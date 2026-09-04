/**
 * Test-file recognition across ecosystems. C7 ("tests added" with no test
 * file in the diff) fires on an honest PR whenever the classifier misses the
 * repository's convention, and C3 fails a PR that deletes a product file the
 * classifier wrongly calls a test — so both directions here are guards.
 */
import { describe, expect, it } from 'vitest';

import { analyzeDiff } from '../../src/core/diff/analyze.js';
import { hasInlineTests, isTestFile } from '../../src/core/diff/classify.js';

describe('isTestFile across ecosystems', () => {
  it('recognises the conventions C7 depends on', () => {
    for (const path of [
      'pkg/node/prune_test.go',
      'tests/test_login.py',
      'src/login_test.py',
      'src/login.test.ts',
      'src/login.spec.tsx',
      'src/__tests__/login.js',
      'spec/models/user_spec.rb',
      'test/models/user_test.rb',
      'spec/javascripts/app.spec.js',
      'Tests/FooTests/BarTests.swift',
      'src/Foo/Tests/BarTest.php',
      'src/test/java/com/x/UserTest.java',
      'src/main/kotlin/UserTest.kt',
      'Api.Tests/UserTests.cs',
      'src/test/scala/UserSpec.scala',
      'cypress/e2e/login.cy.ts',
      'e2e/checkout.ts',
      'mastracode/tui/e2e/tui/stream-error-retry.ts',
      'crates/parser/tests/roundtrip.rs',
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
  });

  it('does not treat product code, documents, models, or locale files as tests', () => {
    for (const path of [
      'src/login.ts',
      'src/testing-utils.ts',
      'src/components/Button.stories.tsx',
      'src/__mocks__/api.ts',
      'docs/testing.md',
      'src/lib.rs',
      'contest/entry.py',
      // `spec/` and `specs/` hold specifications, not only RSpec
      'api/spec/openapi.yaml',
      'docs/spec/rfc-0001.md',
      'specs/003-chat-system/spec.md',
      'apps/docs/spec/supabase_js_v2.yml',
      // `*Spec` is a product class name in JVM languages
      'src/main/java/io/kubernetes/client/openapi/models/V1PodSpec.java',
      'src/OpenApiSpec.kt',
      // `.cy.` is also the Welsh locale
      'content/about.cy.md',
      'src/locale/messages.cy.xlf',
      // e2e trees: only source files are tests
      'internal/e2e/README.md',
      'e2e/fixtures/users.json',
      'cypress.config.ts',
    ]) {
      expect(isTestFile(path), path).toBe(false);
    }
  });
});

describe('Rust inline tests', () => {
  const patch = ['@@ -1,2 +1,8 @@', ' fn add(a: i32, b: i32) -> i32 { a + b }', '+#[cfg(test)]', '+mod tests {', '+    #[test]', '+    fn adds() { assert_eq!(add(1, 2), 3); }', '+}'].join('\n');

  it('counts a source file that gains #[test] / #[cfg(test)] as a test edit', () => {
    expect(hasInlineTests('src/lib.rs', patch)).toBe(true);
    expect(hasInlineTests('src/lib.ts', patch)).toBe(false);
    expect(hasInlineTests('src/lib.rs', '@@ -1 +1 @@\n-fn a() {}\n+fn a() { }')).toBe(false);
    expect(hasInlineTests('src/lib.rs', undefined)).toBe(false);
  });

  it('lands in testFiles.modified through analyzeDiff', () => {
    const analysis = analyzeDiff([{ path: 'src/lib.rs', status: 'M', patch }]);
    expect(analysis.testFiles.modified).toEqual(['src/lib.rs']);
    expect(analysis.sourceFiles).toEqual([]);
  });
});
