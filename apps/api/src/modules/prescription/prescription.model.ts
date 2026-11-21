import { Schema, model } from 'mongoose';

const encryptedFields = {
  ciphertext: { type: String, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
} as const;

export const Prescription = model(
  'Prescription',
  new Schema(
    {
      appointmentId: {
        type: Schema.Types.ObjectId,
        ref: 'Appointment',
        required: true,
        index: true,
      },
      patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
      ...encryptedFields,
      wrappedDEK: {
        type: new Schema(encryptedFields, { _id: false }),
        required: true,
      },
      keyId: { type: String, required: true },
    },
    { collection: 'prescriptions', timestamps: true, versionKey: false },
  ),
);
