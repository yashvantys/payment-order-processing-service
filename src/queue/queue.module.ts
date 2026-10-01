import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

@Module({
    imports: [
        BullModule.forRoot({
            connection: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
            },
        }),
        BullModule.registerQueue({
            name: 'payment-events',
        }),
    ],
    exports: [BullModule],
})
export class QueueModule { }