import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectTestCommand } from '../../src/core/runners/index.js';
import { parseReport } from '../../src/pipeline.js';

const vitestPkg = JSON.stringify({ name: 'x', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3' } });

describe('package-manager argument passthrough', () => {
  it('pnpm forwards reporter flags without a `--` separator (pnpm passes `--` through to the script)', () => {
    const d = detectTestCommand({ files: { 'package.json': vitestPkg, 'pnpm-lock.yaml': '' } });
    expect(d?.command).toBe('pnpm test --reporter=json --outputFile=.merge-evidence/vitest-results.json');
    expect(d?.command).not.toContain(' -- ');
  });

  it('npm needs the `--` separator', () => {
    const d = detectTestCommand({ files: { 'package.json': vitestPkg, 'package-lock.json': '{}' } });
    expect(d?.command).toBe('npm test -- --reporter=json --outputFile=.merge-evidence/vitest-results.json');
  });

  it('a written pnpm command (monorepo filter) also gets no `--`', () => {
    const d = detectTestCommand({
      explicit: 'pnpm --filter @acme/core test',
      files: { 'package.json': vitestPkg, 'pnpm-lock.yaml': '' },
    });
    expect(d?.command).toBe(
      'pnpm --filter @acme/core test --reporter=json --outputFile=.merge-evidence/vitest-results.json',
    );
  });
});

describe('parseReport never mistakes console output for a report', () => {
  it('records a missing-report note for a file-based runner instead of parsing stdout to zero silently', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'meg-parse-'));
    const detected = detectTestCommand({ files: { 'package.json': vitestPkg, 'pnpm-lock.yaml': '' } });
    if (detected === null) throw new Error('expected a vitest command');
    const notes: string[] = [];
    const result = parseReport(detected, workDir, ' ✓ src/a.test.ts (3 tests)\n Test Files 1 passed\n', notes);
    expect(result.totals.run).toBe(0);
    expect(notes.some((n) => n.includes('no machine-readable output'))).toBe(true);
  });
});
