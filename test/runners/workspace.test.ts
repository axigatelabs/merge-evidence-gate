/**
 * Workspace scoping: a monorepo whose root has no test command is tested
 * through the `test` scripts of the packages the pull request touches, run
 * from their own directories. supabase/supabase is the motivating case: the
 * root package.json carries only turbo tasks; every PR in the study came back
 * NEUTRAL until this existed.
 */
import { describe, expect, it } from 'vitest';

import { detectWorkspaceCommand, MAX_WORKSPACE_PACKAGES, type WorkspacePackage } from '../../src/core/runners/index.js';

const pkg = (dir: string, test: string | undefined, deps: Record<string, string> = {}): WorkspacePackage => ({
  dir,
  files: {
    'package.json': JSON.stringify({ name: dir.replace('/', '-'), scripts: test === undefined ? {} : { test }, devDependencies: deps }),
  },
});

const ROOT_PNPM = { 'package.json': '{"name":"root","private":true}', 'pnpm-lock.yaml': 'lockfileVersion: 9' };

describe('detectWorkspaceCommand', () => {
  it('runs each touched package’s test script from its directory, reporter injected, one report per package', () => {
    const detected = detectWorkspaceCommand({
      rootFiles: ROOT_PNPM,
      packages: [pkg('apps/studio', 'vitest run', { vitest: '^3' }), pkg('packages/ui', 'vitest', { vitest: '^3' })],
    });
    expect(detected?.family).toBe('vitest');
    expect(detected?.command).toBe(
      "f=0; (cd 'apps/studio' && export PATH=\"$PWD/node_modules/.bin:$PATH\" && mkdir -p .merge-evidence && pnpm test --reporter=json --outputFile=.merge-evidence/vitest-results.json) || f=1; " +
        "(cd 'packages/ui' && export PATH=\"$PWD/node_modules/.bin:$PATH\" && mkdir -p .merge-evidence && pnpm test --reporter=json --outputFile=.merge-evidence/vitest-results.json) || f=1; " +
        'exit "$f"',
    );
    expect(detected?.reportPath).toBe('.merge-evidence/vitest-results.json');
    expect(detected?.note).toContain('root has no test command; running the test script of 2 workspace package(s) this PR touches: apps/studio, packages/ui');
  });

  it('uses the root lockfile for the package manager and the npm separator when there is none', () => {
    const detected = detectWorkspaceCommand({
      rootFiles: { 'package.json': '{}' },
      packages: [pkg('packages/a', 'jest', { jest: '^29' })],
    });
    expect(detected?.family).toBe('jest');
    expect(detected?.command).toContain("(cd 'packages/a' && export PATH=\"$PWD/node_modules/.bin:$PATH\" && mkdir -p .merge-evidence && npm test -- --json --outputFile=.merge-evidence/jest-results.json");
  });

  it('skips packages without a test script and returns null when none has one', () => {
    const detected = detectWorkspaceCommand({
      rootFiles: ROOT_PNPM,
      packages: [pkg('packages/docs', undefined), pkg('packages/a', 'vitest run', { vitest: '^3' })],
    });
    expect(detected?.command).not.toContain('packages/docs');
    expect(detected?.command).toContain("'packages/a'");
    expect(detectWorkspaceCommand({ rootFiles: ROOT_PNPM, packages: [pkg('packages/docs', undefined)] })).toBeNull();
    expect(detectWorkspaceCommand({ rootFiles: ROOT_PNPM, packages: [] })).toBeNull();
  });

  it('runs only the first package’s runner family and says which packages were not run', () => {
    const detected = detectWorkspaceCommand({
      rootFiles: ROOT_PNPM,
      packages: [pkg('packages/a', 'vitest run', { vitest: '^3' }), pkg('packages/b', 'jest', { jest: '^29' })],
    });
    expect(detected?.family).toBe('vitest');
    expect(detected?.command).not.toContain("'packages/b'");
    expect(detected?.note).toContain('packages/b use a different runner (jest) and were not run');
  });

  it('caps the number of packages and notes the rest', () => {
    const many = Array.from({ length: MAX_WORKSPACE_PACKAGES + 2 }, (_, i) => pkg(`packages/p${i}`, 'vitest run', { vitest: '^3' }));
    const detected = detectWorkspaceCommand({ rootFiles: ROOT_PNPM, packages: many });
    expect((detected?.command.match(/\(cd /g) ?? []).length).toBe(MAX_WORKSPACE_PACKAGES);
    expect(detected?.note).toContain(`2 more touched package(s) not run (limit ${MAX_WORKSPACE_PACKAGES}): packages/p5, packages/p6`);
  });

  it('runs a claimed command inside each package when one is given', () => {
    const detected = detectWorkspaceCommand({
      explicit: 'vitest',
      rootFiles: ROOT_PNPM,
      packages: [pkg('apps/studio', 'vitest run', { vitest: '^3' })],
    });
    expect(detected?.family).toBe('vitest');
    expect(detected?.command).toContain("(cd 'apps/studio' && export PATH=\"$PWD/node_modules/.bin:$PATH\" && mkdir -p .merge-evidence && vitest --reporter=json --outputFile=.merge-evidence/vitest-results.json)");
    expect(detected?.note).toContain('running the claimed command in 1 workspace package(s) this PR touches: apps/studio');
  });

  it('quotes a directory that contains a single quote', () => {
    const detected = detectWorkspaceCommand({
      rootFiles: ROOT_PNPM,
      packages: [pkg("packages/o'brien", 'vitest run', { vitest: '^3' })],
    });
    expect(detected?.command).toContain("(cd 'packages/o'\\''brien' &&");
  });
});
