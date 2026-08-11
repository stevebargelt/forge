// FG-679 (BD-12): the durable launch-observation store — what forge OBSERVED
// about a `forge launch`, and WHEN.
//
// WHY IT EXISTS. Before this, a launch's status was DERIVED at read time from a
// live tmux probe (`readLaunch` fans `tmux has-session`/`list-panes` per record;
// `listLaunches` fans it over every record). BD-7/BD-12 forbid any serving or
// polling path from doing that, so "is host verification running right now?" was
// unanswerable from durable state — the exact question FG-679 exists for.
//
// WHAT A ROW IS, AND WHAT IT IS NOT. A row is EVIDENCE OF WHAT WAS OBSERVED AND
// WHEN. It is never a claim about the present. `observed_at` is the whole point:
// a reader past its freshness cutoff must render `unobserved since <t>` — never
// `running`, never terminal. The absence of a fresh observation is a fact about
// the OBSERVER, not about the work.
//
// STRUCTURED, NEVER PRE-RENDERED. `state`/`exit_code`/`signal` carry the canonical
// LaunchStatus shape. src/v2/launch.ts's `statusLine` remains the ONE human
// rendering (BD-4), so `terminated by SIGTERM (signal sender not recorded …)`, a
// bare signal-range `exited 143 (…)`, `owner gone …` and `unknown (…)` stay FOUR
// DIFFERENT FACTS on every surface instead of collapsing into a generic `failed`.
//
// PLACEMENT AUTHORITY LIVES IN THE DATA (BD-2/BD-3/BD-14/BD-15). `association_kind`
// records WHICH CHANNEL DECIDED the project home, decided once at submission:
//   'explicit' — the structured metadata the submitter supplied resolved it.
//   'cwd'      — the cwd resolved to a registered project home. Also what an
//                explicitly associated launch reads when its declared run resolved
//                no project and the cwd supplied one (FG-684 AC4): the label names
//                the channel that ACTUALLY decided, never the strongest one present.
//   'none'     — no registered project home. Host-level "Unassociated activity".
// RUN-level placement and the `unassociated` label follow the DECLARED submission
// ids (`hasPlacementAuthority`), not this label — a launch that named its run is
// associated with it whichever channel resolved its project home.
// Nothing here ever consults a launch NAME, ARGV, or LOG TEXT. FG-492 records that
// long-lived agent processes carry conversation text in argv and falsely match
// unrelated run/ticket names; `extractForgeIds` is quarantined for exactly that
// reason and authorizes nothing.
//
// THE WRITE RULE: every mutation takes its write lock immediately via
// writeTransaction (BEGIN IMMEDIATE), never a deferred txn that upgrades mid-flight.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, writeTransaction } from "./db.js";
import { provenPhysical } from "../util/path-identity.js";
import { LAUNCHES_DIR, classifyExit, isLaunchId, parseExitRecord, type LaunchMeta, type LaunchStatus } from "../v2/launch.js";

/** How a launch's placement was AUTHORIZED. Enum-as-convention (FG-585): TEXT with
 *  no DB CHECK, so an old/new binary never fights a constraint the other lacks. */
export type LaunchAssociationKind = "explicit" | "cwd" | "none";

/** WHAT A LAUNCH IS (FG-700) — declared by the SUBMITTER at submission time and
 *  persisted with the observation. Never derived, at any point, from the launch name,
 *  the argv, the command text, a task prompt or the log: those are the surfaces FG-492
 *  quarantined for false-matching unrelated role and ticket names.
 *
 *  It is a DIFFERENT QUESTION from the association ids, and the two must stay
 *  separate. Association answers WHERE a launch belongs; purpose answers WHAT it is.
 *  Before FG-700 there was no purpose field at all, so the readers used the presence
 *  of run_id/task_id/ticket_id as a stand-in for it and every associated engineer,
 *  test-engineer, documentation-maintainer, review and campaign launch rendered under
 *  the label `Host verification` — false waits, for work the agent-task surface was
 *  already showing.
 *
 *  The vocabulary is the set of launch kinds this codebase actually submits:
 *    host_verification — a host verification run (the tests/typecheck/build an operator
 *                        or an orchestrator runs on the host for a run or ticket). The
 *                        ONLY value that may render as a host-verification wait.
 *    agent_invoke      — a launch that starts agent work: `forge invoke`, `forge new`,
 *                        `forge next`, and the queue dispatcher's own ticket launch.
 *                        Already represented once by the agent-task projection.
 *    review            — `forge review start/continue`, `forge review-loop`.
 *    campaign          — the campaign drive-item launcher and campaign controllers.
 *    dashboard         — the long-lived dashboard server.
 *    generic           — anything else, AND the fail-closed answer for a launch that
 *                        declared nothing (a legacy row, or a value this binary does
 *                        not know). */
const LAUNCH_PURPOSES = {
  host_verification: true,
  agent_invoke: true,
  review: true,
  campaign: true,
  dashboard: true,
  generic: true,
} as const;

export type LaunchPurpose = keyof typeof LAUNCH_PURPOSES;

export const LAUNCH_PURPOSE_VALUES = Object.keys(LAUNCH_PURPOSES) as ReadonlyArray<LaunchPurpose>;

/** The one purpose that may render as a host-verification wait, named once so no
 *  reader spells it itself. */
export const HOST_VERIFICATION_PURPOSE: LaunchPurpose = "host_verification";

/** The purpose an undeclared launch has. NOT a claim that the launch is unimportant —
 *  a claim that nothing declared what it is, which is exactly what `generic` says. */
export const DEFAULT_LAUNCH_PURPOSE: LaunchPurpose = "generic";

/** Column value -> purpose. UNKNOWN FAILS CLOSED, in the only direction that is safe:
 *  a NULL (the column arrived by ALTER, so every pre-FG-700 row has one), an empty
 *  string, or a value a newer binary wrote all decode to `generic`. They never decode
 *  to `host_verification` — a purpose this binary cannot read is not evidence for the
 *  most specific claim the surface can make. */
export function decodeLaunchPurpose(raw: string | null | undefined): LaunchPurpose {
  return typeof raw === "string" && Object.hasOwn(LAUNCH_PURPOSES, raw) ? (raw as LaunchPurpose) : DEFAULT_LAUNCH_PURPOSE;
}

/** Is this a purpose the CALLER may declare? Used by the submission surface
 *  (`forge launch run --purpose`) to refuse an unknown value at submission rather than
 *  writing a row that would silently decode to `generic` later. */
export function isLaunchPurpose(raw: string): raw is LaunchPurpose {
  return Object.hasOwn(LAUNCH_PURPOSES, raw);
}

/** Submission-time structured association. The ONLY thing that authorizes
 *  run-level placement (BD-2). Every field is what the SUBMITTER declared — never
 *  something forge inferred from a name, argv, or log text. */
export type LaunchAssociation = {
  runId?: string | undefined;
  taskId?: string | undefined;
  ticketId?: string | undefined;
  campaignId?: string | undefined;
  itemId?: string | undefined;
};

export type LaunchObservation = {
  launchId: string;
  name: string | null;
  command: string[];
  cwd: string;
  projectDir: string | null;
  associationKind: LaunchAssociationKind;
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  /** FG-700: what the submitter DECLARED this launch is. `generic` for every row that
   *  declared nothing — the column's absence is not evidence of a specific kind. */
  purpose: LaunchPurpose;
  startedAt: string;
  observedAt: string;
  status: LaunchStatus;
  terminal: boolean;
  /** FG-693: the PROVEN filesystem identity of `projectDir` at write time, or null —
   *  either because the store predates the column, or because the filesystem would not
   *  confirm the path. `projectDir` keeps the submitter's bytes verbatim. */
  projectDirCanonical: string | null;
};

/** The raw row shape, exported so the shared derivation can decode rows it read
 *  through its OWN database handle (the dashboard opens a separate read-only one)
 *  without a second copy of the codec. */
export type LaunchObservationRow = {
  launch_id: string;
  name: string | null;
  command: string;
  cwd: string;
  project_dir: string | null;
  association_kind: string;
  run_id: string | null;
  task_id: string | null;
  ticket_id: string | null;
  campaign_id: string | null;
  item_id: string | null;
  started_at: string;
  observed_at: string;
  state: string;
  exit_code: number | null;
  signal: string | null;
  /** Absent (not merely null) when the store predates the column — see
   *  `launchObservationColumns`. Both absences decode the same way: `generic`. */
  purpose?: string | null;
  /** Absent (not merely null) when the store predates FG-693's column — the same
   *  shape-probe rule `purpose` takes. Both absences decode to null: no identity was
   *  proven for this row, which is exactly what null means here. */
  project_dir_canonical?: string | null;
  terminal: number;
};

/** The canonical LaunchStatus.state vocabulary as a validation whitelist. Typed
 *  as Record<LaunchStatus["state"], true> so a state ADDED upstream forces this to
 *  be updated (compile error) rather than silently decoding to `unknown`. */
const LAUNCH_STATES: Record<LaunchStatus["state"], true> = {
  running: true,
  exited_ok: true,
  exited_error: true,
  signaled: true,
  terminated_unattributed: true,
  owner_gone: true,
  unknown: true,
};

export const LAUNCH_OBSERVATION_STATES = Object.keys(LAUNCH_STATES) as ReadonlyArray<LaunchStatus["state"]>;

/** A launch is terminal in every state except `running` — the same rule
 *  src/v2/launch.ts's isTerminalStatus applies. Restated here rather than imported
 *  so this store module stays off the import cycle with launch.ts; the two are
 *  pinned to agree by fg679-launch-observations.test.ts, which asserts the verdict
 *  matches isTerminalStatus for EVERY state in the vocabulary. */
export function isTerminalObservationState(state: LaunchStatus["state"]): boolean {
  return state !== "running";
}

/** Structured status -> the three columns that carry it. Never a rendered string:
 *  the four BD-4 facts must survive the round trip as four facts. */
export function encodeLaunchStatus(status: LaunchStatus): { state: string; exitCode: number | null; signal: string | null } {
  switch (status.state) {
    case "running": return { state: "running", exitCode: null, signal: null };
    case "exited_ok": return { state: "exited_ok", exitCode: 0, signal: null };
    case "exited_error": return { state: "exited_error", exitCode: status.code, signal: null };
    case "signaled": return { state: "signaled", exitCode: null, signal: status.signal };
    case "terminated_unattributed": return { state: "terminated_unattributed", exitCode: status.code, signal: null };
    case "owner_gone": return { state: "owner_gone", exitCode: null, signal: null };
    case "unknown": return { state: "unknown", exitCode: null, signal: null };
  }
}

/** The three columns -> structured status. A row whose `state` is outside the
 *  canonical vocabulary (a newer binary wrote it, or the bytes are damaged) decodes
 *  to `unknown` — the honest "no evidence" disposition — never to a fabricated
 *  `running` and never to a specific terminal claim the bytes did not make. */
export function decodeLaunchStatus(state: string, exitCode: number | null, signal: string | null): LaunchStatus {
  switch (state) {
    case "running": return { state: "running" };
    case "exited_ok": return { state: "exited_ok", code: 0 };
    case "exited_error": return { state: "exited_error", code: exitCode ?? 1 };
    case "signaled": return signal ? { state: "signaled", signal, sender: "unrecorded" } : { state: "unknown" };
    case "terminated_unattributed": return exitCode === null ? { state: "unknown" } : { state: "terminated_unattributed", code: exitCode };
    case "owner_gone": return { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" };
    default: return { state: "unknown" };
  }
}

function decodeAssociationKind(raw: string): LaunchAssociationKind {
  // Unknown authority is the WEAKEST authority, never the strongest: a value this
  // binary does not understand must not be promoted to run-level placement.
  return raw === "explicit" || raw === "cwd" ? raw : "none";
}

function decodeCommand(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) return parsed as string[];
  } catch {
    /* fall through — a malformed argv record is reported as empty, never guessed */
  }
  return [];
}

export function rowToLaunchObservation(row: LaunchObservationRow): LaunchObservation {
  const status = decodeLaunchStatus(row.state, row.exit_code, row.signal);
  return {
    launchId: row.launch_id,
    name: row.name,
    command: decodeCommand(row.command),
    cwd: row.cwd,
    projectDir: row.project_dir,
    projectDirCanonical: row.project_dir_canonical ?? null,
    associationKind: decodeAssociationKind(row.association_kind),
    runId: row.run_id,
    taskId: row.task_id,
    ticketId: row.ticket_id,
    campaignId: row.campaign_id,
    itemId: row.item_id,
    purpose: decodeLaunchPurpose(row.purpose),
    startedAt: row.started_at,
    observedAt: row.observed_at,
    status,
    // Derived from the canonical state, never trusted from the column: a row whose
    // `terminal` byte disagrees with its own state must not create an eighth fact.
    terminal: isTerminalObservationState(status.state),
  };
}

const LAUNCH_OBSERVATION_COLUMN_LIST = [
  "launch_id", "name", "command", "cwd", "project_dir", "association_kind",
  "run_id", "task_id", "ticket_id", "campaign_id", "item_id",
  "started_at", "observed_at", "state", "exit_code", "signal", "purpose",
  "project_dir_canonical", "terminal",
] as const;

export const LAUNCH_OBSERVATION_COLUMNS = LAUNCH_OBSERVATION_COLUMN_LIST.join(", ");

/** The select list for THE STORE IN FRONT OF THIS READER, which is not always the
 *  store this binary would create.
 *
 *  `purpose` arrived by ALTER (FG-700), and the ordinary open path adds it — but the
 *  dashboard opens its OWN READ-ONLY handle and deliberately runs neither SCHEMA_SQL
 *  nor applyMigrations (src/store/db.ts), so it can be pointed at a store no writer has
 *  touched since the upgrade. Selecting a column that store does not have would throw
 *  `no such column: purpose` and take the whole Current-activity surface down — a read
 *  failure presented as an error page, for data that is simply older.
 *
 *  PRAGMA table_info on a MISSING table returns zero rows rather than throwing (db.ts's
 *  shape-probe rule), so a table this store does not have at all falls back to the full
 *  list and fails exactly the way it does today (`no such table`), rather than silently
 *  becoming a query with no columns. A row that comes back without `purpose` decodes to
 *  `generic` — the same fail-closed answer a NULL gives. */
export function launchObservationColumns(db: DatabaseInstance): string {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(launch_observations)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (present.size === 0) return LAUNCH_OBSERVATION_COLUMNS;
  const usable = LAUNCH_OBSERVATION_COLUMN_LIST.filter((c) => present.has(c));
  return usable.length === 0 ? LAUNCH_OBSERVATION_COLUMNS : usable.join(", ");
}

export type RecordLaunchObservationInput = {
  launchId: string;
  name?: string | null;
  command: string[];
  cwd: string;
  projectDir?: string | null;
  /** The project home the ASSOCIATION resolved, when the caller resolved the two
   *  channels separately — see associationKindFor. */
  associationProjectDir?: string | null;
  association?: LaunchAssociation | undefined;
  /** FG-700: what this launch IS, as the submitter declares it. Omitting it records
   *  `generic` — a caller that does not say is never assumed to be running host
   *  verification. */
  purpose?: LaunchPurpose | undefined;
  startedAt: string;
  observedAt: string;
  status: LaunchStatus;
};

/** The fields whose presence AUTHORIZES placement — the submission vocabulary
 *  invariant 22 publishes (`--run`, `--task`, `--ticket`). `campaignId`/`itemId` are
 *  deliberately NOT here: they are PROVENANCE. A campaign drive-item launch knows its
 *  campaign and its item and has no run at all (the child dispatches its own), so
 *  treating that identity as placement authority rendered a run-less launch as
 *  ASSOCIATED — the exact opposite of what the campaign launcher documents. It is
 *  still recorded in full; it just does not decide where the launch is placed. */
const PLACEMENT_AUTHORIZING_FIELDS = ["runId", "taskId", "ticketId"] as const;

/** Whether the SUBMITTER declared placement-authorizing metadata. Takes the
 *  association or a recorded observation alike, so the two readers of this fact (the
 *  shared derivation and the dashboard's launch detail) ask the ONE question rather
 *  than each re-deriving it from `association_kind` — which since FG-684 answers a
 *  DIFFERENT question (which channel decided the project placement). */
export function hasPlacementAuthority(
  declared: { runId?: string | null; taskId?: string | null; ticketId?: string | null } | undefined,
): boolean {
  if (declared === undefined) return false;
  return PLACEMENT_AUTHORIZING_FIELDS.some((f) => typeof declared[f] === "string" && declared[f] !== "");
}

/** Decide the placement AUTHORITY from what is actually known — the channel that
 *  ACTUALLY DECIDED the recorded project home (FG-684 AC4), not merely the strongest
 *  channel present. Explicit metadata wins when it resolved the project; a project
 *  home resolved from the cwd is the weaker `cwd` channel; nothing else places
 *  anywhere but the host-level bucket.
 *
 *  `associationProjectDir` is what the declared association itself resolved. It
 *  defaults to `projectDir` — a caller that resolved the placement through one
 *  channel and does not distinguish them is taken at its word. `recordLaunchStart`
 *  DOES distinguish them: an explicit association naming a run the store does not
 *  know resolves nothing, cwd supplies the project, and the row must say `cwd`
 *  rather than claim the declaration put it there. The declared ids stay on the row
 *  either way — demoting the label demotes provenance nowhere. */
export function associationKindFor(
  association: LaunchAssociation | undefined,
  projectDir: string | null,
  associationProjectDir: string | null = projectDir,
): LaunchAssociationKind {
  // With NO project home at all, nothing placed this launch anywhere; a declared
  // association is still the only channel that spoke, so the label stays `explicit`
  // and the host-level bucket keeps its own rule (project_dir is null).
  if (hasPlacementAuthority(association)) return associationProjectDir !== null || projectDir === null ? "explicit" : "cwd";
  return projectDir === null ? "none" : "cwd";
}

/** Write (or replace) the single row for a launch. Callers treat this as
 *  BEST-EFFORT: an unwritable store must never become a launch refusal. */
export function recordLaunchObservation(input: RecordLaunchObservationInput): void {
  const projectDir = input.projectDir ?? null;
  const kind = associationKindFor(input.association, projectDir, input.associationProjectDir);
  const { state, exitCode, signal } = encodeLaunchStatus(input.status);
  const terminal = isTerminalObservationState(input.status.state) ? 1 : 0;
  // FG-693: the submitter's bytes go in project_dir VERBATIM and the PROVEN identity
  // beside them, or NULL where the filesystem would not confirm the path. Resolved
  // BEFORE the transaction opens — no filesystem syscall may be held across the
  // machine-wide write lock (the invariant db.ts and runs.ts both state).
  //
  // Without this writer every new observation joined the pre-FG-693 NULL-canonical
  // population, and the read-time legacy scan whose cost is justified by that
  // population being self-extinguishing would have grown with every launch instead.
  const projectDirCanonical = projectDir === null ? null : provenPhysical(projectDir);
  writeTransaction(() => {
    getDb().prepare(`
      INSERT INTO launch_observations (${LAUNCH_OBSERVATION_COLUMNS})
      VALUES (@launch_id, @name, @command, @cwd, @project_dir, @association_kind, @run_id, @task_id, @ticket_id, @campaign_id, @item_id, @started_at, @observed_at, @state, @exit_code, @signal, @purpose, @project_dir_canonical, @terminal)
      ON CONFLICT(launch_id) DO UPDATE SET
        name = excluded.name,
        command = excluded.command,
        cwd = excluded.cwd,
        project_dir = excluded.project_dir,
        project_dir_canonical = excluded.project_dir_canonical,
        association_kind = excluded.association_kind,
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        ticket_id = excluded.ticket_id,
        campaign_id = excluded.campaign_id,
        item_id = excluded.item_id,
        started_at = excluded.started_at,
        observed_at = excluded.observed_at,
        state = excluded.state,
        exit_code = excluded.exit_code,
        signal = excluded.signal,
        purpose = excluded.purpose,
        terminal = excluded.terminal
    `).run({
      launch_id: input.launchId,
      name: input.name ?? null,
      command: JSON.stringify(input.command),
      cwd: input.cwd,
      project_dir: projectDir,
      project_dir_canonical: projectDirCanonical,
      association_kind: kind,
      run_id: input.association?.runId ?? null,
      task_id: input.association?.taskId ?? null,
      ticket_id: input.association?.ticketId ?? null,
      campaign_id: input.association?.campaignId ?? null,
      item_id: input.association?.itemId ?? null,
      started_at: input.startedAt,
      observed_at: input.observedAt,
      state,
      exit_code: exitCode,
      signal,
      purpose: input.purpose ?? DEFAULT_LAUNCH_PURPOSE,
      terminal,
    });
  });
}

/** Promote an OBSERVED status onto an existing row. Only ever called with a
 *  disposition read out of durable evidence (the on-disk exit record) — this
 *  function fabricates nothing, and it does not create a row for a launch that was
 *  never recorded. */
export function updateLaunchObservationStatus(launchId: string, status: LaunchStatus, observedAt: string): boolean {
  const { state, exitCode, signal } = encodeLaunchStatus(status);
  return writeTransaction(() => {
    const res = getDb().prepare(`
      UPDATE launch_observations
         SET state = ?, exit_code = ?, signal = ?, terminal = ?, observed_at = ?
       WHERE launch_id = ?
    `).run(state, exitCode, signal, isTerminalObservationState(status.state) ? 1 : 0, observedAt, launchId);
    return res.changes === 1;
  });
}

export function getLaunchObservation(launchId: string): LaunchObservation | undefined {
  const db = getDb();
  const row = db
    .prepare(`SELECT ${launchObservationColumns(db)} FROM launch_observations WHERE launch_id = ?`)
    .get(launchId) as LaunchObservationRow | undefined;
  return row ? rowToLaunchObservation(row) : undefined;
}

/** Rows that have NOT reached a terminal disposition — the bounded candidate set
 *  the opportunistic promoter sweeps. Bounded and newest-first so a host with a
 *  long history of abandoned records never turns a `forge next` into a scan. */
export function listOpenLaunchObservations(limit = 200): LaunchObservation[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT ${launchObservationColumns(db)} FROM launch_observations WHERE terminal = 0 ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as LaunchObservationRow[];
  return rows.map(rowToLaunchObservation);
}

export function listLaunchObservations(limit = 500): LaunchObservation[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT ${launchObservationColumns(db)} FROM launch_observations ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as LaunchObservationRow[];
  return rows.map(rowToLaunchObservation);
}

/** Resolve a launch cwd to a REGISTERED project home, or null.
 *
 *  Deliberately the store's OWN observed-project registry (`runs.project_dir`)
 *  rather than `listProjects()`: that scans the filesystem and shells `git` through
 *  repositoryCheckoutIdentity, and this runs on the launch-submission path where a
 *  multi-second probe would be a tax on every `forge launch run`. The longest
 *  matching prefix wins, so a checkout nested inside another resolves to itself.
 *
 *  A cwd under `~/.forge/worktrees` (a per-task worktree — the 2026-08-04 case this
 *  ticket was filed on) matches no registered home and returns null. For a launch
 *  submitted with NO association that is what puts it in the host-level "Unassociated
 *  activity" bucket rather than inventing an owner for it (BD-14); an EXPLICITLY
 *  associated launch takes its project from the run it declared instead — see
 *  projectDirForAssociation. */
export function resolveRegisteredProjectDir(cwd: string): string | null {
  const target = resolve(cwd);
  let best: string | null = null;
  const rows = getDb()
    .prepare(`SELECT DISTINCT project_dir FROM runs WHERE project_dir IS NOT NULL AND project_dir <> ''`)
    .all() as Array<{ project_dir: string }>;
  for (const row of rows) {
    const dir = resolve(row.project_dir);
    if (target !== dir && !target.startsWith(`${dir}/`)) continue;
    if (best === null || dir.length > best.length) best = dir;
  }
  return best;
}

/** The project home a DECLARED association belongs to, read out of the store's own
 *  run registry — never guessed.
 *
 *  Explicit submission metadata is the STRONGEST authority (BD-3), so it is consulted
 *  FIRST and cwd only when it yields nothing (FG-684). Ordering these the other way
 *  round made cwd win the CONFLICT, not just the gap: the orchestrator dispatches
 *  `forge launch run --run <id>` from the forge checkout while the run belongs to a
 *  disposable clone, so cwd resolved to forge and the launch was placed under an
 *  unrelated project. The gap case matters too — a per-task worktree is deliberately
 *  outside every registered project home, so an otherwise explicit `--run` launch
 *  resolved to project_dir null and then vanished from its project's Current activity.
 *  The declared run (or the run its declared task belongs to) says which project it
 *  is. A ticket id alone names no project; it stays null rather than being resolved
 *  by some looser channel. */
function projectDirForAssociation(association: LaunchAssociation | undefined): string | null {
  const runId = association?.runId;
  const taskId = association?.taskId;
  const row = runId
    ? getDb().prepare(`SELECT project_dir FROM runs WHERE id = ?`).get(runId) as { project_dir: string | null } | undefined
    : taskId
      ? getDb().prepare(`SELECT r.project_dir FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?`).get(taskId) as { project_dir: string | null } | undefined
      : undefined;
  const dir = row?.project_dir;
  return dir === undefined || dir === null || dir === "" ? null : dir;
}

// ── FG-679: the submission-time write, and the opportunistic terminal promoter ──
//
// BOTH LIVE HERE RATHER THAN IN src/v2/launch.ts, and that placement is
// load-bearing. FG-552 (F33) fast-paths `forge launch wait` ahead of the command
// registry so the observer still reports a terminal disposition when
// better-sqlite3 cannot load, and src/cli/commands/launch-wait.ts states the rule:
// "do not add an import that reaches the store". A store import inside launch.ts
// reddens that suite. The dependency therefore runs THIS way — the store imports
// the launch primitives — and the two submission sites (`forge launch run` and the
// campaign drive-item launcher) both already load the registry, so nothing is lost.

/** How long the START observation may wait on a BUSY store before giving up. The
 *  host's default is 5s, which is the right wait for WORK; it is the wrong wait for
 *  instrumentation that runs on the launch-RETURN path. The command is already
 *  running by the time this is called, so a concurrent writer (this host runs several
 *  forge processes against one store — FG-29) must not be able to hold up returning
 *  control to the submitter. Past this bound the write fails, is swallowed, and the
 *  launch is simply unobserved. */
const LAUNCH_OBSERVATION_BUSY_TIMEOUT_MS = 250;

/** Record the START of a launch that is ALREADY RUNNING.
 *
 *  BEST-EFFORT IN BOTH DIRECTIONS, AND THAT IS THE POINT. `startLaunch` is
 *  deliberately refuse-before-execute (toolchain, cwd and tmux all throw before
 *  anything is written) and this instrumentation MUST NOT join that sequence: the
 *  work is the thing, the record is only about the work. Callers invoke this AFTER
 *  the command is running, and a store that cannot be written leaves the launch
 *  running and merely UNOBSERVED — never refused. It can no more DELAY the launch
 *  than refuse it: the write runs under its own short busy timeout, restored on every
 *  exit. Returns whether the observation was recorded, so a caller can say so rather
 *  than assume it.
 *
 *  The association is the SUBMITTER's declared metadata, verbatim. Nothing is
 *  derived from the launch name, from argv, or from anything the command logs.
 *
 *  FG-700: so is the PURPOSE, and it is a separate argument for the same reason it is
 *  a separate column — carrying `--run`/`--task`/`--ticket` says where the launch
 *  belongs and says NOTHING about what it is. A caller that does not declare one
 *  records `generic`. */
export function recordLaunchStart(meta: LaunchMeta, association?: LaunchAssociation, purpose?: LaunchPurpose): boolean {
  try {
    const db = getDb();
    const priorBusyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma(`busy_timeout = ${LAUNCH_OBSERVATION_BUSY_TIMEOUT_MS}`);
    try {
      // Both channels are resolved SEPARATELY because the row records not just WHERE
      // the launch was placed but WHICH channel put it there (FG-684 AC4).
      const associationProjectDir = projectDirForAssociation(association);
      recordLaunchObservation({
        launchId: meta.id,
        name: meta.id,
        command: meta.command,
        cwd: meta.cwd,
        projectDir: associationProjectDir ?? resolveRegisteredProjectDir(meta.cwd),
        associationProjectDir,
        ...(association ? { association } : {}),
        ...(purpose ? { purpose } : {}),
        startedAt: meta.startedAt,
        observedAt: meta.startedAt,
        status: { state: "running" },
      });
    } finally {
      db.pragma(`busy_timeout = ${priorBusyTimeout}`);
    }
    return true;
  } catch {
    return false; // unobserved, not unlaunched — and never delayed
  }
}

/** FG-679 (BD-16): promote on-disk terminal evidence into the observation store.
 *
 *  NO DAEMON AND NO RESIDENT OBSERVER. The terminal record is ALREADY durable
 *  without a waiter: `buildWrapperCommand` embeds a recorder in the command the tmux
 *  pane runs, and that recorder's LAST act is writing the exit file. A resident
 *  observer would therefore buy nothing — the only missing step is copying that
 *  record into the store, which the next writable Forge invocation does (the same
 *  shape as the publication reconcile sweep at the top of every wave, and the SSO
 *  watchdog being stopped by the next `forge next`/`forge gate`). The absence of a
 *  daemon here is BD-16, not an absence of precedent: src/util/sso-watchdog.ts is a
 *  real supervised, PID-file-tracked, detached periodic host process (BD-17).
 *
 *  IT NEVER PROBES AND IT NEVER FABRICATES. It reads ONLY the on-disk exit record,
 *  through the same launch-id charset guard every other path uses. It does not
 *  consult tmux. A launch with NO exit record on disk is left EXACTLY as it was —
 *  it keeps reading `unobserved since <t>` rather than being promoted to a terminal
 *  disposition nothing observed. That is the honest FG-680-incident shape and it
 *  must stay reachable.
 *
 *  Returns the number of rows promoted. Best-effort for the caller: a failing sweep
 *  must never take down the command that hosts it. */
export function promoteLaunchObservations(opts: { now?: Date; limit?: number } = {}): number {
  const observedAt = (opts.now ?? new Date()).toISOString();
  let open: LaunchObservation[];
  try {
    open = listOpenLaunchObservations(opts.limit ?? 200);
  } catch {
    return 0;
  }
  let promoted = 0;
  for (const row of open) {
    try {
      // The charset guard BEFORE the id can become a path — the same contract
      // launchDir enforces. A row an older/foreign writer left with a non-conforming
      // id is skipped, never joined onto the filesystem.
      if (!isLaunchId(row.launchId)) continue;
      const exitPath = join(LAUNCHES_DIR, row.launchId, "exit");
      if (!existsSync(exitPath)) continue;
      const rec = parseExitRecord(readFileSync(exitPath, "utf8"));
      // An unreadable/half-written record is NOT terminal evidence (FG-552): leave
      // the row alone and let a later sweep see the committed bytes.
      if (!rec) continue;
      if (updateLaunchObservationStatus(row.launchId, classifyExit(rec), observedAt)) promoted++;
    } catch {
      /* one unreadable launch never stops the sweep */
    }
  }
  return promoted;
}
