import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from '../queue/queue.module.js';
import { PaymentsProcessor } from './payments.processor.js';
import { PaymentProviderService } from './payment-provider.service.js';

@Module({
    imports: [
        QueueModule,
        BullModule.registerQueue({
            name: 'payment-dlq',
        }),
    ],
    providers: [
        PaymentsProcessor,
        PaymentProviderService,
    ],
})
export class PaymentsModule { }