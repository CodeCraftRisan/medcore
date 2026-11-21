import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  acquireSlotLock,
  releaseSlotLock,
} from '../../shared/lock/redisLock.js';
import { requireAuth } from '../../shared/middleware/auth.js';
import {
  completeIdempotency,
  requireIdempotency,
} from '../../shared/middleware/idempotency.js';
import { Slot } from '../doctor/slot.model.js';
import { Appointment } from './appointment.model.js';
import {
  canTransitionAppointment,
  canTransitionSlot,
} from './booking.states.js';

const objectId = z
  .string()
  .regex(/^[a-f0-9]{24}$/i)
  .transform((id) => id.toLowerCase());
const holdInput = z.strictObject({ slotId: objectId });
const cancelInput = z.strictObject({ appointmentId: objectId });

export const bookingRouter = Router();
bookingRouter.use(requireAuth);

bookingRouter.post('/hold', requireIdempotency, async (req, res) => {
  const input = holdInput.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ code: 'INVALID_INPUT' });
    return;
  }

  const { slotId } = input.data;
  const patientId = req.auth!.sub;
  const claim = res.locals.idempotency!;
  const lock = await acquireSlotLock(slotId);
  if (lock === null) {
    res.status(409).json({ code: 'SLOT_LOCKED' });
    return;
  }

  try {
    const body = await mongoose.connection.transaction(async (session) => {
      const holdExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const slot = await Slot.findOneAndUpdate(
        { _id: slotId, status: 'available' },
        { $set: { status: 'held', heldBy: patientId, holdExpiresAt } },
        { session, returnDocument: 'after' },
      );
      if (!slot) return null;

      const appointment = await new Appointment({
        patientId,
        doctorId: slot.doctorId,
        slotId,
        status: 'pending_payment',
        idempotencyKey: claim.key,
        holdExpiresAt,
      }).save({ session });

      const body = { appointment: appointment.toJSON() };
      await completeIdempotency(claim, 201, body, session);
      return body;
    });

    if (!body) {
      res.status(409).json({ code: 'SLOT_NOT_AVAILABLE' });
      return;
    }
    claim.committed = true;
    res.status(201).json(body);
  } catch (error) {
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      error.code === 11000 &&
      error.keyPattern?.slotId === 1
    ) {
      res.status(409).json({ code: 'SLOT_NOT_AVAILABLE' });
      return;
    }
    throw error;
  } finally {
    if (lock) await releaseSlotLock(slotId, lock);
  }
});

bookingRouter.post(
  '/:appointmentId/cancel',
  requireIdempotency,
  async (req, res) => {
    const input = cancelInput.safeParse(req.params);
    const bodyInput = z.strictObject({}).optional().safeParse(req.body);
    if (!input.success || !bodyInput.success) {
      res.status(400).json({ code: 'INVALID_INPUT' });
      return;
    }

    const claim = res.locals.idempotency!;
    const result = await mongoose.connection.transaction(async (session) => {
      const appointment = await Appointment.findOne({
        _id: input.data.appointmentId,
        patientId: req.auth!.sub,
      }).session(session);
      if (!appointment)
        return {
          status: 404,
          body: { code: 'APPOINTMENT_NOT_FOUND' },
        } as const;

      if (!canTransitionAppointment(appointment.status, 'cancelled')) {
        return {
          status: 409,
          body: { code: 'APPOINTMENT_NOT_CANCELLABLE' },
        } as const;
      }

      const slot = await Slot.findById(appointment.slotId).session(session);
      const expectedStatus =
        appointment.status === 'confirmed' ? 'booked' : 'held';
      if (
        !slot ||
        slot.status !== expectedStatus ||
        !canTransitionSlot(slot.status, 'available') ||
        (slot.status === 'held' && !slot.heldBy?.equals(appointment.patientId))
      ) {
        return { status: 409, body: { code: 'SLOT_STATE_CONFLICT' } } as const;
      }

      slot.status = 'available';
      slot.heldBy = null;
      slot.holdExpiresAt = null;
      await slot.save({ session });

      appointment.status = 'cancelled';
      await appointment.save({ session });

      const body = { appointment: appointment.toJSON() };
      await completeIdempotency(claim, 200, body, session);
      return { status: 200, body } as const;
    });

    claim.committed = result.status === 200;
    res.status(result.status).json(result.body);
  },
);
