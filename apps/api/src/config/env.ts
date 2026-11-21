import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

const loaded = config({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
  quiet: true,
});

if (
  loaded.error &&
  (!('code' in loaded.error) || loaded.error.code !== 'ENOENT')
) {
  throw loaded.error;
}

const optionalKey = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.base64().optional(),
);
const keyId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const keyRing = z
  .string()
  .transform((value, ctx): unknown => {
    try {
      return JSON.parse(value || '{}');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Expected a JSON key ring' });
      return z.NEVER;
    }
  })
  .pipe(
    z.record(
      keyId,
      z.base64().refine((value) => Buffer.from(value, 'base64').length === 32),
    ),
  );

const result = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    JWT_ACCESS_SECRET: z.string().min(32),
    STRIPE_SECRET_KEY: z
      .string()
      .trim()
      .transform((value) => value || undefined)
      .optional(),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .trim()
      .transform((value) => value || undefined)
      .optional(),
    STRIPE_CURRENCY: z
      .string()
      .regex(/^[a-z]{3}$/)
      .default('usd'),
    PRESCRIPTION_KEKS: keyRing.prefault('{}'),
    PRESCRIPTION_ACTIVE_KEK_ID: keyId.default('kek-v1'),
    AUDIT_ANCHOR_PRIVATE_KEY: optionalKey,
    AUDIT_ANCHOR_PUBLIC_KEY: optionalKey,
    AUDIT_ANCHOR_DIR: z
      .string()
      .min(1)
      .default(
        fileURLToPath(new URL('../../../../.audit-anchors', import.meta.url)),
      ),
    RATE_LIMIT_KEY_PREFIX: z
      .string()
      .regex(/^[a-zA-Z0-9:_-]{1,100}$/)
      .default('medcore:rate'),
    API_RATE_LIMIT: z.coerce.number().int().positive().default(1000),
    LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGO_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((value, ctx) => {
    if (
      Object.keys(value.PRESCRIPTION_KEKS).length &&
      !Object.hasOwn(value.PRESCRIPTION_KEKS, value.PRESCRIPTION_ACTIVE_KEK_ID)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PRESCRIPTION_ACTIVE_KEK_ID'],
        message: 'Active KEK must exist in key ring',
      });
    }
    if (value.NODE_ENV === 'production' && !value.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'Required in production',
      });
    }
    if (
      value.NODE_ENV !== 'test' &&
      value.STRIPE_SECRET_KEY &&
      !value.STRIPE_WEBHOOK_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'Required with Stripe',
      });
    }
  })
  .safeParse(process.env);

if (!result.success) {
  const names = result.error.issues.map((issue) => issue.path.join('.'));
  throw new Error(`Invalid environment variables: ${names.join(', ')}`);
}

export const env = result.data;
