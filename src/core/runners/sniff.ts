/**
 * Recognise a test report by its content, for the mode where the gate reads
 * the report the repository's own test step wrote instead of running anything.
 * Pure: a function of the text.
 */
import type { RunnerFamily } from '../types.js';

/** Formats an operator may name; `auto` means sniff. */
export const REPORT_FORMATS = ['auto', 'go', 'pytest', 'jest', 'vitest', 'node-test', 'junit'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

/** The runner family that parses a named format. */
export function formatFamily(format: Exclude<ReportFormat, 'auto'>): RunnerFamily {
  return format;
}

/**
 * The family whose adapter reads `raw`, or undefined when it is none the gate
 * knows. `hint` is the repository's detected runner: it breaks the ties a
 * format cannot — Vitest writes Jest's JSON shape, pytest writes plain JUnit.
 */
export function sniffReportFormat(raw: string, hint?: RunnerFamily): RunnerFamily | undefined {
  const text = raw.trimStart();
  if (text === '') return undefined;

  if (text.startsWith('<')) {
    if (!/<testsuites?[\s>]/.test(text)) return undefined;
    // node's junit reporter: every testcase says classname="test" and carries the file.
    const classnames = text.match(/classname="[^"]*"/g) ?? [];
    if (classnames.length > 0 && classnames.every((c) => c === 'classname="test"') && /<testcase [^>]*file="/.test(text)) {
      return 'node-test';
    }
    return hint === 'pytest' || hint === 'junit' ? hint : 'junit';
  }

  if (text.startsWith('{')) {
    // go test -json is one object per line, each with an Action; jest/vitest is one document.
    const firstLine = text.split('\n', 1)[0] ?? '';
    if (/"Action"\s*:/.test(firstLine) && /"Time"\s*:|"Package"\s*:/.test(firstLine)) return 'go';
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { testResults?: unknown }).testResults)) {
        return hint === 'vitest' ? 'vitest' : 'jest';
      }
    } catch {
      // not one JSON document; fall through
    }
    return undefined;
  }
  return undefined;
}
