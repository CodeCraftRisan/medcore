import { Schema, model } from 'mongoose';

export const AuditLog = model(
  'AuditLog',
  new Schema(
    {
      seq: { type: Number, required: true, unique: true },
      prevHash: { type: String, required: true },
      hash: { type: String, required: true },
      type: { type: String, required: true },
      payloadHash: { type: String, required: true },
      ts: { type: Date, required: true },
    },
    { collection: 'audit_logs', versionKey: false },
  ),
);

export const AuditHead = model(
  'AuditHead',
  new Schema(
    {
      _id: { type: String, required: true },
      seq: { type: Number, required: true },
      hash: { type: String, required: true },
    },
    { collection: 'audit_head', versionKey: false },
  ),
);
