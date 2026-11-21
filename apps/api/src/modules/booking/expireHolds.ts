import mongoose from 'mongoose';
import { Slot } from '../doctor/slot.model.js';
import { Appointment } from './appointment.model.js';

export async function expireHolds(now = new Date()): Promise<void> {
  const due = {
    status: 'pending_payment' as const,
    holdExpiresAt: { $lte: now },
  };
  const candidates = await Appointment.find(due)
    .sort({ holdExpiresAt: 1 })
    .limit(100)
    .select('_id')
    .lean();
  for (const { _id } of candidates) {
    await mongoose.connection.transaction(async (session) => {
      const appointment = await Appointment.findOneAndUpdate(
        { _id, ...due },
        { $set: { status: 'expired' } },
        { session, returnDocument: 'before' },
      );
      if (!appointment) return;
      await Slot.updateOne(
        {
          _id: appointment.slotId,
          status: 'held',
          heldBy: appointment.patientId,
          holdExpiresAt: appointment.holdExpiresAt,
        },
        { $set: { status: 'available', heldBy: null, holdExpiresAt: null } },
        { session },
      );
    });
  }
}
