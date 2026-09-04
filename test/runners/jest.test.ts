import { describe, expect, it } from 'vitest';
import { parseJestJson } from '../../src/core/runners/adapters/jest.js';
import { fixture } from './fixtures.js';

const CART = '/home/runner/work/svc/src/cart/cart.test.ts';
const CHECKOUT = '/home/runner/work/svc/src/checkout/checkout.test.ts';

describe('Jest --json adapter', () => {
  const result = parseJestJson(fixture('jest-results.json'));

  it('builds ids from the test file path and the full name, sorted', () => {
    expect(result.tests.map((t) => t.id)).toEqual([
      `${CART}::Cart adds a line item`,
      `${CART}::Cart applies a coupon`,
      `${CART}::Cart rejects a negative quantity`,
      `${CHECKOUT}::Checkout charges the card once`,
      `${CHECKOUT}::Checkout emits a receipt`,
      `${CHECKOUT}::Checkout refunds a partial capture`,
    ]);
  });

  it('maps pending and todo to skipped, and keeps focused distinct', () => {
    const byId = new Map(result.tests.map((t) => [t.id, t.status]));
    expect(byId.get(`${CART}::Cart adds a line item`)).toBe('passed');
    expect(byId.get(`${CART}::Cart rejects a negative quantity`)).toBe('failed');
    expect(byId.get(`${CART}::Cart applies a coupon`)).toBe('skipped');
    expect(byId.get(`${CHECKOUT}::Checkout refunds a partial capture`)).toBe('skipped');
    expect(byId.get(`${CHECKOUT}::Checkout emits a receipt`)).toBe('focused');
  });

  it('surfaces invocations > 1 as a retry', () => {
    const retried = result.tests.find((t) => t.id.endsWith('charges the card once'));
    expect(retried?.invocations).toBe(2);
    const once = result.tests.find((t) => t.id.endsWith('adds a line item'));
    expect(once?.invocations).toBe(1);
  });

  it('records the file and duration', () => {
    const once = result.tests.find((t) => t.id.endsWith('adds a line item'));
    expect(once?.file).toBe(CART);
    expect(once?.durationMs).toBe(12);
  });

  it('totals the run, counting focused in run but not in passed', () => {
    expect(result.totals).toEqual({ run: 6, passed: 2, failed: 1, skipped: 2, retried: 1 });
  });
});

describe('Vitest --reporter=json adapter', () => {
  const result = parseJestJson(fixture('vitest-results.json'));
  const FILE = '/home/runner/work/gate/test/claims/parse.test.ts';

  it('reads the Jest-shaped report Vitest emits, using `name` as the file path', () => {
    expect(result.tests.map((t) => [t.id, t.status])).toEqual([
      [`${FILE}::parseClaims counts checked boxes`, 'passed'],
      [`${FILE}::parseClaims extracts a backticked command`, 'passed'],
      [`${FILE}::parseClaims records an unparseable caveat`, 'failed'],
    ]);
    expect(result.totals).toEqual({ run: 3, passed: 2, failed: 1, skipped: 0, retried: 0 });
  });

  it('omits invocations when the reporter does not provide it', () => {
    expect(result.tests.every((t) => t.invocations === undefined)).toBe(true);
  });
});

describe('Jest adapter robustness', () => {
  it('returns nothing for empty or malformed input', () => {
    const empty = { tests: [], totals: { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 } };
    expect(parseJestJson('')).toEqual(empty);
    expect(parseJestJson('not json')).toEqual(empty);
    expect(parseJestJson('{}')).toEqual(empty);
  });

  it('skips assertions with an unknown status', () => {
    const raw = JSON.stringify({
      testResults: [
        {
          name: '/repo/a.test.ts',
          assertionResults: [
            { fullName: 'a works', status: 'passed' },
            { fullName: 'a mystery', status: 'quantum' },
          ],
        },
      ],
    });
    expect(parseJestJson(raw).tests.map((t) => t.id)).toEqual(['/repo/a.test.ts::a works']);
  });
});
