/**
 * Claims module: what the PR body SAID, and whether an agent wrote it.
 *
 * `detectAgent` decides if the gate should run at all; `extractClaims` turns the
 * body into the structured claims the reconcile step checks against ObservedRun.
 */
export { detectAgent } from './detect.js';
export { extractClaims } from './extract.js';
