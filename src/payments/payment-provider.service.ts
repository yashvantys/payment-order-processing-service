import { Injectable } from '@nestjs/common';

@Injectable()
export class PaymentProviderService {
  async charge(input: {
    paymentId: string;
    amount: bigint;
    currency: string;
  }) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (input.amount === BigInt(999999)) {
      throw new Error('Mock payment provider unavailable');
    }
    return {
      success: true,
      provider: 'mock',
      providerPaymentId: `mock_${input.paymentId}`,
    };
  }
}