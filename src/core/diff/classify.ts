/**
 * Path and patch classifiers for the diff module.
 *
 * Every predicate here is pure and path-shaped: it answers "what kind of file
 * is this?" without touching the filesystem, git, or the network. `analyzeDiff`
 * composes them; they are exported individually so each one is unit-testable
 * against the naming conventions of the ecosystems we support.
 *
 * Regex conventions in this file: no `g` flag anywhere (so `.test()` is
 * stateless and safe to reuse), and every pattern carries a comment naming the
 * concrete case it catches.
 */

/**
 * Directory segments that mark a tree as test-owned — any file below them
 * counts. Compared case-insensitively so SwiftPM's and Symfony's `Tests/`
 * count. Rust's `tests/` lands here too. `spec/` is deliberately absent:
 * OpenAPI documents, RFCs, and spec-driven planning trees live there, and the
 * test conventions that use it (RSpec `_spec.rb`, Jasmine `.spec.js`) are
 * matched on the file name instead.
 */
const TEST_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  '__test__',
  'testdata',
  'integration_test', // Flutter
  'test_driver', // Flutter
  'androidtest', // Android source set (compared lower-cased)
]);

/** .NET test projects are directories named `<Project>.Tests` / `<Project>.Test`. */
const DOTNET_TEST_PROJECT = /\.tests?$/i;

/** End-to-end trees where only SOURCE files are tests: `e2e/README.md` is documentation. */
const E2E_DIR_SEGMENTS: ReadonlySet<string> = new Set(['e2e', 'cypress']);

/** A file that holds code in a language with a test runner. */
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|cs|php|swift|scala)$/;

const isTestDirSegment = (segment: string): boolean => TEST_DIR_SEGMENTS.has(segment.toLowerCase());
const isE2eDirSegment = (segment: string): boolean => E2E_DIR_SEGMENTS.has(segment.toLowerCase());

/** Go test files: `pkg/node/prune_test.go`. */
const GO_TEST_FILE = /_test\.go$/;

/**
 * Ruby: RSpec `spec/models/user_spec.rb` — only below a `spec/` directory, since
 * `app/models/blood_test.rb` is a product model — plus the helpers and support
 * trees RSpec loads. Minitest lives under `test/` (directory rule).
 */
const RB_SPEC_FILE = /_spec\.rb$/;
const RB_SPEC_HELPER = /(?:^|\/)(?:spec|rails)_helper\.rb$/;
const RB_SPEC_SUPPORT: ReadonlySet<string> = new Set(['support', 'factories']);

/**
 * `_test` / `_unittest` file suffixes in languages whose runners use them: Deno
 * (`login_test.ts`), gtest (`parser_test.cc`, `parser_unittest.cc`), Dart
 * (`login_test.dart`), Elixir (`login_test.exs`).
 *
 * Class-per-file names such as `UserTest.java` are deliberately NOT a rule:
 * JUnit, Kotlin, PHPUnit and XCTest all keep tests under a `test/`, `tests/`
 * or `Tests/` directory (matched above), while `SpeedTest.java` or
 * `LoadTest.cs` outside one is product code. `*Spec` names are product classes
 * (`V1PodSpec.java`, `OpenApiSpec.kt`); ScalaTest's `UserSpec.scala` is
 * recognised by its `src/test/` directory.
 */
const SUFFIX_TEST_FILE = /_(?:test|unittest)\.(?:[cm]?[jt]sx?|cc|cpp|cxx|c|dart|exs?)$/;

/** Cypress specs: `login.cy.ts`. Script extensions only — `about.cy.md` is a Welsh page. */
const CY_TEST_FILE = /\.cy\.[cm]?[jt]sx?$/;

/**
 * Rust keeps unit tests inside the source file; an added `#[test]`,
 * `#[cfg(test)]`, or an attribute-macro test (`#[tokio::test]`, `#[rstest]`,
 * `#[test_case(…)]`, `#[wasm_bindgen_test]`, `#[proptest]`) is a test edit.
 */
const RUST_INLINE_TEST = /^\s*#\[(?:cfg\(test\)|(?:\w+::)*(?:test|rstest|test_case|proptest|quickcheck|wasm_bindgen_test)\b)/;

/** Python test modules, both orderings plus Django's default `app/tests.py`: `tests/test_login.py`, `login_test.py`. */
const PY_TEST_FILE = /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.py|tests\.py)$/;

/** Python shared test fixtures/plugins at any depth: `tests/conftest.py`. */
const PY_CONFTEST = /(?:^|\/)conftest\.py$/;

/** JS/TS-family test files: `login.test.ts`, `login.spec.tsx`, `api.test.d.ts`. */
const JS_TEST_FILE = /\.(?:test|spec)\.[^/]+$/;

/** Jest/Vitest snapshots and Go golden files, anywhere in the tree: `__snapshots__/App.test.tsx.snap`, `testdata/out.golden`. */
const SNAPSHOT_EXT = /\.(?:snap|golden)$/;

/** Python requirement lists, including the pinned variants: `requirements.txt`, `requirements-dev.txt`. */
const REQUIREMENTS_TXT = /^requirements[^/]*\.txt$/;

/** Pipenv/Bundler manifests and their locks: `Pipfile`, `Pipfile.lock`, `Gemfile`, `Gemfile.lock`. */
const PIPFILE_OR_GEMFILE = /^(?:Pipfile|Gemfile)[^/]*$/;

/** .NET project files carry their package references: `src/Api/Api.csproj`. */
const CSPROJ_FILE = /\.csproj$/;

/** Exactly-named dependency manifests and lockfiles, matched on the basename. */
const DEPENDENCY_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Cargo.toml',
  'Cargo.lock',
  'packages.lock.json',
]);

// ---------------------------------------------------------------------------
// Verification-layer reasons — stable strings; downstream checks (C4) quote them.
// ---------------------------------------------------------------------------

export const REASON_CI_WORKFLOW = 'CI workflow edited';
export const REASON_COVERAGE_THRESHOLD = 'coverage threshold changed';
export const REASON_AGENT_RULES = 'agent rules edited';
export const REASON_TEST_INFRA = 'test infrastructure edited';
export const REASON_FAILURE_SUPPRESSED = 'CI failure suppressed';

/** GitHub Actions workflow definitions, including monorepo sub-checkouts: `.github/workflows/ci.yml`. */
const CI_WORKFLOW_PATH = /(?:^|\/)\.github\/workflows\/[^/]+$/;

/** Coverage-capable config files whose gates can be lowered; only flagged when the patch names a threshold. */
const COVERAGE_CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  'pytest.ini',
  'setup.cfg',
  'pyproject.toml',
  '.coveragerc',
  'codecov.yml',
  '.codecov.yml',
]);

/** Jest/Vitest config in any module flavour: `jest.config.js`, `vitest.config.mts`. */
const JS_TEST_CONFIG = /^(?:jest|vitest)\.config\.[^/]+$/;

/**
 * Tokens that name a coverage gate. A patch touching one of these in a
 * coverage-capable config file is a threshold change; a config file edited for
 * any other reason (a new alias, a dependency bump in `pyproject.toml`) is not.
 *
 * `codecov.yml` is gated the same way on purpose: v1 stays conservative and only
 * reports a threshold change it can point at a line for.
 */
const COVERAGE_TOKENS: readonly string[] = [
  'coverageThreshold', // Jest: coverageThreshold: { global: { lines: 80 } }
  'fail_under', // coverage.py / .coveragerc / pyproject: fail_under = 80
  '--cov-fail-under', // pytest-cov addopts: --cov-fail-under=80
  'thresholds', // Vitest: coverage: { thresholds: { lines: 80 } }
];

/** Agent instruction files that tell a coding agent what it may skip: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`. */
const AGENT_RULE_BASENAMES: ReadonlySet<string> = new Set(['CLAUDE.md', 'AGENTS.md', '.cursorrules']);

/** Cursor's per-rule directory: `.cursor/rules/testing.mdc`. */
const CURSOR_RULES_PATH = /(?:^|\/)\.cursor\/rules\//;

/** Copilot's repository instructions: `.github/copilot-instructions.md`. */
const COPILOT_INSTRUCTIONS_PATH = /(?:^|\/)\.github\/copilot-instructions\.md$/;

/**
 * Added-line tokens that neutralise a failing step, paired with the case each catches.
 * These are the "make red go green without fixing anything" edits.
 *
 * Where they count: anywhere in a CI-relevant file (workflows, CI configs,
 * Makefiles, `package.json`, `scripts/`, task runners), and elsewhere only on a
 * line that runs a test command. `docker volume rm x || true` in a helper
 * script is housekeeping; `pytest || true` anywhere is not. Documentation is
 * never executed and is skipped.
 */
const SUPPRESSION_PATTERNS: readonly RegExp[] = [
  /continue-on-error:\s*true/, // GitHub Actions step that no longer fails the job
  /\|\|\s*true/, // shell: `pytest || true` — exit code discarded
  /--no-verify/, // git commit/push that skips hooks
  /set\s+\+e/, // shell: stop aborting on error for the rest of the script
  /allow_failure/, // GitLab CI / generic: allow_failure: true
];

/** Files CI executes or reads: a suppression token counts anywhere in them. */
const CI_RELEVANT_PATH =
  /(?:^|\/)(?:\.github\/workflows\/[^/]+|\.gitlab-ci\.ya?ml|\.circleci\/[^/]+|\.travis\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|bitbucket-pipelines\.ya?ml|\.buildkite\/[^/]+|Makefile|GNUmakefile|justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py|package\.json|scripts?\/[^/]+|\.?ci\/[^/]+)$/i;

/** A line that invokes a test runner: suppressing ITS failure counts in any file. */
const TEST_INVOCATION =
  /\b(?:pytest|py\.test|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|npx\s+(?:vitest|jest|mocha|playwright|cypress)|vitest|jest|mocha|cargo\s+(?:test|nextest)|make\s+(?:test|check)|ctest|mvn|gradlew?|dotnet\s+test|rspec|bundle\s+exec|phpunit|mix\s+test|swift\s+test|xcodebuild|flutter\s+test|dart\s+test|deno\s+test|tox|nox|coverage\s+run)\b/;

/** Documentation is never executed, so a token quoted in prose is not a suppression. */
const DOC_FILE = /\.(?:md|mdx|rst|txt|adoc)$/i;

function suppressesFailure(line: string, ciRelevant: boolean): boolean {
  if (!SUPPRESSION_PATTERNS.some((pattern) => pattern.test(line))) return false;
  return ciRelevant || TEST_INVOCATION.test(line);
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

/** Strip a `./` prefix and normalise Windows separators so every classifier sees one shape. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** The last `/`-separated segment: `pkg/node/prune_test.go` → `prune_test.go`. */
function basename(path: string): string {
  const parts = normalize(path).split('/');
  return parts[parts.length - 1] ?? '';
}

/** Every `/`-separated directory segment of the path, excluding the file name itself. */
function dirSegments(path: string): string[] {
  return normalize(path).split('/').slice(0, -1);
}

/**
 * Content of lines the patch ADDS, with the leading `+` removed.
 * `+++ b/file` is a file header, not content, so it is excluded.
 */
export function addedLines(patch: string | undefined): string[] {
  if (!patch) return [];
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

/**
 * Content of every line the patch ADDS or REMOVES, with the leading marker removed.
 * A lowered threshold shows up as a removed line plus an added line, so checks
 * that ask "did this patch touch X at all" need both sides.
 */
export function changedLines(patch: string | undefined): string[] {
  if (!patch) return [];
  return patch
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---')),
    )
    .map((line) => line.slice(1));
}

/**
 * True when the patch changes something AND one of `tokens` appears anywhere in
 * the hunk, context lines and the `@@ … @@` block label included.
 *
 * Context counts on purpose. Lowering a Jest gate looks like this:
 *
 *     coverageThreshold: {        ← context: the only line naming the token
 *       global: {
 *   -      lines: 90,
 *   +      lines: 45,
 *
 * The changed lines carry no token at all, so a changed-lines-only scan would
 * miss the exact edit this check exists to catch. Requiring at least one changed
 * line keeps an untouched file from ever matching; unified diffs carry three
 * lines of context, so a token must sit within three lines of a real edit.
 */
function patchTouches(patch: string | undefined, tokens: readonly string[]): boolean {
  if (!patch) return false;
  if (changedLines(patch).length === 0) return false;
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('+++') && !line.startsWith('---'))
    .some((line) => tokens.some((token) => line.includes(token)));
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/**
 * True when the path is a test file or test infrastructure.
 *
 * `conftest.py` counts: pytest loads it as part of the test run, so weakening it
 * weakens the tests even though it holds no test function itself.
 */
export function isTestFile(path: string): boolean {
  const p = normalize(path);
  if (GO_TEST_FILE.test(p)) return true;
  if (PY_TEST_FILE.test(p)) return true;
  if (PY_CONFTEST.test(p)) return true;
  if (JS_TEST_FILE.test(p)) return true;
  if (CY_TEST_FILE.test(p)) return true;
  if (SUFFIX_TEST_FILE.test(p)) return true;
  if (RB_SPEC_HELPER.test(p)) return true;
  const segments = dirSegments(p);
  if (segments.some(isTestDirSegment)) return true;
  if (segments.some((segment) => DOTNET_TEST_PROJECT.test(segment))) return true;
  if (segments.some((segment) => segment.toLowerCase() === 'spec')) {
    if (RB_SPEC_FILE.test(p)) return true;
    if (segments.some((segment) => RB_SPEC_SUPPORT.has(segment.toLowerCase()))) return true;
  }
  return SOURCE_EXT.test(p) && segments.some(isE2eDirSegment);
}

/**
 * True when a Rust source file's patch ADDS an inline test (`#[test]`,
 * `#[cfg(test)]`). Rust puts unit tests next to the code, so a path-only
 * classifier would call an honest "added tests" PR untested.
 */
export function hasInlineTests(path: string, patch: string | undefined): boolean {
  if (!/\.rs$/.test(normalize(path))) return false;
  return addedLines(patch).some((line) => RUST_INLINE_TEST.test(line));
}

/**
 * True when the path holds recorded expected output rather than assertions:
 * snapshots, golden files, Go `testdata/`, and `fixtures/` when it sits inside a
 * test tree. A bare `src/fixtures/` is product data, not evidence, so it is not
 * counted.
 */
export function isSnapshotFile(path: string): boolean {
  const p = normalize(path);
  if (SNAPSHOT_EXT.test(p)) return true;
  const segments = dirSegments(p);
  if (segments.some((segment) => segment.toLowerCase() === 'testdata')) return true;
  if (segments.includes('fixtures')) {
    // `fixtures/` only counts under a test dir: `test/fixtures/user.json` yes, `src/fixtures/flags.json` no.
    return segments.some(isTestDirSegment);
  }
  return false;
}

/** True when the path is a dependency manifest or lockfile for any supported ecosystem. */
export function isDependencyFile(path: string): boolean {
  const name = basename(path);
  if (DEPENDENCY_BASENAMES.has(name)) return true;
  if (REQUIREMENTS_TXT.test(name)) return true;
  if (PIPFILE_OR_GEMFILE.test(name)) return true;
  return CSPROJ_FILE.test(name);
}

/**
 * Why this file counts as an edit to the verification layer — the machinery that
 * decides whether a PR is green — or `null` when it does not.
 *
 * Precedence is most-specific-first: a workflow that adds `continue-on-error: true`
 * reports the suppression, because "CI workflow edited" is already implied by the
 * path and the suppression is the part a reviewer must look at.
 */
export function verificationLayerReason(path: string, patch?: string): string | null {
  const p = normalize(path);
  const name = basename(p);

  // Content signal first: an added line that makes failure survivable.
  if (!DOC_FILE.test(p)) {
    const ciRelevant = CI_RELEVANT_PATH.test(p);
    if (addedLines(patch).some((line) => suppressesFailure(line, ciRelevant))) {
      return REASON_FAILURE_SUPPRESSED;
    }
  }

  if (CI_WORKFLOW_PATH.test(p)) return REASON_CI_WORKFLOW;

  if (COVERAGE_CONFIG_BASENAMES.has(name) || JS_TEST_CONFIG.test(name)) {
    if (patchTouches(patch, COVERAGE_TOKENS)) return REASON_COVERAGE_THRESHOLD;
  }

  if (AGENT_RULE_BASENAMES.has(name)) return REASON_AGENT_RULES;
  if (CURSOR_RULES_PATH.test(p)) return REASON_AGENT_RULES;
  if (COPILOT_INSTRUCTIONS_PATH.test(p)) return REASON_AGENT_RULES;

  if (PY_CONFTEST.test(p)) return REASON_TEST_INFRA;

  return null;
}
