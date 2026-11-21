import { Schema, model } from 'mongoose';
import { roleSchema } from './auth.schemas.js';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: roleSchema.options,
      required: true,
      default: 'patient',
    },
  },
  { collection: 'users', timestamps: true },
);

export const User = model('User', userSchema);
