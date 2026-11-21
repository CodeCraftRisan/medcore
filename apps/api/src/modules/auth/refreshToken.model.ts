import { Schema, model } from 'mongoose';

const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    used: { type: Boolean, default: false, required: true },
    revoked: { type: Boolean, default: false, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { collection: 'refresh_tokens' },
);

export const RefreshToken = model('RefreshToken', refreshTokenSchema);
