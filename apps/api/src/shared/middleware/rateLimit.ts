import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import { sha256 } from '../crypto/hashChain.js';
import { logger } from '../observability/logger.js';

const slidingWindow = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local window = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return math.max(1, tonumber(oldest[2]) + window - now)
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return 0
`;

export function rateLimit(scope: 'api' | 'login'): RequestHandler {
  return async (req, res, next) => {
    if (redis.status !== 'ready') {
      next();
      return;
    }

    const key =
      env.RATE_LIMIT_KEY_PREFIX +
      ':' +
      scope +
      ':' +
      sha256(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const limit = scope === 'login' ? env.LOGIN_RATE_LIMIT : env.API_RATE_LIMIT;
    let retryMs: number;
    try {
      retryMs = Number(
        await redis.eval(
          slidingWindow,
          1,
          key,
          env.RATE_LIMIT_WINDOW_MS,
          limit,
          randomUUID(),
        ),
      );
    } catch {
      logger.warn({ scope }, 'Rate limiter unavailable');
      next();
      return;
    }

    if (retryMs > 0) {
      res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
      res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED' });
      return;
    }
    next();
  };
}
