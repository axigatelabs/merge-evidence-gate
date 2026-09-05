#!/usr/bin/env node
// Aggregate study receipts into the Claim–Reality Gap table.
//
//   node study/summarize.mjs [study/out]
//
// The table only scores what the gate actually checked. A claim is CHECKABLE
// when a rule can confirm or contradict it against the re-run or the diff:
// command and count claims (C1/C2) and a ticked "tests added" box (C7). Every
// other checkbox and caveat is STATED — reported, never scored, because the
// gate has no rule for it; calling those "confirmed" would inflate the numbers.
//
// Outcomes of a checkable claim: Confirmed (mapped to the run or the diff and
// consistent), Unsupported (the gate could not map it — listed in the receipt's
// `unverifiable` sidecar; never counted against the author), Contradicted (a
// discrepancy names it). Wording rule: no "lie".
//
// A PR whose run produced no per-test evidence is INCONCLUSIVE for the run:
// its command/count claims are unsupported. Its diff-based findings (C3–C8)
// still count — the reconciler decides those without a run — so such a PR can
// still be flagged, and its verdict is tallied like any other.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? join(import.meta.dirname, 'out');
const repos = existsSync(root) ? readdirSync(root).filter((d) => !d.startsWith('.')) : [];

// Verbatim copies of TESTS_ADDED_LABEL / TESTS_ADDED_NEGATION in
// src/core/reconcile/reconcile.ts; test/reconcile/no-evidence-and-c7.test.ts
// fails if they drift.
const TESTS_ADDED =
  /\b(?:added|adds|wrote|written|created|introduced|implemented)(?:\/(?:updated|extended|adjusted|improved|expanded|fixed))?(?:\s+(?:a|an|the|some|new|more|additional|meaningful|comprehensive|thorough|unit|integration|regression|e2e|end-to-end|corresponding|relevant|appropriate|missing|extra|basic|initial|proper|automated|dedicated|targeted|several|two|three|few))*\s+(?:tests|test\s+cases?|test\s+coverage|test\s+for)\b|^\s*(?:new|additional|more|missing|corresponding|unit|integration|regression|e2e)?\s*tests\s+(?:were\s+|have\s+been\s+)?(?:added|created)\b/i;
const NEGATED =
  /\b(?:no|not|none|without|n\/a|todo|later|follow-?up|exempt|optional|unless)\b|n't\b|\b(?:if|where|when|as)\s+(?:applicable|appropriate|needed|necessary|relevant|required)\b|\bif\s+\w+ing\b|\bonly\s+if\b|\bor\s+(?:this|the|it|we|i)\b|\b(?:another|separate|previous|earlier|prior|different|other|upstream)\s+(?:PR|pull\s+request|change|changeset|commit|branch)\b|\bin\s+#\d+|:\s*(?:0|zero|none)\b/i;
const isCheckable = (c) =>
  c.kind === 'command' ||
  c.kind === 'count' ||
  (c.kind === 'checkbox' && c.parsed?.checked === true && TESTS_ADDED.test(c.parsed.label ?? '') && !NEGATED.test(c.parsed.label ?? ''));

const fresh = () => ({
  prs: 0, inconclusive: 0, verdicts: {}, agents: {},
  checkable: 0, confirmed: 0, unsupported: 0, contradicted: 0, stated: 0,
  flagged: 0, checks: {},
});
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

const rows = [];
const all = fresh();

for (const key of repos) {
  const dir = join(root, key);
  const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  const r = { repo: key.replace('__', '/'), ...fresh() };
  for (const f of files) {
    let receipt, meta = {};
    try { receipt = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    try { meta = JSON.parse(readFileSync(join(dir, f.replace(/\.json$/, '.meta.json')), 'utf8')); } catch {}
    r.prs++;
    const o = receipt.observed ?? {};
    // The receipt says so (observed.no_evidence, v0.2+). Receipts written before
    // that field existed: zero tests and an exit of 128+ means the runner was
    // killed before it wrote its report.
    const runInconclusive =
      o.no_evidence === true || o.no_test_command === true ||
      (o.no_evidence === undefined && (o.totals?.run ?? 0) === 0 && (o.exit_code ?? 0) >= 128);
    if (runInconclusive) r.inconclusive++;

    bump(r.verdicts, receipt.verdict);
    bump(r.agents, receipt.agent?.detected ?? 'unknown');
    const named = new Set((receipt.discrepancies ?? []).map((d) => d.claim).filter(Boolean));
    const unsupported = new Set(meta.unverifiable ?? []);
    for (const c of receipt.claims ?? []) {
      if (!isCheckable(c)) { r.stated++; continue; }
      r.checkable++;
      // A run that produced no evidence cannot confirm or contradict a claim
      // ABOUT the run (command, count), whatever an older receipt recorded;
      // a "tests added" box is decided by the diff and is unaffected.
      if (runInconclusive && c.kind !== 'checkbox') r.unsupported++;
      else if (named.has(c.id)) r.contradicted++;
      else if (unsupported.has(c.id)) r.unsupported++;
      else r.confirmed++;
    }
    for (const d of receipt.discrepancies ?? []) bump(r.checks, d.check);
    const flaggedPr = (receipt.discrepancies ?? []).some(
      (d) => d.claim !== undefined || ((d.check === 'C3' || d.check === 'C4') && d.severity !== 'info'),
    );
    if (flaggedPr) r.flagged++;
  }
  rows.push(r);
  for (const k of ['prs', 'inconclusive', 'checkable', 'confirmed', 'unsupported', 'contradicted', 'stated', 'flagged']) all[k] += r[k];
  for (const [k, v] of Object.entries(r.verdicts)) all.verdicts[k] = (all.verdicts[k] ?? 0) + v;
  for (const [k, v] of Object.entries(r.checks)) all.checks[k] = (all.checks[k] ?? 0) + v;
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const fmt = (o) => Object.entries(o).sort().map(([k, v]) => `${k}:${v}`).join(' ') || '–';
const line = (name, r) =>
  `| ${name} | ${r.prs} | ${r.inconclusive} | ${fmt(r.verdicts)} | ${r.checkable} | ${pct(r.confirmed, r.checkable)} | ${pct(r.unsupported, r.checkable)} | ${pct(r.contradicted, r.checkable)} | ${r.stated} | ${r.flagged} | ${fmt(r.checks)} |`;

console.log('# Claim–Reality Gap — study summary\n');
console.log('| Repository | PRs | Run inconclusive | Verdicts | Checkable claims | Confirmed | Unsupported | Contradicted | Stated, not checkable | PRs flagged | Checks fired |');
console.log('|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|');
for (const r of rows) console.log(line(`${r.repo} (${fmt(r.agents)})`, r));
console.log(line('**All**', all));
console.log('\n- **Run inconclusive**: the re-run produced no per-test evidence (the sandbox killed the runner, or a toolchain is missing), so command and count claims are unsupported. Diff-based findings still count; NEUTRAL is the verdict when nothing else fired.');
console.log('- **Checkable**: command and count claims, and a ticked "tests added" box — the claims a rule can confirm or contradict against the re-run or the diff.');
console.log('- **Stated, not checkable**: every other checkbox and caveat. Reported so the reader sees how much of a PR body is unverifiable by construction; never scored.');
console.log('- **PRs flagged**: at least one contradicted claim, or a verification-layer finding (C3/C4) above info. This is the headline, not the share of green receipts.');
