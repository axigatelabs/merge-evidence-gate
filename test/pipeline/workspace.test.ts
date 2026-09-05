/**
 * Workspace scoping end to end: a monorepo whose root has no test script, two
 * packages with their own vitest suites, a pull request touching one of them.
 * Only that package's tests run; the receipt carries its totals and the note
 * says which package ran. Dependencies are this repository's `node_modules`,
 * symlinked at the root, which vitest resolves by walking up.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/core/reconcile/index.js';
import type { ChangedFile, PullRequestFacts } from '../../src/core/types.js';
import { evaluate, workspacePackages, type EvaluateResult } from '../../src/pipeline.js';

const REPO_ROOT = process.cwd();
const E2E_TIMEOUT_MS = 240_000;

function write(dir: string, rel: string, contents: string): void {
  const target = join(dir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

const PKG = (name: string): string =>
  `${JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.2.4' } }, null, 2)}\n`;
const TEST = (name: string, n: number): string =>
  `import { describe, expect, it } from 'vitest';\ndescribe('${name}', () => {\n${Array.from({ length: n }, (_, i) => `  it('case ${i}', () => { expect(${i}).toBe(${i}); });`).join('\n')}\n});\n`;

/** Root has turbo-style scripts and no `test`; two packages each own a suite. */
function createWorkspace(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meg-workspace-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'agent@example.test');
  git(dir, 'config', 'user.name', 'Demo Agent');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, '.gitignore', 'node_modules/\n.merge-evidence/\n.merge-evidence.head/\n.merge-evidence.base/\n');
  write(dir, 'package.json', `${JSON.stringify({ name: 'root', private: true, scripts: { build: 'turbo run build', lint: 'turbo run lint' } }, null, 2)}\n`);
  write(dir, 'packages/a/package.json', PKG('a'));
  write(dir, 'packages/a/src/index.js', 'export const a = 1;\n');
  write(dir, 'packages/a/test/a.test.js', TEST('a', 2));
  write(dir, 'packages/b/package.json', PKG('b'));
  write(dir, 'packages/b/src/index.js', 'export const b = 1;\n');
  write(dir, 'packages/b/test/b.test.js', TEST('b', 3));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD') };
}

function touchPackageA(dir: string): string {
  write(dir, 'packages/a/src/index.js', 'export const a = 2;\n');
  write(dir, 'packages/a/test/a.test.js', TEST('a', 4));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'a: more cases');
  return git(dir, 'rev-parse', 'HEAD');
}

function facts(baseSha: string, headSha: string, body: string): PullRequestFacts {
  return { repo: 'example/mono', number: 3, headSha, baseSha, baseRef: 'main', headRef: 'claude/a', authorLogin: 'demo-agent', body, title: 'a', commitMessages: [] };
}

async function evaluateOffline(options: Parameters<typeof evaluate>[0]): Promise<EvaluateResult> {
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VITEST') || key === 'NODE_OPTIONS' || key === 'NODE_V8_COVERAGE') {
      saved.set(key, value);
      delete process.env[key];
    }
  }
  try {
    return await evaluate(options);
  } finally {
    for (const [key, value] of saved) process.env[key] = value;
  }
}

describe('workspacePackages', () => {
  it('maps changed paths to their nearest package directory, most-changed first, never the root', () => {
    const { dir } = createWorkspace();
    const changed: ChangedFile[] = [
      { path: 'packages/b/src/index.js', status: 'M' },
      { path: 'packages/a/src/index.js', status: 'M' },
      { path: 'packages/a/test/a.test.js', status: 'M' },
      { path: 'package.json', status: 'M' },
      { path: 'README.md', status: 'A' },
      { path: 'packages/gone/index.js', status: 'D' },
    ];
    const found = workspacePackages(dir, changed);
    expect(found.map((p) => p.dir)).toEqual(['packages/a', 'packages/b']);
    expect(found[0]?.files['package.json']).toContain('"name": "a"');
  });
});

describe('evaluate in a workspace whose root has no test command', () => {
  it(
    "runs only the touched package's suite and says so on the receipt",
    async () => {
      const { dir, baseSha } = createWorkspace();
      const headSha = touchPackageA(dir);
      const result = await evaluateOffline({
        workDir: dir,
        pr: facts(baseSha, headSha, '## Test plan\n\n- [x] `npm test` — 4 tests, 0 failures\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'),
        policy: { ...DEFAULT_POLICY },
      });
      expect(result.receipt?.observed.no_test_command).toBeUndefined();
      expect(result.receipt?.observed.totals).toMatchObject({ run: 4, passed: 4, failed: 0 });
      expect(result.receipt?.observed.command).toContain("(cd 'packages/a' &&");
      expect(result.receipt?.observed.command).not.toContain("'packages/b'");
      expect(result.notes.some((n) => n.includes('running the test script of 1 workspace package(s) this PR touches: packages/a'))).toBe(true);
      expect(result.discrepancies.map((d) => d.check)).not.toContain('C2');
      expect(result.verdict).toBe('PASS');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'runs a claimed bare `vitest` inside the touched package instead of at the root',
    async () => {
      const { dir, baseSha } = createWorkspace();
      const headSha = touchPackageA(dir);
      const result = await evaluateOffline({
        workDir: dir,
        pr: facts(baseSha, headSha, 'Ran `vitest` in the package.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'),
        policy: { ...DEFAULT_POLICY },
        preferClaimedCommand: true,
      });
      expect(result.receipt?.observed.command).toContain("(cd 'packages/a' && export PATH=\"$PWD/node_modules/.bin:$PATH\" && mkdir -p .merge-evidence && vitest --reporter=json");
      expect(result.receipt?.observed.totals.run).toBe(4);
      expect(result.notes.some((n) => n.includes('running the claimed command in 1 workspace package(s)'))).toBe(true);
      expect(result.verdict).toBe('PASS');
    },
    E2E_TIMEOUT_MS,
  );
});
