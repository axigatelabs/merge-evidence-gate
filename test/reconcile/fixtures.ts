/**
 * Builders for the three inputs the reconciler consumes. Each returns a fully
 * populated, "clean" value that a test narrows with overrides, so a test body
 * shows only the fact it is about.
 */

import type {
  AgentDetection,
  Claim,
  DiffAnalysis,
  ExecutedTest,
  ObservedRun,
  PullRequestFacts,
} from '../../src/core/types.js';

export function pr(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    repo: 'owner/name',
    number: 341,
    headSha: '3f2a1c9d4e5f60718293a4b5c6d7e8f901234567',
    baseSha: '9b0e7d2c1a3b4c5d6e7f8091a2b3c4d5e6f70819',
    baseRef: 'main',
    headRef: 'copilot/fix-prune',
    authorLogin: 'copilot-swe-agent[bot]',
    body: 'Fixes the prune path.',
    title: 'Fix prune',
    commitMessages: [],
    ...overrides,
  };
}

export function agent(overrides: Partial<AgentDetection> = {}): AgentDetection {
  return {
    detected: 'copilot',
    signals: ['login', 'branch-prefix'],
    isAgent: true,
    ...overrides,
  };
}

export function test(id: string, status: ExecutedTest['status'] = 'passed'): ExecutedTest {
  return { id, status };
}

export function observed(overrides: Partial<ObservedRun> = {}): ObservedRun {
  const tests = overrides.tests ?? [
    test('pkg/node/TestPrune'),
    test('pkg/node/TestGraft'),
    test('pkg/tree/TestWalk'),
  ];
  const totals = overrides.totals ?? {
    run: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    skipped: tests.filter((t) => t.status === 'skipped').length,
    retried: 0,
  };
  const base: ObservedRun = {
    command: 'go test -json -count=1 ./...',
    runner: 'go',
    exitCode: 0,
    durationMs: 118_400,
    toolchain: { go: '1.25.1' },
    totals,
    tests,
  };
  return { ...base, ...overrides, tests, totals };
}

/** An observed run for a repository where no test command could be found. */
export function noTestCommandRun(): ObservedRun {
  return {
    command: '',
    runner: 'none',
    exitCode: 0,
    durationMs: 0,
    toolchain: {},
    totals: { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 },
    tests: [],
    noTestCommand: true,
  };
}

export function diff(overrides: Partial<DiffAnalysis> = {}): DiffAnalysis {
  return {
    testFiles: { added: [], modified: [], deleted: [], renamed: [] },
    skipMarkersAdded: [],
    focusMarkersAdded: [],
    verificationLayerEdits: [],
    dependencyFiles: [],
    snapshotFiles: [],
    sourceFiles: [],
    ...overrides,
  };
}

export function commandClaim(
  id: string,
  raw: string,
  parsed: Partial<Omit<Claim['parsed'], 'kind'>> & {
    runner?: 'go' | 'pytest' | 'jest' | 'vitest' | 'cargo' | 'junit' | 'make' | 'npm' | 'unknown';
    paths?: string[];
    nameFilters?: string[];
  } = {},
): Claim {
  return {
    id,
    kind: 'command',
    text: `\`${raw}\``,
    parsed: {
      kind: 'command',
      runner: parsed.runner ?? 'go',
      raw,
      paths: parsed.paths ?? [],
      nameFilters: parsed.nameFilters ?? [],
    },
    section: 'Test plan',
  };
}

export function countClaim(
  id: string,
  text: string,
  counts: { passed?: number; failed?: number; skipped?: number; total?: number },
): Claim {
  return {
    id,
    kind: 'count',
    text,
    parsed: { kind: 'count', ...counts },
    section: 'Test plan',
  };
}

export function checkboxClaim(id: string, label: string, checked = true): Claim {
  return {
    id,
    kind: 'checkbox',
    text: `- [${checked ? 'x' : ' '}] ${label}`,
    parsed: { kind: 'checkbox', checked, label },
  };
}
