/**
 * JUnit XML adapter — pytest (`--junitxml`, xunit1 family), cargo-nextest, and
 * generic JUnit producers.
 *
 * Identity is `classname::name`, except that pytest also emits a `file`
 * attribute; when present we prefer `file::name` so the id matches the pytest
 * node id an agent would quote in a PR body (`tests/test_auth.py::test_login`).
 *
 * nextest records retries as extra children of the same `<testcase>`:
 * `<rerunFailure>` for an attempt that failed again and `<flakyFailure>` for one
 * that failed then passed. Each is one extra invocation, which is how the gate
 * detects a green result that only happened on the third try.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ExecutedTest, ObservedRun, RunnerAdapter } from '../../types.js';
import { compareById, countTotals } from './go.js';

/** Tags that may legitimately repeat and must always parse to an array. */
const ARRAY_TAGS = new Set([
  'testsuite',
  'testcase',
  'failure',
  'error',
  'skipped',
  'rerunFailure',
  'flakyFailure',
  'rerunError',
  'flakyError',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName: string) => ARRAY_TAGS.has(tagName),
});

type XmlNode = Record<string, unknown>;

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every `<testcase>` in the document, at any nesting depth. */
function collectTestcases(node: unknown, out: XmlNode[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTestcases(item, out);
    return;
  }
  if (!isNode(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'testcase') {
      if (Array.isArray(value)) {
        for (const testcase of value) if (isNode(testcase)) out.push(testcase);
      } else if (isNode(value)) {
        out.push(value);
      }
      continue;
    }
    if (key.startsWith('@_') || key === '#text') continue;
    collectTestcases(value, out);
  }
}

function attr(node: XmlNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** How many children of this tag the testcase has (0 when the tag is absent). */
function childCount(node: XmlNode, tag: string): number {
  const value = node[tag];
  if (value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  return 1;
}

export function parseJUnitXml(raw: string): {
  tests: ExecutedTest[];
  totals: ObservedRun['totals'];
} {
  if (raw.trim() === '') return { tests: [], totals: countTotals([]) };

  const document: unknown = parser.parse(raw);
  const testcases: XmlNode[] = [];
  collectTestcases(document, testcases);

  const tests: ExecutedTest[] = [];
  for (const testcase of testcases) {
    const name = attr(testcase, 'name');
    if (name === undefined) continue;
    const classname = attr(testcase, 'classname');
    const file = attr(testcase, 'file');
    // pytest carries the source file; its node id is what humans and agents quote.
    const id = file !== undefined ? `${file}::${name}` : `${classname ?? ''}::${name}`;

    const failures = childCount(testcase, 'failure') + childCount(testcase, 'error');
    const skipped = childCount(testcase, 'skipped');
    const test: ExecutedTest = {
      id,
      status: failures > 0 ? 'failed' : skipped > 0 ? 'skipped' : 'passed',
    };

    if (file !== undefined) test.file = file;

    const time = attr(testcase, 'time');
    if (time !== undefined) {
      const seconds = Number.parseFloat(time);
      if (Number.isFinite(seconds)) test.durationMs = seconds * 1000;
    }

    const reruns =
      childCount(testcase, 'rerunFailure') +
      childCount(testcase, 'flakyFailure') +
      childCount(testcase, 'rerunError') +
      childCount(testcase, 'flakyError');
    if (reruns > 0) test.invocations = reruns + 1;

    tests.push(test);
  }

  tests.sort(compareById);
  return { tests, totals: countTotals(tests) };
}

export const junitAdapter: RunnerAdapter = {
  family: 'junit',
  parse: parseJUnitXml,
};

/** Same parser, registered under the pytest family so `normalize('pytest', …)` works. */
export const pytestAdapter: RunnerAdapter = {
  family: 'pytest',
  parse: parseJUnitXml,
};
