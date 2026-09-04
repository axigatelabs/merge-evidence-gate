import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, parsePolicyYaml, resolveSeverity } from '../../src/core/reconcile/index.js';
import type { Policy } from '../../src/core/types.js';

describe('DEFAULT_POLICY', () => {
  it('matches the v1 severities in docs/receipt-spec.md', () => {
    expect(DEFAULT_POLICY.version).toBe('1.0.0');
    expect(DEFAULT_POLICY.agentsOnly).toBe(true);
    expect(DEFAULT_POLICY.severity).toEqual({
      C1: 'fail',
      C2: 'needs-human',
      C3: 'fail',
      C4: 'fail',
      C5: 'needs-human',
      C6: 'needs-human',
      C7: 'needs-human',
      C8: 'info',
    });
  });
});

describe('resolveSeverity', () => {
  it('uses the policy override when present', () => {
    const policy: Policy = { version: '1.0.0', severity: { C2: 'info' } };
    expect(resolveSeverity('C2', policy)).toBe('info');
  });

  it('falls back to the v1 default for checks the policy does not mention', () => {
    const policy: Policy = { version: '1.0.0', severity: { C2: 'info' } };
    expect(resolveSeverity('C3', policy)).toBe('fail');
    expect(resolveSeverity('C8', policy)).toBe('info');
  });

  it('falls back to the v1 default when the policy has no severity map at all', () => {
    expect(resolveSeverity('C1', { version: '2.0.0' })).toBe('fail');
  });
});

const EXAMPLE_YAML = `# Copy to \`.merge-evidence.yml\` in your repository root to tune the gate.
version: 1

# Explicit test command.
test-command: go test ./...   # overrides detection

# Only gate PRs that look agent-authored.
agents-only: true

severity:
  # C2: claimed test count differs from what ran
  C2: info
  C5: fail

scope-allow:
  - "docs/**"
  - CHANGELOG.md
`;

describe('parsePolicyYaml', () => {
  const parsed = parsePolicyYaml(EXAMPLE_YAML);

  it('reads the top-level scalars, stripping comments and quotes', () => {
    expect(parsed.version).toBe('1');
    expect(parsed.testCommand).toBe('go test ./...');
    expect(parsed.agentsOnly).toBe(true);
  });

  it('reads the nested severity map', () => {
    expect(parsed.severity).toEqual({ C2: 'info', C5: 'fail' });
  });

  it('reads the scope-allow sequence', () => {
    expect(parsed.scopeAllow).toEqual(['docs/**', 'CHANGELOG.md']);
  });

  it('round-trips: what it parses is what resolveSeverity then applies', () => {
    expect(resolveSeverity('C2', parsed)).toBe('info');
    expect(resolveSeverity('C5', parsed)).toBe('fail');
    // untouched checks keep the v1 defaults
    expect(resolveSeverity('C1', parsed)).toBe('fail');
    expect(resolveSeverity('C8', parsed)).toBe('info');
  });

  it('is deterministic — parsing twice yields identical JSON', () => {
    expect(JSON.stringify(parsePolicyYaml(EXAMPLE_YAML))).toBe(
      JSON.stringify(parsePolicyYaml(EXAMPLE_YAML)),
    );
  });

  it('returns the default version and no overrides for an empty file', () => {
    const empty = parsePolicyYaml('# nothing but a comment\n\n');
    expect(empty).toEqual({ version: DEFAULT_POLICY.version });
  });

  it('ignores unknown keys, unknown checks, and invalid severities', () => {
    const policy = parsePolicyYaml(
      ['future-key: 12', 'severity:', '  C9: fail', '  C3: shout', '  C4: info'].join('\n'),
    );
    expect(policy.severity).toEqual({ C4: 'info' });
    expect(Object.keys(policy)).toEqual(['version', 'severity']);
  });

  it('accepts agents-only: false and quoted scalars', () => {
    const policy = parsePolicyYaml(['agents-only: false', "test-command: 'npm test -- --run'"].join('\n'));
    expect(policy.agentsOnly).toBe(false);
    expect(policy.testCommand).toBe('npm test -- --run');
  });

  it('does not treat a # inside a quoted scalar as a comment', () => {
    const policy = parsePolicyYaml('test-command: "make test # all"');
    expect(policy.testCommand).toBe('make test # all');
  });

  it('stops a nested block at the next top-level key', () => {
    const policy = parsePolicyYaml(
      ['severity:', '  C3: info', 'scope-allow:', '  - docs/**', 'agents-only: true'].join('\n'),
    );
    expect(policy.severity).toEqual({ C3: 'info' });
    expect(policy.scopeAllow).toEqual(['docs/**']);
    expect(policy.agentsOnly).toBe(true);
  });
});
