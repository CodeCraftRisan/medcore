import { Schema, model } from 'mongoose';
import { slotStatuses } from './doctor.schemas.js';

const slotSchema = new Schema(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: {
      type: String,
      enum: slotStatuses,
      default: 'available',
      required: true,
    },
    heldBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    holdExpiresAt: { type: Date, default: null },
  },
  { collection: 'slots', versionKey: false },
);

slotSchema.index({ doctorId: 1, startAt: 1 }, { unique: true });
slotSchema.index({ status: 1, holdExpiresAt: 1 });

export const Slot = model('Slot', slotSchema);
