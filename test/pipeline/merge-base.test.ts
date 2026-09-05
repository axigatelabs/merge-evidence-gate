/**
 * The diff is taken against the fork point, not the base branch's tip. A base
 * tip that moved on carries changes this pull request never made; taken
 * two-dot against it, upstream additions read as the PR's deletions.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { WorkspacePackage } from '../../src/core/runners/index.js';
import type { PullRequestFacts } from '../../src/core/types.js';
import { changedFilesDetailed, packagesHoldingPaths } from '../../src/pipeline.js';

function write(dir: string, rel: string, contents: string): void {
  const target = join(dir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** main: base → (upstream adds a test file) → tip; branch from base: the PR removes nothing. */
function repoWhereMainMovedOn(): { dir: string; fork: string; tip: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'meg-mb-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  const fork = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', '-c', 'feature');
  write(dir, 'src/a.ts', 'export const a = 2;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'pr: change a');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  write(dir, 'src/upstream.test.ts', 'test("x", () => {});\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'upstream: add a test');
  const tip = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', head);
  return { dir, fork, tip, head };
}

const facts = (o: Partial<PullRequestFacts>): PullRequestFacts => ({
  repo: 'o/r', number: 1, headSha: '', baseSha: '', baseRef: 'main', headRef: 'feature', authorLogin: 'x', body: '', title: 't', commitMessages: [], ...o,
});

describe('changedFilesDetailed', () => {
  it('diffs against the merge base git finds, so the upstream test file is not "deleted"', async () => {
    const { dir, fork, tip, head } = repoWhereMainMovedOn();
    const notes: string[] = [];
    const change = await changedFilesDetailed(dir, facts({ baseSha: tip, headSha: head }), notes);
    expect(change.unreliable).toBe(false);
    expect(change.mergeBase).toBe(fork);
    expect(change.files.map((f) => `${f.status} ${f.path}`)).toEqual(['M src/a.ts']);
  });

  it('uses a merge base the caller supplies, without probing', async () => {
    const { dir, fork, tip, head } = repoWhereMainMovedOn();
    const change = await changedFilesDetailed(dir, facts({ baseSha: tip, headSha: head, mergeBaseSha: fork }), []);
    expect(change.mergeBase).toBe(fork);
    expect(change.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('marks a diff unreliable when no merge base can be found, and says so', async () => {
    const { dir, tip, head } = repoWhereMainMovedOn();
    // An unrelated root commit as "base": no common ancestor exists.
    const other = mkdtempSync(join(tmpdir(), 'meg-mb-other-'));
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.email', 'a@b.c'); git(other, 'config', 'user.name', 't'); git(other, 'config', 'commit.gpgsign', 'false');
    write(other, 'z.txt', 'z\n'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 'unrelated');
    const unrelated = git(other, 'rev-parse', 'HEAD');
    git(dir, 'fetch', '-q', other, unrelated);
    const notes: string[] = [];
    const change = await changedFilesDetailed(dir, facts({ baseSha: unrelated, headSha: head }), notes);
    expect(change.unreliable).toBe(true);
    expect(change.mergeBase).toBeUndefined();
    expect(change.files.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.includes('no merge base') && n.includes('fetch-depth: 0'))).toBe(true);
    void tip;
    rmSync(other, { recursive: true, force: true });
  });
});

describe('packagesHoldingPaths', () => {
  it('keeps only the packages where every claimed path exists, else all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meg-hold-'));
    mkdirSync(join(dir, 'apps/studio/components/x'), { recursive: true });
    mkdirSync(join(dir, 'packages/common'), { recursive: true });
    const packages: WorkspacePackage[] = [{ dir: 'apps/studio', files: {} }, { dir: 'packages/common', files: {} }];
    expect(packagesHoldingPaths(dir, packages, ['components/x']).map((p) => p.dir)).toEqual(['apps/studio']);
    expect(packagesHoldingPaths(dir, packages, ['./components/x/...']).map((p) => p.dir)).toEqual(['apps/studio']);
    expect(packagesHoldingPaths(dir, packages, ['nowhere']).map((p) => p.dir)).toEqual(['apps/studio', 'packages/common']);
    expect(packagesHoldingPaths(dir, packages, []).map((p) => p.dir)).toEqual(['apps/studio', 'packages/common']);
  });
});
