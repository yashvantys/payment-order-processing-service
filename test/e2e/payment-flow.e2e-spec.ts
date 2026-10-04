import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { OutboxRelay } from '../../src/outbox/outbox.relay.js';

describe('Payment Flow (e2e)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let outboxRelay: OutboxRelay;

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
    });

    afterAll(async () => {
        await app.close();
    });

    it(
        'should process payment successfully',
        async () => {
            // 1. Create order
            const response = await request(app.getHttpServer())
                .post('/orders')
                .set('Idempotency-Key', `payment-flow-${Date.now()}`)
                .send({
                    customerId,
                    amount: 49900,
                    currency: 'INR',
                })
                .expect(202);

            const { orderId, paymentId } = response.body;

            expect(orderId).toBeDefined();
            expect(paymentId).toBeDefined();
            expect(response.body.status).toBe('PENDING');

            // 2. Verify initial DB state
            let payment = await prisma.payment.findUnique({
                where: { id: paymentId },
            });

            expect(payment).not.toBeNull();
            expect(payment?.status).toBe('PENDING');

            // 3. Publish outbox event
            await outboxRelay.publishPendingEvents(10);
            console.log('Outbox event published for payment:', paymentId);
            // 4. Wait for BullMQ worker
            const timeoutMs = 10_000;
            const pollIntervalMs = 250;
            const startTime = Date.now();

            while (Date.now() - startTime < timeoutMs) {
                payment = await prisma.payment.findUnique({
                    where: { id: paymentId },
                });

                if (
                    payment?.status === 'SUCCESS' ||
                    payment?.status === 'FAILED'
                ) {
                    break;
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, pollIntervalMs),
                );
            }

            // 5. Verify payment
            expect(payment?.status).toBe('SUCCESS');
            expect(payment?.provider).toBe('mock');
            expect(payment?.providerPaymentId).toBe(`mock_${paymentId}`);

            // 6. Verify order
            const order = await prisma.order.findUnique({
                where: { id: orderId },
            });

            expect(order?.status).toBe('PAID');

            // 7. Verify completion event
            const completionEvent = await prisma.outboxEvent.findFirst({
                where: {
                    aggregateId: paymentId,
                    eventType: 'PaymentCompleted',
                },
            });

            expect(completionEvent).not.toBeNull();
        },
        15_000,
    );
});