import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { OutboxController } from './outbox.controller.js';
import { OutboxRelay } from './outbox.relay.js';
import { OutboxService } from './outbox.service.js';

@Module({
  imports: [QueueModule],
  controllers: [OutboxController],
  providers: [OutboxService, OutboxRelay],
  exports: [OutboxService, OutboxRelay],
})
export class OutboxModule { }