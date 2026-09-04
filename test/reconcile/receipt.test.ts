import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildReceipt, DEFAULT_POLICY, reconcile } from '../../src/core/reconcile/index.js';
import type { BuildReceiptInput } from '../../src/core/reconcile/receipt.js';
import {
  agent,
  commandClaim,
  countClaim,
  diff,
  noTestCommandRun,
  observed,
  pr,
  test as executed,
} from './fixtures.js';

const NOW = new Date('2026-09-04T18:22:31.512Z');

function inputFor(overrides: Partial<BuildReceiptInput> = {}): BuildReceiptInput {
  const facts = overrides.pr ?? pr({ body: 'Fixes prune. Ran the suite.' });
  const run = overrides.observed ?? observed();
  const analysis = overrides.diff ?? diff();
  const claims = overrides.claims ?? [
    commandClaim('c1', 'go test ./...', { paths: ['./...'] }),
    countClaim('c2', '68 tests, 0 failures', { total: 68, failed: 0 }),
  ];
  const reconciled = reconcile({ pr: facts, claims, observed: run, diff: analysis });

  return {
    pr: facts,
    agent: agent(),
    claims,
    observed: run,
    diff: analysis,
    discrepancies: reconciled.discrepancies,
    verdict: reconciled.verdict,
    policy: DEFAULT_POLICY,
    now: NOW,
    ...overrides,
  };
}

describe('buildReceipt — shape', () => {
  const receipt = buildReceipt(inputFor());

  it('stamps the schema, the clock, and the policy version', () => {
    expect(receipt.schema).toBe('merge-evidence/receipt/v1');
    expect(receipt.generatedAt).toBe('2026-09-04T18:22:31Z');
    expect(receipt.policy_version).toBe('1.0.0');
  });

  it('binds the receipt to the exact commit that was executed', () => {
    expect(receipt.pr).toEqual({
      repo: 'owner/name',
      number: 341,
      head_sha: '3f2a1c9d4e5f60718293a4b5c6d7e8f901234567',
      base_sha: '9b0e7d2c1a3b4c5d6e7f8091a2b3c4d5e6f70819',
      author: 'copilot-swe-agent[bot]',
    });
  });

  it('projects the observed run, rounding the duration to whole seconds', () => {
    expect(receipt.observed.command).toBe('go test -json -count=1 ./...');
    expect(receipt.observed.exit_code).toBe(0);
    expect(receipt.observed.duration_s).toBe(118);
    expect(receipt.observed.totals).toEqual({ run: 3, passed: 3, failed: 0, skipped: 0, retried: 0 });
    expect(receipt.observed.no_test_command).toBeUndefined();
  });

  it('carries the in-toto predicate type for later attestation', () => {
    expect(receipt.signature).toEqual({
      predicate_type: 'https://merge-evidence.dev/receipt/v1',
    });
  });

  it('sets no_test_command only when the gate abstained', () => {
    const abstained = buildReceipt(inputFor({ observed: noTestCommandRun(), claims: [] }));
    expect(abstained.observed.no_test_command).toBe(true);
  });
});

describe('buildReceipt — hashes', () => {
  const body = 'Fixes prune. Ran the suite.';
  const receipt = buildReceipt(inputFor({ pr: pr({ body }) }));

  it('hashes the PR body once and stamps it on every claim', () => {
    const expected = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
    expect(receipt.claims).toHaveLength(2);
    for (const claim of receipt.claims) {
      expect(claim.body_hash).toBe(expected);
      expect(claim.body_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('digests the sorted executed test ids joined by newlines', () => {
    const ids = ['pkg/node/TestGraft', 'pkg/node/TestPrune', 'pkg/tree/TestWalk'];
    const expected = `sha256:${createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex')}`;
    expect(receipt.observed.tests_digest).toBe(expected);
    expect(receipt.observed.tests_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('digests the same set the same way regardless of execution order', () => {
    const shuffled = buildReceipt(
      inputFor({
        observed: observed({
          tests: [
            executed('pkg/tree/TestWalk'),
            executed('pkg/node/TestPrune'),
            executed('pkg/node/TestGraft'),
          ],
        }),
      }),
    );
    expect(shuffled.observed.tests_digest).toBe(receipt.observed.tests_digest);
  });

  it('detects a PR body edit — a different body is a different hash', () => {
    const other = buildReceipt(inputFor({ pr: pr({ body: `${body} (edited)` }) }));
    expect(other.claims[0]?.body_hash).not.toBe(receipt.claims[0]?.body_hash);
  });
});

describe('buildReceipt — diff projection', () => {
  const receipt = buildReceipt(
    inputFor({
      observed: observed({
        enumeratedAtBase: ['pkg/node/TestPrune', 'pkg/tree/TestWalk'],
        enumeratedAtHead: ['pkg/tree/TestWalk'],
      }),
      diff: diff({
        testFiles: {
          added: ['pkg/tree/walk_test.go'],
          modified: [],
          deleted: ['pkg/node/prune_test.go'],
          renamed: [],
        },
        skipMarkersAdded: [{ file: 'tests/test_login.py', marker: '@pytest.mark.skip' }],
        focusMarkersAdded: [{ file: 'src/a.test.ts', marker: 'it.only' }],
        verificationLayerEdits: [
          { file: 'codecov.yml', reason: 'coverage threshold lowered' },
          { file: '.github/workflows/ci.yml', reason: 'CI workflow edited' },
        ],
        dependencyFiles: ['go.sum', 'go.mod'],
        snapshotFiles: ['__snapshots__/b.snap', '__snapshots__/a.snap'],
        sourceFiles: ['pkg/node/prune.go'],
      }),
    }),
  );

  it('merges deleted test files with tests that vanished between base and head', () => {
    expect(receipt.diff.tests.deleted).toEqual(['pkg/node/TestPrune', 'pkg/node/prune_test.go']);
  });

  it('records the markers, sensitive paths, lockfiles and snapshots, sorted', () => {
    expect(receipt.diff.tests.added).toEqual(['pkg/tree/walk_test.go']);
    expect(receipt.diff.tests.skipped_added).toEqual(['tests/test_login.py: @pytest.mark.skip']);
    expect(receipt.diff.tests.focused).toEqual(['src/a.test.ts: it.only']);
    expect(receipt.diff.sensitive_paths).toEqual(['.github/workflows/ci.yml', 'codecov.yml']);
    expect(receipt.diff.lockfiles).toEqual(['go.mod', 'go.sum']);
    expect(receipt.diff.snapshots).toEqual(['__snapshots__/a.snap', '__snapshots__/b.snap']);
  });
});

describe('buildReceipt — determinism', () => {
  it('produces byte-identical JSON for the same input and clock', () => {
    const input = inputFor();
    expect(JSON.stringify(buildReceipt(input))).toBe(JSON.stringify(buildReceipt(input)));
  });

  it('is order-independent in the toolchain map', () => {
    const a = buildReceipt(inputFor({ observed: observed({ toolchain: { go: '1.25.1', node: '24.4.0' } }) }));
    const b = buildReceipt(inputFor({ observed: observed({ toolchain: { node: '24.4.0', go: '1.25.1' } }) }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('round-trips through JSON unchanged', () => {
    const receipt = buildReceipt(inputFor());
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
  });

  it('does not alias the inputs it was handed', () => {
    const input = inputFor();
    const receipt = buildReceipt(input);
    receipt.diff.lockfiles.push('mutated');
    receipt.observed.totals.run = 999;
    expect(input.diff.dependencyFiles).toEqual([]);
    expect(input.observed.totals.run).toBe(3);
  });
});
