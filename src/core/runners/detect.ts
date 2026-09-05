/**
 * Test-command detection.
 *
 * Given the repository's manifest files (already read by the caller — this
 * module never touches the filesystem, spawns a process, or hits the network)
 * decide *how* this repository runs its tests, and rewrite that command so it
 * emits machine-readable output with retries and result caching disabled.
 *
 * Two invariants make the receipt trustworthy:
 *
 *  1. **Machine-readable output.** A human-readable summary can be forged by
 *     a `|| true` or a doctored reporter; a per-test event stream cannot be
 *     summarised away. Every returned command either injects a structured
 *     reporter or carries a `note` saying why per-test parsing is impossible.
 *  2. **No retries, no caching.** A cached PASS from a previous run, or a
 *     green result produced by a third attempt, is not evidence. `-count=1`,
 *     `-p no:rerunfailures` and `--ci` remove the common sources.
 */
import type { RunnerFamily } from '../types.js';

/**
 * A resolved test command, ready for the Action to execute.
 *
 * `command` is the full shell command *after* reporter injection; `reporterArgs`
 * is the injected fragment on its own (useful for the receipt and for tests);
 * `env` is the environment overlay to apply; `reportPath` is where the
 * machine-readable report will land (for stdout-streaming runners such as Go,
 * the path the caller should tee stdout into).
 *
 * `note` is present only when something about the setup limits what the gate
 * can verify — e.g. plain `cargo test`, which has no per-test machine output.
 */
export type DetectedCommand = {
  family: RunnerFamily;
  command: string;
  reporterArgs: string[];
  env: Record<string, string>;
  reportPath: string;
  note?: string;
};

export interface DetectInput {
  /** An operator-supplied command (action input); wins over every manifest. */
  explicit?: string;
  /** Candidate manifest filenames → contents, when the file exists. */
  files: Record<string, string | undefined>;
}

/** A workspace package the pull request touches, with the manifests found in its directory. */
export interface WorkspacePackage {
  /** Directory relative to the repository root, e.g. `apps/studio`. */
  dir: string;
  /** Manifest filenames → contents for that directory (`package.json` at least). */
  files: Record<string, string | undefined>;
}

export interface WorkspaceDetectInput {
  /** A command to run inside each package instead of the package's own `test` script. */
  explicit?: string;
  /** The repository root's manifests — the lockfile there decides the package manager. */
  rootFiles: Record<string, string | undefined>;
  /** Touched packages, most-changed first. */
  packages: WorkspacePackage[];
  /** How many packages to run at most (default 5); the rest are noted, not run. */
  maxPackages?: number;
}

/** Packages run in one `detectWorkspaceCommand` call before the rest are noted instead. */
export const MAX_WORKSPACE_PACKAGES = 5;

/** Directory the gate writes its reporter output into. */
export const REPORT_DIR = '.merge-evidence';

export const REPORT_PATHS = {
  go: `${REPORT_DIR}/go-test.json`,
  pytest: `${REPORT_DIR}/pytest-junit.xml`,
  jest: `${REPORT_DIR}/jest-results.json`,
  vitest: `${REPORT_DIR}/vitest-results.json`,
  /** cargo-nextest writes `<junit.path>` under `target/nextest/<profile>/`. */
  nextest: 'target/nextest/ci/junit.xml',
  cargo: `${REPORT_DIR}/cargo-test.txt`,
  opaque: `${REPORT_DIR}/test-output.txt`,
} as const;

/** Applied to every run: deterministic locale/timezone, CI mode on. */
const BASE_ENV: Record<string, string> = { CI: '1', TZ: 'UTC', LANG: 'C.UTF-8' };

const PYTEST_REPORTER_ARGS = (reportPath: string): string[] => [
  '-p',
  'no:rerunfailures',
  '-o',
  'junit_family=xunit1',
  `--junitxml=${reportPath}`,
];

const NEXTEST_NOTE =
  'nextest JUnit output requires `[profile.ci.junit] path = "junit.xml"` in .config/nextest.toml; ' +
  `the report is expected at ${REPORT_PATHS.nextest}.`;

const CARGO_NOTE =
  'plain `cargo test` has no per-test machine-readable output; install cargo-nextest and add a ' +
  '`ci` profile with JUnit enabled for per-test evidence.';

const OPAQUE_NOTE =
  'no machine-readable reporter could be injected into this command; per-test evidence is unavailable.';

/**
 * The runner a command text invokes directly, when it is recognisable.
 * `nextest` is reported separately from `cargo` because only nextest produces
 * a per-test report.
 */
type DirectRunner = 'go' | 'pytest' | 'jest' | 'vitest' | 'nextest' | 'cargo';

function classifyDirect(command: string): DirectRunner | undefined {
  if (/\bgo\s+test\b/.test(command)) return 'go';
  if (/\b(pytest|py\.test)\b/.test(command)) return 'pytest';
  if (/\bpython[0-9.]*\s+-m\s+pytest\b/.test(command)) return 'pytest';
  if (/\bvitest\b/.test(command)) return 'vitest';
  if (/\bjest\b/.test(command)) return 'jest';
  if (/\bcargo\s+nextest\b/.test(command)) return 'nextest';
  if (/\bcargo\s+test\b/.test(command)) return 'cargo';
  return undefined;
}

/** True for `make`, `npm run test`, `pnpm test`, … — a wrapper around a real runner. */
function isMakeCommand(command: string): boolean {
  return /(^|\s|\/)make(\s|$)/.test(command);
}

function isPackageManagerCommand(command: string): boolean {
  return /(^|\s)(npm|pnpm|yarn|bun)(\s|$)/.test(command);
}

// ---------------------------------------------------------------------------
// Reporter injection for directly-invoked runners
// ---------------------------------------------------------------------------

/** Insert `-json -count=1` immediately after `go test`, without duplicating. */
function injectGo(command: string): DetectedCommand {
  const args: string[] = [];
  if (!/\s-json\b/.test(command)) args.push('-json');
  if (!/\s-count=\d+\b/.test(command)) args.push('-count=1');
  const injected =
    args.length === 0
      ? command
      : command.replace(/\bgo(\s+)test\b/, (m) => `${m} ${args.join(' ')}`);
  return {
    family: 'go',
    command: injected,
    reporterArgs: args,
    env: { ...BASE_ENV },
    reportPath: REPORT_PATHS.go,
  };
}

function injectPytest(command: string): DetectedCommand {
  const reporterArgs = PYTEST_REPORTER_ARGS(REPORT_PATHS.pytest);
  return {
    family: 'pytest',
    command: `${command} ${reporterArgs.join(' ')}`,
    reporterArgs,
    env: { ...BASE_ENV },
    reportPath: REPORT_PATHS.pytest,
  };
}

function injectJest(command: string, separator = ''): DetectedCommand {
  const reporterArgs = ['--json', `--outputFile=${REPORT_PATHS.jest}`, '--ci'];
  return {
    family: 'jest',
    command: `${command}${separator} ${reporterArgs.join(' ')}`,
    reporterArgs,
    env: { ...BASE_ENV, FORCE_COLOR: '0' },
    reportPath: REPORT_PATHS.jest,
  };
}

function injectVitest(command: string, separator = ''): DetectedCommand {
  const reporterArgs = ['--reporter=json', `--outputFile=${REPORT_PATHS.vitest}`];
  return {
    family: 'vitest',
    command: `${command}${separator} ${reporterArgs.join(' ')}`,
    reporterArgs,
    env: { ...BASE_ENV, FORCE_COLOR: '0' },
    reportPath: REPORT_PATHS.vitest,
  };
}

function injectNextest(command: string): DetectedCommand {
  const reporterArgs = /--profile\b/.test(command) ? [] : ['--profile', 'ci'];
  return {
    // nextest speaks JUnit XML, so the JUnit adapter parses it.
    family: 'junit',
    command: reporterArgs.length === 0 ? command : `${command} ${reporterArgs.join(' ')}`,
    reporterArgs,
    env: { ...BASE_ENV, NEXTEST_PROFILE: 'ci' },
    reportPath: REPORT_PATHS.nextest,
    note: NEXTEST_NOTE,
  };
}

function plainCargo(command: string): DetectedCommand {
  return {
    family: 'cargo',
    command,
    reporterArgs: [],
    env: { ...BASE_ENV },
    reportPath: REPORT_PATHS.cargo,
    note: CARGO_NOTE,
  };
}

/** Wrap an opaque script (make target, unrecognised command) that runs pytest underneath. */
function wrapPytestEnv(command: string): DetectedCommand {
  const reporterArgs = PYTEST_REPORTER_ARGS(REPORT_PATHS.pytest);
  return {
    family: 'pytest',
    command,
    reporterArgs,
    env: { ...BASE_ENV, PYTEST_ADDOPTS: reporterArgs.join(' ') },
    reportPath: REPORT_PATHS.pytest,
  };
}

/** Wrap an opaque script that runs `go test` underneath (GOFLAGS reaches it). */
function wrapGoEnv(command: string): DetectedCommand {
  const reporterArgs = ['-json', '-count=1'];
  return {
    family: 'go',
    command,
    reporterArgs,
    // GOFLAGS entries are applied only to go commands that know the flag, so
    // `-json` reaches `go test` without breaking a `go build` in the same target.
    env: { ...BASE_ENV, GOFLAGS: reporterArgs.join(' ') },
    reportPath: REPORT_PATHS.go,
  };
}

function opaque(command: string, family: RunnerFamily): DetectedCommand {
  return {
    family,
    command,
    reporterArgs: [],
    env: { ...BASE_ENV },
    reportPath: REPORT_PATHS.opaque,
    note: OPAQUE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Manifest readers
// ---------------------------------------------------------------------------

/**
 * Pull `test-command:` out of `.merge-evidence.yml` with a line scan rather than
 * a YAML parser — the gate reads exactly one scalar key and must not gain a
 * dependency (or a parser CVE) for it.
 */
export function readYamlTestCommand(yaml: string): string | undefined {
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^[ \t]*test-command[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const value = stripYamlScalar(m[1] ?? '');
    if (value.length > 0) return value;
  }
  return undefined;
}

function stripYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0] as string;
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) return trimmed.slice(1, end);
    return trimmed.slice(1);
  }
  // Strip a trailing ` # comment`, which YAML only recognises after whitespace.
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * The recipe lines of a Makefile target, or undefined when the target is absent.
 * Handles `test:`, `test::` and prerequisites, and ignores `test := value`.
 */
export function readMakeTarget(makefile: string, target: string): string[] | undefined {
  const lines = makefile.split(/\r?\n/);
  const header = new RegExp(`^${target}[ \\t]*::?[ \\t]*(?!=)`);
  let i = lines.findIndex((line) => header.test(line));
  if (i < 0) return undefined;
  const recipe: string[] = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('\t')) {
      recipe.push(line.slice(1).trim());
      continue;
    }
    if (line.trim() === '') continue;
    break;
  }
  return recipe;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function readPackageManager(files: Record<string, string | undefined>): PackageManager {
  if (files['pnpm-lock.yaml'] !== undefined) return 'pnpm';
  if (files['yarn.lock'] !== undefined) return 'yarn';
  if (files['bun.lockb'] !== undefined) return 'bun';
  return 'npm';
}

/**
 * How each package manager is invoked, and whether extra args need a `--`
 * separator to reach the underlying script. Only npm needs it: pnpm, yarn and
 * bun forward trailing args directly, and pnpm passes an explicit `--` THROUGH
 * to the script — `vitest run -- --reporter=json` then treats the flags as file
 * filters and writes no report (seen on a real monorepo run).
 */
const PM_INVOCATION: Record<PackageManager, { command: string; separator: string }> = {
  npm: { command: 'npm test', separator: ' --' },
  pnpm: { command: 'pnpm test', separator: '' },
  yarn: { command: 'yarn test', separator: '' },
  bun: { command: 'bun run test', separator: '' },
};

interface PackageJson {
  scripts?: Record<string, string | undefined>;
  devDependencies?: Record<string, string | undefined>;
  dependencies?: Record<string, string | undefined>;
}

function parsePackageJson(raw: string | undefined): PackageJson | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed as PackageJson;
  } catch {
    // A malformed package.json is treated as absent — detection falls through.
  }
  return undefined;
}

/** jest vs vitest, from the script text first, then the declared dependencies. */
function classifyNodeRunner(
  scriptText: string | undefined,
  pkg: PackageJson | undefined,
): 'jest' | 'vitest' | undefined {
  if (scriptText !== undefined) {
    if (/\bvitest\b/.test(scriptText)) return 'vitest';
    if (/\bjest\b/.test(scriptText)) return 'jest';
  }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps['vitest'] !== undefined) return 'vitest';
  if (deps['jest'] !== undefined) return 'jest';
  return undefined;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Resolve the command this repository uses to run its tests, with a
 * machine-readable reporter injected. Returns `null` when nothing indicates
 * how to run tests — the gate then abstains (verdict NEUTRAL) rather than
 * guessing.
 *
 * First hit wins, in this order: explicit input → `.merge-evidence.yml`
 * `test-command:` → `Makefile` `test:` target → `package.json` `scripts.test`
 * → `go.mod` → pytest manifests → `Cargo.toml`.
 */
export function detectTestCommand(input: DetectInput): DetectedCommand | null {
  const { files } = input;

  const explicit = input.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return resolveWrittenCommand(explicit, files);
  }

  const yaml = files['.merge-evidence.yml'];
  if (yaml !== undefined) {
    const configured = readYamlTestCommand(yaml);
    if (configured !== undefined) return resolveWrittenCommand(configured, files);
  }

  const makefile = files['Makefile'];
  if (makefile !== undefined) {
    const recipe = readMakeTarget(makefile, 'test');
    if (recipe !== undefined) return fromMakeRecipe('make test', recipe, files);
  }

  const pkg = parsePackageJson(files['package.json']);
  const testScript = pkg?.scripts?.['test'];
  if (testScript !== undefined && testScript.trim().length > 0) {
    return fromPackageScript(testScript, pkg, files);
  }

  if (files['go.mod'] !== undefined) {
    return injectGo('go test ./...');
  }

  if (
    files['pyproject.toml'] !== undefined ||
    files['pytest.ini'] !== undefined ||
    files['setup.cfg'] !== undefined
  ) {
    return injectPytest('pytest');
  }

  if (files['Cargo.toml'] !== undefined) {
    if (files['.config/nextest.toml'] !== undefined) {
      return injectNextest('cargo nextest run');
    }
    return plainCargo('cargo test');
  }

  return null;
}

/** Single-quote a path for bash; repository paths rarely carry quotes, but a quote must not break the command. */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * A monorepo whose root has no test command — a turbo/nx/lerna workspace where
 * every package runs its own suite — is tested the way its own CI tests a
 * change: the test script of each package the pull request touches, run from
 * that package's directory. Each package writes its reporter output relative
 * to its own directory, which the pipeline's nested-report merge collects.
 *
 * Packages whose runner family differs from the first package's are skipped
 * with a note (one adapter parses the run), and no more than `maxPackages` run.
 * With `explicit` set, that command is run inside each package instead of the
 * package's script — how a claimed `vitest` in a monorepo body is meant.
 * Returns null when no touched package has anything to run.
 */
export function detectWorkspaceCommand(input: WorkspaceDetectInput): DetectedCommand | null {
  const explicit = input.explicit?.trim();
  const parts: Array<{ dir: string; detected: DetectedCommand }> = [];
  for (const pkg of input.packages) {
    // The package's manifests win; the root's lockfile still decides the package manager.
    const merged = { ...input.rootFiles, ...pkg.files };
    if (explicit !== undefined && explicit.length > 0) {
      parts.push({ dir: pkg.dir, detected: resolveWrittenCommand(explicit, merged) });
      continue;
    }
    const manifest = parsePackageJson(pkg.files['package.json']);
    const script = manifest?.scripts?.['test'];
    if (script === undefined || script.trim().length === 0) continue;
    parts.push({ dir: pkg.dir, detected: fromPackageScript(script, manifest, merged) });
  }
  if (parts.length === 0) return null;

  const first = parts[0];
  if (first === undefined) return null;
  const family = first.detected.family;
  const sameFamily = parts.filter((part) => part.detected.family === family);
  const otherFamily = parts.filter((part) => part.detected.family !== family);
  const max = input.maxPackages ?? MAX_WORKSPACE_PACKAGES;
  const chosen = sameFamily.slice(0, max);
  const beyondCap = sameFamily.slice(max);

  const command = [
    'f=0',
    ...chosen.map(
      (part) => `(cd ${shellQuote(part.dir)} && mkdir -p ${REPORT_DIR} && ${part.detected.command}) || f=1`,
    ),
    'exit "$f"',
  ].join('; ');
  const env = Object.assign({}, ...chosen.map((part) => part.detected.env)) as Record<string, string>;
  const notes = [
    `${explicit === undefined || explicit.length === 0 ? 'root has no test command; running the test script of' : 'running the claimed command in'} ${chosen.length} workspace package(s) this PR touches: ${chosen.map((part) => part.dir).join(', ')}`,
  ];
  if (otherFamily.length > 0) {
    notes.push(`${otherFamily.map((part) => part.dir).join(', ')} use a different runner (${otherFamily.map((part) => part.detected.family).join(', ')}) and were not run`);
  }
  if (beyondCap.length > 0) {
    notes.push(`${beyondCap.length} more touched package(s) not run (limit ${max}): ${beyondCap.map((part) => part.dir).join(', ')}`);
  }
  const firstNote = chosen[0]?.detected.note;
  if (firstNote !== undefined) notes.push(firstNote);

  return {
    family,
    command,
    reporterArgs: [...first.detected.reporterArgs],
    env,
    reportPath: first.detected.reportPath,
    note: notes.join('; '),
  };
}

/**
 * Resolve a command someone wrote down (action input or `.merge-evidence.yml`).
 * A direct runner invocation gets its reporter injected inline; a wrapper
 * (`make …`, `npm test`) is resolved through the manifest that defines it so we
 * can still inject via env or a `--` passthrough.
 */
function resolveWrittenCommand(
  command: string,
  files: Record<string, string | undefined>,
): DetectedCommand {
  const direct = classifyDirect(command);
  if (direct !== undefined) return injectDirect(command, direct);

  if (isMakeCommand(command)) {
    const makefile = files['Makefile'];
    const target = /(^|\s)make\s+([A-Za-z0-9._-]+)/.exec(command)?.[2] ?? 'test';
    const recipe = makefile !== undefined ? readMakeTarget(makefile, target) : undefined;
    return fromMakeRecipe(command, recipe ?? [], files);
  }

  if (isPackageManagerCommand(command)) {
    const pkg = parsePackageJson(files['package.json']);
    const node = classifyNodeRunner(pkg?.scripts?.['test'], pkg);
    // The command already names the package manager, so append args to it
    // directly. Only npm needs the `--` separator (see PM_INVOCATION).
    const separator = /(^|\s)npm(\s|$)/.test(command) ? ' --' : '';
    if (node === 'vitest') return injectVitest(command, separator);
    if (node === 'jest') return injectJest(command, separator);
    return opaque(command, 'npm');
  }

  return opaque(command, 'make');
}

function injectDirect(command: string, runner: DirectRunner): DetectedCommand {
  switch (runner) {
    case 'go':
      return injectGo(command);
    case 'pytest':
      return injectPytest(command);
    case 'jest':
      return injectJest(command);
    case 'vitest':
      return injectVitest(command);
    case 'nextest':
      return injectNextest(command);
    case 'cargo':
      return plainCargo(command);
  }
}

/**
 * A Makefile target runs an opaque recipe, so the reporter can only be injected
 * through the environment. pytest (PYTEST_ADDOPTS) and go (GOFLAGS) support
 * that; jest/vitest/cargo do not, so those degrade to an opaque run with a note.
 */
function fromMakeRecipe(
  command: string,
  recipe: string[],
  files: Record<string, string | undefined>,
): DetectedCommand {
  const text = recipe.join('\n');
  const direct = classifyDirect(text);
  if (direct === 'pytest') return wrapPytestEnv(command);
  if (direct === 'go') return wrapGoEnv(command);
  if (direct === 'nextest') {
    return { ...injectNextest(command), command, reporterArgs: [] };
  }
  if (direct === undefined && isPackageManagerCommand(text)) {
    // `make test` that shells out to `npm test`: classify through package.json.
    const pkg = parsePackageJson(files['package.json']);
    const node = classifyNodeRunner(pkg?.scripts?.['test'], pkg);
    if (node !== undefined) return opaque(command, 'make');
  }
  return opaque(command, 'make');
}

function fromPackageScript(
  script: string,
  pkg: PackageJson | undefined,
  files: Record<string, string | undefined>,
): DetectedCommand {
  const pm = readPackageManager(files);
  const invocation = PM_INVOCATION[pm];
  const node = classifyNodeRunner(script, pkg);
  if (node === 'vitest') return injectVitest(invocation.command, invocation.separator);
  if (node === 'jest') return injectJest(invocation.command, invocation.separator);

  // The script runs something else entirely (`node --test`, a shell script, …).
  const direct = classifyDirect(script);
  if (direct === 'pytest') return wrapPytestEnv(invocation.command);
  if (direct === 'go') return wrapGoEnv(invocation.command);
  return opaque(invocation.command, 'npm');
}
