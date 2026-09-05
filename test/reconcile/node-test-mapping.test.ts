import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, reconcile } from '../../src/core/reconcile/index.js';
import { commandClaim, countClaim, diff, observed, pr, test as executed } from './fixtures.js';

const NODE_RUN = observed({
  command: 'npm test',
  runner: 'node-test',
  toolchain: { node: '24.4.0' },
  tests: [
    executed('test/math.test.js::math > adds'),
    executed('test/math.test.js::math > subtracts'),
    executed('test/math.test.js::top level: adds negatives'),
  ],
});

describe("reconcile — a package script that resolves to node's runner", () => {
  it('maps a claimed `npm test` onto the node-test run and confirms its count', () => {
    const claims = [commandClaim('c1', 'npm test', { runner: 'npm' }), countClaim('c2', '3 tests', { total: 3 })];
    const result = reconcile({ pr: pr(), claims, observed: NODE_RUN, diff: diff(), policy: DEFAULT_POLICY });
    expect(result.unverifiable).toEqual([]);
    expect(result.discrepancies).toEqual([]);
    expect(result.verdict).toBe('PASS');
  });

  it('still refuses a claim whose invocation differs from the run', () => {
    const claims = [commandClaim('c1', 'pnpm test:e2e', { runner: 'npm' })];
    const result = reconcile({ pr: pr(), claims, observed: NODE_RUN, diff: diff(), policy: DEFAULT_POLICY });
    expect(result.unverifiable).toEqual(['c1']);
  });

  it('maps a claimed direct `node --test` by family and selector', () => {
    const direct = observed({ ...NODE_RUN, command: 'node --test test/' });
    const claims = [commandClaim('c1', 'node --test test/', { runner: 'node-test', paths: ['test/'] })];
    const result = reconcile({ pr: pr(), claims, observed: direct, diff: diff(), policy: DEFAULT_POLICY });
    expect(result.unverifiable).toEqual([]);
    expect(result.verdict).toBe('PASS');
  });
});
