import { IsInt, IsString, IsUUID, Length, Min } from 'class-validator';

export class CreateOrderDto {
    @IsUUID()
    customerId: string;

    @IsInt()
    @Min(1)
    amount: number;

    @IsString()
    @Length(3, 3)
    currency: string;
}