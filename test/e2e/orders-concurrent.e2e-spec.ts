import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

describe('Orders Concurrent Idempotency (e2e)', () => {
    let app: INestApplication;
    let prisma: PrismaService;

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
    });

    afterAll(async () => {
        await app.close();
    });

    it(
        'should create only one order when 10 concurrent requests use the same idempotency key',
        async () => {
            const idempotencyKey = `concurrent-${Date.now()}`;

            const payload = {
                customerId,
                amount: 49900,
                currency: 'INR',
            };

            // Send 10 requests concurrently
            const responses = await Promise.all(
                Array.from({ length: 10 }, () =>
                    request(app.getHttpServer())
                        .post('/orders')
                        .set('Idempotency-Key', idempotencyKey)
                        .send(payload),
                ),
            );

            // All requests should succeed
            expect(responses.every((response) => response.status === 202)).toBe(
                true,
            );

            // All responses should contain the same order/payment
            const firstResponse = responses[0].body;

            expect(firstResponse).toEqual(
                expect.objectContaining({
                    orderId: expect.any(String),
                    paymentId: expect.any(String),
                    status: 'PENDING',
                }),
            );

            for (const response of responses) {
                expect(response.body.orderId).toBe(firstResponse.orderId);
                expect(response.body.paymentId).toBe(firstResponse.paymentId);
                expect(response.body.status).toBe('PENDING');
            }

            // Verify exactly one idempotency record
            const idempotencyRecords = await prisma.idempotencyKey.findMany({
                where: {
                    userId: customerId,
                    key: idempotencyKey,
                },
            });

            expect(idempotencyRecords).toHaveLength(1);

            // Verify exactly one order
            const orders = await prisma.order.findMany({
                where: {
                    id: firstResponse.orderId,
                },
            });

            expect(orders).toHaveLength(1);

            // Verify exactly one payment
            const payments = await prisma.payment.findMany({
                where: {
                    orderId: firstResponse.orderId,
                },
            });

            expect(payments).toHaveLength(1);

            // Verify exactly one PaymentRequested outbox event
            const outboxEvents = await prisma.outboxEvent.findMany({
                where: {
                    aggregateId: firstResponse.orderId,
                    eventType: 'PaymentRequested',
                },
            });

            expect(outboxEvents).toHaveLength(1);
        },
        15000,
    );
});