import { describe, expect, it } from 'vitest';

import {
  buildReceipt,
  COMMENT_MARKER,
  DEFAULT_POLICY,
  formatDuration,
  MAX_COMMENT_BYTES,
  MAX_TITLE_CHARS,
  reconcile,
  renderComment,
} from '../../src/core/reconcile/index.js';
import type { Claim, DiffAnalysis, ObservedRun, PullRequestFacts, Receipt } from '../../src/core/types.js';
import {
  agent,
  checkboxClaim,
  commandClaim,
  countClaim,
  diff,
  noTestCommandRun,
  observed,
  pr,
  test as executed,
} from './fixtures.js';

const NOW = new Date('2026-09-04T18:22:31Z');

/** Reconcile then build a receipt, the way the Action does. */
function receiptFor(parts: {
  pr: PullRequestFacts;
  claims: Claim[];
  observed: ObservedRun;
  diff: DiffAnalysis;
}): { receipt: Receipt; unverifiable: string[] } {
  const reconciled = reconcile(parts);
  return {
    receipt: buildReceipt({
      pr: parts.pr,
      agent: agent(),
      claims: parts.claims,
      observed: parts.observed,
      diff: parts.diff,
      discrepancies: reconciled.discrepancies,
      verdict: reconciled.verdict,
      policy: DEFAULT_POLICY,
      now: NOW,
    }),
    unverifiable: reconciled.unverifiable,
  };
}

/** The scenario README.md's "What the receipt looks like" block describes. */
function readmeScenario() {
  const facts = pr({ body: 'Fixes the prune path in the node package.' });
  const claims = [
    commandClaim('c1', 'go test ./...', { paths: ['./...'] }),
    countClaim('c2', '480 tests, 0 failures', { total: 480, failed: 0 }),
    checkboxClaim('c3', 'tests pass locally'),
  ];
  const run = observed({
    tests: Array.from({ length: 412 }, (_, i) => executed(`pkg/node/Test${i}`)),
    durationMs: 118_400,
  });
  const analysis = diff({
    testFiles: { added: [], modified: [], deleted: ['pkg/node/prune_test.go'], renamed: [] },
    verificationLayerEdits: [{ file: '.github/workflows/ci.yml', reason: 'CI workflow edited' }],
    sourceFiles: ['pkg/node/prune.go', 'cmd/root.go'],
  });
  return { facts, claims, run, analysis };
}

describe('renderComment — the README layout', () => {
  const { facts, claims, run, analysis } = readmeScenario();
  const { receipt, unverifiable } = receiptFor({ pr: facts, claims, observed: run, diff: analysis });
  // "tests pass locally" is a checkbox: nothing to map it to, so it is unverifiable.
  const comment = renderComment(receipt, { unverifiable: [...unverifiable, 'c3'] });

  it('renders the whole block exactly', () => {
    expect(comment.markdown).toBe(
      [
        '<!-- merge-evidence-gate -->',
        '**Merge-Evidence Gate — FAIL**  (head 3f2a1c9)',
        '',
        '**Claims vs observed**',
        '- `go test ./...` — ran ✔  412/412 pass',
        '- "480 tests, 0 failures" — (claimed 480 → observed 412) ✘ count',
        '- "tests pass locally" — unverifiable',
        '',
        '**Verification layer**',
        '- ✘ 1 test file deleted in this PR — pkg/node/prune_test.go',
        '- ✘ .github/workflows/ci.yml edited — CI workflow edited',
        '- ✔ no skip/only markers added',
        '- ✔ lockfile install OK',
        '',
        '**Scope**',
        '- · 2 changed files not mentioned in the PR body — cmd/root.go, pkg/node/prune.go',
        '',
        'Details: receipt.json (artifact) · rerun: `go test -json -count=1 ./...` · 1m58s',
      ].join('\n'),
    );
  });

  it('carries the sticky marker and a short title', () => {
    expect(comment.marker).toBe(COMMENT_MARKER);
    expect(comment.markdown.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment.title).toBe('Merge-Evidence Gate — FAIL  (head 3f2a1c9)');
    expect(comment.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  it('uses an explicit rerun command when one is given', () => {
    const withRerun = renderComment(receipt, { rerunCommand: 'make test' });
    expect(withRerun.markdown).toContain('rerun: `make test`');
  });
});

describe('renderComment — a clean PR', () => {
  const facts = pr({ body: 'Adds walk coverage in walk_test.go.' });
  const claims = [
    commandClaim('c1', 'go test ./...', { paths: ['./...'] }),
    countClaim('c2', '3 tests', { total: 3 }),
  ];
  const { receipt, unverifiable } = receiptFor({
    pr: facts,
    claims,
    observed: observed(),
    diff: diff(),
  });
  const comment = renderComment(receipt, { unverifiable });

  it('says PASS and shows the ✔ lines', () => {
    expect(comment.title).toContain('PASS');
    expect(comment.markdown).toContain('- `go test ./...` — ran ✔  3/3 pass');
    expect(comment.markdown).toContain('- "3 tests" — counts match ✔');
    expect(comment.markdown).toContain('- ✔ no skip/only markers added');
    expect(comment.markdown).toContain('- ✔ lockfile install OK');
  });

  it('omits the scope section when nothing is out of scope', () => {
    expect(comment.markdown).not.toContain('**Scope**');
  });
});

describe('renderComment — needs-human notes', () => {
  it('replaces the lockfile ✔ with the C5 note and lists the snapshots', () => {
    const { receipt } = receiptFor({
      pr: pr(),
      claims: [],
      observed: observed(),
      diff: diff({ dependencyFiles: ['go.sum'], snapshotFiles: ['__snapshots__/a.snap'] }),
    });
    const markdown = renderComment(receipt).markdown;

    expect(markdown).toContain('- ⚠ 1 dependency file changed, none mentioned in the PR body — go.sum');
    expect(markdown).toContain('- ⚠ 1 snapshot/golden file updated — __snapshots__/a.snap');
    expect(markdown).not.toContain('lockfile install OK');
  });

  it('drops the marker ✔ line when a skip marker was added', () => {
    const { receipt } = receiptFor({
      pr: pr(),
      claims: [],
      observed: observed(),
      diff: diff({ skipMarkersAdded: [{ file: 'tests/test_login.py', marker: '@pytest.mark.skip' }] }),
    });
    const markdown = renderComment(receipt).markdown;

    expect(markdown).toContain('- ✘ 1 skip marker added in this PR — tests/test_login.py: @pytest.mark.skip');
    expect(markdown).not.toContain('no skip/only markers added');
  });
});

describe('renderComment — a failing command claim', () => {
  it('marks the claim ran ✘ with the exit code', () => {
    const claims = [commandClaim('c1', 'go test ./...', { paths: ['./...'] })];
    const { receipt } = receiptFor({
      pr: pr(),
      claims,
      observed: observed({
        exitCode: 1,
        tests: [executed('pkg/node/TestPrune', 'failed'), executed('pkg/tree/TestWalk')],
      }),
      diff: diff(),
    });
    expect(renderComment(receipt).markdown).toContain('- `go test ./...` — ran ✘  exit 1, 1 failed');
  });
});

describe('renderComment — the gate abstains', () => {
  it('says so when there is no test command and nothing to show', () => {
    const { receipt } = receiptFor({
      pr: pr(),
      claims: [],
      observed: noTestCommandRun(),
      diff: diff(),
    });
    const comment = renderComment(receipt);

    expect(comment.title).toContain('NEUTRAL');
    expect(comment.markdown).toContain('- no test command found — the gate abstains');
  });
});

describe('renderComment — the 8 KB cap', () => {
  const huge = (() => {
    const files = Array.from({ length: 400 }, (_, i) => `pkg/very/long/path/segment/file${i}.go`);
    const claims = Array.from({ length: 200 }, (_, i) =>
      commandClaim(`c${i}`, `go test ./pkg/very/long/path/segment/pkg${i}/...`, {
        paths: [`./pkg/very/long/path/segment/pkg${i}/...`],
      }),
    );
    const { receipt, unverifiable } = receiptFor({
      pr: pr({ body: 'x' }),
      claims,
      observed: observed({ exitCode: 1, tests: files.map((f) => executed(f, 'failed')) }),
      diff: diff({
        testFiles: { added: [], modified: [], deleted: files, renamed: [] },
        verificationLayerEdits: files.map((file) => ({ file, reason: 'CI workflow edited' })),
        dependencyFiles: files,
        snapshotFiles: files,
        sourceFiles: files,
      }),
    });
    return renderComment(receipt, { unverifiable });
  })();

  it('stays within the hard cap', () => {
    expect(Buffer.byteLength(huge.markdown, 'utf8')).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
  });

  it('keeps the marker, the title line, the footer, and says what it dropped', () => {
    expect(huge.markdown.startsWith(COMMENT_MARKER)).toBe(true);
    expect(huge.markdown).toContain('**Merge-Evidence Gate — FAIL**');
    expect(huge.markdown).toContain('Details: receipt.json (artifact) · rerun:');
    expect(huge.markdown).toMatch(/- … and \d+ more\n/);
    expect(huge.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  it('is deterministic', () => {
    expect(huge.markdown).toBe(huge.markdown);
  });
});

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(58)).toBe('58s');
  });

  it('renders minutes and seconds above a minute', () => {
    expect(formatDuration(60)).toBe('1m0s');
    expect(formatDuration(118)).toBe('1m58s');
    expect(formatDuration(3661)).toBe('61m1s');
  });

  it('never renders a negative or non-finite duration', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});
