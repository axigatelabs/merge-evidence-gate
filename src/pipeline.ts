/**
 * The Merge-Evidence pipeline, with no GitHub in it.
 *
 * Everything between "here is a pull request and a checkout" and "here is a
 * receipt" lives here: read the policy, move the checkout to the head commit,
 * install from the lockfile, re-run the repository's own tests with a
 * machine-readable reporter, diff base against head, extract the claims from the
 * PR body, reconcile the three and render the comment.
 *
 * Two front-ends call `evaluate`: the GitHub Action (`src/main.ts`), which adds
 * the event wiring, outputs, annotations, artifact and sticky comment; and the
 * offline CLI (`src/cli.ts`), which takes the pull-request facts as arguments
 * and writes files. Because the second one runs on a laptop or inside a
 * network-less container, nothing in this module may import `@actions/github` or
 * `@actions/artifact` — `@actions/core` (whose `info` prints to stdout off a
 * runner) and `@actions/exec` are fine.
 *
 * The rules from the Action apply here too: the verdict is the only thing that
 * may fail a run, and a claim the gate could not verify is reported, never
 * counted against the PR.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import * as core from '@actions/core';
import * as exec from '@actions/exec';

import {
  parseNameStatus,
  probeToolchain,
  readManifests,
  readReport,
  readTextFile,
} from './action/env.js';
import { detectAgent, extractClaims } from './core/claims/index.js';
import { analyzeDiff } from './core/diff/index.js';
import {
  buildReceipt,
  DEFAULT_POLICY,
  parsePolicyYaml,
  reconcile,
  renderComment,
  type ParsedPolicy,
} from './core/reconcile/index.js';
import { hasNoEvidence } from './core/reconcile/reconcile.js';
import {
  adapters,
  detectTestCommand,
  detectWorkspaceCommand,
  normalize,
  REPORT_DIR,
  type DetectedCommand,
  type WorkspacePackage,
} from './core/runners/index.js';
import type {
  AgentDetection,
  BaselineRun,
  ChangedFile,
  DiffAnalysis,
  Discrepancy,
  ObservedRun,
  Policy,
  PullRequestFacts,
  Receipt,
  RenderedComment,
  Verdict,
} from './core/types.js';

/** Where the raw combined stdout/stderr of the test run is kept. */
export const RUN_LOG = `${REPORT_DIR}/run.log`;

export const EMPTY_TOTALS: ObservedRun['totals'] = {
  run: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  retried: 0,
};

// ---------------------------------------------------------------------------
// Small process helpers
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** Exit status; 128 + signal number when the process died by signal. */
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process died by signal rather than exiting (`SIGKILL`, `SIGTERM`, or `unknown`). */
  signal?: string;
}

/** Signal names by the exit status a POSIX shell reports for a child killed by that signal. */
const SIGNAL_BY_EXIT: ReadonlyMap<number, string> = new Map([
  [129, 'SIGHUP'],
  [130, 'SIGINT'],
  [131, 'SIGQUIT'],
  [132, 'SIGILL'],
  [134, 'SIGABRT'],
  [135, 'SIGBUS'],
  [136, 'SIGFPE'],
  [137, 'SIGKILL'],
  [139, 'SIGSEGV'],
  [143, 'SIGTERM'],
]);

/**
 * The notice a shell prints when a child dies by signal — bash's
 * `bash: line 1:  1234 Killed  pnpm test`, sh's bare `Killed` — mapped to the
 * signal. Only consulted when the exit status already says 128 + n, so a test
 * that merely prints "Killed" on a normal exit is never mistaken for a kill.
 */
const SHELL_SIGNAL_NOTICE =
  /(?:^|\n)(?:[^\n:]*:\s*)?(?:line \d+:\s*)?(?:\d+\s+)?(Killed|Terminated|Segmentation fault|Aborted|Hangup|Illegal instruction|Bus error|Floating point exception)(?:\s|$)/;
const SIGNAL_BY_NOTICE: ReadonlyMap<string, string> = new Map([
  ['Killed', 'SIGKILL'],
  ['Terminated', 'SIGTERM'],
  ['Segmentation fault', 'SIGSEGV'],
  ['Aborted', 'SIGABRT'],
  ['Hangup', 'SIGHUP'],
  ['Illegal instruction', 'SIGILL'],
  ['Bus error', 'SIGBUS'],
  ['Floating point exception', 'SIGFPE'],
]);

/**
 * The signal a test run died by, when the evidence says it did: the process
 * itself was signalled (no exit status at all), or the shell reported 128 + n
 * AND printed its kill notice. A bare 128 + n with no notice is left alone —
 * mocha exits with its failure count, so 130 there is 130 failures.
 */
export function signalOf(result: CommandResult): string | undefined {
  if (result.signal !== undefined) return result.signal;
  if (result.code < 128) return undefined;
  const notice = SHELL_SIGNAL_NOTICE.exec(result.stderr)?.[1];
  if (notice === undefined) return undefined;
  return SIGNAL_BY_NOTICE.get(notice) ?? SIGNAL_BY_EXIT.get(result.code) ?? 'unknown';
}

/** Environment for the test run: the runner's own, plus the reporter overlay. */
export function mergedEnv(overlay: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overlay };
}

/**
 * PATH for a run inside `workDir`: the checkout's `node_modules/.bin` first,
 * when it exists. A claimed bare `vitest` or `jest` is how developers write
 * the command; it resolves only because npm, pnpm or npx put that directory
 * on PATH, and the gate runs commands through bash directly.
 */
export function pathWithBin(workDir: string, base: string | undefined = process.env['PATH']): string {
  const bin = join(workDir, 'node_modules', '.bin');
  const current = base ?? '';
  if (!existsSync(bin)) return current;
  const parts = current.split(':').filter((p) => p !== '');
  return [bin, ...parts.filter((p) => p !== bin)].join(':');
}

/**
 * Run `commandLine` and capture both streams. Never rejects: a command that
 * cannot even be spawned comes back as code 127 with the reason on stderr, so
 * every caller handles one shape.
 */
export async function execCapture(
  commandLine: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; silent?: boolean },
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  try {
    // @actions/exec types the result as a number, but a process that dies by
    // signal has no exit status: Node reports null and the value comes through
    // as-is. Record it as "killed by a signal we could not name" rather than
    // letting `null` reach the receipt.
    const code = (await exec.exec(commandLine, args, {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      ignoreReturnCode: true,
      silent: options.silent ?? false,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
        stderr: (data: Buffer) => {
          stderr += data.toString();
        },
      },
    })) as number | null;
    if (code === null || code === undefined) return { code: 128, stdout, stderr, signal: 'unknown' };
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout, stderr: `${stderr}${err instanceof Error ? err.message : String(err)}` };
  }
}

/** `git …` in `cwd`, quietly — git chatter is noise unless something failed. */
export async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
  return execCapture('git', args, { cwd, silent: true });
}

/**
 * Run a shell command line the way the repository's own CI would.
 *
 * Detected commands are shell text (`npm test -- --reporter=json`,
 * `make test`, occasionally with `&&`), so they go through a shell rather than
 * `exec`'s argv splitter, which does not understand operators.
 */
export async function shell(
  commandLine: string,
  options: { cwd: string; env: Record<string, string> },
): Promise<CommandResult> {
  if (process.platform === 'win32') {
    return execCapture('pwsh', ['-NoProfile', '-Command', commandLine], options);
  }
  // A trailing `exit "$rc"` keeps bash as the parent instead of exec-ing a
  // single simple command: bash then reports 128 + n and prints its kill
  // notice when the runner dies by signal, which is how a kill is told apart
  // from a runner that exits with a large status of its own.
  return execCapture('bash', ['-c', `${commandLine}\nrc=$?; exit "$rc"`], options);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The repository's policy file, or the built-in defaults.
 *
 * The path is tried inside `working-directory` first and then at the workspace
 * root, so a monorepo that gates one package can keep its policy next to that
 * package or at the top — whichever it already does.
 */
export function loadPolicy(workDir: string, policyFile: string): ParsedPolicy {
  const candidates = isAbsolute(policyFile)
    ? [policyFile]
    : [...new Set([resolve(workDir, policyFile), resolve(process.cwd(), policyFile)])];
  for (const candidate of candidates) {
    const text = readTextFile(candidate);
    if (text === undefined) continue;
    try {
      const parsed = parsePolicyYaml(text);
      core.info(`policy: ${candidate} (version ${parsed.version})`);
      return parsed;
    } catch (err) {
      core.warning(
        `policy: could not parse ${candidate} (${err instanceof Error ? err.message : String(err)}) — using defaults`,
      );
      return { ...DEFAULT_POLICY };
    }
  }
  core.info(`policy: no ${policyFile} found — using built-in defaults`);
  return { ...DEFAULT_POLICY };
}

// ---------------------------------------------------------------------------
// Clean re-run
// ---------------------------------------------------------------------------

/**
 * Make sure we are testing the commit the receipt will name.
 *
 * `actions/checkout` normally leaves the workspace on a merge commit or on the
 * head sha already; when it does not, moving there is best-effort and any
 * failure is recorded rather than raised — the receipt then says which commit
 * actually ran.
 */
export async function ensureHeadCheckout(workDir: string, headSha: string, notes: string[]): Promise<void> {
  const current = (await git(workDir, 'rev-parse', 'HEAD')).stdout.trim();
  if (current === headSha) return;
  core.info(`checkout is at ${current.slice(0, 7)}, moving to head ${headSha.slice(0, 7)}`);
  await git(workDir, 'fetch', '--no-tags', 'origin', headSha);
  const checkout = await git(workDir, 'checkout', '--force', headSha);
  if (checkout.code !== 0) {
    const note = `checkout: could not move to head ${headSha.slice(0, 7)}; tests ran at ${current.slice(0, 7) || 'an unknown commit'}`;
    core.warning(note);
    notes.push(note);
    return;
  }
  core.info(`checkout: now at ${headSha.slice(0, 7)}`);
}

/** The frozen-install commands this checkout needs, in the order to run them. */
export function installPlan(
  workDir: string,
  files: Record<string, string | undefined>,
  options: { force?: boolean } = {},
): Array<{ command: string; frozen: boolean }> {
  const plan: Array<{ command: string; frozen: boolean }> = [];
  // `force` installs even when a dependency tree is already present — used when
  // the checkout moved to a commit whose manifests differ from the installed ones.
  const fresh = (dir: string): boolean => options.force === true || !existsSync(join(workDir, dir));

  if (files['package.json'] !== undefined && fresh('node_modules')) {
    if (files['pnpm-lock.yaml'] !== undefined) plan.push({ command: 'pnpm i --frozen-lockfile', frozen: true });
    else if (files['yarn.lock'] !== undefined) plan.push({ command: 'yarn install --immutable', frozen: true });
    else if (files['bun.lockb'] !== undefined) plan.push({ command: 'bun install --frozen-lockfile', frozen: true });
    else if (files['package-lock.json'] !== undefined) plan.push({ command: 'npm ci', frozen: true });
    // No lockfile: the install cannot be frozen, so it is recorded as such
    // rather than silently presented as a reproducible environment.
    else plan.push({ command: 'npm install --no-audit --no-fund', frozen: false });
  }

  if (files['go.mod'] !== undefined && fresh('vendor')) {
    plan.push({ command: 'go mod download', frozen: true });
  }

  if (files['uv.lock'] !== undefined) {
    // The lockfile pins every extra too; tests routinely import optional
    // dependencies (litellm's conftest imports `prisma` from the proxy extra),
    // so the frozen install takes all of them, as the repository's own CI does.
    plan.push({ command: 'uv sync --locked --all-extras', frozen: true });
  } else if (files['pyproject.toml'] !== undefined) {
    plan.push({ command: 'pip install -e .', frozen: false });
  }

  return plan;
}

/**
 * Install dependencies from the lockfile, best-effort.
 *
 * A failed install is evidence, not an error: the tests that follow may not be
 * running against the dependencies the PR declares, which is exactly the C5
 * territory the receipt exists to surface. So it is recorded and the run
 * continues — a partial answer beats no answer.
 */
export async function installDependencies(
  workDir: string,
  files: Record<string, string | undefined>,
  env: Record<string, string>,
  notes: string[],
  options: { force?: boolean } = {},
): Promise<void> {
  for (const step of installPlan(workDir, files, options)) {
    core.info(`install: ${step.command}`);
    const result = await shell(step.command, { cwd: workDir, env });
    if (result.code !== 0) {
      const note = `dependencies: \`${step.command}\` exited ${result.code}; the test run may not reflect a clean install`;
      core.warning(note);
      notes.push(note);
      continue;
    }
    if (!step.frozen) {
      const note = `dependencies: \`${step.command}\` is not a locked install (no lockfile present), so the environment is not reproducible`;
      core.warning(note);
      notes.push(note);
    }
  }
}

/** Turn the reporter's output into the executed test list, or degrade with a note. */
export function parseReport(
  detected: DetectedCommand,
  workDir: string,
  stdout: string,
  notes: string[],
): { tests: ObservedRun['tests']; totals: ObservedRun['totals']; reportMissing?: boolean } {
  if (detected.note !== undefined) {
    core.info(`runner: ${detected.note}`);
    notes.push(`runner: ${detected.note}`);
  }
  // An opaque family (plain cargo, make, an npm script hiding its runner) never
  // has per-test output; its exit code is still the evidence for C1.
  if (adapters[detected.family] === undefined) {
    return { tests: [], totals: EMPTY_TOTALS };
  }

  // Go streams its JSON events to stdout; every other supported runner writes a
  // report file. `runTests` has already teed stdout to `reportPath` for Go, so
  // the file is tried first either way and stdout is the fallback — for Go
  // ONLY. For a file-based runner, plain stdout is never a report: feeding the
  // console text to the adapter parses to zero tests silently, which reads
  // like "nothing ran" instead of "the reporter produced nothing".
  const raw =
    readReport(join(workDir, detected.reportPath)) ??
    (detected.family === 'go' && stdout.trim() !== '' ? stdout : undefined);
  if (raw !== undefined) {
    try {
      return normalize(detected.family, raw);
    } catch (err) {
      const note = `runner: could not parse ${detected.family} output (${err instanceof Error ? err.message : String(err)})`;
      core.warning(note);
      notes.push(note);
      return { tests: [], totals: EMPTY_TOTALS, reportMissing: true };
    }
  }

  // Monorepos: `pnpm test` at the root fans out to every workspace package, and
  // each package's runner writes the report relative to ITS directory. Gather
  // every report with the expected name below the work dir and merge them —
  // the executed set is the union, which is exactly what ran.
  const nested = findNestedReports(workDir, detected.reportPath);
  if (nested.length > 0) {
    const merged: ObservedRun['tests'] = [];
    let parsed = 0;
    for (const path of nested) {
      const text = readReport(path);
      if (text === undefined) continue;
      try {
        merged.push(...normalize(detected.family, text).tests);
        parsed++;
      } catch {
        // one unreadable package report must not hide the others
      }
    }
    if (parsed > 0) {
      const note = `runner: merged ${parsed} per-package report(s) found below the work dir (monorepo)`;
      core.info(note);
      notes.push(note);
      return { tests: merged, totals: totalsOf(merged) };
    }
  }

  // The reporter never wrote: killed, or crashed before the report. This is the
  // one case with no evidence at all — jest/vitest/pytest all write a report
  // even when the suite fails to load, and that report IS evidence.
  const note = `runner: no machine-readable output at ${detected.reportPath}; per-test evidence is unavailable`;
  core.warning(note);
  notes.push(note);
  return { tests: [], totals: EMPTY_TOTALS, reportMissing: true };
}

/**
 * A claimed command chain without its install steps.
 *
 * Agents write "`pnpm install && pnpm test`"; the gate has already done a
 * frozen install, so re-running one is redundant online and fatal offline
 * (pnpm would sit retrying against a dead network). Segments joined by `&&`
 * or `;` that are package-manager installs are dropped; the rest is kept in
 * order. Returns '' when nothing runnable remains.
 */
export function withoutInstallSteps(command: string): string {
  const install =
    /^(?:cd\s+\S+\s*&&\s*)?(?:(?:pnpm|npm|yarn|bun)\s+(?:i|install|ci|add)\b|uv\s+(?:sync|pip)\b|pip3?\s+install\b|poetry\s+install\b|go\s+mod\s+(?:download|tidy)\b|cargo\s+fetch\b|bundle\s+install\b)/;
  return command
    .split(/\s*(?:&&|;)\s*/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !install.test(s))
    .join(' && ');
}

/** Totals over an executed-test list (the same arithmetic the adapters use). */
export function totalsOf(tests: ObservedRun['tests']): ObservedRun['totals'] {
  const totals = { ...EMPTY_TOTALS };
  for (const t of tests) {
    totals.run++;
    if (t.status === 'passed') totals.passed++;
    else if (t.status === 'failed') totals.failed++;
    else totals.skipped++;
    if ((t.invocations ?? 1) > 1) totals.retried++;
  }
  return totals;
}

/**
 * Every file below `workDir` whose path ends with the report's relative path
 * (e.g. `.merge-evidence/vitest-results.json`), skipping dependency and build
 * trees. Bounded depth keeps this cheap even on very large checkouts.
 */
export function findNestedReports(workDir: string, reportPath: string, maxDepth = 6): string[] {
  const wanted = reportPath.split('/').filter((p) => p !== '' && p !== '.');
  const found: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '.pnpm-store', 'coverage']);
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      const sub = join(dir, entry.name);
      const candidate = join(sub, ...wanted);
      // Only reports below the root count — the root one was already tried.
      if (sub !== workDir && existsSync(candidate)) found.push(candidate);
      walk(sub, depth + 1);
    }
  };
  walk(workDir, 0);
  return found.sort();
}

/**
 * The clean re-run: install, execute the detected command with a
 * machine-readable reporter, and record exactly what ran.
 */
export async function runTests(
  detected: DetectedCommand,
  workDir: string,
  files: Record<string, string | undefined>,
  notes: string[],
  options: { skipInstall?: boolean } = {},
): Promise<ObservedRun> {
  const env = mergedEnv({ ...detected.env, PATH: pathWithBin(workDir) });
  mkdirSync(join(workDir, REPORT_DIR), { recursive: true });

  // The offline CLI can be handed a container whose dependencies are already in
  // place (installed while the network was still up); re-running the install
  // there would fail, not inform.
  if (options.skipInstall !== true) {
    await installDependencies(workDir, files, env, notes);
  }

  core.info(`run: ${detected.command}`);
  const started = Date.now();
  const result = await shell(detected.command, { cwd: workDir, env });
  const durationMs = Date.now() - started;
  core.info(`run: exit ${result.code} in ${Math.round(durationMs / 1000)}s`);

  // Keep the raw log next to the report so a reader can audit the reporter's
  // summary against the runner's own words.
  writeSafely(join(workDir, RUN_LOG), `${result.stdout}\n${result.stderr}`);
  if (detected.family === 'go') {
    // Go's `-json` stream is stdout; tee it to the report path the adapter reads.
    writeSafely(join(workDir, detected.reportPath), result.stdout);
  }

  const { tests, totals, reportMissing } = parseReport(detected, workDir, result.stdout, notes);
  const signal = signalOf(result);
  if (signal !== undefined) {
    const note = `runner: the test process died by ${signal} (exit ${result.code}); no evidence about the PR`;
    core.warning(note);
    notes.push(note);
  }

  return {
    command: detected.command,
    runner: detected.family,
    exitCode: result.code,
    durationMs,
    toolchain: probeToolchain(workDir),
    totals,
    tests,
    reportPath: detected.reportPath,
    ...(reportMissing === true ? { reportMissing: true } : {}),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Write a file, turning any filesystem problem into a warning. */
export function writeSafely(path: string, contents: string): void {
  try {
    writeFileSync(path, contents, 'utf8');
  } catch (err) {
    core.warning(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * What the PR changed, from git.
 *
 * `actions/checkout` defaults to a shallow single-commit fetch, so the base may
 * not be in the object store; it is fetched on demand, and if that fails too the
 * gate reports an empty diff (losing the C3–C8 checks) rather than failing.
 */
export async function collectDiff(
  workDir: string,
  pr: PullRequestFacts,
  policy: Policy,
  notes: string[],
  change?: ChangeList,
): Promise<DiffAnalysis> {
  const list = change ?? (await changedFilesDetailed(workDir, pr, notes));
  core.info(`diff: ${list.files.length} changed file(s)${list.unreliable ? ' (unreliable: no merge base)' : ''}`);
  return {
    ...analyzeDiff(list.files, policy.scopeAllow === undefined ? {} : { scopeAllow: policy.scopeAllow }),
    // The raw count survives scope filtering, so a check can tell "nothing
    // changed / base not comparable" apart from "only allow-listed paths changed".
    fileCount: list.files.length,
    ...(list.unreliable ? { unreliable: true } : {}),
  };
}

/** The change list, and whether it can be trusted to be this pull request's own. */
export interface ChangeList {
  files: ChangedFile[];
  /** No merge base was reachable: the list is a two-dot diff against the base tip. */
  unreliable: boolean;
  /** The commit the diff was taken against when a merge base was found or given. */
  mergeBase?: string;
}

async function ensureCommit(workDir: string, sha: string, label: string): Promise<void> {
  const present = await git(workDir, 'cat-file', '-e', `${sha}^{commit}`);
  if (present.code !== 0) {
    core.info(`diff: ${label} ${sha.slice(0, 7)} not present locally, fetching`);
    await git(workDir, 'fetch', '--no-tags', '--depth=1', 'origin', sha);
  }
}

/** The merge base of two commits, when the local history connects them. */
export async function mergeBaseOf(workDir: string, base: string, head: string): Promise<string | undefined> {
  const result = await git(workDir, 'merge-base', base, head);
  const sha = result.stdout.trim();
  return result.code === 0 && sha !== '' ? sha : undefined;
}

/**
 * What the pull request changed, taken against the commit it forked from.
 *
 * A diff against the base branch's TIP is only right when that tip is the fork
 * point. Otherwise everything the base branch did since the fork shows up as
 * the pull request's doing — upstream additions read as its deletions, and a
 * C3 "test file deleted" fires on a change that touched no test. So the diff
 * is taken against the merge base: the one the caller supplied, or the one
 * git finds, deepening a shallow history twice to find it. When there is still
 * none, the two-dot list is returned marked `unreliable`, and the change-based
 * checks abstain rather than guess.
 */
export async function changedFilesDetailed(
  workDir: string,
  pr: PullRequestFacts,
  notes: string[],
): Promise<ChangeList> {
  if (pr.baseSha === '' && pr.mergeBaseSha === undefined) return { files: [], unreliable: false };
  const head7 = pr.headSha.slice(0, 7);

  let mergeBase: string | undefined;
  if (pr.mergeBaseSha !== undefined && pr.mergeBaseSha !== '') {
    await ensureCommit(workDir, pr.mergeBaseSha, 'merge base');
    mergeBase = pr.mergeBaseSha;
  } else {
    await ensureCommit(workDir, pr.baseSha, 'base');
    mergeBase = await mergeBaseOf(workDir, pr.baseSha, pr.headSha);
    for (const depth of [100, 500]) {
      if (mergeBase !== undefined) break;
      core.info(`diff: no merge base between ${pr.baseSha.slice(0, 7)} and ${head7}; deepening history by ${depth}`);
      await git(workDir, 'fetch', '--no-tags', `--deepen=${depth}`, 'origin', pr.baseSha, pr.headSha);
      mergeBase = await mergeBaseOf(workDir, pr.baseSha, pr.headSha);
    }
  }

  const against = mergeBase ?? pr.baseSha;
  const nameStatus = await git(workDir, 'diff', '--name-status', '-M', against, pr.headSha);
  if (nameStatus.code !== 0) {
    const note = `diff: could not compare ${against.slice(0, 7)} with ${head7}; the change-based checks did not run`;
    core.warning(note);
    notes.push(note);
    return { files: [], unreliable: false };
  }
  const patches = await git(workDir, 'diff', '--unified=0', '-M', against, pr.headSha);
  const files = parseNameStatus(nameStatus.stdout, patches.code === 0 ? patches.stdout : '');

  if (mergeBase === undefined) {
    const note = `diff: no merge base between ${pr.baseSha.slice(0, 7)} and ${head7} (shallow checkout?); the change-based checks did not run — check out with fetch-depth: 0`;
    core.warning(note);
    notes.push(note);
    return { files, unreliable: true };
  }
  return { files, unreliable: false, mergeBase };
}

/** The change list alone; see `changedFilesDetailed`. */
export async function changedFiles(
  workDir: string,
  pr: PullRequestFacts,
  notes: string[],
): Promise<ChangedFile[]> {
  return (await changedFilesDetailed(workDir, pr, notes)).files;
}

// ---------------------------------------------------------------------------
// The pipeline both front-ends run
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** The checkout to test: where the tests run and the diff is taken. */
  workDir: string;
  pr: PullRequestFacts;
  policy: ParsedPolicy;
  /** An operator-supplied command; wins over the policy file and detection. */
  testCommand?: string;
  /** Only gate agent-authored PRs. Falls back to the policy, then to `true`. */
  agentsOnly?: boolean;
  /** The dependencies are already in place — do not run an install. */
  skipInstall?: boolean;
  /**
   * When no operator/policy command is given, run the test command the PR body
   * itself claims (the first `command` claim with a known runner) instead of the
   * repository's default. This is what C1 is really about — "did the command
   * you said you ran actually pass?" — and in a monorepo it is also the only
   * affordable choice: the root `pnpm test` fans out to every package.
   */
  preferClaimedCommand?: boolean;
  /**
   * `auto` (default): when the head run fails with evidence, run the same
   * command at the base commit so failures the repository already had are not
   * counted against the PR. `never`: skip that run. Falls back to the policy.
   */
  baseComparison?: 'auto' | 'never';
}

export interface EvaluateResult {
  /** Set when the PR was not gated at all; `receipt` and `rendered` are then absent. */
  skipped?: 'not-agent';
  agent: AgentDetection;
  receipt?: Receipt;
  rendered?: RenderedComment;
  discrepancies: Discrepancy[];
  verdict: Verdict;
  /** Claims the gate could not map to the run; shown, never counted against the PR. */
  unverifiable: string[];
  /** Facts the gate could not establish (checkout, install, reporter, diff). */
  notes: string[];
  /** The receipt as it should be written to disk, newline-terminated. */
  receiptJson?: string;
}

/**
 * Turn a pull request and a checkout into a verdict, a receipt and a rendered
 * comment.
 *
 * This is the whole gate: agent detection, the clean re-run, the diff, the
 * claims, the reconciliation. It publishes nothing and sets no exit status —
 * that is the caller's business, and it is why the Action and the CLI can share
 * every line of it.
 */
export async function evaluate(opts: EvaluateOptions): Promise<EvaluateResult> {
  const { workDir, pr, policy } = opts;
  const agentsOnly = opts.agentsOnly ?? policy.agentsOnly ?? true;

  const agent = detectAgent(pr);
  core.info(
    `agent: ${agent.detected}${agent.signals.length === 0 ? '' : ` (${agent.signals.join(', ')})`}`,
  );
  if (agentsOnly && !agent.isAgent) {
    core.info('skipped: not an agent PR');
    return {
      skipped: 'not-agent',
      agent,
      discrepancies: [],
      verdict: 'NEUTRAL',
      unverifiable: [],
      notes: [],
    };
  }

  /** Facts the gate could not establish; shown on the comment, never counted against the PR. */
  const notes: string[] = [];

  const files = readManifests(workDir);
  const claims = extractClaims(pr);
  core.info(`claims: ${claims.length} extracted from the PR body`);

  // The changed files are needed before the run: in a workspace whose root has
  // no test command, the packages this PR touches are what gets tested.
  const change: ChangeList =
    pr.baseSha === '' && pr.mergeBaseSha === undefined
      ? { files: [], unreliable: false }
      : await changedFilesDetailed(workDir, pr, notes);
  const packages = workspacePackages(workDir, change.files);

  const operatorCommand =
    opts.testCommand === undefined || opts.testCommand === '' ? policy.testCommand : opts.testCommand;
  let claimedCommand: string | undefined;
  let claimedPaths: string[] = [];
  if (operatorCommand === undefined && opts.preferClaimedCommand === true) {
    const claimed = claims.find(
      (c): c is typeof c & { parsed: { kind: 'command'; runner: string; raw: string; paths: string[] } } =>
        c.kind === 'command' && c.parsed.kind === 'command' && c.parsed.runner !== 'unknown',
    );
    if (claimed !== undefined) {
      const stripped = withoutInstallSteps(claimed.parsed.raw);
      if (stripped !== '') {
        claimedCommand = stripped;
        claimedPaths = claimed.parsed.paths;
        const note = `runner: running the command the PR claimed (${claimed.id}): \`${claimedCommand}\``;
        core.info(note);
        notes.push(note);
      }
    }
  }

  // Precedence: an operator/policy command runs at the root as written; a
  // claimed command runs at the root when the root has a test command of its
  // own, else inside the touched packages; otherwise the root's own command,
  // else the touched packages' scripts.
  const root = detectTestCommand({ ...(operatorCommand === undefined ? {} : { explicit: operatorCommand }), files });
  let detected: DetectedCommand | null;
  if (operatorCommand !== undefined) {
    detected = root;
  } else if (claimedCommand !== undefined) {
    // A claimed command that names paths (`vitest --run components/x`) is meant
    // for the package where those paths exist, not every touched package.
    const holding = packagesHoldingPaths(workDir, packages, claimedPaths);
    detected =
      root === null && packages.length > 0
        ? detectWorkspaceCommand({ explicit: claimedCommand, rootFiles: files, packages: holding })
        : detectTestCommand({ explicit: claimedCommand, files });
  } else {
    detected = root ?? (packages.length > 0 ? detectWorkspaceCommand({ rootFiles: files, packages }) : null);
  }

  let observed: ObservedRun;
  if (detected === null) {
    const note = 'no test command could be detected — configure `test-command:` to enable the gate';
    core.warning(`runner: ${note}`);
    notes.push(note);
    observed = {
      command: '',
      runner: 'none',
      exitCode: 0,
      durationMs: 0,
      toolchain: probeToolchain(workDir),
      totals: EMPTY_TOTALS,
      tests: [],
      noTestCommand: true,
    };
  } else {
    await ensureHeadCheckout(workDir, pr.headSha, notes);
    observed = await runTests(detected, workDir, files, notes, {
      ...(opts.skipInstall === undefined ? {} : { skipInstall: opts.skipInstall }),
    });

    // A failed head run is compared against the base commit before it can be
    // held against the PR: many repositories fail some tests on a clean runner
    // (network, keys, platform), and those failures are not this change's.
    const mode = opts.baseComparison ?? policy.baseComparison ?? 'auto';
    if (mode !== 'never' && needsBaseline(observed)) {
      if (pr.baseSha === '') {
        const note = 'baseline: no base commit given, so the head failure could not be compared against base';
        core.info(note);
        notes.push(note);
      } else {
        core.info(`baseline: the head run failed (exit ${observed.exitCode}) — running the same command at base ${pr.baseSha.slice(0, 7)}`);
        const baseline = await runBaseline(detected, workDir, pr, files, notes, {
          ...(opts.skipInstall === undefined ? {} : { skipInstall: opts.skipInstall }),
          // Compare at the fork point when it is known: the base tip may carry
          // unrelated newer changes that would muddy the attribution.
          baseSha: pr.mergeBaseSha ?? change.mergeBase ?? pr.baseSha,
        });
        if (baseline !== undefined) observed = { ...observed, baseline };
      }
    }
  }

  const diff = await collectDiff(workDir, pr, policy, notes, change);

  const { discrepancies, verdict, unverifiable } = reconcile({ pr, claims, observed, diff, policy });
  const receipt = buildReceipt({ pr, agent, claims, observed, diff, discrepancies, verdict, policy });
  const rendered = renderComment(receipt, { unverifiable: [...unverifiable, ...notes] });

  return {
    agent,
    receipt,
    rendered,
    discrepancies,
    verdict,
    unverifiable,
    notes,
    receiptJson: `${JSON.stringify(receipt, null, 2)}\n`,
  };
}

/**
 * The workspace packages a change touches: for each changed path, the nearest
 * ancestor directory — never the root — holding a `package.json`. Most-changed
 * first, so a cap keeps the packages the pull request is mostly about. A
 * package deleted by the change has no directory at head and is skipped.
 */
export function workspacePackages(workDir: string, changed: readonly ChangedFile[]): WorkspacePackage[] {
  const counts = new Map<string, number>();
  for (const file of changed) {
    const path = file.path.replace(/\\/g, '/');
    if (path.split('/').includes('node_modules')) continue;
    let dir = dirname(path);
    while (dir !== '.' && dir !== '' && dir !== '/') {
      if (existsSync(join(workDir, dir, 'package.json'))) {
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
        break;
      }
      dir = dirname(dir);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dir]) => ({ dir, files: readManifests(join(workDir, dir)) }));
}

/** Strip the selector syntax a claimed path may carry: `./pkg/...`, `tests/**`. */
function selectorPath(selector: string): string {
  return selector.trim().replace(/^\.\//, '').replace(/\/?(?:\.\.\.|\*\*)$/, '').replace(/\/$/, '');
}

/**
 * The packages in which every claimed path exists — the ones a claimed
 * `vitest --run components/x` can mean. With no paths, or none found anywhere,
 * every package stays in: the paths may be relative to the root.
 */
export function packagesHoldingPaths(
  workDir: string,
  packages: WorkspacePackage[],
  claimedPaths: readonly string[],
): WorkspacePackage[] {
  const paths = claimedPaths.map(selectorPath).filter((p) => p !== '' && p !== '.');
  if (paths.length === 0) return packages;
  const holding = packages.filter((pkg) => paths.every((p) => existsSync(join(workDir, pkg.dir, p))));
  return holding.length > 0 ? holding : packages;
}

/** Manifests whose change between base and head means base needs its own install. */
const DEPENDENCY_MANIFESTS: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
  'requirements.txt',
  'Cargo.toml',
  'Cargo.lock',
];

/** True when any dependency manifest differs between two checkouts' manifest maps. */
export function manifestsDiffer(
  a: Record<string, string | undefined>,
  b: Record<string, string | undefined>,
): boolean {
  return DEPENDENCY_MANIFESTS.some((name) => a[name] !== b[name]);
}

/**
 * True when the head run failed in a way a base run could explain: it ran, it
 * produced evidence, and it did not pass. A passing run is never re-run at base
 * — the comparison can only ever excuse a failure, never manufacture one.
 */
export function needsBaseline(observed: ObservedRun): boolean {
  return observed.noTestCommand !== true && observed.exitCode !== 0 && !hasNoEvidence(observed);
}

/**
 * Run the detected command at the base commit, in the same checkout and
 * environment, and return what failed there. The head run's artifacts are
 * kept aside and restored; the checkout always returns to head, and when the
 * dependency manifests differ the base gets its own frozen install and head
 * is reinstalled afterwards. Anything that stops the comparison is a note,
 * never a failure: the head result then stands as observed.
 */
export async function runBaseline(
  detected: DetectedCommand,
  workDir: string,
  pr: PullRequestFacts,
  headFiles: Record<string, string | undefined>,
  notes: string[],
  options: { skipInstall?: boolean; baseSha?: string } = {},
): Promise<BaselineRun | undefined> {
  const sha = options.baseSha ?? pr.baseSha;
  const short = sha.slice(0, 7);
  const giveUp = (reason: string): undefined => {
    const note = `baseline: ${reason}; the head failure could not be compared against base ${short}`;
    core.warning(note);
    notes.push(note);
    return undefined;
  };

  const present = await git(workDir, 'cat-file', '-e', `${sha}^{commit}`);
  if (present.code !== 0) await git(workDir, 'fetch', '--no-tags', '--depth=1', 'origin', sha);

  // Keep the head run's reports: the base run writes to the same paths.
  const reportDir = join(workDir, REPORT_DIR);
  const headKeep = `${reportDir}.head`;
  rmSync(headKeep, { recursive: true, force: true });
  if (existsSync(reportDir)) renameSync(reportDir, headKeep);
  for (const nested of findNestedReports(workDir, detected.reportPath)) rmSync(nested, { force: true });

  const restore = async (): Promise<boolean> => {
    const back = await git(workDir, 'checkout', '--force', '--detach', pr.headSha);
    const baseKeep = `${reportDir}.base`;
    rmSync(baseKeep, { recursive: true, force: true });
    if (existsSync(reportDir)) renameSync(reportDir, baseKeep);
    if (existsSync(headKeep)) renameSync(headKeep, reportDir);
    return back.code === 0;
  };

  const checkout = await git(workDir, 'checkout', '--force', '--detach', sha);
  if (checkout.code !== 0) {
    await restore();
    return giveUp(`could not check out base ${short}`);
  }

  const env = mergedEnv({ ...detected.env, PATH: pathWithBin(workDir) });
  const baseFiles = readManifests(workDir);
  const depsChanged = manifestsDiffer(headFiles, baseFiles);
  if (depsChanged && options.skipInstall === true) {
    await restore();
    return giveUp('dependency manifests differ between base and head and installs are disabled');
  }
  if (depsChanged) {
    core.info('baseline: dependency manifests differ from head — installing the base dependencies');
    await installDependencies(workDir, baseFiles, env, notes, { force: true });
  }

  mkdirSync(reportDir, { recursive: true });
  core.info(`baseline: run: ${detected.command} @ ${short}`);
  const started = Date.now();
  const result = await shell(detected.command, { cwd: workDir, env });
  core.info(`baseline: run: exit ${result.code} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (detected.family === 'go') writeSafely(join(workDir, detected.reportPath), result.stdout);
  const baseNotes: string[] = [];
  const parsed = parseReport(detected, workDir, result.stdout, baseNotes);
  for (const note of baseNotes) notes.push(`baseline: ${note}`);
  const signal = signalOf(result);

  const restored = await restore();
  if (depsChanged) {
    core.info('baseline: reinstalling the head dependencies');
    await installDependencies(workDir, headFiles, env, notes, { force: true });
  }
  if (!restored) {
    const note = `baseline: could not return the checkout to head ${pr.headSha.slice(0, 7)} after the base run`;
    core.warning(note);
    notes.push(note);
  }

  const noEvidence = hasNoEvidence({
    command: detected.command,
    runner: detected.family,
    exitCode: result.code,
    durationMs: 0,
    toolchain: {},
    totals: parsed.totals,
    tests: parsed.tests,
    ...(parsed.reportMissing === true ? { reportMissing: true } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  const failed = parsed.tests
    .filter((test) => test.status === 'failed')
    .map((test) => test.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  core.info(
    `baseline: ${parsed.totals.run} tests, ${parsed.totals.failed} failed at base${noEvidence ? ' (no per-test evidence)' : ''}`,
  );
  return {
    sha,
    exitCode: result.code,
    totals: parsed.totals,
    failed,
    ...(noEvidence ? { noEvidence: true } : {}),
  };
}

/**
 * Move the checkout to the head commit and install its dependencies — nothing
 * else.
 *
 * A study harness that runs the gate with the network off needs a moment when
 * the network is still on: this is that moment, run once per repository before
 * the container is sealed.
 */
export async function installOnly(workDir: string, pr: PullRequestFacts, notes: string[]): Promise<void> {
  await ensureHeadCheckout(workDir, pr.headSha, notes);
  await installDependencies(workDir, readManifests(workDir), mergedEnv({}), notes);
}
