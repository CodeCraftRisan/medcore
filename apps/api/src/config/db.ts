import mongoose from 'mongoose';
import { RefreshToken } from '../modules/auth/refreshToken.model.js';
import { User } from '../modules/auth/user.model.js';
import { Doctor } from '../modules/doctor/doctor.model.js';
import { Slot } from '../modules/doctor/slot.model.js';
import { Appointment } from '../modules/booking/appointment.model.js';
import { IdempotencyKey } from '../shared/middleware/idempotencyKey.model.js';
import { env } from './env.js';

export async function connectMongo(): Promise<void> {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    User.init(),
    RefreshToken.init(),
    Doctor.init(),
    Slot.init(),
    Appointment.init(),
    IdempotencyKey.init(),
  ]);
}

export async function isMongoReady(): Promise<boolean> {
  const { db, readyState } = mongoose.connection;
  if (readyState !== 1 || !db) return false;

  await db.command({ ping: 1 }, { timeoutMS: 1000 });
  return true;
}

export async function closeMongo(): Promise<void> {
  await mongoose.disconnect();
}
