import {
  closeMongo,
  connectMongo,
  env,
  expireHolds,
  logger,
  outboxRelay,
  reconcilePayments,
} from '@medcore/api/worker';
import { Queue, Worker } from 'bullmq';

const queueName = 'medcore-background';
const jobs = {
  expireHolds: { run: () => expireHolds(), every: 5000 },
  outboxRelay: { run: outboxRelay, every: 5000 },
  reconcilePayments: { run: reconcilePayments, every: 15000 },
};
type JobName = keyof typeof jobs;

let queue: Queue | undefined;
let worker: Worker | undefined;
let stopping = false;

async function start(): Promise<void> {
  await connectMongo();
  if (stopping) return;
  const url = new URL(env.REDIS_URL);
  const connection = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    connectTimeout: 5000,
  };

  queue = new Queue(queueName, {
    connection: { ...connection, maxRetriesPerRequest: 1 },
  });
  queue.on('error', () => logger.warn('BullMQ queue error'));
  worker = new Worker(
    queueName,
    async (job) => {
      if (!Object.hasOwn(jobs, job.name)) throw new Error('Unknown worker job');
      await jobs[job.name as JobName].run();
    },
    {
      connection: { ...connection, maxRetriesPerRequest: null },
      concurrency: 3,
    },
  );
  worker.on('error', () => logger.warn('BullMQ worker error'));
  worker.on('failed', (job) =>
    logger.warn({ job: job?.name }, 'BullMQ job failed'),
  );

  for (const [name, job] of Object.entries(jobs)) {
    await queue.upsertJobScheduler(
      name,
      { every: job.every },
      {
        name,
        data: {},
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );
  }
  logger.info('Background worker started');
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await startup.catch(() => undefined);
  const results = await Promise.allSettled([worker?.close(), queue?.close()]);
  await closeMongo();
  if (results.some((result) => result.status === 'rejected'))
    process.exitCode = 1;
}

function stop(): void {
  void shutdown().catch(() => {
    process.exitCode = 1;
    logger.error('Worker shutdown failed');
  });
}

const startup = start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
void startup.catch(() => {
  process.exitCode = 1;
  logger.error('Worker startup failed');
  stop();
});
