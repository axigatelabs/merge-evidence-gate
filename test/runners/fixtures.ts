import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read a fixture from `test/runners/fixtures/` as UTF-8 text. */
export function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}
