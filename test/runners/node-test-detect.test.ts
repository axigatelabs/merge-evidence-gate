import { describe, expect, it } from 'vitest';
import { detectTestCommand, detectWorkspaceCommand, REPORT_PATHS } from '../../src/core/runners/index.js';

const REPORT = REPORT_PATHS['node-test'];
const NODE_OPTIONS = `--test-reporter=junit --test-reporter-destination=${REPORT}`;

const detect = (files: Record<string, string | undefined>, explicit?: string) =>
  detectTestCommand(explicit === undefined ? { files } : { files, explicit });

describe("detectTestCommand — node's built-in runner", () => {
  it('runs `npm test` unchanged and attaches the junit reporter through NODE_OPTIONS', () => {
    const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
    const result = detect({ 'package.json': pkg, 'package-lock.json': '{}' });
    expect(result?.family).toBe('node-test');
    expect(result?.command).toBe('npm test');
    expect(result?.reporterArgs).toEqual(['--test-reporter=junit', `--test-reporter-destination=${REPORT}`]);
    expect(result?.env['NODE_OPTIONS']).toBe(NODE_OPTIONS);
    expect(result?.env['CI']).toBe('1');
    expect(result?.reportPath).toBe(REPORT);
    expect(result?.note).toBeUndefined();
  });

  it('recognises the flag among others and behind tsx, but not --test-only', () => {
    for (const script of [
      'node --experimental-strip-types --test',
      'node --import tsx --test test/',
      'node --test-concurrency=2 --test',
      'tsx --test',
    ]) {
      const pkg = JSON.stringify({ scripts: { test: script } });
      expect(detect({ 'package.json': pkg })?.family, script).toBe('node-test');
    }
    const only = JSON.stringify({ scripts: { test: 'node --test-only' } });
    expect(detect({ 'package.json': only })?.family).toBe('npm');
  });

  it('follows the package manager the lockfile implies, with nothing appended', () => {
    const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
    expect(detect({ 'package.json': pkg, 'pnpm-lock.yaml': '' })?.command).toBe('pnpm test');
    expect(detect({ 'package.json': pkg, 'yarn.lock': '' })?.command).toBe('yarn test');
  });

  it('wraps a direct `node --test` written as the explicit command', () => {
    const result = detect({}, 'node --test test/unit');
    expect(result?.family).toBe('node-test');
    expect(result?.command).toBe('node --test test/unit');
    expect(result?.env['NODE_OPTIONS']).toBe(NODE_OPTIONS);
  });

  it('gives a directly written reporter its stdout destination so a second reporter is legal', () => {
    const result = detect({}, 'node --test --test-reporter=spec test/');
    expect(result?.command).toBe('node --test --test-reporter-destination=stdout --test-reporter=spec test/');
    expect(result?.env['NODE_OPTIONS']).toBe(NODE_OPTIONS);
    const balanced = detect({}, 'node --test --test-reporter=spec --test-reporter-destination=stdout');
    expect(balanced?.command).toBe('node --test --test-reporter=spec --test-reporter-destination=stdout');
  });

  it('cannot attach a reporter to a script that sets its own without a destination, and says why', () => {
    const pkg = JSON.stringify({ scripts: { test: 'node --test --test-reporter=spec' } });
    const result = detect({ 'package.json': pkg });
    expect(result?.family).toBe('node-test');
    expect(result?.command).toBe('npm test');
    expect(result?.reporterArgs).toEqual([]);
    expect(result?.env['NODE_OPTIONS']).toBeUndefined();
    expect(result?.note).toMatch(/--test-reporter-destination=stdout/);
  });

  it('attaches the reporter when the script pairs its own reporter with a destination', () => {
    const pkg = JSON.stringify({ scripts: { test: 'node --test --test-reporter=spec --test-reporter-destination=stdout' } });
    expect(detect({ 'package.json': pkg })?.env['NODE_OPTIONS']).toBe(NODE_OPTIONS);
  });

  it('reaches the runner through a Makefile target', () => {
    const result = detect({ Makefile: 'test:\n\tnode --test\n' });
    expect(result?.family).toBe('node-test');
    expect(result?.command).toBe('make test');
    expect(result?.env['NODE_OPTIONS']).toBe(NODE_OPTIONS);
  });

  it('follows a chained `test` script to the step that runs node --test', () => {
    const pkg = JSON.stringify({
      scripts: { test: 'npm run build && npm run test:unit', 'test:unit': 'node --test' },
    });
    const result = detect({ 'package.json': pkg });
    expect(result?.command).toBe('npm run test:unit');
    expect(result?.family).toBe('node-test');
    expect(result?.note).toMatch(/chains to `test:unit`/);
  });

  it('runs a workspace package on node --test from its own directory', () => {
    const result = detectWorkspaceCommand({
      rootFiles: { 'package.json': JSON.stringify({ private: true }), 'pnpm-lock.yaml': '' },
      packages: [{ dir: 'apps/manor', files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) } }],
    });
    expect(result?.family).toBe('node-test');
    expect(result?.command).toContain("(cd 'apps/manor' && ");
    expect(result?.command).toContain('pnpm test)');
    expect(result?.env['NODE_OPTIONS']).toBe(NODE_OPTIONS);
    expect(result?.reportPath).toBe(REPORT);
  });
});
