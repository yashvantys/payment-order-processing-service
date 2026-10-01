import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class OutboxService {
    constructor(private readonly prisma: PrismaService) { }

    async getPendingEvents(limit = 10) {
        return this.prisma.outboxEvent.findMany({
            where: {
                status: 'PENDING',
                availableAt: {
                    lte: new Date(),
                },
            },
            orderBy: {
                createdAt: 'asc',
            },
            take: limit,
        });
    }
}