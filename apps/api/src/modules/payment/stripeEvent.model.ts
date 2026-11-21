import { Schema, model } from 'mongoose';

export const StripeEvent = model(
  'StripeEvent',
  new Schema(
    {
      eventId: { type: String, required: true, unique: true },
      type: { type: String, required: true },
      processedAt: { type: Date, required: true },
    },
    { collection: 'stripe_events', versionKey: false },
  ),
);
