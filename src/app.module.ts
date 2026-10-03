import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { QueueModule } from './queue/queue.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { WebhookModule } from './webhook/webhook.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule, 
    OrdersModule, 
    OutboxModule, 
    QueueModule, 
    PaymentsModule, 
    WebhookModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
