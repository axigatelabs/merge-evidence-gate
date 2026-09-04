/**
 * Agent detection — "does this PR look agent-authored?"
 *
 * Four independent signal families fire against the PR facts. Each is a hint,
 * never proof, so every hit is reported: a body that carries both a Claude
 * footer and a Codex link reports `body-marker:claude` AND `body-marker:codex`.
 * `AgentDetection.signals` entries are therefore `"<family>:<agent>"` strings,
 * which keeps the family names from docs/receipt-spec.md while preserving which
 * agent each hit pointed at.
 *
 * `detected` is the agent behind the STRONGEST family that fired, using the
 * precedence login > branch-prefix > coauthor-trailer > body-marker. Within one
 * family (two markers in the same body) the table order below breaks the tie.
 *
 * Pure: no I/O, no network, no @actions/* — see src/core/types.ts.
 */
import type { AgentDetection, AgentKind, PullRequestFacts } from '../types.js';

/** Signal families, strongest first. `detected` takes the first one that fired. */
const FAMILIES = ['login', 'branch-prefix', 'coauthor-trailer', 'body-marker'] as const;
type Family = (typeof FAMILIES)[number];

/** Bot accounts the agents open PRs from. Compared case-insensitively, in full. */
const LOGINS: ReadonlyArray<readonly [needle: string, agent: AgentKind]> = [
  ['copilot-swe-agent[bot]', 'copilot'],
  ['devin-ai-integration[bot]', 'devin'],
  ['claude[bot]', 'claude'],
  ['cursor[bot]', 'cursor'],
  ['opencode-agent[bot]', 'opencode'],
];

/** Head-branch namespaces the agents push to, e.g. `copilot/fix-flaky-test`. */
const BRANCH_PREFIXES: ReadonlyArray<readonly [needle: string, agent: AgentKind]> = [
  ['copilot/', 'copilot'],
  ['devin/', 'devin'],
  ['cursor/', 'cursor'],
  ['claude/', 'claude'],
  ['codex/', 'codex'],
];

/** Vendor markers and footers agents leave in the PR body. Substring match. */
const BODY_MARKERS: ReadonlyArray<readonly [needle: string, agent: AgentKind]> = [
  ['<!-- START COPILOT CODING AGENT', 'copilot'],
  ['app.devin.ai/sessions/', 'devin'],
  ['Generated with [Claude Code]', 'claude'],
  ['claude.ai/code/session', 'claude'],
  ['ccr-projects-attribution', 'claude'],
  ['cursor.com/agents/', 'cursor'],
  ['CURSOR_AGENT_PR_BODY_BEGIN', 'cursor'],
  ['chatgpt.com/codex/tasks/', 'codex'],
];

/** Commit-message trailers the agents sign with. Substring match on any commit. */
const COAUTHOR_TRAILERS: ReadonlyArray<readonly [needle: string, agent: AgentKind]> = [
  ['Co-Authored-By: Claude', 'claude'],
  ['Co-authored-by: Copilot', 'copilot'],
  ['Cursor Agent <cursoragent@cursor.com>', 'cursor'],
];

/** One hit: which family fired and which agent it pointed at. */
interface Hit {
  family: Family;
  agent: AgentKind;
}

/**
 * Every table entry whose needle is present in `haystack`, in table order.
 * Everything is lowercased first: GitHub logins and branch names are
 * case-insensitive, and trailer/marker casing varies between agent versions
 * (`Co-Authored-By` vs `Co-authored-by`), so a single rule covers all of them.
 */
function hitsFrom(
  family: Family,
  table: ReadonlyArray<readonly [string, AgentKind]>,
  haystack: string,
  match: (hay: string, needle: string) => boolean,
): Hit[] {
  const hay = haystack.toLowerCase();
  const hits: Hit[] = [];
  for (const [needle, agent] of table) {
    if (match(hay, needle.toLowerCase())) hits.push({ family, agent });
  }
  return hits;
}

const isEqual = (hay: string, needle: string): boolean => hay.trim() === needle;
const hasPrefix = (hay: string, needle: string): boolean => hay.trim().startsWith(needle);
const contains = (hay: string, needle: string): boolean => hay.includes(needle);

export function detectAgent(pr: PullRequestFacts): AgentDetection {
  const hits: Hit[] = [
    ...hitsFrom('login', LOGINS, pr.authorLogin, isEqual),
    ...hitsFrom('branch-prefix', BRANCH_PREFIXES, pr.headRef, hasPrefix),
    // Trailers live in commit messages, so all commits are searched as one blob.
    ...hitsFrom('coauthor-trailer', COAUTHOR_TRAILERS, pr.commitMessages.join('\n'), contains),
    ...hitsFrom('body-marker', BODY_MARKERS, pr.body, contains),
  ];

  // The same agent can be named by two markers (Claude has three); report the
  // family/agent pair once.
  const signals: string[] = [];
  for (const hit of hits) {
    const signal = `${hit.family}:${hit.agent}`;
    if (!signals.includes(signal)) signals.push(signal);
  }

  // `hits` is already built in family-precedence order, and each family's hits
  // are in table order, so the first hit is the strongest single signal.
  const strongest = hits[0];

  return {
    detected: strongest ? strongest.agent : 'unknown',
    signals,
    isAgent: hits.length > 0,
  };
}
