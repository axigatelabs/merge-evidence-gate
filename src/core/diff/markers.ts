/**
 * Skip and focus marker detection over unified patches.
 *
 * A test that is skipped or focused stops protecting anything, so an agent can
 * turn a red suite green by adding one decorator. This module finds those
 * additions deterministically: it reads only the ADDED lines of a patch, so a
 * marker that already existed at base is never reported as new.
 *
 * Regex conventions: no `g` flag (stateless `.test()`), and every pattern is
 * anchored against an identifier boundary so `process.exit(` is not read as
 * `xit(` and `benefit(` is not read as `fit(`.
 */
import type { ChangedFile } from '../types.js';
import { addedLines } from './classify.js';

/** One marker occurrence: which file gained it, and which marker it was. */
export interface MarkerHit {
  file: string;
  marker: string;
}

/** A marker's canonical name plus the pattern that recognises it in a line of code. */
export interface MarkerPattern {
  /** Reported verbatim as `MarkerHit.marker`; stable enough to appear in a receipt. */
  marker: string;
  pattern: RegExp;
}

/**
 * Two lookbehind shapes recur below. `(?<![\w$])` guards a dotted call such as
 * `it.skip(` so it does not fire inside `unit.skip(`. `(?<![\w$.])` guards a
 * bare global such as `xit(` so it fires neither inside `process.exit(` nor on
 * `foo.xit(`, where `xit` is somebody's method rather than the test global.
 */
export const SKIP_MARKERS: readonly MarkerPattern[] = [
  // pytest: `@pytest.mark.skip` and `@pytest.mark.skipif(sys.platform == "win32")`.
  { marker: '@pytest.mark.skip', pattern: /@pytest\.mark\.skip/ },
  // pytest: `@pytest.mark.xfail(reason="flaky")` — an expected failure still stops protecting.
  { marker: '@pytest.mark.xfail', pattern: /@pytest\.mark\.xfail/ },
  // pytest: imperative `pytest.skip("no fixture")`; rejects `mypytest.skip(`.
  { marker: 'pytest.skip(', pattern: /(?<![\w.])pytest\.skip\(/ },
  // Go: `t.Skip("flaky on CI")`; the boundary rejects `bt.Skip(`.
  { marker: 't.Skip(', pattern: /\bt\.Skip\(/ },
  // Go: `t.Skipf("unsupported on %s", runtime.GOOS)`.
  { marker: 't.Skipf(', pattern: /\bt\.Skipf\(/ },
  // Jest/Vitest/Mocha: `it.skip('logs in', …)`; rejects `unit.skip(`.
  { marker: 'it.skip(', pattern: /(?<![\w$])it\.skip\(/ },
  // Jest/Vitest: `test.skip('logs in', …)`.
  { marker: 'test.skip(', pattern: /(?<![\w$])test\.skip\(/ },
  // Jest/Vitest/Mocha: `describe.skip('auth', …)` — skips the whole block.
  { marker: 'describe.skip(', pattern: /(?<![\w$])describe\.skip\(/ },
  // Jasmine/Jest shorthand: `xit('logs in', …)`; rejects `process.exit(` and `explicit(`.
  { marker: 'xit(', pattern: /(?<![\w$.])xit\(/ },
  // Jasmine/Jest shorthand: `xdescribe('auth', …)`.
  { marker: 'xdescribe(', pattern: /(?<![\w$.])xdescribe\(/ },
  // Jest shorthand: `xtest('logs in', …)`.
  { marker: 'xtest(', pattern: /(?<![\w$.])xtest\(/ },
  // Rust: `#[ignore]` and `#[ignore = "needs network"]`.
  { marker: '#[ignore]', pattern: /#\[\s*ignore\b/ },
  // JUnit 4: `@Ignore("broken")`; `\b` rejects `@IgnoreMe`.
  { marker: '@Ignore', pattern: /@Ignore\b/ },
  // JUnit 5: `@Disabled("broken")`.
  { marker: '@Disabled', pattern: /@Disabled\b/ },
];

/**
 * Focus markers narrow a run to one test, silently skipping every other test in
 * the file (or the whole suite). Committing one is almost always accidental —
 * and it hides failures exactly like a skip does.
 */
export const FOCUS_MARKERS: readonly MarkerPattern[] = [
  // Jest/Vitest/Mocha: `it.only('logs in', …)`; rejects `unit.only(`.
  { marker: 'it.only(', pattern: /(?<![\w$])it\.only\(/ },
  // Jest/Vitest: `test.only('logs in', …)`.
  { marker: 'test.only(', pattern: /(?<![\w$])test\.only\(/ },
  // Jest/Vitest/Mocha: `describe.only('auth', …)` — the rest of the suite stops running.
  { marker: 'describe.only(', pattern: /(?<![\w$])describe\.only\(/ },
  // Jasmine/Jest shorthand: `fit('logs in', …)`; rejects `benefit(` and `profit(`.
  { marker: 'fit(', pattern: /(?<![\w$.])fit\(/ },
  // Jasmine/Jest shorthand: `fdescribe('auth', …)`.
  { marker: 'fdescribe(', pattern: /(?<![\w$.])fdescribe\(/ },
  // Runner flag committed into a script or config: `cargo test -- --only foo`.
  { marker: '--only', pattern: /--only\b/ },
];

/**
 * Every distinct marker from `patterns` that appears on a line this patch adds.
 *
 * Hits are deduplicated per (file, marker): three added `it.only(` calls in one
 * spec are one fact for a reviewer, and the receipt's evidence lists are path
 * lists, so repeating the pair adds noise without adding information.
 */
function scan(file: ChangedFile, patterns: readonly MarkerPattern[]): MarkerHit[] {
  const lines = addedLines(file.patch);
  if (lines.length === 0) return [];
  const hits: MarkerHit[] = [];
  for (const { marker, pattern } of patterns) {
    if (lines.some((line) => pattern.test(line))) {
      hits.push({ file: file.path, marker });
    }
  }
  return hits;
}

/** Skip/xfail/ignore markers this patch ADDS to the given file. */
export function findSkipMarkers(file: ChangedFile): MarkerHit[] {
  return scan(file, SKIP_MARKERS);
}

/** Focus (`.only`) markers this patch ADDS to the given file. */
export function findFocusMarkers(file: ChangedFile): MarkerHit[] {
  return scan(file, FOCUS_MARKERS);
}
