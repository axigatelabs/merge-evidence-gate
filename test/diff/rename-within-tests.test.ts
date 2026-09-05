/**
 * A rename inside the test set is a refactor, not a removal. mastra #20938
 * renamed seven `stored-workflow*.test.ts` files to `dynamic-workflow*.test.ts`
 * and came back FAIL on C3 for "renaming away" tests it kept.
 */
import { describe, expect, it } from 'vitest';

import { analyzeDiff } from '../../src/core/diff/analyze.js';

describe('renames and the test set', () => {
  it('a test renamed to another test path is a modified test, not a removal', () => {
    const a = analyzeDiff([
      { path: 'src/resources/dynamic-workflow.test.ts', status: 'R', oldPath: 'src/resources/stored-workflow.test.ts' },
    ]);
    expect(a.testFiles.renamed).toEqual([]);
    expect(a.testFiles.modified).toEqual(['src/resources/dynamic-workflow.test.ts']);
  });

  it('a rename out of the test set is still reported', () => {
    const a = analyzeDiff([{ path: 'pkg/b_helper.go', status: 'R', oldPath: 'pkg/a_test.go' }]);
    expect(a.testFiles.renamed).toEqual([{ from: 'pkg/a_test.go', to: 'pkg/b_helper.go' }]);
  });

  it('a source file renamed into the test set is an added test', () => {
    const a = analyzeDiff([{ path: 'pkg/foo_test.go', status: 'R', oldPath: 'pkg/foo.go' }]);
    expect(a.testFiles.added).toEqual(['pkg/foo_test.go']);
    expect(a.testFiles.renamed).toEqual([]);
  });
});
