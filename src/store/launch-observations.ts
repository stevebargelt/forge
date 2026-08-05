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
// records HOW the launch was placed, decided once at submission:
//   'explicit' — structured metadata the submitter supplied. The ONLY authority for
//                RUN-level placement.
//   'cwd'      — the cwd resolved to a registered project home. PROJECT level only,
//                and labeled `unassociated`.
//   'none'     — no registered project home. Host-level "Unassociated activity".
// Nothing here ever consults a launch NAME, ARGV, or LOG TEXT. FG-492 records that
// long-lived agent processes carry conversation text in argv and falsely match
// unrelated run/ticket names; `extractForgeIds` is quarantined for exactly that
// reason and authorizes nothing.
//
// THE WRITE RULE: every mutation takes its write lock immediately via
// writeTransaction (BEGIN IMMEDIATE), never a deferred txn that upgrades mid-flight.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDb, writeTransaction } from "./db.js";
import { LAUNCHES_DIR, classifyExit, isLaunchId, parseExitRecord, type LaunchMeta, type LaunchStatus } from "../v2/launch.js";

/** How a launch's placement was AUTHORIZED. Enum-as-convention (FG-585): TEXT with
 *  no DB CHECK, so an old/new binary never fights a constraint the other lacks. */
export type LaunchAssociationKind = "explicit" | "cwd" | "none";

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
  startedAt: string;
  observedAt: string;
  status: LaunchStatus;
  terminal: boolean;
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
    associationKind: decodeAssociationKind(row.association_kind),
    runId: row.run_id,
    taskId: row.task_id,
    ticketId: row.ticket_id,
    campaignId: row.campaign_id,
    itemId: row.item_id,
    startedAt: row.started_at,
    observedAt: row.observed_at,
    status,
    // Derived from the canonical state, never trusted from the column: a row whose
    // `terminal` byte disagrees with its own state must not create an eighth fact.
    terminal: isTerminalObservationState(status.state),
  };
}

export const LAUNCH_OBSERVATION_COLUMNS =
  "launch_id, name, command, cwd, project_dir, association_kind, run_id, task_id, ticket_id, campaign_id, item_id, started_at, observed_at, state, exit_code, signal, terminal";

export type RecordLaunchObservationInput = {
  launchId: string;
  name?: string | null;
  command: string[];
  cwd: string;
  projectDir?: string | null;
  association?: LaunchAssociation | undefined;
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

function hasPlacementAuthority(association: LaunchAssociation | undefined): boolean {
  if (association === undefined) return false;
  return PLACEMENT_AUTHORIZING_FIELDS.some((f) => typeof association[f] === "string" && association[f] !== "");
}

/** Decide the placement AUTHORITY from what is actually known. Explicit metadata
 *  wins; a resolved project home is the weaker `cwd` channel; nothing else places
 *  anywhere but the host-level bucket. */
export function associationKindFor(association: LaunchAssociation | undefined, projectDir: string | null): LaunchAssociationKind {
  if (hasPlacementAuthority(association)) return "explicit";
  return projectDir === null ? "none" : "cwd";
}

/** Write (or replace) the single row for a launch. Callers treat this as
 *  BEST-EFFORT: an unwritable store must never become a launch refusal. */
export function recordLaunchObservation(input: RecordLaunchObservationInput): void {
  const projectDir = input.projectDir ?? null;
  const kind = associationKindFor(input.association, projectDir);
  const { state, exitCode, signal } = encodeLaunchStatus(input.status);
  const terminal = isTerminalObservationState(input.status.state) ? 1 : 0;
  writeTransaction(() => {
    getDb().prepare(`
      INSERT INTO launch_observations (${LAUNCH_OBSERVATION_COLUMNS})
      VALUES (@launch_id, @name, @command, @cwd, @project_dir, @association_kind, @run_id, @task_id, @ticket_id, @campaign_id, @item_id, @started_at, @observed_at, @state, @exit_code, @signal, @terminal)
      ON CONFLICT(launch_id) DO UPDATE SET
        name = excluded.name,
        command = excluded.command,
        cwd = excluded.cwd,
        project_dir = excluded.project_dir,
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
        terminal = excluded.terminal
    `).run({
      launch_id: input.launchId,
      name: input.name ?? null,
      command: JSON.stringify(input.command),
      cwd: input.cwd,
      project_dir: projectDir,
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
  const row = getDb()
    .prepare(`SELECT ${LAUNCH_OBSERVATION_COLUMNS} FROM launch_observations WHERE launch_id = ?`)
    .get(launchId) as LaunchObservationRow | undefined;
  return row ? rowToLaunchObservation(row) : undefined;
}

/** Rows that have NOT reached a terminal disposition — the bounded candidate set
 *  the opportunistic promoter sweeps. Bounded and newest-first so a host with a
 *  long history of abandoned records never turns a `forge next` into a scan. */
export function listOpenLaunchObservations(limit = 200): LaunchObservation[] {
  const rows = getDb()
    .prepare(`SELECT ${LAUNCH_OBSERVATION_COLUMNS} FROM launch_observations WHERE terminal = 0 ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as LaunchObservationRow[];
  return rows.map(rowToLaunchObservation);
}

export function listLaunchObservations(limit = 500): LaunchObservation[] {
  const rows = getDb()
    .prepare(`SELECT ${LAUNCH_OBSERVATION_COLUMNS} FROM launch_observations ORDER BY started_at DESC LIMIT ?`)
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
 *  Explicit submission metadata is the STRONGEST authority (BD-3), so it must not
 *  lose to a cwd lookup that happens to fail. A per-task worktree is deliberately
 *  outside every registered project home, so an otherwise explicit `--run` launch
 *  resolved to project_dir null and then vanished from its project's Current activity
 *  — defeating the ticket's own motivating case. The declared run (or the run its
 *  declared task belongs to) says which project it is, and that answer is at least as
 *  authoritative as the cwd one. A ticket id alone names no project; it stays null
 *  rather than being resolved by some looser channel. */
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
 *  derived from the launch name, from argv, or from anything the command logs. */
export function recordLaunchStart(meta: LaunchMeta, association?: LaunchAssociation): boolean {
  try {
    const db = getDb();
    const priorBusyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma(`busy_timeout = ${LAUNCH_OBSERVATION_BUSY_TIMEOUT_MS}`);
    try {
      recordLaunchObservation({
        launchId: meta.id,
        name: meta.id,
        command: meta.command,
        cwd: meta.cwd,
        projectDir: resolveRegisteredProjectDir(meta.cwd) ?? projectDirForAssociation(association),
        ...(association ? { association } : {}),
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
