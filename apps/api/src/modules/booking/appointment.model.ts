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

export const Appointment = model('Appointment', schema);
