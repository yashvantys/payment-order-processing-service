import {
    Body,
    Controller,
    Headers,
    Post,
    HttpCode,
    BadRequestException,
    Get,
    Param,
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
        if (!idempotencyKey?.trim()) {
            throw new BadRequestException(
                'Idempotency-Key header is required',
            );
        }
        return this.ordersService.createOrder(idempotencyKey, dto);
    }
    @Get(':id')
    async getOrder(@Param('id') id: string) {
        return this.ordersService.getOrder(id);
    }
}