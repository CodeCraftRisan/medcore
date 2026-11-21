import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { roleSchema, type Role } from './auth.schemas.js';

const accessClaimsSchema = z.object({
  sub: z.string().regex(/^[a-f0-9]{24}$/i),
  role: roleSchema,
  exp: z.number().int(),
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign({ role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: 15 * 60,
    jwtid: randomUUID(),
  });
}

export function verifyAccessToken(token: string): AccessClaims | undefined {
  try {
    const claims = accessClaimsSchema.safeParse(
      jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }),
    );
    return claims.success ? claims.data : undefined;
  } catch {
    return undefined;
  }
}
