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
// WHAT MAKES A LAUNCH HOST VERIFICATION (FG-700). Its DECLARED PURPOSE, recorded on
// the observation at submission, and NOTHING ELSE. `hostVerification` admits only
// `purpose === 'host_verification'`; every other open launch in scope — agent invoke,
// review, campaign, dashboard, generic, and every legacy row whose purpose is NULL —
// lands in `launches`, the generic launch-diagnostics bucket, and is still rendered in
// full there. Placement (run / project / host, and the `unassociated` label) is decided
// by the association ids exactly as before and is NOT consulted for the label; purpose
// is not consulted for placement. Until FG-700 this section had no purpose to consult
// and used PLACEMENT as a proxy for it, so `forge invoke engineer`, `forge invoke
// test-engineer`, `forge invoke documentation-maintainer` and `forge review start` all
// rendered as `Host verification` on 2026-08-10 merely by carrying `--run`/`--ticket`.
// An unrecognized or absent purpose is `generic`, never host verification: the fallback
// is always to the WEAKER claim.
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
//     Nor one whose only anchor is a review of a CLOSED ticket: closure never drives
//     the review row terminal, so eight unfinished rows for shipped tickets were still
//     presenting their CI as current after the first fix landed.
//   - It never consults a launch name, argv, log text, or the quarantined
//     `forgeIds`. Placement is authorized by the persisted association alone — the
//     DECLARED submission ids and `project_dir` (BD-2/BD-15).
//   - It never renders the launch status itself: `statusLine` (src/v2/launch.ts) is
//     the ONE human rendering, so the four BD-4 facts stay four facts here too.

import { basename } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { compareIdentity, identify, provenPhysical } from "../util/path-identity.js";
import { isLaunchId, statusLine, type LaunchStatus } from "./launch.js";
import {
  HOST_VERIFICATION_PURPOSE,
  hasPlacementAuthority,
  launchObservationColumns,
  rowToLaunchObservation,
  type LaunchAssociationKind,
  type LaunchObservation,
  type LaunchObservationRow,
  type LaunchPurpose,
} from "../store/launch-observations.js";
import { isTerminalReviewState } from "../store/reviews.js";

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

/** FG-694: the THIRD absence, and the one the pre-fix surface could not say. Nothing
 *  in scope is still open — no anchored run, no open review — so there is nothing that
 *  could be waiting on required checks, which is a different fact from "we have a current
 *  candidate and have observed no CI for it" (`CI not observed`). Collapsing the two
 *  is the same class of error as the stale-row defect, pointed the other way: one
 *  invents currency, the other invents an observation. */
export const CI_NO_CANDIDATE_LABEL = "no current CI candidate";

/** A run row that is not `active` is finished, by any of the three names the
 *  vocabulary gives it (`complete`, `failed`, `abandoned`). Selected POSITIVELY, so
 *  a status this binary does not know reads as "not current" rather than leaking
 *  through a NOT-IN list that predates it. */
const ACTIVE_RUN_STATUS = "active";

/** The one ticket status that means the work is OVER. The `tickets` CHECK vocabulary
 *  is exactly active/done/deferred, and only `done` is closure: a deferred ticket is
 *  work nobody is doing right now, which is not the same as work that shipped, and
 *  reading it as closure would retire a review an operator may still be driving. */
const CLOSED_TICKET_STATUS = "done";

/** Review terminality is NOT enumerated here. It is a property of the review state
 *  vocabulary, so it is decided at the one place that vocabulary is defined
 *  (`REVIEW_STATE_TERMINALITY` in src/store/reviews.ts), exhaustively and under the
 *  compiler. FG-694/RF-1: this module used to carry its own `["settled", "failed"]`,
 *  which is an allowlist of two names pretending to be an open-ended terminal set —
 *  a twelfth state would have been added over there and silently read as an OPEN
 *  anchor here. Every review row is now classified through `isTerminalReviewState`,
 *  which still reads a state it does not recognize as OPEN (surfacing live work
 *  rather than hiding it) — but a state that EXISTS can no longer go unclassified. */

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
  /** FG-700: what the SUBMITTER declared this launch IS, carried on every launch row
   *  of every section so a reader can see the classification rather than infer it back
   *  out of which array the row arrived in. `generic` for an undeclared or
   *  unrecognized purpose — never upgraded to a more specific kind. */
  purpose: LaunchPurpose;
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
   *  `no_current_candidate` — nothing in scope could be waiting on required checks: no
   *    work reference is still open (`hasCurrentCandidate`), no open review. The
   *    consumer omits the CI row entirely; it must NOT report that CI was not observed,
   *    because nothing was owed an observation (FG-694).
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
  /** ONLY launches whose DECLARED purpose is host verification (FG-700). */
  hostVerification: HostLaunchActivity[];
  /** FG-700: every OTHER open launch in scope — agent invoke, review, campaign,
   *  dashboard, generic, and every legacy row with no declared purpose. Disjoint from
   *  `hostVerification` by construction: a launch is in exactly one of the two. This is
   *  the generic launch-diagnostics bucket, and it exists so that narrowing the
   *  host-verification LABEL does not delete the launch DIAGNOSTICS — a launch that is
   *  not host verification still renders, under a heading that does not claim it is. */
  launches: HostLaunchActivity[];
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

// ─── FG-693: project scope is FILESYSTEM IDENTITY, never the bytes ──────────────
//
// This derivation used to scope by raw strings on both halves — `projectDirs.includes
// (projectDir)` in process and `r.project_dir IN (...)` in SQL. One checkout has many
// names (a symlinked parent, a system directory exposed under two prefixes, a relative
// spelling, a trailing separator), so a run created under one spelling was invisible to
// a query naming another. This is the ONE derivation `forge status` and the dashboard
// both call, so that hid live work on BOTH surfaces at once.
//
// Everything below goes through the ONE contract (src/util/path-identity.ts). The
// SCOPE is resolved ONCE per derivation and a recorded spelling is resolved at most
// once per DISTINCT value — never once per row, and never at all for a row that
// carries its proven identity in `project_dir_canonical`. This path serves every
// dashboard poll, so the syscall count is part of its contract.
//
// No outbound call is added: `realpath` is a filesystem read, which this module has
// always been allowed (BD-7/BD-12 forbid tmux/git/gh/shell/CLI), and it is the one
// call the contract itself makes.

/** One row's project identity as the two columns record it: the caller's bytes, and
 *  the PROVEN identity beside them (null when nothing proved one). */
type RowProjectIdentity = { projectDir: string | null; canonical: string | null };

/** Nothing recorded at all — neither bytes nor a proven identity. */
const EMPTY_ROW_IDENTITY: RowProjectIdentity = { projectDir: null, canonical: null };

/** The operator's scope spellings, RESOLVED ONCE per derivation. Two sets, because a
 *  PROVEN physical path and an unresolvable SPELLING are different kinds of thing and
 *  deduplicating them in one namespace is the conflation the contract exists to stop. */
type ResolvedProjectScope = {
  /** Proven physical paths, deduplicated — two spellings of one checkout probe once. */
  physicals: ReadonlySet<string>;
  /** Spellings the filesystem would not confirm. Matched by recorded BYTES only: for
   *  an unproven target, byte equality is the only relation left that claims nothing. */
  unresolved: ReadonlySet<string>;
  /** One resolution per DISTINCT recorded spelling, for this derivation only. */
  spellings: Map<string, string | null>;
};

function resolveProjectScope(projectDirs: readonly string[] | undefined): ResolvedProjectScope | undefined {
  if (projectDirs === undefined) return undefined;
  const physicals = new Set<string>();
  const unresolved = new Set<string>();
  for (const spelling of projectDirs) {
    const identity = identify(spelling);
    if (identity.kind === "resolved") physicals.add(identity.physical);
    else unresolved.add(spelling);
  }
  return { physicals, unresolved, spellings: new Map() };
}

function recordedPhysical(scope: ResolvedProjectScope, spelling: string): string | null {
  const memo = scope.spellings.get(spelling);
  if (memo !== undefined) return memo;
  const physical = provenPhysical(spelling);
  scope.spellings.set(spelling, physical);
  return physical;
}

/** Is this row in the operator's scope? The ACTING projection: scoping decides what an
 *  operator is shown as THEIR work, so an indeterminate comparison excludes the row
 *  rather than claiming it on a guess. A row that carries a proven canonical identity
 *  is decided by set membership alone — no filesystem call. */
function inProjectScope(row: RowProjectIdentity, scope: ResolvedProjectScope | undefined): boolean {
  if (scope === undefined) return true;
  const spelling = row.projectDir ?? "";
  if (row.canonical !== null && row.canonical !== "") {
    if (scope.physicals.has(row.canonical)) return true;
  } else if (spelling !== "" && scope.physicals.size > 0) {
    const physical = recordedPhysical(scope, spelling);
    if (physical !== null && scope.physicals.has(physical)) return true;
  }
  return spelling !== "" && scope.unresolved.has(spelling);
}

/** Could a row of this project still be in scope? The GUARD projection of the same
 *  question, used ONLY to decide which runs the bounded event window may be spent on
 *  — a budget rule, not a currency answer, so a run whose identity cannot be decided
 *  KEEPS its slot. A run is dropped only where the comparison is genuinely decided
 *  against it: its identity is proven and is not one of the targets, or the targets
 *  are all unproven and byte equality (their only possible relation) already failed. */
function scopeCouldInclude(row: RowProjectIdentity, scope: ResolvedProjectScope | undefined): boolean {
  if (scope === undefined) return true;
  if (inProjectScope(row, scope)) return true;
  if (scope.physicals.size === 0) return false;
  if (row.canonical !== null && row.canonical !== "") return false;
  const spelling = row.projectDir ?? "";
  if (spelling === "") return true;
  return recordedPhysical(scope, spelling) === null;
}

/** Does the store in front of THIS reader carry FG-693's canonical column? The
 *  dashboard opens its own read-only handle and runs no migrations, so it can be
 *  pointed at a store no writer has touched since the upgrade; naming a column that
 *  store lacks would throw and take the whole surface down. PRAGMA table_info on a
 *  missing table returns zero rows rather than throwing (db.ts's shape-probe rule).
 *
 *  Asked per read rather than cached: a PRAGMA is a schema lookup, and a peer forge
 *  that migrates the store in place must not leave a long-running dashboard reading
 *  the pre-migration shape forever. */
function hasCanonicalColumn(db: DatabaseInstance, table: "runs"): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === "project_dir_canonical");
}

function readAgents(
  db: DatabaseInstance,
  scope: CurrentActivityScope,
  project: ResolvedProjectScope | undefined,
): ActivityAgentTask[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (scope.runId !== undefined) {
    clauses.push("AND t.run_id = ?");
    params.push(scope.runId);
  }
  // FG-693: the project narrowing is deliberately NOT in this statement any more.
  // `r.project_dir IN (...)` compared the operator's BYTES against the recorded bytes,
  // which is the defect. The rows this query returns are the IN-FLIGHT ones — a
  // handful — so deciding identity over them in process costs at most one realpath per
  // distinct recorded spelling and none at all for a row with a proven canonical.
  const canonical = hasCanonicalColumn(db, "runs") ? ", r.project_dir_canonical" : "";
  const rows = db.prepare(`
    SELECT t.id, t.run_id, t.phase, t.agent_role, t.agent_model, t.status, t.started_at,
           r.title, r.workflow, r.project_dir${canonical}
      FROM tasks t
      JOIN runs r ON r.id = t.run_id
     WHERE t.status IN ('running', 'awaiting_gate', 'awaiting_red', 'blocked_by_red', 'awaiting_recovery')
       AND r.status = 'active'
       ${clauses.join("\n       ")}
     ORDER BY t.started_at DESC, t.created_at DESC
  `).all(...params) as Array<{
    id: string; run_id: string; phase: string; agent_role: string; agent_model: string | null;
    status: string; started_at: string | null; title: string; workflow: string; project_dir: string | null;
    project_dir_canonical?: string | null;
  }>;
  return rows.filter((r) =>
    inProjectScope({ projectDir: r.project_dir, canonical: r.project_dir_canonical ?? null }, project),
  ).map((r) => ({
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
    purpose: obs.purpose,
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
  // The column list is resolved against THIS store: the dashboard's read-only handle
  // runs no migrations, so `purpose` may not exist there yet. A row read without it
  // decodes to `generic` — which keeps it out of the host-verification section, the
  // fail-closed direction.
  const rows = db.prepare(`
    SELECT ${launchObservationColumns(db)}
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

/** The WORK a row names: the run it declares, the project home it declares, and the
 *  ticket it declares. Every currency question in this module is asked about one of
 *  these, through ONE predicate (`workIsCurrent`), with the reference the row itself
 *  DECLARED — never with a shape-specific subset of it.
 *
 *  FG-694/RF-2: the anchor rule and the observation filter used to call the same
 *  matcher with DIFFERENT inputs — the anchor passed a run id and dropped the ticket —
 *  so they agreed for every review STATE and still disagreed for a review SHAPE. A
 *  settled ticket-only review retired the observation and left the run's anchor
 *  standing, which is `CI not observed` for finished work. Passing one reference makes
 *  the divergence unrepresentable rather than untested. */
type WorkRef = { runId: string | null; projectDir: string | null; ticketId: string | null };

/** What is still OPEN, read from the persisted run and review rows and nothing else.
 *  This is the whole of FG-694's selection authority: an observation is current
 *  because the work it names is current, never because it happens to be the newest
 *  row for a pair. */
type CiCurrency = {
  activeRuns: readonly { id: string; identity: RowProjectIdentity }[];
  activeRunIds: ReadonlySet<string>;
  openReviews: readonly ReviewAnchor[];
  /** Reviews that are OVER, carried for the same reason the open ones are. AC2 names
   *  a terminal run OR a terminal review, and those are not the same fact: a run stays
   *  `active` through its docs and close-out phases, so "this run is active" cannot
   *  answer "is the review of this work over" (FG-694/RF-4). */
  terminalReviews: readonly ReviewAnchor[];
  /** Which runs the 500-row event window may be spent on: `runCouldHoldCurrentWork`
   *  over every run an active row or an open review names. Deliberately a SUPERSET of
   *  the runs that turn out to have a current observation — it is a budget rule, not a
   *  currency answer, and a run it keeps is still decided row by row by the one
   *  predicate. Excluding a run it should have kept is the only way this can be wrong,
   *  which is why the ticket it does not know is quantified rather than assumed away. */
  windowRunIds: ReadonlySet<string>;
  /** Each ACTIVE run's project identity, for the same budget rule. A run this map does
   *  not carry (an open review's run whose row has closed) is undecided, and the rule
   *  keeps it. */
  runIdentities: ReadonlyMap<string, RowProjectIdentity>;
};

/** What one pass over the event window produced: the CURRENT observations, and which
 *  runs the store DECLARED CI work for in this scope. Both come out of the one pass on
 *  purpose — the second is what the candidate question is answered with, so it cannot
 *  be computed from a different rule than the observations were. */
type CiObservationRead = {
  observations: RequiredCiObservation[];
  declaredRunIds: ReadonlySet<string>;
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

/** Ticket ids this host records as CLOSED, and nothing else.
 *
 *  FG-694 (post-ship correction): a review row is not driven to `settled` by ticket
 *  closure — an operator closes the ticket and the row stays `verifying` forever. Those
 *  rows are the anchors the live reproduction found: eight historical CI candidates,
 *  each held current by an unfinished review of a ticket that shipped weeks ago. So
 *  closure retires the review, the way a terminal review state does.
 *
 *  Matched on the ticket id ALONE, across every project row that carries it, and
 *  deliberately in the CONSERVATIVE direction: the id is closed only when EVERY row for
 *  it says `done`. `tickets` is keyed by (project_key, ticket_id) and this module cannot
 *  resolve a project_key from a workspace path without shelling `git`, which it may not
 *  do (BD-7/BD-18). One row still active is therefore read as open — a collision between
 *  two projects' `FG-1` surfaces live work rather than hiding it, which is the direction
 *  every FG-694 rule leans. */
function readClosedTicketIds(db: DatabaseInstance): ReadonlySet<string> {
  // PRAGMA on a missing table returns zero rows rather than throwing (db.ts's
  // shape-probe rule), so this doubles as the table-existence check: `tickets` is an
  // FG-606 table and the read-model fixtures that predate it carry no such table.
  const cols = new Set((db.prepare(`PRAGMA table_info(tickets)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("ticket_id") || !cols.has("status")) return new Set();
  const rows = db.prepare(`
    SELECT ticket_id
      FROM tickets
     GROUP BY ticket_id
    HAVING SUM(CASE WHEN status = ? THEN 0 ELSE 1 END) = 0
  `).all(CLOSED_TICKET_STATUS) as Array<{ ticket_id: string | null }>;
  return new Set(rows.map((r) => r.ticket_id).filter((id): id is string => id !== null && id !== ""));
}

function readCiCurrency(db: DatabaseInstance): CiCurrency {
  // FG-693: the run's proven identity is read alongside its as-written spelling, so a
  // scope decision here is the same decision every other seam makes. Selected
  // conditionally for the unmigrated-store reason hasCanonicalColumn states.
  const canonical = hasCanonicalColumn(db, "runs") ? ", project_dir_canonical" : "";
  const activeRuns = db.prepare(`
    SELECT id, project_dir${canonical} FROM runs WHERE status = ?
  `).all(ACTIVE_RUN_STATUS) as Array<{ id: string; project_dir: string | null; project_dir_canonical?: string | null }>;

  const cols = reviewColumns(db);
  // Every column below arrived by ALTER (FG-638/FG-649), so an aged store can carry a
  // `reviews` table without them. Missing any one means this store cannot answer "is a
  // review open here", and the honest reading of that is "no review anchor available"
  // — not a crash, and not an invented anchor.
  const reviewsUsable = ["run_id", "ticket_id", "workspace_dir", "state"].every((c) => cols.has(c));
  // Every review row, open and terminal alike, classified in ONE place by
  // terminality. The state is no longer a WHERE clause: a query that filtered by two
  // names could only ever answer "not one of these two", which is what RF-1 is about.
  const reviewRows = reviewsUsable
    ? (db.prepare(`
        SELECT run_id, ticket_id, workspace_dir, state FROM reviews
      `).all() as Array<{ run_id: string | null; ticket_id: string | null; workspace_dir: string | null; state: string | null }>)
    : [];
  const closedTickets = readClosedTicketIds(db);
  const openReviews: ReviewAnchor[] = [];
  const terminalReviews: ReviewAnchor[] = [];
  for (const r of reviewRows) {
    const anchor: ReviewAnchor = { runId: r.run_id, ticketId: r.ticket_id, workspaceDir: r.workspace_dir };
    // TWO ways a review stops anchoring current work, and neither implies the other. A
    // terminal STATE is the review saying it is over. A closed TICKET is the operator
    // saying the work is over — and the review row is never driven to a terminal state
    // by that, so an unfinished row for a shipped ticket kept its CI observation current
    // indefinitely. Closure is the second answer, not a substitute for the first.
    const over = isTerminalReviewState(r.state ?? "")
      || (r.ticket_id !== null && r.ticket_id !== "" && closedTickets.has(r.ticket_id));
    (over ? terminalReviews : openReviews).push(anchor);
  }

  const activeRunIds = new Set(activeRuns.map((r) => r.id));
  const openReviewRunIds = new Set(
    openReviews.map((r) => r.runId).filter((id): id is string => id !== null && id !== ""),
  );
  const work = { activeRunIds, openReviews, terminalReviews };
  // Every run any row NAMES as possibly-live. An open review's run is included even
  // when its run row has closed — the work is still being reviewed.
  const windowRunIds = new Set(
    [...activeRunIds, ...openReviewRunIds].filter((id) => runCouldHoldCurrentWork(id, work)),
  );

  const identified = activeRuns.map((r) => ({
    id: r.id,
    identity: { projectDir: r.project_dir, canonical: r.project_dir_canonical ?? null },
  }));
  return {
    activeRuns: identified,
    ...work,
    windowRunIds,
    runIdentities: new Map(identified.map((r) => [r.id, r.identity])),
  };
}

/** Does this review anchor NAME this work?
 *
 *  A review that recorded a RUN speaks for that run and no other. A review that
 *  recorded none — a standalone review-loop round — speaks for its ticket, in its
 *  workspace when it declared one. That distinction is load-bearing in both
 *  directions: it is what lets a settled review retire the observation of the run it
 *  reviewed (RF-4), and what stops the previous attempt's settled review retiring the
 *  LIVE attempt of a ticket that was re-run under a new run id. */
function reviewNamesWork(anchor: ReviewAnchor, work: WorkRef): boolean {
  const anchorRun = reviewRunOf(anchor);
  if (anchorRun !== null) return anchorRun === (work.runId === "" ? null : work.runId);
  if (work.ticketId === null || work.ticketId === "") return false;
  return anchor.ticketId === work.ticketId && namesSameWorkspace(anchor.workspaceDir, work.projectDir);
}

/** FG-693: the workspace half of the anchor rule, by IDENTITY rather than by bytes.
 *
 *  `reviews.workspace_dir` and the observation payload's `projectDir` are written by
 *  two different code paths, so one checkout reaches them under two spellings as a
 *  matter of course — and `anchor.workspaceDir === work.projectDir` then said the
 *  review does not speak for its own work, which hides a LIVE CI observation from
 *  both surfaces. Neither side records a proven identity beside its bytes, so this is
 *  the same rule `inProjectScope` applies to a legacy row: PROVEN sameness, or — for
 *  a pair the filesystem will not confirm — the recorded bytes, which is the only
 *  relation an unproven spelling can have. A null on either side still names the work,
 *  unchanged: a review that recorded no workspace speaks for its ticket anywhere. */
function namesSameWorkspace(workspaceDir: string | null, projectDir: string | null): boolean {
  if (workspaceDir === null || projectDir === null) return true;
  const comparison = compareIdentity(workspaceDir, projectDir);
  return comparison === "same" || (comparison === "indeterminate" && workspaceDir === projectDir);
}

function reviewRunOf(anchor: ReviewAnchor): string | null {
  return anchor.runId === null || anchor.runId === "" ? null : anchor.runId;
}

/** Is the work this reference NAMES still open? The ONE currency predicate: an
 *  observation asks it about the run, project and ticket it declared, and a run asks it
 *  about the work the store declares for that run. It reads the run and review rows and
 *  answers from those alone — nothing is inferred from a sha, a label, or a timestamp. */
function workIsCurrent(work: WorkRef, currency: Omit<CiCurrency, "activeRuns" | "windowRunIds" | "runIdentities">): boolean {
  const named = (r: ReviewAnchor): boolean => reviewNamesWork(r, work);

  // The REVIEW answers first, and it answers in both directions. An open review naming
  // this work keeps it current even after its run row closes; a review that is OVER
  // retires it even while its run row is still `active` — the run has other phases
  // after the review, and AC2 names a terminal run OR a terminal review (FG-694/RF-4).
  if (currency.openReviews.some(named)) return true;
  if (currency.terminalReviews.some(named)) return false;

  // No review names this work at all — CI observed before a review was opened. A
  // DECLARED run is then the only anchor there is, and it is decisive both ways: a
  // finished run makes its newest observation history, which is the thing the
  // newest-per-pair rule had no way to say.
  if (work.runId !== null && work.runId !== "") return currency.activeRunIds.has(work.runId);
  // A standalone review-loop round records no run, so with no review naming its
  // ticket there is nothing left to anchor it.
  return false;
}

/** Could this review name SOME work of this run, for a ticket the RUN ROW does not
 *  declare? A review that recorded this run names all of its work whatever the ticket;
 *  a ticket-only review names the work that declares its ticket, and whether any of
 *  this run's work does is a question only a DECLARATION can answer — so it is left
 *  open here rather than answered `no` by omission, which is the FG-694/RF-2 defect. */
function reviewCouldNameRun(anchor: ReviewAnchor, runId: string): boolean {
  const anchorRun = reviewRunOf(anchor);
  if (anchorRun !== null) return anchorRun === runId;
  return anchor.ticketId !== null && anchor.ticketId !== "";
}

/** `workIsCurrent` for a run whose ticket is UNKNOWN — the run row declares none — with
 *  that ticket existentially quantified: could ANY work of this run still be open?
 *  Answered in the same order by the same rules, so it can only ever be weaker than the
 *  filter, never in conflict with it.
 *
 *  Used for two things and nothing else: which runs the event window may be spent on,
 *  and whether a run for which the store declares NO CI work is a current candidate.
 *  Once the store DOES declare that work — an observation carries the run, project and
 *  ticket together — the declaration is what gets asked, through `workIsCurrent`. */
function runCouldHoldCurrentWork(runId: string, currency: Omit<CiCurrency, "activeRuns" | "windowRunIds" | "runIdentities">): boolean {
  if (currency.openReviews.some((r) => reviewCouldNameRun(r, runId))) return true;
  // A terminal review that recorded this run names EVERY ticket of it, so it retires
  // the run outright. A terminal TICKET-ONLY review retires only the work declaring its
  // ticket, which no run row declares — that is decided per observation, not here.
  if (currency.terminalReviews.some((r) => reviewRunOf(r) === runId)) return false;
  return currency.activeRunIds.has(runId);
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
  project: ResolvedProjectScope | undefined,
  nowMs: number,
  currency: CiCurrency,
): CiObservationRead {
  // Nothing anywhere is open — no active run, no open review — so no event in the table
  // can be current under any reference. Skipping the scan is not merely an optimization:
  // it is the statement that the answer does not depend on the event history at all.
  if (currency.activeRunIds.size === 0 && currency.openReviews.length === 0) {
    return { observations: [], declaredRunIds: new Set() };
  }

  // EVERY narrowing the caller asked for is pushed INTO the query, because the 500-row
  // window is applied by SQLite and anything filtered afterwards has already spent it.
  // That is one defect with two faces: historical noise from finished runs evicting the
  // live candidate (the 2026-08-08 report), and — the same eviction pointed at a
  // narrower read — 500 newer rows from OTHER projects evicting the requested project's
  // current observation, so Home renders no CI row for work that IS waiting on checks
  // (RF-2). A missing current candidate reads as observed absence, which is exactly what
  // this surface may not do.
  //
  // The JS checks below are NOT removed: the payload parsed there stays the authority
  // for what a row says, and these clauses only decide which rows the window spends
  // itself on.
  // `windowRunIds` already excludes a run a terminal review RECORDED — it can produce no
  // current observation (`workIsCurrent` rejects every row declaring that run), so it may
  // not hold a slot. A run no review recorded is kept whatever the ticket-only reviews
  // say, because the ticket that would decide it lives in the rows this query returns.
  // FG-693: the project narrowing is expressed over the RUNS the window may be spent
  // on, never over the project bytes recorded in the payload. `json_extract(payload,
  // '$.projectDir') IN (<the operator's spellings>)` is raw string equality on a path,
  // so an observation recorded under another spelling of the operator's own checkout
  // was dropped BEFORE the identity check below could ever see it — the RF-2 narrowing
  // and the FG-693 defect in one clause. A run is dropped from the window only where
  // its identity is DECIDED against the scope (scopeCouldInclude, the guard
  // projection); the authoritative per-row decision stays in process, on identity.
  const eligibleRunIds = [...currency.windowRunIds]
    .filter((id) => scope.runId === undefined || id === scope.runId)
    .filter((id) => scopeCouldInclude(currency.runIdentities.get(id) ?? EMPTY_ROW_IDENTITY, project));

  // EVERY narrowing here is at PAIR granularity — a function of (run_id, payload
  // projectDir) and nothing else — because a pair is DECIDED by its newest in-scope
  // row and then closed. A clause that dropped SOME rows of a pair would promote the
  // next-oldest row into a slot the newest one had already closed, which carries a
  // superseded candidate forward under a fresher label (the AC3 defect). Narrowing by
  // run id is pair-granular; narrowing by ticket id is NOT, which is why there is no
  // ticket clause here even though a run-less row needs a ticket-only review to be
  // current at all.
  //
  // Rows that declare no run therefore stay in the window whatever the project scope,
  // and identity decides them below. That is the honest trade: their pair key is the
  // payload's project BYTES, so the only pair-granular clause available for them is
  // the byte equality FG-693 exists to delete.
  const clauses: string[] = [];
  const params: string[] = [];
  if (scope.runId !== undefined) {
    // A run-scoped read wants that run's rows and nothing else — not the no-run rows a
    // host-wide read has to consider, which were dropped AFTER the limit before.
    if (eligibleRunIds.length === 0) return { observations: [], declaredRunIds: new Set() };
    clauses.push("AND run_id = ?");
    params.push(scope.runId);
  } else if (eligibleRunIds.length === 0) {
    // Rows with no run id stay in: their anchor is a review, resolved per row below.
    clauses.push("AND run_id IS NULL");
  } else {
    clauses.push(`AND (run_id IS NULL OR run_id IN (${eligibleRunIds.map(() => "?").join(",")}))`);
    params.push(...eligibleRunIds);
  }

  const rows = db.prepare(`
    SELECT run_id, payload, created_at
      FROM events
     WHERE event_type = ?
     ${clauses.join("\n     ")}
     ORDER BY created_at DESC, id DESC
     LIMIT 500
  `).all(CI_OBSERVED_EVENT_TYPE, ...params) as Array<{ run_id: string | null; payload: string | null; created_at: string }>;

  const newest = new Map<string, RequiredCiObservation>();
  /** Pairs whose newest in-scope row has already been DECIDED — kept separate from
   *  `newest` so a pair rejected as historical stays rejected, instead of falling
   *  through to the next-oldest row for the same pair. */
  const decided = new Set<string>();
  /** The runs whose CI work the store DECLARED in this scope — every run named by a row
   *  that reached the decision below, current or not. What makes the anchor and the
   *  filter one answer: a run that declared work has been answered BY that work, so it
   *  never falls back to the ticketless run-level question that cannot see a ticket-only
   *  review (FG-694/RF-1, RF-2). */
  const declaredRunIds = new Set<string>();
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
    // The payload declares the project home; nothing beside it records a proven
    // identity, so this is the legacy-shaped arm of the same one rule.
    if (!inProjectScope({ projectDir, canonical: null }, project)) continue;

    // This row IS the newest in-scope observation for its pair. Whatever is decided
    // about it is decided about the pair.
    decided.add(key);
    if (row.run_id !== null && row.run_id !== "") declaredRunIds.add(row.run_id);
    const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : null;
    if (!workIsCurrent({ runId: row.run_id, projectDir, ticketId }, currency)) continue;

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
  return { observations: [...newest.values()], declaredRunIds };
}

/** Is SOMETHING in scope still open and therefore owed a required-check observation?
 *  This is the `not_observed` / `no_current_candidate` decision, and it is answered by
 *  the SAME predicate the observations went through, over the SAME references:
 *
 *    - a surviving observation IS a current reference, so it settles the question;
 *    - a run whose CI work the store declared has just had every one of those
 *      declarations decided, and none survived — the run is not a candidate, whatever
 *      shape of review retired it (FG-694/RF-1, RF-2);
 *    - a run the store declares NO CI work for has an unknown ticket, so the run-level
 *      question is asked with that ticket quantified rather than assumed absent;
 *    - an open review is current work by definition, even after its run row closes. */
function hasCurrentCandidate(
  scope: CurrentActivityScope,
  project: ResolvedProjectScope | undefined,
  currency: CiCurrency,
  read: CiObservationRead,
): boolean {
  if (read.observations.length > 0) return true;
  const candidate = (id: string): boolean => !read.declaredRunIds.has(id) && runCouldHoldCurrentWork(id, currency);
  if (scope.runId !== undefined) return candidate(scope.runId);
  if (scope.projectDirs !== undefined) {
    // FG-693: a review row records only its workspace SPELLING (`reviews` carries no
    // canonical column), so it takes the legacy-shaped arm of the one rule.
    return currency.activeRuns.some((r) => inProjectScope(r.identity, project) && candidate(r.id))
      || currency.openReviews.some((r) => inProjectScope({ projectDir: r.workspaceDir, canonical: null }, project));
  }
  return currency.activeRuns.some((r) => candidate(r.id)) || currency.openReviews.length > 0;
}

/** The ONE derivation `forge status` and the dashboard both call (BD-9). */
export function deriveCurrentActivity(db: DatabaseInstance, opts: { now?: Date; scope?: CurrentActivityScope } = {}): CurrentActivity {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const scope = opts.scope ?? {};
  const hostWide = scope.runId === undefined && scope.projectDirs === undefined;
  // FG-693: ONE resolution of the operator's scope for the whole derivation. Resolving
  // it inside the row predicates would realpath the same spellings once per row, on a
  // path that serves every dashboard poll.
  const project = resolveProjectScope(scope.projectDirs);

  const open = readOpenLaunches(db);

  // PLACEMENT. Explicit submission metadata is the ONLY authority for run-level
  // placement; a cwd-derived project home may place at project level and is labeled
  // `unassociated`; anything else lands in the host-level bucket. The launch NAME,
  // ARGV and LOG TEXT are not consulted anywhere in here — FG-492 records that argv
  // carries conversation text that false-matches unrelated run and ticket ids.
  //
  // Placement decides WHICH SCOPE a launch is in. It does NOT decide what the launch
  // is: that is the purpose split below, applied to whatever placement selected. The
  // two questions are answered by two fields and neither is re-derived from the other.
  let placed: HostLaunchActivity[];
  if (scope.runId !== undefined) {
    // The DECLARED run id, not `association_kind`: a row's run id is only ever what
    // the submitter declared (BD-15 — nothing is inferred), while the label names
    // which channel resolved the PROJECT home. A launch whose declared run is
    // registered without a project home takes its project from the cwd and reads
    // `cwd`; it still belongs on the run it named.
    placed = open
      .filter((o) => o.runId === scope.runId)
      .map((o) => toHostLaunch(o, "run", nowMs));
  } else if (scope.projectDirs !== undefined) {
    placed = open
      .filter((o) => inProjectScope({ projectDir: o.projectDir, canonical: o.projectDirCanonical }, project))
      .map((o) => toHostLaunch(o, "project", nowMs));
  } else {
    // Host-wide. A launch belongs in the main section if ANYTHING places it: an
    // explicit submission association, or a registered project home. The
    // "Unassociated activity" bucket below is for launches where NEITHER holds —
    // it is the honest last tier, not a dumping ground for a launch that named its
    // run but happened to run in a per-task worktree (the ticket's own 2026-08-04
    // case, which lands ON ITS RUN once `--run` is supplied).
    placed = open
      .filter((o) => o.projectDir !== null || hasPlacementAuthority(o))
      .map((o) => toHostLaunch(o, o.runId !== null ? "run" : o.projectDir !== null ? "project" : "host", nowMs));
  }

  // PURPOSE. The ONE thing that decides the host-verification LABEL, and it is a
  // DECLARATION read off the row — never the presence of an association, never the
  // name, argv or log. Everything else stays visible as generic launch diagnostics, so
  // this narrows what may be CALLED host verification without hiding a single launch.
  const hostVerification = placed.filter((l) => l.purpose === HOST_VERIFICATION_PURPOSE);
  const launches = placed.filter((l) => l.purpose !== HOST_VERIFICATION_PURPOSE);

  const unassociated = hostWide
    ? open
      .filter((o) => o.projectDir === null && !hasPlacementAuthority(o))
      .map((o) => toHostLaunch(o, "host", nowMs))
    : [];

  // FG-694: what is OPEN is read once, and it decides two different things through ONE
  // predicate over the SAME work references — which observations are current, and which
  // of the three CI absences is the true one.
  const currency = readCiCurrency(db);
  const read = readNewestCiObservations(db, scope, project, nowMs, currency);
  const observations = read.observations;
  // The three-way choice the trap in FG-694 is about. `not_observed` is only ever
  // reachable when there IS current work owed an observation; with nothing open,
  // "we observed no CI" would be a claim about an observer that was never asked.
  const ciState: RequiredCiSection["state"] =
    observations.length > 0 ? "observed" : hasCurrentCandidate(scope, project, currency, read) ? "not_observed" : "no_current_candidate";

  return {
    generatedAt: now.toISOString(),
    scope: {
      runId: scope.runId ?? null,
      projectDirs: scope.projectDirs === undefined ? null : [...scope.projectDirs],
    },
    agents: readAgents(db, scope, project),
    hostVerification,
    launches,
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

  // FG-700: the generic launch diagnostics. Rendered only when there is something to
  // render (the `Unassociated activity` pattern), and under a heading that claims
  // nothing about what the launch is beyond the purpose each row DECLARES. These rows
  // used to print under `Host verification` above; narrowing that label may not cost
  // an operator the diagnostics, so they moved rather than disappeared.
  if (activity.launches.length > 0) {
    lines.push("  Launch activity");
    for (const l of activity.launches) {
      lines.push(`    ${l.statusLabel}  ${l.launchId}  [${l.purpose}]${l.unassociated ? "  [unassociated]" : ""}  — ${l.commandLine}`);
    }
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
