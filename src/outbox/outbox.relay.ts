import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class OutboxRelay {
    private readonly logger = new Logger(OutboxRelay.name);
    constructor(
        private readonly prisma: PrismaService,
        @InjectQueue('payment-events')
        private readonly paymentQueue: Queue,
    ) { }

    async publishPendingEvents(limit = 10) {
        for (let i = 0; i < limit; i++) {
            const event = await this.claimNextEvent();
            if (!event) {
                break;
            }
            try {
                await this.paymentQueue.add(
                    event.eventType,
                    {
                        eventId: event.id,
                        aggregateId: event.aggregateId,
                        payload: event.payload,
                    },
                    {
                        jobId: event.id,
                    },
                );
                await this.prisma.outboxEvent.update({
                    where: { id: event.id },
                    data: {
                        status: 'PUBLISHED',
                        publishedAt: new Date(),
                        attempts: {
                            increment: 1,
                        },
                    },
                });
                this.logger.log(`Published outbox event ${event.id}`);
            } catch (error) {
                await this.prisma.outboxEvent.update({
                    where: { id: event.id },
                    data: {
                        status: 'PENDING',
                        attempts: {
                            increment: 1,
                        },
                        lastError:
                            error instanceof Error ? error.message : String(error),
                    },
                });
                this.logger.error(`Failed to publish ${event.id}`);
            }
        }
    }

    private async claimNextEvent() {
        return this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<
                Array<{
                    id: string;
                    aggregateId: string;
                    eventType: string;
                    payload: unknown;
                }>
            >`
      SELECT
        id,
        aggregate_id AS "aggregateId",
        event_type AS "eventType",
        payload
      FROM outbox_events
      WHERE status = 'PENDING'
        AND available_at <= NOW()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;

            const event = rows[0];
            if (!event) {
                return null;
            }
            await tx.outboxEvent.update({
                where: { id: event.id },
                data: {
                    status: 'PROCESSING',
                },
            });
            return event;
        });
    }
}