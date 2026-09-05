/**
 * Merge-Evidence Gate — offline command line.
 *
 * The same pipeline the Action runs (`src/pipeline.ts`), driven from arguments
 * instead of a webhook: point it at a checkout, tell it what the pull request
 * said, get a `receipt.json` back. There is no token, no event, no comment and
 * no artifact, so it runs on a laptop before a push, and inside a throwaway
 * container with the network switched off — which is how a study can re-run
 * hundreds of real agent pull requests without asking GitHub for anything.
 *
 * Two properties matter for a harness driving thousands of these:
 *
 *  1. **The verdict never becomes an exit code.** Exit 0 means the gate reached
 *     a verdict (or skipped a non-agent PR); exit 2 means the CLI itself broke.
 *     A harness can therefore tell "this PR is contradicted" from "this run is
 *     unusable" without parsing stderr.
 *  2. **The sidecar is always written.** `<out>.meta.json` records the verdict,
 *     the skip, the agent and everything the gate could not verify, even when
 *     there is no receipt to write.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { evaluate, installOnly, loadPolicy } from './pipeline.js';
import type { PullRequestFacts } from './core/types.js';

const USAGE = `merge-evidence — re-run a pull request's tests and reconcile them with what it claimed

Usage: merge-evidence --work <dir> --head <sha> --out <receipt.json> [options]

Required:
  --work <dir>             Checkout to test (the pull request's head).
  --head <sha>             Head commit the receipt names.
  --out <path>             Where to write receipt.json. A <out>.meta.json sidecar
                           is always written next to it.

Pull request facts (all optional; the more you pass, the more can be checked):
  --repo <owner/name>      Repository the PR belongs to.
  --pr <n>                 Pull request number.
  --base <sha>             Base commit; without it the diff-based checks are skipped.
  --author <login>         PR author login.
  --head-ref <branch>      Head branch name.
  --base-ref <branch>      Base branch name.
  --title <text>           PR title.
  --body-file <path>       File holding the PR body markdown (the claims come from here).
  --commits-file <path>    File of commit messages, one per blank-line-separated block.

Behaviour:
  --test-command <cmd>     Command to run; overrides the policy file and detection.
  --policy-file <path>     Policy file (default: .merge-evidence.yml).
  --agents-only <bool>     Only gate agent-authored PRs (default: true).
  --skip-install           Do not install dependencies; the checkout is ready.
  --install-only           Check out the head, install dependencies, and stop.
  --prefer-claimed-command When no command is given, run the test command the PR
                           body itself claims (first command claim with a known
                           runner) instead of the repository default.
  --base-comparison <mode> auto (default): when the head run fails, run the same
                           command at the base commit and only count failures
                           this PR introduced; never: skip that run.
  --help                   Print this.
`;

/**
 * A problem with what the caller asked for — a missing flag, a directory that is
 * not there, a file that will not open. Reported as one line, without a stack:
 * the trace would be about this file, not about the mistake.
 */
class UsageError extends Error {}

/** `true` unless the value spells a negative; an unreadable value is an error. */
function parseBool(name: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  throw new UsageError(`${name}: expected true or false, got '${raw}'`);
}

/** Read a file the caller named; a missing one is the caller's mistake, so it throws. */
function readRequiredFile(flag: string, path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`${flag}: could not read ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Commit messages, one per blank-line-separated block — the shape a harness
 * gets from `git log --format=%B`. Co-author trailers are why the gate wants
 * them, and those live at the end of a message body.
 */
function parseCommitsFile(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/**
 * Run the gate once. Returns the process exit code: 0 when a verdict (or a
 * skip) was produced, 2 when the CLI itself could not run — a bad argument, a
 * work directory that is not there, an unreadable file.
 *
 * Exported so the tests can drive it in-process; the entry guard at the bottom
 * of this file is what makes the bundle a command.
 */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        work: { type: 'string' },
        repo: { type: 'string' },
        pr: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        author: { type: 'string' },
        'head-ref': { type: 'string' },
        'base-ref': { type: 'string' },
        title: { type: 'string' },
        'body-file': { type: 'string' },
        'commits-file': { type: 'string' },
        'test-command': { type: 'string' },
        'policy-file': { type: 'string' },
        'agents-only': { type: 'string' },
        out: { type: 'string' },
        markdown: { type: 'string' },
        'install-only': { type: 'boolean' },
        'skip-install': { type: 'boolean' },
        'prefer-claimed-command': { type: 'boolean' },
        'base-comparison': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`merge-evidence: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  const values = parsed.values;
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const work = values.work;
    if (work === undefined || work.trim() === '') throw new UsageError('--work <dir> is required');
    const workDir = resolve(work);
    if (!existsSync(workDir) || !statSync(workDir).isDirectory()) {
      throw new UsageError(`--work: ${workDir} is not a directory`);
    }

    const head = values.head;
    if (head === undefined || head.trim() === '') throw new UsageError('--head <sha> is required');

    const prNumberRaw = values.pr ?? '';
    const prNumber = prNumberRaw === '' ? 0 : Number.parseInt(prNumberRaw, 10);
    if (!Number.isFinite(prNumber)) throw new UsageError(`--pr: expected a number, got '${prNumberRaw}'`);

    const pr: PullRequestFacts = {
      repo: values.repo ?? '',
      number: prNumber,
      headSha: head.trim(),
      baseSha: (values.base ?? '').trim(),
      baseRef: values['base-ref'] ?? '',
      headRef: values['head-ref'] ?? '',
      authorLogin: values.author ?? '',
      body: values['body-file'] === undefined ? '' : readRequiredFile('--body-file', values['body-file']),
      title: values.title ?? '',
      commitMessages:
        values['commits-file'] === undefined
          ? []
          : parseCommitsFile(readRequiredFile('--commits-file', values['commits-file'])),
    };

    // `--install-only` is the "network is still on" half of an offline study
    // run: prepare the checkout now, gate it later with `--skip-install`.
    if (values['install-only'] === true) {
      const notes: string[] = [];
      await installOnly(workDir, pr, notes);
      process.stdout.write(`merge-evidence: install-only complete (${notes.length} note(s))\n`);
      return 0;
    }

    const out = values.out;
    if (out === undefined || out.trim() === '') throw new UsageError('--out <receipt.json> is required');

    const agentsOnly =
      values['agents-only'] === undefined ? undefined : parseBool('--agents-only', values['agents-only']);

    const policy = loadPolicy(workDir, values['policy-file'] ?? '.merge-evidence.yml');
    const baseRaw = values['base-comparison'];
    if (baseRaw !== undefined && baseRaw !== 'auto' && baseRaw !== 'never') {
      throw new UsageError(`--base-comparison: expected 'auto' or 'never', got '${baseRaw}'`);
    }
    const baseComparison = baseRaw as 'auto' | 'never' | undefined;
    const result = await evaluate({
      workDir,
      pr,
      policy,
      ...(values['test-command'] === undefined ? {} : { testCommand: values['test-command'] }),
      ...(agentsOnly === undefined ? {} : { agentsOnly }),
      ...(values['skip-install'] === true ? { skipInstall: true } : {}),
      ...(values['prefer-claimed-command'] === true ? { preferClaimedCommand: true } : {}),
      ...(baseComparison === undefined ? {} : { baseComparison }),
    });

    if (result.receiptJson !== undefined) writeFile(out, result.receiptJson);
    if (values.markdown !== undefined && result.rendered !== undefined) {
      writeFile(values.markdown, result.rendered.markdown);
    }

    // Written on every path, receipt or not: the harness reads this file to
    // decide what happened, and an absent file would be indistinguishable from
    // a crash.
    writeFile(
      `${out}.meta.json`,
      `${JSON.stringify(
        {
          verdict: result.verdict,
          skipped: result.skipped ?? null,
          agent: result.agent,
          unverifiable: result.unverifiable,
          notes: result.notes,
          title: result.rendered?.title ?? '',
        },
        null,
        2,
      )}\n`,
    );

    const totals = result.receipt?.observed.totals;
    process.stdout.write(
      `merge-evidence: verdict=${result.verdict} discrepancies=${result.discrepancies.length}` +
        ` tests=${totals?.passed ?? 0}/${totals?.run ?? 0} unverifiable=${result.unverifiable.length}\n`,
    );
    return 0;
  } catch (err) {
    // A usage mistake gets the sentence; anything else gets the stack, because
    // then it is the gate that broke and someone has to debug it.
    const detail =
      err instanceof UsageError ? err.message : err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`merge-evidence: ${detail}\n`);
    return 2;
  }
}

/**
 * Run only when this file is the process entry point — `require.main === module`
 * holds in the ncc bundle and is false when a test imports `main` instead. The
 * `typeof` guards keep the check harmless under an ESM loader, where neither
 * identifier exists.
 */
const isEntryPoint =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;

if (isEntryPoint) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
