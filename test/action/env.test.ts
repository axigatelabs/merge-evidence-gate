/**
 * `src/action/env.ts` is the seam between a real checkout and the pure core:
 * everything the Action reads from disk or from `git` is turned into plain data
 * here, so these tests pin that translation without needing a runner, a network
 * or a GitHub token.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MANIFEST_FILES,
  parseNameStatus,
  probeToolchain,
  readManifests,
  readReport,
  readTextFile,
} from '../../src/action/env.js';

// ---------------------------------------------------------------------------
// parseNameStatus
// ---------------------------------------------------------------------------

describe('parseNameStatus', () => {
  it('reads every status code, keeping the rename target as the path', () => {
    const nameStatus = [
      'A\tsrc/added.ts',
      'M\tsrc/modified.ts',
      'D\ttest/gone.test.ts',
      'R096\ttest/old-name.test.ts\ttest/new-name.test.ts',
      'C075\tsrc/template.ts\tsrc/copy.ts',
      'T\tscripts/link.sh',
    ].join('\n');

    expect(parseNameStatus(nameStatus)).toEqual([
      { path: 'src/added.ts', status: 'A' },
      { path: 'src/modified.ts', status: 'M' },
      { path: 'test/gone.test.ts', status: 'D' },
      { path: 'test/new-name.test.ts', status: 'R', oldPath: 'test/old-name.test.ts' },
      { path: 'src/copy.ts', status: 'C', oldPath: 'src/template.ts' },
      { path: 'scripts/link.sh', status: 'T' },
    ]);
  });

  it('attaches each file its own patch, split out of one diff', () => {
    const nameStatus = ['A\tsrc/a.ts', 'M\tsrc/b.ts', 'D\tsrc/c.ts'].join('\n');
    const patches = [
      'diff --git a/src/a.ts b/src/a.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/a.ts',
      '@@ -0,0 +1 @@',
      "+export const a = 'added';",
      'diff --git a/src/b.ts b/src/b.ts',
      'index 2222222..3333333 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -3 +3 @@',
      '-const b = 1;',
      '+const b = 2;',
      'diff --git a/src/c.ts b/src/c.ts',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/src/c.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-const c = 3;',
      '',
    ].join('\n');

    const files = parseNameStatus(nameStatus, patches);
    const byPath = new Map(files.map((file) => [file.path, file]));

    expect(byPath.get('src/a.ts')?.patch).toContain("+export const a = 'added';");
    expect(byPath.get('src/a.ts')?.patch).not.toContain('const b = 2;');
    expect(byPath.get('src/b.ts')?.patch).toContain('+const b = 2;');
    expect(byPath.get('src/b.ts')?.patch).not.toContain('added');
    // A deleted file's patch is found through its `--- a/` side (`+++` is /dev/null).
    expect(byPath.get('src/c.ts')?.patch).toContain('-const c = 3;');
  });

  it('matches a rename patch to the new path', () => {
    const nameStatus = 'R100\ttest/old.test.ts\ttest/new.test.ts';
    const patches = [
      'diff --git a/test/old.test.ts b/test/new.test.ts',
      'similarity index 92%',
      'rename from test/old.test.ts',
      'rename to test/new.test.ts',
      '--- a/test/old.test.ts',
      '+++ b/test/new.test.ts',
      '@@ -1 +1 @@',
      "-it('old', () => {});",
      "+it.only('new', () => {});",
      '',
    ].join('\n');

    const [file] = parseNameStatus(nameStatus, patches);
    expect(file).toMatchObject({ path: 'test/new.test.ts', status: 'R', oldPath: 'test/old.test.ts' });
    expect(file?.patch).toContain("+it.only('new', () => {});");
  });

  it('leaves patch unset when the diff carries none for that file', () => {
    const [file] = parseNameStatus('M\tsrc/only.ts');
    expect(file).toEqual({ path: 'src/only.ts', status: 'M' });
    expect(file && 'patch' in file).toBe(false);
  });

  it('ignores blank lines, headers and unknown status codes', () => {
    const files = parseNameStatus(['', 'X\tsrc/mystery.ts', 'M\tsrc/real.ts', '   ', 'U\tsrc/conflict.ts'].join('\n'));
    expect(files.map((file) => file.path)).toEqual(['src/real.ts']);
  });

  it('de-duplicates a path listed twice', () => {
    const files = parseNameStatus(['M\tsrc/a.ts', 'M\tsrc/a.ts'].join('\n'));
    expect(files).toHaveLength(1);
  });

  it('unquotes paths git escaped, and accepts NUL-separated output', () => {
    const quoted = parseNameStatus('A\t"src/with space/caf\\303\\251.ts"');
    expect(quoted[0]?.path).toBe('src/with space/café.ts');

    const nulSeparated = parseNameStatus('M\0src/a.ts\nA\0src/b.ts');
    expect(nulSeparated.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns an empty list for empty input', () => {
    expect(parseNameStatus('')).toEqual([]);
    expect(parseNameStatus('', 'diff --git a/x b/x\n')).toEqual([]);
  });

  it('parses the output of a real git diff', () => {
    const repo = mkdtempSync(join(tmpdir(), 'meg-git-'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'gate@example.test');
      git('config', 'user.name', 'Gate');
      mkdirSync(join(repo, 'test'), { recursive: true });
      writeFileSync(join(repo, 'test', 'keep.test.ts'), "it('keeps', () => {});\n");
      writeFileSync(join(repo, 'test', 'drop.test.ts'), "it('drops', () => {});\n");
      git('add', '-A');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD').trim();

      rmSync(join(repo, 'test', 'drop.test.ts'));
      writeFileSync(join(repo, 'test', 'keep.test.ts'), "it.only('keeps', () => {});\n");
      writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
      git('add', '-A');
      git('commit', '-qm', 'head');
      const head = git('rev-parse', 'HEAD').trim();

      const files = parseNameStatus(
        git('diff', '--name-status', `${base}...${head}`),
        git('diff', '--unified=0', `${base}...${head}`),
      );
      const byPath = new Map(files.map((file) => [file.path, file]));

      expect(byPath.get('test/drop.test.ts')?.status).toBe('D');
      expect(byPath.get('src.ts')?.status).toBe('A');
      expect(byPath.get('test/keep.test.ts')?.status).toBe('M');
      expect(byPath.get('test/keep.test.ts')?.patch).toContain('+it.only');
      expect(byPath.get('src.ts')?.patch).not.toContain('it.only');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readManifests / readReport / probeToolchain
// ---------------------------------------------------------------------------

describe('readManifests', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'meg-manifests-'));
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    writeFileSync(join(dir, 'go.mod'), 'module example.test\n');
    writeFileSync(join(dir, 'GNUmakefile'), 'test:\n\tgo test ./...\n');
    mkdirSync(join(dir, '.config'), { recursive: true });
    writeFileSync(join(dir, '.config', 'nextest.toml'), '[profile.ci.junit]\npath = "junit.xml"\n');
    writeFileSync(join(dir, 'unrelated.txt'), 'ignored');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the manifests that exist and nothing else', () => {
    const files = readManifests(dir);
    expect(files['package.json']).toContain('vitest run');
    expect(files['go.mod']).toContain('module example.test');
    expect(files['.config/nextest.toml']).toContain('junit.xml');
    expect(files['Cargo.toml']).toBeUndefined();
    expect(Object.keys(files).every((key) => !key.includes('unrelated'))).toBe(true);
  });

  it('aliases GNUmakefile onto the Makefile key detectTestCommand looks up', () => {
    expect(readManifests(dir)['Makefile']).toContain('go test ./...');
  });

  it('returns an empty map for a directory with no manifests', () => {
    const empty = mkdtempSync(join(tmpdir(), 'meg-empty-'));
    try {
      expect(readManifests(empty)).toEqual({});
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('lists only filenames, never globs', () => {
    expect(MANIFEST_FILES).toContain('package.json');
    expect(MANIFEST_FILES.some((name) => name.includes('*'))).toBe(false);
  });
});

describe('readReport and readTextFile', () => {
  it('returns undefined for a missing, unreadable or blank file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meg-report-'));
    try {
      expect(readReport(join(dir, 'nope.json'))).toBeUndefined();
      expect(readTextFile(join(dir, 'nope.json'))).toBeUndefined();
      // A directory is unreadable as a file.
      expect(readTextFile(dir)).toBeUndefined();

      writeFileSync(join(dir, 'blank.json'), '   \n');
      expect(readReport(join(dir, 'blank.json'))).toBeUndefined();

      writeFileSync(join(dir, 'report.json'), '{"ok":true}');
      expect(readReport(join(dir, 'report.json'))).toBe('{"ok":true}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('probeToolchain', () => {
  it('records the node version it is running under and never throws', () => {
    const versions = probeToolchain(process.cwd());
    expect(versions['node']).toBe(process.version.replace(/^v/, ''));
    for (const value of Object.values(versions)) {
      expect(value).toMatch(/^\d+\.\d+/);
    }
  });
});
