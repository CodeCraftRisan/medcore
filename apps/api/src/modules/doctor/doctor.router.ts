import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../../shared/middleware/auth.js';
import { Doctor } from './doctor.model.js';
import {
  createSlotsSchema,
  doctorParamsSchema,
  listSlotsSchema,
  nearbySchema,
  profileSchema,
} from './doctor.schemas.js';
import { Slot } from './slot.model.js';

export const doctorRouter = Router();
const canManage = [requireAuth, requireRole('doctor', 'admin')];

doctorRouter.post('/profile', ...canManage, async (req, res) => {
  const input = profileSchema.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ code: 'INVALID_INPUT' });
    return;
  }

  const doctor = await Doctor.findOneAndUpdate(
    { userId: req.auth!.sub },
    { $set: input.data },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );

  res.json({ doctor });
});

doctorRouter.get('/nearby', async (req, res) => {
  const input = nearbySchema.safeParse(req.query);
  if (!input.success) {
    res.status(400).json({ code: 'INVALID_QUERY' });
    return;
  }

  const { lng, lat, maxDistanceKm, specialty } = input.data;
  const doctors = await Doctor.find({
    ...(specialty === undefined ? {} : { specialty }),
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: maxDistanceKm * 1000,
      },
    },
  })
    .select('-userId')
    .lean();

  res.json({ doctors });
});

doctorRouter.post('/:doctorId/slots', ...canManage, async (req, res) => {
  const params = doctorParamsSchema.safeParse(req.params);
  const input = createSlotsSchema.safeParse(req.body);
  if (!params.success || !input.success) {
    res.status(400).json({ code: 'INVALID_INPUT' });
    return;
  }

  const { doctorId } = params.data;
  const doctor = await Doctor.findById(doctorId).select('userId').lean();
  if (!doctor) {
    res.status(404).json({ code: 'DOCTOR_NOT_FOUND' });
    return;
  }

  const auth = req.auth!;
  if (auth.role !== 'admin' && !doctor.userId.equals(auth.sub)) {
    res.status(403).json({ code: 'FORBIDDEN' });
    return;
  }

  try {
    const slots = await mongoose.connection.transaction((session) =>
      Slot.insertMany(
        input.data.map((slot) => ({ ...slot, doctorId })),
        { session },
      ),
    );
    res.status(201).json({ slots });
  } catch (error) {
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      error.code === 11000
    ) {
      res.status(409).json({ code: 'DUPLICATE_SLOT' });
      return;
    }
    throw error;
  }
});

doctorRouter.get('/:doctorId/slots', async (req, res) => {
  const params = doctorParamsSchema.safeParse(req.params);
  const input = listSlotsSchema.safeParse(req.query);
  if (!params.success || !input.success) {
    res.status(400).json({ code: 'INVALID_QUERY' });
    return;
  }

  const { status, from, to } = input.data;
  const slots = await Slot.find({
    doctorId: params.data.doctorId,
    ...(status === undefined ? {} : { status }),
    ...(from || to
      ? {
          startAt: {
            ...(from ? { $gte: from } : {}),
            ...(to ? { $lt: to } : {}),
          },
        }
      : {}),
  })
    .select('-heldBy')
    .sort({ startAt: 1 })
    .lean();

  res.json({ slots });
});
