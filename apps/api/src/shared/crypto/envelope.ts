import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { decryptGcm, encryptGcm, type Sealed } from './aesGcm.js';

interface WrappedKey {
  wrappedDEK: Sealed;
  keyId: string;
}

function kek(keyId: string): Buffer {
  if (!Object.hasOwn(env.PRESCRIPTION_KEKS, keyId))
    throw new Error('Prescription key unavailable');
  return Buffer.from(env.PRESCRIPTION_KEKS[keyId], 'base64');
}

function wrap(dek: Buffer, aad: string): WrappedKey {
  const keyId = env.PRESCRIPTION_ACTIVE_KEK_ID;
  return {
    keyId,
    wrappedDEK: encryptGcm(dek, kek(keyId), 'dek:' + keyId + ':' + aad),
  };
}

function unwrap({ keyId, wrappedDEK }: WrappedKey, aad: string): Buffer {
  return decryptGcm(wrappedDEK, kek(keyId), 'dek:' + keyId + ':' + aad);
}

export function encryptPrescription(
  plaintext: Buffer,
  aad: string,
): Sealed & WrappedKey {
  const dek = randomBytes(32);
  try {
    return { ...encryptGcm(plaintext, dek, aad), ...wrap(dek, aad) };
  } finally {
    dek.fill(0);
  }
}

export function decryptPrescription(
  value: Sealed & WrappedKey,
  aad: string,
): Buffer {
  const dek = unwrap(value, aad);
  try {
    return decryptGcm(value, dek, aad);
  } finally {
    dek.fill(0);
  }
}

export function rotatePrescriptionKey(
  value: WrappedKey,
  aad: string,
): WrappedKey {
  const dek = unwrap(value, aad);
  try {
    return wrap(dek, aad);
  } finally {
    dek.fill(0);
  }
}
