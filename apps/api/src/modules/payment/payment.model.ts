import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    appointmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Appointment',
      required: true,
      unique: true,
    },
    stripeIntentId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'refunded', 'failed'],
      required: true,
    },
    refundRequired: { type: Boolean, default: false },
    refundId: String,
    nextCheckAt: { type: Date, default: Date.now },
  },
  { collection: 'payments', versionKey: false },
);

schema.index({ status: 1, nextCheckAt: 1 });
export const Payment = model('Payment', schema);
