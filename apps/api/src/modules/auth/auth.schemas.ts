import { z } from 'zod';

export const roleSchema = z.enum(['patient', 'doctor', 'admin']);
export type Role = z.infer<typeof roleSchema>;

export const credentialsSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(128),
});

export const refreshTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
