import {
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';

interface PaymentWebhookPayload {
    provider: string;
    providerEventId: string;
    eventType: string;
    paymentId: string;
    status: 'SUCCESS' | 'FAILED';
}

@Injectable()
export class WebhookService {
    private readonly logger = new Logger(WebhookService.name);
    constructor(private readonly prisma: PrismaService) { }
    verifySignature(
        rawBody: Buffer,
        signature: string,
    ): boolean {
        const secret = process.env.WEBHOOK_SECRET;
        if (!secret) {
            throw new Error('WEBHOOK_SECRET is not configured');
        }
        const expectedSignature = createHmac(
            'sha256',
            secret,
        ).update(rawBody).digest('hex');
        const expected = Buffer.from(expectedSignature, 'utf8');
        const received = Buffer.from(signature, 'utf8');
        if (expected.length !== received.length) {
            return false;
        }
        return timingSafeEqual(expected, received);
    }

    async processWebhook(
        rawBody: Buffer,
        signature: string,
        payload: PaymentWebhookPayload,
    ) {
        if (!this.verifySignature(rawBody, signature)) {
            throw new UnauthorizedException('Invalid webhook signature');
        }

        this.logger.log(
            `Processing webhook ${payload.providerEventId}`,
        );

        return this.prisma.$transaction(async (tx) => {
            // Check whether this provider event was already processed.
            const existingEvent = await tx.webhookEvent.findUnique({
                where: {
                    provider_providerEventId: {
                        provider: payload.provider,
                        providerEventId: payload.providerEventId,
                    },
                },
            });

            // Duplicate webhook.
            if (existingEvent) {
                this.logger.log(
                    `Duplicate webhook ignored: ${payload.providerEventId}`,
                );

                return {
                    received: true,
                    duplicate: true,
                    eventId: payload.providerEventId,
                };
            }

            // Store webhook event first.
            await tx.webhookEvent.create({
                data: {
                    provider: payload.provider,
                    providerEventId: payload.providerEventId,
                    eventType: payload.eventType,
                    payload: {
                        provider: payload.provider,
                        providerEventId: payload.providerEventId,
                        eventType: payload.eventType,
                        paymentId: payload.paymentId,
                        status: payload.status,
                    },
                    signature,
                    status: 'RECEIVED',
                },
            });

            const payment = await tx.payment.findUnique({
                where: {
                    id: payload.paymentId,
                },
            });

            if (!payment) {
                throw new Error(
                    `Payment ${payload.paymentId} not found`,
                );
            }

            // IMPORTANT:
            // Protect terminal payment states BEFORE applying webhook changes.
            if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
                this.logger.warn(
                    `Ignoring webhook ${payload.providerEventId}: payment ${payment.id} is already ${payment.status}`,
                );

                await tx.webhookEvent.update({
                    where: {
                        provider_providerEventId: {
                            provider: payload.provider,
                            providerEventId: payload.providerEventId,
                        },
                    },
                    data: {
                        status: 'PROCESSED',
                        processedAt: new Date(),
                    },
                });

                return {
                    received: true,
                    duplicate: false,
                    ignored: true,
                    reason: `Payment already ${payment.status}`,
                    eventId: payload.providerEventId,
                };
            }

            if (payload.status === 'SUCCESS') {
                await tx.payment.update({
                    where: {
                        id: payload.paymentId,
                    },
                    data: {
                        status: 'SUCCESS',
                        provider: payload.provider,
                    },
                });

                await tx.order.update({
                    where: {
                        id: payment.orderId,
                    },
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
                            source: 'WEBHOOK',
                        },
                    },
                });
            } else {
                await tx.payment.update({
                    where: {
                        id: payload.paymentId,
                    },
                    data: {
                        status: 'FAILED',
                        failureReason: 'Payment provider reported failure',
                    },
                });

                await tx.order.update({
                    where: {
                        id: payment.orderId,
                    },
                    data: {
                        status: 'PAYMENT_FAILED',
                    },
                });

                await tx.outboxEvent.create({
                    data: {
                        aggregateType: 'PAYMENT',
                        aggregateId: payment.id,
                        eventType: 'PaymentFailed',
                        payload: {
                            eventType: 'PaymentFailed',
                            paymentId: payment.id,
                            orderId: payment.orderId,
                            source: 'WEBHOOK',
                        },
                    },
                });
            }

            // Mark webhook as successfully processed.
            await tx.webhookEvent.update({
                where: {
                    provider_providerEventId: {
                        provider: payload.provider,
                        providerEventId: payload.providerEventId,
                    },
                },
                data: {
                    status: 'PROCESSED',
                    processedAt: new Date(),
                },
            });

            return {
                received: true,
                duplicate: false,
                eventId: payload.providerEventId,
            };
        });
    }
}