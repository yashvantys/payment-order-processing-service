import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentProviderService } from './payment-provider.service.js';

@Injectable()
export class ReconciliationService {
    private readonly logger = new Logger(ReconciliationService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentProvider: PaymentProviderService,
    ) { }

    async reconcileProcessingPayments() {
        const payments = await this.prisma.payment.findMany({
            where: {
                status: 'PROCESSING',
                providerPaymentId: {
                    not: null,
                },
            },
            take: 50,
        });

        for (const payment of payments) {
            await this.reconcilePayment(payment.id);
        }

        return {
            checked: payments.length,
        };
    }

    async reconcilePayment(paymentId: string) {
        const payment = await this.prisma.payment.findUnique({
            where: { id: paymentId },
        });

        if (!payment) {
            throw new Error(`Payment ${paymentId} not found`);
        }

        if (payment.status !== 'PROCESSING') {
            return {
                paymentId,
                status: payment.status,
                reconciled: false,
            };
        }

        if (!payment.providerPaymentId) {
            return {
                paymentId,
                status: 'PROCESSING',
                reconciled: false,
                reason: 'Provider payment ID not available',
            };
        }

        const result =
            await this.paymentProvider.getPaymentStatus(
                payment.providerPaymentId,
            );

        if (result.status === 'SUCCESS') {
            await this.prisma.$transaction(async (tx) => {
                await tx.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: 'SUCCESS',
                    },
                });

                await tx.order.update({
                    where: { id: payment.orderId },
                    data: {
                        status: 'PAID',
                    },
                });

                await tx.outboxEvent.create({
                    data: {
                        aggregateType: 'PAYMENT',
                        aggregateId: payment.id,
                        eventType: 'PaymentCompleted',
                        payload: {
                            eventType: 'PaymentCompleted',
                            paymentId: payment.id,
                            orderId: payment.orderId,
                            source: 'RECONCILIATION',
                        },
                    },
                });
            });

            return {
                paymentId,
                status: 'SUCCESS',
                reconciled: true,
            };
        }

        return {
            paymentId,
            status: 'PROCESSING',
            reconciled: false,
            reason: 'Provider status unknown',
        };
    }

    async getPayment(paymentId: string) {
        const payment = await this.prisma.payment.findUnique({
            where: {
                id: paymentId,
            },
        });

        if (!payment) {
            throw new NotFoundException('Payment not found');
        }

        return payment;
    }
}