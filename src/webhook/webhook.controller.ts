import {
    Controller,
    Headers,
    Post,
    Req,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhookService } from './webhook.service.js';

@Controller('webhooks')
export class WebhookController {
    constructor(
        private readonly webhookService: WebhookService,
    ) { }
    @Post('payments')
    async paymentWebhook(
        @Req() req: Request & { rawBody?: Buffer },
        @Headers('x-webhook-signature') signature: string,
    ) {
        const rawBody = req.rawBody;
        if (!rawBody) {
            throw new Error('Raw request body is not available');
        }
        const payload = req.body;
        return this.webhookService.processWebhook(
            rawBody,
            signature,
            payload,
        );
    }
}