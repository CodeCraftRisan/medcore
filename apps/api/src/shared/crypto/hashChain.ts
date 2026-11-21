import { createHash } from 'node:crypto';

export const genesisHash = '0'.repeat(64);
export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

export function auditHash(entry: {
  seq: number;
  prevHash: string;
  type: string;
  payloadHash: string;
  ts: Date;
}): string {
  const { seq, prevHash, type, payloadHash, ts } = entry;
  return sha256(
    `${seq}|${prevHash}|${type}|${payloadHash}|${ts.toISOString()}`,
  );
}
