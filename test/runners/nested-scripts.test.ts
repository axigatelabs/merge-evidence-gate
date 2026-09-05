/**
 * A `test` script that is a chain around the real runner. supabase's
 * apps/docs: `pnpm supabase start && pnpm run test:local && pnpm supabase
 * stop`, where `test:local` is the vitest step — reporter flags appended to
 * `pnpm test` landed on `pnpm supabase stop`.
 */
import { describe, expect, it } from 'vitest';

import { detectTestCommand } from '../../src/core/runners/index.js';

const pkg = (scripts: Record<string, string>, pm: 'pnpm' | 'npm' = 'pnpm') => ({
  'package.json': JSON.stringify({ name: 'docs', scripts, devDependencies: { vitest: '^3', jest: '^29' } }),
  ...(pm === 'pnpm' ? { 'pnpm-lock.yaml': 'lockfileVersion: 9' } : {}),
});

describe('a test script that chains to the runner through another script', () => {
  it('runs the nested vitest step directly and says so', () => {
    const detected = detectTestCommand({
      files: pkg({
        test: 'pnpm supabase start && pnpm run test:local && pnpm supabase stop',
        'test:local': 'vitest --exclude "**/*.smoke.test.ts"',
      }),
    });
    expect(detected?.family).toBe('vitest');
    expect(detected?.command).toBe('pnpm run test:local --reporter=json --outputFile=.merge-evidence/vitest-results.json');
    expect(detected?.note).toBe('the `test` script chains to `test:local`; running that step directly');
  });

  it('keeps the npm separator for a nested jest step', () => {
    const detected = detectTestCommand({
      files: pkg({ test: 'npm run lint && npm run test:unit', 'test:unit': 'jest --ci' }, 'npm'),
    });
    expect(detected?.family).toBe('jest');
    expect(detected?.command).toBe('npm run test:unit -- --json --outputFile=.merge-evidence/jest-results.json --ci');
  });

  it('leaves a script that names the runner itself alone', () => {
    const detected = detectTestCommand({ files: pkg({ test: 'vitest run', 'test:local': 'vitest' }) });
    expect(detected?.command).toBe('pnpm test --reporter=json --outputFile=.merge-evidence/vitest-results.json');
    expect(detected?.note).toBeUndefined();
  });

  it('falls back to the dependency-based guess when no nested step names a runner', () => {
    const detected = detectTestCommand({ files: pkg({ test: 'pnpm run build && pnpm run check', check: 'tsc' }) });
    // classifyNodeRunner picks vitest from devDependencies, as before
    expect(detected?.family).toBe('vitest');
    expect(detected?.command).toBe('pnpm test --reporter=json --outputFile=.merge-evidence/vitest-results.json');
  });
});
