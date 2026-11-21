import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeMongo, connectMongo } from '../config/db.js';
import { signAccessToken } from '../modules/auth/accessToken.js';
import type { Role } from '../modules/auth/auth.schemas.js';
import { User } from '../modules/auth/user.model.js';
import { Doctor } from '../modules/doctor/doctor.model.js';
import { Slot } from '../modules/doctor/slot.model.js';

const app = createApp();
const path = '/api/doctors';
const runId = randomUUID();
const specialty = `Cardiology ${runId}`;

let passwordHash: string;

async function bearer(label: string, role: Role = 'doctor') {
  const user = await User.create({
    email: `${runId}-${label}@example.test`,
    passwordHash,
    role,
  });
  return `Bearer ${signAccessToken(user._id.toHexString(), role)}`;
}

function profile(
  name: string,
  coordinates: [number, number] = [90.376, 23.746],
) {
  return {
    name,
    specialty,
    consultationFee: 150000,
    location: { type: 'Point', coordinates },
  };
}

function upsertProfile(
  authorization: string,
  input: ReturnType<typeof profile>,
) {
  return request(app)
    .post(`${path}/profile`)
    .set('Authorization', authorization)
    .send(input);
}

beforeAll(async () => {
  await connectMongo();
  passwordHash = await argon2.hash('doctor-fixture-password', {
    type: argon2.argon2id,
  });
}, 15_000);

afterAll(async () => {
  try {
    if (User.db.readyState === 1) {
      const users = await User.find({ email: new RegExp(`^${runId}-`) }).select(
        '_id',
      );
      const userIds = users.map(({ _id }) => _id);
      const doctors = await Doctor.find({ userId: { $in: userIds } }).select(
        '_id',
      );
      await Slot.deleteMany({
        doctorId: { $in: doctors.map(({ _id }) => _id) },
      });
      await Doctor.deleteMany({ userId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    }
  } finally {
    await closeMongo();
  }
});

it('returns doctors in exact distance order and applies default radius, explicit radius and specialty', async () => {
  const locations = [
    profile('Chittagong', [91.783, 22.356]),
    profile('Uttara', [90.4, 23.875]),
    profile('Dhanmondi', [90.376, 23.746]),
    {
      ...profile('Other specialty', [90.38, 23.75]),
      specialty: `Dermatology ${runId}`,
    },
  ];
  const ids: string[] = [];
  for (const [index, input] of locations.entries()) {
    const who = await bearer(`geo-${index}`);
    const { body } = await upsertProfile(who, input).expect(200);
    ids.push(body.doctor._id);
  }

  const query = { lng: 90.376, lat: 23.746 };
  const all = await request(app)
    .get(`${path}/nearby`)
    .query({ ...query, maxDistanceKm: 300 })
    .expect(200);
  expect(
    all.body.doctors
      .map((doctor: { _id: string }) => doctor._id)
      .filter((id: string) => ids.includes(id)),
  ).toEqual([ids[2], ids[3], ids[1], ids[0]]);

  const filtered = await request(app)
    .get(`${path}/nearby`)
    .query({ ...query, specialty, maxDistanceKm: 25 })
    .expect(200);
  expect(
    filtered.body.doctors.map((doctor: { _id: string }) => doctor._id),
  ).toEqual([ids[2], ids[1]]);

  const defaults = await request(app)
    .get(`${path}/nearby`)
    .query({ ...query, specialty })
    .expect(200);
  expect(
    defaults.body.doctors.map((doctor: { _id: string }) => doctor._id),
  ).toEqual([ids[2]]);
  await request(app)
    .get(`${path}/nearby`)
    .query({ lng: 181, lat: 0 })
    .expect(400);
});

it('upserts one profile per caller and validates role and coordinates', async () => {
  const who = await bearer('profile');
  await upsertProfile(who, profile('Out of bounds', [90, 91])).expect(400);
  await upsertProfile(
    await bearer('patient', 'patient'),
    profile('Not allowed'),
  ).expect(403);

  const first = await upsertProfile(who, profile('Original')).expect(200);
  const updated = await upsertProfile(who, profile('Updated')).expect(200);
  expect(updated.body.doctor).toMatchObject({
    _id: first.body.doctor._id,
    name: 'Updated',
  });
  expect(
    await Doctor.countDocuments({ userId: first.body.doctor.userId }),
  ).toBe(1);
  await upsertProfile(
    await bearer('profile-admin', 'admin'),
    profile('Admin profile'),
  ).expect(200);
});

it('returns 409 for the same doctor and start time and rolls back a conflicting batch', async () => {
  const who = await bearer('unique');
  const { body } = await upsertProfile(who, profile('Unique')).expect(200);
  const doctorId: string = body.doctor._id;
  const url = `${path}/${doctorId}/slots`;
  const slot = {
    startAt: '2030-06-01T09:00:00Z',
    endAt: '2030-06-01T09:30:00Z',
  };
  const added = await request(app)
    .post(url)
    .set('Authorization', who)
    .send(slot)
    .expect(201);
  expect(added.body.slots[0].status).toBe('available');
  await request(app)
    .post(url)
    .set('Authorization', who)
    .send(slot)
    .expect(409, { code: 'DUPLICATE_SLOT' });

  const different = {
    startAt: '2030-06-01T10:00:00Z',
    endAt: '2030-06-01T10:30:00Z',
  };
  await request(app)
    .post(url)
    .set('Authorization', who)
    .send({ slots: [different, slot] })
    .expect(409);
  expect(await Slot.countDocuments({ doctorId })).toBe(1);

  const other = await bearer('unique-other');
  const otherProfile = await upsertProfile(
    other,
    profile('Other doctor'),
  ).expect(200);
  await request(app)
    .post(path + '/' + otherProfile.body.doctor._id + '/slots')
    .set('Authorization', other)
    .send(slot)
    .expect(201);
});

it('limits slot writes to the owner or an admin and filters by status and start time', async () => {
  const owner = await bearer('slots-owner');
  const other = await bearer('slots-other');
  const admin = await bearer('slots-admin', 'admin');
  const { body } = await upsertProfile(owner, profile('Slots')).expect(200);
  const url = `${path}/${body.doctor._id}/slots`;
  const early = {
    startAt: '2030-06-01T08:00:00Z',
    endAt: '2030-06-01T08:30:00Z',
  };
  const late = {
    startAt: '2030-06-01T09:00:00Z',
    endAt: '2030-06-01T09:30:00Z',
  };

  await request(app)
    .post(url)
    .set('Authorization', other)
    .send(early)
    .expect(403);
  await request(app)
    .post(url)
    .set('Authorization', owner)
    .send({ ...early, endAt: early.startAt })
    .expect(400);
  await request(app)
    .post(url)
    .set('Authorization', admin)
    .send({ slots: [late, early] })
    .expect(201);
  await Slot.updateOne(
    { doctorId: body.doctor._id, startAt: new Date(late.startAt) },
    { status: 'booked' },
  );

  const byDate = await request(app)
    .get(url)
    .query({ from: early.startAt, to: late.startAt })
    .expect(200);
  expect(byDate.body.slots).toHaveLength(1);
  expect(byDate.body.slots[0]).toMatchObject({
    status: 'available',
    startAt: new Date(early.startAt).toISOString(),
  });

  const booked = await request(app)
    .get(url)
    .query({ status: 'booked' })
    .expect(200);
  expect(booked.body.slots).toHaveLength(1);
  expect(booked.body.slots[0]).not.toHaveProperty('heldBy');
});
