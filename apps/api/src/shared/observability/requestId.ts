import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type {} from 'pino-http';

export const requestId: RequestHandler = (req, res, next) => {
  req.id = randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
};
