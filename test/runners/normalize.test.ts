import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecutedTest } from '../../src/core/types.js';
import { adapters, normalize, testsDigest } from '../../src/core/runners/index.js';
import { fixture } from './fixtures.js';

describe('adapters registry', () => {
  it('maps every family that produces machine-readable output', () => {
    expect(adapters.go?.family).toBe('go');
    expect(adapters.pytest?.family).toBe('pytest');
    expect(adapters.jest?.family).toBe('jest');
    expect(adapters.vitest?.family).toBe('vitest');
    expect(adapters.junit?.family).toBe('junit');
  });

  it('leaves families with no per-test output unmapped', () => {
    // Plain `cargo test`, `make` and bare package scripts print prose only —
    // detect.ts attaches a note explaining that per-test evidence is unavailable.
    expect(adapters.cargo).toBeUndefined();
    expect(adapters.make).toBeUndefined();
    expect(adapters.npm).toBeUndefined();
  });
});

describe('normalize', () => {
  it('parses a go stream and recomputes totals from the tests', () => {
    const { tests, totals } = normalize('go', fixture('go-test.jsonl'));
    expect(totals).toEqual({ run: 7, passed: 3, failed: 3, skipped: 1, retried: 0 });
    expect(totals.run).toBe(tests.length);
  });

  it('parses pytest JUnit through the pytest family', () => {
    const { totals } = normalize('pytest', fixture('pytest-junit.xml'));
    expect(totals).toEqual({ run: 4, passed: 2, failed: 1, skipped: 1, retried: 0 });
  });

  it('parses nextest JUnit through the junit family', () => {
    const { totals } = normalize('junit', fixture('nextest-junit.xml'));
    expect(totals.retried).toBe(2);
  });

  it('parses vitest output through the vitest family', () => {
    const { totals } = normalize('vitest', fixture('vitest-results.json'));
    expect(totals).toEqual({ run: 3, passed: 2, failed: 1, skipped: 0, retried: 0 });
  });

  it('returns tests sorted by id', () => {
    const { tests } = normalize('jest', fixture('jest-results.json'));
    const ids = tests.map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('throws for a family with no adapter', () => {
    expect(() => normalize('cargo', 'running 3 tests')).toThrow(/no runner adapter/);
  });
});

describe('testsDigest', () => {
  const a: ExecutedTest = { id: 'pkg/TestA', status: 'passed' };
  const b: ExecutedTest = { id: 'pkg/TestB', status: 'failed' };

  it('hashes the sorted ids joined by newlines', () => {
    expect(testsDigest([a, b])).toBe(
      'sha256:0572ad607818219820b3b986dfeaddee5b794821af95d2bc810e853d69c39787',
    );
  });

  it('does not depend on input order', () => {
    expect(testsDigest([b, a])).toBe(testsDigest([a, b]));
  });

  it('ignores status, duration and file — only the executed set matters', () => {
    expect(testsDigest([{ ...a, status: 'failed', durationMs: 9, file: 'x.go' }, b])).toBe(
      testsDigest([a, b]),
    );
  });

  it('changes when a test disappears', () => {
    expect(testsDigest([a])).not.toBe(testsDigest([a, b]));
  });

  it('hashes the empty string for an empty run', () => {
    expect(testsDigest([])).toBe(`sha256:${createHash('sha256').update('', 'utf8').digest('hex')}`);
  });

  it('is reproducible from the receipt recipe (sorted ids, newline-joined)', () => {
    const { tests } = normalize('go', fixture('go-test.jsonl'));
    const expected = createHash('sha256')
      .update(
        tests
          .map((t) => t.id)
          .sort()
          .join('\n'),
        'utf8',
      )
      .digest('hex');
    expect(testsDigest(tests)).toBe(`sha256:${expected}`);
  });
});
