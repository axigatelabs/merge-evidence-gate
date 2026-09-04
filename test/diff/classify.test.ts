import { describe, expect, it } from 'vitest';

import {
  addedLines,
  changedLines,
  isDependencyFile,
  isSnapshotFile,
  isTestFile,
  REASON_AGENT_RULES,
  REASON_CI_WORKFLOW,
  REASON_COVERAGE_THRESHOLD,
  REASON_FAILURE_SUPPRESSED,
  REASON_TEST_INFRA,
  verificationLayerReason,
} from '../../src/core/diff/classify.js';

describe('isTestFile', () => {
  it.each([
    'pkg/node/prune_test.go',
    'tests/test_billing.py',
    'billing_test.py',
    'tests/conftest.py',
    'conftest.py',
    'src/auth/login.test.ts',
    'src/auth/login.spec.tsx',
    'src/__tests__/helpers.ts',
    'tests/integration/smoke.rb',
    'test/helpers.js',
    'pkg/render/testdata/receipt.golden',
    'crates/store/tests/roundtrip.rs',
  ])('recognises %s', (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    'pkg/node/prune.go',
    'src/auth/login.ts',
    'src/latest/index.ts', // "latest" is not the "test" segment
    'src/contest/rules.ts', // substring of a test word, not a test path
    'docs/testing.md',
    'README.md',
  ])('rejects %s', (path) => {
    expect(isTestFile(path)).toBe(false);
  });

  it('normalises Windows separators and a leading ./', () => {
    expect(isTestFile('.\\pkg\\node\\prune_test.go')).toBe(true);
    expect(isTestFile('./tests/conftest.py')).toBe(true);
  });
});

describe('isSnapshotFile', () => {
  it.each([
    'src/render/__snapshots__/comment.test.ts.snap',
    'src/render/comment.snap',
    'pkg/render/testdata/receipt.golden',
    'pkg/render/testdata/nested/input.json',
    'test/fixtures/user.json', // fixtures under a test dir
    'tests/e2e/fixtures/session.json',
  ])('recognises %s', (path) => {
    expect(isSnapshotFile(path)).toBe(true);
  });

  it.each([
    'src/fixtures/feature-flags.json', // product data, not recorded expectations
    'fixtures/seed.sql',
    'src/auth/login.ts',
  ])('rejects %s', (path) => {
    expect(isSnapshotFile(path)).toBe(false);
  });
});

describe('isDependencyFile', () => {
  it.each([
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'bun.lock',
    'go.mod',
    'go.sum',
    'requirements.txt',
    'requirements-dev.txt',
    'pyproject.toml',
    'poetry.lock',
    'uv.lock',
    'Pipfile',
    'Pipfile.lock',
    'Cargo.toml',
    'Cargo.lock',
    'Gemfile',
    'Gemfile.lock',
    'src/Api/Api.csproj',
    'packages.lock.json',
    'services/worker/go.mod', // nested workspaces count too
  ])('recognises %s', (path) => {
    expect(isDependencyFile(path)).toBe(true);
  });

  it.each(['src/package.ts', 'requirements.md', 'docs/Cargo.md', 'go.work'])(
    'rejects %s',
    (path) => {
      expect(isDependencyFile(path)).toBe(false);
    },
  );
});

describe('verificationLayerReason', () => {
  it('flags any CI workflow edit', () => {
    const reason = verificationLayerReason(
      '.github/workflows/ci.yml',
      ['@@ -21,7 +21,7 @@ jobs:', '-        run: go test ./...', '+        run: go test ./pkg'].join(
        '\n',
      ),
    );
    expect(reason).toBe(REASON_CI_WORKFLOW);
  });

  it('reports the suppression rather than the path when a workflow adds continue-on-error', () => {
    const reason = verificationLayerReason(
      '.github/workflows/ci.yml',
      ['@@ -24,6 +24,7 @@', '+        continue-on-error: true', '         run: npm test'].join('\n'),
    );
    expect(reason).toBe(REASON_FAILURE_SUPPRESSED);
  });

  it.each([
    ['|| true', '+        run: pytest || true'],
    ['--no-verify', '+        run: git commit --no-verify -m wip'],
    ['set +e', '+        run: set +e'],
    ['allow_failure', '+    allow_failure: true'],
  ])('flags %s added in a plain script', (_label, addedLine) => {
    expect(verificationLayerReason('scripts/ci.sh', ['@@ -1,2 +1,3 @@', addedLine].join('\n'))).toBe(
      REASON_FAILURE_SUPPRESSED,
    );
  });

  it('ignores a suppression token that is only being REMOVED', () => {
    // Deleting `|| true` strengthens CI; it must not be reported as weakening it.
    expect(
      verificationLayerReason('scripts/ci.sh', ['@@ -1,2 +1,2 @@', '-  pytest || true', '+  pytest'].join('\n')),
    ).toBeNull();
  });

  it('flags a lowered Jest threshold even though the token sits on a context line', () => {
    const reason = verificationLayerReason(
      'jest.config.js',
      [
        '@@ -6,8 +6,8 @@ module.exports = {',
        '   coverageThreshold: {',
        '     global: {',
        '-      lines: 90,',
        '+      lines: 25,',
        '     },',
      ].join('\n'),
    );
    expect(reason).toBe(REASON_COVERAGE_THRESHOLD);
  });

  it.each([
    ['vitest.config.ts', '-      thresholds: { lines: 90 },', '+      thresholds: { lines: 10 },'],
    ['setup.cfg', '-fail_under = 90', '+fail_under = 10'],
    ['pytest.ini', '-addopts = --cov-fail-under=90', '+addopts = --cov-fail-under=10'],
    ['.coveragerc', '-fail_under = 80', '+fail_under = 0'],
  ])('flags a coverage gate change in %s', (path, removed, added) => {
    expect(verificationLayerReason(path, ['@@ -1,3 +1,3 @@', removed, added].join('\n'))).toBe(
      REASON_COVERAGE_THRESHOLD,
    );
  });

  it('leaves a coverage-capable config alone when no threshold is in the hunk', () => {
    // pyproject.toml is also a dependency manifest; a dependency bump is not a gate change.
    expect(
      verificationLayerReason(
        'pyproject.toml',
        ['@@ -10,3 +10,3 @@ dependencies = [', '-  "httpx==0.27.0",', '+  "httpx==0.28.1",'].join('\n'),
      ),
    ).toBeNull();
  });

  it.each([
    'CLAUDE.md',
    'AGENTS.md',
    'packages/api/AGENTS.md',
    '.cursorrules',
    '.cursor/rules/testing.mdc',
    '.github/copilot-instructions.md',
  ])('flags agent rule file %s', (path) => {
    expect(verificationLayerReason(path, '@@ -1,2 +1,2 @@\n-always run tests\n+skip tests')).toBe(
      REASON_AGENT_RULES,
    );
  });

  it('flags conftest.py as test infrastructure', () => {
    expect(
      verificationLayerReason('tests/conftest.py', '@@ -1,2 +1,2 @@\n-import pytest\n+import pytest  # noqa'),
    ).toBe(REASON_TEST_INFRA);
  });

  it('returns null for ordinary source and docs', () => {
    expect(verificationLayerReason('src/auth/login.ts', '@@ -1,2 +1,2 @@\n-a\n+b')).toBeNull();
    expect(verificationLayerReason('README.md', undefined)).toBeNull();
  });
});

describe('patch helpers', () => {
  const sample = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-removed',
    '+added',
  ].join('\n');

  it('addedLines skips the +++ header and strips the marker', () => {
    expect(addedLines(sample)).toEqual(['added']);
  });

  it('changedLines skips both headers and returns each side', () => {
    expect(changedLines(sample)).toEqual(['removed', 'added']);
  });

  it('treats a missing patch as no lines', () => {
    expect(addedLines(undefined)).toEqual([]);
    expect(changedLines(undefined)).toEqual([]);
  });
});
