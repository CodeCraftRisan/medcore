import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeMongo, connectMongo } from '../config/db.js';
import { env } from '../config/env.js';
import { RefreshToken } from '../modules/auth/refreshToken.model.js';
import { User } from '../modules/auth/user.model.js';
import { requireAuth, requireRole } from '../shared/middleware/auth.js';

const app = createApp();
app.get('/test/admin', requireAuth, requireRole('admin'), (_req, res) =>
  res.sendStatus(200),
);
app.get('/test/doctor', requireAuth, requireRole('doctor'), (_req, res) =>
  res.sendStatus(200),
);
app.get('/test/patient', requireAuth, requireRole('patient'), (_req, res) =>
  res.sendStatus(200),
);

const runId = randomUUID();
const password = 'test-password-1234';
const auth = '/api/auth';

function credentials(label: string) {
  return { email: `${runId}-${label}@example.test`, password };
}

function refreshCookie(response: Response): string {
  const setCookie = response.get('Set-Cookie')?.[0];
  expect(setCookie).toMatch(/^refresh_token=[A-Za-z0-9_-]{43};/);
  expect(setCookie).toMatch(/; HttpOnly/i);
  expect(setCookie).toMatch(/; SameSite=Strict/i);
  expect(setCookie).toContain('Path=/api/auth');
  return setCookie!.split(';')[0];
}

function tokenHash(cookie: string): string {
  return createHash('sha256')
    .update(cookie.slice('refresh_token='.length))
    .digest('hex');
}

async function loginAs(label: string) {
  const input = credentials(label);
  await request(app).post(`${auth}/register`).send(input).expect(201);
  return request(app).post(`${auth}/login`).send(input).expect(200);
}

beforeAll(async () => {
  await connectMongo();
}, 15_000);

afterAll(async () => {
  try {
    if (User.db.readyState === 1) {
      const filter = { email: new RegExp(`^${runId}-`) };
      const users = await User.find(filter).select('_id');
      await RefreshToken.deleteMany({
        userId: { $in: users.map((user) => user._id) },
      });
      await User.deleteMany(filter);
    }
  } finally {
    await closeMongo();
  }
});

it('normalizes registration, stores an Argon2id hash and issues a 15-minute access token', async () => {
  const input = credentials('register');
  const registered = await request(app)
    .post(`${auth}/register`)
    .send({ ...input, email: ` ${input.email.toUpperCase()} ` })
    .expect(201);

  const user = await User.findOne({ email: input.email })
    .select('+passwordHash')
    .orFail();
  expect(registered.body.user).toEqual({
    id: user._id.toHexString(),
    email: input.email,
    role: 'patient',
  });
  expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  expect(await argon2.verify(user.passwordHash, input.password)).toBe(true);
  await request(app).post(`${auth}/register`).send(input).expect(409);
  await request(app)
    .post(`${auth}/login`)
    .send({ ...input, password: 'wrong-password' })
    .expect(401);

  const loggedIn = await request(app)
    .post(`${auth}/login`)
    .send(input)
    .expect(200);
  const cookie = refreshCookie(loggedIn);
  const claims = jwt.verify(loggedIn.body.accessToken, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
  });
  expect(claims).toMatchObject({
    sub: user._id.toHexString(),
    role: 'patient',
  });
  if (typeof claims === 'string') throw new Error('Expected JWT claims');
  expect(claims.exp! - claims.iat!).toBe(900);
  expect(loggedIn.body).not.toHaveProperty('refreshToken');
  expect(
    await RefreshToken.findOne({
      tokenHash: tokenHash(cookie),
      userId: user._id,
    }),
  ).not.toBeNull();
});

it('rejects invalid credentials and role assignment at public registration', async () => {
  await request(app)
    .post(`${auth}/register`)
    .send({ ...credentials('role-injection'), role: 'admin' })
    .expect(400, { code: 'INVALID_INPUT' });
  await request(app)
    .post(`${auth}/register`)
    .send({ email: 'invalid', password: 'x' })
    .expect(400);
});

it('rotates the cookie and marks the old token used in the same family', async () => {
  const loggedIn = await loginAs('rotate');
  const oldCookie = refreshCookie(loggedIn);
  const rotated = await request(app)
    .post(`${auth}/refresh`)
    .set('Cookie', oldCookie)
    .expect(200);
  const newCookie = refreshCookie(rotated);
  expect(newCookie).not.toBe(oldCookie);
  expect(rotated.body.accessToken).toEqual(expect.any(String));
  expect(rotated.body.accessToken).not.toBe(loggedIn.body.accessToken);

  const old = await RefreshToken.findOne({
    tokenHash: tokenHash(oldCookie),
  }).orFail();
  const current = await RefreshToken.findOne({
    tokenHash: tokenHash(newCookie),
  }).orFail();
  expect(old.used).toBe(true);
  expect(current.used).toBe(false);
  expect(current.familyId).toBe(old.familyId);
  expect(current.expiresAt).toEqual(old.expiresAt);
});

it('detects replay, clears the cookie and revokes even the newly issued legitimate token', async () => {
  const oldCookie = refreshCookie(await loginAs('replay'));
  const newCookie = refreshCookie(
    await request(app)
      .post(`${auth}/refresh`)
      .set('Cookie', oldCookie)
      .expect(200),
  );

  const replay = await request(app)
    .post(`${auth}/refresh`)
    .send({ refreshToken: oldCookie.slice('refresh_token='.length) })
    .expect(401, { code: 'TOKEN_REUSE_DETECTED' });
  expect(replay.get('Set-Cookie')?.[0]).toMatch(/^refresh_token=;/);
  await request(app)
    .post(`${auth}/refresh`)
    .set('Cookie', newCookie)
    .expect(401, {
      code: 'INVALID_REFRESH_TOKEN',
    });

  const old = await RefreshToken.findOne({
    tokenHash: tokenHash(oldCookie),
  }).orFail();
  const family = await RefreshToken.find({ familyId: old.familyId });
  expect(family).toHaveLength(2);
  expect(family.every((token) => token.revoked)).toBe(true);
});

it('handles concurrent uses as one rotation and one replay', async () => {
  const cookie = refreshCookie(await loginAs('concurrent'));
  const results = await Promise.all([
    request(app).post(`${auth}/refresh`).set('Cookie', cookie),
    request(app).post(`${auth}/refresh`).set('Cookie', cookie),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  const issued = results.find((result) => result.status === 200)!;
  expect(results.find((result) => result.status === 401)?.body.code).toBe(
    'TOKEN_REUSE_DETECTED',
  );
  await request(app)
    .post(`${auth}/refresh`)
    .set('Cookie', refreshCookie(issued))
    .expect(401);
});

it('logs out the supplied family while leaving an independent login usable', async () => {
  const first = refreshCookie(await loginAs('logout'));
  const second = refreshCookie(
    await request(app)
      .post(`${auth}/login`)
      .send(credentials('logout'))
      .expect(200),
  );
  const response = await request(app)
    .post(`${auth}/logout`)
    .set('Cookie', first)
    .expect(204);
  expect(response.get('Set-Cookie')?.[0]).toMatch(/^refresh_token=;/);
  await request(app).post(`${auth}/refresh`).set('Cookie', first).expect(401);
  await request(app).post(`${auth}/refresh`).set('Cookie', second).expect(200);
});

it('rejects an expired unused refresh token', async () => {
  const cookie = refreshCookie(await loginAs('expired'));
  await RefreshToken.updateOne(
    { tokenHash: tokenHash(cookie) },
    { expiresAt: new Date(0) },
  );
  await request(app).post(`${auth}/refresh`).set('Cookie', cookie).expect(401, {
    code: 'INVALID_REFRESH_TOKEN',
  });
});

it('rejects missing or invalid JWTs and forbids patient access to admin and doctor routes', async () => {
  const { body } = await loginAs('rbac');
  await request(app).get('/test/admin').expect(401);
  await request(app)
    .get('/test/admin')
    .set('Authorization', 'Bearer invalid')
    .expect(401);

  const header = `Bearer ${body.accessToken}`;
  await request(app)
    .get('/test/admin')
    .set('Authorization', header)
    .expect(403);
  await request(app)
    .get('/test/doctor')
    .set('Authorization', header)
    .expect(403);
  await request(app)
    .get('/test/patient')
    .set('Authorization', header)
    .expect(200);
});
