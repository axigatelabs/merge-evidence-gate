import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../../src/core/reconcile/index.js';
import type { ObservedRun, PullRequestFacts } from '../../src/core/types.js';
import { evaluate, findNestedReports, totalsOf, withoutInstallSteps } from '../../src/pipeline.js';

describe('findNestedReports (monorepo per-package reports)', () => {
  it('finds every report with the expected relative path below the root, skipping dependency trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'meg-nested-'));
    const rel = '.merge-evidence/vitest-results.json';
    for (const pkg of ['packages/core', 'packages/cli', 'apps/web']) {
      mkdirSync(join(root, pkg, '.merge-evidence'), { recursive: true });
      writeFileSync(join(root, pkg, rel), '{}');
    }
    // must be ignored: a dependency's copy and the root's own report
    mkdirSync(join(root, 'node_modules/dep/.merge-evidence'), { recursive: true });
    writeFileSync(join(root, 'node_modules/dep', rel), '{}');
    mkdirSync(join(root, '.merge-evidence'), { recursive: true });
    writeFileSync(join(root, rel), '{}');

    const found = findNestedReports(root, rel).map((p) => p.slice(root.length + 1));
    expect(found).toEqual(['apps/web/' + rel, 'packages/cli/' + rel, 'packages/core/' + rel]);
  });

  it('returns nothing when no package wrote a report', () => {
    const root = mkdtempSync(join(tmpdir(), 'meg-nested-empty-'));
    mkdirSync(join(root, 'packages/a'), { recursive: true });
    expect(findNestedReports(root, '.merge-evidence/jest-results.json')).toEqual([]);
  });
});

describe('withoutInstallSteps', () => {
  it('drops package-manager installs from a claimed chain and keeps the rest in order', () => {
    expect(withoutInstallSteps('pnpm install && pnpm test')).toBe('pnpm test');
    expect(withoutInstallSteps('npm ci; npm test -- --runInBand')).toBe('npm test -- --runInBand');
    // a leading `cd` is not an install step — the test must still run there
    expect(withoutInstallSteps('cd packages/core && pnpm i && pnpm test')).toBe('cd packages/core && pnpm test');
    expect(withoutInstallSteps('uv sync && pytest -q && go mod download')).toBe('pytest -q');
  });

  it('leaves a plain test command alone and returns an empty string when only installs remain', () => {
    expect(withoutInstallSteps('go test ./...')).toBe('go test ./...');
    expect(withoutInstallSteps('pnpm install')).toBe('');
    expect(withoutInstallSteps('npm ci && yarn install --immutable')).toBe('');
  });
});

describe('totalsOf', () => {
  it('counts statuses and retries the way the adapters do', () => {
    const tests: ObservedRun['tests'] = [
      { id: 'a::t1', status: 'passed' },
      { id: 'a::t2', status: 'failed' },
      { id: 'b::t3', status: 'skipped' },
      { id: 'b::t4', status: 'focused' },
      { id: 'c::t5', status: 'passed', invocations: 2 },
    ];
    expect(totalsOf(tests)).toEqual({ run: 5, passed: 2, failed: 1, skipped: 2, retried: 1 });
  });
});

describe('evaluate with preferClaimedCommand', () => {
  function tinyRepo(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'meg-claimed-'));
    // Detection would pick `npm test` (package.json); the body claims `make test`.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tiny', scripts: { test: 'echo default-suite' } }));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
        .toString()
        .trim();
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    return { dir, head: git('rev-parse', 'HEAD') };
  }

  function facts(dir: string, head: string, body: string): PullRequestFacts {
    return {
      repo: 'o/r',
      number: 1,
      headSha: head,
      baseSha: '',
      baseRef: 'main',
      headRef: 'devin/1-x',
      authorLogin: 'devin-ai-integration[bot]',
      body,
      title: 't',
      commitMessages: [],
    };
  }

  it('runs the command the PR body claimed instead of the detected default', async () => {
    const { dir, head } = tinyRepo();
    const body = '## Testing\n\nRan `make test` — all green.\n';
    const preferred = await evaluate({
      workDir: dir,
      pr: facts(dir, head, body),
      policy: { ...DEFAULT_POLICY },
      skipInstall: true,
      preferClaimedCommand: true,
    });
    expect(preferred.receipt?.observed.command).toBe('make test');
    expect(preferred.notes.some((n) => n.includes('running the command the PR claimed'))).toBe(true);

    const detected = await evaluate({
      workDir: dir,
      pr: facts(dir, head, body),
      policy: { ...DEFAULT_POLICY },
      skipInstall: true,
    });
    expect(detected.receipt?.observed.command.startsWith('npm test')).toBe(true);
  });
});
