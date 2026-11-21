import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectMongo(): Promise<void> {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
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
