import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectAgent } from '../../src/core/claims/index.js';
import type { PullRequestFacts } from '../../src/core/types.js';

/** Vitest runs from the repo root, so fixtures resolve off the cwd. */
const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'test/claims/fixtures', name), 'utf8');

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    repo: 'acme/widgets',
    number: 341,
    headSha: '3f2a1c9',
    baseSha: '9b0e7d2',
    baseRef: 'main',
    headRef: 'feature/whatever',
    authorLogin: 'jrivera',
    body: '',
    title: 'Some change',
    commitMessages: [],
    ...overrides,
  };
}

describe('detectAgent — real agent PRs', () => {
  it('reports every family that fires on a Copilot PR', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'copilot-swe-agent[bot]',
        headRef: 'copilot/fix-pipeline-yaml-image',
        body: fixture('copilot-pipeline-yaml.md'),
        commitMessages: [
          'Default the tag in the renderer\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>',
        ],
      }),
    );

    expect(result.isAgent).toBe(true);
    expect(result.detected).toBe('copilot');
    expect(result.signals).toEqual([
      'login:copilot',
      'branch-prefix:copilot',
      'coauthor-trailer:copilot',
      'body-marker:copilot',
    ]);
  });

  it('detects Devin from the bot login, branch and session footer', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'devin-ai-integration[bot]',
        headRef: 'devin/1719-uploader-retry-budget',
        body: fixture('devin-gradle-build.md'),
      }),
    );

    expect(result.detected).toBe('devin');
    expect(result.signals).toEqual(['login:devin', 'branch-prefix:devin', 'body-marker:devin']);
  });

  it('detects Claude Code from the footer and the commit trailer', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'claude[bot]',
        headRef: 'claude/fix-run-tests-exit-code',
        body: fixture('claude-code-test-plan.md'),
        commitMessages: ['Propagate the suite exit code\n\nCo-Authored-By: Claude <noreply@anthropic.com>'],
      }),
    );

    expect(result.detected).toBe('claude');
    expect(result.signals).toEqual([
      'login:claude',
      'branch-prefix:claude',
      'coauthor-trailer:claude',
      'body-marker:claude',
    ]);
  });

  it('detects Cursor from the agent link and the Cursor Agent trailer', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'cursor[bot]',
        headRef: 'cursor/prune-orphans-9f13',
        body: fixture('cursor-cargo-prune.md'),
        commitMessages: ['prune: drop orphaned index entries\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>'],
      }),
    );

    expect(result.detected).toBe('cursor');
    expect(result.signals).toEqual([
      'login:cursor',
      'branch-prefix:cursor',
      'coauthor-trailer:cursor',
      'body-marker:cursor',
    ]);
  });

  it('detects Codex from the branch and task link even though the author is a human account', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'jrivera',
        headRef: 'codex/normalise-search-path',
        body: fixture('codex-blocked.md'),
      }),
    );

    expect(result.detected).toBe('codex');
    expect(result.signals).toEqual(['branch-prefix:codex', 'body-marker:codex']);
  });

  it('detects OpenCode from the bot login alone', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'opencode-agent[bot]',
        headRef: 'add-dry-run-flag',
        body: fixture('opencode-bun-tests.md'),
      }),
    );

    expect(result.detected).toBe('opencode');
    expect(result.signals).toEqual(['login:opencode']);
  });
});

describe('detectAgent — no signal', () => {
  it('leaves a human PR alone', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'jrivera',
        headRef: 'jrivera/reporting-pool-ceiling',
        body: fixture('human-no-signals.md'),
        commitMessages: ['Raise the reporting replica pool ceiling'],
      }),
    );

    expect(result).toEqual({ detected: 'unknown', signals: [], isAgent: false });
  });

  it('does not treat a mention of an agent in prose as a signal', () => {
    const result = detectAgent(
      facts({ body: 'Copilot suggested this approach in review, but I wrote it by hand.' }),
    );

    expect(result.isAgent).toBe(false);
  });
});

describe('detectAgent — markers are hints, never proof', () => {
  it('reports both marker hits when a body carries a Claude footer and a Codex link', () => {
    const result = detectAgent(
      facts({ headRef: 'feat/request-id', body: fixture('mixed-claude-codex.md') }),
    );

    expect(result.signals).toEqual(['body-marker:claude', 'body-marker:codex']);
    // Same family, so the marker table order decides: Claude is listed first.
    expect(result.detected).toBe('claude');
    expect(result.isAgent).toBe(true);
  });

  it('reports the Claude marker family once even when all three markers appear', () => {
    const result = detectAgent(
      facts({
        body: [
          'Generated with [Claude Code](https://claude.com/claude-code)',
          'https://claude.ai/code/session_01G2',
          '<!-- ccr-projects-attribution -->',
        ].join('\n'),
      }),
    );

    expect(result.signals).toEqual(['body-marker:claude']);
  });
});

describe('detectAgent — precedence login > branch-prefix > coauthor-trailer > body-marker', () => {
  it('lets the bot login win over a conflicting branch prefix and body marker', () => {
    const result = detectAgent(
      facts({
        authorLogin: 'cursor[bot]',
        headRef: 'codex/some-task',
        body: 'See https://chatgpt.com/codex/tasks/task_e_1',
      }),
    );

    expect(result.detected).toBe('cursor');
    expect(result.signals).toEqual(['login:cursor', 'branch-prefix:codex', 'body-marker:codex']);
  });

  it('lets the branch prefix win over a conflicting trailer and marker', () => {
    const result = detectAgent(
      facts({
        headRef: 'devin/1719-task',
        body: 'See https://chatgpt.com/codex/tasks/task_e_1',
        commitMessages: ['fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>'],
      }),
    );

    expect(result.detected).toBe('devin');
    expect(result.signals).toEqual(['branch-prefix:devin', 'coauthor-trailer:claude', 'body-marker:codex']);
  });

  it('lets a commit trailer win over a body marker', () => {
    const result = detectAgent(
      facts({
        body: 'See https://chatgpt.com/codex/tasks/task_e_1',
        commitMessages: ['fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>'],
      }),
    );

    expect(result.detected).toBe('claude');
    expect(result.signals).toEqual(['coauthor-trailer:claude', 'body-marker:codex']);
  });
});

describe('detectAgent — matching rules', () => {
  it('matches logins and branches case-insensitively', () => {
    const result = detectAgent(
      facts({ authorLogin: 'Copilot-SWE-Agent[bot]', headRef: 'Devin/1719-task' }),
    );

    expect(result.signals).toEqual(['login:copilot', 'branch-prefix:devin']);
    expect(result.detected).toBe('copilot');
  });

  it('requires a whole login, not a substring', () => {
    expect(detectAgent(facts({ authorLogin: 'not-cursor[bot]-either' })).isAgent).toBe(false);
  });

  it('requires the prefix at the start of the head branch', () => {
    expect(detectAgent(facts({ headRef: 'fix/copilot/rename' })).isAgent).toBe(false);
    expect(detectAgent(facts({ headRef: 'copilot/rename' })).detected).toBe('copilot');
  });

  it('searches every commit message for a trailer, not just the first', () => {
    const result = detectAgent(
      facts({ commitMessages: ['first commit', 'second\n\nCo-Authored-By: Claude <noreply@anthropic.com>'] }),
    );

    expect(result.signals).toEqual(['coauthor-trailer:claude']);
  });
});
