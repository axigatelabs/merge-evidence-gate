import { describe, expect, it } from 'vitest';

import { analyzeDiff } from '../../src/core/diff/index.js';
import {
  REASON_CI_WORKFLOW,
  REASON_COVERAGE_THRESHOLD,
  REASON_FAILURE_SUPPRESSED,
} from '../../src/core/diff/classify.js';
import type { ChangedFile } from '../../src/core/types.js';
import {
  continueOnErrorPr,
  coverageThresholdLoweredPr,
  deletedTestAndWorkflowPr,
  docsOnlyPr,
  focusMarkerPr,
  lockfileOnlyPr,
  pytestSkipPr,
  renamedTestPr,
  snapshotUpdatePr,
} from './fixtures/prs.js';

describe('analyzeDiff — deleted test plus a narrowed CI workflow', () => {
  const result = analyzeDiff(deletedTestAndWorkflowPr);

  it('records the deleted test', () => {
    expect(result.testFiles.deleted).toEqual(['pkg/node/prune_test.go']);
    expect(result.testFiles.added).toEqual([]);
    expect(result.testFiles.modified).toEqual([]);
    expect(result.testFiles.renamed).toEqual([]);
  });

  it('records the workflow edit', () => {
    expect(result.verificationLayerEdits).toEqual([
      { file: '.github/workflows/ci.yml', reason: REASON_CI_WORKFLOW },
    ]);
  });

  it('lists the workflow and the source file as changed source', () => {
    // A workflow is not a test, a manifest, or a snapshot, so it is source too;
    // the categories overlap by design and only `sourceFiles` is the residual.
    expect(result.sourceFiles).toEqual(['.github/workflows/ci.yml', 'pkg/node/prune.go']);
    expect(result.dependencyFiles).toEqual([]);
    expect(result.snapshotFiles).toEqual([]);
  });
});

describe('analyzeDiff — a focused spec', () => {
  const result = analyzeDiff(focusMarkerPr);

  it('reports the .only as a focus marker, not a skip', () => {
    expect(result.focusMarkersAdded).toEqual([
      { file: 'src/auth/login.spec.ts', marker: 'it.only(' },
    ]);
    expect(result.skipMarkersAdded).toEqual([]);
  });

  it('keeps the spec in testFiles and the implementation in sourceFiles', () => {
    expect(result.testFiles.modified).toEqual(['src/auth/login.spec.ts']);
    expect(result.sourceFiles).toEqual(['src/auth/login.ts']);
  });
});

describe('analyzeDiff — an added pytest skip', () => {
  const result = analyzeDiff(pytestSkipPr);

  it('reports the skip marker', () => {
    expect(result.skipMarkersAdded).toEqual([
      { file: 'tests/test_billing.py', marker: '@pytest.mark.skip' },
    ]);
    expect(result.focusMarkersAdded).toEqual([]);
  });

  it('touches nothing outside the test file', () => {
    expect(result.testFiles.modified).toEqual(['tests/test_billing.py']);
    expect(result.sourceFiles).toEqual([]);
    expect(result.verificationLayerEdits).toEqual([]);
  });
});

describe('analyzeDiff — a lockfile-only change', () => {
  const result = analyzeDiff(lockfileOnlyPr);

  it('lists both manifests and nothing else', () => {
    expect(result.dependencyFiles).toEqual(['package-lock.json', 'package.json']);
    expect(result.sourceFiles).toEqual([]);
    expect(result.snapshotFiles).toEqual([]);
    expect(result.verificationLayerEdits).toEqual([]);
    expect(result.testFiles).toEqual({ added: [], modified: [], deleted: [], renamed: [] });
  });
});

describe('analyzeDiff — a snapshot update', () => {
  const result = analyzeDiff(snapshotUpdatePr);

  it('lists the snapshot and the golden file', () => {
    expect(result.snapshotFiles).toEqual([
      'pkg/render/testdata/receipt.golden',
      'src/render/__snapshots__/comment.test.ts.snap',
    ]);
  });

  it('keeps the implementation change in sourceFiles', () => {
    // Recorded expectations are never source: only comment.ts is left over.
    expect(result.sourceFiles).toEqual(['src/render/comment.ts']);
  });
});

describe('analyzeDiff — a renamed test file', () => {
  const result = analyzeDiff(renamedTestPr);

  it('a rename within the test set is a modified test, not a delete plus an add and not a removal', () => {
    expect(result.testFiles.renamed).toEqual([]);
    expect(result.testFiles.modified).toEqual(['pkg/store/b_test.go']);
    expect(result.testFiles.deleted).toEqual([]);
    expect(result.testFiles.added).toEqual([]);
    expect(result.sourceFiles).toEqual([]);
  });

  it('a rename OUT of the test set is reported with both endpoints', () => {
    const away: ChangedFile[] = [{ path: 'pkg/store/b_helper.go', oldPath: 'pkg/store/a_test.go', status: 'R' }];
    expect(analyzeDiff(away).testFiles.renamed).toEqual([{ from: 'pkg/store/a_test.go', to: 'pkg/store/b_helper.go' }]);
  });

  it('falls back to "modified" when a rename arrives without an oldPath', () => {
    const malformed: ChangedFile[] = [{ path: 'pkg/store/b_test.go', status: 'R' }];
    const analysis = analyzeDiff(malformed);
    expect(analysis.testFiles.renamed).toEqual([]);
    expect(analysis.testFiles.modified).toEqual(['pkg/store/b_test.go']);
  });

  it('treats a rename INTO a test path as an added test', () => {
    const promoted: ChangedFile[] = [
      { path: 'pkg/store/store_test.go', oldPath: 'pkg/store/scratch.go', status: 'R' },
    ];
    const analysis = analyzeDiff(promoted);
    expect(analysis.testFiles.added).toEqual(['pkg/store/store_test.go']);
    expect(analysis.testFiles.renamed).toEqual([]);
  });
});

describe('analyzeDiff — a benign docs-only PR', () => {
  it('finds nothing to flag', () => {
    const result = analyzeDiff(docsOnlyPr);
    expect(result.skipMarkersAdded).toEqual([]);
    expect(result.focusMarkersAdded).toEqual([]);
    expect(result.verificationLayerEdits).toEqual([]);
    expect(result.dependencyFiles).toEqual([]);
    expect(result.snapshotFiles).toEqual([]);
    expect(result.testFiles).toEqual({ added: [], modified: [], deleted: [], renamed: [] });
  });

  it('counts the prose as source until a scope-allow rule excuses it', () => {
    expect(analyzeDiff(docsOnlyPr).sourceFiles).toEqual(['README.md', 'docs/receipt-spec.md']);
    expect(analyzeDiff(docsOnlyPr, { scopeAllow: ['docs/**', 'README.md'] }).sourceFiles).toEqual([]);
  });
});

describe('analyzeDiff — a suppressed CI failure', () => {
  it('reports the suppression, not just the workflow path', () => {
    expect(analyzeDiff(continueOnErrorPr).verificationLayerEdits).toEqual([
      { file: '.github/workflows/ci.yml', reason: REASON_FAILURE_SUPPRESSED },
    ]);
  });
});

describe('analyzeDiff — a lowered coverage threshold', () => {
  it('reports the jest.config.js gate change', () => {
    expect(analyzeDiff(coverageThresholdLoweredPr).verificationLayerEdits).toEqual([
      { file: 'jest.config.js', reason: REASON_COVERAGE_THRESHOLD },
    ]);
  });
});

describe('analyzeDiff — scope-allow', () => {
  const files: ChangedFile[] = [
    { path: 'docs/guide.md', status: 'M' },
    { path: 'CHANGELOG.md', status: 'M' },
    { path: 'src/api/handler.ts', status: 'M' },
    { path: '.github/dependabot.yml', status: 'M' },
  ];

  it('excludes matching paths from sourceFiles only', () => {
    const result = analyzeDiff(files, { scopeAllow: ['docs/**', 'CHANGELOG.md', '.github/*.yml'] });
    expect(result.sourceFiles).toEqual(['src/api/handler.ts']);
  });

  it('leaves sourceFiles untouched when no globs are given', () => {
    expect(analyzeDiff(files).sourceFiles).toEqual([
      '.github/dependabot.yml',
      'CHANGELOG.md',
      'docs/guide.md',
      'src/api/handler.ts',
    ]);
  });

  it('does not let scope-allow hide a verification-layer edit', () => {
    // A policy that waives `.github/**` from scope must not also waive the CI check.
    const result = analyzeDiff(deletedTestAndWorkflowPr, { scopeAllow: ['.github/**'] });
    expect(result.sourceFiles).toEqual(['pkg/node/prune.go']);
    expect(result.verificationLayerEdits).toEqual([
      { file: '.github/workflows/ci.yml', reason: REASON_CI_WORKFLOW },
    ]);
  });
});

describe('analyzeDiff — determinism', () => {
  const everything: ChangedFile[] = [
    ...deletedTestAndWorkflowPr,
    ...focusMarkerPr,
    ...pytestSkipPr,
    ...lockfileOnlyPr,
    ...snapshotUpdatePr,
    ...renamedTestPr,
  ];

  it('returns the same analysis regardless of input order', () => {
    const forwards = analyzeDiff(everything);
    const backwards = analyzeDiff([...everything].reverse());
    expect(backwards).toEqual(forwards);
  });

  it('sorts every output array', () => {
    const result = analyzeDiff([...everything].reverse());
    const isSorted = (values: string[]): boolean =>
      values.every((value, i) => i === 0 || (values[i - 1] as string) <= value);
    expect(isSorted(result.sourceFiles)).toBe(true);
    expect(isSorted(result.dependencyFiles)).toBe(true);
    expect(isSorted(result.snapshotFiles)).toBe(true);
    expect(isSorted(result.testFiles.deleted)).toBe(true);
    expect(isSorted(result.testFiles.modified)).toBe(true);
    expect(isSorted(result.verificationLayerEdits.map((e) => e.file))).toBe(true);
    expect(isSorted(result.skipMarkersAdded.map((m) => m.file))).toBe(true);
    expect(isSorted(result.focusMarkersAdded.map((m) => m.file))).toBe(true);
  });

  it('handles an empty diff', () => {
    expect(analyzeDiff([])).toEqual({
      testFiles: { added: [], modified: [], deleted: [], renamed: [] },
      skipMarkersAdded: [],
      focusMarkersAdded: [],
      verificationLayerEdits: [],
      dependencyFiles: [],
      snapshotFiles: [],
      sourceFiles: [],
    });
  });
});
