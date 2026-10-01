import { Controller, Post } from '@nestjs/common';
import { OutboxRelay } from './outbox.relay.js';

@Controller('outbox')
export class OutboxController {
    constructor(private readonly outboxRelay: OutboxRelay) { }
    @Post('publish')
    async publish() {
        await this.outboxRelay.publishPendingEvents(10);
        return {
            message: 'Outbox events processed',
        };
    }
}