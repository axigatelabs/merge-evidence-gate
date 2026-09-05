/**
 * Diff analysis — what the PR changed AROUND the tests.
 *
 * `analyzeDiff` takes the changed-file list the Action collected (a
 * `git diff --name-status base...head` plus per-file unified patches) and turns
 * it into the `DiffAnalysis` the reconcile step consumes. It is pure: no git, no
 * process execution, no filesystem, no network. Feed it the same input twice and
 * the output is byte-identical — every array is sorted before it is returned.
 */
import { minimatch } from 'minimatch';

import type { ChangedFile, DiffAnalysis } from '../types.js';
import {
  hasInlineTests,
  isDependencyFile,
  isSnapshotFile,
  isTestFile,
  verificationLayerReason,
} from './classify.js';
import { findFocusMarkers, findSkipMarkers, type MarkerHit } from './markers.js';

/** Options accepted by {@link analyzeDiff}. */
export interface AnalyzeDiffOptions {
  /** Globs (minimatch syntax) for paths allowed to change without counting as scope. */
  scopeAllow?: string[];
}

/** One verification-layer finding: the file, and why it counts. */
type VerificationEdit = DiffAnalysis['verificationLayerEdits'][number];

/** Code-unit comparison — locale-independent, so the order is the same on every runner. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted, de-duplicated copy of a path list — the determinism guarantee for every output array. */
function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compare);
}

/**
 * Marker hits ordered by file then marker, de-duplicated on the pair.
 *
 * Three added `it.only(` calls in one spec are one fact for a reviewer, and the
 * receipt's evidence lists are path lists, so repeating the pair would add noise
 * without adding information.
 */
function sortedHits(hits: MarkerHit[]): MarkerHit[] {
  const seen = new Map<string, MarkerHit>();
  for (const hit of hits) {
    seen.set(`${hit.file} :: ${hit.marker}`, hit);
  }
  return [...seen.values()].sort((a, b) =>
    a.file === b.file ? compare(a.marker, b.marker) : compare(a.file, b.file),
  );
}

/** Verification-layer edits ordered by file then reason, de-duplicated on the pair. */
function sortedEdits(edits: VerificationEdit[]): VerificationEdit[] {
  const seen = new Map<string, VerificationEdit>();
  for (const edit of edits) {
    seen.set(`${edit.file} :: ${edit.reason}`, edit);
  }
  return [...seen.values()].sort((a, b) =>
    a.file === b.file ? compare(a.reason, b.reason) : compare(a.file, b.file),
  );
}

/** True when any scope-allow glob covers this path. */
function isScopeAllowed(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => minimatch(path, glob, { dot: true }));
}

/**
 * A rename we can actually report needs both endpoints. Git supplies `oldPath`
 * for `R`/`C` entries; if it is missing the entry is malformed, and we degrade to
 * treating the file as modified rather than inventing a `from`.
 */
function renameEndpoints(file: ChangedFile): { from: string; to: string } | null {
  if (file.oldPath === undefined || file.oldPath === file.path) return null;
  return { from: file.oldPath, to: file.path };
}

/**
 * Analyse a PR's changed files.
 *
 * Status handling follows `git diff --name-status`: `A` added, `M` modified,
 * `D` deleted, `R` renamed. `C` (copy) is reported as an addition — a new path
 * appears — and `T` (type change) as a modification, since the path survives.
 */
export function analyzeDiff(files: ChangedFile[], opts?: AnalyzeDiffOptions): DiffAnalysis {
  const scopeAllow = opts?.scopeAllow ?? [];

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  const skipMarkersAdded: MarkerHit[] = [];
  const focusMarkersAdded: MarkerHit[] = [];
  const verificationLayerEdits: VerificationEdit[] = [];
  const dependencyFiles: string[] = [];
  const snapshotFiles: string[] = [];
  const sourceFiles: string[] = [];

  for (const file of files) {
    const rename = file.status === 'R' || file.status === 'C' ? renameEndpoints(file) : null;

    // A rename counts as touching a test when EITHER endpoint is a test path:
    // `foo.go` → `foo_test.go` and `a_test.go` → `b.go` both move test coverage.
    // A Rust source file that gains an inline `#[test]` counts as a test edit.
    const isTest =
      isTestFile(file.path) ||
      (rename !== null && isTestFile(rename.from)) ||
      hasInlineTests(file.path, file.patch);
    const isSnapshot = isSnapshotFile(file.path);
    const isDependency = isDependencyFile(file.path);

    if (isTest) {
      if (file.status === 'R' && rename !== null) {
        // Only a rename that takes a file OUT of the test set moves coverage
        // away (`a_test.go` → `b_helper.go`). A test renamed to another test
        // path — a refactor — keeps its coverage and is a modified test; a
        // source file renamed into the test set is an added test.
        const fromTest = isTestFile(rename.from);
        const toTest = isTestFile(rename.to);
        if (fromTest && !toTest) renamed.push(rename);
        else if (!fromTest && toTest) added.push(rename.to);
        else modified.push(rename.to);
      } else if (file.status === 'D') {
        deleted.push(file.path);
      } else if (file.status === 'A' || (file.status === 'C' && rename !== null)) {
        added.push(file.path);
      } else {
        // 'M', 'T', and any 'R'/'C' entry that arrived without a usable oldPath.
        modified.push(file.path);
      }

      // Markers are only meaningful in test files, and only on lines this PR adds.
      skipMarkersAdded.push(...findSkipMarkers(file));
      focusMarkersAdded.push(...findFocusMarkers(file));
    }

    // The verification layer is checked over EVERY file: a `|| true` in a shell
    // script or a lowered threshold in a config is not a test file at all.
    const reason = verificationLayerReason(file.path, file.patch);
    if (reason !== null) {
      verificationLayerEdits.push({ file: file.path, reason });
    }

    if (isDependency) dependencyFiles.push(file.path);
    if (isSnapshot) snapshotFiles.push(file.path);

    // Everything else is product source, minus whatever policy says may move freely.
    if (!isTest && !isDependency && !isSnapshot && !isScopeAllowed(file.path, scopeAllow)) {
      sourceFiles.push(file.path);
    }
  }

  return {
    testFiles: {
      added: sortedUnique(added),
      modified: sortedUnique(modified),
      deleted: sortedUnique(deleted),
      renamed: renamed
        .slice()
        .sort((a, b) => (a.to === b.to ? compare(a.from, b.from) : compare(a.to, b.to))),
    },
    skipMarkersAdded: sortedHits(skipMarkersAdded),
    focusMarkersAdded: sortedHits(focusMarkersAdded),
    verificationLayerEdits: sortedEdits(verificationLayerEdits),
    dependencyFiles: sortedUnique(dependencyFiles),
    snapshotFiles: sortedUnique(snapshotFiles),
    sourceFiles: sortedUnique(sourceFiles),
  };
}
