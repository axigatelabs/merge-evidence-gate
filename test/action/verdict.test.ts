import { describe, expect, it } from 'vitest';
import { applyVerdict, type VerdictSink } from '../../src/action/verdict.js';
import type { Verdict } from '../../src/core/types.js';

function recorder(): VerdictSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setFailed: (m) => calls.push(`failed: ${m}`),
    warning: (m) => calls.push(`warning: ${m}`),
    info: (m) => calls.push(`info: ${m}`),
  };
}

const VERDICTS: Verdict[] = ['PASS', 'NEEDS_HUMAN', 'FAIL', 'NEUTRAL'];

describe('applyVerdict', () => {
  it('fail (the default) fails the job only on FAIL', () => {
    const outcome = VERDICTS.map((v) => {
      const sink = recorder();
      applyVerdict(v, 'fail', `Gate — ${v}`, sink);
      return sink.calls[0]?.split(':')[0];
    });
    expect(outcome).toEqual(['info', 'warning', 'failed', 'info']);
  });

  it('needs-human also fails the job on NEEDS_HUMAN', () => {
    const sink = recorder();
    applyVerdict('NEEDS_HUMAN', 'needs-human', 'Gate — NEEDS_HUMAN', sink);
    expect(sink.calls).toEqual(['failed: Gate — NEEDS_HUMAN']);
  });

  it('never keeps the job green on every verdict and says so on the bad ones', () => {
    const outcome = VERDICTS.map((v) => {
      const sink = recorder();
      applyVerdict(v, 'never', `Gate — ${v}`, sink);
      return sink.calls[0] ?? '';
    });
    expect(outcome.some((line) => line.startsWith('failed'))).toBe(false);
    expect(outcome[2]).toBe("warning: Gate — FAIL — fail-on is 'never', so the job stays green; read the receipt");
    expect(outcome[1]).toMatch(/^warning: Gate — NEEDS_HUMAN — fail-on is 'never'/);
    expect(outcome[0]).toBe('info: Gate — PASS');
    expect(outcome[3]).toBe('info: Gate — NEUTRAL');
  });
});
