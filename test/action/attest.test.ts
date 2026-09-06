import { describe, expect, it } from 'vitest';
import type { AttestOptions } from '@actions/attest';
import { attestReceipt } from '../../src/action/attest.js';
import { PREDICATE_TYPE } from '../../src/core/reconcile/index.js';
import { sha256Hex } from '../../src/core/signing.js';
import type { Receipt } from '../../src/core/types.js';

const receipt = { schema: 'merge-evidence/receipt/v1', verdict: 'PASS' } as unknown as Receipt;
const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

describe('attestReceipt', () => {
  it('attests receipt.json by sha256 with the receipt as the predicate, on the instance the repository visibility calls for', async () => {
    const calls: AttestOptions[] = [];
    const result = await attestReceipt(
      { receiptBytes: bytes, receipt, token: 'tok', repoIsPrivate: true },
      async (options) => {
        calls.push(options);
        return { bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' }, certificate: 'PEM', attestationID: '4242', tlogID: undefined } as never;
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      subjects: [{ name: 'receipt.json', digest: { sha256: sha256Hex(bytes) } }],
      predicateType: PREDICATE_TYPE,
      predicate: receipt,
      token: 'tok',
      sigstore: 'github',
    });
    expect(result.attestationId).toBe('4242');
    expect(result.tlogId).toBeUndefined();
    expect(result.sha256).toBe(sha256Hex(bytes));
    expect(JSON.parse(result.bundleJson)).toEqual({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' });
  });

  it('uses the public-good instance for a public repository and carries the log id', async () => {
    const result = await attestReceipt(
      { receiptBytes: bytes, receipt, token: 'tok', repoIsPrivate: false },
      async (options) => {
        expect(options.sigstore).toBe('public-good');
        return { bundle: {}, certificate: 'PEM', tlogID: '99', attestationID: '1' } as never;
      },
    );
    expect(result.tlogId).toBe('99');
  });

  it('lets a signing failure propagate for the caller to turn into a warning', async () => {
    await expect(
      attestReceipt({ receiptBytes: bytes, receipt, token: '', repoIsPrivate: false }, async () => {
        throw new Error('Unable to get the OIDC token');
      }),
    ).rejects.toThrow(/OIDC/);
  });
});
