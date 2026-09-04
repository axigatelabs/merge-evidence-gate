/**
 * The Action's GitHub API surface: everything that talks to github.com lives
 * here (and in `src/main.ts`), so the orchestration reads as a sequence of
 * intentions and the API details stay in one testable place.
 *
 * Both helpers are total. A fork PR runs with a read-only token, so listing
 * commits or posting a comment can fail with 403 and that must never fail the
 * gate: each function returns a degraded result carrying the error text, and the
 * caller turns it into a warning.
 */
import type { getOctokit } from '@actions/github';

export type Octokit = ReturnType<typeof getOctokit>;

/** The `owner`/`repo` pair every REST call needs. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** `"owner/name"` → `{ owner, repo }`; the second half may itself contain no slash. */
export function parseRepo(fullName: string): RepoRef {
  const slash = fullName.indexOf('/');
  if (slash < 0) return { owner: fullName, repo: '' };
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * True when the failure is GitHub refusing the token rather than a transient
 * fault — the expected shape on a fork PR, where `GITHUB_TOKEN` is read-only.
 */
export function isPermissionError(err: unknown): boolean {
  const status: unknown = (err as { status?: unknown } | null)?.status;
  if (status === 403 || status === 401 || status === 404) return true;
  return /\b(403|401|resource not accessible|read[- ]only)\b/i.test(errorText(err));
}

/**
 * Commit messages for the PR's first 100 commits, used to spot co-author
 * trailers that identify an agent. Returns an empty list (plus the error text)
 * when the API is unavailable — the detector simply sees one fewer signal.
 */
export async function listCommitMessages(
  octokit: Octokit,
  ref: RepoRef,
  pullNumber: number,
): Promise<{ messages: string[]; error?: string }> {
  try {
    const response = await octokit.rest.pulls.listCommits({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    const messages = response.data
      .map((entry) => entry.commit?.message)
      .filter((message): message is string => typeof message === 'string' && message.length > 0);
    return { messages };
  } catch (err) {
    return { messages: [], error: errorText(err) };
  }
}

/** What `upsertStickyComment` did, for the log line the Action prints. */
export interface CommentResult {
  action: 'created' | 'updated' | 'failed';
  url?: string;
  /** Set when `action` is `failed`. */
  error?: string;
  /** True when the failure was a permission refusal (fork PR, read-only token). */
  permissionDenied?: boolean;
}

/**
 * Post the receipt once and edit it thereafter.
 *
 * The comment carries a hidden HTML marker; every run lists the issue comments,
 * finds the first one containing that marker and updates it, so a PR that is
 * pushed to twenty times still shows exactly one receipt, always current.
 * Only comments authored by this token's identity are considered, so a human
 * quoting the marker cannot capture the gate's comment.
 */
export async function upsertStickyComment(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<CommentResult> {
  try {
    const existingId = await findStickyComment(octokit, ref, issueNumber, marker);
    if (existingId !== undefined) {
      const updated = await octokit.rest.issues.updateComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: existingId,
        body,
      });
      return { action: 'updated', url: updated.data.html_url };
    }
    const created = await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      body,
    });
    return { action: 'created', url: created.data.html_url };
  } catch (err) {
    const result: CommentResult = { action: 'failed', error: errorText(err) };
    if (isPermissionError(err)) result.permissionDenied = true;
    return result;
  }
}

/** Id of this PR's existing receipt comment, when one is already posted. */
async function findStickyComment(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  marker: string,
): Promise<number | undefined> {
  const pages = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  for (const comment of pages) {
    const body = comment.body ?? '';
    if (!body.includes(marker)) continue;
    // Bot-authored comments only: the marker is public text, and updating a
    // human's comment (which the token could not do anyway) would be wrong.
    const type = comment.user?.type;
    if (type !== undefined && type !== 'Bot' && type !== 'User') continue;
    return comment.id;
  }
  return undefined;
}
