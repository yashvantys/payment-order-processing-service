import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { OutboxRelay } from '../../src/outbox/outbox.relay.js';

describe('Payment Failure Flow (e2e)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let outboxRelay: OutboxRelay;
    let paymentDlq: Queue;

    const customerId = '550e8400-e29b-41d4-a716-446655440000';

    beforeAll(async () => {
        const moduleFixture: TestingModule =
            await Test.createTestingModule({
                imports: [AppModule],
            }).compile();

        app = moduleFixture.createNestApplication();

        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                transform: true,
                forbidNonWhitelisted: true,
            }),
        );

        await app.init();

        prisma = app.get(PrismaService);
        outboxRelay = app.get(OutboxRelay);

        paymentDlq = app.get<Queue>(
            getQueueToken('payment-dlq'),
        );
    });

    afterAll(async () => {
        await app.close();
    });

    it(
        'should retry failed payment and move it to DLQ',
        async () => {
            // 1. Create order with amount that triggers
            //    "Mock payment provider unavailable"
            const response = await request(app.getHttpServer())
                .post('/orders')
                .set(
                    'Idempotency-Key',
                    `payment-failure-${Date.now()}`,
                )
                .send({
                    customerId,
                    amount: 999999,
                    currency: 'INR',
                })
                .expect(202);

            const { orderId, paymentId } = response.body;

            expect(orderId).toBeDefined();
            expect(paymentId).toBeDefined();
            expect(response.body.status).toBe('PENDING');

            // 2. Verify initial payment state
            let payment = await prisma.payment.findUnique({
                where: { id: paymentId },
            });

            expect(payment).not.toBeNull();
            expect(payment?.status).toBe('PENDING');

            // 3. Publish PaymentRequested outbox event
            await outboxRelay.publishPendingEvents(10);

            // 4. Wait for BullMQ retries + final failure
            const timeoutMs = 10_000;
            const pollIntervalMs = 250;
            const startTime = Date.now();

            while (Date.now() - startTime < timeoutMs) {
                payment = await prisma.payment.findUnique({
                    where: { id: paymentId },
                });

                if (payment?.status === 'FAILED') {
                    break;
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, pollIntervalMs),
                );
            }

            // 5. Payment should be FAILED
            expect(payment?.status).toBe('FAILED');

            expect(payment?.failureReason).toBe(
                'Mock payment provider unavailable',
            );

            // 6. Order should be PAYMENT_FAILED
            const order = await prisma.order.findUnique({
                where: { id: orderId },
            });

            expect(order?.status).toBe('PAYMENT_FAILED');

            // 7. PaymentFailed event should be created
            const failedEvent = await prisma.outboxEvent.findFirst({
                where: {
                    aggregateId: paymentId,
                    eventType: 'PaymentFailed',
                },
            });

            expect(failedEvent).not.toBeNull();

            // 8. Verify the original PaymentRequested event
            //    was published
            const paymentRequestedEvent =
                await prisma.outboxEvent.findFirst({
                    where: {
                        aggregateId: orderId,
                        eventType: 'PaymentRequested',
                    },
                });

            expect(paymentRequestedEvent).not.toBeNull();
            expect(paymentRequestedEvent?.status).toBe('PUBLISHED');

            // 9. Verify failed payment job was moved to DLQ
            const dlqJobs = await paymentDlq.getJobs([
                'waiting',
                'active',
                'completed',
                'failed',
            ]);

            const dlqJob = dlqJobs.find(
                (job) => job.data?.payload?.paymentId === paymentId,
            );

            expect(dlqJob).toBeDefined();

            expect(
                dlqJob?.data?.payload?.paymentId,
            ).toBe(paymentId);

            expect(dlqJob?.data?.error).toBe(
                'Mock payment provider unavailable',
            );
        },
        15_000,
    );
});