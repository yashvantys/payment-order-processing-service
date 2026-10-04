import { Controller, Post, Get, Param } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service.js';
@Controller('payments')
export class PaymentsController {
    constructor(private readonly reconciliationService: ReconciliationService) { }

    @Post('reconcile')
    async reconcile() {
        return this.reconciliationService.reconcileProcessingPayments();
    }

    @Get(':id')
    async getPayment(@Param('id') id: string) {
        return this.reconciliationService.getPayment(id);
    }
}