/**
 * litellm #39467's body has "Before (sha)" and "After (sha)" sections, each with
 * a command and a count. The gate ran the first command and reported two C2
 * findings: the "before" count describes the bug, and the "61 passed" count
 * belongs to the second command. Two rules: a section that describes another
 * state is not a claim, and a count is bound to the command it follows.
 */
import { describe, expect, it } from 'vitest';

import { extractClaims } from '../../src/core/claims/extract.js';
import { buildReceipt } from '../../src/core/reconcile/receipt.js';
import { DEFAULT_POLICY } from '../../src/core/reconcile/policy.js';
import { reconcile } from '../../src/core/reconcile/reconcile.js';
import type { Claim, ExecutedTest, PullRequestFacts } from '../../src/core/types.js';
import { agent, diff, observed, pr as prFacts } from '../reconcile/fixtures.js';

const facts = (body: string): PullRequestFacts => ({ ...prFacts(), body });

const BODY = `## Summary

Fix the cadence check.

## Before (e0e2492)

1. \`LITELLM_LOCAL_MODEL_COST_MAP=True uv run pytest tests/a/test_x.py -k cadence -q\`
2. \`2 failed, 2 passed\`

## After (484f801)

1. \`LITELLM_LOCAL_MODEL_COST_MAP=True uv run pytest tests/a/test_x.py -q\`
2. \`61 passed\`

## Checklist

- [x] I have added meaningful tests
`;

describe('sections that describe another state are not claims', () => {
  it('drops the commands and counts under "Before (sha)", keeps the ones under "After"', () => {
    const claims = extractClaims(facts(BODY));
    const commands = claims.filter((c) => c.kind === 'command');
    const counts = claims.filter((c) => c.kind === 'count');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.section).toBe('After (484f801)');
    expect(counts).toHaveLength(1);
    expect(counts[0]?.text).toBe('61 passed');
    expect(claims.filter((c) => c.kind === 'checkbox')).toHaveLength(1);
  });

  it.each(['Previously', 'Steps to reproduce', 'Current behavior', 'Reproduction', 'Without the fix'])('skips a "%s" section', (heading) => {
    const claims = extractClaims(facts(`## ${heading}\n\n\`pytest -q\` gave 3 failed.\n\n## Test plan\n\n\`pytest -q\`: 12 passed\n`));
    expect(claims.map((c) => [c.kind, c.section])).toEqual([
      ['command', 'Test plan'],
      ['count', 'Test plan'],
    ]);
  });
});

describe('a count is bound to the command it follows', () => {
  it('records the preceding command in the same section, on the same line or an earlier one', () => {
    const claims = extractClaims(facts(BODY));
    const command = claims.find((c) => c.kind === 'command');
    const count = claims.find((c) => c.kind === 'count');
    expect(count?.commandRef).toBe(command?.id);

    const sameLine = extractClaims(facts('- [x] \`go test ./...\` — 68 tests, 0 failures\n'));
    const cmd = sameLine.find((c) => c.kind === 'command');
    expect(sameLine.find((c) => c.kind === 'count')?.commandRef).toBe(cmd?.id);
  });

  it('does not bind across sections, and leaves a count with no command unbound', () => {
    const claims = extractClaims(facts('## Run\n\n\`pytest -q\`\n\n## Results\n\n12 passed\n'));
    expect(claims.find((c) => c.kind === 'count')?.commandRef).toBeUndefined();
  });
});

describe('C2 compares a bound count only against the run of its own command', () => {
  const t = (id: string): ExecutedTest => ({ id, status: 'passed' });
  const claims = (): Claim[] => extractClaims(facts(BODY));
  const runOf = (claimId: string | undefined) =>
    observed({
      runner: 'pytest',
      exitCode: 0,
      tests: [t('tests/a/test_x.py::a'), t('tests/a/test_x.py::b'), t('tests/a/test_x.py::c'), t('tests/a/test_x.py::d')],
      ...(claimId === undefined ? {} : { claimId }),
    });

  it('is unverifiable when the run came from a different claim, compared when it came from the same one', () => {
    const cs = claims();
    const command = cs.find((c) => c.kind === 'command');
    const count = cs.find((c) => c.kind === 'count');
    if (command === undefined || count === undefined) throw new Error('fixture');

    const other = reconcile({ pr: prFacts(), claims: cs, observed: runOf('c99'), diff: diff(), policy: DEFAULT_POLICY });
    expect(other.discrepancies.map((d) => d.check)).not.toContain('C2');
    expect(other.unverifiable).toContain(count.id);

    const same = reconcile({ pr: prFacts(), claims: cs, observed: runOf(command.id), diff: diff(), policy: DEFAULT_POLICY });
    expect(same.discrepancies.map((d) => d.check)).toContain('C2');

    const unattributed = reconcile({ pr: prFacts(), claims: cs, observed: runOf(undefined), diff: diff(), policy: DEFAULT_POLICY });
    expect(unattributed.discrepancies.map((d) => d.check)).toContain('C2');
  });

  it('writes the executed claim on the receipt', () => {
    const cs = claims();
    const obs = runOf('c1');
    const result = reconcile({ pr: prFacts(), claims: cs, observed: obs, diff: diff(), policy: DEFAULT_POLICY });
    const receipt = buildReceipt({ pr: prFacts(), agent: agent(), claims: cs, observed: obs, diff: diff(), discrepancies: result.discrepancies, verdict: result.verdict, policy: DEFAULT_POLICY, now: new Date('2026-09-05T00:00:00Z') });
    expect(receipt.observed.claim).toBe('c1');
    expect(receipt.claims.find((c) => c.kind === 'count')?.commandRef).toBeDefined();
  });
});
