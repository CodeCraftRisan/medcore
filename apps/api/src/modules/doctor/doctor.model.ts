import { Schema, model } from 'mongoose';
import { coordinatesSchema } from './doctor.schemas.js';

const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: {
      type: [Number],
      required: true,
      default: undefined,
      validate: (value: number[]) => coordinatesSchema.safeParse(value).success,
    },
  },
  { _id: false },
);

const doctorSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    name: { type: String, required: true, trim: true },
    specialty: { type: String, required: true, trim: true, index: true },
    consultationFee: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    location: { type: pointSchema, required: true },
  },
  { collection: 'doctors', versionKey: false },
);

doctorSchema.index({ location: '2dsphere' });

export const Doctor = model('Doctor', doctorSchema);
