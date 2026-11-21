import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import {
  link,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { canonicalJson } from '../../shared/crypto/hashChain.js';
import type { Checkpoint } from './audit.service.js';

const schema = z.strictObject({
  seq: z.number().int().positive(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  ts: z.iso.datetime(),
  signature: z
    .base64()
    .refine((value) => Buffer.from(value, 'base64').length === 64),
});
type Anchor = z.infer<typeof schema>;

function bytes({ seq, hash, ts }: Checkpoint): Buffer {
  return Buffer.from(canonicalJson({ seq, hash, ts }));
}

export function verifySignature(anchor: Anchor): boolean {
  const key = env.AUDIT_ANCHOR_PUBLIC_KEY;
  if (!key) return false;
  const publicKey = createPublicKey({
    key: Buffer.from(key, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return (
    publicKey.asymmetricKeyType === 'ed25519' &&
    verify(
      null,
      bytes(anchor),
      publicKey,
      Buffer.from(anchor.signature, 'base64'),
    )
  );
}

export async function latestAnchor(): Promise<Anchor | null> {
  let files: string[];
  try {
    files = await readdir(env.AUDIT_ANCHOR_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const latest = files
    .filter((file) => /^\d{16}\.json$/.test(file))
    .sort()
    .at(-1);
  if (!latest) return null;
  const anchor = schema.parse(
    JSON.parse(await readFile(join(env.AUDIT_ANCHOR_DIR, latest), 'utf8')),
  );
  if (Number(latest.slice(0, 16)) !== anchor.seq)
    throw new Error('Anchor sequence differs from its filename');
  return anchor;
}

export async function writeAnchor(checkpoint: Checkpoint): Promise<Anchor> {
  const key = createPrivateKey({
    key: Buffer.from(env.AUDIT_ANCHOR_PRIVATE_KEY!, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('Expected Ed25519 signing key');
  const anchor = {
    ...checkpoint,
    signature: sign(null, bytes(checkpoint), key).toString('base64'),
  };
  if (!verifySignature(anchor))
    throw new Error('Audit anchor keys do not match');
  const directory = env.AUDIT_ANCHOR_DIR;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(
    directory,
    String(checkpoint.seq).padStart(16, '0') + '.json',
  );
  const temporary = join(directory, randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(anchor), {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  });
  try {
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = schema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (
      !verifySignature(existing) ||
      !bytes(existing).equals(bytes(checkpoint))
    )
      throw new Error('Conflicting anchor', { cause: error });
    return existing;
  } finally {
    await unlink(temporary);
  }
  return anchor;
}
