import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    key: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      enum: ['in_progress', 'completed'],
      required: true,
    },
    statusCode: Number,
    responseBody: Schema.Types.Mixed,
    createdAt: {
      type: Date,
      default: Date.now,
      required: true,
      expires: 86400,
    },
  },
  { collection: 'idempotency_keys', versionKey: false },
);

schema.index({ userId: 1, key: 1 }, { unique: true });

export const IdempotencyKey = model('IdempotencyKey', schema);
