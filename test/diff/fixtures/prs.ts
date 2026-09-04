/**
 * Realistic `ChangedFile[]` fixtures — one per PR shape the diff module must
 * recognise. Patches are written the way the Action collects them: a unified
 * diff per file, sometimes with `---`/`+++` headers (git) and sometimes starting
 * straight at the `@@` hunk (the GitHub REST `files[].patch` field), so the
 * scanners get exercised against both shapes.
 */
import type { ChangedFile } from '../../../src/core/types.js';

/** Small helper so fixture patches read as line lists rather than escaped blobs. */
const patch = (...lines: string[]): string => lines.join('\n');

/**
 * The headline case: a test is deleted outright and the CI workflow is narrowed
 * in the same PR. Both halves must surface.
 */
export const deletedTestAndWorkflowPr: ChangedFile[] = [
  {
    path: 'pkg/node/prune_test.go',
    status: 'D',
    patch: patch(
      '--- a/pkg/node/prune_test.go',
      '+++ /dev/null',
      '@@ -1,14 +0,0 @@',
      '-package node',
      '-',
      '-import "testing"',
      '-',
      '-func TestPrune(t *testing.T) {',
      '-\tn := New()',
      '-\tif err := n.Prune(); err != nil {',
      '-\t\tt.Fatalf("prune: %v", err)',
      '-\t}',
      '-}',
    ),
  },
  {
    path: '.github/workflows/ci.yml',
    status: 'M',
    patch: patch(
      '@@ -21,7 +21,7 @@ jobs:',
      '       - uses: actions/setup-go@v5',
      '       - name: Test',
      '-        run: go test ./...',
      '+        run: go test ./pkg/node',
      '       - name: Vet',
      '         run: go vet ./...',
    ),
  },
  {
    path: 'pkg/node/prune.go',
    status: 'M',
    patch: patch(
      '@@ -40,6 +40,3 @@ func (n *Node) Prune() error {',
      '-\tif n.stale() {',
      '-\t\treturn n.drop()',
      '-\t}',
      '\treturn nil',
    ),
  },
];

/** A `.only` slips into a spec, silencing every other test in the file. */
export const focusMarkerPr: ChangedFile[] = [
  {
    path: 'src/auth/login.spec.ts',
    status: 'M',
    patch: patch(
      '@@ -8,7 +8,7 @@ describe("login", () => {',
      "     expect(await login('ada', 'pw')).toBe(true);",
      '   });',
      '',
      "-  it('rejects a bad password', async () => {",
      "+  it.only('rejects a bad password', async () => {",
      "     expect(await login('ada', 'nope')).toBe(false);",
      '   });',
    ),
  },
  {
    path: 'src/auth/login.ts',
    status: 'M',
    patch: patch(
      '@@ -12,3 +12,3 @@ export async function login(user: string, pw: string) {',
      '-  return verify(user, pw);',
      '+  return verify(user, pw) && !locked(user);',
    ),
  },
];

/** A failing Python test is decorated away instead of fixed. */
export const pytestSkipPr: ChangedFile[] = [
  {
    path: 'tests/test_billing.py',
    status: 'M',
    patch: patch(
      '--- a/tests/test_billing.py',
      '+++ b/tests/test_billing.py',
      '@@ -30,6 +30,7 @@ def test_invoice_totals():',
      '     assert invoice.total == 120',
      '',
      '',
      '+@pytest.mark.skip(reason="flaky in CI")',
      ' def test_refund_reverses_charge():',
      '     assert refund(charge).amount == charge.amount',
    ),
  },
];

/** Dependency bump with nothing else in it — no tests touched, no source touched. */
export const lockfileOnlyPr: ChangedFile[] = [
  {
    path: 'package.json',
    status: 'M',
    patch: patch(
      '@@ -14,7 +14,7 @@',
      '   "dependencies": {',
      '-    "minimatch": "^10.0.2",',
      '+    "minimatch": "^10.0.3",',
      '     "fast-xml-parser": "^5.2.5"',
    ),
  },
  {
    path: 'package-lock.json',
    status: 'M',
    patch: patch(
      '@@ -1204,8 +1204,8 @@',
      '     "node_modules/minimatch": {',
      '-      "version": "10.0.2",',
      '-      "resolved": "https://registry.npmjs.org/minimatch/-/minimatch-10.0.2.tgz",',
      '+      "version": "10.0.3",',
      '+      "resolved": "https://registry.npmjs.org/minimatch/-/minimatch-10.0.3.tgz",',
    ),
  },
];

/** Recorded expectations rewritten to match new behaviour. */
export const snapshotUpdatePr: ChangedFile[] = [
  {
    path: 'src/render/__snapshots__/comment.test.ts.snap',
    status: 'M',
    patch: patch(
      '@@ -3,5 +3,5 @@',
      ' exports[`renders a verdict 1`] = `',
      '-<summary>FAIL — 1 discrepancy</summary>',
      '+<summary>PASS</summary>',
      ' `;',
    ),
  },
  {
    path: 'pkg/render/testdata/receipt.golden',
    status: 'M',
    patch: patch('@@ -1,2 +1,2 @@', '-verdict: FAIL', '+verdict: PASS'),
  },
  {
    path: 'src/render/comment.ts',
    status: 'M',
    patch: patch(
      '@@ -18,3 +18,3 @@ export function render(receipt: Receipt) {',
      '-  return summarize(receipt);',
      '+  return summarize(receipt, { terse: true });',
    ),
  },
];

/** A test file is moved, not removed — the gate must report from/to, not a deletion. */
export const renamedTestPr: ChangedFile[] = [
  {
    path: 'pkg/store/b_test.go',
    oldPath: 'pkg/store/a_test.go',
    status: 'R',
    patch: patch(
      '--- a/pkg/store/a_test.go',
      '+++ b/pkg/store/b_test.go',
      '@@ -1,4 +1,4 @@',
      ' package store',
      '',
      ' import "testing"',
    ),
  },
];

/** Nothing but prose. The benign baseline: every list should come back empty. */
export const docsOnlyPr: ChangedFile[] = [
  {
    path: 'docs/receipt-spec.md',
    status: 'M',
    patch: patch(
      '@@ -12,3 +12,4 @@ The format is open (MIT).',
      ' ## Design rules',
      '+- **Deterministic.** Every discrepancy names concrete evidence.',
    ),
  },
  {
    path: 'README.md',
    status: 'M',
    patch: patch('@@ -1,3 +1,3 @@', '-# merge-evidence-gate', '+# Merge-Evidence Gate'),
  },
];

/** The failing step is kept, but its failure no longer fails the job. */
export const continueOnErrorPr: ChangedFile[] = [
  {
    path: '.github/workflows/ci.yml',
    status: 'M',
    patch: patch(
      '@@ -24,6 +24,7 @@ jobs:',
      '       - name: Test',
      '+        continue-on-error: true',
      '         run: npm test',
      '       - name: Lint',
      '         run: npm run lint',
    ),
  },
];

/**
 * The gate itself is lowered. Note that `coverageThreshold` sits on a CONTEXT
 * line here, which is the normal shape of this edit.
 */
export const coverageThresholdLoweredPr: ChangedFile[] = [
  {
    path: 'jest.config.js',
    status: 'M',
    patch: patch(
      '@@ -6,9 +6,9 @@ module.exports = {',
      '   coverageThreshold: {',
      '     global: {',
      '-      branches: 85,',
      '-      lines: 90,',
      '+      branches: 20,',
      '+      lines: 25,',
      '     },',
      '   },',
    ),
  },
];
