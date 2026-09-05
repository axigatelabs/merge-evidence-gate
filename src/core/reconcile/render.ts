/**
 * The one-screen receipt comment.
 *
 * Layout mirrors the block in README.md ("What the receipt looks like"): a
 * verdict title bound to the head sha, what the agent claimed next to what the
 * run observed, the verification-layer findings, and a footer pointing at the
 * machine-readable receipt and the exact rerun command. Everything is derived
 * from the receipt alone, so the comment can be regenerated from the artifact.
 *
 * The output is hard-capped at 8 KB — a PR comment is a summary, not a log.
 */

import type { Discrepancy, ParsedCommand, ParsedCount, Receipt, RenderedComment } from '../types.js';
import { claimsTestsAdded } from './reconcile.js';

/** Hidden marker used to find and update the same comment idempotently. */
export const COMMENT_MARKER = '<!-- merge-evidence-gate -->';
/** Hard cap on the rendered markdown. */
export const MAX_COMMENT_BYTES = 8000;
/** Hard cap on the check-run title. */
export const MAX_TITLE_CHARS = 120;

/** Longest a single rendered line may get before it is elided. */
const MAX_LINE_CHARS = 400;
/** Evidence items shown inline on a finding line. */
const MAX_INLINE_EVIDENCE = 3;

export interface RenderOptions {
  /** Claim ids (or free text) the reconciler could not map to the run. */
  unverifiable?: string[];
  /** Command a reader can run to reproduce; defaults to the observed command. */
  rerunCommand?: string;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function icon(severity: Discrepancy['severity']): string {
  return severity === 'fail' ? '✘' : severity === 'needs-human' ? '⚠' : '·';
}

/** `1m58s` / `58s`, from the receipt's whole-second duration. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

function inlineEvidence(evidence: readonly string[]): string {
  if (evidence.length === 0) return '';
  const shown = evidence.slice(0, MAX_INLINE_EVIDENCE);
  const rest = evidence.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} … and ${rest} more` : shown.join(', ');
}

function findingLine(discrepancy: Discrepancy): string {
  const detail = inlineEvidence(discrepancy.evidence);
  const body = detail === '' ? discrepancy.summary : `${discrepancy.summary} — ${detail}`;
  return clamp(`- ${icon(discrepancy.severity)} ${body}`, MAX_LINE_CHARS);
}

function commandOf(claim: Receipt['claims'][number]): ParsedCommand | undefined {
  return claim.parsed.kind === 'command' ? claim.parsed : undefined;
}

function countOf(claim: Receipt['claims'][number]): ParsedCount | undefined {
  return claim.parsed.kind === 'count' ? claim.parsed : undefined;
}

/** How a non-command claim reads on the comment: its own words, not its markup. */
function quoted(claim: Receipt['claims'][number]): string {
  const text = claim.parsed.kind === 'checkbox' ? claim.parsed.label : claim.text;
  return `"${text}"`;
}

/** "Claims vs observed": one line per command/count claim, plus unverifiables. */
function claimLines(receipt: Receipt, unverifiable: readonly string[]): string[] {
  const unmapped = new Set(unverifiable);
  const totals = receipt.observed.totals;
  const lines: string[] = [];
  const rendered = new Set<string>();

  for (const claim of receipt.claims) {
    const command = commandOf(claim);
    if (command !== undefined) {
      rendered.add(claim.id);
      const label = `\`${command.raw}\``;
      if (unmapped.has(claim.id)) {
        lines.push(clamp(`- ${label} — unverifiable`, MAX_LINE_CHARS));
        continue;
      }
      const failure = receipt.discrepancies.find((d) => d.check === 'C1' && d.claim === claim.id);
      if (failure !== undefined) {
        lines.push(
          clamp(
            `- ${label} — ran ✘  exit ${receipt.observed.exit_code}, ${totals.failed} failed`,
            MAX_LINE_CHARS,
          ),
        );
        continue;
      }
      lines.push(
        clamp(`- ${label} — ran ✔  ${totals.passed}/${totals.run} pass`, MAX_LINE_CHARS),
      );
      continue;
    }

    const count = countOf(claim);
    if (count !== undefined) {
      rendered.add(claim.id);
      if (unmapped.has(claim.id)) {
        lines.push(clamp(`- ${quoted(claim)} — unverifiable`, MAX_LINE_CHARS));
        continue;
      }
      const mismatch = receipt.discrepancies.find((d) => d.check === 'C2' && d.claim === claim.id);
      const claimed = count.total ?? count.passed ?? count.failed;
      const observed =
        count.total !== undefined
          ? totals.run
          : count.passed !== undefined
            ? totals.passed
            : totals.failed;
      const label = quoted(claim);
      lines.push(
        clamp(
          mismatch === undefined
            ? `- ${label} — counts match ✔`
            : `- ${label} — (claimed ${claimed ?? '?'} → observed ${observed}) ✘ count`,
          MAX_LINE_CHARS,
        ),
      );
      continue;
    }

    // A ticked "I have added tests" box is a claim about the diff (C7).
    if (claimsTestsAdded(claim)) {
      rendered.add(claim.id);
      const label = quoted(claim);
      if (unmapped.has(claim.id)) {
        lines.push(clamp(`- ${label} — unverifiable`, MAX_LINE_CHARS));
        continue;
      }
      const hit = receipt.discrepancies.find((d) => d.check === 'C7' && d.claim === claim.id);
      lines.push(
        clamp(
          hit === undefined
            ? `- ${label} — test files in the diff ✔`
            : `- ${label} — ${icon(hit.severity)} no test file added, modified, or renamed in the diff`,
          MAX_LINE_CHARS,
        ),
      );
      continue;
    }
  }

  // Anything the reconciler could not map that has no command/count line of its
  // own (an unparsed command, a prose checkbox) still gets a line, because
  // "unverifiable" is information for the reader, not a finding. Free-text
  // entries are the pipeline's notes ("runner: …", "diff: …"): they are shown
  // as they are, never suffixed as if they were claims.
  for (const entry of unverifiable) {
    if (rendered.has(entry)) continue;
    const claim = receipt.claims.find((c) => c.id === entry);
    lines.push(clamp(claim === undefined ? `- ${entry}` : `- ${quoted(claim)} — unverifiable`, MAX_LINE_CHARS));
  }

  return lines;
}

/** "Verification layer": C3/C4 hits, C5/C6 notes, and the clean ✔ lines. */
function verificationLines(receipt: Receipt): string[] {
  const lines: string[] = [];
  const of = (check: Discrepancy['check']): Discrepancy[] =>
    receipt.discrepancies.filter((d) => d.check === check);

  for (const discrepancy of [...of('C3'), ...of('C4')]) lines.push(findingLine(discrepancy));
  for (const discrepancy of [...of('C5'), ...of('C6')]) lines.push(findingLine(discrepancy));

  const markersClean =
    receipt.diff.tests.skipped_added.length === 0 && receipt.diff.tests.focused.length === 0;
  if (markersClean) lines.push('- ✔ no skip/only markers added');
  if (of('C5').length === 0) lines.push('- ✔ lockfile install OK');

  return lines;
}

function scopeLines(receipt: Receipt): string[] {
  return receipt.discrepancies.filter((d) => d.check === 'C8').map(findingLine);
}

export function renderComment(receipt: Receipt, opts?: RenderOptions): RenderedComment {
  const unverifiable = opts?.unverifiable ?? [];
  const sha7 = receipt.pr.head_sha.slice(0, 7);
  const headline = `**Merge-Evidence Gate — ${receipt.verdict}**  (head ${sha7})`;
  const title = clamp(`Merge-Evidence Gate — ${receipt.verdict}  (head ${sha7})`, MAX_TITLE_CHARS);
  const rerun = opts?.rerunCommand ?? receipt.observed.command;
  const footer =
    `Details: receipt.json (artifact) · rerun: \`${rerun}\` · ` +
    formatDuration(receipt.observed.duration_s);

  const body: string[] = [];
  const claims = claimLines(receipt, unverifiable);
  body.push('**Claims vs observed**');
  if (receipt.observed.no_test_command === true && claims.length > 0) {
    body.push(
      '- no test command found — claims about the run are unverifiable; ' +
        (receipt.verdict === 'NEUTRAL' ? 'the gate abstains' : 'the verdict rests on the diff alone'),
    );
  }
  if (receipt.observed.no_evidence === true) {
    body.push(
      `- the re-run produced no per-test evidence (exit ${receipt.observed.exit_code}) — ` +
        'claims about the run are unverifiable; ' +
        (receipt.verdict === 'NEUTRAL' ? 'the gate abstains' : 'the verdict rests on the diff alone'),
    );
  }
  body.push(
    ...(claims.length > 0
      ? claims
      : [
          receipt.observed.no_test_command === true
            ? receipt.verdict === 'NEUTRAL'
              ? '- no test command found — the gate abstains'
              : '- no test command found — the verdict rests on the diff alone'
            : '- no parseable claims in the PR body',
        ]),
  );
  body.push('', '**Verification layer**', ...verificationLines(receipt));

  const scope = scopeLines(receipt);
  if (scope.length > 0) body.push('', '**Scope**', ...scope);

  const assemble = (lines: readonly string[]): string =>
    [COMMENT_MARKER, headline, '', ...lines, '', footer].join('\n');

  let markdown = assemble(body);
  if (bytes(markdown) > MAX_COMMENT_BYTES) {
    const fits = (keep: number): boolean =>
      bytes(assemble([...body.slice(0, keep), `- … and ${body.length - keep} more`])) <=
      MAX_COMMENT_BYTES;
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    markdown = assemble([...body.slice(0, lo), `- … and ${body.length - lo} more`]);
    // Degenerate safety net: even the header/footer plus one note overflows.
    if (bytes(markdown) > MAX_COMMENT_BYTES) {
      markdown = assemble([]);
      while (bytes(markdown) > MAX_COMMENT_BYTES) markdown = markdown.slice(0, -1);
    }
  }

  return { marker: COMMENT_MARKER, markdown, title };
}
