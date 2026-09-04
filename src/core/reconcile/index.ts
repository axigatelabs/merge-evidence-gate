/**
 * Public surface of the reconcile module: claims + observed run + diff →
 * discrepancies → verdict → receipt → the PR comment.
 *
 * Consumers (the Action in src/main.ts, and tests) import from here rather than
 * reaching into the individual files, so the internal split stays free to move.
 */
export {
  CHECK_IDS,
  DEFAULT_POLICY,
  parsePolicyYaml,
  resolveSeverity,
  type ParsedPolicy,
} from './policy.js';
export {
  decideVerdict,
  missingAtHead,
  reconcile,
  type ReconcileInput,
  type ReconcileResult,
} from './reconcile.js';
export {
  buildReceipt,
  sha256,
  testsDigest,
  PREDICATE_TYPE,
  type BuildReceiptInput,
} from './receipt.js';
export {
  formatDuration,
  renderComment,
  COMMENT_MARKER,
  MAX_COMMENT_BYTES,
  MAX_TITLE_CHARS,
  type RenderOptions,
} from './render.js';
