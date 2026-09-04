import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, reconcile } from '../../src/core/reconcile/index.js';
import type { Discrepancy, Policy } from '../../src/core/types.js';
import {
  checkboxClaim,
  commandClaim,
  countClaim,
  diff,
  noTestCommandRun,
  observed,
  pr,
  test as executed,
} from './fixtures.js';

const checks = (discrepancies: Discrepancy[]): string[] => discrepancies.map((d) => d.check);

const run = (input: Partial<Parameters<typeof reconcile>[0]> = {}) =>
  reconcile({
    pr: pr(),
    claims: [],
    observed: observed(),
    diff: diff(),
    ...input,
  });

// ---------------------------------------------------------------------------
// C1 — claimed command never ran / failed
// ---------------------------------------------------------------------------

describe('C1 — a claimed command that maps to the observed run', () => {
  it('does not fire when the mapped run passed', () => {
    const result = run({ claims: [commandClaim('c1', 'go test ./...', { paths: ['./...'] })] });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual([]);
    expect(result.verdict).toBe('PASS');
  });

  it('fails with the exit code and the failed test ids when the mapped run failed', () => {
    const result = run({
      claims: [commandClaim('c1', 'go test ./...', { paths: ['./...'] })],
      observed: observed({
        exitCode: 1,
        tests: [executed('pkg/node/TestPrune', 'failed'), executed('pkg/tree/TestWalk')],
      }),
    });

    expect(checks(result.discrepancies)).toEqual(['C1']);
    const [first] = result.discrepancies;
    expect(first?.severity).toBe('fail');
    expect(first?.claim).toBe('c1');
    expect(first?.evidence).toContain('observed exit_code=1');
    expect(first?.evidence).toContain('failed: pkg/node/TestPrune');
    expect(result.verdict).toBe('FAIL');
  });

  it('caps the failed-test evidence at ten ids plus a "and N more" line', () => {
    const tests = Array.from({ length: 15 }, (_, i) =>
      executed(`pkg/node/Test${String(i).padStart(2, '0')}`, 'failed'),
    );
    const result = run({
      claims: [commandClaim('c1', 'go test ./...', { paths: ['./...'] })],
      observed: observed({ exitCode: 1, tests }),
    });

    const evidence = result.discrepancies[0]?.evidence ?? [];
    expect(evidence.filter((line) => line.startsWith('failed: '))).toHaveLength(10);
    expect(evidence.at(-1)).toBe('… and 5 more');
  });

  it('maps a name-filtered claim when some executed id contains the filter', () => {
    const result = run({
      claims: [
        commandClaim('c1', 'go test -run TestPrune ./pkg/node', {
          paths: ['./pkg/node'],
          nameFilters: ['^TestPrune$'],
        }),
      ],
      observed: observed({ exitCode: 2, tests: [executed('pkg/node/TestPrune', 'failed')] }),
    });

    expect(checks(result.discrepancies)).toEqual(['C1']);
    expect(result.unverifiable).toEqual([]);
  });
});

describe('C1 — a claim the gate cannot map is unverifiable, never a failure', () => {
  it('reports a pytest claim as unverifiable when the observed run is go', () => {
    const result = run({
      claims: [commandClaim('c1', 'pytest -q', { runner: 'pytest' })],
      observed: observed({ exitCode: 1, tests: [executed('pkg/node/TestPrune', 'failed')] }),
    });

    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.verdict).toBe('PASS');
  });

  it('reports an unknown runner as unverifiable', () => {
    const result = run({ claims: [commandClaim('c1', './scripts/check.sh', { runner: 'unknown' })] });
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.discrepancies).toEqual([]);
  });

  it('reports a claim whose paths were never executed as unverifiable', () => {
    const result = run({
      claims: [commandClaim('c1', 'go test ./pkg/absent/...', { paths: ['./pkg/absent/...'] })],
      observed: observed({ exitCode: 1 }),
    });
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.discrepancies).toEqual([]);
  });

  it('reports a claim whose name filter matched nothing as unverifiable', () => {
    const result = run({
      claims: [commandClaim('c1', 'go test -run TestGone ./...', { nameFilters: ['TestGone'] })],
      observed: observed({ exitCode: 1 }),
    });
    expect(result.unverifiable).toEqual(['c1']);
  });

  it('reports every command claim as unverifiable when no test command was found', () => {
    const result = run({
      claims: [commandClaim('c1', 'go test ./...'), checkboxClaim('c2', 'tests pass')],
      observed: noTestCommandRun(),
    });
    expect(result.unverifiable).toEqual(['c1']);
    expect(result.discrepancies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C2 — claimed count ≠ observed
// ---------------------------------------------------------------------------

describe('C2 — count claims', () => {
  it('needs a human when the claimed total differs from what ran', () => {
    const result = run({ claims: [countClaim('c2', '68 tests, 0 failures', { total: 68, failed: 0 })] });

    expect(checks(result.discrepancies)).toEqual(['C2']);
    const [first] = result.discrepancies;
    expect(first?.severity).toBe('needs-human');
    expect(first?.claim).toBe('c2');
    expect(first?.summary).toBe('Claimed 68 total; 3 observed');
    expect(first?.evidence).toEqual(['claimed total=68', 'observed run=3']);
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });

  it('compares passed and failed as well as the total', () => {
    const result = run({
      claims: [countClaim('c2', '2 passed, 1 failed', { passed: 2, failed: 1 })],
      observed: observed({ tests: [executed('a'), executed('b'), executed('c')] }),
    });
    expect(result.discrepancies[0]?.evidence).toEqual([
      'claimed passed=2',
      'observed passed=3',
      'claimed failed=1',
      'observed failed=0',
    ]);
  });

  it('does not fire when the counts agree', () => {
    const result = run({
      claims: [countClaim('c2', '3 tests, 0 failures', { total: 3, failed: 0, passed: 3 })],
    });
    expect(result.discrepancies).toEqual([]);
    expect(result.verdict).toBe('PASS');
  });

  it('is skipped entirely when no test command was found', () => {
    const result = run({
      claims: [countClaim('c2', '68 tests', { total: 68 })],
      observed: noTestCommandRun(),
    });
    expect(result.discrepancies).toEqual([]);
    expect(result.verdict).toBe('NEUTRAL');
  });
});

// ---------------------------------------------------------------------------
// C3 — tests deleted / renamed / skipped / focused
// ---------------------------------------------------------------------------

describe('C3 — the test set shrank', () => {
  it('does not fire on a clean diff', () => {
    expect(run().discrepancies).toEqual([]);
  });

  it('fails on a deleted test file', () => {
    const result = run({
      diff: diff({
        testFiles: { added: [], modified: [], deleted: ['pkg/node/prune_test.go'], renamed: [] },
      }),
    });
    expect(checks(result.discrepancies)).toEqual(['C3']);
    expect(result.discrepancies[0]?.evidence).toEqual(['pkg/node/prune_test.go']);
    expect(result.verdict).toBe('FAIL');
  });

  it('fails on a renamed test file', () => {
    const result = run({
      diff: diff({
        testFiles: {
          added: [],
          modified: [],
          deleted: [],
          renamed: [{ from: 'a_test.go', to: 'b_helper.go' }],
        },
      }),
    });
    expect(checks(result.discrepancies)).toEqual(['C3']);
    expect(result.discrepancies[0]?.evidence).toEqual(['a_test.go → b_helper.go']);
  });

  it('fails on an added skip marker and on an added focus marker', () => {
    const result = run({
      diff: diff({
        skipMarkersAdded: [{ file: 'tests/test_login.py', marker: '@pytest.mark.skip' }],
        focusMarkersAdded: [{ file: 'src/a.test.ts', marker: 'it.only' }],
      }),
    });
    expect(checks(result.discrepancies)).toEqual(['C3', 'C3']);
    expect(result.discrepancies[0]?.evidence).toEqual(['tests/test_login.py: @pytest.mark.skip']);
    expect(result.discrepancies[1]?.evidence).toEqual(['src/a.test.ts: it.only']);
  });

  it('fails on a test enumerated at base but absent at head', () => {
    const result = run({
      observed: observed({
        enumeratedAtBase: ['pkg/node/TestPrune', 'pkg/tree/TestWalk'],
        enumeratedAtHead: ['pkg/tree/TestWalk'],
      }),
    });
    expect(checks(result.discrepancies)).toEqual(['C3']);
    expect(result.discrepancies[0]?.evidence).toEqual([
      'pkg/node/TestPrune enumerated at base, absent at head',
    ]);
  });

  it('does not fire when enumeration is only available on one side', () => {
    const result = run({ observed: observed({ enumeratedAtBase: ['pkg/node/TestPrune'] }) });
    expect(result.discrepancies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C4 — verification-layer edits
// ---------------------------------------------------------------------------

describe('C4 — verification-layer edits', () => {
  it('emits one fail per edit, sorted by file', () => {
    const result = run({
      diff: diff({
        verificationLayerEdits: [
          { file: 'codecov.yml', reason: 'coverage threshold lowered' },
          { file: '.github/workflows/ci.yml', reason: 'CI workflow edited' },
        ],
      }),
    });

    expect(checks(result.discrepancies)).toEqual(['C4', 'C4']);
    expect(result.discrepancies.map((d) => d.summary)).toEqual([
      '.github/workflows/ci.yml edited',
      'codecov.yml edited',
    ]);
    expect(result.discrepancies.map((d) => d.evidence)).toEqual([
      ['CI workflow edited'],
      ['coverage threshold lowered'],
    ]);
    expect(result.verdict).toBe('FAIL');
  });

  it('does not fire when nothing in the verification layer changed', () => {
    expect(run().discrepancies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C5 / C6 — dependencies and snapshots
// ---------------------------------------------------------------------------

describe('C5 — unmentioned dependency changes', () => {
  it('needs a human when no dependency file is named in the body', () => {
    const result = run({ diff: diff({ dependencyFiles: ['go.sum', 'go.mod'] }) });
    expect(checks(result.discrepancies)).toEqual(['C5']);
    expect(result.discrepancies[0]?.severity).toBe('needs-human');
    expect(result.discrepancies[0]?.evidence).toEqual(['go.mod', 'go.sum']);
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });

  it('does not fire when the body mentions one of them by basename', () => {
    const result = run({
      pr: pr({ body: 'Bumps the pinned deps in go.sum.' }),
      diff: diff({ dependencyFiles: ['go.sum'] }),
    });
    expect(result.discrepancies).toEqual([]);
  });

  it('does not fire when no dependency file changed', () => {
    expect(run().discrepancies).toEqual([]);
  });
});

describe('C6 — snapshot updates', () => {
  it('needs a human and lists the snapshots', () => {
    const result = run({ diff: diff({ snapshotFiles: ['__snapshots__/a.snap'] }) });
    expect(checks(result.discrepancies)).toEqual(['C6']);
    expect(result.discrepancies[0]?.evidence).toEqual(['__snapshots__/a.snap']);
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });

  it('does not fire when no snapshot changed', () => {
    expect(run().discrepancies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C8 — scope creep
// ---------------------------------------------------------------------------

describe('C8 — files the PR body never mentions', () => {
  it('lists unmentioned source files as info', () => {
    const result = run({ diff: diff({ sourceFiles: ['pkg/node/prune.go', 'cmd/root.go'] }) });
    expect(checks(result.discrepancies)).toEqual(['C8']);
    expect(result.discrepancies[0]?.severity).toBe('info');
    expect(result.discrepancies[0]?.evidence).toEqual(['cmd/root.go', 'pkg/node/prune.go']);
    expect(result.verdict).toBe('PASS');
  });

  it('does not fire when every changed file is mentioned', () => {
    const result = run({
      pr: pr({ body: 'Touches prune.go only.' }),
      diff: diff({ sourceFiles: ['pkg/node/prune.go'] }),
    });
    expect(result.discrepancies).toEqual([]);
  });

  it('honours scope-allow globs from the policy', () => {
    const policy: Policy = { ...DEFAULT_POLICY, scopeAllow: ['docs/**', 'CHANGELOG.md'] };
    const result = run({
      diff: diff({ sourceFiles: ['docs/guide.md', 'CHANGELOG.md'] }),
      policy,
    });
    expect(result.discrepancies).toEqual([]);
  });

  it('caps the list at twenty files plus a "and N more" line', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
    const result = run({ diff: diff({ sourceFiles: files }) });
    const evidence = result.discrepancies[0]?.evidence ?? [];
    expect(evidence).toHaveLength(21);
    expect(evidence.at(-1)).toBe('… and 5 more');
  });
});

// ---------------------------------------------------------------------------
// Verdict precedence and policy overrides
// ---------------------------------------------------------------------------

describe('verdict precedence', () => {
  it('prefers FAIL over needs-human and info', () => {
    const result = run({
      diff: diff({
        testFiles: { added: [], modified: [], deleted: ['a_test.go'], renamed: [] },
        snapshotFiles: ['a.snap'],
        sourceFiles: ['b.go'],
      }),
    });
    expect(new Set(checks(result.discrepancies))).toEqual(new Set(['C3', 'C6', 'C8']));
    expect(result.verdict).toBe('FAIL');
  });

  it('prefers NEEDS_HUMAN over info', () => {
    const result = run({ diff: diff({ snapshotFiles: ['a.snap'], sourceFiles: ['b.go'] }) });
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });

  it('is PASS when only info discrepancies exist', () => {
    expect(run({ diff: diff({ sourceFiles: ['b.go'] }) }).verdict).toBe('PASS');
  });

  it('is NEUTRAL when no test command was found and nothing else fired', () => {
    const result = run({
      observed: noTestCommandRun(),
      diff: diff({ sourceFiles: ['b.go'] }),
    });
    expect(checks(result.discrepancies)).toEqual(['C8']);
    expect(result.verdict).toBe('NEUTRAL');
  });

  it('is not NEUTRAL when the verification layer fired without a test command', () => {
    const result = run({
      observed: noTestCommandRun(),
      diff: diff({ verificationLayerEdits: [{ file: '.github/workflows/ci.yml', reason: 'CI workflow edited' }] }),
    });
    expect(result.verdict).toBe('FAIL');
  });

  it('is NEEDS_HUMAN when only C6 fired without a test command', () => {
    const result = run({ observed: noTestCommandRun(), diff: diff({ snapshotFiles: ['a.snap'] }) });
    expect(result.verdict).toBe('NEEDS_HUMAN');
  });
});

describe('policy overrides', () => {
  const deletedTest = diff({
    testFiles: { added: [], modified: [], deleted: ['pkg/node/prune_test.go'], renamed: [] },
  });

  it('downgrading C3 to info flips FAIL to PASS', () => {
    const policy: Policy = { version: '1.1.0', severity: { ...DEFAULT_POLICY.severity, C3: 'info' } };
    const strict = run({ diff: deletedTest });
    const relaxed = run({ diff: deletedTest, policy });

    expect(strict.verdict).toBe('FAIL');
    expect(relaxed.verdict).toBe('PASS');
    expect(relaxed.discrepancies[0]?.severity).toBe('info');
  });

  it('upgrading C8 to fail flips PASS to FAIL', () => {
    const policy: Policy = { version: '1.1.0', severity: { C8: 'fail' } };
    const result = run({ diff: diff({ sourceFiles: ['b.go'] }), policy });
    expect(result.verdict).toBe('FAIL');
  });

  it('uses DEFAULT_POLICY when the caller passes none', () => {
    expect(run({ diff: deletedTest }).discrepancies[0]?.severity).toBe('fail');
  });
});

describe('output ordering', () => {
  it('emits discrepancies in check order and is deterministic', () => {
    const input = {
      pr: pr(),
      claims: [
        commandClaim('c1', 'go test ./...', { paths: ['./...'] }),
        countClaim('c2', '68 tests', { total: 68 }),
      ],
      observed: observed({ exitCode: 1, tests: [executed('pkg/node/TestPrune', 'failed')] }),
      diff: diff({
        testFiles: { added: [], modified: [], deleted: ['a_test.go'], renamed: [] },
        verificationLayerEdits: [{ file: '.github/workflows/ci.yml', reason: 'CI workflow edited' }],
        dependencyFiles: ['go.sum'],
        snapshotFiles: ['a.snap'],
        sourceFiles: ['b.go'],
      }),
    };

    const first = reconcile(input);
    const second = reconcile(input);
    expect(checks(first.discrepancies)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C8']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
