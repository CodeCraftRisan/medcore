import mongoose from 'mongoose';
import { logger } from '../../shared/observability/logger.js';
import { Payment } from './payment.model.js';
import { applyPaymentSuccess, finishLateRefund } from './payment.service.js';
import { retrieveIntent } from './stripe.adapter.js';

export async function reconcilePayments(): Promise<void> {
  const now = new Date();
  const due = { status: 'pending' as const, nextCheckAt: { $lte: now } };
  const nextCheckAt = new Date(now.getTime() + 30_000);
  const candidates = await Payment.find(due)
    .sort({ nextCheckAt: 1 })
    .limit(100)
    .select('_id')
    .lean();
  for (const { _id } of candidates) {
    const payment = await Payment.findOneAndUpdate(
      { _id, ...due },
      { $set: { nextCheckAt } },
    );
    if (!payment) continue;
    try {
      if (payment.refundRequired) {
        await finishLateRefund(payment.stripeIntentId);
        continue;
      }

      const intent = await retrieveIntent(payment.stripeIntentId);
      if (intent.status !== 'succeeded') continue;
      const refund = await mongoose.connection.transaction((session) =>
        applyPaymentSuccess(intent, session),
      );
      if (refund) await finishLateRefund(intent.id);
    } catch (error) {
      logger.warn(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'Payment reconciliation will retry',
      );
    }
  }
}
