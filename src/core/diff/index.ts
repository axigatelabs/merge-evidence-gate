/**
 * Public surface of the diff module: what the PR changed around the tests.
 *
 * Consumers import from here rather than reaching into the individual files, so
 * the internal split (path classifiers vs. patch scanners vs. the analyzer that
 * composes them) stays free to move.
 */
export { analyzeDiff, type AnalyzeDiffOptions } from './analyze.js';
export {
  addedLines,
  changedLines,
  isDependencyFile,
  isSnapshotFile,
  isTestFile,
  verificationLayerReason,
  REASON_AGENT_RULES,
  REASON_CI_WORKFLOW,
  REASON_COVERAGE_THRESHOLD,
  REASON_FAILURE_SUPPRESSED,
  REASON_TEST_INFRA,
} from './classify.js';
export {
  findFocusMarkers,
  findSkipMarkers,
  FOCUS_MARKERS,
  SKIP_MARKERS,
  type MarkerHit,
  type MarkerPattern,
} from './markers.js';
