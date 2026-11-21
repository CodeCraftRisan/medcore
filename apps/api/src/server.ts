import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { closeMongo, connectMongo } from './config/db.js';
import { env } from './config/env.js';
import { closeRedis, connectRedis } from './config/redis.js';
import { logger } from './shared/observability/logger.js';

const server = createServer(createApp());
let stopping = false;

async function start(): Promise<void> {
  await connectMongo();
  if (stopping) return;

  await connectRedis();
  if (stopping) return;

  const listening = once(server, 'listening');
  server.listen(env.PORT);
  await listening;
  logger.info({ port: env.PORT }, 'API listening');
}

async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'API shutting down');

  await startup.catch(() => undefined);

  if (server.listening) {
    const timeout = setTimeout(() => server.closeAllConnections(), 10_000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch {
      process.exitCode = 1;
      logger.error('HTTP shutdown failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  const results = await Promise.allSettled([closeMongo(), closeRedis()]);
  if (results.some((result) => result.status === 'rejected')) {
    process.exitCode = 1;
    logger.error('Database shutdown failed');
  }
}

const startup = start();

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void startup.catch((error: unknown) => {
  if (!stopping) {
    process.exitCode = 1;
    logger.error(
      { errorType: error instanceof Error ? error.name : 'Unknown' },
      'API startup failed',
    );
    void shutdown('startup failure');
  }
});
