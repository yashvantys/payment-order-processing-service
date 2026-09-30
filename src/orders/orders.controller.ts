import {
    Body,
    Controller,
    Headers,
    Post,
    HttpCode,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';

@Controller('orders')
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) { }

    @Post()
    @HttpCode(202)
    async createOrder(
        @Headers('idempotency-key') idempotencyKey: string,
        @Body() dto: CreateOrderDto,
    ) {
        return this.ordersService.createOrder(idempotencyKey, dto);
    }
}