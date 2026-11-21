import { Schema, model } from 'mongoose';

export const Outbox = model(
  'Outbox',
  new Schema(
    {
      type: { type: String, required: true },
      payload: { type: Schema.Types.Mixed, required: true },
      status: {
        type: String,
        enum: ['pending', 'processed', 'failed'],
        default: 'pending',
        required: true,
        index: true,
      },
      attempts: { type: Number, default: 0 },
      lastError: { type: String, default: null },
    },
    { collection: 'outbox', versionKey: false },
  ),
);

// The local relay hands off each event to a durable inbox under the same event ID.
export const OutboxDelivery = model(
  'OutboxDelivery',
  new Schema(
    {
      type: { type: String, required: true },
      payload: { type: Schema.Types.Mixed, required: true },
      deliveredAt: { type: Date, required: true },
    },
    { collection: 'outbox_deliveries', versionKey: false },
  ),
);
