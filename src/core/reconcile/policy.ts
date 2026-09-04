/**
 * Severity policy for the gate.
 *
 * The defaults are the v1 near-zero-false-positive behaviour documented in
 * docs/receipt-spec.md ("Verdict policy (v1 defaults)"). A repository tunes them
 * with a `.merge-evidence.yml` at its root; `parsePolicyYaml` reads the small,
 * fixed subset of YAML that file is allowed to use, so the Action needs no YAML
 * dependency and the parse is deterministic and auditable.
 */

import type { CheckId, Policy, Severity } from '../types.js';

/** Every check the reconciler can emit, in receipt order. */
export const CHECK_IDS: readonly CheckId[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];

/** The v1 defaults; severities exactly as docs/receipt-spec.md. */
export const DEFAULT_POLICY: Policy = {
  version: '1.0.0',
  severity: {
    C1: 'fail',
    C2: 'needs-human',
    C3: 'fail',
    C4: 'fail',
    C5: 'needs-human',
    C6: 'needs-human',
    C7: 'needs-human',
    C8: 'info',
  },
  agentsOnly: true,
};

/**
 * The severity a check carries under `policy`, falling back to the v1 default
 * when the policy does not override it. Unknown checks are never silently
 * upgraded to a merge blocker — the fallback of last resort is `info`.
 */
export function resolveSeverity(check: CheckId, policy: Policy): Severity {
  return policy.severity?.[check] ?? DEFAULT_POLICY.severity?.[check] ?? 'info';
}

/**
 * A parsed `.merge-evidence.yml`. It is a `Policy` plus the one config key that
 * is not a policy knob — the explicit test command, which the runner module
 * consumes. Returning a subtype keeps `parsePolicyYaml(...)` usable anywhere a
 * `Policy` is expected without widening the shared contract in types.ts.
 */
export interface ParsedPolicy extends Policy {
  /** `test-command:` — the command to execute instead of auto-detecting one. */
  testCommand?: string;
}

const SEVERITIES: readonly Severity[] = ['fail', 'needs-human', 'info'];

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

function isCheckId(value: string): value is CheckId {
  return (CHECK_IDS as readonly string[]).includes(value);
}

/** Width of the leading run of spaces; tabs are not indentation in YAML. */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  return n;
}

/**
 * Drop a trailing `# comment`. A `#` only starts a comment at the start of the
 * line or after whitespace, and never inside a quoted scalar.
 */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Unwrap a quoted scalar; plain scalars are returned trimmed. */
function scalar(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && last === first) return text.slice(1, -1);
  }
  return text;
}

function parseBoolean(raw: string): boolean | undefined {
  const text = scalar(raw).toLowerCase();
  if (text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === 'no' || text === 'off') return false;
  return undefined;
}

interface Entry {
  indent: number;
  key: string;
  /** Text after the first `: ` — empty when the key opens a block. */
  value: string;
  /** True for a `- item` sequence entry; `key` is then empty. */
  isItem: boolean;
  itemValue: string;
}

function tokenize(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line.trim() === '' || line.trim() === '---') continue;
    const indent = indentOf(line);
    const body = line.trim();
    if (body.startsWith('- ') || body === '-') {
      entries.push({ indent, key: '', value: '', isItem: true, itemValue: scalar(body.slice(1)) });
      continue;
    }
    const colon = body.indexOf(':');
    if (colon < 0) continue; // not a mapping line — the subset ignores it
    entries.push({
      indent,
      key: body.slice(0, colon).trim(),
      value: body.slice(colon + 1).trim(),
      isItem: false,
      itemValue: '',
    });
  }
  return entries;
}

/**
 * Parse the `.merge-evidence.yml` subset: top-level `key: value`, a nested
 * `severity:` map, and a `scope-allow:` sequence of `- item` lines. Anything
 * else in the file is ignored rather than rejected, so a config written for a
 * later version still yields a usable policy.
 */
export function parsePolicyYaml(text: string): ParsedPolicy {
  const entries = tokenize(text);
  const policy: ParsedPolicy = { version: DEFAULT_POLICY.version };
  const severity: Partial<Record<CheckId, Severity>> = {};
  const scopeAllow: string[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined || entry.isItem || entry.indent !== 0) continue;

    switch (entry.key) {
      case 'version': {
        const value = scalar(entry.value);
        if (value !== '') policy.version = value;
        break;
      }
      case 'test-command': {
        const value = scalar(entry.value);
        if (value !== '') policy.testCommand = value;
        break;
      }
      case 'agents-only': {
        const value = parseBoolean(entry.value);
        if (value !== undefined) policy.agentsOnly = value;
        break;
      }
      case 'severity': {
        for (let j = i + 1; j < entries.length; j += 1) {
          const child = entries[j];
          if (child === undefined || child.indent === 0) break;
          if (child.isItem) continue;
          const value = scalar(child.value);
          if (isCheckId(child.key) && isSeverity(value)) severity[child.key] = value;
        }
        break;
      }
      case 'scope-allow': {
        for (let j = i + 1; j < entries.length; j += 1) {
          const child = entries[j];
          if (child === undefined || child.indent === 0) break;
          if (!child.isItem) break;
          if (child.itemValue !== '') scopeAllow.push(child.itemValue);
        }
        break;
      }
      default:
        break;
    }
  }

  if (Object.keys(severity).length > 0) policy.severity = severity;
  if (scopeAllow.length > 0) policy.scopeAllow = scopeAllow;
  return policy;
}
