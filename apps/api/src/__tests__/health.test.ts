import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeMongo, connectMongo } from '../config/db.js';
import { closeRedis, connectRedis } from '../config/redis.js';

const app = createApp();

it('returns 200 and generates a fresh UUID for every health request', async () => {
  const first = await request(app)
    .get('/health')
    .set('x-request-id', 'client-value');
  const second = await request(app).get('/health');

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const uuidV4 =
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
  expect(first.headers['x-request-id']).toMatch(uuidV4);
  expect(second.headers['x-request-id']).toMatch(uuidV4);
  expect(first.headers['x-request-id']).not.toBe(
    second.headers['x-request-id'],
  );
});

it('returns 503 when the backing services are disconnected', async () => {
  await request(app).get('/ready').expect(503, { status: 'not_ready' });
});

describe('readiness with local Docker services', () => {
  beforeAll(async () => {
    await connectMongo();
    await connectRedis();
  }, 15_000);

  afterAll(async () => {
    try {
      await closeRedis();
    } finally {
      await closeMongo();
    }
  });

  it('returns 200 when MongoDB and Redis respond', async () => {
    await request(app).get('/ready').expect(200, { status: 'ready' });
  });
});
