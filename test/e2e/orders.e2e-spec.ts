import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';

describe('Orders API (e2e)', () => {
    let app: INestApplication;

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
    });

    afterAll(async () => {
        await app.close();
    });

    describe('POST /orders', () => {
        it('should create an order successfully', async () => {
            const response = await request(app.getHttpServer())
                .post('/orders')
                .set('Idempotency-Key', `test-${Date.now()}`)
                .send({
                    customerId,
                    amount: 49900,
                    currency: 'INR',
                })
                .expect(202);

            expect(response.body).toHaveProperty('orderId');
            expect(response.body).toHaveProperty('paymentId');
            expect(response.body.status).toBe('PENDING');
        });

        it('should replay the same response for the same idempotency key', async () => {
            const idempotencyKey = `replay-${Date.now()}`;

            const payload = {
                customerId,
                amount: 25000,
                currency: 'INR',
            };

            const firstResponse = await request(app.getHttpServer())
                .post('/orders')
                .set('Idempotency-Key', idempotencyKey)
                .send(payload)
                .expect(202);

            const secondResponse = await request(app.getHttpServer())
                .post('/orders')
                .set('Idempotency-Key', idempotencyKey)
                .send(payload)
                .expect(202);

            expect(secondResponse.body).toEqual(firstResponse.body);
        });

        it('should reject the same key with a different payload', async () => {
            const idempotencyKey = `different-${Date.now()}`;

            await request(app.getHttpServer())
                .post('/orders')
                .set('Idempotency-Key', idempotencyKey)
                .send({
                    customerId,
                    amount: 10000,
                    currency: 'INR',
                })
                .expect(202);

            const response = await request(app.getHttpServer())
                .post('/orders')
                .set('Idempotency-Key', idempotencyKey)
                .send({
                    customerId,
                    amount: 20000,
                    currency: 'INR',
                })
                .expect(422);

            expect(response.body.message).toBe(
                'Idempotency-Key was already used with a different request',
            );
        });

        it('should reject a missing Idempotency-Key', async () => {
            await request(app.getHttpServer())
                .post('/orders')
                .send({
                    customerId,
                    amount: 10000,
                    currency: 'INR',
                })
                .expect(400);
        });

    });

    it('should get an existing order by id', async () => {
        const response = await request(app.getHttpServer())
            .post('/orders')
            .set('Idempotency-Key', `get-order-${Date.now()}`)
            .send({
                customerId,
                amount: 49900,
                currency: 'INR',
            })
            .expect(202);
        const orderId = response.body.orderId;
        const getResponse = await request(app.getHttpServer())
            .get(`/orders/${orderId}`)
            .expect(200);
        expect(getResponse.body).toEqual(
            expect.objectContaining({
                id: orderId,
                customerId,
                amount: '49900',
                currency: 'INR',
                status: 'PENDING',
            }),
        );
        expect(getResponse.body.payment).toEqual(
            expect.objectContaining({
                orderId,
                status: 'PENDING',
            }),
        );
    });

    it('should return 404 when order does not exist', async () => {
        const unknownOrderId = '550e8400-e29b-41d4-a716-446655440099';
        const response = await request(app.getHttpServer())
            .get(`/orders/${unknownOrderId}`)
            .expect(404);
        expect(response.body.message).toBe('Order not found');
    });

});