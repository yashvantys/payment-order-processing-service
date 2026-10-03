import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from '../queue/queue.module.js';
import { PaymentsProcessor } from './payments.processor.js';
import { PaymentProviderService } from './payment-provider.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { PaymentsController } from './payments.controller.js';

@Module({
    imports: [
        QueueModule,
        BullModule.registerQueue({
            name: 'payment-dlq',
        }),
    ],
    controllers:[PaymentsController],
    providers: [
        PaymentsProcessor,
        PaymentProviderService,
        ReconciliationService,
    ],
})
export class PaymentsModule { }