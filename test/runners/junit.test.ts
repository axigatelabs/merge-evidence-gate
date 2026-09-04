import { describe, expect, it } from 'vitest';
import { parseJUnitXml } from '../../src/core/runners/adapters/junit.js';
import { fixture } from './fixtures.js';

describe('JUnit XML adapter — pytest', () => {
  const result = parseJUnitXml(fixture('pytest-junit.xml'));

  it('prefers file::name so ids match pytest node ids', () => {
    expect(result.tests.map((t) => t.id)).toEqual([
      'tests/test_auth.py::test_login_over_ldap',
      'tests/test_auth.py::test_login_rejects_bad_password',
      'tests/test_auth.py::test_login_sets_cookie',
      'tests/test_store.py::test_compacts_on_threshold',
    ]);
  });

  it('maps failure and skipped children', () => {
    const byId = new Map(result.tests.map((t) => [t.id, t]));
    expect(byId.get('tests/test_auth.py::test_login_sets_cookie')?.status).toBe('passed');
    expect(byId.get('tests/test_auth.py::test_login_rejects_bad_password')?.status).toBe('failed');
    expect(byId.get('tests/test_auth.py::test_login_over_ldap')?.status).toBe('skipped');
  });

  it('records the source file and duration', () => {
    const cookie = result.tests.find((t) => t.id.endsWith('::test_login_sets_cookie'));
    expect(cookie?.file).toBe('tests/test_auth.py');
    expect(cookie?.durationMs).toBeCloseTo(81, 6);
  });

  it('totals the run with no retries', () => {
    expect(result.totals).toEqual({ run: 4, passed: 2, failed: 1, skipped: 1, retried: 0 });
  });
});

describe('JUnit XML adapter — cargo-nextest', () => {
  const result = parseJUnitXml(fixture('nextest-junit.xml'));

  it('falls back to classname::name when no file attribute exists', () => {
    expect(result.tests.map((t) => t.id)).toEqual([
      'svc::net::tests::ipv6_only',
      'svc::net::tests::retries_on_timeout',
      'svc::store::tests::compacts_under_pressure',
      'svc::store::tests::put_then_get',
    ]);
  });

  it('counts a flakyFailure as a second invocation of a passing test', () => {
    const flaky = result.tests.find((t) => t.id.endsWith('compacts_under_pressure'));
    expect(flaky?.status).toBe('passed');
    expect(flaky?.invocations).toBe(2);
  });

  it('counts a rerunFailure alongside a failure', () => {
    const retried = result.tests.find((t) => t.id.endsWith('retries_on_timeout'));
    expect(retried?.status).toBe('failed');
    expect(retried?.invocations).toBe(2);
  });

  it('leaves a single-attempt test without an invocations field', () => {
    const clean = result.tests.find((t) => t.id.endsWith('put_then_get'));
    expect(clean?.invocations).toBeUndefined();
  });

  it('reports both retried tests in the totals', () => {
    expect(result.totals).toEqual({ run: 4, passed: 2, failed: 1, skipped: 1, retried: 2 });
  });
});

describe('JUnit XML adapter — generic', () => {
  it('treats an <error> child as a failure and handles a bare <testsuite> root', () => {
    const result = parseJUnitXml(fixture('generic-junit.xml'));
    expect(result.tests.map((t) => [t.id, t.status])).toEqual([
      ['com.acme.CartTest::addsLineItem', 'passed'],
      ['com.acme.CartTest::rejectsNegativeQuantity', 'failed'],
    ]);
    expect(result.totals).toEqual({ run: 2, passed: 1, failed: 1, skipped: 0, retried: 0 });
  });

  it('returns nothing for empty input', () => {
    expect(parseJUnitXml('   ')).toEqual({
      tests: [],
      totals: { run: 0, passed: 0, failed: 0, skipped: 0, retried: 0 },
    });
  });
});
