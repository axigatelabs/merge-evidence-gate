/**
 * Claim extraction — "what did the agent SAY it did?"
 *
 * A deterministic markdown reader: no LLM, no network, no I/O. It walks the PR
 * body line by line, tracks the current heading, and emits one Claim per thing
 * the body actually asserts. Claims are numbered c1, c2, … in document order.
 *
 * The bias is deliberate: a phrase that cannot be parsed confidently is dropped
 * rather than guessed at. An unverifiable claim is never held against the author
 * (docs/receipt-spec.md, "Unverifiable ≠ failed"), but an invented one would be.
 *
 * Two regions of the body are treated as non-assertions and skipped entirely:
 *   - fenced code blocks — pasted tool output, not a statement by the agent
 *     (and their `# comment` lines would otherwise read as markdown headings);
 *   - HTML comments — vendor scaffolding the reader never sees.
 */
import type {
  Claim,
  ParsedCaveat,
  ParsedCheckbox,
  ParsedCommand,
  ParsedCount,
  ParsedTest,
  PullRequestFacts,
  RunnerFamily,
} from '../types.js';

// ---------------------------------------------------------------------------
// Line-level structure
// ---------------------------------------------------------------------------

/** ``` or ~~~ opening/closing a fenced code block (up to 3 spaces of indent). */
const FENCE = /^ {0,3}(?:```|~~~)/;
/** An ATX heading: "## Test plan" → section "Test plan". */
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
/** "- [x] label" / "* [ ] label" — the checkbox claim. */
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/;
/** An inline-code span: `go test ./...`. Backticks are excluded from the body. */
const INLINE_CODE = /`([^`\n]+)`/g;

// ---------------------------------------------------------------------------
// command claims
// ---------------------------------------------------------------------------

/**
 * Command openings we recognise, mapped to the runner family that would produce
 * machine-readable output for them. Longer openings come first so that
 * `npm run test` is preferred over `npm test` when both could match.
 * Build tools with no single family (gradle, maven, dotnet, ad-hoc scripts) are
 * still captured as commands, but with runner 'unknown'.
 */
const COMMAND_PREFIXES: ReadonlyArray<readonly [prefix: string, runner: RunnerFamily | 'unknown']> = [
  ['python -m pytest', 'pytest'],
  ['pytest', 'pytest'],
  ['go test', 'go'],
  ['npm run test', 'npm'],
  ['npm test', 'npm'],
  ['pnpm test', 'npm'],
  ['yarn test', 'npm'],
  ['bun run test', 'npm'],
  ['bun test', 'npm'],
  ['cargo nextest', 'cargo'],
  ['cargo test', 'cargo'],
  ['make test', 'make'],
  ['vitest', 'vitest'],
  ['jest', 'jest'],
  ['./gradlew', 'unknown'],
  ['dotnet test', 'unknown'],
  ['mvn', 'unknown'],
];

/** Any repo-local test script, e.g. `scripts/test.sh`, `./scripts/test-e2e.sh`. */
const TEST_SCRIPT = /^(?:\.\/)?scripts\/test[^\s]*\.sh/;

/**
 * What may stand in front of a test command without changing what it is:
 * `VAR=value` assignments and the wrappers that run a tool from a project
 * environment — `uv run pytest …`, `poetry run pytest …`, `npx vitest …`,
 * `pnpm exec jest …`, `yarn vitest …`, `bunx vitest …`. The wrapper stays in
 * the claim's `raw` text (that is what gets re-run); only the match starts
 * after it.
 */
const COMMAND_WRAPPERS =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:(?:uv|poetry|pipenv|pdm|hatch|rye)\s+run\s+(?:--no-sync\s+|--frozen\s+)*|npx\s+(?:--no-install\s+|--yes\s+|-y\s+)*|pnpm\s+(?:exec|dlx)\s+|yarn\s+(?:exec\s+)?|bunx\s+|bun\s+x\s+)?/;

/**
 * `<your_test_file>`, `<path>`: a template placeholder. A command carrying one
 * is the repository's PR template showing how to test, not a statement that
 * the author ran anything.
 */
const PLACEHOLDER = /<[^<>\s]+>/;

/** Flags whose value is a test-name filter: `-run X`, `-k X`, `-t X`, `--grep X`. */
const NAME_FILTER_FLAGS = new Set(['-run', '--run', '-k', '-t', '--grep']);
/** Flags whose value selects a package/path: `cargo test -p my-crate`. */
const PACKAGE_FLAGS = new Set(['-p', '--package']);

/** A bare token that names a source file even without a slash, e.g. test_login.py. */
const SOURCE_FILE = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|rb|php|cs|swift|scala)$/;

/**
 * The recognised opening of `raw`, or undefined when it is not a test command.
 * A prefix only counts when the next character cannot continue an identifier,
 * so `go test` matches "go test ./..." and "bun run test" matches
 * "bun run test:unit", but neither matches "go testdata".
 */
function matchCommandPrefix(
  raw: string,
): { prefix: string; runner: RunnerFamily | 'unknown'; offset: number } | undefined {
  if (PLACEHOLDER.test(raw)) return undefined;
  // First as written (`yarn test` is a package script, not `yarn` wrapping
  // `test`); then with any env assignments and runner wrapper stepped over.
  for (const offset of [0, COMMAND_WRAPPERS.exec(raw)?.[0].length ?? 0]) {
    const core = raw.slice(offset);
    for (const [prefix, runner] of COMMAND_PREFIXES) {
      if (!core.startsWith(prefix)) continue;
      const next = core.charAt(prefix.length);
      if (next === '' || !/[A-Za-z0-9_-]/.test(next)) return { prefix, runner, offset };
    }
    const script = TEST_SCRIPT.exec(core);
    if (script) return { prefix: script[0], runner: 'unknown', offset };
  }
  return undefined;
}

/**
 * One command argument. A run of non-space characters, except that a quoted
 * section may contain spaces — so `--grep "two words"` yields two tokens and
 * `--grep="two words"` yields one.
 */
const ARGUMENT = /(?:[^\s'"]+|"[^"]*"|'[^']*')+/g;

const tokenize = (args: string): string[] => args.match(ARGUMENT) ?? [];

function unquote(token: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(token);
  return quoted?.[2] ?? token;
}

/** Path/package selectors: `./...`, `pkg/x/...`, `tests/test_auth.py`, `test_login.py`. */
function looksLikePath(token: string): boolean {
  if (token === '...' || token.endsWith('/...')) return true;
  if (token.includes('/')) return true;
  return SOURCE_FILE.test(token);
}

/** Split the arguments after the recognised opening into paths and name filters. */
function parseCommand(
  raw: string,
  prefix: string,
  runner: RunnerFamily | 'unknown',
  offset = 0,
): ParsedCommand {
  const paths: string[] = [];
  const nameFilters: string[] = [];
  const tokens = tokenize(raw.slice(offset + prefix.length));

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    // `--grep=foo` / `-p=my-crate`
    const equals = token.startsWith('-') ? token.indexOf('=') : -1;
    if (equals > 0) {
      const flag = token.slice(0, equals);
      const value = unquote(token.slice(equals + 1));
      if (value.length > 0 && NAME_FILTER_FLAGS.has(flag)) nameFilters.push(value);
      else if (value.length > 0 && PACKAGE_FLAGS.has(flag)) paths.push(value);
      continue;
    }

    // `--grep foo` / `-p my-crate` — the value is the next token.
    if (NAME_FILTER_FLAGS.has(token) || PACKAGE_FLAGS.has(token)) {
      const value = tokens[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        (NAME_FILTER_FLAGS.has(token) ? nameFilters : paths).push(unquote(value));
        i += 1;
      }
      continue;
    }

    if (token.startsWith('-')) continue; // any other flag, and the `--` separator
    if (looksLikePath(token)) paths.push(token);
    // Bare non-path words (`clean build`, a cargo test substring) stay unclaimed.
  }

  return { kind: 'command', runner, raw, paths, nameFilters };
}

// ---------------------------------------------------------------------------
// count claims
// ---------------------------------------------------------------------------

/**
 * One "<number> <noun>" pair, e.g. "68 tests", "0 failures", "11 related tests".
 * A short whitelist of adjectives is allowed between the two so that counts read
 * from real bodies ("(11 related tests)") still parse, without matching arbitrary
 * prose that happens to put a number near the word "test".
 */
const COUNT_TOKEN =
  /(\d+)\s+(?:(?:related|new|existing|additional|unit|integration|total)\s+)?(passed|passing|passes|pass|failures|failure|failed|failing|fails|fail|errors|error|skipped|skips|skip|ignored|tests|test|total)\b/gi;

/** Text allowed between two pairs that belong to the same count, e.g. ", " or " and ". */
const COUNT_JOINER = /^[\s,;/|]*(?:and|with|but)?[\s,;/|]*$/i;

/**
 * A quoted span on a line: `"Claimed 1480 total; 0 observed"`. A count inside
 * quotation marks is someone else's words being cited, not an assertion about
 * this pull request's run.
 */
const QUOTED_SPAN = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g;

/**
 * Vocabulary of a line that compares runs or reports on another one — "head
 * 203 failures, base ffc6440 the same 203", "observed 6 failures before the
 * fix". Counts on such a line describe a comparison, not the run this pull
 * request claims to have made, so they are left out rather than checked
 * against the wrong thing.
 */
const COMPARISON_LINE =
  /\b(?:observed|claimed|at base|at head|vs\.?|versus|previously|before this|before the fix|under \d)\b|\bhead\b.*\bbase\b|\bbase\b.*\bhead\b/i;

/** "404 error", "500 errors": an HTTP status, not a count of failing tests. */
function isHttpStatus(pair: RegExpMatchArray): boolean {
  const n = Number(pair[1]);
  return /^errors?$/i.test(pair[2] ?? '') && n >= 100 && n <= 599;
}

/** The `[start, end)` ranges of every quoted span on the line. */
function quotedRanges(line: string): Array<[number, number]> {
  return [...line.matchAll(QUOTED_SPAN)].map((m) => [m.index, m.index + m[0].length]);
}

function countField(noun: string): keyof Omit<ParsedCount, 'kind'> {
  const word = noun.toLowerCase();
  if (word.startsWith('pass')) return 'passed';
  if (word.startsWith('fail') || word.startsWith('error')) return 'failed';
  if (word.startsWith('skip') || word === 'ignored') return 'skipped';
  return 'total'; // "tests", "test", "total"
}

// ---------------------------------------------------------------------------
// test-name claims
// ---------------------------------------------------------------------------

/** Shapes that are unambiguously test identifiers rather than ordinary words. */
const TEST_NAME_PATTERNS: readonly RegExp[] = [
  /^Test[A-Z][A-Za-z0-9_]*(?:\/[A-Za-z0-9_]+)*$/, // Go: TestPrune, TestPrune/empty_db
  /^test_[A-Za-z0-9_]+$/, // pytest / unittest: test_login
  /^[A-Z][A-Za-z0-9_]*Tests?$/, // xUnit-style class: PipelineYamlTests
];

/** "tests added: TestPrune, TestCompact" / "test named: test_login". */
const TESTS_NAMED = /tests?\s+(?:named|added)\s*:\s*(.+)$/i;

const isTestName = (token: string): boolean => TEST_NAME_PATTERNS.some((re) => re.test(token));

// ---------------------------------------------------------------------------
// caveat claims
// ---------------------------------------------------------------------------

/** Honest hedges. Their presence is the claim; the line itself is the reason. */
const CAVEAT_PHRASES: readonly string[] = [
  'blocked by',
  'could not run',
  'not verified',
  'unable to run',
  'did not run',
  'skipped because',
  'no changes needed',
  'verified by reading',
];

/** Emphasis wrappers stripped from a caveat so the reason reads as a sentence. */
const EMPHASIS = ['***', '**', '*', '___', '__', '_'] as const;

function caveatReason(line: string): string {
  let text = line
    .trim()
    .replace(/^>\s*/, '') // blockquote
    .replace(/^[-*+]\s+/, '') // list bullet
    .replace(/^\[[ xX]\]\s*/, '') // checkbox left behind by the bullet
    .trim();

  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const mark of EMPHASIS) {
      if (text.length > mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) {
        text = text.slice(mark.length, -mark.length).trim();
        stripped = true;
        break;
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// HTML comments
// ---------------------------------------------------------------------------

/** Remove `<!-- … -->` regions, carrying the "still inside a comment" flag across lines. */
function stripComments(line: string, inComment: boolean): { visible: string; inComment: boolean } {
  let visible = '';
  let open = inComment;
  let i = 0;

  while (i <= line.length) {
    if (open) {
      const end = line.indexOf('-->', i);
      if (end === -1) return { visible, inComment: true };
      i = end + '-->'.length;
      open = false;
    } else {
      const start = line.indexOf('<!--', i);
      if (start === -1) {
        visible += line.slice(i);
        break;
      }
      visible += line.slice(i, start);
      i = start + '<!--'.length;
      open = true;
    }
  }
  return { visible, inComment: open };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** A claim plus where on the line it started, so a line's claims stay in reading order. */
interface Candidate {
  at: number;
  claim: Omit<Claim, 'id'>;
}

/** Sort keys for the two claims that describe a whole line rather than a span. */
const LINE_START = -1;
const LINE_END = Number.MAX_SAFE_INTEGER;

function collectFromLine(line: string, section: string | undefined): Candidate[] {
  const found: Candidate[] = [];
  const withSection = <T extends object>(claim: T): T & { section?: string } =>
    section === undefined ? claim : { ...claim, section };

  const checkbox = CHECKBOX.exec(line);
  if (checkbox) {
    const parsed: ParsedCheckbox = {
      kind: 'checkbox',
      checked: checkbox[1] !== ' ',
      label: (checkbox[2] ?? '').trim(),
    };
    found.push({ at: LINE_START, claim: withSection({ kind: 'checkbox', text: line.trim(), parsed }) });
  }

  // Inline code spans are either a test command or a test name — or neither.
  const namesSeen = new Set<string>();
  for (const span of line.matchAll(INLINE_CODE)) {
    const raw = (span[1] ?? '').trim();
    const at = span.index;
    const opening = matchCommandPrefix(raw);
    if (opening) {
      const parsed: ParsedCommand = parseCommand(raw, opening.prefix, opening.runner, opening.offset);
      found.push({ at, claim: withSection({ kind: 'command', text: `\`${raw}\``, parsed }) });
    } else if (isTestName(raw)) {
      namesSeen.add(raw);
      const parsed: ParsedTest = { kind: 'test', name: raw };
      found.push({ at, claim: withSection({ kind: 'test', text: `\`${raw}\``, parsed }) });
    }
  }

  // "tests added: TestPrune, TestCompact" — names outside backticks.
  const named = TESTS_NAMED.exec(line);
  if (named) {
    const listAt = line.indexOf(named[1] ?? '', named.index);
    for (const token of (named[1] ?? '').split(/[\s,;]+/)) {
      const name = token.replace(/[`.]+$/, '').replace(/^`+/, '');
      if (!isTestName(name) || namesSeen.has(name)) continue;
      namesSeen.add(name);
      const parsed: ParsedTest = { kind: 'test', name };
      found.push({ at: listAt, claim: withSection({ kind: 'test', text: name, parsed }) });
    }
  }

  // Adjacent "<n> <noun>" pairs merge into one count, so "68 tests, 0 failures"
  // is a single claim with total and failed rather than two half-claims. Pairs
  // inside quotation marks, or anywhere on a line that compares runs, are not
  // assertions about this pull request and are skipped.
  const quoted = quotedRanges(line);
  const pairs = COMPARISON_LINE.test(line)
    ? []
    : [...line.matchAll(COUNT_TOKEN)].filter(
        (pair) =>
          !quoted.some(([start, end]) => pair.index >= start && pair.index < end) &&
          !isHttpStatus(pair),
      );
  for (let i = 0; i < pairs.length; ) {
    const first = pairs[i];
    if (first === undefined) break;
    let last = first;
    let j = i + 1;
    while (j < pairs.length) {
      const next = pairs[j];
      if (next === undefined) break;
      const gap = line.slice(last.index + last[0].length, next.index);
      if (!COUNT_JOINER.test(gap)) break;
      last = next;
      j += 1;
    }

    const parsed: ParsedCount = { kind: 'count' };
    for (const pair of pairs.slice(i, j)) {
      const value = Number(pair[1]);
      const field = countField(pair[2] ?? '');
      if (parsed[field] === undefined) parsed[field] = value;
    }
    const text = line.slice(first.index, last.index + last[0].length);
    found.push({ at: first.index, claim: withSection({ kind: 'count', text, parsed }) });
    i = j;
  }

  const lower = line.toLowerCase();
  const phrase = CAVEAT_PHRASES.find((p) => lower.includes(p));
  if (phrase !== undefined) {
    const parsed: ParsedCaveat = { kind: 'caveat', reason: caveatReason(line) };
    found.push({ at: LINE_END, claim: withSection({ kind: 'caveat', text: line.trim(), parsed }) });
  }

  return found.sort((a, b) => a.at - b.at);
}

export function extractClaims(pr: PullRequestFacts): Claim[] {
  const claims: Claim[] = [];
  let section: string | undefined;
  let inFence = false;
  let inComment = false;

  for (const rawLine of pr.body.split(/\r?\n/)) {
    const stripped = stripComments(rawLine, inComment);
    inComment = stripped.inComment;
    const line = stripped.visible;

    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      // "## Test plan ##" → "Test plan". The heading itself is never a claim.
      section = (heading[2] ?? '').replace(/\s*#+\s*$/, '').trim() || undefined;
      continue;
    }

    for (const candidate of collectFromLine(line, section)) {
      claims.push({ id: `c${claims.length + 1}`, ...candidate.claim });
    }
  }

  return claims;
}
