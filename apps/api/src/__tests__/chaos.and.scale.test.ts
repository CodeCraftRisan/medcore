import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { promisify } from 'node:util';
import argon2 from 'argon2';
import { Redis } from 'ioredis';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { summarizeLatency } from '../../../../loadtest/stats.js';
import { createApp } from '../app.js';
import { closeMongo, connectMongo } from '../config/db.js';
import { env } from '../config/env.js';
import { closeRedis, connectRedis } from '../config/redis.js';
import { AuditLog } from '../modules/audit/audit.model.js';
import { signAccessToken } from '../modules/auth/accessToken.js';
import { User } from '../modules/auth/user.model.js';
import { Appointment } from '../modules/booking/appointment.model.js';
import { activeAppointmentStatuses } from '../modules/booking/booking.states.js';
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
import { Outbox } from '../shared/outbox/outbox.model.js';

const redisOverride = vi.hoisted(() => ({
  client: undefined as Redis | undefined,
}));
vi.mock('../config/redis.js', async (load) => {
  const config = await load<typeof import('../config/redis.js')>();
  return {
    ...config,
    redis: new Proxy(config.redis, {
      get(target, property) {
        const client = redisOverride.client ?? target;
        const member = Reflect.get(client, property, client);
        return typeof member === 'function' ? member.bind(client) : member;
      },
    }),
  };
});

const docker = promisify(execFile);
const app = createApp();
const server = createServer(app);
const database = 'medcore_chaos_' + randomUUID().replaceAll('-', '');
const users = Array.from({ length: 1000 }, () => new Types.ObjectId());
const authorization = users.map(
  (id) => 'Bearer ' + signAccessToken(id.toHexString(), 'patient'),
);
const amount = 2500;
let doctorId: Types.ObjectId;
let port: number;
let slotNumber = 0;

beforeAll(async () => {
  env.RATE_LIMIT_KEY_PREFIX = database;
  env.API_RATE_LIMIT = 5000;
  await connectMongo(database);
  await connectRedis();
  const passwordHash = await argon2.hash('scale-test-password');
  const doctorUserId = new Types.ObjectId();
  await User.insertMany(
    users.map((_id) => ({
      _id,
      email: _id.toHexString() + '@example.test',
      passwordHash,
    })),
  );
  await User.create({
    _id: doctorUserId,
    email: doctorUserId.toHexString() + '@example.test',
    passwordHash,
    role: 'doctor',
  });
  doctorId = (
    await Doctor.create({
      userId: doctorUserId,
      name: 'Scale fixture',
      specialty: 'Integration',
      consultationFee: amount,
      location: { type: 'Point', coordinates: [90.376, 23.746] },
    })
  )._id;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', backlog: 2048 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  port = address.port;
}, 30000);

afterAll(async () => {
  try {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (
      mongoose.connection.readyState === 1 &&
      mongoose.connection.name === database
    ) {
      await mongoose.connection.dropDatabase();
    }
  } finally {
    await Promise.all([closeMongo(), closeRedis()]);
  }
});

async function makeSlot() {
  const startAt = new Date(Date.UTC(2030, 1, 1, slotNumber++));
  return Slot.create({
    doctorId,
    startAt,
    endAt: new Date(startAt.getTime() + 1_800_000),
  });
}

async function burst(slotId: string, count: number) {
  // Pipeline the burst over established sockets to keep TCP admission outside the measurement.
  const lanes = Array.from(
    { length: Math.min(20, count) },
    () => [] as string[],
  );
  authorization
    .slice(0, count)
    .forEach((auth, index) => lanes[index % lanes.length].push(auth));
  const sockets: Socket[] = [];
  let elapsed: number;
  let results: { status: number; duration: number }[];
  try {
    await Promise.all(
      lanes.map(
        () =>
          new Promise<void>((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port });
            sockets.push(socket);
            socket.once('connect', resolve);
            socket.once('error', reject);
          }),
      ),
    );

    const started = performance.now();
    const body = JSON.stringify({ slotId });
    const responses = await Promise.all(
      sockets.map(
        (socket, index) =>
          new Promise<{ status: number; duration: number }[]>(
            (resolve, reject) => {
              const batch = lanes[index];
              const parsed: { status: number; duration: number }[] = [];
              let buffer = Buffer.alloc(0);
              socket.setTimeout(30000, () =>
                socket.destroy(new Error('HTTP pipeline timed out')),
              );
              socket.once('error', reject);
              socket.once('close', () => {
                if (parsed.length !== batch.length)
                  reject(
                    new Error('HTTP pipeline closed before all responses'),
                  );
                else resolve(parsed);
              });
              socket.on('data', (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                while (true) {
                  const end = buffer.indexOf('\r\n\r\n');
                  if (end < 0) break;
                  const headers = buffer.subarray(0, end).toString('ascii');
                  const status = Number(
                    /^HTTP\/1\.1 (\d{3})/.exec(headers)?.[1],
                  );
                  const length = Number(
                    /(?:^|\r\n)Content-Length: (\d+)/i.exec(headers)?.[1],
                  );
                  if (!status || !Number.isFinite(length)) {
                    socket.destroy(
                      new Error('Invalid HTTP response in booking pipeline'),
                    );
                    break;
                  }
                  const consumed = end + 4 + length;
                  if (buffer.length < consumed) break;
                  parsed.push({ status, duration: performance.now() - begin });
                  buffer = buffer.subarray(consumed);
                }
              });
              const payload = batch
                .map((auth, position) =>
                  [
                    'POST /api/bookings/hold HTTP/1.1',
                    'Host: 127.0.0.1:' + port,
                    'Authorization: ' + auth,
                    'Idempotency-Key: ' + randomUUID(),
                    'Content-Type: application/json',
                    'Content-Length: ' + Buffer.byteLength(body),
                    'Connection: ' +
                      (position === batch.length - 1 ? 'close' : 'keep-alive'),
                    '',
                    body,
                  ].join('\r\n'),
                )
                .join('');
              const begin = performance.now();
              socket.write(payload);
            },
          ),
      ),
    );
    results = responses.flat();
    elapsed = performance.now() - started;
  } finally {
    for (const socket of sockets) socket.destroy();
  }
  const statuses = Object.fromEntries(
    [...new Set(results.map(({ status }) => status))].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  const active = await Appointment.countDocuments({
    slotId,
    status: { $in: [...activeAppointmentStatuses] },
  });
  expect(statuses).toEqual({ 201: 1, 409: count - 1 });
  expect(active).toBe(1);
  expect(await Appointment.countDocuments({ slotId })).toBe(1);
  return summarizeLatency(
    results.map(({ duration }) => duration),
    elapsed,
  );
}

it('holds once under 1,000 simultaneous HTTP requests', async () => {
  const slot = await makeSlot();
  const stats = await burst(slot._id.toHexString(), 1000);
  console.info(
    'Scale results | 1000 | 1 | 999 | 0 | ' +
      [stats.requestsPerSecond, stats.p50, stats.p95, stats.p99]
        .map((value) => value.toFixed(2))
        .join(' | '),
  );
}, 60000);

it('falls back to MongoDB after the isolated Redis container is killed', async () => {
  const name = 'medcore-chaos-' + randomUUID();
  const slot = await makeSlot();
  let created = false;
  let killed = false;
  try {
    await docker(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-p',
        '127.0.0.1::6379',
        'redis:7-alpine',
      ],
      { timeout: 30000 },
    );
    created = true;
    const { stdout } = await docker('docker', ['port', name, '6379/tcp'], {
      timeout: 5000,
    });
    const port = Number(/:(\d+)\s*$/.exec(stdout)?.[1]);
    if (!port)
      throw new Error('Docker did not publish the isolated Redis port');
    const isolated = new Redis({
      host: '127.0.0.1',
      port,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null,
      connectTimeout: 5000,
    });
    redisOverride.client = isolated;
    await isolated.connect();
    expect(await isolated.ping()).toBe('PONG');
    await docker('docker', ['kill', name], { timeout: 15000 });
    killed = true;
    await vi.waitFor(() => expect(isolated.status).toBe('end'), {
      timeout: 5000,
    });
    await expect(isolated.ping()).rejects.toThrow();
    await burst(slot._id.toHexString(), 50);
  } finally {
    redisOverride.client?.disconnect();
    redisOverride.client = undefined;
    if (created && !killed)
      await docker('docker', ['rm', '-f', name], { timeout: 15000 });
  }
}, 60000);

async function checkout() {
  const slot = await makeSlot();
  const hold = await request(server)
    .post('/api/bookings/hold')
    .set('Authorization', authorization[0])
    .set('Idempotency-Key', randomUUID())
    .send({ slotId: slot.id })
    .expect(201);
  const appointmentId: string = hold.body.appointment._id;
  const { body } = await request(server)
    .post('/api/payments/intent')
    .set('Authorization', authorization[0])
    .set('Idempotency-Key', randomUUID())
    .send({ appointmentId })
    .expect(201);
  return {
    appointmentId,
    slotId: slot._id,
    intentId: body.paymentIntentId as string,
  };
}

function webhook(intentId: string, eventId = 'evt_' + randomUUID()) {
  const payload = Buffer.from(
    JSON.stringify({
      id: eventId,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: intentId,
          amount_received: amount,
          currency: env.STRIPE_CURRENCY,
        },
      },
    }),
  );
  return request(server)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signLocalWebhook(payload))
    .send(payload.toString())
    .expect(200);
}

it('processes five simultaneous deliveries of one webhook exactly once', async () => {
  const { appointmentId, intentId, slotId } = await checkout();
  const eventId = 'evt_' + randomUUID();
  const replies = await Promise.all(
    Array.from({ length: 5 }, () => webhook(intentId, eventId)),
  );
  expect(replies.filter(({ body }) => body.duplicate === true)).toHaveLength(4);
  expect(replies.filter(({ body }) => body.received === true)).toHaveLength(1);
  expect(await StripeEvent.countDocuments({ eventId })).toBe(1);
  expect(
    await Outbox.countDocuments({
      type: 'AppointmentConfirmed',
      'payload.appointmentId': new Types.ObjectId(appointmentId),
    }),
  ).toBe(1);
  expect(await AuditLog.countDocuments({ type: 'AppointmentConfirmed' })).toBe(
    1,
  );
  expect(await Slot.findById(slotId)).toMatchObject({ status: 'booked' });
});

it('refunds a payment at the hold expiry boundary without booking the slot', async () => {
  const { appointmentId, slotId, intentId } = await checkout();
  const appointment = await Appointment.findById(appointmentId).orFail();
  await expireHolds(appointment.holdExpiresAt);
  await webhook(intentId);
  expect(await Appointment.findById(appointmentId)).toMatchObject({
    status: 'expired',
  });
  expect(await Slot.findById(slotId)).toMatchObject({ status: 'available' });
  expect(await Payment.findOne({ stripeIntentId: intentId })).toMatchObject({
    status: 'refunded',
  });
  expect(
    await Outbox.countDocuments({
      type: 'LatePaymentRefunded',
      'payload.stripeIntentId': intentId,
    }),
  ).toBe(1);
});

it('reconciles a successful payment whose webhook was never delivered', async () => {
  const { appointmentId, slotId, intentId } = await checkout();
  await LocalStripeIntent.updateOne(
    { _id: intentId },
    { $set: { status: 'succeeded' } },
  );
  const eventCount = await StripeEvent.countDocuments();
  await reconcilePayments();
  expect(await StripeEvent.countDocuments()).toBe(eventCount);
  expect(await Appointment.findById(appointmentId)).toMatchObject({
    status: 'confirmed',
  });
  expect(await Slot.findById(slotId)).toMatchObject({ status: 'booked' });
  expect(await Payment.findOne({ stripeIntentId: intentId })).toMatchObject({
    status: 'succeeded',
  });
});

it('serves OpenAPI 3.0 and its HTML viewer', async () => {
  const spec = await request(server).get('/api/docs.json').expect(200);
  expect(spec.body.openapi).toBe('3.0.3');
  expect(Object.keys(spec.body.paths)).toHaveLength(22);
  expect(spec.body.paths['/api/bookings/hold'].post.responses).toHaveProperty(
    '409',
  );
  await request(server)
    .get('/api/docs')
    .expect('Content-Type', /html/)
    .expect(200, /OpenAPI 3.0 JSON/);
});
