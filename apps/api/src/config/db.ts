import mongoose from 'mongoose';
import { RefreshToken } from '../modules/auth/refreshToken.model.js';
import { User } from '../modules/auth/user.model.js';
import { Doctor } from '../modules/doctor/doctor.model.js';
import { Slot } from '../modules/doctor/slot.model.js';
import { Appointment } from '../modules/booking/appointment.model.js';
import { IdempotencyKey } from '../shared/middleware/idempotencyKey.model.js';
import { Payment } from '../modules/payment/payment.model.js';
import { StripeEvent } from '../modules/payment/stripeEvent.model.js';
import { Outbox, OutboxDelivery } from '../shared/outbox/outbox.model.js';
import { env } from './env.js';

export async function connectMongo(dbName?: string): Promise<void> {
  await mongoose.connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    dbName,
  });
  await Promise.all([
    User.init(),
    RefreshToken.init(),
    Doctor.init(),
    Slot.init(),
    Appointment.init(),
    IdempotencyKey.init(),
    Payment.init(),
    StripeEvent.init(),
    Outbox.init(),
    OutboxDelivery.init(),
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
