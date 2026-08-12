// FG-703: the canonical adjudication-identity contract.
//
// A narrow, operator-authorized adjudication lifecycle retires an exact
// orphaned_work_may_persist ops incident (outcome no_unique_work) from the
// active high-severity report while preserving the failed task, failed run,
// detector evidence, rationale, actor and timestamp as durable audit history.
//
// This module owns the ONE identity function used at BOTH the adjudication-write
// side and the detection-suppression side — neither re-derives identity
// independently. Incident identity is a pure function of detector-owned
// STRUCTURED facts on the latest task.failed payload; it never reads rendered
// evidence text and never performs a live re-scan.
//
// The field partition is the central design decision (AC1):
//
//   IDENTITY-BEARING (a change here is a materially different WORK incident, so
//   the adjudication no longer applies and the incident reappears as unresolved):
//     - anchor:            runId, taskId
//     - failure_kind
//     - work-output facts: resultState, recoverableStdoutResult
//     - evidence source:   source ("worktree" | "project_dir_shared")
//     - terminal cause:    containerExitedEventObserved, exitCode, oomKilled, signal
//     - changed-file SET:  ONLY when source === "worktree" (a dedicated,
//                          task-exclusive worktree — a stable fact about THIS
//                          task's work), as a sorted, de-duplicated set.
//
//   VOLATILE / EXCLUDED (a change here must NOT invalidate an adjudication):
//     - changedFiles when source !== "worktree" (the four live incidents share a
//       dirty project_dir_shared checkout whose changed-file count differs on
//       every re-scan — hashing it would invalidate every adjudication on the
//       next `forge ops check`)
//     - worktreePathChecked and every absolute path
//     - startedAt / finishedAt and every other timestamp
//     - dockerStateError / resultWriteFailed (best-effort prose diagnostics)
//     - the top-level rendered `error` string and every rendered evidence[] line
//
// This is a strict superset of the notify dedupe key (kind+runId+taskId,
// ops.ts:40): that key is too weak — a genuinely NEW incident on the same task
// would inherit a stale adjudication. Binding identity to the structured work
// facts above fixes both failure modes at once (over-broad whole-evidence hash
// and under-broad anchor-only key).

import type { OrphanEvidence } from "../v2/failure-kind.js";
import { sha256OfString } from "../util/content-digest.js";

/** The structured facts an incident's identity is derived from. Both the write
 *  side (performAdjudicate) and the detect side (detectOrphanedWorkMayPersist)
 *  assemble this from the SAME source — the anchor (runId, taskId) off the task
 *  row and the failure_kind + evidence off the latest task.failed payload — and
 *  hand it here. Neither side re-derives the identity string itself. */
export type AdjudicationIdentityInput = {
  runId: string;
  taskId: string;
  failureKind: string;
  /** The OrphanEvidence tuple off the latest task.failed payload, when present.
   *  A pre-evidence task.failed (or a kind that records none) omits it. */
  evidence?: OrphanEvidence | undefined;
};

// The identity-bearing projection, with a FIXED key order so JSON.stringify is
// deterministic. A field the evidence does not carry is recorded as null rather
// than omitted, so "field absent" and "field present but volatile" never collide
// on the same serialized shape.
type CanonicalIdentity = {
  runId: string;
  taskId: string;
  failureKind: string;
  resultState: OrphanEvidence["resultState"] | null;
  recoverableStdoutResult: boolean | null;
  source: OrphanEvidence["source"] | null;
  containerExitedEventObserved: boolean | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  signal: string | null;
  // The sorted, de-duplicated changed-file SET — ONLY when source === "worktree".
  // null for project_dir_shared / no-source evidence and for no-evidence: the
  // shared-checkout changed-file list is volatile and must not bind identity.
  worktreeChangedFiles: string[] | null;
};

function canonicalIdentity(input: AdjudicationIdentityInput): CanonicalIdentity {
  const e = input.evidence;
  // A worktree-sourced diff is task-exclusive and stable; hash it as a SET
  // (sorted + de-duplicated) so file-order churn does not invalidate but a
  // genuinely different set of touched files does. Any other source (or none)
  // contributes no changed-file fact to identity.
  const worktreeChangedFiles =
    e && e.source === "worktree"
      ? Array.from(new Set(e.changedFiles)).sort()
      : null;
  return {
    runId: input.runId,
    taskId: input.taskId,
    failureKind: input.failureKind,
    resultState: e?.resultState ?? null,
    recoverableStdoutResult: e?.recoverableStdoutResult ?? null,
    source: e?.source ?? null,
    containerExitedEventObserved: e?.containerExitedEventObserved ?? null,
    exitCode: e?.exitCode ?? null,
    oomKilled: e?.oomKilled ?? null,
    signal: e?.signal ?? null,
    worktreeChangedFiles,
  };
}

/** The one canonical identity string for an incident, derived from detector-owned
 *  structured facts only. Stable across volatile churn (shared-checkout changed
 *  files, absolute paths, timestamps, rendered prose); changes when any
 *  identity-bearing WORK fact changes. Both the adjudication write and the
 *  detection suppression call this — neither re-derives it. */
export function computeAdjudicationIdentity(input: AdjudicationIdentityInput): string {
  // Fixed-key-order object → deterministic JSON → sha256. The object literal in
  // canonicalIdentity fixes the key order, so JSON.stringify is stable without a
  // custom serializer.
  return sha256OfString(JSON.stringify(canonicalIdentity(input)));
}
