import { Schema, model } from 'mongoose';
import {
  activeAppointmentStatuses,
  appointmentStatuses,
} from './booking.states.js';

const schema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    slotId: { type: Schema.Types.ObjectId, ref: 'Slot', required: true },
    status: { type: String, enum: appointmentStatuses, required: true },
    paymentIntentId: { type: String, default: null },
    paymentAmount: { type: Number, default: null, select: false },
    idempotencyKey: { type: String, required: true },
    holdExpiresAt: { type: Date, required: true },
  },
  { collection: 'appointments', versionKey: false },
);

schema.index(
  { slotId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [...activeAppointmentStatuses] },
    },
  },
);

schema.index({ status: 1, holdExpiresAt: 1 });

export const Appointment = model('Appointment', schema);
