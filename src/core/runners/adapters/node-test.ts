/**
 * Adapter for node's built-in test runner (`node --test`), through its `junit`
 * reporter.
 *
 * The shape is JUnit with two node-specific habits: `describe` blocks become
 * nested `<testsuite>` elements while top-level tests sit directly under
 * `<testsuites>`, and every `<testcase>` carries `classname="test"` (a
 * constant) plus an absolute `file`. Identity is therefore built from the
 * file, made relative to the directory the tests ran in, and the suite path:
 * `test/math.test.js::add > adds two numbers`. A skipped or todo test is a
 * `<skipped>` child; a failure is a `<failure>` child.
 */
import { XMLParser } from 'fast-xml-parser';
import { isAbsolute, relative } from 'node:path';
import type { ExecutedTest, ObservedRun, ParseOptions, RunnerAdapter } from '../../types.js';
import { compareById, countTotals } from './go.js';

const ARRAY_TAGS = new Set(['testsuite', 'testcase', 'failure', 'error', 'skipped']);

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

function attr(node: XmlNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function childCount(node: XmlNode, tag: string): number {
  const value = node[tag];
  if (value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}

/** Forward slashes everywhere, so an id is the same on Windows runners. */
function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

function relativeFile(file: string, cwd: string | undefined): string {
  if (cwd === undefined || !isAbsolute(file)) return posix(file);
  const rel = relative(cwd, file);
  return rel === '' || rel.startsWith('..') ? posix(file) : posix(rel);
}

/** Walk suites depth-first, carrying the suite names down to each testcase. */
function walk(node: XmlNode, suites: string[], cwd: string | undefined, out: ExecutedTest[]): void {
  const cases = node['testcase'];
  if (Array.isArray(cases)) {
    for (const testcase of cases) {
      if (!isNode(testcase)) continue;
      const name = attr(testcase, 'name');
      if (name === undefined) continue;
      const file = attr(testcase, 'file');
      const path = [...suites, name].join(' > ');
      const rel = file === undefined ? undefined : relativeFile(file, cwd);
      const test: ExecutedTest = {
        id: rel === undefined ? path : `${rel}::${path}`,
        status:
          childCount(testcase, 'failure') + childCount(testcase, 'error') > 0
            ? 'failed'
            : childCount(testcase, 'skipped') > 0
              ? 'skipped'
              : 'passed',
      };
      if (rel !== undefined) test.file = rel;
      const time = attr(testcase, 'time');
      if (time !== undefined) {
        const seconds = Number.parseFloat(time);
        if (Number.isFinite(seconds)) test.durationMs = seconds * 1000;
      }
      out.push(test);
    }
  }
  const nested = node['testsuite'];
  if (Array.isArray(nested)) {
    for (const suite of nested) {
      if (!isNode(suite)) continue;
      const name = attr(suite, 'name');
      walk(suite, name === undefined ? suites : [...suites, name], cwd, out);
    }
  }
}

export function parseNodeTestJUnit(
  raw: string,
  options: ParseOptions = {},
): { tests: ExecutedTest[]; totals: ObservedRun['totals'] } {
  if (raw.trim() === '') return { tests: [], totals: countTotals([]) };
  const document: unknown = parser.parse(raw);
  const tests: ExecutedTest[] = [];
  if (isNode(document)) {
    const root = document['testsuites'];
    if (Array.isArray(root)) {
      for (const item of root) if (isNode(item)) walk(item, [], options.cwd, tests);
    } else if (isNode(root)) {
      walk(root, [], options.cwd, tests);
    } else {
      // A bare <testsuite> root, or a document with no wrapper at all.
      walk(document, [], options.cwd, tests);
    }
  }
  tests.sort(compareById);
  return { tests, totals: countTotals(tests) };
}

export const nodeTestAdapter: RunnerAdapter = {
  family: 'node-test',
  parse: parseNodeTestJUnit,
};
