/**
 * Merge-Evidence Gate — GitHub Action entry point.
 *
 * Wiring lands in the `action` task; until then this stub keeps the bundle
 * buildable so the scaffold and the pure core modules can be developed and
 * tested independently.
 */
import * as core from '@actions/core';

export async function run(): Promise<void> {
  core.info('merge-evidence-gate: scaffold — action wiring pending');
  core.setOutput('verdict', 'NEUTRAL');
  core.setOutput('discrepancies', '0');
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
