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
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGO_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .safeParse(process.env);

if (!result.success) {
  const names = result.error.issues.map((issue) => issue.path.join('.'));
  throw new Error(`Invalid environment variables: ${names.join(', ')}`);
}

export const env = result.data;
