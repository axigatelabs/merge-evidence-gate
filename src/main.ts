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
 * The pipeline itself lives in `src/pipeline.ts`, which the offline CLI
 * (`src/cli.ts`) runs too; this file is the GitHub half of it — the event and
 * payload checks, the token, the outputs, the annotations, the artifact, the
 * summary and the comment.
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
 * All `@actions/github` and `@actions/artifact` usage lives here and in
 * `src/action/github.ts`; the core modules under `src/core/` are pure and know
 * nothing about a runner.
 */
import { join, resolve } from 'node:path';

import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import * as github from '@actions/github';

import {
  listCommitMessages,
  parseRepo,
  upsertStickyComment,
  type Octokit,
  type RepoRef,
} from './action/github.js';
import { evaluate, loadPolicy, writeSafely } from './pipeline.js';
import type { PullRequestFacts, Verdict } from './core/types.js';

/** Events that carry a pull request worth gating. */
const GATE_EVENTS = new Set(['pull_request', 'pull_request_target', 'merge_group']);

/** Artifact name the receipt is uploaded under. */
const ARTIFACT_NAME = 'merge-evidence-receipt';

/** Most discrepancy annotations to emit, so one bad PR cannot flood the log. */
const MAX_ANNOTATIONS = 10;

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

  const result = await evaluate({
    workDir,
    pr,
    policy,
    testCommand: inputs.testCommand,
    ...(inputs.agentsOnly === undefined ? {} : { agentsOnly: inputs.agentsOnly }),
  });

  if (result.skipped === 'not-agent') {
    setOutputs('NEUTRAL', 0, '');
    await core.summary
      .addRaw('**Merge-Evidence Gate — NEUTRAL** · skipped: not an agent PR', true)
      .write();
    return;
  }

  const { receipt, rendered, receiptJson, verdict, discrepancies } = result;
  if (receipt === undefined || rendered === undefined || receiptJson === undefined) {
    // Unreachable: `evaluate` omits these only on the skip handled above.
    throw new Error('the pipeline returned no receipt');
  }

  const receiptPath = join(workspace, 'receipt.json');
  writeSafely(receiptPath, receiptJson);
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
