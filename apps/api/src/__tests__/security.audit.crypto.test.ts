import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { closeMongo, connectMongo } from '../config/db.js';
import { env } from '../config/env.js';
import { closeRedis, connectRedis } from '../config/redis.js';
import { AuditHead, AuditLog } from '../modules/audit/audit.model.js';
import { appendAuditLog } from '../modules/audit/audit.service.js';
import { signAccessToken } from '../modules/auth/accessToken.js';
import { Appointment } from '../modules/booking/appointment.model.js';
import { Doctor } from '../modules/doctor/doctor.model.js';
import { Prescription } from '../modules/prescription/prescription.model.js';
import { auditHash } from '../shared/crypto/hashChain.js';
import { logger } from '../shared/observability/logger.js';

const app = createApp();
const dbName = 'medcore_security_' + randomUUID().replaceAll('-', '');
const patientId = new mongoose.Types.ObjectId();
const doctorUserId = new mongoose.Types.ObjectId();
const admin =
  'Bearer ' +
  signAccessToken(new mongoose.Types.ObjectId().toHexString(), 'admin');
const doctor =
  'Bearer ' + signAccessToken(doctorUserId.toHexString(), 'doctor');
const patient = 'Bearer ' + signAccessToken(patientId.toHexString(), 'patient');
const unrelatedPatient =
  'Bearer ' +
  signAccessToken(new mongoose.Types.ObjectId().toHexString(), 'patient');
const audit = '/api/audit';
const prescriptions = '/api/prescriptions';
const medical = {
  diagnosis: 'fixture diagnosis',
  medications: ['fictional medication'],
  notes: 'fixture notes',
};

it('logs a structured warning for a query over 100ms', async () => {
  const query = AuditLog.collection.findOne.bind(AuditLog.collection);
  const lookup = vi
    .spyOn(AuditLog.collection, 'findOne')
    .mockImplementationOnce(async (...args) => {
      await delay(120);
      return query(...args);
    });
  const warning = vi.spyOn(logger, 'warn');
  try {
    await AuditLog.findOne({ seq: 1 }).orFail();
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'findOne',
        collection: 'audit_logs',
      }),
      'slow_query_detected',
    );
  } finally {
    lookup.mockRestore();
    warning.mockRestore();
  }
});
let doctorId: mongoose.Types.ObjectId;
let anchorDir: string;

beforeAll(async () => {
  anchorDir = await mkdtemp(join(tmpdir(), 'medcore-anchor-'));
  env.AUDIT_ANCHOR_DIR = anchorDir;
  env.PRESCRIPTION_KEKS = {
    'kek-v1': randomBytes(32).toString('base64'),
    'kek-v2': randomBytes(32).toString('base64'),
  };
  env.PRESCRIPTION_ACTIVE_KEK_ID = 'kek-v1';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  env.AUDIT_ANCHOR_PRIVATE_KEY = privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64');
  env.AUDIT_ANCHOR_PUBLIC_KEY = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  env.RATE_LIMIT_KEY_PREFIX = dbName;
  await connectMongo(dbName);
  await connectRedis();
  doctorId = (
    await Doctor.create({
      userId: doctorUserId,
      name: 'Fixture doctor',
      specialty: 'Integration',
      consultationFee: 2500,
      location: { type: 'Point', coordinates: [90.376, 23.746] },
    })
  )._id;
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      appendAuditLog('FixtureEvent', { index, name: 'private fixture' }),
    ),
  );
}, 20_000);

afterAll(async () => {
  try {
    if (
      mongoose.connection.readyState === 1 &&
      mongoose.connection.name === dbName
    ) {
      await mongoose.connection.dropDatabase();
    }
    if (anchorDir) await rm(anchorDir, { recursive: true, force: true });
  } finally {
    await Promise.all([closeMongo(), closeRedis()]);
  }
});

async function createPrescription() {
  const appointment = await Appointment.create({
    patientId,
    doctorId,
    slotId: new mongoose.Types.ObjectId(),
    status: 'confirmed',
    idempotencyKey: randomUUID(),
    holdExpiresAt: new Date(),
  });
  const response = await request(app)
    .post(prescriptions)
    .set('Authorization', doctor)
    .send({ appointmentId: appointment.id, ...medical })
    .expect(201);
  return Prescription.findById(response.body.id).orFail();
}

it('serializes concurrent appends and detects tampering and deletion', async () => {
  await request(app)
    .get(audit + '/verify')
    .set('Authorization', admin)
    .expect(200, { valid: true, totalEntries: 5 });
  const entry = await AuditLog.findOne({ seq: 3 }).lean().orFail();
  expect(JSON.stringify(entry)).not.toContain('private fixture');
  try {
    await AuditLog.updateOne({ seq: 3 }, { $set: { type: 'Changed' } });
    await request(app)
      .get(audit + '/verify')
      .set('Authorization', admin)
      .expect(200, { valid: false, brokenAtSeq: 3, reason: 'HASH_MISMATCH' });
  } finally {
    await AuditLog.updateOne({ seq: 3 }, { $set: { type: entry.type } });
  }
  const tail = await AuditLog.findOne({ seq: 5 }).lean().orFail();
  try {
    await AuditLog.deleteOne({ seq: 5 });
    await request(app)
      .get(audit + '/verify')
      .set('Authorization', admin)
      .expect(200, { valid: false, brokenAtSeq: 5, reason: 'HEAD_MISMATCH' });
  } finally {
    await AuditLog.create(tail);
  }
});

it('verifies the external Ed25519 anchor and rejects a rewritten audit tip', async () => {
  await request(app)
    .post(audit + '/anchor')
    .set('Authorization', patient)
    .expect(403);
  await request(app)
    .post(audit + '/anchor')
    .set('Authorization', admin)
    .expect(201);
  expect(await readdir(anchorDir)).toHaveLength(1);
  await request(app)
    .get(audit + '/anchor/verify')
    .set('Authorization', admin)
    .expect(200, { valid: true, seq: 5 });
  const entry = await AuditLog.findOne({ seq: 5 }).lean().orFail();
  const altered = { ...entry, type: 'Rewrite' };
  const hash = auditHash(altered);
  try {
    await AuditLog.updateOne(
      { seq: 5 },
      { $set: { type: altered.type, hash } },
    );
    await AuditHead.updateOne({ _id: 'main' }, { $set: { hash } });
    await request(app)
      .get(audit + '/verify')
      .set('Authorization', admin)
      .expect(200, { valid: true, totalEntries: 5 });
    await request(app)
      .get(audit + '/anchor/verify')
      .set('Authorization', admin)
      .expect(200, { valid: false, reason: 'ANCHOR_MISMATCH' });
    await request(app)
      .post(audit + '/anchor')
      .set('Authorization', admin)
      .expect(409);
  } finally {
    await AuditLog.updateOne(
      { seq: 5 },
      { $set: { type: entry.type, hash: entry.hash } },
    );
    await AuditHead.updateOne({ _id: 'main' }, { $set: { hash: entry.hash } });
  }
});

it('keeps medical data out of MongoDB and rejects an envelope copied to a different appointment', async () => {
  const first = await createPrescription();
  const second = await createPrescription();
  expect(
    JSON.stringify(await Prescription.collection.findOne({ _id: first._id })),
  ).not.toContain(medical.medications[0]);
  expect(
    await AuditLog.countDocuments({ type: 'PrescriptionCreated' }),
  ).toBeGreaterThanOrEqual(2);
  const response = await request(app)
    .get(prescriptions + '/' + first.id)
    .set('Authorization', patient)
    .expect(200);
  expect(response.body).toMatchObject(medical);
  await Prescription.updateOne(
    { _id: second._id },
    {
      $set: {
        ciphertext: first.ciphertext,
        iv: first.iv,
        tag: first.tag,
        wrappedDEK: first.wrappedDEK,
        keyId: first.keyId,
      },
    },
  );
  await request(app)
    .get(prescriptions + '/' + second.id)
    .set('Authorization', patient)
    .expect(500, { code: 'PRESCRIPTION_DECRYPTION_FAILED' });
});

it('rewraps the DEK with a new KEK without changing ciphertext, and blocks IDOR', async () => {
  const original = await createPrescription();
  const route = prescriptions + '/' + original.id;
  await request(app)
    .get(route)
    .set('Authorization', unrelatedPatient)
    .expect(403);
  await request(app)
    .post(route + '/rotate-key')
    .set('Authorization', doctor)
    .expect(403);
  env.PRESCRIPTION_ACTIVE_KEK_ID = 'kek-v2';
  try {
    await request(app)
      .post(route + '/rotate-key')
      .set('Authorization', admin)
      .expect(200, { keyId: 'kek-v2' });
    const rotated = await Prescription.findById(original._id).orFail();
    expect(rotated.keyId).toBe('kek-v2');
    expect(rotated.wrappedDEK.ciphertext).not.toBe(
      original.wrappedDEK.ciphertext,
    );
    expect(rotated).toMatchObject({
      ciphertext: original.ciphertext,
      iv: original.iv,
      tag: original.tag,
    });
    expect(
      (await request(app).get(route).set('Authorization', patient).expect(200))
        .body,
    ).toMatchObject(medical);
  } finally {
    env.PRESCRIPTION_ACTIVE_KEK_ID = 'kek-v1';
  }
});

it('applies Redis login and general limits and exposes Prometheus metrics', async () => {
  env.RATE_LIMIT_KEY_PREFIX = dbName + ':limits';
  env.LOGIN_RATE_LIMIT = 2;
  env.API_RATE_LIMIT = 4;
  for (let i = 0; i < 2; i++) {
    await request(app).post('/api/auth/login').send({}).expect(400);
  }
  await request(app)
    .post('/api/auth/login')
    .send({})
    .expect('Retry-After', /^[1-9]\d*$/)
    .expect(429);
  await request(app).get('/api/doctors/nearby').expect(400);
  await request(app)
    .get('/api/doctors/nearby')
    .expect(429, { code: 'RATE_LIMIT_EXCEEDED' });

  const metrics = await request(app).get('/metrics').expect(200);
  expect(metrics.headers['content-type']).toMatch(
    /^text\/plain;.*version=0.0.4/,
  );
  for (const name of [
    'booking_success_total',
    'booking_conflict_total',
    'lock_contention_total',
    'webhook_failures_total',
  ]) {
    expect(metrics.text).toContain('# TYPE medcore_' + name + ' counter');
  }
  expect(metrics.text).toContain(
    'medcore_http_request_duration_seconds_bucket{le="+Inf"}',
  );
});
