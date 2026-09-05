/**
 * The verdict → job status step of the Action, kept apart from `main.ts` so it
 * can be tested without running the Action.
 */
import * as core from '@actions/core';
import type { Verdict } from '../core/types.js';

export type FailOn = 'fail' | 'needs-human' | 'never';

/** The three calls the step makes on `@actions/core`; tests pass a recorder. */
export interface VerdictSink {
  setFailed(message: string): void;
  warning(message: string): void;
  info(message: string): void;
}

/**
 * Translate the verdict into the job's exit status.
 *
 * `fail` (the default) fails the job on FAIL; `needs-human` also fails it on
 * NEEDS_HUMAN; `never` keeps the job green whatever the verdict — the comment,
 * job summary, artifact and outputs still carry it — which is how a team runs
 * the gate advisory-only before making it a required check.
 */
export function applyVerdict(verdict: Verdict, failOn: FailOn, title: string, sink: VerdictSink = core): void {
  if (failOn === 'never') {
    if (verdict === 'FAIL' || verdict === 'NEEDS_HUMAN') {
      sink.warning(`${title} — fail-on is 'never', so the job stays green; read the receipt`);
    } else {
      sink.info(title);
    }
    return;
  }
  if (verdict === 'FAIL') {
    sink.setFailed(title);
    return;
  }
  if (verdict === 'NEEDS_HUMAN') {
    if (failOn === 'needs-human') sink.setFailed(title);
    else sink.warning(`${title} — a human should look at this before merging`);
    return;
  }
  sink.info(title);
}
