import { describe, expect, it } from 'vitest';

import type { ChangedFile } from '../../src/core/types.js';
import {
  findFocusMarkers,
  findSkipMarkers,
  FOCUS_MARKERS,
  SKIP_MARKERS,
} from '../../src/core/diff/markers.js';

/** Wrap one or more source lines as a patch that ADDS them to `path`. */
function addsLines(path: string, ...lines: string[]): ChangedFile {
  return {
    path,
    status: 'M',
    patch: ['@@ -1,1 +1,%d @@'.replace('%d', String(lines.length + 1)), ...lines.map((l) => `+${l}`)].join(
      '\n',
    ),
  };
}

describe('findSkipMarkers', () => {
  it.each([
    ['@pytest.mark.skip', '@pytest.mark.skip(reason="flaky")'],
    ['@pytest.mark.skip', '@pytest.mark.skipif(sys.platform == "win32", reason="x")'],
    ['@pytest.mark.xfail', '@pytest.mark.xfail(strict=False)'],
    ['pytest.skip(', '    pytest.skip("no database")'],
    ['t.Skip(', '\tt.Skip("flaky on CI")'],
    ['t.Skipf(', '\tt.Skipf("unsupported on %s", runtime.GOOS)'],
    ['it.skip(', "  it.skip('logs in', async () => {"],
    ['test.skip(', "  test.skip('logs in', async () => {"],
    ['describe.skip(', "describe.skip('auth', () => {"],
    ['xit(', "  xit('logs in', () => {"],
    ['xdescribe(', "xdescribe('auth', () => {"],
    ['xtest(', "  xtest('logs in', () => {"],
    ['#[ignore]', '    #[ignore]'],
    ['#[ignore]', '    #[ignore = "needs network"]'],
    ['@Ignore', '    @Ignore("broken")'],
    ['@Disabled', '    @Disabled("broken")'],
  ])('reports %s', (marker, line) => {
    expect(findSkipMarkers(addsLines('tests/thing_test.py', line))).toEqual([
      { file: 'tests/thing_test.py', marker },
    ]);
  });

  it.each([
    'process.exit(1);', // contains "xit(" but is not the xit global
    'const total = benefit(x);', // contains "fit(" — a focus-marker near-miss
    '  unit.skip(thing);', // contains "it.skip(" but on another object
    '  mypytest.skip(x)', // contains "pytest.skip(" but on another module
    '\tbt.Skip("x")', // contains "t.Skip(" on a different receiver
    '  @IgnoreCase', // "@Ignore" without a word boundary
  ])('does not fire on %s', (line) => {
    expect(findSkipMarkers(addsLines('tests/thing_test.py', line))).toEqual([]);
    expect(findFocusMarkers(addsLines('tests/thing_test.py', line))).toEqual([]);
  });

  it('ignores markers that were already there or are being removed', () => {
    const file: ChangedFile = {
      path: 'tests/test_billing.py',
      status: 'M',
      patch: [
        '--- a/tests/test_billing.py',
        '+++ b/tests/test_billing.py',
        '@@ -1,4 +1,4 @@',
        ' @pytest.mark.xfail(reason="pre-existing")', // context: was already skipped at base
        '-@pytest.mark.skip(reason="old")', // removed: the PR is UN-skipping this one
        '+def test_refund():',
      ].join('\n'),
    };
    expect(findSkipMarkers(file)).toEqual([]);
  });

  it('reports a file with no patch as having no markers', () => {
    expect(findSkipMarkers({ path: 'tests/test_a.py', status: 'M' })).toEqual([]);
  });
});

describe('findFocusMarkers', () => {
  it.each([
    ['it.only(', "  it.only('logs in', async () => {"],
    ['test.only(', "  test.only('logs in', async () => {"],
    ['describe.only(', "describe.only('auth', () => {"],
    ['fit(', "  fit('logs in', () => {"],
    ['fdescribe(', "fdescribe('auth', () => {"],
    ['--only', '    "test": "vitest run --only auth"'],
  ])('reports %s', (marker, line) => {
    expect(findFocusMarkers(addsLines('src/auth/login.spec.ts', line))).toEqual([
      { file: 'src/auth/login.spec.ts', marker },
    ]);
  });

  it('deduplicates repeats of the same marker in one file', () => {
    const file = addsLines(
      'src/auth/login.spec.ts',
      "  it.only('a', () => {});",
      "  it.only('b', () => {});",
      "  it.only('c', () => {});",
    );
    expect(findFocusMarkers(file)).toEqual([{ file: 'src/auth/login.spec.ts', marker: 'it.only(' }]);
  });

  it('reports each distinct marker separately', () => {
    const file = addsLines(
      'src/auth/login.spec.ts',
      "describe.only('auth', () => {",
      "  it.only('logs in', () => {});",
    );
    expect(findFocusMarkers(file)).toEqual([
      { file: 'src/auth/login.spec.ts', marker: 'it.only(' },
      { file: 'src/auth/login.spec.ts', marker: 'describe.only(' },
    ]);
  });
});

describe('marker tables', () => {
  it('cover every marker the spec names, with no duplicates', () => {
    const skip = SKIP_MARKERS.map((m) => m.marker);
    const focus = FOCUS_MARKERS.map((m) => m.marker);
    expect(skip).toEqual([
      '@pytest.mark.skip',
      '@pytest.mark.xfail',
      'pytest.skip(',
      't.Skip(',
      't.Skipf(',
      'it.skip(',
      'test.skip(',
      'describe.skip(',
      'xit(',
      'xdescribe(',
      'xtest(',
      '#[ignore]',
      '@Ignore',
      '@Disabled',
    ]);
    expect(focus).toEqual([
      'it.only(',
      'test.only(',
      'describe.only(',
      'fit(',
      'fdescribe(',
      '--only',
    ]);
    expect(new Set([...skip, ...focus]).size).toBe(skip.length + focus.length);
  });

  it('uses stateless regexes so repeated scans agree', () => {
    // A stray `g` flag would make `.test()` alternate between true and false.
    for (const { pattern } of [...SKIP_MARKERS, ...FOCUS_MARKERS]) {
      expect(pattern.global).toBe(false);
    }
    const file = addsLines('src/a.spec.ts', "it.only('x', () => {});");
    expect(findFocusMarkers(file)).toEqual(findFocusMarkers(file));
  });
});
