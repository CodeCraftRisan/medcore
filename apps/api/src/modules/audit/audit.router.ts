import { Router } from 'express';
import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../../config/env.js';
import { requireAuth, requireRole } from '../../shared/middleware/auth.js';
import { latestAnchor, verifySignature, writeAnchor } from './anchor.js';
import { AuditLog } from './audit.model.js';
import { verifyAudit } from './audit.service.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('admin'));
const options = { readConcern: { level: 'snapshot' as const } };

auditRouter.get('/verify', async (_req, res) => {
  const result = await mongoose.connection.transaction(verifyAudit, options);
  res.json(
    result.valid ? { valid: true, totalEntries: result.totalEntries } : result,
  );
});

async function checkAnchor(session: ClientSession) {
  const result = await verifyAudit(session);
  if (!result.valid)
    return {
      valid: false as const,
      reason: result.reason,
      brokenAtSeq: result.brokenAtSeq,
    };
  let anchor;
  try {
    anchor = await latestAnchor();
    if (anchor && !verifySignature(anchor))
      return { valid: false as const, reason: 'INVALID_SIGNATURE' };
  } catch {
    return { valid: false as const, reason: 'INVALID_ANCHOR' };
  }

  if (anchor) {
    const entry = await AuditLog.findOne({ seq: anchor.seq })
      .session(session)
      .lean();
    if (
      !entry ||
      entry.hash !== anchor.hash ||
      entry.ts.toISOString() !== anchor.ts
    ) {
      return { valid: false as const, reason: 'ANCHOR_MISMATCH' };
    }
  }

  return { valid: true as const, tip: result.tip, anchor };
}

auditRouter.post('/anchor', async (_req, res) => {
  if (!env.AUDIT_ANCHOR_PRIVATE_KEY || !env.AUDIT_ANCHOR_PUBLIC_KEY) {
    res.status(503).json({ code: 'ANCHOR_KEYS_UNAVAILABLE' });
    return;
  }
  const result = await mongoose.connection.transaction(checkAnchor, options);
  if (!result.valid || !result.tip) {
    res.status(409).json(result.valid ? { code: 'AUDIT_CHAIN_EMPTY' } : result);
    return;
  }
  res.status(201).json(await writeAnchor(result.tip));
});

auditRouter.get('/anchor/verify', async (_req, res) => {
  const result = await mongoose.connection.transaction(checkAnchor, options);
  if (!result.valid) {
    res.json(result);
    return;
  }
  if (!result.anchor || result.tip?.seq !== result.anchor.seq) {
    res.json({
      valid: false,
      reason: result.anchor ? 'TIP_NOT_ANCHORED' : 'ANCHOR_NOT_FOUND',
    });
    return;
  }
  res.json({ valid: true, seq: result.anchor.seq });
});
