import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { closeMongo, connectMongo } from '../config/db.js';
import { closeRedis, connectRedis, redis } from '../config/redis.js';
import { signAccessToken } from '../modules/auth/accessToken.js';
import { User } from '../modules/auth/user.model.js';
import { Appointment } from '../modules/booking/appointment.model.js';
import { activeAppointmentStatuses } from '../modules/booking/booking.states.js';
import { Doctor } from '../modules/doctor/doctor.model.js';
import { Slot } from '../modules/doctor/slot.model.js';
import { acquireSlotLock, releaseSlotLock } from '../shared/lock/redisLock.js';
import { IdempotencyKey } from '../shared/middleware/idempotencyKey.model.js';

const app = createApp();
const doctorId = new Types.ObjectId();
const doctorUserId = new Types.ObjectId();
const patientIds = Array.from({ length: 100 }, () => new Types.ObjectId());
const authorizations = patientIds.map(
  (id) => `Bearer ${signAccessToken(id.toHexString(), 'patient')}`,
);
let slotNumber = 0;

async function makeSlot() {
  const startAt = new Date(Date.UTC(2030, 8, 1, slotNumber++));
  const slot = await Slot.create({
    doctorId,
    startAt,
    endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
  });
  return slot._id.toHexString();
}

function hold(slotId: string, patient = 0, key = randomUUID()) {
  return request(app)
    .post('/api/bookings/hold')
    .set('Authorization', authorizations[patient])
    .set('Idempotency-Key', key)
    .send({ slotId });
}

async function expectOneWinner(slotId: string, count: number) {
  const results = await Promise.all(
    authorizations
      .slice(0, count)
      .map((_authorization, index) => hold(slotId, index)),
  );
  const winners = results.filter(({ status }) => status === 201);
  expect(winners).toHaveLength(1);
  expect(results.filter(({ status }) => status === 409)).toHaveLength(
    count - 1,
  );

  const active = await Appointment.find({
    slotId,
    status: { $in: [...activeAppointmentStatuses] },
  });
  expect(active).toHaveLength(1);
  expect(active[0]._id.toHexString()).toBe(winners[0].body.appointment._id);
  const slot = await Slot.findById(slotId).orFail();
  expect(slot.status).toBe('held');
  expect(slot.heldBy?.equals(active[0].patientId)).toBe(true);
  expect(slot.holdExpiresAt).toEqual(active[0].holdExpiresAt);
}

beforeAll(async () => {
  await connectMongo();
  await connectRedis();
  const passwordHash = await argon2.hash('booking-test-fixture-password');
  await User.insertMany([
    ...patientIds.map((_id) => ({
      _id,
      email: `${_id}@example.test`,
      passwordHash,
      role: 'patient',
    })),
    {
      _id: doctorUserId,
      email: `${doctorUserId}@example.test`,
      passwordHash,
      role: 'doctor',
    },
  ]);
  await Doctor.create({
    _id: doctorId,
    userId: doctorUserId,
    name: 'Booking test doctor',
    specialty: 'Booking test',
    consultationFee: 1000,
    location: { type: 'Point', coordinates: [90.376, 23.746] },
  });
}, 15_000);

afterAll(async () => {
  try {
    if (Slot.db.readyState === 1) {
      await IdempotencyKey.deleteMany({ userId: { $in: patientIds } });
      await Appointment.deleteMany({ doctorId });
      await Slot.deleteMany({ doctorId });
      await Doctor.deleteOne({ _id: doctorId });
      await User.deleteMany({ _id: { $in: [...patientIds, doctorUserId] } });
    }
  } finally {
    await Promise.all([closeMongo(), closeRedis()]);
  }
});

it('replays the exact 201, rejects a different body, and requires a key', async () => {
  const slotId = await makeSlot();
  const anotherSlot = await makeSlot();
  const key = randomUUID();
  await request(app)
    .post('/api/bookings/hold')
    .set('Authorization', authorizations[0])
    .send({ slotId })
    .expect(400, { code: 'INVALID_IDEMPOTENCY_KEY' });
  const first = await hold(slotId, 0, key).expect(201);
  const replay = await hold(slotId, 0, key).expect(201);
  expect(replay.text).toBe(first.text);
  expect(await Appointment.countDocuments({ doctorId, slotId })).toBe(1);
  await hold(anotherSlot, 0, key).expect(422, {
    code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
  });
});

it('creates exactly one appointment among 100 concurrent requests with Redis', async () => {
  await expectOneWinner(await makeSlot(), 100);
}, 30_000);

it('creates exactly one appointment among 50 concurrent requests when Redis SET fails', async () => {
  const slotId = await makeSlot();
  const set = vi
    .spyOn(redis, 'set')
    .mockRejectedValue(new Error('Redis offline'));
  try {
    await expectOneWinner(slotId, 50);
    expect(set).toHaveBeenCalledTimes(50);
  } finally {
    set.mockRestore();
  }
}, 30_000);

it('reports an in-progress request for the same key and leaves failed keys retryable', async () => {
  const slotId = await makeSlot();
  const key = randomUUID();
  const realSet = redis.set.bind(redis);
  const set = vi.spyOn(redis, 'set');
  let unblock = () => {};
  let entered = () => {};
  const paused = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  set.mockImplementationOnce(async (...args: Parameters<typeof redis.set>) => {
    entered();
    await paused;
    return realSet(...args);
  });
  const pending = hold(slotId, 0, key)
    .expect(201)
    .then((response) => response);
  try {
    await Promise.race([
      acquired,
      pending.then(() => {
        throw new Error('Hold finished before acquiring the lock');
      }),
    ]);
    await hold(slotId, 0, key).expect(409, {
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });
  } finally {
    unblock();
    set.mockRestore();
    await pending;
  }

  const anotherSlot = await makeSlot();
  const token = await acquireSlotLock(anotherSlot);
  if (!token) throw new Error('Expected Redis lock');
  const retryKey = randomUUID();
  try {
    await hold(anotherSlot, 0, retryKey).expect(409, { code: 'SLOT_LOCKED' });
  } finally {
    await releaseSlotLock(anotherSlot, token);
  }
  await hold(anotherSlot, 0, retryKey).expect(201);
});

it('prevents an old Redis lock owner from deleting the new owner’s lock', async () => {
  const id = new Types.ObjectId().toHexString();
  const old = await acquireSlotLock(id);
  if (!old) throw new Error('Expected initial Redis lock');
  await redis.pexpire(`lock:slot:${id}`, 0);
  const current = await acquireSlotLock(id);
  if (!current) throw new Error('Expected replacement Redis lock');
  try {
    await releaseSlotLock(id, old);
    expect(await redis.get(`lock:slot:${id}`)).toBe(current);
  } finally {
    await releaseSlotLock(id, current);
  }
});

it('enforces the partial unique index and atomically cancels and releases the slot', async () => {
  const slotId = await makeSlot();
  const { body } = await hold(slotId).expect(201);
  const appointment = await Appointment.findById(body.appointment._id).orFail();
  const duplicate = {
    patientId: patientIds[1],
    doctorId,
    slotId,
    status: 'confirmed' as const,
    idempotencyKey: randomUUID(),
    holdExpiresAt: appointment.holdExpiresAt,
  };
  await expect(Appointment.create(duplicate)).rejects.toMatchObject({
    code: 11000,
  });

  const url = `/api/bookings/${appointment._id}/cancel`;
  await request(app)
    .post(url)
    .set('Authorization', authorizations[1])
    .set('Idempotency-Key', randomUUID())
    .expect(404);

  const key = randomUUID();
  const cancel = () =>
    request(app)
      .post(url)
      .set('Authorization', authorizations[0])
      .set('Idempotency-Key', key);
  const cancelled = await cancel().expect(200);
  expect(cancelled.body.appointment.status).toBe('cancelled');
  expect((await cancel().expect(200)).text).toBe(cancelled.text);
  const slot = await Slot.findById(slotId).orFail();
  expect(slot).toMatchObject({
    status: 'available',
    heldBy: null,
    holdExpiresAt: null,
  });
  await hold(slotId, 1).expect(201);
});
