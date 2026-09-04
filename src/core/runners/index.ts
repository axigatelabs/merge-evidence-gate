/**
 * Runners module — decide how a repository runs its tests, and turn each
 * runner's machine-readable output into one normalized list of what actually
 * ran.
 *
 * This module is pure: it reads no files, spawns no processes, and makes no
 * network calls. The Action supplies manifest contents and reporter output as
 * strings; everything here is a function of those strings.
 */
import { createHash } from 'node:crypto';
import type { ExecutedTest, ObservedRun, RunnerAdapter, RunnerFamily } from '../types.js';
import { countTotals, goAdapter } from './adapters/go.js';
import { jestAdapter, vitestAdapter } from './adapters/jest.js';
import { junitAdapter, pytestAdapter } from './adapters/junit.js';

export { detectTestCommand, REPORT_DIR, REPORT_PATHS } from './detect.js';
export type { DetectedCommand, DetectInput } from './detect.js';
export { goAdapter, parseGoTestJson } from './adapters/go.js';
export { junitAdapter, pytestAdapter, parseJUnitXml } from './adapters/junit.js';
export { jestAdapter, vitestAdapter, parseJestJson } from './adapters/jest.js';

/**
 * Adapter per runner family. `undefined` means the family produces no per-test
 * machine-readable output, so the gate can record that a command ran but cannot
 * enumerate tests — `detect.ts` attaches a `note` explaining why.
 *
 * `junit` covers cargo-nextest and any other JUnit producer; plain `cargo test`
 * has no structured output at all.
 */
export const adapters: Record<RunnerFamily, RunnerAdapter | undefined> = {
  go: goAdapter,
  pytest: pytestAdapter,
  jest: jestAdapter,
  vitest: vitestAdapter,
  junit: junitAdapter,
  cargo: undefined,
  make: undefined,
  npm: undefined,
};

/**
 * Parse `raw` with the adapter for `family` and recompute the totals from the
 * resulting tests, so the totals on the receipt always agree with the test list
 * they summarise. Tests are sorted by id for a reproducible digest.
 *
 * Throws when the family has no adapter — the caller must check
 * `adapters[family]` (or the `note` on the detected command) first.
 */
export function normalize(
  family: RunnerFamily,
  raw: string,
): { tests: ExecutedTest[]; totals: ObservedRun['totals'] } {
  const adapter = adapters[family];
  if (adapter === undefined) {
    throw new Error(`no runner adapter for family '${family}': no machine-readable output to parse`);
  }
  const { tests } = adapter.parse(raw);
  const sorted = [...tests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { tests: sorted, totals: countTotals(sorted) };
}

/**
 * `sha256:` over the sorted executed test ids, newline-joined.
 *
 * This is the receipt's `observed.tests_digest`: it lets a stranger re-run the
 * recorded command and confirm the same set of tests executed, without the tool
 * having to publish the raw log.
 */
export function testsDigest(tests: ExecutedTest[]): string {
  const ids = tests.map((test) => test.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex');
  return `sha256:${hash}`;
}
