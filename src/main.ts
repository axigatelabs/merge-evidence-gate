/**
 * Merge-Evidence Gate — GitHub Action entry point.
 *
 * One `run()` that turns a pull request into a receipt: read what the agent
 * SAID (claims), re-run the repository's own tests in a clean environment and
 * record what ACTUALLY happened (observed), look at what the PR CHANGED around
 * those tests (diff), reconcile the three into discrepancies and a verdict, and
 * publish that as a sticky comment, a job summary, a `receipt.json` artifact and
 * a set of outputs.
 *
 * Two rules shape every line below.
 *
 *  1. **The verdict is the only thing that may fail the job.** A fork PR's
 *     read-only token, a missing base commit, an absent reporter, a dependency
 *     install that will not resolve — each becomes a warning and a degraded
 *     result, never a thrown exception. A gate that fails on its own plumbing
 *     teaches people to ignore it.
 *  2. **Never fail a PR on a claim the gate could not verify.** Anything the
 *     reconciler cannot map to the observed run is reported as unverifiable and
 *     shown on the comment; it is not counted against the PR.
 *
 * All `@actions/*` usage lives here and in `src/action/github.ts`; the core
 * modules under `src/core/` are pure and know nothing about a runner.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';

import {
  listCommitMessages,
  parseRepo,
  upsertStickyComment,
  type Octokit,
  type RepoRef,
} from './action/github.js';
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
import {
  adapters,
  detectTestCommand,
  normalize,
  REPORT_DIR,
  type DetectedCommand,
} from './core/runners/index.js';
import type {
  ChangedFile,
  DiffAnalysis,
  ObservedRun,
  Policy,
  PullRequestFacts,
  Verdict,
} from './core/types.js';

/** Events that carry a pull request worth gating. */
const GATE_EVENTS = new Set(['pull_request', 'pull_request_target', 'merge_group']);

/** Artifact name the receipt is uploaded under. */
const ARTIFACT_NAME = 'merge-evidence-receipt';

/** Most discrepancy annotations to emit, so one bad PR cannot flood the log. */
const MAX_ANNOTATIONS = 10;

/** Where the raw combined stdout/stderr of the test run is kept. */
const RUN_LOG = `${REPORT_DIR}/run.log`;

const EMPTY_TOTALS: ObservedRun['totals'] = {
  run: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  retried: 0,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

interface Inputs {
  token: string;
  testCommand: string;
  agentsOnly: boolean | undefined;
  failOn: 'fail' | 'needs-human';
  comment: boolean;
  uploadReceipt: boolean;
  policyFile: string;
  workingDirectory: string;
}

/**
 * A boolean action input. `core.getBooleanInput` throws on anything outside the
 * YAML 1.2 spelling; a typo in a workflow file must not fail the gate, so this
 * warns and falls back instead.
 */
function boolInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  core.warning(`input '${name}': expected a boolean, got '${raw}' — using ${fallback}`);
  return fallback;
}

/** As `boolInput`, but `undefined` when the input was left empty. */
function optionalBoolInput(name: string): boolean | undefined {
  if (core.getInput(name).trim() === '') return undefined;
  return boolInput(name, true);
}

function readInputs(): Inputs {
  const failOnRaw = core.getInput('fail-on').trim().toLowerCase();
  if (failOnRaw !== '' && failOnRaw !== 'fail' && failOnRaw !== 'needs-human') {
    core.warning(`input 'fail-on': expected 'fail' or 'needs-human', got '${failOnRaw}' — using 'fail'`);
  }
  return {
    token: core.getInput('github-token'),
    testCommand: core.getInput('test-command').trim(),
    agentsOnly: optionalBoolInput('agents-only'),
    failOn: failOnRaw === 'needs-human' ? 'needs-human' : 'fail',
    comment: boolInput('comment', true),
    uploadReceipt: boolInput('upload-receipt', true),
    policyFile: core.getInput('policy-file').trim() || '.merge-evidence.yml',
    workingDirectory: core.getInput('working-directory').trim() || '.',
  };
}

// ---------------------------------------------------------------------------
// Small process helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Environment for the test run: the runner's own, plus the reporter overlay. */
function mergedEnv(overlay: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overlay };
}

/**
 * Run `commandLine` and capture both streams. Never rejects: a command that
 * cannot even be spawned comes back as code 127 with the reason on stderr, so
 * every caller handles one shape.
 */
async function execCapture(
  commandLine: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; silent?: boolean },
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  try {
    const code = await exec.exec(commandLine, args, {
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
    });
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout, stderr: `${stderr}${err instanceof Error ? err.message : String(err)}` };
  }
}

/** `git …` in `cwd`, quietly — git chatter is noise unless something failed. */
async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
  return execCapture('git', args, { cwd, silent: true });
}

/**
 * Run a shell command line the way the repository's own CI would.
 *
 * Detected commands are shell text (`npm test -- --reporter=json`,
 * `make test`, occasionally with `&&`), so they go through a shell rather than
 * `exec`'s argv splitter, which does not understand operators.
 */
async function shell(
  commandLine: string,
  options: { cwd: string; env: Record<string, string> },
): Promise<CommandResult> {
  if (process.platform === 'win32') {
    return execCapture('pwsh', ['-NoProfile', '-Command', commandLine], options);
  }
  return execCapture('bash', ['-c', commandLine], options);
}

// ---------------------------------------------------------------------------
// Pull request facts
// ---------------------------------------------------------------------------

/** The subset of the webhook payload we read, without trusting its shape. */
interface PayloadPullRequest {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  head?: { sha?: unknown; ref?: unknown } | null;
  base?: { sha?: unknown; ref?: unknown } | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Build `PullRequestFacts` from the event payload. Returns `undefined` when the
 * payload carries no pull request (a `merge_group` event, a manual dispatch),
 * which the caller turns into a neutral skip rather than a failure.
 */
function readPullRequest(repoFullName: string): PullRequestFacts | undefined {
  const payload = github.context.payload.pull_request as PayloadPullRequest | undefined;
  if (payload === undefined) return undefined;
  const number = typeof payload.number === 'number' ? payload.number : Number.NaN;
  const headSha = str(payload.head?.sha);
  const baseSha = str(payload.base?.sha);
  if (!Number.isFinite(number) || headSha === '') return undefined;
  return {
    repo: repoFullName,
    number,
    headSha,
    baseSha,
    baseRef: str(payload.base?.ref),
    headRef: str(payload.head?.ref),
    authorLogin: str(payload.user?.login),
    body: str(payload.body),
    title: str(payload.title),
    commitMessages: [],
  };
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
function loadPolicy(workDir: string, policyFile: string): ParsedPolicy {
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
async function ensureHeadCheckout(workDir: string, headSha: string, notes: string[]): Promise<void> {
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
function installPlan(
  workDir: string,
  files: Record<string, string | undefined>,
): Array<{ command: string; frozen: boolean }> {
  const plan: Array<{ command: string; frozen: boolean }> = [];

  if (files['package.json'] !== undefined && !existsSync(join(workDir, 'node_modules'))) {
    if (files['pnpm-lock.yaml'] !== undefined) plan.push({ command: 'pnpm i --frozen-lockfile', frozen: true });
    else if (files['yarn.lock'] !== undefined) plan.push({ command: 'yarn install --immutable', frozen: true });
    else if (files['bun.lockb'] !== undefined) plan.push({ command: 'bun install --frozen-lockfile', frozen: true });
    else if (files['package-lock.json'] !== undefined) plan.push({ command: 'npm ci', frozen: true });
    // No lockfile: the install cannot be frozen, so it is recorded as such
    // rather than silently presented as a reproducible environment.
    else plan.push({ command: 'npm install --no-audit --no-fund', frozen: false });
  }

  if (files['go.mod'] !== undefined && !existsSync(join(workDir, 'vendor'))) {
    plan.push({ command: 'go mod download', frozen: true });
  }

  if (files['uv.lock'] !== undefined) {
    plan.push({ command: 'uv sync --locked', frozen: true });
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
async function installDependencies(
  workDir: string,
  files: Record<string, string | undefined>,
  env: Record<string, string>,
  notes: string[],
): Promise<void> {
  for (const step of installPlan(workDir, files)) {
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
function parseReport(
  detected: DetectedCommand,
  workDir: string,
  stdout: string,
  notes: string[],
): { tests: ObservedRun['tests']; totals: ObservedRun['totals'] } {
  if (detected.note !== undefined) {
    core.info(`runner: ${detected.note}`);
    notes.push(`runner: ${detected.note}`);
  }
  if (adapters[detected.family] === undefined) {
    return { tests: [], totals: EMPTY_TOTALS };
  }

  // Go streams its JSON events to stdout; every other supported runner writes a
  // report file. `runTests` has already teed stdout to `reportPath` for Go, so
  // the file is tried first either way and stdout is the fallback.
  const raw = readReport(join(workDir, detected.reportPath)) ?? (stdout.trim() === '' ? undefined : stdout);
  if (raw === undefined) {
    const note = `runner: no machine-readable output at ${detected.reportPath}; per-test evidence is unavailable`;
    core.warning(note);
    notes.push(note);
    return { tests: [], totals: EMPTY_TOTALS };
  }

  try {
    return normalize(detected.family, raw);
  } catch (err) {
    const note = `runner: could not parse ${detected.family} output (${err instanceof Error ? err.message : String(err)})`;
    core.warning(note);
    notes.push(note);
    return { tests: [], totals: EMPTY_TOTALS };
  }
}

/**
 * The clean re-run: install, execute the detected command with a
 * machine-readable reporter, and record exactly what ran.
 */
async function runTests(
  detected: DetectedCommand,
  workDir: string,
  files: Record<string, string | undefined>,
  notes: string[],
): Promise<ObservedRun> {
  const env = mergedEnv(detected.env);
  mkdirSync(join(workDir, REPORT_DIR), { recursive: true });

  await installDependencies(workDir, files, env, notes);

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

  const { tests, totals } = parseReport(detected, workDir, result.stdout, notes);

  return {
    command: detected.command,
    runner: detected.family,
    exitCode: result.code,
    durationMs,
    toolchain: probeToolchain(workDir),
    totals,
    tests,
    reportPath: detected.reportPath,
  };
}

/** Write a file, turning any filesystem problem into a warning. */
function writeSafely(path: string, contents: string): void {
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
async function collectDiff(
  workDir: string,
  pr: PullRequestFacts,
  policy: Policy,
  notes: string[],
): Promise<DiffAnalysis> {
  const files = await changedFiles(workDir, pr, notes);
  core.info(`diff: ${files.length} changed file(s)`);
  return analyzeDiff(files, policy.scopeAllow === undefined ? {} : { scopeAllow: policy.scopeAllow });
}

async function changedFiles(
  workDir: string,
  pr: PullRequestFacts,
  notes: string[],
): Promise<ChangedFile[]> {
  if (pr.baseSha === '') return [];

  const present = await git(workDir, 'cat-file', '-e', `${pr.baseSha}^{commit}`);
  if (present.code !== 0) {
    core.info(`diff: base ${pr.baseSha.slice(0, 7)} not present locally, fetching`);
    await git(workDir, 'fetch', '--no-tags', '--depth=1', 'origin', pr.baseSha);
  }

  // `base...head` is the right comparison (changes on the branch only), but it
  // needs a merge base, which a shallow fetch does not provide; a two-dot diff
  // is the honest fallback.
  for (const range of [`${pr.baseSha}...${pr.headSha}`, `${pr.baseSha} ${pr.headSha}`]) {
    const args = range.split(' ');
    const nameStatus = await git(workDir, 'diff', '--name-status', '-M', ...args);
    if (nameStatus.code !== 0) continue;
    const patches = await git(workDir, 'diff', '--unified=0', '-M', ...args);
    return parseNameStatus(nameStatus.stdout, patches.code === 0 ? patches.stdout : '');
  }

  const note = `diff: could not compare ${pr.baseSha.slice(0, 7)}...${pr.headSha.slice(0, 7)}; the change-based checks did not run`;
  core.warning(note);
  notes.push(note);
  return [];
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** Emit one annotation per discrepancy, capped, plus a compact table in the log. */
function annotate(discrepancies: ReadonlyArray<{ check: string; severity: string; summary: string }>): void {
  if (discrepancies.length === 0) {
    core.info('discrepancies: none');
    return;
  }
  const rows = discrepancies.map((d) => `  ${d.check}  ${d.severity.padEnd(11)}  ${d.summary}`);
  core.info(`discrepancies (${discrepancies.length}):\n${rows.join('\n')}`);

  for (const d of discrepancies.slice(0, MAX_ANNOTATIONS)) {
    const message = `${d.check}: ${d.summary}`;
    if (d.severity === 'fail') core.error(message, { title: 'Merge-Evidence Gate' });
    else if (d.severity === 'needs-human') core.warning(message, { title: 'Merge-Evidence Gate' });
    else core.notice(message, { title: 'Merge-Evidence Gate' });
  }
  if (discrepancies.length > MAX_ANNOTATIONS) {
    core.info(`… ${discrepancies.length - MAX_ANNOTATIONS} further discrepancies on the receipt`);
  }
}

/** Upload `receipt.json` so the full evidence outlives the log retention. */
async function uploadReceipt(receiptPath: string, rootDir: string): Promise<void> {
  try {
    const client = new DefaultArtifactClient();
    await client.uploadArtifact(ARTIFACT_NAME, [receiptPath], rootDir);
    core.info(`artifact: uploaded ${ARTIFACT_NAME}`);
  } catch (err) {
    core.warning(`artifact: could not upload ${ARTIFACT_NAME} (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Post or update the receipt comment; a read-only token is a warning, not a failure. */
async function publishComment(
  octokit: Octokit | undefined,
  ref: RepoRef,
  prNumber: number,
  marker: string,
  markdown: string,
): Promise<void> {
  if (octokit === undefined) {
    core.warning('comment: no github-token available — skipping the receipt comment');
    return;
  }
  const result = await upsertStickyComment(octokit, ref, prNumber, marker, markdown);
  if (result.action === 'failed') {
    const reason = result.permissionDenied === true
      ? 'the token cannot write comments (expected on a fork PR) — the receipt is still in the job summary and artifact'
      : result.error ?? 'unknown error';
    core.warning(`comment: ${reason}`);
    return;
  }
  core.info(`comment: ${result.action}${result.url === undefined ? '' : ` ${result.url}`}`);
}

/** Set the three action outputs in one place, so every exit path agrees. */
function setOutputs(verdict: Verdict, discrepancies: number, receiptPath: string): void {
  core.setOutput('verdict', verdict);
  core.setOutput('discrepancies', String(discrepancies));
  core.setOutput('receipt-path', receiptPath);
}

/** Translate the verdict into the job's exit status. */
function applyVerdict(verdict: Verdict, failOn: Inputs['failOn'], title: string): void {
  if (verdict === 'FAIL') {
    core.setFailed(title);
    return;
  }
  if (verdict === 'NEEDS_HUMAN') {
    if (failOn === 'needs-human') core.setFailed(title);
    else core.warning(`${title} — a human should look at this before merging`);
    return;
  }
  core.info(title);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const inputs = readInputs();
  const workspace = process.env['GITHUB_WORKSPACE'] ?? process.cwd();
  const workDir = resolve(workspace, inputs.workingDirectory);

  if (!GATE_EVENTS.has(github.context.eventName)) {
    core.notice(
      `merge-evidence-gate: nothing to do on '${github.context.eventName}' — the gate runs on pull_request, pull_request_target and merge_group.`,
    );
    setOutputs('NEUTRAL', 0, '');
    return;
  }

  const ref: RepoRef = { owner: github.context.repo.owner, repo: github.context.repo.repo };
  const repoFullName = `${ref.owner}/${ref.repo}`;
  const pr = readPullRequest(repoFullName);
  if (pr === undefined) {
    core.notice('merge-evidence-gate: this event carries no pull request — skipping.');
    setOutputs('NEUTRAL', 0, '');
    return;
  }

  const octokit = inputs.token === '' ? undefined : github.getOctokit(inputs.token);
  if (octokit !== undefined) {
    const commits = await listCommitMessages(octokit, parseRepo(repoFullName), pr.number);
    if (commits.error !== undefined) {
      core.warning(`commits: could not list this PR's commits (${commits.error}) — co-author trailers were not read`);
    }
    pr.commitMessages = commits.messages;
  }

  // The policy is read before the agent gate so a repository can turn
  // `agents-only` off (or on) in one place instead of in every workflow file.
  const policy = loadPolicy(workDir, inputs.policyFile);
  const agentsOnly = inputs.agentsOnly ?? policy.agentsOnly ?? true;

  const agent = detectAgent(pr);
  core.info(
    `agent: ${agent.detected}${agent.signals.length === 0 ? '' : ` (${agent.signals.join(', ')})`}`,
  );
  if (agentsOnly && !agent.isAgent) {
    core.info('skipped: not an agent PR');
    setOutputs('NEUTRAL', 0, '');
    await core.summary
      .addRaw('**Merge-Evidence Gate — NEUTRAL** · skipped: not an agent PR', true)
      .write();
    return;
  }

  /** Facts the gate could not establish; shown on the comment, never counted against the PR. */
  const notes: string[] = [];

  const files = readManifests(workDir);
  const detected = detectTestCommand({
    ...(inputs.testCommand === ''
      ? policy.testCommand === undefined
        ? {}
        : { explicit: policy.testCommand }
      : { explicit: inputs.testCommand }),
    files,
  });

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
    observed = await runTests(detected, workDir, files, notes);
  }

  const diff = await collectDiff(workDir, pr, policy, notes);
  const claims = extractClaims(pr);
  core.info(`claims: ${claims.length} extracted from the PR body`);

  const { discrepancies, verdict, unverifiable } = reconcile({ pr, claims, observed, diff, policy });
  const receipt = buildReceipt({ pr, agent, claims, observed, diff, discrepancies, verdict, policy });
  const rendered = renderComment(receipt, { unverifiable: [...unverifiable, ...notes] });

  const receiptPath = join(workspace, 'receipt.json');
  writeSafely(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  setOutputs(verdict, discrepancies.length, receiptPath);

  annotate(discrepancies);

  if (inputs.uploadReceipt) await uploadReceipt(receiptPath, workspace);

  try {
    await core.summary.addRaw(rendered.markdown, true).write();
  } catch (err) {
    core.warning(`summary: could not write the job summary (${err instanceof Error ? err.message : String(err)})`);
  }

  if (inputs.comment) {
    await publishComment(octokit, ref, pr.number, rendered.marker, rendered.markdown);
  }

  applyVerdict(verdict, inputs.failOn, rendered.title);
}

run().catch((err: unknown) => {
  // Reaching here means the gate itself broke, not that the PR is bad. Say so
  // plainly: a plumbing failure that reads like a verdict is worse than none.
  core.setFailed(
    `merge-evidence-gate failed before reaching a verdict: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
});
