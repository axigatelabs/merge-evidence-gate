import { describe, expect, it } from 'vitest';
import { parseGoTestJson } from '../../src/core/runners/adapters/go.js';
import { fixture } from './fixtures.js';

describe('go test -json adapter', () => {
  const result = parseGoTestJson(fixture('go-test.jsonl'));

  it('records one entry per test, sorted by id', () => {
    expect(result.tests.map((t) => t.id)).toEqual([
      'github.com/acme/svc/internal/cache/<build>',
      'github.com/acme/svc/pkg/node/TestPrune',
      'github.com/acme/svc/pkg/node/TestPrune/deep_tree',
      'github.com/acme/svc/pkg/node/TestPrune/empty_tree',
      'github.com/acme/svc/pkg/node/TestWalkSkipsSymlinks',
      'github.com/acme/svc/pkg/store/TestCompact',
      'github.com/acme/svc/pkg/store/TestPutGet',
    ]);
  });

  it('maps pass/fail/skip and keeps subtest paths', () => {
    const byId = new Map(result.tests.map((t) => [t.id, t]));
    expect(byId.get('github.com/acme/svc/pkg/node/TestPrune/empty_tree')?.status).toBe('passed');
    expect(byId.get('github.com/acme/svc/pkg/node/TestPrune/deep_tree')?.status).toBe('failed');
    expect(byId.get('github.com/acme/svc/pkg/node/TestPrune')?.status).toBe('failed');
    expect(byId.get('github.com/acme/svc/pkg/node/TestWalkSkipsSymlinks')?.status).toBe('skipped');
    expect(byId.get('github.com/acme/svc/pkg/store/TestPutGet')?.status).toBe('passed');
  });

  it('counts a FailedBuild package as one failure', () => {
    const build = result.tests.find((t) => t.id.endsWith('/<build>'));
    expect(build).toEqual({ id: 'github.com/acme/svc/internal/cache/<build>', status: 'failed' });
  });

  it('converts Elapsed seconds to milliseconds', () => {
    const compact = result.tests.find((t) => t.id.endsWith('/TestCompact'));
    expect(compact?.durationMs).toBeCloseTo(61, 6);
  });

  it('totals the run', () => {
    expect(result.totals).toEqual({ run: 7, passed: 3, failed: 3, skipped: 1, retried: 0 });
  });

  it('ignores output lines and package-level pass/fail without FailedBuild', () => {
    // The store package passes and the node package fails at package level;
    // neither becomes a test entry, so only real tests plus the build are counted.
    expect(result.tests.filter((t) => !t.id.includes('/Test') && !t.id.endsWith('/<build>'))).toEqual(
      [],
    );
  });

  it('treats a test that started but never reported as failed', () => {
    const panicked = parseGoTestJson(fixture('go-test-panic.jsonl'));
    expect(panicked.tests).toEqual([
      { id: 'github.com/acme/svc/pkg/queue/TestDrain', status: 'passed', durationMs: 39 },
      { id: 'github.com/acme/svc/pkg/queue/TestEnqueueRace', status: 'failed' },
    ]);
    expect(panicked.totals).toEqual({ run: 2, passed: 1, failed: 1, skipped: 0, retried: 0 });
  });

  it('reports repeated results as invocations (a -count=N run)', () => {
    const repeated = parseGoTestJson(fixture('go-test-count2.jsonl'));
    expect(repeated.tests[0]?.invocations).toBe(2);
    expect(repeated.totals).toEqual({ run: 1, passed: 1, failed: 0, skipped: 0, retried: 1 });
  });

  it('survives non-JSON noise from a wrapper script', () => {
    const noisy = ['make: entering directory', fixture('go-test-count2.jsonl'), 'ok  0.4s'].join(
      '\n',
    );
    expect(parseGoTestJson(noisy).totals.run).toBe(1);
  });

  it('returns nothing for empty input', () => {
    expect(parseGoTestJson('')).toEqual({
      tests: [],
      totals: { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 },
    });
  });
});
