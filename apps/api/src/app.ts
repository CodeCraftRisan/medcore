import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { isMongoReady } from './config/db.js';
import { isRedisReady } from './config/redis.js';
import { authRouter } from './modules/auth/auth.router.js';
import { logger } from './shared/observability/logger.js';
import { requestId } from './shared/observability/requestId.js';

const handleError: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status =
    error instanceof Error && 'status' in error ? error.status : undefined;
  if (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  ) {
    res.status(status).json({ status: 'invalid_request' });
    return;
  }

  req.log.error(
    { errorType: error instanceof Error ? error.name : 'Unknown' },
    'Request failed',
  );
  res.status(500).json({ status: 'internal_error' });
};

export function createApp() {
  const app = express();

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      wrapSerializers: false,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/ready', async (_req, res) => {
    const results = await Promise.allSettled([isMongoReady(), isRedisReady()]);
    const ready = results.every(
      (result) => result.status === 'fulfilled' && result.value,
    );
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use('/api/auth', authRouter);
  app.use(handleError);

  return app;
}
