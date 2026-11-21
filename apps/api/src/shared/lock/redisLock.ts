import { randomUUID } from 'node:crypto';
import { redis } from '../../config/redis.js';
import { logger } from '../observability/logger.js';

const releaseIfOwned = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// null means contention; undefined means Redis is unavailable and MongoDB must arbitrate.
export async function acquireSlotLock(
  slotId: string,
  ttlMs = 5000,
): Promise<string | null | undefined> {
  const token = randomUUID();
  try {
    const result = await redis.set(
      `lock:slot:${slotId}`,
      token,
      'PX',
      ttlMs,
      'NX',
    );
    return result === 'OK' ? token : null;
  } catch {
    logger.warn('Redis slot lock unavailable; using MongoDB');
    return undefined;
  }
}

export async function releaseSlotLock(
  slotId: string,
  token: string,
): Promise<void> {
  try {
    await redis.eval(releaseIfOwned, 1, `lock:slot:${slotId}`, token);
  } catch {
    logger.warn('Redis slot lock release failed; the lock will expire');
  }
}
