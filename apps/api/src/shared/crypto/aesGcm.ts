import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptGcm(
  plaintext: Buffer,
  key: Buffer,
  aad: string,
): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptGcm(sealed: Sealed, key: Buffer, aad: string): Buffer {
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error('Invalid encryption parameters');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]);
}
