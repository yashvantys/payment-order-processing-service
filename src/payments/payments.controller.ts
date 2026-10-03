import { Controller, Post } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service.js';
@Controller('payments')
export class PaymentsController {
    constructor(private readonly reconciliationService: ReconciliationService) { }

    @Post('reconcile')
    async reconcile() {
        return this.reconciliationService.reconcileProcessingPayments();
    }
}