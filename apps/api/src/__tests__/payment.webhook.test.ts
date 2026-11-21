import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { closeMongo, connectMongo } from '../config/db.js';
import { env } from '../config/env.js';
import { AuditLog } from '../modules/audit/audit.model.js';
import { signAccessToken } from '../modules/auth/accessToken.js';
import { Appointment } from '../modules/booking/appointment.model.js';
import { expireHolds } from '../modules/booking/expireHolds.js';
import { Doctor } from '../modules/doctor/doctor.model.js';
import { Slot } from '../modules/doctor/slot.model.js';
import { Payment } from '../modules/payment/payment.model.js';
import { reconcilePayments } from '../modules/payment/reconcilePayments.js';
import {
  LocalStripeIntent,
  signLocalWebhook,
} from '../modules/payment/stripe.adapter.js';
import { StripeEvent } from '../modules/payment/stripeEvent.model.js';
import { Outbox, OutboxDelivery } from '../shared/outbox/outbox.model.js';
import { outboxRelay } from '../shared/outbox/outboxRelay.js';

const app = createApp();
const testDatabase = 'medcore_payment_' + randomUUID().replaceAll('-', '');
const patientId = new mongoose.Types.ObjectId();
const auth = 'Bearer ' + signAccessToken(patientId.toHexString(), 'patient');
const amount = 2500;

beforeAll(async () => {
  await connectMongo(testDatabase);
}, 15_000);

afterAll(async () => {
  try {
    if (
      mongoose.connection.readyState === 1 &&
      mongoose.connection.name === testDatabase
    ) {
      await mongoose.connection.dropDatabase();
    }
  } finally {
    await closeMongo();
  }
});

async function checkout() {
  const doctor = await Doctor.create({
    userId: new mongoose.Types.ObjectId(),
    name: 'Payment fixture doctor',
    specialty: 'Integration',
    consultationFee: amount,
    location: { type: 'Point', coordinates: [90.376, 23.746] },
  });
  const slot = await Slot.create({
    doctorId: doctor._id,
    startAt: new Date('2030-01-01T12:00:00Z'),
    endAt: new Date('2030-01-01T12:30:00Z'),
  });
  const hold = await request(app)
    .post('/api/bookings/hold')
    .set('Authorization', auth)
    .set('Idempotency-Key', randomUUID())
    .send({ slotId: slot.id })
    .expect(201);
  const appointmentId: string = hold.body.appointment._id;
  const key = randomUUID();
  const intentRequest = () =>
    request(app)
      .post('/api/payments/intent')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .send({ appointmentId });
  const created = await intentRequest().expect(201);
  expect((await intentRequest().expect(201)).body).toEqual(created.body);
  const intentId: string = created.body.paymentIntentId;
  expect(intentId).toMatch(/^pi_/);
  expect(await Appointment.findById(appointmentId)).toMatchObject({
    paymentIntentId: intentId,
  });
  expect(await Payment.findOne({ appointmentId })).toMatchObject({
    stripeIntentId: intentId,
    status: 'pending',
    amount,
  });
  const local = await LocalStripeIntent.findById(intentId).orFail();
  expect(local.metadata).toMatchObject({
    appointmentId,
    patientId: patientId.toHexString(),
    slotId: slot.id,
  });
  return { appointmentId, slotId: slot.id as string, intentId };
}

function webhook(
  intentId: string,
  eventId = 'evt_' + randomUUID(),
  validSignature = true,
  received = amount,
) {
  const payload = Buffer.from(
    JSON.stringify({
      id: eventId,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: intentId,
          amount_received: received,
          currency: env.STRIPE_CURRENCY,
        },
      },
    }),
  );
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set(
      'Stripe-Signature',
      validSignature ? signLocalWebhook(payload) : 'invalid',
    )
    .send(payload.toString());
}

it('confirms the appointment and relays its outbox event once', async () => {
  const { appointmentId, slotId, intentId } = await checkout();
  await webhook(intentId).expect(200, { received: true });

  expect(await Slot.findById(slotId)).toMatchObject({
    status: 'booked',
    holdExpiresAt: null,
  });
  expect(await Appointment.findById(appointmentId)).toMatchObject({
    status: 'confirmed',
  });
  expect(await Payment.findOne({ stripeIntentId: intentId })).toMatchObject({
    status: 'succeeded',
  });
  expect(await AuditLog.countDocuments({ type: 'AppointmentConfirmed' })).toBe(
    1,
  );
  const event = await Outbox.findOne({
    type: 'AppointmentConfirmed',
    'payload.appointmentId': new mongoose.Types.ObjectId(appointmentId),
  }).orFail();
  expect(event.status).toBe('pending');
  const delivery = vi
    .spyOn(OutboxDelivery, 'updateOne')
    .mockImplementationOnce(() => {
      throw new Error('Simulated delivery failure');
    });
  try {
    await outboxRelay();
  } finally {
    delivery.mockRestore();
  }
  expect(await Outbox.findById(event._id)).toMatchObject({
    status: 'pending',
    attempts: 1,
  });
  await Promise.all([outboxRelay(), outboxRelay()]);
  expect(await Outbox.findById(event._id)).toMatchObject({
    status: 'processed',
  });
  expect(await OutboxDelivery.countDocuments({ _id: event._id })).toBe(1);
});

it('deduplicates concurrent delivery of the same Stripe event', async () => {
  const { appointmentId, intentId } = await checkout();
  const eventId = 'evt_' + randomUUID();
  const results = await Promise.all([
    webhook(intentId, eventId).expect(200),
    webhook(intentId, eventId).expect(200),
  ]);
  expect(results.map(({ body }) => body)).toEqual(
    expect.arrayContaining([{ received: true }, { duplicate: true }]),
  );
  expect(await StripeEvent.countDocuments({ eventId })).toBe(1);
  expect(
    await Outbox.countDocuments({
      'payload.appointmentId': new mongoose.Types.ObjectId(appointmentId),
    }),
  ).toBe(1);
});

it('expires a hold and refunds a late payment without modifying the released slot', async () => {
  const { appointmentId, slotId, intentId } = await checkout();
  const appointment = await Appointment.findById(appointmentId).orFail();
  await expireHolds(appointment.holdExpiresAt);

  expect(await Slot.findById(slotId)).toMatchObject({
    status: 'available',
    heldBy: null,
  });
  expect(await Appointment.findById(appointmentId)).toMatchObject({
    status: 'expired',
  });
  await webhook(intentId).expect(200);
  await webhook(intentId).expect(200);

  expect(await Payment.findOne({ stripeIntentId: intentId })).toMatchObject({
    status: 'refunded',
    refundId: expect.stringMatching(/^re_/),
  });
  expect(await Slot.findById(slotId)).toMatchObject({ status: 'available' });
  expect(
    await Outbox.countDocuments({
      type: 'LatePaymentRefunded',
      'payload.stripeIntentId': intentId,
    }),
  ).toBe(1);
});

it('reconciles a succeeded intent even when its webhook was missed', async () => {
  const { appointmentId, slotId, intentId } = await checkout();
  await LocalStripeIntent.updateOne(
    { _id: intentId },
    { $set: { status: 'succeeded' } },
  );
  await reconcilePayments();
  expect(await Appointment.findById(appointmentId)).toMatchObject({
    status: 'confirmed',
  });
  expect(await Slot.findById(slotId)).toMatchObject({ status: 'booked' });
  expect(await Payment.findOne({ stripeIntentId: intentId })).toMatchObject({
    status: 'succeeded',
  });
});

it('retries a late refund after the provider call fails', async () => {
  const { appointmentId, intentId } = await checkout();
  const appointment = await Appointment.findById(appointmentId).orFail();
  await expireHolds(appointment.holdExpiresAt);
  const refund = vi
    .spyOn(LocalStripeIntent, 'updateOne')
    .mockImplementationOnce(() => {
      throw new Error('Simulated provider outage');
    });
  try {
    await webhook(intentId).expect(200, { received: true });
  } finally {
    refund.mockRestore();
  }
  expect(await Payment.findOne({ stripeIntentId: intentId })).toMatchObject({
    status: 'pending',
    refundRequired: true,
  });
  await reconcilePayments();
  expect(await Payment.findOne({ stripeIntentId: intentId })).toMatchObject({
    status: 'refunded',
    refundRequired: false,
  });
  expect(
    await Outbox.countDocuments({
      type: 'LatePaymentRefunded',
      'payload.stripeIntentId': intentId,
    }),
  ).toBe(1);
});

it('rejects a bad signature and leaves a failed transaction retryable', async () => {
  const { intentId, appointmentId } = await checkout();
  const eventId = 'evt_' + randomUUID();
  await webhook(intentId, eventId, false).expect(400);
  await webhook(intentId, eventId, true, amount + 1).expect(500);
  expect(await StripeEvent.findOne({ eventId })).toBeNull();
  expect(await Appointment.findById(appointmentId)).toMatchObject({
    status: 'pending_payment',
  });
  await webhook(intentId, eventId).expect(200, { received: true });
});
