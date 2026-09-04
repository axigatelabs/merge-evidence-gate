/**
 * Filesystem and process-shaped helpers for the Action.
 *
 * The core modules are pure by design: they take manifest contents, reporter
 * output and a `ChangedFile[]` as plain data. This module is the thin, testable
 * layer that produces that data from a real checkout — reading manifests,
 * reading a reporter file, probing toolchain versions, and turning raw `git
 * diff` output into `ChangedFile[]`.
 *
 * It deliberately avoids `@actions/*` (that stays in `src/main.ts` and
 * `src/action/github.ts`) so every function here can be unit-tested without a
 * runner environment. Everything degrades: a missing file, an unreadable
 * directory or an absent toolchain yields `undefined`/`{}` rather than throwing.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChangedFile } from '../core/types.js';

/**
 * Manifest filenames `detectTestCommand` knows how to read, plus the lockfiles
 * it uses to pick a package manager. Read as a set rather than globbed so the
 * gate never walks an untrusted tree.
 */
export const MANIFEST_FILES = [
  '.merge-evidence.yml',
  '.merge-evidence.yaml',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'pytest.ini',
  'setup.cfg',
  'uv.lock',
  'requirements.txt',
  'Cargo.toml',
  'Cargo.lock',
  '.config/nextest.toml',
] as const;

/** Read `path` as UTF-8, or `undefined` when it is missing or unreadable. */
export function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Contents of every known manifest present under `dir`, keyed by the filename
 * `detectTestCommand` expects. Absent files are simply not in the map.
 */
export function readManifests(dir: string): Record<string, string | undefined> {
  const files: Record<string, string | undefined> = {};
  for (const name of MANIFEST_FILES) {
    const contents = readTextFile(join(dir, name));
    if (contents !== undefined) files[name] = contents;
  }
  // `detectTestCommand` looks up the canonical `Makefile` key; GNU make also
  // accepts `makefile` and `GNUmakefile`, so alias whichever one exists.
  if (files['Makefile'] === undefined) {
    const alias = files['makefile'] ?? files['GNUmakefile'];
    if (alias !== undefined) files['Makefile'] = alias;
  }
  // Same for the config file, which the docs spell with either extension.
  if (files['.merge-evidence.yml'] === undefined && files['.merge-evidence.yaml'] !== undefined) {
    files['.merge-evidence.yml'] = files['.merge-evidence.yaml'];
  }
  return files;
}

/**
 * The machine-readable reporter output at `path`, or `undefined` when the run
 * produced none (crashed runner, wrong reporter, unsupported family).
 */
export function readReport(path: string): string | undefined {
  const raw = readTextFile(path);
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw;
}

// ---------------------------------------------------------------------------
// Toolchain probes
// ---------------------------------------------------------------------------

interface Probe {
  key: string;
  argv: [string, ...string[]];
  /** Pull the bare version out of the tool's banner line. */
  extract(output: string): string | undefined;
}

const SEMVERISH = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/;

function firstVersion(output: string): string | undefined {
  return SEMVERISH.exec(output)?.[1];
}

const PROBES: Probe[] = [
  { key: 'node', argv: ['node', '--version'], extract: firstVersion },
  { key: 'go', argv: ['go', 'version'], extract: firstVersion },
  { key: 'python', argv: ['python3', '--version'], extract: firstVersion },
  { key: 'python', argv: ['python', '--version'], extract: firstVersion },
  { key: 'cargo', argv: ['cargo', '--version'], extract: firstVersion },
];

/**
 * Versions of the toolchains present on the runner, e.g. `{ node: "24.4.0" }`.
 *
 * Every probe is best-effort: a tool that is absent, slow or that exits non-zero
 * is left out of the map instead of failing the run. Some tools print their
 * banner on stderr (python < 3.4, cargo in some shells), so both streams are
 * considered. The first probe to answer for a key wins, which is why `python3`
 * is tried before `python`.
 */
export function probeToolchain(cwd: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const probe of PROBES) {
    if (versions[probe.key] !== undefined) continue;
    const [file, ...args] = probe.argv;
    try {
      const result = spawnSync(file, args, {
        cwd,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
      if (result.status !== 0) continue;
      const version = probe.extract(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
      if (version !== undefined) versions[probe.key] = version;
    } catch {
      // Tool missing or not executable — nothing to record.
    }
  }
  return versions;
}

// ---------------------------------------------------------------------------
// git diff → ChangedFile[]
// ---------------------------------------------------------------------------

const STATUS_CODES = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

/**
 * Undo git's C-style path quoting (`core.quotePath`), which kicks in for paths
 * containing spaces, quotes or non-ASCII bytes.
 */
function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const inner = value.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    i += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      default: {
        // Octal escape for a raw byte, e.g. \303\251 for "é".
        const octal = inner.slice(i, i + 3);
        if (/^[0-7]{3}$/.test(octal)) {
          out += String.fromCharCode(Number.parseInt(octal, 8));
          i += 2;
        } else if (next !== undefined) {
          out += next;
        }
      }
    }
  }
  // Octal escapes are UTF-8 bytes; re-decode so multi-byte characters survive.
  try {
    return Buffer.from(out, 'binary').toString('utf8');
  } catch {
    return out;
  }
}

/** The path a `git diff` file section is about, from its `---`/`+++` headers. */
function patchPath(section: string): string | undefined {
  const lines = section.split('\n');
  let fromPath: string | undefined;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') return unquotePath(stripPrefix(value));
    } else if (line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') fromPath = unquotePath(stripPrefix(value));
    } else if (line.startsWith('@@')) {
      break;
    }
  }
  if (fromPath !== undefined) return fromPath;
  // Binary files and pure mode changes have no `---`/`+++` headers; fall back to
  // the `diff --git a/x b/x` line, which is unambiguous when both sides match.
  const header = /^diff --git a\/(.+) b\/\1$/m.exec(section);
  return header?.[1] !== undefined ? unquotePath(header[1]) : undefined;
}

/** `a/src/x.ts` → `src/x.ts`; quoted paths keep their quotes for `unquotePath`. */
function stripPrefix(value: string): string {
  if (value.startsWith('"')) return `"${value.slice(1).replace(/^[ab]\//, '')}`;
  return value.replace(/^[ab]\//, '');
}

/** Split `git diff` output into one text section per file. */
function splitPatches(patchesText: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (patchesText.trim().length === 0) return byPath;
  const sections = patchesText.split(/^(?=diff --git )/m);
  for (const section of sections) {
    if (!section.startsWith('diff --git ')) continue;
    const path = patchPath(section);
    if (path === undefined) continue;
    const trimmed = section.replace(/\n+$/, '\n');
    const existing = byPath.get(path);
    byPath.set(path, existing === undefined ? trimmed : `${existing}${trimmed}`);
  }
  return byPath;
}

/**
 * Build the `ChangedFile[]` the diff module consumes from raw git output.
 *
 * `text` is `git diff --name-status <base>...<head>` (tab-separated, with a
 * similarity score on R/C rows and a second path column for renames and copies);
 * `patchesText` is the corresponding `git diff --unified=0` output, which is
 * split per file and attached so the content detectors can scan added lines.
 *
 * Pure and total: unparsable lines are skipped, a file with no patch simply has
 * no `patch`, and a rename records both sides. `-z`-style NUL separators are
 * accepted as well as newlines, so the caller may use either form.
 */
export function parseNameStatus(text: string, patchesText = ''): ChangedFile[] {
  const patches = splitPatches(patchesText);
  const files: ChangedFile[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, '\t').trim();
    if (line.length === 0) continue;
    const parts = line.split('\t').filter((part) => part.length > 0);
    const rawStatus = parts[0];
    if (rawStatus === undefined) continue;
    const code = rawStatus[0]?.toUpperCase();
    if (code === undefined || !STATUS_CODES.has(code)) continue;

    const isPair = code === 'R' || code === 'C';
    const from = parts[1] === undefined ? undefined : unquotePath(parts[1]);
    const to = parts[2] === undefined ? undefined : unquotePath(parts[2]);
    const path = isPair ? to ?? from : from;
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);

    const patch = patches.get(path);
    const file: ChangedFile = { path, status: code as ChangedFile['status'] };
    if (isPair && from !== undefined && from !== path) file.oldPath = from;
    if (patch !== undefined) file.patch = patch;
    files.push(file);
  }

  return files;
}
