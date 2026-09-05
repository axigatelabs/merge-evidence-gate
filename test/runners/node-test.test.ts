import { describe, expect, it } from 'vitest';
import { parseNodeTestJUnit } from '../../src/core/runners/adapters/node-test.js';
import { normalize } from '../../src/core/runners/index.js';
import { fixture } from './fixtures.js';

describe("node's test runner — junit reporter", () => {
  const result = parseNodeTestJUnit(fixture('node-test-junit.xml'), { cwd: '/work/repo' });

  it('builds ids from the repository-relative file and the describe path', () => {
    expect(result.tests.map((t) => t.id)).toEqual([
      'packages/api/test/other.test.js::other file passes',
      'test/math.test.js::add > adds two numbers',
      'test/math.test.js::add > fails on purpose',
      'test/math.test.js::add > skipped one',
      'test/math.test.js::add > todo one',
      'test/math.test.js::top level passes',
      'test/nested.test.js::outer > adds two numbers',
      'test/nested.test.js::outer > inner > deep passes',
    ]);
  });

  it('keeps a same-named test in two suites distinct', () => {
    const named = result.tests.filter((t) => t.id.endsWith('adds two numbers'));
    expect(named).toHaveLength(2);
  });

  it('maps failure, skipped and todo children; ignores the constant classname', () => {
    const byId = new Map(result.tests.map((t) => [t.id, t]));
    expect(byId.get('test/math.test.js::add > fails on purpose')?.status).toBe('failed');
    expect(byId.get('test/math.test.js::add > skipped one')?.status).toBe('skipped');
    expect(byId.get('test/math.test.js::add > todo one')?.status).toBe('skipped');
    expect(byId.get('test/math.test.js::top level passes')?.status).toBe('passed');
    expect(result.tests.every((t) => !t.id.includes('::test::'))).toBe(true);
  });

  it('records the relative file and the duration', () => {
    const deep = result.tests.find((t) => t.id.endsWith('deep passes'));
    expect(deep?.file).toBe('test/nested.test.js');
    expect(deep?.durationMs).toBeCloseTo(0.05, 6);
  });

  it('totals the run', () => {
    expect(result.totals).toEqual({ run: 8, passed: 5, failed: 1, skipped: 2, retried: 0 });
  });

  it('keeps the absolute path when no cwd is given or the file lies outside it', () => {
    const bare = parseNodeTestJUnit(fixture('node-test-junit.xml'));
    expect(bare.tests[0]?.id).toBe('/work/repo/packages/api/test/other.test.js::other file passes');
    const elsewhere = parseNodeTestJUnit(fixture('node-test-junit.xml'), { cwd: '/other/checkout' });
    expect(elsewhere.tests[0]?.file).toBe('/work/repo/packages/api/test/other.test.js');
  });

  it('returns nothing for empty input', () => {
    expect(parseNodeTestJUnit('   ')).toEqual({
      tests: [],
      totals: { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 },
    });
  });

  it('is registered under the node-test family and receives the cwd through normalize', () => {
    const viaNormalize = normalize('node-test', fixture('node-test-junit.xml'), { cwd: '/work/repo' });
    expect(viaNormalize.tests.map((t) => t.id)).toEqual(result.tests.map((t) => t.id));
  });
});
