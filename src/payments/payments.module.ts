import { Module } from '@nestjs/common';
import { PaymentsProcessor } from './payments.processor.js';
import { PaymentProviderService } from './payment-provider.service.js';

@Module({
    providers: [
        PaymentsProcessor,
        PaymentProviderService,
    ],
})
export class PaymentsModule { }