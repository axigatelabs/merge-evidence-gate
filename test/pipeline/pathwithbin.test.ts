import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { pathWithBin } from '../../src/pipeline.js';

describe('pathWithBin', () => {
  it('puts the checkout\'s node_modules/.bin first when it exists, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meg-bin-'));
    expect(pathWithBin(dir, '/usr/bin:/bin')).toBe('/usr/bin:/bin');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin');
    expect(pathWithBin(dir, '/usr/bin:/bin')).toBe(`${bin}:/usr/bin:/bin`);
    expect(pathWithBin(dir, `${bin}:/usr/bin`)).toBe(`${bin}:/usr/bin`);
    expect(pathWithBin(dir, '')).toBe(bin);
  });
});
