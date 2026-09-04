/**
 * `go test -json` adapter.
 *
 * The stream is one JSON object per line (test2json), each carrying
 * `{ Time, Action, Package, Test?, Elapsed?, FailedBuild? }` where Action is one
 * of start|run|pause|cont|pass|bench|fail|output|skip. Lines that are not JSON
 * are ignored, so the adapter also survives a wrapper (`make test`) that prints
 * its own output around the stream.
 *
 * Identity is `Package + "/" + Test`; subtests keep their `/` separator, so
 * `pkg/node` running `TestPrune/empty` yields `pkg/node/TestPrune/empty`.
 */
import type { ExecutedTest, ObservedRun, RunnerAdapter, TestStatus } from '../../types.js';

interface GoEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Elapsed?: number;
  FailedBuild?: string;
}

/** Suffix used for the synthetic test id recorded when a package fails to build. */
export const BUILD_FAILURE_SUFFIX = '<build>';

interface Accumulated {
  status: TestStatus | undefined;
  durationMs: number | undefined;
  /** Terminal events seen for this id; >1 means `-count=N` or a rerun. */
  results: number;
  /** True once a `run` event has been seen, even if no result ever arrives. */
  started: boolean;
}

function parseEvent(line: string): GoEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) return parsed as GoEvent;
  } catch {
    // Not a test2json line (interleaved build output, a wrapper's logging, …).
  }
  return undefined;
}

export function parseGoTestJson(raw: string): {
  tests: ExecutedTest[];
  totals: ObservedRun['totals'];
} {
  const byId = new Map<string, Accumulated>();

  const touch = (id: string): Accumulated => {
    let entry = byId.get(id);
    if (entry === undefined) {
      entry = { status: undefined, durationMs: undefined, results: 0, started: false };
      byId.set(id, entry);
    }
    return entry;
  };

  for (const line of raw.split(/\r?\n/)) {
    const event = parseEvent(line);
    if (event === undefined) continue;

    const action = event.Action;
    // `output` carries only human-readable text; the structured actions say what happened.
    if (action === undefined || action === 'output') continue;

    const pkg = event.Package;
    if (pkg === undefined || pkg === '') continue;

    if (event.Test === undefined || event.Test === '') {
      // Package-level event. Only a build failure is per-package evidence: the
      // package's tests never ran, so record the build itself as a failure.
      if (action === 'fail' && typeof event.FailedBuild === 'string' && event.FailedBuild !== '') {
        const entry = touch(`${pkg}/${BUILD_FAILURE_SUFFIX}`);
        entry.status = 'failed';
        entry.results += 1;
      }
      continue;
    }

    const id = `${pkg}/${event.Test}`;
    const entry = touch(id);

    switch (action) {
      case 'run':
      case 'start':
      case 'pause':
      case 'cont':
        entry.started = true;
        break;
      case 'pass':
      case 'bench':
        entry.status = 'passed';
        entry.results += 1;
        if (typeof event.Elapsed === 'number') entry.durationMs = event.Elapsed * 1000;
        break;
      case 'fail':
        entry.status = 'failed';
        entry.results += 1;
        if (typeof event.Elapsed === 'number') entry.durationMs = event.Elapsed * 1000;
        break;
      case 'skip':
        entry.status = 'skipped';
        entry.results += 1;
        if (typeof event.Elapsed === 'number') entry.durationMs = event.Elapsed * 1000;
        break;
      default:
        break;
    }
  }

  const tests: ExecutedTest[] = [];
  for (const [id, entry] of byId) {
    // A test that started but never reported a result means the process died
    // mid-run (panic, timeout, OOM). That is a failure, not an absence.
    const status: TestStatus | undefined = entry.status ?? (entry.started ? 'failed' : undefined);
    if (status === undefined) continue;
    const test: ExecutedTest = { id, status };
    if (entry.durationMs !== undefined) test.durationMs = entry.durationMs;
    if (entry.results > 1) test.invocations = entry.results;
    tests.push(test);
  }

  tests.sort(compareById);
  return { tests, totals: countTotals(tests) };
}

/** Byte-order comparison — locale-independent so the digest is reproducible. */
export function compareById(a: ExecutedTest, b: ExecutedTest): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function countTotals(tests: ExecutedTest[]): ObservedRun['totals'] {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let retried = 0;
  for (const test of tests) {
    if (test.status === 'passed') passed += 1;
    else if (test.status === 'failed') failed += 1;
    else if (test.status === 'skipped') skipped += 1;
    if (test.invocations !== undefined && test.invocations > 1) retried += 1;
  }
  return { run: tests.length, passed, failed, skipped, retried };
}

export const goAdapter: RunnerAdapter = {
  family: 'go',
  parse: parseGoTestJson,
};
