import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { mongo, type ClientSession, type Types } from 'mongoose';
import { z } from 'zod';
import type {} from './auth.js';
import { IdempotencyKey } from './idempotencyKey.model.js';

interface IdempotencyClaim {
  id: Types.ObjectId;
  key: string;
  committed: boolean;
}

declare module 'express-serve-static-core' {
  interface Locals {
    idempotency?: IdempotencyClaim;
  }
}

const keySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return (
      '{' +
      fields
        .map(([key, field]) => JSON.stringify(key) + ':' + canonicalJson(field))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

export async function completeIdempotency(
  claim: IdempotencyClaim,
  statusCode: number,
  responseBody: unknown,
  session?: ClientSession,
): Promise<void> {
  const result = await IdempotencyKey.updateOne(
    { _id: claim.id, status: 'in_progress' },
    { $set: { status: 'completed', statusCode, responseBody } },
    { session },
  );
  if (!result.matchedCount)
    throw new Error('Idempotency claim expired before completion');
}

export const requireIdempotency: RequestHandler = async (req, res, next) => {
  if (!req.auth) {
    res.status(401).json({ code: 'UNAUTHORIZED' });
    return;
  }

  const parsed = keySchema.safeParse(req.get('Idempotency-Key'));
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_IDEMPOTENCY_KEY' });
    return;
  }

  const key = parsed.data;
  const userId = req.auth.sub;
  const requestHash = createHash('sha256')
    .update(
      canonicalJson([req.method, req.baseUrl + req.path, req.body ?? null]),
    )
    .digest('hex');

  let claim: IdempotencyClaim;
  try {
    const record = await IdempotencyKey.create({
      key,
      userId,
      requestHash,
      status: 'in_progress',
    });
    claim = { id: record._id, key, committed: false };
  } catch (error) {
    if (!(error instanceof mongo.MongoServerError) || error.code !== 11000)
      throw error;
    const existing = await IdempotencyKey.findOne({ key, userId }).lean();
    if (existing && existing.requestHash !== requestHash) {
      res.status(422).json({ code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' });
    } else if (
      existing?.status === 'completed' &&
      typeof existing.statusCode === 'number'
    ) {
      res.status(existing.statusCode).json(existing.responseBody);
    } else {
      res.status(409).json({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
    }
    return;
  }

  res.locals.idempotency = claim;
  const sendJson = res.json;
  res.json = (body) => {
    res.json = sendJson;
    if (claim.committed) return sendJson.call(res, body);

    const statusCode = res.statusCode;
    const persist =
      statusCode >= 200 && statusCode < 300
        ? completeIdempotency(claim, statusCode, body)
        : IdempotencyKey.deleteOne({
            _id: claim.id,
            status: 'in_progress',
          }).exec();
    void persist
      .then(() => {
        if (!res.destroyed) sendJson.call(res, body);
      })
      .catch(next);
    return res;
  };

  next();
};
