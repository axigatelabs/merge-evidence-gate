/**
 * The receipt: the product's atom.
 *
 * `buildReceipt` is a pure projection of the reconciler's inputs and output into
 * the open `merge-evidence/receipt/v1` format (docs/receipt-spec.md). It is
 * deterministic — the same inputs and the same `now` produce byte-identical
 * JSON — and it records hashes rather than raw text, because attested receipts
 * land in a public transparency log.
 */

import { createHash } from 'node:crypto';

import type {
  AgentDetection,
  Claim,
  DiffAnalysis,
  Discrepancy,
  ObservedRun,
  Policy,
  PullRequestFacts,
  Receipt,
  Verdict,
} from '../types.js';
import { hasNoEvidence, missingAtHead } from './reconcile.js';

export interface BuildReceiptInput {
  pr: PullRequestFacts;
  agent: AgentDetection;
  claims: Claim[];
  observed: ObservedRun;
  diff: DiffAnalysis;
  discrepancies: Discrepancy[];
  verdict: Verdict;
  policy: Policy;
  /** Injectable clock so a receipt can be reproduced exactly. */
  now?: Date;
}

/** in-toto predicate type used when the receipt is attested. */
export const PREDICATE_TYPE = 'https://merge-evidence.dev/receipt/v1';

/** `sha256:<hex>` — the one hash format the receipt uses. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Digest over the executed test set: the ids, sorted and joined by newlines, so
 * a verifier can re-run the command and confirm the set without the raw log.
 */
export function testsDigest(tests: ReadonlyArray<{ id: string }>): string {
  return sha256(sortUnique(tests.map((test) => test.id)).join('\n'));
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Second-precision ISO-8601, as in the spec's example receipts. */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildReceipt(input: BuildReceiptInput): Receipt {
  const { pr, agent, claims, observed, diff, discrepancies, verdict, policy } = input;
  const bodyHash = sha256(pr.body);
  const noTestCommand = observed.noTestCommand === true;

  return {
    schema: 'merge-evidence/receipt/v1',
    generatedAt: isoSeconds(input.now ?? new Date()),
    pr: {
      repo: pr.repo,
      number: pr.number,
      head_sha: pr.headSha,
      base_sha: pr.baseSha,
      author: pr.authorLogin,
    },
    agent: { detected: agent.detected, signals: [...agent.signals].sort() },
    claims: claims.map((claim) => ({ ...claim, body_hash: bodyHash })),
    observed: {
      command: observed.command,
      exit_code: observed.exitCode,
      toolchain: sortKeys(observed.toolchain),
      totals: { ...observed.totals },
      tests_digest: testsDigest(observed.tests),
      duration_s: Math.round(observed.durationMs / 1000),
      ...(noTestCommand ? { no_test_command: true } : {}),
      ...(hasNoEvidence(observed) ? { no_evidence: true } : {}),
    },
    diff: {
      tests: {
        added: sortUnique(diff.testFiles.added),
        // Both kinds of disappearance: the test file the diff deleted, and the
        // test id that was enumerated at base but not at head.
        deleted: sortUnique([...diff.testFiles.deleted, ...missingAtHead(observed)]),
        skipped_added: sortUnique(diff.skipMarkersAdded.map((hit) => `${hit.file}: ${hit.marker}`)),
        focused: sortUnique(diff.focusMarkersAdded.map((hit) => `${hit.file}: ${hit.marker}`)),
      },
      sensitive_paths: sortUnique(diff.verificationLayerEdits.map((edit) => edit.file)),
      lockfiles: sortUnique(diff.dependencyFiles),
      snapshots: sortUnique(diff.snapshotFiles),
    },
    discrepancies: discrepancies.map((d) => ({ ...d, evidence: [...d.evidence] })),
    verdict,
    policy_version: policy.version,
    signature: { predicate_type: PREDICATE_TYPE },
  };
}

/** Stable key order for the toolchain map, so JSON.stringify is reproducible. */
function sortKeys(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
