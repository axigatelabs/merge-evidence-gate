/**
 * Jest / Vitest `--json` adapter.
 *
 * Vitest's JSON reporter deliberately emits Jest's `AggregatedResult` shape, so
 * one parser serves both. The per-file entry is `name` in the on-disk report and
 * `testFilePath` in some Jest versions and in-process shapes; we accept either.
 *
 * Identity is `<file>::<fullName>`, where `fullName` already includes the
 * enclosing `describe` blocks — the same string a developer passes to `-t`.
 */
import type { ExecutedTest, ObservedRun, RunnerAdapter, TestStatus } from '../../types.js';
import { compareById, countTotals } from './go.js';

interface JestAssertion {
  fullName?: string;
  title?: string;
  status?: string;
  duration?: number | null;
  invocations?: number;
  location?: { line?: number } | null;
}

interface JestFileResult {
  testFilePath?: string;
  name?: string;
  assertionResults?: JestAssertion[];
}

interface JestReport {
  testResults?: JestFileResult[];
}

/**
 * Jest and Vitest agree on these status strings. `pending`/`todo`/`disabled` all
 * mean "declared but not executed", which the receipt reports as `skipped`;
 * `focused` is kept distinct because a PR that focuses a test silently drops
 * every other test in the file, and that is a finding, not a skip.
 */
const STATUS_MAP: Record<string, TestStatus> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'skipped',
  todo: 'skipped',
  disabled: 'skipped',
  focused: 'focused',
};

export function parseJestJson(raw: string): {
  tests: ExecutedTest[];
  totals: ObservedRun['totals'];
} {
  if (raw.trim() === '') return { tests: [], totals: countTotals([]) };

  let report: JestReport;
  try {
    const parsed: unknown = JSON.parse(raw);
    report = typeof parsed === 'object' && parsed !== null ? (parsed as JestReport) : {};
  } catch {
    return { tests: [], totals: countTotals([]) };
  }

  const tests: ExecutedTest[] = [];
  for (const fileResult of report.testResults ?? []) {
    const file = fileResult.testFilePath ?? fileResult.name ?? '';
    for (const assertion of fileResult.assertionResults ?? []) {
      const fullName = assertion.fullName ?? assertion.title;
      if (fullName === undefined || fullName === '') continue;
      const status = STATUS_MAP[assertion.status ?? ''];
      if (status === undefined) continue;

      const test: ExecutedTest = { id: `${file}::${fullName}`, status };
      if (file !== '') test.file = file;
      if (typeof assertion.duration === 'number') test.durationMs = assertion.duration;
      if (typeof assertion.invocations === 'number' && assertion.invocations > 0) {
        test.invocations = assertion.invocations;
      }
      tests.push(test);
    }
  }

  tests.sort(compareById);
  return { tests, totals: countTotals(tests) };
}

export const jestAdapter: RunnerAdapter = {
  family: 'jest',
  parse: parseJestJson,
};

/** Same parser under the vitest family — Vitest emits the Jest report shape. */
export const vitestAdapter: RunnerAdapter = {
  family: 'vitest',
  parse: parseJestJson,
};
