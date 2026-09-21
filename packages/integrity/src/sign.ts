import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalize } from '@obscura/shared';

/**
 * Ed25519 over the RFC 8785 canonical form of the document.
 *
 * Signing raw JSON bytes is how signature verification usually breaks in the field:
 * re-serialising with different key ordering or whitespace invalidates a valid document.
 * Canonicalising first makes verification independent of serialisation.
 */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be exactly 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyFromSeed(seed: Buffer): KeyObject {
  return createPublicKey(privateKeyFromSeed(seed));
}

export function rawPublicKey(pub: KeyObject): Buffer {
  const der = pub.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(SPKI_PREFIX.length));
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('Ed25519 public key must be exactly 32 bytes');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export interface Signature {
  algorithm: 'Ed25519';
  keyId: string;
  canonicalization: 'RFC8785';
  value: string;
}

/** Sign a document. The `signature` field is excluded from the signed payload. */
export function signDocument<T extends { signature?: Signature }>(
  doc: T, privateKey: KeyObject, keyId: string,
): T & { signature: Signature } {
  const { signature: _drop, ...payload } = doc;
  const bytes = Buffer.from(canonicalize(payload), 'utf8');
  return {
    ...doc,
    signature: {
      algorithm: 'Ed25519',
      keyId,
      canonicalization: 'RFC8785',
      value: edSign(null, bytes, privateKey).toString('base64'),
    },
  };
}

export function verifyDocument<T extends { signature?: Signature }>(
  doc: T, publicKey: KeyObject,
): boolean {
  if (!doc.signature) return false;
  const { signature, ...payload } = doc;
  if (signature.algorithm !== 'Ed25519' || signature.canonicalization !== 'RFC8785') return false;
  try {
    return edVerify(
      null,
      Buffer.from(canonicalize(payload), 'utf8'),
      publicKey,
      Buffer.from(signature.value, 'base64'),
    );
  } catch { return false; }
}

/** JWKS-shaped public key document, served at /.well-known/obscura-integrity-keys.json
 *  so third parties can verify our claims without our cooperation. */
export function publicKeyJwks(keys: { keyId: string; publicKey: KeyObject }[]) {
  return {
    keys: keys.map((k) => ({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
      kid: k.keyId,
      x: rawPublicKey(k.publicKey).toString('base64url'),
    })),
  };
}
