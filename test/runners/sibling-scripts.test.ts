/**
 * `test` is npm's placeholder (`echo "Error: no test specified" && exit 1`)
 * while the suite lives under `test:unit`. Infisical's backend; every one of
 * its PRs in the study came back with no evidence.
 */
import { describe, expect, it } from 'vitest';

import { detectTestCommand } from '../../src/core/runners/index.js';

const files = (scripts: Record<string, string>, lock: Record<string, string> = { 'package-lock.json': '{}' }) => ({
  'package.json': JSON.stringify({ name: 'backend', scripts, devDependencies: { vitest: '^3', jest: '^29' } }),
  ...lock,
});

describe('a placeholder or runner-less test script falls through to a sibling', () => {
  it('runs test:unit when test is the npm placeholder', () => {
    const detected = detectTestCommand({
      files: files({ test: 'echo "Error: no test specified" && exit 1', 'test:unit': 'vitest run -c vitest.unit.config.mts', 'test:e2e': 'vitest run -c vitest.e2e.config.mts' }),
    });
    expect(detected?.family).toBe('vitest');
    expect(detected?.command).toBe('npm run test:unit -- --reporter=json --outputFile=.merge-evidence/vitest-results.json');
    expect(detected?.note).toBe("the `test` script is npm's placeholder; running `test:unit` instead");
  });

  it('prefers test:unit over test:ci, and a chained step over a sibling', () => {
    const chained = detectTestCommand({ files: files({ test: 'npm run lint && npm run test:ci', 'test:ci': 'jest --ci', 'test:unit': 'vitest run' }) });
    expect(chained?.command).toContain('npm run test:ci --');
    const sibling = detectTestCommand({ files: files({ test: 'echo nope && exit 1', 'test:ci': 'jest --ci', 'test:unit': 'vitest run' }) });
    expect(sibling?.command).toContain('npm run test:unit --');
    expect(sibling?.note).toBe('the `test` script names no runner; running `test:unit` instead');
  });

  it('leaves a runner-naming test script alone and keeps the dependency guess when no sibling names a runner', () => {
    expect(detectTestCommand({ files: files({ test: 'vitest run', 'test:unit': 'jest' }) })?.command).toBe('npm test -- --reporter=json --outputFile=.merge-evidence/vitest-results.json');
    const none = detectTestCommand({ files: files({ test: 'echo "Error: no test specified" && exit 1', build: 'tsc' }) });
    expect(none?.family).toBe('vitest');
    expect(none?.command).toBe('npm test -- --reporter=json --outputFile=.merge-evidence/vitest-results.json');
  });
});
