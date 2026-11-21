import { Redis } from 'ioredis';
import { logger } from '../shared/observability/logger.js';
import { env } from './env.js';

const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 5000,
  commandTimeout: 1000,
});

redis.on('error', (error: Error) => {
  logger.warn({ errorType: error.name }, 'Redis connection error');
});

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

export async function isRedisReady(): Promise<boolean> {
  return redis.status === 'ready' && (await redis.ping()) === 'PONG';
}

export async function closeRedis(): Promise<void> {
  try {
    if (redis.status === 'ready') await redis.quit();
  } finally {
    redis.disconnect();
  }
}
