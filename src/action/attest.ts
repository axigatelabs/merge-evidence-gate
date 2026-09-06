/**
 * Keyless signing through GitHub's artifact attestations: the receipt becomes
 * the predicate of an in-toto statement whose subject is `receipt.json` by its
 * sha256, signed with a Sigstore certificate issued to this workflow's OIDC
 * identity, and stored in the repository's attestation store. Verifiers use
 * `gh attestation verify receipt.json -R owner/name --predicate-type <type>`.
 *
 * Needs `id-token: write` and `attestations: write` on the job. A fork pull
 * request has no OIDC token, so this cannot sign there; the caller turns that
 * into a warning, never a failure — the verifier is the enforcement point.
 */
import type { Attestation, AttestOptions } from '@actions/attest';
import { PREDICATE_TYPE } from '../core/reconcile/index.js';
import { sha256Hex } from '../core/signing.js';
import type { Receipt } from '../core/types.js';

export interface AttestReceiptOptions {
  receiptBytes: Buffer;
  receipt: Receipt;
  /** A token allowed to write attestations — the workflow token with `attestations: write`. */
  token: string;
  /** Private repositories use GitHub's Sigstore instance; public ones the public-good instance. */
  repoIsPrivate: boolean;
  subjectName?: string;
}

export interface AttestReceiptResult {
  /** The Sigstore bundle as JSON — what `gh attestation verify --bundle` reads offline. */
  bundleJson: string;
  /** Id of the stored attestation, when the store accepted it. */
  attestationId?: string;
  /** Transparency-log entry id, when one was made (public-good instance). */
  tlogId?: string;
  sha256: string;
}

export type AttestFn = (options: AttestOptions) => Promise<Attestation>;

/**
 * `@actions/attest` ships as ES modules only; this package compiles to
 * CommonJS, so the library is loaded with a dynamic import, which the bundler
 * resolves under the `import` condition. The eager hint makes it inline the
 * library into the single committed bundle instead of a separate chunk file
 * that the Action runtime would not have (0.1.0 crashed on exactly that).
 */
async function defaultAttest(options: AttestOptions): Promise<Attestation> {
  const lib = await import(/* webpackMode: "eager" */ '@actions/attest');
  return lib.attest(options);
}

export async function attestReceipt(options: AttestReceiptOptions, attestFn: AttestFn = defaultAttest): Promise<AttestReceiptResult> {
  const sha256 = sha256Hex(options.receiptBytes);
  const attestation = await attestFn({
    subjects: [{ name: options.subjectName ?? 'receipt.json', digest: { sha256 } }],
    predicateType: PREDICATE_TYPE,
    predicate: options.receipt,
    token: options.token,
    sigstore: options.repoIsPrivate ? 'github' : 'public-good',
  });
  return {
    bundleJson: `${JSON.stringify(attestation.bundle)}\n`,
    ...(attestation.attestationID === undefined ? {} : { attestationId: attestation.attestationID }),
    ...(attestation.tlogID === undefined ? {} : { tlogId: attestation.tlogID }),
    sha256,
  };
}
