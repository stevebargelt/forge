// FG-745: the durable WORKSPACE-PURPOSE store — WHAT a Forge-owned on-disk
// workspace IS, declared at creation or by an operator, and never inferred.
//
// WHY IT EXISTS. The Projects tab promotes every surviving run-derived or
// Forge-initialized directory to a top-level operator project, because
// listProjects() unions every runs.project_dir with the filesystem scan and the
// presentation filter only suppresses a checkout once it is GONE from disk. Any
// retained artifact — a disposable implementation clone, a per-task worktree, a
// deliberately-retained evidence fixture — therefore becomes a peer operator
// project merely because its directory still exists. FG-677 cleanup may delete an
// artifact proven disposable, but it cannot solve this: evidence-bearing,
// ambiguous, or intentionally retained artifacts must stay on disk WITHOUT
// becoming first-class projects.
//
// THE DISTINCTION IS A RECORDED FACT, NOT A HEURISTIC. This store answers "is this
// directory an operator project or a Forge artifact?" from a row that was written
// when Forge created the artifact (createWorktree/createTaskClone), when FG-677
// retained one, or when an operator classified a legacy directory by hand. It is
// NEVER inferred from a path prefix, a basename, a ticket-shaped name, a run
// count, a missing remote, or an age — every one of which the ticket forbids.
//
// THE FAIL-SAFE IS INVERTED FROM launch-observations.ts (FG-700). There an unknown
// purpose fails CLOSED to `generic` (the weakest claim). Here an unknown purpose
// fails OPEN to `unclassified`, which stays VISIBLE as a (flagged) operator
// project — because hiding a REAL independent project is the expensive outcome,
// and only an EXPLICITLY-recorded artifact kind may suppress a top-level entry.
//
// KEYED ON PROVEN CANONICAL IDENTITY (FG-693). The row's key is provenPhysical()
// of the workspace path — the realpath, resolved BEFORE the write transaction
// opens so no filesystem syscall is held across the machine-wide write lock (the
// invariant db.ts and runs.ts both state). A spelling the filesystem will not
// confirm cannot be keyed durably, so it is not written (creation/retention are
// best-effort) and reads back `unclassified` — the visible fail-safe.

import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, writeTransaction } from "./db.js";
import { provenPhysical } from "../util/path-identity.js";
import { nowIso } from "../util/ids.js";
import type { CleanupReason } from "../v2/run-cleanup-report.js";

/** THE CLOSED WORKSPACE-KIND VOCABULARY.
 *
 *   operator          — a genuine operator project. Stays a top-level Projects entry.
 *   disposable_clone  — a Forge-created private task clone (worktree-lifecycle's
 *                       createTaskClone). Suppressed as a top-level entry; reachable
 *                       from its owning run.
 *   worktree          — a Forge-created per-task linked worktree (createWorktree).
 *                       Suppressed likewise.
 *   evidence_fixture  — a deliberately-retained evidence/dogfood workspace (the
 *                       fg584-dogfood shape). Retained on disk, auditable, suppressed.
 *   unclassified      — the workspace's purpose was never recorded. The VISIBLE
 *                       fail-safe: kept as a top-level entry and flagged so an
 *                       operator can classify it, NEVER hidden.
 *
 * Enum-as-convention (FG-585): the column is free TEXT with no DB CHECK, so an
 * old/new binary never fights a constraint the other lacks. */
const WORKSPACE_KINDS = {
  operator: true,
  disposable_clone: true,
  worktree: true,
  evidence_fixture: true,
  unclassified: true,
} as const;

export type WorkspaceKind = keyof typeof WORKSPACE_KINDS;

export const WORKSPACE_KIND_VALUES = Object.keys(WORKSPACE_KINDS) as ReadonlyArray<WorkspaceKind>;

/** The purpose an unrecorded / unreadable workspace has. NOT a claim that it is an
 *  artifact — a claim that nothing declared what it is, which is exactly what
 *  `unclassified` says, and which stays VISIBLE. */
export const DEFAULT_WORKSPACE_KIND: WorkspaceKind = "unclassified";

/** The kinds that EXPLICITLY suppress a top-level Projects entry. Only a recorded
 *  artifact kind is here — `unclassified` is deliberately absent (visible fail-safe)
 *  and `operator` is a project. */
export const ARTIFACT_WORKSPACE_KINDS: ReadonlyArray<WorkspaceKind> = [
  "disposable_clone",
  "worktree",
  "evidence_fixture",
];

/** How the record was established. Free TEXT (enum-as-convention). */
export type WorkspacePurposeSource = "creation" | "retention" | "operator";

/** Column value -> kind. UNKNOWN FAILS OPEN, in the only direction that is safe
 *  here: a NULL (the row's column arrived by a table this store did not have), an
 *  empty string, or a value a newer binary wrote all decode to `unclassified`. They
 *  NEVER decode to an artifact kind — a purpose this binary cannot read is not
 *  evidence for suppressing a top-level project. */
export function decodeWorkspaceKind(raw: string | null | undefined): WorkspaceKind {
  return typeof raw === "string" && Object.hasOwn(WORKSPACE_KINDS, raw)
    ? (raw as WorkspaceKind)
    : DEFAULT_WORKSPACE_KIND;
}

/** Is this a kind the CALLER may declare? Used by the submission surfaces
 *  (`forge projects classify`, the dashboard classify route) to refuse an unknown
 *  value at submission rather than writing a row that would silently decode to
 *  `unclassified` later. */
export function isWorkspaceKind(raw: string): raw is WorkspaceKind {
  return Object.hasOwn(WORKSPACE_KINDS, raw);
}

/** The three-valued presentation classification derived from a kind. `operator`
 *  and `unclassified` stay visible; `artifact` is suppressed as a peer project. */
export type WorkspaceClassification = "operator" | "artifact" | "unclassified";

export function classificationForKind(kind: WorkspaceKind): WorkspaceClassification {
  if (kind === "operator") return "operator";
  if (kind === "unclassified") return "unclassified";
  return "artifact";
}

/** The owner a Forge artifact declares at creation (or an operator supplies at
 *  repair): the durable project it belongs to (FG-663 project_identity) plus the
 *  run/task that created it. Every field optional — a legacy classify may know the
 *  purpose without knowing the run. */
export type WorkspaceOwner = {
  projectIdentity?: string | null;
  runId?: string | null;
  taskId?: string | null;
};

export type WorkspacePurpose = {
  /** The PROVEN canonical path (realpath) this row is keyed on. */
  path: string;
  /** The caller's spelling, verbatim — display/audit only, decides nothing. */
  pathAsWritten: string;
  kind: WorkspaceKind;
  projectIdentity: string | null;
  runId: string | null;
  taskId: string | null;
  /** FG-677 retention outcome carried onto the row, when reconcile retained the
   *  workspace (active_process_cwd, active_mount, ownership_ambiguous, …). */
  reason: CleanupReason | null;
  source: WorkspacePurposeSource;
  createdAt: string;
  updatedAt: string;
};

type WorkspacePurposeRow = {
  path: string;
  path_as_written: string;
  kind: string;
  project_identity: string | null;
  run_id: string | null;
  task_id: string | null;
  reason: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

function rowToPurpose(row: WorkspacePurposeRow): WorkspacePurpose {
  return {
    path: row.path,
    pathAsWritten: row.path_as_written,
    kind: decodeWorkspaceKind(row.kind),
    projectIdentity: row.project_identity,
    runId: row.run_id,
    taskId: row.task_id,
    reason: (row.reason as CleanupReason | null) ?? null,
    source: (row.source as WorkspacePurposeSource) ?? "operator",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** THE SHAPE-PROBE. A read-only handle on a store no writer has migrated since the
 *  upgrade may lack the table entirely; a bare SELECT would throw `no such table`
 *  and take the whole Projects surface down for data that is simply older. PRAGMA
 *  table_info on a missing table returns ZERO rows rather than throwing (db.ts's
 *  rule), so absence degrades to "every workspace reads unclassified/visible". */
export function hasWorkspacePurposeTable(db: DatabaseInstance): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(workspace_purposes)`).all() as Array<{ name: string }>;
    return cols.length > 0;
  } catch {
    return false;
  }
}

function readRow(canonical: string): WorkspacePurposeRow | undefined {
  const db = getDb();
  if (!hasWorkspacePurposeTable(db)) return undefined;
  return db
    .prepare(
      `SELECT path, path_as_written, kind, project_identity, run_id, task_id, reason, source, created_at, updated_at
         FROM workspace_purposes WHERE path = ?`,
    )
    .get(canonical) as WorkspacePurposeRow | undefined;
}

/** Look up the recorded purpose for a workspace path. Resolves the PROVEN canonical
 *  identity first, then reads the row keyed on it. Returns undefined when nothing
 *  was recorded, when the path does not resolve, or when the store predates the
 *  table — every one of which a caller treats as `unclassified` (visible). Never
 *  throws: a store/read failure degrades to undefined, never to a hidden project. */
export function getWorkspacePurpose(path: string): WorkspacePurpose | undefined {
  try {
    const canonical = provenPhysical(path);
    if (canonical === null) return undefined;
    const row = readRow(canonical);
    return row ? rowToPurpose(row) : undefined;
  } catch {
    return undefined;
  }
}

/** Bulk lookup for the projection join: canonical path -> purpose, for the paths
 *  that have a recorded row. Shape-probe guarded, single query. Callers resolve
 *  provenPhysical for their checkout roots and index into this map; a miss reads as
 *  `unclassified`. */
export function workspacePurposesByCanonical(canonicalPaths: string[]): Map<string, WorkspacePurpose> {
  const out = new Map<string, WorkspacePurpose>();
  if (canonicalPaths.length === 0) return out;
  try {
    const db = getDb();
    if (!hasWorkspacePurposeTable(db)) return out;
    const placeholders = canonicalPaths.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT path, path_as_written, kind, project_identity, run_id, task_id, reason, source, created_at, updated_at
           FROM workspace_purposes WHERE path IN (${placeholders})`,
      )
      .all(...canonicalPaths) as WorkspacePurposeRow[];
    for (const row of rows) out.set(row.path, rowToPurpose(row));
  } catch {
    /* a read failure degrades to an empty map: everything reads unclassified/visible */
  }
  return out;
}

type UpsertFields = {
  canonical: string;
  pathAsWritten: string;
  kind: WorkspaceKind;
  owner: WorkspaceOwner | undefined;
  reason: CleanupReason | null;
  source: WorkspacePurposeSource;
};

/** The single INSERT — used by every writer, always inside a writeTransaction so
 *  the read + write are one atomic unit. */
function insertRow(fields: UpsertFields, now: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_purposes
         (path, path_as_written, kind, project_identity, run_id, task_id, reason, source, created_at, updated_at)
       VALUES (@path, @path_as_written, @kind, @project_identity, @run_id, @task_id, @reason, @source, @created_at, @updated_at)`,
    )
    .run({
      path: fields.canonical,
      path_as_written: fields.pathAsWritten,
      kind: fields.kind,
      project_identity: fields.owner?.projectIdentity ?? null,
      run_id: fields.owner?.runId ?? null,
      task_id: fields.owner?.taskId ?? null,
      reason: fields.reason,
      source: fields.source,
      created_at: now,
      updated_at: now,
    });
}

export type RecordWorkspacePurposeInput = {
  /** The workspace path, as the caller spells it. Resolved to its PROVEN canonical
   *  identity before the write; an unresolvable path is a no-op (best-effort). */
  path: string;
  kind: WorkspaceKind;
  owner?: WorkspaceOwner | undefined;
  reason?: CleanupReason | undefined;
  source?: WorkspacePurposeSource | undefined;
};

/** Record a workspace's DECLARED purpose at CREATION. Best-effort: an unresolvable
 *  path or an unwritable store returns false rather than turning creation into a
 *  failure (the same contract recordLaunchObservation takes). Resolves provenPhysical
 *  BEFORE opening the write transaction — no filesystem syscall across the write lock.
 *
 *  Idempotent by construction: a fresh artifact path has no prior row, so the ON
 *  CONFLICT re-asserts the declared kind/owner rather than duplicating. */
export function recordWorkspacePurpose(input: RecordWorkspacePurposeInput): boolean {
  const canonical = provenPhysical(input.path);
  if (canonical === null) return false;
  const now = nowIso();
  return writeTransaction(() => {
    const existing = readRow(canonical);
    if (!existing) {
      insertRow(
        {
          canonical,
          pathAsWritten: input.path,
          kind: input.kind,
          owner: input.owner,
          reason: input.reason ?? null,
          source: input.source ?? "creation",
        },
        now,
      );
      return true;
    }
    // Re-assert a creation declaration: the kind and owner declared at creation win,
    // but a previously-recorded retention reason is preserved unless a new one is given.
    getDb()
      .prepare(
        `UPDATE workspace_purposes
            SET kind = ?, project_identity = COALESCE(?, project_identity),
                run_id = COALESCE(?, run_id), task_id = COALESCE(?, task_id),
                reason = COALESCE(?, reason), source = ?, updated_at = ?
          WHERE path = ?`,
      )
      .run(
        input.kind,
        input.owner?.projectIdentity ?? null,
        input.owner?.runId ?? null,
        input.owner?.taskId ?? null,
        input.reason ?? null,
        input.source ?? "creation",
        now,
        canonical,
      );
    return true;
  });
}

/** FG-677 (AC6): carry a RETENTION outcome onto the row for a retained workspace,
 *  so "unique work / active process / ownership ambiguity" is representable WITHOUT
 *  promoting the workspace to a project. Never changes the removed-vs-retained
 *  decision (reconcile owns that) and never clobbers a recorded kind — a workspace
 *  recorded at creation keeps its artifact kind; a workspace nothing recorded gets a
 *  fresh `unclassified` row carrying only the reason. Best-effort. */
export function attachRetentionReason(input: {
  path: string;
  reason: CleanupReason;
  owner?: WorkspaceOwner | undefined;
}): boolean {
  const canonical = provenPhysical(input.path);
  if (canonical === null) return false;
  const now = nowIso();
  return writeTransaction(() => {
    const existing = readRow(canonical);
    if (!existing) {
      insertRow(
        {
          canonical,
          pathAsWritten: input.path,
          kind: "unclassified",
          owner: input.owner,
          reason: input.reason,
          source: "retention",
        },
        now,
      );
      return true;
    }
    getDb()
      .prepare(
        `UPDATE workspace_purposes
            SET reason = ?, project_identity = COALESCE(project_identity, ?),
                run_id = COALESCE(run_id, ?), task_id = COALESCE(task_id, ?), updated_at = ?
          WHERE path = ?`,
      )
      .run(
        input.reason,
        input.owner?.projectIdentity ?? null,
        input.owner?.runId ?? null,
        input.owner?.taskId ?? null,
        now,
        canonical,
      );
    return true;
  });
}

/** A REFUSE outcome from the operator classify/repair claim: the directory already
 *  carries a DIFFERENT recorded artifact/operator kind, and reassigning it would
 *  silently overwrite a durable fact. Surfaced, never swallowed — the operator
 *  resolves which purpose the workspace actually has. */
export class WorkspacePurposeConflictError extends Error {
  constructor(
    message: string,
    readonly detail: { path: string; existingKind: WorkspaceKind; requestedKind: WorkspaceKind },
  ) {
    super(message);
    this.name = "WorkspacePurposeConflictError";
  }
}

export type ClassifyWorkspaceResult = {
  path: string;
  kind: WorkspaceKind;
  previousKind?: WorkspaceKind;
};

/** THE BOUNDED OPERATOR CLASSIFY/REPAIR CLAIM (AC3, AC8). Atomic and
 *  REFUSE-on-conflict, mirroring project-registry.ts's authority ladder:
 *
 *    - the path MUST resolve to a real directory (never classify a phantom);
 *    - an ABSENT row, or one recorded `unclassified`, is CLAIMED for the requested
 *      kind — this is the legacy-repair door;
 *    - a row already recorded with a DIFFERENT non-unclassified kind is REFUSED
 *      (WorkspacePurposeConflictError), never silently overwritten;
 *    - re-classifying to the SAME kind is idempotent, not a conflict.
 *
 *  It records only the PURPOSE row. It never deletes the workspace and never
 *  rewrites a historical run — the ticket's non-negotiables. */
export function classifyWorkspacePurpose(input: {
  path: string;
  kind: WorkspaceKind;
  owner?: WorkspaceOwner | undefined;
}): ClassifyWorkspaceResult {
  const canonical = provenPhysical(input.path);
  if (canonical === null) {
    throw new Error(
      `forge: refusing to classify — ${input.path} does not resolve to a real directory on this host. ` +
        `A workspace purpose is keyed on a proven filesystem identity; classify a directory that exists.`,
    );
  }
  const now = nowIso();
  return writeTransaction(() => {
    const existing = readRow(canonical);
    if (existing) {
      const recordedRaw = existing.kind;
      const existingKind = decodeWorkspaceKind(recordedRaw);
      // RF-2: a kind this binary cannot READ — a value a NEWER binary wrote — decodes to
      // `unclassified`, but it is NOT the claimable legacy-repair door. Overwriting it
      // would silently replace a durable fact no operator resolved, letting an older
      // binary stamp an artifact kind over a newer recorded purpose. Distinguish it from a
      // genuinely-unrecorded row (the literal "unclassified", or a NULL/empty kind) so the
      // repair door stays open ONLY where nothing meaningful is recorded, and REFUSE on a
      // recorded-but-unreadable kind exactly as on a recorded conflicting kind.
      const recordedButUnreadable =
        typeof recordedRaw === "string" && recordedRaw.trim().length > 0 && !isWorkspaceKind(recordedRaw);
      const conflictsWithRecordedKind = existingKind !== "unclassified" && existingKind !== input.kind;
      if (recordedButUnreadable || conflictsWithRecordedKind) {
        const shownExisting = recordedButUnreadable ? recordedRaw : existingKind;
        throw new WorkspacePurposeConflictError(
          `forge: refusing to classify — ${canonical} is already recorded as '${shownExisting}', not ` +
            `'${input.kind}'. Reassigning it would silently overwrite a durable fact. If the recorded ` +
            `purpose is wrong, resolve which purpose this workspace actually has first.`,
          { path: canonical, existingKind, requestedKind: input.kind },
        );
      }
      getDb()
        .prepare(
          `UPDATE workspace_purposes
              SET kind = ?, project_identity = COALESCE(?, project_identity),
                  run_id = COALESCE(?, run_id), task_id = COALESCE(?, task_id),
                  source = 'operator', updated_at = ?
            WHERE path = ?`,
        )
        .run(
          input.kind,
          input.owner?.projectIdentity ?? null,
          input.owner?.runId ?? null,
          input.owner?.taskId ?? null,
          now,
          canonical,
        );
      return { path: canonical, kind: input.kind, previousKind: existingKind };
    }
    insertRow(
      {
        canonical,
        pathAsWritten: input.path,
        kind: input.kind,
        owner: input.owner,
        reason: null,
        source: "operator",
      },
      now,
    );
    return { path: canonical, kind: input.kind };
  });
}
