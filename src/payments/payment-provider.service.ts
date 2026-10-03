import { Injectable, Logger } from '@nestjs/common';

export class PaymentProviderTimeoutError extends Error {
  constructor(
    message: string,
    public readonly providerPaymentId: string,
  ) {
    super(message);
    this.name = 'PaymentProviderTimeoutError';
  }
}

@Injectable()
export class PaymentProviderService {
  private readonly logger = new Logger(PaymentProviderService.name);

  async charge(input: {
    paymentId: string;
    amount: bigint;
    currency: string;
  }) {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const providerPaymentId = `mock_${input.paymentId}`;

    // Provider created the payment, but our application
    // lost the response because of a timeout.
    if (input.amount === BigInt(888888)) {
      this.logger.warn(
        `Simulating provider timeout for ${providerPaymentId}`,
      );

      throw new PaymentProviderTimeoutError(
        'Mock provider timeout after payment creation',
        providerPaymentId,
      );
    }

    // Provider is unavailable.
    if (input.amount === BigInt(999999)) {
      throw new Error('Mock payment provider unavailable');
    }

    return {
      success: true,
      provider: 'mock',
      providerPaymentId,
    };
  }

  async getPaymentStatus(providerPaymentId: string) {
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (providerPaymentId.startsWith('mock_')) {
      return {
        status: 'SUCCESS' as const,
        provider: 'mock',
        providerPaymentId,
      };
    }

    return {
      status: 'UNKNOWN' as const,
      provider: 'mock',
      providerPaymentId,
    };
  }
}