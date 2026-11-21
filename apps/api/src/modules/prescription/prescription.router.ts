import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  decryptPrescription,
  encryptPrescription,
  rotatePrescriptionKey,
} from '../../shared/crypto/envelope.js';
import { requireAuth, requireRole } from '../../shared/middleware/auth.js';
import { appendAuditLog } from '../audit/audit.service.js';
import { Appointment } from '../booking/appointment.model.js';
import { Doctor } from '../doctor/doctor.model.js';
import { Prescription } from './prescription.model.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const text = z.string().trim().min(1).max(4000);
const medicalFields = z.strictObject({
  diagnosis: text,
  medications: z
    .array(
      z.union([
        text,
        z.strictObject({
          name: text,
          dose: text.optional(),
          dosage: text.optional(),
          frequency: text.optional(),
          instructions: text.optional(),
          duration: text.optional(),
        }),
      ]),
    )
    .max(50),
  notes: text.or(z.literal('')).optional(),
});
const createInput = medicalFields.extend({ appointmentId: objectId });

function aad(value: {
  appointmentId: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
}): string {
  return (
    value.appointmentId.toHexString() + ':' + value.patientId.toHexString()
  );
}

export const prescriptionRouter = Router();
prescriptionRouter.use(requireAuth, (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

prescriptionRouter.post(
  '/',
  requireRole('doctor', 'admin'),
  async (req, res) => {
    const input = createInput.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'INVALID_INPUT' });
      return;
    }
    const { appointmentId, ...medical } = input.data;
    const appointment = await Appointment.findById(appointmentId).lean();
    if (!appointment) {
      res.status(404).json({ code: 'APPOINTMENT_NOT_FOUND' });
      return;
    }
    if (
      req.auth!.role !== 'admin' &&
      !(await Doctor.exists({
        _id: appointment.doctorId,
        userId: req.auth!.sub,
      }))
    ) {
      res.status(403).json({ code: 'FORBIDDEN' });
      return;
    }
    if (!Object.hasOwn(env.PRESCRIPTION_KEKS, env.PRESCRIPTION_ACTIVE_KEK_ID)) {
      res.status(503).json({ code: 'PRESCRIPTION_KEYS_UNAVAILABLE' });
      return;
    }

    const references = {
      appointmentId: appointment._id,
      patientId: appointment.patientId,
      doctorId: appointment.doctorId,
    };
    const encrypted = encryptPrescription(
      Buffer.from(JSON.stringify(medical)),
      aad(references),
    );
    const id = await mongoose.connection.transaction(async (session) => {
      const prescription = await new Prescription({
        ...references,
        ...encrypted,
      }).save({ session });
      await appendAuditLog(
        'PrescriptionCreated',
        {
          prescriptionId: prescription._id.toHexString(),
          appointmentId: appointment._id.toHexString(),
        },
        session,
      );
      return prescription._id;
    });
    res.status(201).json({ id });
  },
);

prescriptionRouter.get('/:id', async (req, res) => {
  const id = objectId.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ code: 'INVALID_ID' });
    return;
  }
  const prescription = await Prescription.findById(id.data).lean();
  if (!prescription) {
    res.status(404).json({ code: 'PRESCRIPTION_NOT_FOUND' });
    return;
  }
  const auth = req.auth!;
  const canRead =
    auth.role === 'admin' ||
    (auth.role === 'patient' && prescription.patientId.equals(auth.sub)) ||
    (auth.role === 'doctor' &&
      (await Doctor.exists({ _id: prescription.doctorId, userId: auth.sub })));
  if (!canRead) {
    res.status(403).json({ code: 'FORBIDDEN' });
    return;
  }

  let medical;
  try {
    const plaintext = decryptPrescription(prescription, aad(prescription));
    medical = medicalFields.parse(JSON.parse(plaintext.toString('utf8')));
  } catch {
    req.log.warn('Prescription decryption or integrity check failed');
    res.status(500).json({ code: 'PRESCRIPTION_DECRYPTION_FAILED' });
    return;
  }
  res.json({
    id: prescription._id,
    appointmentId: prescription.appointmentId,
    patientId: prescription.patientId,
    doctorId: prescription.doctorId,
    ...medical,
  });
});

prescriptionRouter.post(
  '/:id/rotate-key',
  requireRole('admin'),
  async (req, res) => {
    const id = objectId.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ code: 'INVALID_ID' });
      return;
    }
    const prescription = await Prescription.findById(id.data).lean();
    if (!prescription) {
      res.status(404).json({ code: 'PRESCRIPTION_NOT_FOUND' });
      return;
    }

    if (prescription.keyId !== env.PRESCRIPTION_ACTIVE_KEK_ID) {
      const rewrapped = rotatePrescriptionKey(prescription, aad(prescription));
      const result = await Prescription.updateOne(
        { _id: prescription._id, keyId: prescription.keyId },
        { $set: rewrapped },
      );
      if (!result.matchedCount) {
        res.status(409).json({ code: 'PRESCRIPTION_KEY_CHANGED' });
        return;
      }
    }
    res.json({ keyId: env.PRESCRIPTION_ACTIVE_KEK_ID });
  },
);
