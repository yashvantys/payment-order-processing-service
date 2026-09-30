import {
    Injectable,
    UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';

@Injectable()
export class OrdersService {
    constructor(private readonly prisma: PrismaService) { }

    async createOrder(
        idempotencyKey: string,
        dto: CreateOrderDto,
    ) {
        const requestHash = createHash('sha256')
            .update(JSON.stringify(dto))
            .digest('hex');

        try {
            return await this.prisma.$transaction(async (tx) => {
                // 2. Check whether this idempotency key already exists
                const existingKey = await tx.idempotencyKey.findUnique({
                    where: {
                        userId_key: {
                            userId: dto.customerId,
                            key: idempotencyKey,
                        },
                    },
                });

                // 3. Handle retry with the same key
                if (existingKey) {
                    // Same key + different request = reject
                    if (existingKey.requestHash !== requestHash) {
                        throw new UnprocessableEntityException(
                            'Idempotency-Key was already used with a different request',
                        );
                    }

                    // Same key + same request = return original response
                    return existingKey.responseBody;
                }

                // 4. Generate IDs
                const orderId = crypto.randomUUID();
                const paymentId = crypto.randomUUID();

                const orderNumber = `ORD-${Date.now()}`;

                // 5. Create idempotency record
                await tx.idempotencyKey.create({
                    data: {
                        userId: dto.customerId,
                        key: idempotencyKey,
                        requestHash,
                        responseStatus: 202,
                        responseBody: {
                            orderId,
                            paymentId,
                            status: 'PENDING',
                        },
                    },
                });

                // 6. Create Order
                await tx.order.create({
                    data: {
                        id: orderId,
                        orderNumber,
                        customerId: dto.customerId,
                        amount: BigInt(dto.amount),
                        currency: dto.currency.toUpperCase(),
                        status: 'PENDING',
                    },
                });

                // 7. Create Payment
                await tx.payment.create({
                    data: {
                        id: paymentId,
                        orderId,
                        amount: BigInt(dto.amount),
                        currency: dto.currency.toUpperCase(),
                        status: 'PENDING',
                        provider: 'mock',
                    },
                });

                // 8. Create Outbox Event
                await tx.outboxEvent.create({
                    data: {
                        aggregateType: 'ORDER',
                        aggregateId: orderId,
                        eventType: 'PaymentRequested',
                        payload: {
                            orderId,
                            paymentId,
                            customerId: dto.customerId,
                            amount: dto.amount,
                            currency: dto.currency.toUpperCase(),
                        },
                    },
                });

                return {
                    orderId,
                    paymentId,
                    status: 'PENDING',
                };
            });
        } catch (error) {
            if (error instanceof UnprocessableEntityException) {
                throw error;
            }

            throw error;
        }
    }
}