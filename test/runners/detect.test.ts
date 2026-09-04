import { describe, expect, it } from 'vitest';
import { REPORT_PATHS, detectTestCommand } from '../../src/core/runners/detect.js';

const BASE_ENV = { CI: '1', TZ: 'UTC', LANG: 'C.UTF-8' };

/** Convenience: only the files a case cares about are present. */
function detect(files: Record<string, string | undefined>, explicit?: string) {
  return explicit === undefined
    ? detectTestCommand({ files })
    : detectTestCommand({ explicit, files });
}

const PKG_JEST = JSON.stringify({
  name: 'svc',
  scripts: { test: 'jest --runInBand' },
  devDependencies: { jest: '^30.0.0' },
});

const PKG_VITEST = JSON.stringify({
  name: 'gate',
  scripts: { test: 'vitest run' },
  devDependencies: { vitest: '^3.2.4' },
});

describe('detectTestCommand — nothing to go on', () => {
  it('returns null when no manifest indicates how tests run', () => {
    expect(detect({})).toBeNull();
    expect(detect({ 'README.md': '# svc' })).toBeNull();
  });

  it('returns null when package.json has no test script', () => {
    expect(detect({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) })).toBeNull();
  });

  it('returns null for a malformed package.json with nothing else present', () => {
    expect(detect({ 'package.json': '{ not json' })).toBeNull();
  });
});

describe('detectTestCommand — explicit input wins', () => {
  it('overrides every manifest', () => {
    const result = detect({ 'package.json': PKG_JEST, 'go.mod': 'module x' }, 'go test ./pkg/...');
    expect(result).toEqual({
      family: 'go',
      command: 'go test -json -count=1 ./pkg/...',
      reporterArgs: ['-json', '-count=1'],
      env: BASE_ENV,
      reportPath: REPORT_PATHS.go,
    });
  });

  it('is ignored when blank', () => {
    expect(detect({ 'go.mod': 'module x' }, '   ')?.command).toBe('go test -json -count=1 ./...');
  });

  it('does not duplicate reporter flags already present', () => {
    const result = detect({}, 'go test -json -count=1 ./...');
    expect(result?.command).toBe('go test -json -count=1 ./...');
    expect(result?.reporterArgs).toEqual([]);
  });

  it('injects the pytest reporter into a direct pytest command', () => {
    const result = detect({}, 'pytest tests/ -k auth');
    expect(result?.family).toBe('pytest');
    expect(result?.command).toBe(
      `pytest tests/ -k auth -p no:rerunfailures -o junit_family=xunit1 --junitxml=${REPORT_PATHS.pytest}`,
    );
    expect(result?.env).toEqual(BASE_ENV);
  });

  it('recognises `python -m pytest`', () => {
    expect(detect({}, 'python3 -m pytest')?.family).toBe('pytest');
  });

  it('resolves an `npm test` wrapper through package.json', () => {
    const result = detect({ 'package.json': PKG_JEST }, 'npm test');
    expect(result?.family).toBe('jest');
    expect(result?.command).toBe(
      `npm test -- --json --outputFile=${REPORT_PATHS.jest} --ci`,
    );
  });

  it('marks an unrecognisable command as opaque with a note', () => {
    const result = detect({}, './scripts/run-tests.sh');
    expect(result?.family).toBe('make');
    expect(result?.reporterArgs).toEqual([]);
    expect(result?.reportPath).toBe(REPORT_PATHS.opaque);
    expect(result?.note).toMatch(/no machine-readable reporter/);
  });
});

describe('detectTestCommand — .merge-evidence.yml', () => {
  it('reads test-command and beats the Makefile and package.json', () => {
    const result = detect({
      '.merge-evidence.yml': 'version: 1\ntest-command: go test ./...\nagents-only: true\n',
      Makefile: 'test:\n\t./run.sh\n',
      'package.json': PKG_JEST,
    });
    expect(result?.family).toBe('go');
    expect(result?.command).toBe('go test -json -count=1 ./...');
  });

  it('strips quotes and trailing comments', () => {
    expect(
      detect({ '.merge-evidence.yml': 'test-command: "pytest tests/"  # only the unit tests\n' })
        ?.command,
    ).toBe(
      `pytest tests/ -p no:rerunfailures -o junit_family=xunit1 --junitxml=${REPORT_PATHS.pytest}`,
    );
    expect(detect({ '.merge-evidence.yml': "test-command: 'go test ./...'\n" })?.family).toBe('go');
    expect(detect({ '.merge-evidence.yml': 'test-command: go test ./... # everything\n' })?.command).toBe(
      'go test -json -count=1 ./...',
    );
  });

  it('falls through when the key is commented out or empty', () => {
    expect(detect({ '.merge-evidence.yml': '# test-command: go test ./...\n' })).toBeNull();
    expect(
      detect({ '.merge-evidence.yml': 'test-command:\n', 'go.mod': 'module x' })?.family,
    ).toBe('go');
  });
});

describe('detectTestCommand — Makefile test target', () => {
  it('injects pytest options through PYTEST_ADDOPTS', () => {
    const result = detect({ Makefile: '.PHONY: test\ntest: deps\n\tpytest tests/\n' });
    expect(result?.family).toBe('pytest');
    expect(result?.command).toBe('make test');
    expect(result?.env).toEqual({
      ...BASE_ENV,
      PYTEST_ADDOPTS: `-p no:rerunfailures -o junit_family=xunit1 --junitxml=${REPORT_PATHS.pytest}`,
    });
    expect(result?.reportPath).toBe(REPORT_PATHS.pytest);
  });

  it('injects go options through GOFLAGS', () => {
    const result = detect({ Makefile: 'build:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n' });
    expect(result?.family).toBe('go');
    expect(result?.command).toBe('make test');
    expect(result?.env).toEqual({ ...BASE_ENV, GOFLAGS: '-json -count=1' });
  });

  it('degrades to an opaque run when the recipe has no env injection channel', () => {
    const result = detect({ Makefile: 'test:\n\t./scripts/all.sh\n' });
    expect(result?.family).toBe('make');
    expect(result?.note).toMatch(/no machine-readable reporter/);
  });

  it('ignores a `test :=` variable assignment', () => {
    expect(detect({ Makefile: 'test := 1\n', 'go.mod': 'module x' })?.command).toBe(
      'go test -json -count=1 ./...',
    );
  });

  it('beats package.json and go.mod', () => {
    const result = detect({
      Makefile: 'test:\n\tpytest\n',
      'package.json': PKG_JEST,
      'go.mod': 'module x',
    });
    expect(result?.command).toBe('make test');
  });

  it('resolves an explicit `make check` against that target', () => {
    const result = detect({ Makefile: 'check:\n\tpytest -q\n' }, 'make check');
    expect(result?.family).toBe('pytest');
    expect(result?.command).toBe('make check');
    expect(result?.env['PYTEST_ADDOPTS']).toContain('--junitxml=');
  });
});

describe('detectTestCommand — package.json scripts.test', () => {
  it('uses npm and injects the jest reporter after `--`', () => {
    const result = detect({ 'package.json': PKG_JEST, 'package-lock.json': '{}' });
    expect(result).toEqual({
      family: 'jest',
      command: `npm test -- --json --outputFile=${REPORT_PATHS.jest} --ci`,
      reporterArgs: ['--json', `--outputFile=${REPORT_PATHS.jest}`, '--ci'],
      env: { ...BASE_ENV, FORCE_COLOR: '0' },
      reportPath: REPORT_PATHS.jest,
    });
  });

  it('uses pnpm when pnpm-lock.yaml is present', () => {
    const result = detect({ 'package.json': PKG_VITEST, 'pnpm-lock.yaml': 'lockfileVersion: 9.0' });
    expect(result?.family).toBe('vitest');
    expect(result?.command).toBe(
      `pnpm test -- --reporter=json --outputFile=${REPORT_PATHS.vitest}`,
    );
    expect(result?.reportPath).toBe(REPORT_PATHS.vitest);
  });

  it('uses yarn without a `--` separator', () => {
    const result = detect({ 'package.json': PKG_JEST, 'yarn.lock': '# yarn lockfile v1' });
    expect(result?.command).toBe(`yarn test --json --outputFile=${REPORT_PATHS.jest} --ci`);
  });

  it('uses `bun run test` for a bun lockfile', () => {
    const result = detect({ 'package.json': PKG_VITEST, 'bun.lockb': 'binary' });
    expect(result?.command).toBe(
      `bun run test --reporter=json --outputFile=${REPORT_PATHS.vitest}`,
    );
  });

  it('falls back to devDependencies when the script text names neither runner', () => {
    const pkg = JSON.stringify({
      scripts: { test: 'run-tests --all' },
      devDependencies: { vitest: '^3.2.4' },
    });
    expect(detect({ 'package.json': pkg })?.family).toBe('vitest');
  });

  it('prefers the script text over the dependency list', () => {
    const pkg = JSON.stringify({
      scripts: { test: 'vitest run' },
      devDependencies: { jest: '^30.0.0', vitest: '^3.2.4' },
    });
    expect(detect({ 'package.json': pkg })?.family).toBe('vitest');
  });

  it('marks an unknown node test script as opaque', () => {
    const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
    const result = detect({ 'package.json': pkg, 'package-lock.json': '{}' });
    expect(result?.family).toBe('npm');
    expect(result?.command).toBe('npm test');
    expect(result?.reporterArgs).toEqual([]);
    expect(result?.note).toMatch(/no machine-readable reporter/);
  });

  it('beats go.mod, pyproject.toml and Cargo.toml', () => {
    const result = detect({
      'package.json': PKG_JEST,
      'go.mod': 'module x',
      'pyproject.toml': '[project]\nname = "x"\n',
      'Cargo.toml': '[package]\nname = "x"\n',
    });
    expect(result?.family).toBe('jest');
  });
});

describe('detectTestCommand — go.mod', () => {
  it('runs the whole module with -json and no test cache', () => {
    expect(detect({ 'go.mod': 'module github.com/acme/svc\n\ngo 1.25\n' })).toEqual({
      family: 'go',
      command: 'go test -json -count=1 ./...',
      reporterArgs: ['-json', '-count=1'],
      env: BASE_ENV,
      reportPath: REPORT_PATHS.go,
    });
  });

  it('beats pyproject.toml and Cargo.toml', () => {
    const result = detect({
      'go.mod': 'module x',
      'pyproject.toml': '[project]\n',
      'Cargo.toml': '[package]\n',
    });
    expect(result?.family).toBe('go');
  });
});

describe('detectTestCommand — python manifests', () => {
  const expected = {
    family: 'pytest',
    command: `pytest -p no:rerunfailures -o junit_family=xunit1 --junitxml=${REPORT_PATHS.pytest}`,
    reporterArgs: [
      '-p',
      'no:rerunfailures',
      '-o',
      'junit_family=xunit1',
      `--junitxml=${REPORT_PATHS.pytest}`,
    ],
    env: BASE_ENV,
    reportPath: REPORT_PATHS.pytest,
  };

  it('detects from pyproject.toml', () => {
    expect(detect({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })).toEqual(expected);
  });

  it('detects from pytest.ini', () => {
    expect(detect({ 'pytest.ini': '[pytest]\n' })).toEqual(expected);
  });

  it('detects from setup.cfg', () => {
    expect(detect({ 'setup.cfg': '[metadata]\nname = svc\n' })).toEqual(expected);
  });

  it('beats Cargo.toml', () => {
    expect(detect({ 'pytest.ini': '[pytest]\n', 'Cargo.toml': '[package]\n' })?.family).toBe(
      'pytest',
    );
  });
});

describe('detectTestCommand — Cargo', () => {
  it('uses nextest with the ci profile when .config/nextest.toml exists', () => {
    const result = detect({
      'Cargo.toml': '[package]\nname = "svc"\n',
      '.config/nextest.toml': '[profile.ci.junit]\npath = "junit.xml"\n',
    });
    expect(result).toEqual({
      // nextest emits JUnit XML, so the JUnit adapter parses the report.
      family: 'junit',
      command: 'cargo nextest run --profile ci',
      reporterArgs: ['--profile', 'ci'],
      env: { ...BASE_ENV, NEXTEST_PROFILE: 'ci' },
      reportPath: REPORT_PATHS.nextest,
      note: expect.stringContaining('nextest.toml') as unknown as string,
    });
  });

  it('runs plain cargo test with a note when nextest is not configured', () => {
    const result = detect({ 'Cargo.toml': '[package]\nname = "svc"\n' });
    expect(result?.family).toBe('cargo');
    expect(result?.command).toBe('cargo test');
    expect(result?.reporterArgs).toEqual([]);
    expect(result?.note).toMatch(/cargo-nextest/);
  });
});

describe('detectTestCommand — invariants', () => {
  const cases: Array<Record<string, string>> = [
    { 'go.mod': 'module x' },
    { 'pytest.ini': '[pytest]' },
    { 'Cargo.toml': '[package]' },
    { 'Cargo.toml': '[package]', '.config/nextest.toml': '[profile.ci.junit]' },
    { 'package.json': PKG_JEST },
    { 'package.json': PKG_VITEST },
    { Makefile: 'test:\n\tpytest\n' },
  ];

  it('always sets the deterministic base environment', () => {
    for (const files of cases) {
      const result = detect(files);
      expect(result?.env).toMatchObject(BASE_ENV);
    }
  });

  it('always names a report path', () => {
    for (const files of cases) {
      expect(result0(files)).not.toBe('');
    }
  });

  it('either injects a reporter or explains why it could not', () => {
    for (const files of cases) {
      const result = detect(files);
      expect(result).not.toBeNull();
      const injected =
        (result?.reporterArgs.length ?? 0) > 0 ||
        Object.keys(result?.env ?? {}).some((k) => k === 'PYTEST_ADDOPTS' || k === 'GOFLAGS');
      expect(injected || result?.note !== undefined).toBe(true);
    }
  });

  it('disables result caching and retries for every injected runner', () => {
    expect(detect({ 'go.mod': 'module x' })?.command).toContain('-count=1');
    expect(detect({ 'pytest.ini': '[pytest]' })?.command).toContain('-p no:rerunfailures');
    expect(detect({ 'package.json': PKG_JEST })?.command).toContain('--ci');
  });

  function result0(files: Record<string, string>): string {
    return detect(files)?.reportPath ?? '';
  }
});
