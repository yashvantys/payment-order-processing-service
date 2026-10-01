import { Injectable } from '@nestjs/common';

@Injectable()
export class PaymentProviderService {
  async charge(input: {
    paymentId: string;
    amount: bigint;
    currency: string;
  }) {
    // Simulate an external payment provider.
    await new Promise((resolve) => setTimeout(resolve, 500));

    return {
      success: true,
      provider: 'mock',
      providerPaymentId: `mock_${input.paymentId}`,
    };
  }
}