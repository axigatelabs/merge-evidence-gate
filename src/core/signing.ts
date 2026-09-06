/**
 * Signing a receipt with a key of your own — the portable path, for anyone who
 * cannot use GitHub's artifact attestations (the keyless path lives in
 * `src/action/attest.ts`).
 *
 * The signature is over the exact bytes of `receipt.json`; nothing is
 * canonicalised, so the file on disk is what a verifier checks. The signature
 * document sits beside the receipt and names the key that signed it by the
 * digest of its public half. A verifier supplies its own trusted copy of the
 * public key — the copy embedded in the document is a convenience for humans,
 * never the basis of trust.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Receipt } from './types.js';

export const SIGNATURE_SCHEMA = 'merge-evidence/signature/v1';

/** `receipt.sig.json` — a detached Ed25519 signature over the receipt's bytes. */
export interface SignatureDocument {
  schema: typeof SIGNATURE_SCHEMA;
  algorithm: 'ed25519';
  subject: { name: string; sha256: string };
  /** Base64 of the 64-byte Ed25519 signature over the subject's bytes. */
  signature: string;
  /** The signing key's public half, PEM (SPKI). Informational — verify with your own copy. */
  public_key: string;
  /** `sha256:` over the public key's DER encoding; how a verifier names the key it trusts. */
  key_id: string;
  signed_at: string;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `sha256:<hex>` over the SPKI DER of the key's public half. */
export function keyIdOf(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return `sha256:${sha256Hex(publicKey.export({ type: 'spki', format: 'der' }) as Buffer)}`;
}

function requireEd25519(key: KeyObject, what: string): void {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${what} must be an Ed25519 key (got ${key.asymmetricKeyType ?? 'an unknown type'})`);
  }
}

/** Parse a PEM (PKCS#8) private key, insisting on Ed25519. */
export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    throw new Error(`the signing key is not a readable PEM private key (${err instanceof Error ? err.message : String(err)})`);
  }
  requireEd25519(key, 'the signing key');
  return key;
}

/** Parse a PEM (SPKI) public key, insisting on Ed25519. */
export function parsePublicKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (err) {
    throw new Error(`the public key is not a readable PEM public key (${err instanceof Error ? err.message : String(err)})`);
  }
  requireEd25519(key, 'the public key');
  return key;
}

export function signReceipt(
  bytes: Buffer,
  privateKeyPem: string,
  options: { subjectName?: string; now?: Date } = {},
): SignatureDocument {
  const key = parsePrivateKey(privateKeyPem);
  const publicKey = createPublicKey(key);
  return {
    schema: SIGNATURE_SCHEMA,
    algorithm: 'ed25519',
    subject: { name: options.subjectName ?? 'receipt.json', sha256: sha256Hex(bytes) },
    signature: sign(null, bytes, key).toString('base64'),
    public_key: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    key_id: keyIdOf(publicKey),
    signed_at: (options.now ?? new Date()).toISOString(),
  };
}

export type VerifyOutcome =
  | { ok: true; keyId: string; sha256: string; subject: string }
  | { ok: false; reason: string };

function isSignatureDocument(value: unknown): value is SignatureDocument {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Record<string, unknown>;
  const subject = doc['subject'] as Record<string, unknown> | undefined;
  return (
    doc['schema'] === SIGNATURE_SCHEMA &&
    doc['algorithm'] === 'ed25519' &&
    typeof subject === 'object' &&
    subject !== null &&
    typeof subject['name'] === 'string' &&
    typeof subject['sha256'] === 'string' &&
    typeof doc['signature'] === 'string' &&
    typeof doc['key_id'] === 'string'
  );
}

/**
 * Check a signature document against the receipt's bytes and the public key the
 * verifier trusts. Every failure names its reason; none of them throws.
 */
export function verifyReceiptSignature(bytes: Buffer, document: unknown, publicKeyPem: string): VerifyOutcome {
  if (!isSignatureDocument(document)) {
    return { ok: false, reason: `not a ${SIGNATURE_SCHEMA} document` };
  }
  let key: KeyObject;
  try {
    key = parsePublicKey(publicKeyPem);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const keyId = keyIdOf(key);
  if (document.key_id !== keyId) {
    return { ok: false, reason: `the signature names key ${document.key_id}; the key supplied is ${keyId}` };
  }
  const digest = sha256Hex(bytes);
  if (document.subject.sha256 !== digest) {
    return { ok: false, reason: `the receipt's sha256 is ${digest}; the signature covers ${document.subject.sha256}` };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(document.signature, 'base64');
  } catch {
    return { ok: false, reason: 'the signature is not base64' };
  }
  let valid = false;
  try {
    valid = verify(null, bytes, key, signature);
  } catch (err) {
    return { ok: false, reason: `the signature could not be checked (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!valid) return { ok: false, reason: 'the signature does not match the receipt bytes under this key' };
  return { ok: true, keyId, sha256: digest, subject: document.subject.name };
}

/** A fresh Ed25519 key pair, PEM-encoded, for `sign: key`. */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    keyId: keyIdOf(publicKey),
  };
}

export type SignatureMethod = 'attest' | 'key';

/**
 * The receipt with `signature.method` recorded, serialised the way the gate
 * writes it. Set before signing: the method is known up front and must be part
 * of the signed bytes, whereas the attestation id or the signature itself
 * cannot be — they are computed over these very bytes.
 */
export function withSignatureMethod(receipt: Receipt, method: SignatureMethod): { receipt: Receipt; json: string } {
  const signed: Receipt = { ...receipt, signature: { ...receipt.signature, predicate_type: receipt.signature?.predicate_type ?? '', method } };
  return { receipt: signed, json: `${JSON.stringify(signed, null, 2)}\n` };
}
