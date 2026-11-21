import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { Outbox, OutboxDelivery } from './outbox.model.js';

const maxAttempts = 5;

export async function outboxRelay(): Promise<void> {
  const candidates = await Outbox.find({ status: 'pending' })
    .sort({ attempts: 1, _id: 1 })
    .limit(100)
    .select('_id')
    .lean();
  for (const { _id } of candidates) {
    try {
      await mongoose.connection.transaction(async (session) => {
        const event = await Outbox.findOneAndUpdate(
          { _id, status: 'pending' },
          { $set: { status: 'processed', lastError: null } },
          { session, returnDocument: 'before' },
        );
        if (!event) return;
        await OutboxDelivery.updateOne(
          { _id },
          {
            $setOnInsert: {
              type: event.type,
              payload: event.payload,
              deliveredAt: new Date(),
            },
          },
          { session, upsert: true },
        );
      });
    } catch (error) {
      const lastError = error instanceof Error ? error.name : 'UnknownError';
      await Outbox.updateOne(
        { _id, status: 'pending' },
        [
          { $set: { attempts: { $add: ['$attempts', 1] }, lastError } },
          {
            $set: {
              status: {
                $cond: [
                  { $gte: ['$attempts', maxAttempts] },
                  'failed',
                  'pending',
                ],
              },
            },
          },
        ],
        { updatePipeline: true },
      );
      logger.warn({ errorType: lastError }, 'Outbox delivery failed');
    }
  }
}
