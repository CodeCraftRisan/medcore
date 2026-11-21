import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import { signAccessToken } from './accessToken.js';
import type { Role } from './auth.schemas.js';
import { RefreshToken } from './refreshToken.model.js';
import { User } from './user.model.js';

const refreshLifetimeMs = 30 * 24 * 60 * 60 * 1000;

interface Credentials {
  email: string;
  password: string;
}

interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

type RotationResult =
  | { status: 'rotated'; session: AuthSession }
  | { status: 'invalid' }
  | { status: 'reused' };

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function issueSession(
  userId: Types.ObjectId,
  role: Role,
  familyId: string,
  expiresAt: Date,
  session?: ClientSession,
): Promise<AuthSession> {
  const refreshToken = randomBytes(32).toString('base64url');
  const accessToken = signAccessToken(userId.toHexString(), role);

  await new RefreshToken({
    userId,
    familyId,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  }).save({ session });

  return { accessToken, refreshToken, expiresAt };
}

export async function register({ email, password }: Credentials) {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  try {
    const user = await User.create({ email, passwordHash, role: 'patient' });
    return { id: user.id as string, email: user.email, role: user.role };
  } catch (error) {
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      error.code === 11000
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function login({
  email,
  password,
}: Credentials): Promise<AuthSession | undefined> {
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user || !(await argon2.verify(user.passwordHash, password)))
    return undefined;

  return issueSession(
    user._id,
    user.role,
    randomUUID(),
    new Date(Date.now() + refreshLifetimeMs),
  );
}

async function revokeFamily(
  familyId: string,
  session: ClientSession,
): Promise<void> {
  await RefreshToken.updateMany(
    { familyId },
    { $set: { revoked: true } },
    { session },
  );
}

export async function rotateRefreshToken(
  token: string,
): Promise<RotationResult> {
  return mongoose.connection.transaction(
    async (session): Promise<RotationResult> => {
      const current = await RefreshToken.findOne({
        tokenHash: hashRefreshToken(token),
      }).session(session);
      if (!current) return { status: 'invalid' };

      if (current.used) {
        await revokeFamily(current.familyId, session);
        return { status: 'reused' };
      }

      if (current.revoked || current.expiresAt.getTime() <= Date.now()) {
        return { status: 'invalid' };
      }

      const user = await User.findById(current.userId).session(session);
      if (!user) return { status: 'invalid' };

      // Updating this record conflicts with simultaneous rotation or family revocation.
      current.used = true;
      await current.save({ session });
      const next = await issueSession(
        user._id,
        user.role,
        current.familyId,
        current.expiresAt,
        session,
      );
      return { status: 'rotated', session: next };
    },
  );
}

export async function logout(token: string): Promise<void> {
  await mongoose.connection.transaction(async (session) => {
    const current = await RefreshToken.findOne({
      tokenHash: hashRefreshToken(token),
    }).session(session);
    if (current) await revokeFamily(current.familyId, session);
  });
}
