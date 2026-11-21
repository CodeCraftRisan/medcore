import mongoose, { type ClientSession } from 'mongoose';
import {
  auditHash,
  canonicalJson,
  genesisHash,
  sha256,
} from '../../shared/crypto/hashChain.js';
import { AuditHead, AuditLog } from './audit.model.js';

const chainId = 'main';

export async function initializeAudit(): Promise<void> {
  try {
    await AuditHead.updateOne(
      { _id: chainId },
      { $setOnInsert: { seq: 0, hash: genesisHash } },
      { upsert: true },
    );
  } catch (error) {
    if (!(
      error instanceof mongoose.mongo.MongoServerError && error.code === 11000
    ))
      throw error;
    if (!(await AuditHead.exists({ _id: chainId }))) throw error;
  }
}

export async function appendAuditLog(
  type: string,
  payload: unknown,
  session?: ClientSession,
): Promise<void> {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(type))
    throw new Error('Invalid audit event type');
  const payloadHash = sha256(canonicalJson(payload));

  async function append(transaction: ClientSession) {
    // The head write serializes all appends; transaction retries handle write conflicts.
    const head = await AuditHead.findOneAndUpdate(
      { _id: chainId },
      { $inc: { seq: 1 } },
      {
        session: transaction,
        returnDocument: 'after',
      },
    ).orFail();
    const entry = {
      seq: head.seq,
      prevHash: head.hash,
      type,
      payloadHash,
      ts: new Date(),
    };
    head.hash = auditHash(entry);
    await new AuditLog({ ...entry, hash: head.hash }).save({
      session: transaction,
    });
    await head.save({ session: transaction });
  }

  if (session) {
    await append(session);
    return;
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await mongoose.connection.transaction(append);
      return;
    } catch (error) {
      if (
        !(
          error instanceof mongoose.mongo.MongoServerError &&
          error.code === 11000 &&
          error.keyPattern?.seq === 1
        ) ||
        attempt >= 2
      )
        throw error;
    }
  }
}

export interface Checkpoint {
  seq: number;
  hash: string;
  ts: string;
}
type Verification =
  | { valid: true; totalEntries: number; tip: Checkpoint | null }
  | { valid: false; brokenAtSeq: number; reason: string };

export async function verifyAudit(
  session: ClientSession,
): Promise<Verification> {
  let expected = 1;
  let prevHash = genesisHash;
  let tip: Checkpoint | null = null;
  const head = await AuditHead.findById(chainId).session(session).lean();
  const cursor = AuditLog.find()
    .sort({ seq: 1 })
    .session(session)
    .lean()
    .cursor();
  for await (const entry of cursor) {
    if (entry.seq !== expected)
      return { valid: false, brokenAtSeq: expected, reason: 'SEQUENCE_GAP' };
    if (
      !(entry.ts instanceof Date) ||
      !Number.isFinite(entry.ts.getTime()) ||
      entry.prevHash !== prevHash ||
      !/^[0-9a-f]{64}$/.test(entry.payloadHash) ||
      auditHash(entry) !== entry.hash
    ) {
      return { valid: false, brokenAtSeq: expected, reason: 'HASH_MISMATCH' };
    }
    tip = { seq: entry.seq, hash: entry.hash, ts: entry.ts.toISOString() };
    prevHash = entry.hash;
    expected++;
  }
  if (!head || head.seq !== expected - 1 || head.hash !== prevHash) {
    return {
      valid: false,
      brokenAtSeq: Math.min(expected, head?.seq || expected),
      reason: 'HEAD_MISMATCH',
    };
  }
  return { valid: true, totalEntries: expected - 1, tip };
}
