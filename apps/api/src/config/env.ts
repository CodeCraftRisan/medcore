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
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGO_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((value, ctx) => {
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
