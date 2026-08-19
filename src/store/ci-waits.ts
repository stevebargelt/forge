// FG-731 (Step 1): the durable ci_waits store — a Forge-owned CI WAIT as a
// first-class, recoverable row.
//
// WHY IT EXISTS. When the orchestrator waits on a Forge-owned CI run (required PR
// checks, a push-triggered Actions run, or a workflow_dispatch run), that wait is
// invisible on `forge status`/the dashboard: those surface forge-native execution
// plus a candidate-sha-bound `requiredCi`, never an arbitrary awaited Actions run.
// A wait registered here is durable BEFORE polling, so the shared Current Activity
// derivation (Step 2b) can read WAITING/WORKING — never IDLE — while the wait lives.
//
// A DISTINCT FOURTH CI SURFACE. Not launch_observations (whose terminal authority is
// a LOCAL tmux owner — wrong for a remote run), not the review-loop's candidate-sha
// `ci_observed` stream, not `requiredCi`. See the ci_waits block in schema.ts.
//
// THE INVARIANTS THIS MODULE BAKES IN:
//   1. TERMINAL AUTHORITY IS REMOTE. A dead waiter (expired lease) NEVER terminalizes
//      the wait — the run is still real on GitHub. Terminal is reached ONLY by
//      advanceCiWait, and the lease is read by nobody here to decide terminality.
//   2. EXISTENCE FORCES NON-IDLE INDEPENDENT OF FRESHNESS. `terminal = 0` is the
//      liveness predicate (isCiWaitLive), independent of observed_at. Freshness
//      governs only the LABEL a later step renders, never whether the wait exists.
//   3. A RESOLVABLE-NOT-FOUND REMOTE reaches a DISTINCT terminal (`abandoned`) rather
//      than persisting as running — the vocabulary is here; the transition that fires
//      it is a later step's observation logic.

import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, writeTransaction } from "./db.js";
import { storeNowMs } from "./publications.js";
import { provenPhysical } from "../util/path-identity.js";

/** The wait kinds this surface covers. Enum-as-convention (FG-585): TEXT with no DB
 *  CHECK, so an old/new binary never fights a constraint the other lacks. */
const CI_WAIT_KINDS = {
  pr_checks: true,
  push_actions: true,
  workflow_dispatch: true,
} as const;
export type CiWaitKind = keyof typeof CI_WAIT_KINDS;
export const CI_WAIT_KIND_VALUES = Object.keys(CI_WAIT_KINDS) as ReadonlyArray<CiWaitKind>;

/** The STATE-MACHINE position — the axis that decides liveness. The legal path is
 *  registered -> running -> completed_awaiting_advance -> {advanced|cancelled|abandoned}.
 *  `completed_awaiting_advance` is a REAL non-terminal state (a forge advance is owed),
 *  never a leak. */
const CI_WAIT_LIFECYCLE_STATES = {
  registered: true,
  running: true,
  completed_awaiting_advance: true,
  advanced: true,
  cancelled: true,
  abandoned: true,
} as const;
export type CiWaitLifecycleState = keyof typeof CI_WAIT_LIFECYCLE_STATES;

/** The terminal dispositions. A terminal wait carries exactly one of these, and its
 *  lifecycle_state equals it. `completed_awaiting_advance` is deliberately NOT here. */
const CI_WAIT_TERMINAL_DISPOSITIONS = {
  advanced: true,
  cancelled: true,
  abandoned: true,
} as const;
export type CiWaitTerminalDisposition = keyof typeof CI_WAIT_TERMINAL_DISPOSITIONS;

/** The LAST-OBSERVED aggregate CI state — a DIFFERENT axis from lifecycle_state. `no_runs`
 *  ("no CI is running") and `unavailable` ("CI state could not be determined") are DISTINCT
 *  and never collapse into each other or into a fake success/idle. */
export type CiWaitObservation =
  | { state: "running"; m?: number | null; n?: number | null }
  | { state: "no_runs" }
  | { state: "unavailable"; reason?: string | null }
  | { state: "completed" };

export type CiWaitObservedState = CiWaitObservation["state"];

/** Is this lifecycle state terminal? The predicate behind `terminal` and isCiWaitLive.
 *  A value this binary does not recognize is treated as NON-terminal — a wait whose
 *  state a newer binary wrote must keep forcing non-idle, never silently drop off the
 *  live surface (invariant 2). */
export function isTerminalCiWaitState(state: string): boolean {
  return state === "advanced" || state === "cancelled" || state === "abandoned";
}

export type CiWaitAssociation = {
  runId?: string | null;
  ticketId?: string | null;
  projectDir?: string | null;
};

/** The remote identity + request, sufficient for ANY forge process to re-query `gh`
 *  without the original waiter. Which fields are populated depends on `kind` — see the
 *  ci_waits block in schema.ts. */
export type CiWaitRemote = {
  repo?: string | null;
  actionsRunId?: string | null;
  prNumber?: number | null;
  headSha?: string | null;
  checkSuiteRef?: string | null;
  workflowFile?: string | null;
  dispatchRef?: string | null;
  /** workflow_dispatch inputs. An object is JSON-serialized; a string is stored verbatim. */
  dispatchInputs?: Record<string, unknown> | string | null;
};

export type RegisterCiWaitInput = {
  id: string;
  kind: CiWaitKind;
  remote?: CiWaitRemote;
  url?: string | null;
  startedAt: string;
  owner?: string | null;
  leaseExpiresAtMs?: number | null;
  association?: CiWaitAssociation;
};

export type CiWait = {
  id: string;
  kind: CiWaitKind;
  repo: string | null;
  actionsRunId: string | null;
  prNumber: number | null;
  headSha: string | null;
  checkSuiteRef: string | null;
  workflowFile: string | null;
  dispatchRef: string | null;
  dispatchInputs: string | null;
  url: string | null;
  startedAt: string;
  lifecycleState: CiWaitLifecycleState;
  terminal: boolean;
  terminalDisposition: CiWaitTerminalDisposition | null;
  observedState: CiWaitObservedState | null;
  observedReason: string | null;
  observedM: number | null;
  observedN: number | null;
  observedAt: string | null;
  owner: string | null;
  leaseExpiresAtMs: number | null;
  runId: string | null;
  ticketId: string | null;
  projectDir: string | null;
  projectDirCanonical: string | null;
};

type CiWaitRow = {
  id: string;
  kind: string;
  repo: string | null;
  actions_run_id: string | null;
  pr_number: number | null;
  head_sha: string | null;
  check_suite_ref: string | null;
  workflow_file: string | null;
  dispatch_ref: string | null;
  dispatch_inputs: string | null;
  url: string | null;
  started_at: string;
  lifecycle_state: string;
  terminal: number;
  terminal_disposition: string | null;
  observed_state: string | null;
  observed_reason: string | null;
  observed_m: number | null;
  observed_n: number | null;
  observed_at: string | null;
  owner: string | null;
  lease_expires_at_ms: number | null;
  run_id: string | null;
  ticket_id: string | null;
  project_dir: string | null;
  project_dir_canonical: string | null;
};

const CI_WAIT_COLUMNS = [
  "id", "kind", "repo", "actions_run_id", "pr_number", "head_sha", "check_suite_ref",
  "workflow_file", "dispatch_ref", "dispatch_inputs", "url", "started_at",
  "lifecycle_state", "terminal", "terminal_disposition", "observed_state",
  "observed_reason", "observed_m", "observed_n", "observed_at", "owner",
  "lease_expires_at_ms", "run_id", "ticket_id", "project_dir", "project_dir_canonical",
].join(", ");

/** The SQL liveness predicate — derived from lifecycle_state (the CANONICAL axis),
 *  NEVER the stored `terminal` byte (invariant 2). Filtering on the byte would silently
 *  drop a row whose byte lies (e.g. lifecycle=running, terminal=1) off the live surface,
 *  which is exactly the recovery/activity IDLE bug. The three terminal states here mirror
 *  isTerminalCiWaitState / CI_WAIT_TERMINAL_DISPOSITIONS — everything else (including a
 *  state a newer binary wrote) is live, so a filter on this never ages a wait out. */
export const CI_WAIT_LIVE_WHERE = `lifecycle_state NOT IN ('advanced', 'cancelled', 'abandoned')`;

function decodeKind(raw: string): CiWaitKind {
  // An unknown kind is kept verbatim rather than fabricated into a specific one:
  // failing closed to pr_checks would be a lie, and a value a newer binary wrote is
  // its vocabulary to own — readers only ever compare it.
  return raw as CiWaitKind;
}

function decodeObservedState(raw: string | null): CiWaitObservedState | null {
  if (raw === "running" || raw === "no_runs" || raw === "unavailable" || raw === "completed") return raw;
  return null;
}

function decodeTerminalDisposition(raw: string | null): CiWaitTerminalDisposition | null {
  return raw !== null && Object.hasOwn(CI_WAIT_TERMINAL_DISPOSITIONS, raw)
    ? (raw as CiWaitTerminalDisposition)
    : null;
}

export function rowToCiWait(row: CiWaitRow): CiWait {
  return {
    id: row.id,
    kind: decodeKind(row.kind),
    repo: row.repo,
    actionsRunId: row.actions_run_id,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    checkSuiteRef: row.check_suite_ref,
    workflowFile: row.workflow_file,
    dispatchRef: row.dispatch_ref,
    dispatchInputs: row.dispatch_inputs,
    url: row.url,
    startedAt: row.started_at,
    lifecycleState: row.lifecycle_state as CiWaitLifecycleState,
    // Derived from the canonical state, never trusted from the column: a row whose
    // `terminal` byte disagrees with its own state must not create a new fact.
    terminal: isTerminalCiWaitState(row.lifecycle_state),
    terminalDisposition: decodeTerminalDisposition(row.terminal_disposition),
    observedState: decodeObservedState(row.observed_state),
    observedReason: row.observed_reason,
    observedM: row.observed_m,
    observedN: row.observed_n,
    observedAt: row.observed_at,
    owner: row.owner,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    runId: row.run_id,
    ticketId: row.ticket_id,
    projectDir: row.project_dir,
    projectDirCanonical: row.project_dir_canonical,
  };
}

/** The live-wait predicate (invariant 2): non-terminal is live, FULL STOP —
 *  independent of observed_at freshness. Its mere presence is what forces
 *  WAITING/never-IDLE in Step 2b. */
export function isCiWaitLive(wait: Pick<CiWait, "terminal">): boolean {
  return !wait.terminal;
}

function encodeDispatchInputs(inputs: CiWaitRemote["dispatchInputs"]): string | null {
  if (inputs === null || inputs === undefined) return null;
  return typeof inputs === "string" ? inputs : JSON.stringify(inputs);
}

/** How long the register write may wait on a BUSY store before giving up — the same
 *  discipline as recordLaunchStart. Registration runs on the wait-creation path and
 *  must NEVER block or refuse the wait; a store hiccup degrades to best-effort. */
const CI_WAIT_REGISTER_BUSY_TIMEOUT_MS = 250;

/** The register-before-poll INSERT: synchronous, done at wait-creation BEFORE any gh
 *  call, and BEST-EFFORT against the store. A store that cannot be written leaves the
 *  wait UNREGISTERED — never refused and never delayed (mirrors recordLaunchStart).
 *  Returns whether the row was written. */
export function registerCiWait(input: RegisterCiWaitInput): boolean {
  const remote = input.remote ?? {};
  const projectDir = input.association?.projectDir ?? null;
  // PROVEN identity resolved BEFORE the transaction opens — no filesystem syscall may
  // be held across the machine-wide write lock (the invariant db.ts and runs.ts state).
  const projectDirCanonical = projectDir === null ? null : provenPhysical(projectDir);
  try {
    const db = getDb();
    const priorBusyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma(`busy_timeout = ${CI_WAIT_REGISTER_BUSY_TIMEOUT_MS}`);
    try {
      writeTransaction(() => {
        getDb().prepare(`
          INSERT INTO ci_waits (${CI_WAIT_COLUMNS})
          VALUES (@id, @kind, @repo, @actions_run_id, @pr_number, @head_sha, @check_suite_ref,
                  @workflow_file, @dispatch_ref, @dispatch_inputs, @url, @started_at,
                  'registered', 0, NULL, NULL, NULL, NULL, NULL, NULL, @owner,
                  @lease_expires_at_ms, @run_id, @ticket_id, @project_dir, @project_dir_canonical)
          ON CONFLICT(id) DO NOTHING
        `).run({
          id: input.id,
          kind: input.kind,
          repo: remote.repo ?? null,
          actions_run_id: remote.actionsRunId ?? null,
          pr_number: remote.prNumber ?? null,
          head_sha: remote.headSha ?? null,
          check_suite_ref: remote.checkSuiteRef ?? null,
          workflow_file: remote.workflowFile ?? null,
          dispatch_ref: remote.dispatchRef ?? null,
          dispatch_inputs: encodeDispatchInputs(remote.dispatchInputs),
          url: input.url ?? null,
          started_at: input.startedAt,
          owner: input.owner ?? null,
          lease_expires_at_ms: input.leaseExpiresAtMs ?? null,
          run_id: input.association?.runId ?? null,
          ticket_id: input.association?.ticketId ?? null,
          project_dir: projectDir,
          project_dir_canonical: projectDirCanonical,
        });
      });
    } finally {
      db.pragma(`busy_timeout = ${priorBusyTimeout}`);
    }
    return true;
  } catch {
    return false; // unregistered, not unwaited — and never delayed
  }
}

export type RegisterOrAdoptCiWaitInput = RegisterCiWaitInput & { owner: string; leaseMs: number };

export type RegisterOrAdoptCiWaitResult =
  | { registered: true; adopted: boolean; wait: CiWait }
  | { registered: false };

/** ATOMIC insert-or-adopt keyed on the caller's remote-identity matcher (FG-731 RF-1).
 *  The find-a-live-twin read and the INSERT run in ONE writeTransaction (BEGIN IMMEDIATE),
 *  so two forge processes arming the SAME remote run cannot both take the new-row path:
 *  the loser blocks on the write lock, then sees the winner's committed row and adopts it.
 *  Candidate liveness is derived from lifecycle_state (CI_WAIT_LIVE_WHERE), never the byte.
 *
 *  The lease is set in the SAME transaction — so the caller never needs a SECOND write to
 *  arm the wait. BEST-EFFORT against a busy store, exactly like registerCiWait: a store
 *  hiccup returns { registered: false } and NEVER throws, so the caller degrades to an
 *  unregistered fallback wait rather than blocking or refusing it (RF-6). */
export function registerOrAdoptCiWait(
  input: RegisterOrAdoptCiWaitInput,
  matches: (candidate: CiWait) => boolean,
): RegisterOrAdoptCiWaitResult {
  const remote = input.remote ?? {};
  const projectDir = input.association?.projectDir ?? null;
  // PROVEN identity resolved BEFORE the transaction opens — no filesystem syscall may be
  // held across the machine-wide write lock (the invariant db.ts and registerCiWait state).
  const projectDirCanonical = projectDir === null ? null : provenPhysical(projectDir);
  try {
    const db = getDb();
    const priorBusyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma(`busy_timeout = ${CI_WAIT_REGISTER_BUSY_TIMEOUT_MS}`);
    try {
      return writeTransaction((): RegisterOrAdoptCiWaitResult => {
        const tx = getDb();
        const liveRows = tx
          .prepare(`SELECT ${CI_WAIT_COLUMNS} FROM ci_waits WHERE ${CI_WAIT_LIVE_WHERE} ORDER BY started_at DESC`)
          .all() as CiWaitRow[];
        const existing = liveRows.map(rowToCiWait).find(matches);
        const leaseExpiresAtMs = storeNowMs() + input.leaseMs;
        if (existing) {
          tx.prepare(`UPDATE ci_waits SET owner = ?, lease_expires_at_ms = ? WHERE id = ?`)
            .run(input.owner, leaseExpiresAtMs, existing.id);
          return { registered: true, adopted: true, wait: { ...existing, owner: input.owner, leaseExpiresAtMs } };
        }
        tx.prepare(`
          INSERT INTO ci_waits (${CI_WAIT_COLUMNS})
          VALUES (@id, @kind, @repo, @actions_run_id, @pr_number, @head_sha, @check_suite_ref,
                  @workflow_file, @dispatch_ref, @dispatch_inputs, @url, @started_at,
                  'registered', 0, NULL, NULL, NULL, NULL, NULL, NULL, @owner,
                  @lease_expires_at_ms, @run_id, @ticket_id, @project_dir, @project_dir_canonical)
          ON CONFLICT(id) DO NOTHING
        `).run({
          id: input.id,
          kind: input.kind,
          repo: remote.repo ?? null,
          actions_run_id: remote.actionsRunId ?? null,
          pr_number: remote.prNumber ?? null,
          head_sha: remote.headSha ?? null,
          check_suite_ref: remote.checkSuiteRef ?? null,
          workflow_file: remote.workflowFile ?? null,
          dispatch_ref: remote.dispatchRef ?? null,
          dispatch_inputs: encodeDispatchInputs(remote.dispatchInputs),
          url: input.url ?? null,
          started_at: input.startedAt,
          owner: input.owner,
          lease_expires_at_ms: leaseExpiresAtMs,
          run_id: input.association?.runId ?? null,
          ticket_id: input.association?.ticketId ?? null,
          project_dir: projectDir,
          project_dir_canonical: projectDirCanonical,
        });
        const wait = getCiWait(input.id);
        return wait === undefined ? { registered: false } : { registered: true, adopted: false, wait };
      });
    } finally {
      db.pragma(`busy_timeout = ${priorBusyTimeout}`);
    }
  } catch {
    return { registered: false }; // unregistered, not unwaited — and never delayed
  }
}

/** What an observation may resolve about the remote on first sight — the
 *  workflow_dispatch case fills the run id/url here (register-before-poll left them null). */
export type CiWaitResolved = { actionsRunId?: string | null; url?: string | null };

/** Update the last-observed aggregate state + observed_at, and drive the non-terminal
 *  lifecycle transitions: registered -> running (any non-completed observation) and
 *  -> completed_awaiting_advance (gh reports the run terminal). NEVER terminalizes — a
 *  terminal disposition is advanceCiWait's job — and never resurrects a terminal wait
 *  (returns false). Does not create a row for an id that was never registered. */
export function observeCiWait(
  id: string,
  observation: CiWaitObservation,
  observedAt: string,
  resolved?: CiWaitResolved,
): boolean {
  const observedState = observation.state;
  const observedM = observation.state === "running" ? observation.m ?? null : null;
  const observedN = observation.state === "running" ? observation.n ?? null : null;
  const observedReason = observation.state === "unavailable" ? observation.reason ?? null : null;
  // A run gh reports terminal is completed_awaiting_advance — a forge advance is owed;
  // any other observation means the run is still live, so the wait is `running`.
  const nextLifecycle: CiWaitLifecycleState =
    observedState === "completed" ? "completed_awaiting_advance" : "running";
  return writeTransaction(() => {
    const db = getDb();
    const row = db.prepare(`SELECT lifecycle_state FROM ci_waits WHERE id = ?`).get(id) as
      | { lifecycle_state: string }
      | undefined;
    if (row === undefined) return false;
    if (isTerminalCiWaitState(row.lifecycle_state)) return false;
    const res = db.prepare(`
      UPDATE ci_waits
         SET lifecycle_state = ?,
             terminal = 0,
             observed_state = ?,
             observed_reason = ?,
             observed_m = ?,
             observed_n = ?,
             observed_at = ?,
             actions_run_id = COALESCE(?, actions_run_id),
             url = COALESCE(?, url)
       WHERE id = ?
    `).run(
      nextLifecycle,
      observedState,
      observedReason,
      observedM,
      observedN,
      observedAt,
      resolved?.actionsRunId ?? null,
      resolved?.url ?? null,
      id,
    );
    return res.changes === 1;
  });
}

/** Move the wait to a TERMINAL disposition. `advanced` requires the run to have been
 *  observed terminal first (completed_awaiting_advance -> advanced). `cancelled` and
 *  `abandoned` may fire from ANY non-terminal state (an operator cancel, a lost waiter,
 *  or a gh "not found" that resolves the remote as gone). A wait already terminal is
 *  left as-is (returns false) — the first disposition wins. */
export function advanceCiWait(id: string, disposition: CiWaitTerminalDisposition): boolean {
  return writeTransaction(() => {
    const db = getDb();
    const row = db.prepare(`SELECT lifecycle_state FROM ci_waits WHERE id = ?`).get(id) as
      | { lifecycle_state: string }
      | undefined;
    if (row === undefined) return false;
    if (isTerminalCiWaitState(row.lifecycle_state)) return false;
    if (disposition === "advanced" && row.lifecycle_state !== "completed_awaiting_advance") return false;
    const res = db.prepare(`
      UPDATE ci_waits SET lifecycle_state = ?, terminal = 1, terminal_disposition = ? WHERE id = ?
    `).run(disposition, disposition, id);
    return res.changes === 1;
  });
}

/** Renew (or set) the owner + epoch-ms lease. Observability + adopt-on-recovery ONLY:
 *  the lease is NOT terminal authority, so this NEVER touches lifecycle_state or
 *  terminal. `leaseMs` is added to the STORE's own clock (storeNowMs), the single clock
 *  every lease is written and compared against. */
export function renewCiWaitLease(id: string, owner: string, leaseMs: number): boolean {
  return writeTransaction(() => {
    const res = getDb().prepare(`
      UPDATE ci_waits SET owner = ?, lease_expires_at_ms = ? WHERE id = ?
    `).run(owner, storeNowMs() + leaseMs, id);
    return res.changes === 1;
  });
}

export type CiWaitLease = { owner: string | null; leaseExpiresAtMs: number | null };

/** Read the lease for adopt-on-recovery. An EXPIRED lease is reported as-is — an
 *  expired lease means the WAITER is gone, NOT that the wait is terminal (invariant 1).
 *  The caller compares against storeNowMs() to decide adoption. */
export function readCiWaitLease(id: string): CiWaitLease | undefined {
  const row = getDb()
    .prepare(`SELECT owner, lease_expires_at_ms FROM ci_waits WHERE id = ?`)
    .get(id) as { owner: string | null; lease_expires_at_ms: number | null } | undefined;
  return row === undefined ? undefined : { owner: row.owner, leaseExpiresAtMs: row.lease_expires_at_ms };
}

export function getCiWait(id: string): CiWait | undefined {
  const row = getDb().prepare(`SELECT ${CI_WAIT_COLUMNS} FROM ci_waits WHERE id = ?`).get(id) as
    | CiWaitRow
    | undefined;
  return row === undefined ? undefined : rowToCiWait(row);
}

export type CiWaitScope = { liveOnly?: boolean; limit?: number };

/** Read waits for the Step-2b derivation and the Step-2a wait command. Newest-first.
 *  `liveOnly` restricts to non-terminal rows (the live surface). Project/run scoping is
 *  left to the derivation's resolveProjectScope machinery over the association fields
 *  every row carries — this read stays deliberately un-opinionated about placement. */
export function readCiWaits(scope: CiWaitScope = {}): CiWait[] {
  // liveOnly filters on lifecycle_state (CI_WAIT_LIVE_WHERE), never the `terminal` byte:
  // a row whose byte disagrees with its own state must be decided by the state (RF-3), and
  // this keeps the LIMIT applied to live rows rather than to a byte-filtered subset.
  const where = scope.liveOnly ? `WHERE ${CI_WAIT_LIVE_WHERE}` : ``;
  const rows = getDb()
    .prepare(`SELECT ${CI_WAIT_COLUMNS} FROM ci_waits ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(scope.limit ?? 500) as CiWaitRow[];
  return rows.map(rowToCiWait);
}

/** Test/introspection seam: the raw column set, so a fresh-vs-migrated assertion can
 *  probe the table shape without a second copy of the list. */
export function ciWaitColumns(db: DatabaseInstance): string[] {
  return (db.prepare(`PRAGMA table_info(ci_waits)`).all() as Array<{ name: string }>).map((c) => c.name);
}
