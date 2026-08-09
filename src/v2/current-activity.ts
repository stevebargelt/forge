// FG-679: the ONE shared "current activity" derivation.
//
// WHY ONE MODULE. BD-9 requires `/status` and the dashboard to AGREE when the only
// active work is a host launch or a pending required check. Agreement asserted in a
// SKILL.md's prose is not agreement; agreement by CONSTRUCTION is. Both surfaces
// call this function, over the same persisted state, so a disagreement would have
// to be a disagreement with itself.
//
// WHAT IT READS: persisted state ONLY — task/run rows, the `launch_observations`
// table (FG-679), and the newest `review_loop.ci_observed` event per
// (runId, projectDir) THAT IS STILL ANCHORED TO CURRENT WORK (FG-694). It makes NO
// outbound call of any kind: no tmux, no `readLaunch`/`listLaunches`, no `git`, no
// `gh`, no shell, no Forge CLI (BD-7/BD-12).
// The database handle is INJECTED because the dashboard opens its own read-only
// connection; the derivation itself owns no handle and mints no store.
//
// THREE DISJOINT SECTIONS (BD-1): `agents`, `hostVerification`, `requiredCi`. A
// launch is NEVER represented as an agent task, and a pending check is never
// represented as either.
//
// WHAT IT REFUSES TO DO:
//   - It never claims liveness it did not observe. A non-terminal row past the
//     freshness cutoff reads `unobserved since <t>` — never `running`, never
//     terminal (BD-12).
//   - It never computes what the candidate sha IS. The observer DECLARES the sha it
//     probed; this reader presents only the NEWEST observation, so an observation
//     bound to a superseded candidate simply stops being the newest and disappears
//     rather than being carried forward or relabeled (BD-6). FG-694 does NOT relax
//     this: it narrows which observations are CURRENT, by asking the persisted run
//     and review rows whether the work is still open — never by re-deriving a sha.
//   - It never presents a CI observation whose only anchor is FINISHED work
//     (FG-694). "Newest for its (run, project) pair" was never a claim of currency:
//     a pair whose run completed months ago has a newest row forever, and ten of
//     them rendered at once under the heading `Current activity` on 2026-08-08.
//   - It never consults a launch name, argv, log text, or the quarantined
//     `forgeIds`. Placement is authorized by the persisted association alone — the
//     DECLARED submission ids and `project_dir` (BD-2/BD-15).
//   - It never renders the launch status itself: `statusLine` (src/v2/launch.ts) is
//     the ONE human rendering, so the four BD-4 facts stay four facts here too.

import { basename } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { isLaunchId, statusLine, type LaunchStatus } from "./launch.js";
import {
  LAUNCH_OBSERVATION_COLUMNS,
  hasPlacementAuthority,
  rowToLaunchObservation,
  type LaunchAssociationKind,
  type LaunchObservation,
  type LaunchObservationRow,
} from "../store/launch-observations.js";

/** Re-exported so a second consumer (the dashboard) validates a launch id against
 *  the SAME definition `launchDir` uses, and renders the status through the SAME
 *  `statusLine`, from the one module it already imports for this surface. A
 *  hand-copied regex is how a traversal guard drifts looser than the chokepoint it
 *  mirrors (BD-10); a hand-copied label is how the four BD-4 facts become three. */
export { isLaunchId, statusLine };

/** How old an observation may be before the reader stops treating it as evidence
 *  about NOW. Generous on purpose: host verification runs for minutes to tens of
 *  minutes, and freshness is refreshed only opportunistically (BD-16 — no daemon),
 *  so too tight a cutoff would report honest work as unobserved within one tier. */
export const LAUNCH_OBSERVATION_FRESH_MS = 30 * 60_000;

/** The review-loop observer writes one observation per poll iteration, so a live
 *  CI wait refreshes on the order of seconds. Anything older than this is a fact
 *  about the observer having stopped, not about the checks. */
export const CI_OBSERVATION_FRESH_MS = 15 * 60_000;

export const CI_NOT_OBSERVED_LABEL = "CI not observed";
export const CI_NOT_RUNNING_LABEL = "CI not running";
export const CI_RUNNING_LABEL = "CI running";

/** FG-694: the THIRD absence, and the one the pre-fix surface could not say. There
 *  is no active run and no open review in scope, so there is nothing that could be
 *  waiting on required checks — which is a different fact from "we have a current
 *  candidate and have observed no CI for it" (`CI not observed`). Collapsing the two
 *  is the same class of error as the stale-row defect, pointed the other way: one
 *  invents currency, the other invents an observation. */
export const CI_NO_CANDIDATE_LABEL = "no current CI candidate";

/** A run row that is not `active` is finished, by any of the three names the
 *  vocabulary gives it (`complete`, `failed`, `abandoned`). Selected POSITIVELY, so
 *  a status this binary does not know reads as "not current" rather than leaking
 *  through a NOT-IN list that predates it. */
const ACTIVE_RUN_STATUS = "active";

/** Reviews are selected NEGATIVELY, the opposite way round and deliberately: the
 *  ledger has nine open states and gains more, so a state this binary has not heard
 *  of must read as OPEN (surfacing live work) rather than as finished (hiding it).
 *  `blocked_environment` is open on purpose — the review is stuck, not over; the
 *  freshness cutoff, not this filter, is what stops a stuck review claiming CI is
 *  running now. */
const TERMINAL_REVIEW_STATES = ["settled", "failed"] as const;

export const CI_OBSERVED_EVENT_TYPE = "review_loop.ci_observed";

export type CurrentActivityScope = {
  /** Run-level placement. Only EXPLICITLY associated launches may appear here. */
  runId?: string | undefined;
  /** Project-level placement. Explicit and cwd-derived launches may appear here. */
  projectDirs?: readonly string[] | undefined;
};

export type ActivityAgentTask = {
  runId: string;
  runTitle: string;
  workflow: string;
  projectDir: string | null;
  projectLabel: string | null;
  taskId: string;
  agentRole: string;
  agentModel: string | null;
  phase: string;
  status: string;
  startedAt: string | null;
};

export type HostLaunchActivity = {
  launchId: string;
  name: string | null;
  command: string[];
  /** The argv joined for display. No host filesystem path is carried on this
   *  record: the launch is addressed by IDENTITY, and its detail/log surfaces are
   *  reached through `/api/launches/<id>` rather than through a path (BD-10). */
  commandLine: string;
  projectDir: string | null;
  projectLabel: string | null;
  associationKind: LaunchAssociationKind;
  /** True unless the SUBMITTER declared placement-authorizing metadata. Rendered as
   *  the literal `unassociated` label (BD-3). Deliberately NOT `associationKind !==
   *  "explicit"`: since FG-684 that label names which channel resolved the project
   *  home, so a launch that declared `--run` and took its project from the cwd reads
   *  `cwd` and is still associated with the run it named. */
  unassociated: boolean;
  placement: "run" | "project" | "host";
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  startedAt: string;
  observedAt: string;
  /** The EFFECTIVE disposition: `unknown` once the observation is past its cutoff,
   *  because an old observation is not evidence about now. */
  status: LaunchStatus;
  /** What the row actually recorded, kept distinct from the effective status so a
   *  reader can tell "we observed running, a while ago" from "we know nothing". */
  recordedStatus: LaunchStatus;
  /** What RENDERS. `statusLine`'s output byte-for-byte while fresh; the explicit
   *  `unobserved since <t>` once stale. Never a generic `failed` (BD-4). */
  statusLabel: string;
  observation: "fresh" | "unobserved";
};

export type RequiredCiContext = {
  context: string;
  state: string;
  url: string | null;
  observedAt: string;
};

export type RequiredCiObservation = {
  runId: string | null;
  projectDir: string | null;
  projectLabel: string | null;
  attemptId: string;
  ticketId: string | null;
  /** The exact sha the observer probed, as the observer DECLARED it (BD-5). */
  candidateSha: string;
  observedAt: string;
  outcome: string;
  unavailableReason: string | null;
  contexts: RequiredCiContext[];
  /** `running` — checks are pending at this sha. `not_running` — the observer's
   *  newest look found nothing pending. `stale` — the newest observation is older
   *  than the cutoff, so it is not evidence about now (BD-8). */
  state: "running" | "not_running" | "stale";
  label: string;
};

export type RequiredCiSection = {
  /** THREE facts, not two, and none substitutes for another:
   *  `no_current_candidate` — nothing in scope could be waiting on required checks:
   *    no active run, no open review. The consumer omits the CI row entirely; it must
   *    NOT report that CI was not observed, because nothing was owed an observation
   *    (FG-694).
   *  `not_observed` — there IS current work in scope and no observation exists for
   *    it, which is a fact about the OBSERVER and a different fact from "CI is not
   *    running" (BD-8).
   *  `observed` — at least one current observation, each carrying its own state. */
  state: "no_current_candidate" | "not_observed" | "observed";
  label: string;
  observations: RequiredCiObservation[];
};

export type CurrentActivity = {
  generatedAt: string;
  scope: { runId: string | null; projectDirs: string[] | null };
  agents: ActivityAgentTask[];
  hostVerification: HostLaunchActivity[];
  requiredCi: RequiredCiSection;
  /** BD-14: launches whose cwd maps to NO registered project home. Populated only
   *  for the host-wide scope — it is a HOST-level bucket, and surfacing it inside a
   *  project or run view would be inventing the very ownership BD-2 forbids. */
  unassociated: HostLaunchActivity[];
};

function projectLabelOf(projectDir: string | null): string | null {
  // Deliberately the basename and nothing more. `projectPresentation` in the
  // dashboard resolves a richer label through repositoryCheckoutIdentity, which
  // shells `git` — a pre-existing serving-path exception (BD-18) that these new
  // sections must not join. A weaker label is the correct trade.
  return projectDir === null || projectDir === "" ? null : basename(projectDir);
}

function parseMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Freshness is a RANGE, never a ceiling, and that is a correctness property rather
 *  than a nicety. `now - observed <= cutoff` is trivially TRUE for a NEGATIVE
 *  difference, so a FUTURE-dated observation — clock skew, a corrected system clock,
 *  an imported row — read as maximally fresh and the surface asserted `running` from
 *  evidence whose observation time has not occurred. Nothing is ever fabricated: an
 *  observation dated ahead of the reader is UNUSABLE, exactly like one too old, and
 *  renders `unobserved since <t>` / `stale`.
 *
 *  Exported so the dashboard's launch detail applies the SAME predicate rather than a
 *  second hand-written comparison that can drift back to one-sided. */
export function observationIsFresh(observedMs: number | null, nowMs: number, freshMs: number): boolean {
  if (observedMs === null) return false;
  const age = nowMs - observedMs;
  return age >= 0 && age <= freshMs;
}

function inProjectScope(projectDir: string | null, projectDirs: readonly string[] | undefined): boolean {
  if (projectDirs === undefined) return true;
  if (projectDir === null) return false;
  return projectDirs.includes(projectDir);
}

function readAgents(db: DatabaseInstance, scope: CurrentActivityScope): ActivityAgentTask[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (scope.runId !== undefined) {
    clauses.push("AND t.run_id = ?");
    params.push(scope.runId);
  }
  if (scope.projectDirs !== undefined) {
    if (scope.projectDirs.length === 0) clauses.push("AND 0 = 1");
    else {
      clauses.push(`AND r.project_dir IN (${scope.projectDirs.map(() => "?").join(",")})`);
      params.push(...scope.projectDirs);
    }
  }
  const rows = db.prepare(`
    SELECT t.id, t.run_id, t.phase, t.agent_role, t.agent_model, t.status, t.started_at,
           r.title, r.workflow, r.project_dir
      FROM tasks t
      JOIN runs r ON r.id = t.run_id
     WHERE t.status IN ('running', 'awaiting_gate', 'awaiting_red', 'blocked_by_red', 'awaiting_recovery')
       AND r.status = 'active'
       ${clauses.join("\n       ")}
     ORDER BY t.started_at DESC, t.created_at DESC
  `).all(...params) as Array<{
    id: string; run_id: string; phase: string; agent_role: string; agent_model: string | null;
    status: string; started_at: string | null; title: string; workflow: string; project_dir: string | null;
  }>;
  return rows.map((r) => ({
    runId: r.run_id,
    runTitle: r.title,
    workflow: r.workflow,
    projectDir: r.project_dir,
    projectLabel: projectLabelOf(r.project_dir),
    taskId: r.id,
    agentRole: r.agent_role,
    agentModel: r.agent_model,
    phase: r.phase,
    status: r.status,
    startedAt: r.started_at,
  }));
}

function toHostLaunch(obs: LaunchObservation, placement: "run" | "project" | "host", nowMs: number): HostLaunchActivity {
  const observedMs = parseMs(obs.observedAt);
  // An UNPARSEABLE observation time is not fresh evidence either — it is an
  // observation we cannot date, which is the same absence of freshness as an old one.
  // Nor is a FUTURE-dated one: see observationIsFresh.
  const fresh = observationIsFresh(observedMs, nowMs, LAUNCH_OBSERVATION_FRESH_MS);
  const status: LaunchStatus = fresh ? obs.status : { state: "unknown" };
  return {
    launchId: obs.launchId,
    name: obs.name,
    command: obs.command,
    commandLine: obs.command.join(" "),
    projectDir: obs.projectDir,
    projectLabel: projectLabelOf(obs.projectDir),
    associationKind: obs.associationKind,
    unassociated: !hasPlacementAuthority(obs),
    placement,
    runId: obs.runId,
    taskId: obs.taskId,
    ticketId: obs.ticketId,
    campaignId: obs.campaignId,
    itemId: obs.itemId,
    startedAt: obs.startedAt,
    observedAt: obs.observedAt,
    status,
    recordedStatus: obs.status,
    statusLabel: fresh ? statusLine(obs.status) : `unobserved since ${obs.observedAt}`,
    observation: fresh ? "fresh" : "unobserved",
  };
}

/** Every launch this host has a NON-TERMINAL observation for. A terminal row has
 *  left the in-flight set by construction (BD-16), which is what lets a promoted
 *  hand-run launch stop appearing without anything fabricating its disposition. */
function readOpenLaunches(db: DatabaseInstance): LaunchObservation[] {
  const rows = db.prepare(`
    SELECT ${LAUNCH_OBSERVATION_COLUMNS}
      FROM launch_observations
     WHERE terminal = 0
     ORDER BY started_at DESC
     LIMIT 500
  `).all() as LaunchObservationRow[];
  return rows.map(rowToLaunchObservation).filter((o) => !o.terminal);
}

type CiPayload = {
  attemptId?: unknown;
  ticketId?: unknown;
  projectDir?: unknown;
  candidateSha?: unknown;
  observedAt?: unknown;
  outcome?: unknown;
  unavailableReason?: unknown;
  contexts?: unknown;
};

function parseContexts(raw: unknown): RequiredCiContext[] {
  if (!Array.isArray(raw)) return [];
  const out: RequiredCiContext[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    if (typeof c["context"] !== "string") continue;
    out.push({
      context: c["context"],
      state: typeof c["state"] === "string" ? c["state"] : "unknown",
      url: typeof c["url"] === "string" ? c["url"] : null,
      observedAt: typeof c["observedAt"] === "string" ? c["observedAt"] : "",
    });
  }
  return out;
}

/** One open review, reduced to the three fields that can anchor an observation. */
type ReviewAnchor = { runId: string | null; ticketId: string | null; workspaceDir: string | null };

/** What is still OPEN, read from the persisted run and review rows and nothing else.
 *  This is the whole of FG-694's selection authority: an observation is current
 *  because the work it names is current, never because it happens to be the newest
 *  row for a pair. */
type CiCurrency = {
  activeRunIds: ReadonlySet<string>;
  openReviewRunIds: ReadonlySet<string>;
  openReviews: readonly ReviewAnchor[];
  /** True when SOMETHING in scope could currently be waiting on required checks.
   *  Distinguishes `no_current_candidate` from `not_observed` — see RequiredCiSection. */
  hasCurrentAnchor: boolean;
};

function reviewColumns(db: DatabaseInstance): ReadonlySet<string> {
  // PRAGMA table_info on a MISSING table returns zero rows rather than throwing
  // (db.ts's shape-probe rule), so this doubles as the table-existence check. It has
  // to: `reviews` is an FG-638 table, and the read-model fixtures that predate it —
  // and any store opened by an older binary — carry runs/tasks/events/launch_
  // observations and no `reviews` at all. A bare prepare() would throw at parse time
  // and take the whole surface down with it.
  return new Set((db.prepare(`PRAGMA table_info(reviews)`).all() as Array<{ name: string }>).map((c) => c.name));
}

function readCiCurrency(db: DatabaseInstance, scope: CurrentActivityScope): CiCurrency {
  const activeRuns = db.prepare(`
    SELECT id, project_dir FROM runs WHERE status = ?
  `).all(ACTIVE_RUN_STATUS) as Array<{ id: string; project_dir: string | null }>;

  const cols = reviewColumns(db);
  // Every column below arrived by ALTER (FG-638/FG-649), so an aged store can carry a
  // `reviews` table without them. Missing any one means this store cannot answer "is a
  // review open here", and the honest reading of that is "no review anchor available"
  // — not a crash, and not an invented anchor.
  const reviewsUsable = ["run_id", "ticket_id", "workspace_dir", "state"].every((c) => cols.has(c));
  const openReviews: ReviewAnchor[] = reviewsUsable
    ? (db.prepare(`
        SELECT run_id, ticket_id, workspace_dir
          FROM reviews
         WHERE state NOT IN (${TERMINAL_REVIEW_STATES.map(() => "?").join(",")})
      `).all(...TERMINAL_REVIEW_STATES) as Array<{ run_id: string | null; ticket_id: string | null; workspace_dir: string | null }>)
      .map((r) => ({ runId: r.run_id, ticketId: r.ticket_id, workspaceDir: r.workspace_dir }))
    : [];

  const activeRunIds = new Set(activeRuns.map((r) => r.id));
  const openReviewRunIds = new Set(openReviews.map((r) => r.runId).filter((id): id is string => id !== null && id !== ""));

  let hasCurrentAnchor: boolean;
  if (scope.runId !== undefined) {
    hasCurrentAnchor = activeRunIds.has(scope.runId) || openReviewRunIds.has(scope.runId);
  } else if (scope.projectDirs !== undefined) {
    hasCurrentAnchor =
      activeRuns.some((r) => inProjectScope(r.project_dir, scope.projectDirs)) ||
      openReviews.some((r) => inProjectScope(r.workspaceDir, scope.projectDirs));
  } else {
    hasCurrentAnchor = activeRuns.length > 0 || openReviews.length > 0;
  }

  return { activeRunIds, openReviewRunIds, openReviews, hasCurrentAnchor };
}

/** Is the work this observation NAMES still open? The observation declares its own
 *  run, project and ticket; this asks the run and review rows about them and answers
 *  from those alone. Nothing is inferred from a sha, a label, or a timestamp. */
function observationIsCurrent(
  runId: string | null,
  projectDir: string | null,
  ticketId: string | null,
  currency: CiCurrency,
): boolean {
  if (runId !== null && runId !== "") {
    // A DECLARED run is the strongest anchor there is, and it is decisive in BOTH
    // directions: if that run is finished and no open review carries it, the
    // observation is history. This single `false` is the FG-694 fix — it is the thing
    // the newest-per-pair rule had no way to say.
    return currency.activeRunIds.has(runId) || currency.openReviewRunIds.has(runId);
  }
  // A standalone review-loop round records no run. The only remaining authority is an
  // OPEN review naming the same ticket, in the same workspace when the review declares
  // one. A review with no recorded workspace (opened before FG-649) cannot narrow by
  // project, so it does not pretend to.
  if (ticketId === null || ticketId === "") return false;
  return currency.openReviews.some(
    (r) => r.ticketId === ticketId && (r.workspaceDir === null || projectDir === null || r.workspaceDir === projectDir),
  );
}

/** The newest CURRENT `review_loop.ci_observed` per (runId, projectDir), and nothing
 *  else. Presenting only the newest IS the BD-6 supersession rule: an observation
 *  bound to a sha the candidate has moved past is not the newest, so it disappears.
 *  Nothing here derives, compares, or "carries forward" a sha.
 *
 *  FG-694 adds the half the pair rule never carried. A pair claims its slot the moment
 *  its newest in-scope row is seen, and if that row is not anchored to open work the
 *  pair contributes NOTHING: the older rows behind it are not promoted in its place,
 *  which would carry a superseded candidate forward under a fresher label — exactly
 *  what AC3 forbids. */
function readNewestCiObservations(
  db: DatabaseInstance,
  scope: CurrentActivityScope,
  nowMs: number,
  currency: CiCurrency,
): RequiredCiObservation[] {
  // Nothing in scope is open, so no event in the table can be current. Skipping the
  // scan is not merely an optimization: it is the statement that the answer does not
  // depend on the event history at all.
  if (!currency.hasCurrentAnchor) return [];

  // The eligible run ids are pushed INTO the query so the 500-row window covers rows
  // that could still be current, rather than being consumed by historical noise from
  // finished runs — the exact shape of the 2026-08-08 report, where ten terminal runs'
  // observations were the ten newest rows for their pairs. Rows with no run id stay in:
  // their anchor is a review, resolved per row below.
  const eligibleRunIds = [...new Set([...currency.activeRunIds, ...currency.openReviewRunIds])]
    .filter((id) => scope.runId === undefined || id === scope.runId);
  const runClause = eligibleRunIds.length === 0
    ? "AND run_id IS NULL"
    : `AND (run_id IS NULL OR run_id IN (${eligibleRunIds.map(() => "?").join(",")}))`;

  const rows = db.prepare(`
    SELECT run_id, payload, created_at
      FROM events
     WHERE event_type = ?
     ${runClause}
     ORDER BY created_at DESC, id DESC
     LIMIT 500
  `).all(CI_OBSERVED_EVENT_TYPE, ...eligibleRunIds) as Array<{ run_id: string | null; payload: string | null; created_at: string }>;

  const newest = new Map<string, RequiredCiObservation>();
  /** Pairs whose newest in-scope row has already been DECIDED — kept separate from
   *  `newest` so a pair rejected as historical stays rejected, instead of falling
   *  through to the next-oldest row for the same pair. */
  const decided = new Set<string>();
  for (const row of rows) {
    let payload: CiPayload;
    try {
      payload = JSON.parse(row.payload ?? "{}") as CiPayload;
    } catch {
      continue;
    }
    const projectDir = typeof payload.projectDir === "string" ? payload.projectDir : null;
    const key = `${row.run_id ?? ""} ${projectDir ?? ""}`;
    if (decided.has(key)) continue; // rows arrive newest-first
    if (typeof payload.candidateSha !== "string" || payload.candidateSha === "") continue;
    if (scope.runId !== undefined && row.run_id !== scope.runId) continue;
    if (!inProjectScope(projectDir, scope.projectDirs)) continue;

    // This row IS the newest in-scope observation for its pair. Whatever is decided
    // about it is decided about the pair.
    decided.add(key);
    const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : null;
    if (!observationIsCurrent(row.run_id, projectDir, ticketId, currency)) continue;

    const observedAt = typeof payload.observedAt === "string" ? payload.observedAt : row.created_at;
    const contexts = parseContexts(payload.contexts);
    const outcome = typeof payload.outcome === "string" ? payload.outcome : "unavailable";
    const observedMs = parseMs(observedAt);
    const stale = !observationIsFresh(observedMs, nowMs, CI_OBSERVATION_FRESH_MS);
    // `pending` is the observer's own word for "checks are still running at this
    // sha". A per-context `pending`/`queued`/`in_progress` says the same thing even
    // when the summary outcome has not caught up.
    const anyPending = outcome === "pending" || contexts.some((c) => /^(pending|queued|in_progress|waiting)$/i.test(c.state));
    const state: RequiredCiObservation["state"] = stale ? "stale" : anyPending ? "running" : "not_running";
    newest.set(key, {
      runId: row.run_id,
      projectDir,
      projectLabel: projectLabelOf(projectDir),
      attemptId: typeof payload.attemptId === "string" ? payload.attemptId : "",
      ticketId,
      candidateSha: payload.candidateSha,
      observedAt,
      outcome,
      unavailableReason: typeof payload.unavailableReason === "string" ? payload.unavailableReason : null,
      contexts,
      state,
      label: stale
        ? `stale — CI last observed ${observedAt}`
        : anyPending
          ? CI_RUNNING_LABEL
          : CI_NOT_RUNNING_LABEL,
    });
  }
  return [...newest.values()];
}

/** The ONE derivation `forge status` and the dashboard both call (BD-9). */
export function deriveCurrentActivity(db: DatabaseInstance, opts: { now?: Date; scope?: CurrentActivityScope } = {}): CurrentActivity {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const scope = opts.scope ?? {};
  const hostWide = scope.runId === undefined && scope.projectDirs === undefined;

  const open = readOpenLaunches(db);

  // PLACEMENT. Explicit submission metadata is the ONLY authority for run-level
  // placement; a cwd-derived project home may place at project level and is labeled
  // `unassociated`; anything else lands in the host-level bucket. The launch NAME,
  // ARGV and LOG TEXT are not consulted anywhere in here — FG-492 records that argv
  // carries conversation text that false-matches unrelated run and ticket ids.
  let hostVerification: HostLaunchActivity[];
  if (scope.runId !== undefined) {
    // The DECLARED run id, not `association_kind`: a row's run id is only ever what
    // the submitter declared (BD-15 — nothing is inferred), while the label names
    // which channel resolved the PROJECT home. A launch whose declared run is
    // registered without a project home takes its project from the cwd and reads
    // `cwd`; it still belongs on the run it named.
    hostVerification = open
      .filter((o) => o.runId === scope.runId)
      .map((o) => toHostLaunch(o, "run", nowMs));
  } else if (scope.projectDirs !== undefined) {
    hostVerification = open
      .filter((o) => inProjectScope(o.projectDir, scope.projectDirs))
      .map((o) => toHostLaunch(o, "project", nowMs));
  } else {
    // Host-wide. A launch belongs in the main section if ANYTHING places it: an
    // explicit submission association, or a registered project home. The
    // "Unassociated activity" bucket below is for launches where NEITHER holds —
    // it is the honest last tier, not a dumping ground for a launch that named its
    // run but happened to run in a per-task worktree (the ticket's own 2026-08-04
    // case, which lands ON ITS RUN once `--run` is supplied).
    hostVerification = open
      .filter((o) => o.projectDir !== null || hasPlacementAuthority(o))
      .map((o) => toHostLaunch(o, o.runId !== null ? "run" : o.projectDir !== null ? "project" : "host", nowMs));
  }

  const unassociated = hostWide
    ? open
      .filter((o) => o.projectDir === null && !hasPlacementAuthority(o))
      .map((o) => toHostLaunch(o, "host", nowMs))
    : [];

  // FG-694: what is OPEN is read once, and it decides two different things — which
  // observations are current, and which of the three CI absences is the true one.
  const currency = readCiCurrency(db, scope);
  const observations = readNewestCiObservations(db, scope, nowMs, currency);
  // The three-way choice the trap in FG-694 is about. `not_observed` is only ever
  // reachable when there IS current work owed an observation; with nothing open,
  // "we observed no CI" would be a claim about an observer that was never asked.
  const ciState: RequiredCiSection["state"] =
    observations.length > 0 ? "observed" : currency.hasCurrentAnchor ? "not_observed" : "no_current_candidate";

  return {
    generatedAt: now.toISOString(),
    scope: {
      runId: scope.runId ?? null,
      projectDirs: scope.projectDirs === undefined ? null : [...scope.projectDirs],
    },
    agents: readAgents(db, scope),
    hostVerification,
    requiredCi: {
      state: ciState,
      label: ciState === "observed"
        ? `${observations.length} observed`
        : ciState === "not_observed"
          ? CI_NOT_OBSERVED_LABEL
          : CI_NO_CANDIDATE_LABEL,
      observations,
    },
    unassociated,
  };
}

/** The human rendering `forge status` prints, and the exact text the dashboard's
 *  three sections carry. Exported so the agreement test can assert one string
 *  against the other rather than two independently-written renderers. */
export function renderCurrentActivityLines(activity: CurrentActivity): string[] {
  const lines: string[] = ["Current activity"];

  lines.push("  Agents");
  if (activity.agents.length === 0) lines.push("    (no agent task in flight)");
  for (const a of activity.agents) {
    lines.push(`    ${a.status.replace(/_/g, " ")}  ${a.agentRole}  ${a.phase} · ${a.taskId}  — ${a.runTitle}`);
  }

  lines.push("  Host verification");
  if (activity.hostVerification.length === 0) lines.push("    (no host launch observed in flight)");
  for (const l of activity.hostVerification) {
    lines.push(`    ${l.statusLabel}  ${l.launchId}${l.unassociated ? "  [unassociated]" : ""}  — ${l.commandLine}`);
  }

  lines.push("  Required CI");
  if (activity.requiredCi.state === "no_current_candidate") {
    // Parenthesised like the other two empty-section lines, and deliberately NOT
    // `CI not observed`: nothing was waiting on required checks, so there was no
    // observation to miss. The heading stays — `forge status` is the diagnostic
    // surface, where the three sections are a fixed shape an operator reads down
    // (FG-694 narrows HOME; it does not delete evidence structure here).
    lines.push(`    (${CI_NO_CANDIDATE_LABEL})`);
  } else if (activity.requiredCi.state === "not_observed") {
    lines.push(`    ${CI_NOT_OBSERVED_LABEL}`);
  } else {
    for (const ci of activity.requiredCi.observations) {
      lines.push(`    ${ci.label}  candidate ${ci.candidateSha}${ci.ticketId ? `  ${ci.ticketId}` : ""}`);
      if (ci.contexts.length === 0) lines.push(`      (no required context enumerated)`);
      for (const c of ci.contexts) {
        lines.push(`      ${c.context}: ${c.state}  ${c.url ?? "(no url)"}  observed ${c.observedAt}`);
      }
      if (ci.unavailableReason) lines.push(`      unavailable: ${ci.unavailableReason}`);
    }
  }

  if (activity.unassociated.length > 0) {
    lines.push("  Unassociated activity");
    for (const l of activity.unassociated) {
      lines.push(`    ${l.statusLabel}  ${l.launchId}  — ${l.commandLine}`);
    }
  }
  return lines;
}
