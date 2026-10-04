import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
    PaymentProviderService,
    PaymentProviderTimeoutError,
} from './payment-provider.service.js';

interface PaymentRequestedEvent {
    eventId: string;
    aggregateId: string;
    payload: {
        orderId: string;
        paymentId: string;
        customerId: string;
        amount: number;
        currency: string;
    };
}

@Injectable()
@Processor('payment-events')
export class PaymentsProcessor extends WorkerHost {
    private readonly logger = new Logger(PaymentsProcessor.name);
    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentProvider: PaymentProviderService,

        @InjectQueue('payment-dlq')
        private readonly paymentDlq: Queue,
    ) {
        super();
    }
    async process(job: Job<PaymentRequestedEvent>) {
        console.log('>>> PAYMENT WORKER STARTED');
        console.log('>>> Job ID:', job.id);
        console.log('>>> Job data:', job.data);
        this.logger.log(
            `Job ${job.id}: attemptsMade=${job.attemptsMade}, configuredAttempts=${job.opts.attempts ?? 1}`,
        );
        this.logger.log(`Processing payment job ${job.id}`);
        const { paymentId, orderId, amount, currency } = job.data.payload;
        const payment = await this.prisma.payment.findUnique({
            where: { id: paymentId },
        });
        if (!payment) {
            throw new Error(`Payment ${paymentId} not found`);
        }
        // Idempotent consumer:
        // If payment has already reached a terminal state,
        // do not charge the provider again.
        if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
            this.logger.log(
                `Payment ${paymentId} already processed: ${payment.status}`,
            );
            return;
        }
        await this.prisma.payment.update({
            where: { id: paymentId },
            data: {
                status: 'PROCESSING',
            },
        });
        try {            
            const result = await this.paymentProvider.charge({
                paymentId,
                amount: BigInt(amount),
                currency,
            });

            await this.prisma.$transaction(async (tx) => {
                if (result.success) {
                    await tx.payment.update({
                        where: { id: paymentId },
                        data: {
                            status: 'SUCCESS',
                            provider: result.provider,
                            providerPaymentId: result.providerPaymentId,
                        },
                    });

                    await tx.order.update({
                        where: { id: orderId },
                        data: {
                            status: 'PAID',
                        },
                    });

                    await tx.outboxEvent.create({
                        data: {
                            aggregateType: 'PAYMENT',
                            aggregateId: paymentId,
                            eventType: 'PaymentCompleted',
                            payload: {
                                eventType: 'PaymentCompleted',
                                paymentId,
                                orderId,
                            },
                        },
                    });
                } else {
                    await tx.payment.update({
                        where: { id: paymentId },
                        data: {
                            status: 'FAILED',
                            failureReason:
                                'Payment provider rejected the payment',
                        },
                    });

                    await tx.order.update({
                        where: { id: orderId },
                        data: {
                            status: 'PAYMENT_FAILED',
                        },
                    });

                    await tx.outboxEvent.create({
                        data: {
                            aggregateType: 'PAYMENT',
                            aggregateId: paymentId,
                            eventType: 'PaymentFailed',
                            payload: {
                                eventType: 'PaymentFailed',
                                paymentId,
                                orderId,
                            },
                        },
                    });
                }
            });

            this.logger.log(
                `Payment ${paymentId} processed successfully`,
            );
        } catch (error) {
            if (error instanceof PaymentProviderTimeoutError) {
                await this.prisma.payment.update({
                    where: { id: paymentId },
                    data: {
                        status: 'PROCESSING',
                        provider: 'mock',
                        providerPaymentId: error.providerPaymentId,
                    },
                });

                this.logger.warn(
                    `Payment ${paymentId} remains PROCESSING. ` +
                    `Provider payment ID: ${error.providerPaymentId}`,
                );

                // Important:
                // Do not throw. Reconciliation will resolve it.
                return;
            }

            // Normal provider errors still go through
            // BullMQ retry/DLQ handling.
            throw error;
        }
    }

    @OnWorkerEvent('failed')
    async onFailed(job: Job, error: Error) {
        if (!job) {
            return;
        }

        const maxAttempts = job.opts.attempts ?? 1;

        this.logger.error(
            `Payment job ${job.id} failed. ` +
            `attempt=${job.attemptsMade}, ` +
            `maxAttempts=${maxAttempts}, ` +
            `error=${error.message}`,
        );

        // Retries are still available.
        if (job.attemptsMade < maxAttempts) {
            return;
        }

        const { paymentId, orderId } = job.data.payload;

        // All retries exhausted.
        // Move the payment/order to their terminal failure states.
        await this.prisma.$transaction(async (tx) => {
            const payment = await tx.payment.findUnique({
                where: { id: paymentId },
            });

            // Protect against duplicate failed events.
            if (!payment || payment.status === 'FAILED') {
                return;
            }

            await tx.payment.update({
                where: { id: paymentId },
                data: {
                    status: 'FAILED',
                    failureReason: error.message,
                },
            });

            await tx.order.update({
                where: { id: orderId },
                data: {
                    status: 'PAYMENT_FAILED',
                },
            });

            await tx.outboxEvent.create({
                data: {
                    aggregateType: 'PAYMENT',
                    aggregateId: paymentId,
                    eventType: 'PaymentFailed',
                    payload: {
                        eventType: 'PaymentFailed',
                        paymentId,
                        orderId,
                        reason: error.message,
                    },
                },
            });
        });

        // Move the exhausted job to DLQ.
        await this.paymentDlq.add(
            'PaymentProcessingFailed',
            {
                originalJobId: job.id,
                eventId: job.data?.eventId,
                aggregateId: job.data?.aggregateId,
                payload: job.data?.payload,
                error: error.message,
                failedAt: new Date().toISOString(),
            },
            {
                jobId: `dlq-${job.id}`,
                removeOnComplete: false,
                removeOnFail: false,
            },
        );

        this.logger.error(
            `Payment job ${job.id} moved to DLQ after ${job.attemptsMade} attempts`,
        );
    }
}