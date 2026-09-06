import { describe, expect, it } from 'vitest';
import {
  generateSigningKeyPair,
  keyIdOf,
  parsePrivateKey,
  sha256Hex,
  SIGNATURE_SCHEMA,
  signReceipt,
  verifyReceiptSignature,
  withSignatureMethod,
} from '../../src/core/signing.js';
import type { Receipt } from '../../src/core/types.js';

const RECEIPT = Buffer.from('{"schema":"merge-evidence/receipt/v1","verdict":"PASS"}\n', 'utf8');
const pair = generateSigningKeyPair();
const other = generateSigningKeyPair();

describe('signReceipt / verifyReceiptSignature', () => {
  const doc = signReceipt(RECEIPT, pair.privateKeyPem, { now: new Date('2026-09-05T20:00:00Z') });

  it('writes a v1 signature document over the exact bytes', () => {
    expect(doc.schema).toBe(SIGNATURE_SCHEMA);
    expect(doc.algorithm).toBe('ed25519');
    expect(doc.subject).toEqual({ name: 'receipt.json', sha256: sha256Hex(RECEIPT) });
    expect(Buffer.from(doc.signature, 'base64')).toHaveLength(64);
    expect(doc.key_id).toBe(pair.keyId);
    expect(doc.public_key).toBe(pair.publicKeyPem);
    expect(doc.signed_at).toBe('2026-09-05T20:00:00.000Z');
  });

  it('verifies with the trusted public key', () => {
    const outcome = verifyReceiptSignature(RECEIPT, doc, pair.publicKeyPem);
    expect(outcome).toEqual({ ok: true, keyId: pair.keyId, sha256: sha256Hex(RECEIPT), subject: 'receipt.json' });
  });

  it('is deterministic: the same bytes and key sign identically', () => {
    expect(signReceipt(RECEIPT, pair.privateKeyPem).signature).toBe(doc.signature);
  });

  it('refuses a receipt whose bytes changed by one character', () => {
    const tampered = Buffer.from(RECEIPT.toString('utf8').replace('PASS', 'FAIL'), 'utf8');
    const outcome = verifyReceiptSignature(tampered, doc, pair.publicKeyPem);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/sha256/);
  });

  it('refuses a signature under a key the verifier does not hold', () => {
    const outcome = verifyReceiptSignature(RECEIPT, doc, other.publicKeyPem);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/names key .* the key supplied is/);
  });

  it('refuses a forged signature even when the digest and key id line up', () => {
    const forged = { ...doc, signature: Buffer.alloc(64, 7).toString('base64') };
    const outcome = verifyReceiptSignature(RECEIPT, forged, pair.publicKeyPem);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/does not match/);
  });

  it('never trusts the public key embedded in the document', () => {
    // The document carries the other key; the verifier's own copy still decides.
    const swapped = { ...doc, public_key: other.publicKeyPem };
    expect(verifyReceiptSignature(RECEIPT, swapped, pair.publicKeyPem).ok).toBe(true);
  });

  it('names the problem for something that is not a signature document', () => {
    expect(verifyReceiptSignature(RECEIPT, { hello: 'world' }, pair.publicKeyPem)).toEqual({
      ok: false,
      reason: `not a ${SIGNATURE_SCHEMA} document`,
    });
    expect(verifyReceiptSignature(RECEIPT, null, pair.publicKeyPem).ok).toBe(false);
  });

  it('insists on Ed25519 keys on both sides', () => {
    expect(() => parsePrivateKey('-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n')).toThrow(/not a readable PEM/);
    const outcome = verifyReceiptSignature(RECEIPT, doc, 'not a key');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/not a readable PEM public key/);
  });
});

describe('keys', () => {
  it('generates distinct pairs whose id is the sha256 of the public half', () => {
    expect(pair.keyId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pair.keyId).not.toBe(other.keyId);
    expect(keyIdOf(parsePrivateKey(pair.privateKeyPem))).toBe(pair.keyId);
    expect(pair.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(pair.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });
});

describe('withSignatureMethod', () => {
  it('records the method inside the bytes that get signed, keeping the predicate type', () => {
    const receipt = { schema: 'merge-evidence/receipt/v1', signature: { predicate_type: 'https://merge-evidence.dev/receipt/v1' } } as unknown as Receipt;
    const signed = withSignatureMethod(receipt, 'key');
    expect(signed.receipt.signature).toEqual({ predicate_type: 'https://merge-evidence.dev/receipt/v1', method: 'key' });
    expect(signed.json.endsWith('\n')).toBe(true);
    expect(JSON.parse(signed.json)).toEqual(signed.receipt);
  });
});
