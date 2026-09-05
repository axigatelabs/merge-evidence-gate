/**
 * A repository that is several projects side by side — Infisical's `backend/`
 * and `frontend/` each with their own lockfile — needs each touched project's
 * dependencies installed; the root install does not reach them. Every
 * Infisical backend run in the study had failed with `vitest: not found`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { packageInstallPlans, workspacePackages } from '../../src/pipeline.js';

describe('packageInstallPlans', () => {
  it('plans a frozen install for a touched package with its own lockfile and no node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meg-pkginst-'));
    mkdirSync(join(dir, 'backend'), { recursive: true });
    writeFileSync(join(dir, 'backend/package.json'), '{"name":"backend","scripts":{"test:unit":"vitest run"}}');
    writeFileSync(join(dir, 'backend/package-lock.json'), '{}');
    mkdirSync(join(dir, 'frontend'), { recursive: true });
    writeFileSync(join(dir, 'frontend/package.json'), '{"name":"frontend"}');
    writeFileSync(join(dir, 'frontend/pnpm-lock.yaml'), 'lockfileVersion: 9');
    mkdirSync(join(dir, 'frontend/node_modules'));
    mkdirSync(join(dir, 'packages/ws'), { recursive: true });
    writeFileSync(join(dir, 'packages/ws/package.json'), '{"name":"ws"}');

    const packages = workspacePackages(dir, [
      { path: 'backend/src/a.ts', status: 'M' },
      { path: 'frontend/src/b.tsx', status: 'M' },
      { path: 'packages/ws/index.ts', status: 'M' },
    ]);
    expect(packageInstallPlans(dir, packages)).toEqual([{ dir: 'backend', steps: [{ command: 'npm ci', frozen: true }] }]);
  });
});
