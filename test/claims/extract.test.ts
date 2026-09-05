import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractClaims } from '../../src/core/claims/index.js';
import type { Claim, ParsedCommand, ParsedCount, PullRequestFacts } from '../../src/core/types.js';

/** Vitest runs from the repo root, so fixtures resolve off the cwd. */
const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'test/claims/fixtures', name), 'utf8');

function facts(body: string): PullRequestFacts {
  return {
    repo: 'acme/widgets',
    number: 341,
    headSha: '3f2a1c9',
    baseSha: '9b0e7d2',
    baseRef: 'main',
    headRef: 'feature/whatever',
    authorLogin: 'jrivera',
    body,
    title: 'Some change',
    commitMessages: [],
  };
}

const claimsFor = (body: string): Claim[] => extractClaims(facts(body));
const fromFixture = (name: string): Claim[] => claimsFor(fixture(name));

/** Compact shape used to assert a whole body at once: kind, id, section and parse. */
const shape = (claims: Claim[]): unknown[] =>
  claims.map((c) => ({ id: c.id, kind: c.kind, section: c.section, parsed: c.parsed }));

const only = (claims: Claim[], kind: Claim['kind']): Claim[] => claims.filter((c) => c.kind === kind);

describe('extractClaims — Copilot: a task checklist and a test class, but no run statement', () => {
  const claims = fromFixture('copilot-pipeline-yaml.md');

  it('reads the checklist, the test class and its count — and nothing else', () => {
    expect(shape(claims)).toEqual([
      { id: 'c1', kind: 'checkbox', section: 'Tasks', parsed: { kind: 'checkbox', checked: true, label: 'Reproduce the empty `image:` field' } },
      { id: 'c2', kind: 'checkbox', section: 'Tasks', parsed: { kind: 'checkbox', checked: true, label: 'Default the tag in the renderer' } },
      { id: 'c3', kind: 'checkbox', section: 'Tasks', parsed: { kind: 'checkbox', checked: true, label: 'Extend `PipelineYamlTests` (11 tests)' } },
      { id: 'c4', kind: 'test', section: 'Tasks', parsed: { kind: 'test', name: 'PipelineYamlTests' } },
      { id: 'c5', kind: 'count', section: 'Tasks', parsed: { kind: 'count', total: 11 } },
      { id: 'c6', kind: 'checkbox', section: 'Tasks', parsed: { kind: 'checkbox', checked: false, label: 'Update the operator guide' } },
    ]);
  });

  it('claims no command, because the body never says anything was run', () => {
    expect(only(claims, 'command')).toEqual([]);
  });

  it('ignores the vendor HTML comment markers', () => {
    expect(claims.every((c) => !c.text.includes('COPILOT CODING AGENT'))).toBe(true);
  });
});

describe('extractClaims — Devin: a verified gradle build with a count', () => {
  const claims = fromFixture('devin-gradle-build.md');

  it('reads the command and the merged count in reading order', () => {
    expect(shape(claims)).toEqual([
      { id: 'c1', kind: 'command', section: 'Summary', parsed: { kind: 'command', runner: 'unknown', raw: './gradlew clean build', paths: [], nameFilters: [] } },
      { id: 'c2', kind: 'count', section: 'Summary', parsed: { kind: 'count', total: 68, failed: 0 } },
      { id: 'c3', kind: 'checkbox', section: 'Test plan', parsed: { kind: 'checkbox', checked: true, label: '`./gradlew :uploader:test` passes locally' } },
      { id: 'c4', kind: 'command', section: 'Test plan', parsed: { kind: 'command', runner: 'unknown', raw: './gradlew :uploader:test', paths: [], nameFilters: [] } },
      { id: 'c5', kind: 'checkbox', section: 'Test plan', parsed: { kind: 'checkbox', checked: false, label: 'Staging soak before rollout' } },
    ]);
  });

  it('keeps the claim text verbatim, backticks and all', () => {
    expect(claims[0]?.text).toBe('`./gradlew clean build`');
    expect(claims[1]?.text).toBe('68 tests, 0 failures');
  });

  it('does not read the "503" in the prose as a test count', () => {
    expect(only(claims, 'count')).toHaveLength(1);
  });
});

describe('extractClaims — Claude Code: a test plan with one box left honestly unchecked', () => {
  const claims = fromFixture('claude-code-test-plan.md');

  it('reads both boxes and records the unchecked one as unchecked', () => {
    expect(shape(claims)).toEqual([
      { id: 'c1', kind: 'checkbox', section: 'Test plan', parsed: { kind: 'checkbox', checked: true, label: 'run_tests.sh passes locally' } },
      { id: 'c2', kind: 'checkbox', section: 'Test plan', parsed: { kind: 'checkbox', checked: false, label: 'CI workflow passes' } },
    ]);
  });

  it('does not turn the prose about run_tests.sh into a command claim', () => {
    expect(only(claims, 'command')).toEqual([]);
  });
});

describe('extractClaims — Cursor: a scoped cargo run inside a checkbox', () => {
  const claims = fromFixture('cursor-cargo-prune.md');

  it('reads the box, the command and the "(11 related tests)" count', () => {
    expect(shape(claims)).toEqual([
      { id: 'c1', kind: 'checkbox', section: 'Testing', parsed: { kind: 'checkbox', checked: true, label: '`cargo test -p bitcoin-rs-node --lib prune` (11 related tests)' } },
      { id: 'c2', kind: 'command', section: 'Testing', parsed: { kind: 'command', runner: 'cargo', raw: 'cargo test -p bitcoin-rs-node --lib prune', paths: ['bitcoin-rs-node'], nameFilters: [] } },
      { id: 'c3', kind: 'count', section: 'Testing', parsed: { kind: 'count', total: 11 } },
      { id: 'c4', kind: 'checkbox', section: 'Testing', parsed: { kind: 'checkbox', checked: true, label: '`cargo test -p bitcoin-rs-node --lib` (full crate, no regressions)' } },
      { id: 'c5', kind: 'command', section: 'Testing', parsed: { kind: 'command', runner: 'cargo', raw: 'cargo test -p bitcoin-rs-node --lib', paths: ['bitcoin-rs-node'], nameFilters: [] } },
    ]);
  });
});

describe('extractClaims — Codex: a command that was never run', () => {
  const claims = fromFixture('codex-blocked.md');

  it('reads the command and the italic caveat, with the emphasis stripped from the reason', () => {
    expect(shape(claims)).toEqual([
      { id: 'c1', kind: 'command', section: 'Testing', parsed: { kind: 'command', runner: 'cargo', raw: 'cargo test -p pg_query_wrapper', paths: ['pg_query_wrapper'], nameFilters: [] } },
      { id: 'c2', kind: 'caveat', section: 'Testing', parsed: { kind: 'caveat', reason: '(blocked by the existing libpg-query build failure)' } },
    ]);
  });

  it('keeps the caveat text verbatim even though the reason is cleaned up', () => {
    expect(claims[1]?.text).toBe('*(blocked by the existing libpg-query build failure)*');
  });
});

describe('extractClaims — OpenCode: two runs and two counts on one line', () => {
  const claims = fromFixture('opencode-bun-tests.md');

  it('interleaves commands and counts in the order they appear on the line', () => {
    expect(shape(claims)).toEqual([
      { id: 'c1', kind: 'command', section: 'Verification', parsed: { kind: 'command', runner: 'npm', raw: 'bun run test:unit', paths: [], nameFilters: [] } },
      { id: 'c2', kind: 'count', section: 'Verification', parsed: { kind: 'count', passed: 738, skipped: 1 } },
      { id: 'c3', kind: 'command', section: 'Verification', parsed: { kind: 'command', runner: 'npm', raw: 'bun run test:browser', paths: [], nameFilters: [] } },
      { id: 'c4', kind: 'count', section: 'Verification', parsed: { kind: 'count', passed: 118 } },
    ]);
  });

  it('does not merge counts that belong to different commands', () => {
    expect(claims[1]?.text).toBe('738 passed, 1 skipped');
    expect(claims[3]?.text).toBe('118 passed');
  });
});

describe('extractClaims — a body carrying two vendor footers', () => {
  it('reads the claims and ignores the footers themselves', () => {
    expect(shape(fromFixture('mixed-claude-codex.md'))).toEqual([
      { id: 'c1', kind: 'checkbox', section: 'Testing', parsed: { kind: 'checkbox', checked: true, label: '`go test ./internal/worker/...`' } },
      { id: 'c2', kind: 'command', section: 'Testing', parsed: { kind: 'command', runner: 'go', raw: 'go test ./internal/worker/...', paths: ['./internal/worker/...'], nameFilters: [] } },
    ]);
  });
});

describe('extractClaims — a human PR', () => {
  it('extracts nothing from ordinary prose', () => {
    expect(fromFixture('human-no-signals.md')).toEqual([]);
  });
});

describe('extractClaims — command grammar', () => {
  const parsedCommand = (body: string): ParsedCommand => {
    const claim = claimsFor(body).find((c) => c.kind === 'command');
    if (claim === undefined) throw new Error(`no command claim in: ${body}`);
    return claim.parsed as ParsedCommand;
  };

  it.each([
    ['`go test ./...`', 'go'],
    ['`pytest -q`', 'pytest'],
    ['`python -m pytest tests/`', 'pytest'],
    ['`npm test`', 'npm'],
    ['`npm run test:ci`', 'npm'],
    ['`pnpm test`', 'npm'],
    ['`yarn test`', 'npm'],
    ['`bun test`', 'npm'],
    ['`bun run test:unit`', 'npm'],
    ['`cargo test`', 'cargo'],
    ['`cargo nextest run`', 'cargo'],
    ['`make test`', 'make'],
    ['`vitest run test/claims`', 'vitest'],
    ['`jest --ci`', 'jest'],
    ['`node --test test/`', 'node-test'],
    ['`./gradlew check`', 'unknown'],
    ['`mvn -q verify`', 'unknown'],
    ['`dotnet test`', 'unknown'],
    ['`scripts/test.sh`', 'unknown'],
    ['`./scripts/test-e2e.sh --fast`', 'unknown'],
  ])('maps %s to the %s runner', (body, runner) => {
    expect(parsedCommand(body).runner).toBe(runner);
  });

  it('collects go package patterns and -run filters', () => {
    expect(parsedCommand('`go test -run TestPrune ./pkg/node/...`')).toEqual({
      kind: 'command',
      runner: 'go',
      raw: 'go test -run TestPrune ./pkg/node/...',
      paths: ['./pkg/node/...'],
      nameFilters: ['TestPrune'],
    });
  });

  it('collects pytest -k filters and file paths', () => {
    expect(parsedCommand('`pytest -k login tests/test_auth.py`')).toEqual({
      kind: 'command',
      runner: 'pytest',
      raw: 'pytest -k login tests/test_auth.py',
      paths: ['tests/test_auth.py'],
      nameFilters: ['login'],
    });
  });

  it('accepts --grep and the flag=value form, and unquotes a value with spaces', () => {
    expect(parsedCommand('`vitest run --grep="claims extractor"`').nameFilters).toEqual(['claims extractor']);
    expect(parsedCommand("`vitest run --grep 'claims extractor'`").nameFilters).toEqual(['claims extractor']);
    expect(parsedCommand('`jest -t checkout`').nameFilters).toEqual(['checkout']);
  });

  it('treats a cargo -p package as a path selector', () => {
    expect(parsedCommand('`cargo test -p my-crate --lib`').paths).toEqual(['my-crate']);
  });

  it('ignores unrecognised flags and bare words rather than guessing at them', () => {
    expect(parsedCommand('`go test -count=1 -v ./...`')).toEqual({
      kind: 'command',
      runner: 'go',
      raw: 'go test -count=1 -v ./...',
      paths: ['./...'],
      nameFilters: [],
    });
    expect(parsedCommand('`./gradlew clean build`').paths).toEqual([]);
  });

  it('requires a word boundary after the command opening', () => {
    expect(claimsFor('Look at `go testdata/fixtures.json` for the shape.')).toEqual([]);
    expect(claimsFor('Ran `gotest ./...` from the makefile.')).toEqual([]);
  });

  it('only reads commands out of inline code, not out of prose', () => {
    expect(claimsFor('I ran go test ./... and it was fine.')).toEqual([]);
  });
});

describe('extractClaims — commands behind wrappers and env assignments', () => {
  const commandsIn = (body: string) =>
    extractClaims(facts(body)).filter((c) => c.kind === 'command').map((c) => c.parsed as ParsedCommand);

  it('sees through uv/poetry/npx/pnpm exec/yarn/bunx and a leading VAR=value', () => {
    expect(commandsIn('Ran `uv run pytest tests/test_litellm/proxy/test_x.py -q`.')).toEqual([
      { kind: 'command', runner: 'pytest', raw: 'uv run pytest tests/test_litellm/proxy/test_x.py -q', paths: ['tests/test_litellm/proxy/test_x.py'], nameFilters: [] },
    ]);
    expect(commandsIn('`LITELLM_LOCAL_MODEL_COST_MAP=True uv run --no-sync pytest tests/a.py -k cadence -q`')).toEqual([
      { kind: 'command', runner: 'pytest', raw: 'LITELLM_LOCAL_MODEL_COST_MAP=True uv run --no-sync pytest tests/a.py -k cadence -q', paths: ['tests/a.py'], nameFilters: ['cadence'] },
    ]);
    expect(commandsIn('`npx vitest run src/a.test.ts`').map((c) => [c.runner, c.paths])).toEqual([['vitest', ['src/a.test.ts']]]);
    expect(commandsIn('`pnpm exec jest --ci`').map((c) => c.runner)).toEqual(['jest']);
    expect(commandsIn('`yarn vitest run`').map((c) => c.runner)).toEqual(['vitest']);
    expect(commandsIn('`bunx vitest`').map((c) => c.runner)).toEqual(['vitest']);
    expect(commandsIn('`poetry run pytest -x`').map((c) => c.runner)).toEqual(['pytest']);
  });

  it('keeps `yarn test` and `npm test` as package scripts', () => {
    expect(commandsIn('`yarn test` and `npm test`').map((c) => c.runner)).toEqual(['npm', 'npm']);
  });

  it('ignores a command carrying a template placeholder', () => {
    const body = '- [x] The handful of test files covering my change pass locally, e.g. `uv run pytest tests/test_litellm/<your_test_file>.py -v`';
    const claims = extractClaims(facts(body));
    expect(claims.filter((c) => c.kind === 'command')).toEqual([]);
    expect(claims.filter((c) => c.kind === 'checkbox')).toHaveLength(1);
    expect(commandsIn('`pytest tests/<path>`')).toEqual([]);
  });
});

describe('extractClaims — count grammar', () => {
  const parsedCount = (body: string): ParsedCount => {
    const claim = claimsFor(body).find((c) => c.kind === 'count');
    if (claim === undefined) throw new Error(`no count claim in: ${body}`);
    return claim.parsed as ParsedCount;
  };

  it.each([
    ['68 tests, 0 failures', { kind: 'count', total: 68, failed: 0 }],
    ['48 pass, 0 fail', { kind: 'count', passed: 48, failed: 0 }],
    ['738 passed, 1 skipped', { kind: 'count', passed: 738, skipped: 1 }],
    ['118 passed', { kind: 'count', passed: 118 }],
    ['11 tests', { kind: 'count', total: 11 }],
    ['(11 related tests)', { kind: 'count', total: 11 }],
    ['412 passed, 0 failed and 3 skipped', { kind: 'count', passed: 412, failed: 0, skipped: 3 }],
    ['2 errors', { kind: 'count', failed: 2 }],
  ])('parses %s', (body, expected) => {
    expect(parsedCount(body)).toEqual(expected);
  });

  it('merges adjacent numbers into one claim rather than several half-claims', () => {
    expect(claimsFor('68 tests, 0 failures')).toHaveLength(1);
  });

  it('does not read a count inside quotation marks as a claim', () => {
    expect(claimsFor('Before this an OOM-killed run reported "Claimed 1480 total; 0 observed".').filter((c) => c.kind === 'count')).toEqual([]);
    expect(claimsFor('The log said \u201c12 tests, 0 failures\u201d but 3 tests are new.').map((c) => c.parsed)).toEqual([
      { kind: 'count', total: 3 },
    ]);
  });

  it('does not read counts on a line that compares runs or reports on another one', () => {
    for (const line of [
      'head 203 failures, base ffc6440 the same 203 failures',
      'Observed 6 failures locally before the fix',
      '412 tests at head vs 409 at base',
      'Under 0.2.0 this was 1 failure',
    ]) {
      expect(claimsFor(line).filter((c) => c.kind === 'count'), line).toEqual([]);
    }
  });

  it('splits counts that are separated by prose', () => {
    const counts = claimsFor('The unit suite reported 68 passed but the e2e suite reported 3 failed.');
    expect(counts.map((c) => c.parsed)).toEqual([
      { kind: 'count', passed: 68 },
      { kind: 'count', failed: 3 },
    ]);
  });

  it('does not read an arbitrary number in prose as a count', () => {
    expect(claimsFor('Bumps the pool ceiling from 20 to 40 connections.')).toEqual([]);
    expect(claimsFor('Fixes #482 and closes #17.')).toEqual([]);
  });
});

describe('extractClaims — test-name grammar', () => {
  it('recognises Go, pytest and xUnit shaped identifiers in inline code', () => {
    const names = claimsFor('Covered by `TestPrune`, `test_login` and `PipelineYamlTests`.').map((c) => c.parsed);
    expect(names).toEqual([
      { kind: 'test', name: 'TestPrune' },
      { kind: 'test', name: 'test_login' },
      { kind: 'test', name: 'PipelineYamlTests' },
    ]);
  });

  it('keeps a Go subtest path', () => {
    expect(claimsFor('`TestPrune/empty_db` now passes.')[0]?.parsed).toEqual({
      kind: 'test',
      name: 'TestPrune/empty_db',
    });
  });

  it('reads a "tests added:" list', () => {
    expect(claimsFor('Tests added: TestPrune, TestCompact').map((c) => c.parsed)).toEqual([
      { kind: 'test', name: 'TestPrune' },
      { kind: 'test', name: 'TestCompact' },
    ]);
  });

  it('does not list the same name twice when it is both backticked and in the list', () => {
    expect(claimsFor('Test named: `test_login`').map((c) => c.parsed)).toEqual([
      { kind: 'test', name: 'test_login' },
    ]);
  });

  it('leaves ordinary backticked identifiers alone', () => {
    expect(claimsFor('Renamed `search_path` and `--dry-run`, touched `image:`.')).toEqual([]);
  });
});

describe('extractClaims — caveats', () => {
  it.each([
    'The e2e suite is blocked by a missing sandbox credential.',
    'I could not run the browser suite in this environment.',
    'The migration path is not verified end to end.',
    'Unable to run the integration tests without a database.',
    'I did not run the load suite.',
    'The flaky case was skipped because it needs network access.',
    'No changes needed to the generated client.',
    'The renderer change is verified by reading the diff only.',
  ])('records "%s" as a caveat', (line) => {
    const claims = claimsFor(line);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.parsed).toEqual({ kind: 'caveat', reason: line });
  });

  it('strips list bullets, blockquotes and emphasis from the reason', () => {
    expect(claimsFor('> **could not run the suite locally**')[0]?.parsed).toEqual({
      kind: 'caveat',
      reason: 'could not run the suite locally',
    });
  });

  it('records a caveat and the checkbox it sits on', () => {
    expect(claimsFor('- [ ] e2e — blocked by the sandbox credential').map((c) => c.kind)).toEqual([
      'checkbox',
      'caveat',
    ]);
  });
});

describe('extractClaims — document structure', () => {
  it('tracks the nearest heading as the claim section', () => {
    const body = ['# Summary', 'Nothing here.', '## Test plan', '- [x] `make test`', '### Follow-ups', '- [ ] docs'].join('\n');
    expect(claimsFor(body).map((c) => [c.kind, c.section])).toEqual([
      ['checkbox', 'Test plan'],
      ['command', 'Test plan'],
      ['checkbox', 'Follow-ups'],
    ]);
  });

  it('leaves section undefined before the first heading', () => {
    expect(claimsFor('- [x] `make test`')[0]?.section).toBeUndefined();
  });

  it('ignores fenced code blocks — pasted output is not a statement by the agent', () => {
    const body = ['## Testing', '```console', '$ go test ./...', 'ok  acme/pkg  12 tests, 0 failures', '```', 'Everything green.'].join('\n');
    expect(claimsFor(body)).toEqual([]);
  });

  it('does not read a shell comment inside a fence as a heading', () => {
    const body = ['## Testing', '```bash', '# Verification', '```', '- [x] done'].join('\n');
    expect(claimsFor(body)[0]?.section).toBe('Testing');
  });

  it('ignores HTML comments, including ones spanning several lines', () => {
    const body = ['<!--', '- [x] `go test ./...`', '-->', '- [ ] real box'].join('\n');
    expect(claimsFor(body).map((c) => c.parsed)).toEqual([
      { kind: 'checkbox', checked: false, label: 'real box' },
    ]);
  });

  it('numbers claims c1, c2, … across the whole document', () => {
    const ids = fromFixture('cursor-cargo-prune.md').map((c) => c.id);
    expect(ids).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('returns nothing for an empty body', () => {
    expect(claimsFor('')).toEqual([]);
  });
});
