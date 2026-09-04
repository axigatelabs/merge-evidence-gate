#!/usr/bin/env node
// Aggregate study receipts into the Claim–Reality Gap table.
//
//   node study/summarize.mjs [study/out]
//
// Per repository: PRs evaluated, verdict distribution, and every claim's outcome —
// Confirmed (mapped to the run and consistent), Unsupported (the gate could not
// map it; never counted against the author), Contradicted (a discrepancy names
// it) — plus which checks fired. Wording rule: no "lie"; agents have no intent.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? join(import.meta.dirname, 'out');
const repos = existsSync(root) ? readdirSync(root).filter((d) => !d.startsWith('.')) : [];
const rows = [];
const overall = { prs: 0, verdicts: {}, claims: 0, confirmed: 0, unsupported: 0, contradicted: 0, checks: {} };

for (const key of repos) {
  const dir = join(root, key);
  const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  const r = { repo: key.replace('__', '/'), prs: 0, verdicts: {}, claims: 0, confirmed: 0, unsupported: 0, contradicted: 0, checks: {}, agents: {} };
  for (const f of files) {
    let receipt, meta = {};
    try { receipt = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    try { meta = JSON.parse(readFileSync(join(dir, f.replace(/\.json$/, '.meta.json')), 'utf8')); } catch {}
    r.prs++;
    r.verdicts[receipt.verdict] = (r.verdicts[receipt.verdict] ?? 0) + 1;
    r.agents[receipt.agent?.detected ?? 'unknown'] = (r.agents[receipt.agent?.detected ?? 'unknown'] ?? 0) + 1;
    const contradictedIds = new Set((receipt.discrepancies ?? []).map((d) => d.claim).filter(Boolean));
    const unsupported = new Set(meta.unverifiable ?? []);
    for (const c of receipt.claims ?? []) {
      r.claims++;
      if (contradictedIds.has(c.id)) r.contradicted++;
      else if ([...unsupported].some((u) => u.includes(c.id) || u.includes(c.text))) r.unsupported++;
      else r.confirmed++;
    }
    for (const d of receipt.discrepancies ?? []) r.checks[d.check] = (r.checks[d.check] ?? 0) + 1;
  }
  rows.push(r);
  overall.prs += r.prs; overall.claims += r.claims; overall.confirmed += r.confirmed; overall.unsupported += r.unsupported; overall.contradicted += r.contradicted;
  for (const [k, v] of Object.entries(r.verdicts)) overall.verdicts[k] = (overall.verdicts[k] ?? 0) + v;
  for (const [k, v] of Object.entries(r.checks)) overall.checks[k] = (overall.checks[k] ?? 0) + v;
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const fmt = (o) => Object.entries(o).sort().map(([k, v]) => `${k}:${v}`).join(' ') || '–';
console.log('# Claim–Reality Gap — study summary\n');
console.log('| Repository | PRs | Verdicts | Claims | Confirmed | Unsupported | Contradicted | Checks fired | Agents |');
console.log('|---|---:|---|---:|---:|---:|---:|---|---|');
for (const r of rows) {
  console.log(`| ${r.repo} | ${r.prs} | ${fmt(r.verdicts)} | ${r.claims} | ${pct(r.confirmed, r.claims)} | ${pct(r.unsupported, r.claims)} | ${pct(r.contradicted, r.claims)} | ${fmt(r.checks)} | ${fmt(r.agents)} |`);
}
console.log(`| **All** | ${overall.prs} | ${fmt(overall.verdicts)} | ${overall.claims} | ${pct(overall.confirmed, overall.claims)} | ${pct(overall.unsupported, overall.claims)} | ${pct(overall.contradicted, overall.claims)} | ${fmt(overall.checks)} | |`);
console.log('\nPRs with at least one contradicted claim or a failing check are the headline; Unsupported claims are never counted against the author.');
