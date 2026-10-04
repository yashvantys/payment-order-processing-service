import {
    Injectable,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';


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
                const existingKey = await tx.idempotencyKey.findUnique({
                    where: {
                        userId_key: {
                            userId: dto.customerId,
                            key: idempotencyKey,
                        },
                    },
                });

                if (existingKey) {
                    if (existingKey.requestHash !== requestHash) {
                        throw new UnprocessableEntityException(
                            'Idempotency-Key was already used with a different request',
                        );
                    }

                    return existingKey.responseBody;
                }

                const orderId = randomUUID();
                const paymentId = randomUUID();
                const orderNumber = `ORD-${randomUUID()}`;

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

            if (this.isUniqueConstraintError(error)) {
                const existingKey =
                    await this.prisma.idempotencyKey.findUnique({
                        where: {
                            userId_key: {
                                userId: dto.customerId,
                                key: idempotencyKey,
                            },
                        },
                    });

                if (!existingKey) {
                    throw error;
                }

                if (existingKey.requestHash !== requestHash) {
                    throw new UnprocessableEntityException(
                        'Idempotency-Key was already used with a different request',
                    );
                }

                return existingKey.responseBody;
            }

            throw error;
        }
    }

    private isUniqueConstraintError(error: unknown): boolean {
        return (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        );
    }

    async getOrder(orderId: string) {
        const order = await this.prisma.order.findUnique({
            where: {
                id: orderId,
            },
            include: {
                payment: true,
            },
        });

        if (!order) {
            throw new NotFoundException('Order not found');
        }
        return order;
    }
}