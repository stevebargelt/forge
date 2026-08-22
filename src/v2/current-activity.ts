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
import { compareIdentity, identify } from "../util/path-identity.js";
import { retargetProofIdentity } from "../store/legacy-path-attribution.js";
import { isLaunchId, isTerminalStatus, statusLine, type LaunchStatus } from "./launch.js";
import { loadWorkflow } from "./loader.js";
import type { Gate } from "./schema.js";
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
import { classifyRetention, retentionDisposition, type RetentionDisposition, type RetentionPolicy } from "./retention-policy.js";
import {
  CI_WAIT_LIVE_WHERE,
  isCiWaitLive,
  rowToCiWait,
  type CiWait,
  type CiWaitKind,
  type CiWaitLifecycleState,
  type CiWaitObservedState,
} from "../store/ci-waits.js";

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

/** FG-731: how old a CI-WAIT observation may be before the reader stops treating it as
 *  evidence about the run's live state. The wait's re-observation cadence matches the
 *  review-loop observer (seconds), so the same generosity as CI_OBSERVATION_FRESH_MS is
 *  right. This gates ONLY the LABEL a wait renders — NEVER whether it is present. A
 *  non-terminal wait past this cutoff is STILL shown and STILL forces non-idle; it just
 *  reads `CI state unavailable` instead of a fabricated `CI running`. */
export const CI_WAIT_OBSERVATION_FRESH_MS = 15 * 60_000;

export const CI_WAIT_RUNNING_LABEL = "CI running";
export const CI_WAIT_NO_RUNS_LABEL = "no CI is running";
export const CI_WAIT_UNAVAILABLE_LABEL = "CI state unavailable";
export const CI_WAIT_AWAITING_ADVANCE_LABEL = "CI completed — awaiting advance";

/** FG-734: the ONE label for an operator wait — Forge has intentionally stopped and is
 *  waiting on a human decision. Distinct from every CI/launch/agent string: this is not
 *  a thing that is RUNNING, it is a thing that has DELIBERATELY STOPPED and is owed an
 *  operator's authority. Its mere presence forces WAITING/never-IDLE, exactly like a
 *  live CI wait (FG-731) — a decision Forge is blocked on is not idleness. */
export const OPERATOR_WAIT_LABEL = "Waiting on operator";

/** The requested action shown for a human-gate operator wait — the durable gate has no
 *  free-text action of its own (a campaign hard-stop carries one), so this is the fixed,
 *  honest instruction: the operator advances or rejects it. */
export const OPERATOR_WAIT_GATE_ACTION = "advance or reject the gate";

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
  /** FG-590: the SHARED retention disposition for a terminal launch, annotated by the
   *  surface (withRetentionDisposition / the dashboard) from the resolved policy — not
   *  computed by the derivation itself, which is clock/policy-free. Null for a running
   *  launch (live work, never a cleanup candidate) and absent on a row no surface
   *  annotated. `renderCurrentActivityLines` surfaces it so the human `forge status`
   *  carries the same disposition the JSON does (RF-8). */
  retentionDisposition?: RetentionDisposition | null;
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

/** FG-731: how a registered CI wait RENDERS. The four states are DISTINCT and never
 *  collapse into each other, into a fabricated success, or into idle:
 *    `running`                     — a fresh observation says checks are still going (+ m/n).
 *    `no_runs`                     — a fresh observation found no CI running (NOT unavailable).
 *    `unavailable`                 — the state could not be determined, OR the last
 *                                    observation is too old to be evidence about now.
 *    `completed_awaiting_advance`  — the run finished but the orchestrator still owes an
 *                                    advance; shown as exactly that, never dropped, never
 *                                    "running". */
export type CiWaitDisplayState = "running" | "no_runs" | "unavailable" | "completed_awaiting_advance";

/** One live (non-terminal) registered CI wait, shaped to PARALLEL HostLaunchActivity —
 *  a durable, register-before-poll wait the orchestrator is blocked on, surfaced so the
 *  workspace never reads IDLE while it lives. Placement/scope is decided by the
 *  association ids the record carries, through the same machinery a launch uses. */
export type CiWaitActivity = {
  waitId: string;
  kind: CiWaitKind;
  url: string | null;
  startedAt: string;
  /** When the wait was last re-observed, or null if never — kept distinct from the
   *  EFFECTIVE freshness so a reader can tell "observed running, a while ago" from
   *  "never looked". */
  observedAt: string | null;
  placement: "run" | "project" | "host";
  runId: string | null;
  ticketId: string | null;
  projectDir: string | null;
  projectLabel: string | null;
  /** The state-machine position, carried through so a reader sees the classification. */
  lifecycleState: CiWaitLifecycleState;
  /** The last-observed aggregate CI state, as persisted — a DIFFERENT axis from
   *  lifecycleState (a wait can be `running` with an `unavailable` last observation). */
  observedState: CiWaitObservedState | null;
  observedReason: string | null;
  m: number | null;
  n: number | null;
  /** `fresh` when the last observation is recent enough to be evidence about now;
   *  `unobserved` when it is stale or absent. Governs ONLY the label, NEVER presence. */
  observation: "fresh" | "unobserved";
  /** What RENDERS, derived once so both surfaces agree (BD-9). Never a fabricated
   *  "running", never a drop. */
  displayState: CiWaitDisplayState;
  statusLabel: string;
};

/** FG-734: which DURABLE record a `waiting_on_operator` entry was derived from — never
 *  inferred from prose, logs or elapsed time. `human_gate` is a task parked at a
 *  workflow step whose gate is `human` (a verdict/auto/none gate is the orchestrator's
 *  call, not the operator's, and is NOT this). `campaign_hard_stop` is a campaign_items
 *  row that recorded a `requested_human_action` — an autonomous run that stopped itself
 *  and named the authority it needs. */
export type OperatorWaitSource = "human_gate" | "campaign_hard_stop";

/** One live thing Forge has INTENTIONALLY STOPPED on and is waiting for a human to
 *  decide — surfaced identically to a CI wait (FG-731): a durable-record derivation whose
 *  MERE PRESENCE forces the workspace non-idle, re-derived from live state every call so
 *  advancing/rejecting/cancelling clears it with no stale row. It is NOT a new table:
 *  `human_gate` rows come from `tasks` (awaiting_gate + human step), `campaign_hard_stop`
 *  rows from `campaign_items.requested_human_action`. Placement/scope is decided by the
 *  association ids it carries, exactly as a launch or CI wait is. */
export type OperatorWaitActivity = {
  kind: "waiting_on_operator";
  source: OperatorWaitSource;
  /** Stable identity for rendering AND de-duplication (AC6) — the task id for a human
   *  gate, the campaign item id for a hard stop. Never fabricated. */
  waitKey: string;
  placement: "run" | "project" | "host";
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  projectDir: string | null;
  projectLabel: string | null;
  /** When the wait began — the task's `started_at` for a gate, the item's `updated_at`
   *  for a hard stop (when it was parked). Null when the record never recorded one. */
  startedAt: string | null;
  /** WHY Forge stopped, in the operator's terms. For a human gate: which step is owed a
   *  decision. For a hard stop: the item's recorded `reason`. */
  reason: string;
  /** The named next action the operator must take. For a human gate this is the fixed
   *  `advance or reject the gate`; for a hard stop it is the item's own
   *  `requested_human_action`. */
  requestedAction: string;
  /** The named stop CATEGORY when there is one — the campaign item's `blocker_kind`, or
   *  `human_gate` for a gate. Carried so a reader sees the classification. */
  blockerKind: string | null;
  /** What RENDERS, derived once so `forge status` and the dashboard agree (BD-9). */
  statusLabel: string;
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
  /** FG-731: the registered Forge-owned CI waits still LIVE (non-terminal). A row here
   *  forces WAITING/never-IDLE by its MERE PRESENCE, INDEPENDENT of observation
   *  freshness — the fix for a dead-waiter wait aging out and the workspace reading idle
   *  again. Freshness governs only `statusLabel`/`displayState`, never membership. */
  ciWaits: CiWaitActivity[];
  /** FG-734: the live things Forge has INTENTIONALLY STOPPED on, waiting for a human
   *  decision — derived from durable `tasks` (human gates) and `campaign_items` (hard
   *  stops), NOT a new table. Like `ciWaits`, a row here forces WAITING/never-IDLE by its
   *  mere presence and clears the instant its source record leaves the live state. */
  operatorWaits: OperatorWaitActivity[];
  /** BD-14: launches whose cwd maps to NO registered project home. Populated only
   *  for the host-wide scope — it is a HOST-level bucket, and surfacing it inside a
   *  project or run view would be inventing the very ownership BD-2 forbids. */
  unassociated: HostLaunchActivity[];
};

/** A CurrentActivity carrying the FG-590 retention surface: the resolved policy at top
 *  level and a `retentionDisposition` on every host-launch row. This is the ONE shape
 *  `forge status --json` and the dashboard both emit, so the two surfaces agree
 *  byte-for-byte (FG-679/BD-9) rather than each annotating its own way. */
export type CurrentActivityWithRetention = CurrentActivity & {
  retentionPolicy: RetentionPolicy;
  hostVerification: Array<HostLaunchActivity & { retentionDisposition: RetentionDisposition | null }>;
  launches: Array<HostLaunchActivity & { retentionDisposition: RetentionDisposition | null }>;
  unassociated: Array<HostLaunchActivity & { retentionDisposition: RetentionDisposition | null }>;
};

/** FG-590: annotate the host-launch buckets of a CurrentActivity with the SHARED
 *  retention disposition so a retained-for-investigation resource is labeled distinctly
 *  from an expired/eligible or leaked one — the SAME rule (retentionDisposition) the
 *  automatic cleanup and both surfaces use, never a second hand-rolled classification.
 *  A non-terminal (running) launch has no disposition (null): it is live work, never a
 *  cleanup candidate. The resolved policy is surfaced too so an operator/orchestrator can
 *  see the active retention windows. Computed over data currentActivity already produced —
 *  no new tmux/docker probe is spent here.
 *
 *  This lives beside the derivation (not on either surface) so `forge status` and the
 *  dashboard cannot drift into annotating differently (FG-679/BD-9). The derivation
 *  itself stays clock/policy-free; this wrapper is where the clock and policy enter. */
export function withRetentionDisposition(
  activity: CurrentActivity,
  policy: RetentionPolicy,
  nowMs: number,
): CurrentActivityWithRetention {
  const annotate = (l: HostLaunchActivity): HostLaunchActivity & { retentionDisposition: RetentionDisposition | null } => {
    let disposition: RetentionDisposition | null = null;
    if (isTerminalStatus(l.recordedStatus)) {
      const startedMs = Date.parse(l.startedAt);
      const ageMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
      disposition = retentionDisposition(classifyRetention({ kind: "launch", state: l.recordedStatus.state }), ageMs, policy);
    }
    return { ...l, retentionDisposition: disposition };
  };
  return {
    ...activity,
    retentionPolicy: policy,
    hostVerification: activity.hostVerification.map(annotate),
    launches: activity.launches.map(annotate),
    unassociated: activity.unassociated.map(annotate),
  };
}

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
  /** One RETARGET-PROOF decision per DISTINCT recorded spelling, for this derivation
   *  only — the physical path where a legacy spelling can still be claimed, and null
   *  where nothing about it can be (see recordedPhysical). */
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

// FG-693 (fix batch): a legacy row is credited only when it is RETARGET-PROOF.
//
// The value below used to be a plain `provenPhysical(spelling)` — where the recorded
// spelling resolves TODAY — and that is the one thing a NULL-canonical row may not be
// attributed on. Resolving a stored spelling now establishes that it resolves now; it
// never establishes that it resolved to the same tree when the row was written. A
// symlink recorded before the migration and since repointed from checkout A to
// checkout B therefore made A's run, launch and CI evidence appear under B — a false
// pass on the surface an operator reads to decide whether their checkout has work in
// flight and whether its checks have run.
//
// The rule is not restated here. `retargetProofIdentity` (src/store/legacy-path-
// attribution.ts) is the ONE definition the receipts and gate-evidence consumers
// already take, and it answers with a physical path only where the spelling
// demonstrably traversed no symlink at all. Membership in `scope.physicals` then
// finishes the comparison the shared `attributeLegacyRow` would do per target — the
// targets are ALREADY the filesystem's proven answers, so comparing against the set
// is that same proven-identity equality, without one realpath per target per row.
//
// WHAT A DECLINE COSTS, stated rather than hidden (AC6's compatibility projection is
// explicit, not silent): the row keeps every byte it recorded and stays fully
// readable — an unscoped `forge status` and the dashboard's host-wide read return it
// exactly as before. What it loses is its claim on ONE PARTICULAR project scope,
// which is the claim nothing ever proved.
function recordedPhysical(scope: ResolvedProjectScope, spelling: string): string | null {
  const memo = scope.spellings.get(spelling);
  if (memo !== undefined) return memo;
  const proof = retargetProofIdentity(spelling);
  const physical = proof.provable ? proof.identity.physical : null;
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
function hasCanonicalColumn(db: DatabaseInstance, table: "runs" | "campaigns"): boolean {
  return hasColumn(db, table, "project_dir_canonical");
}

/** Does THIS store carry a given column? PRAGMA table_info on a missing table returns
 *  zero rows rather than throwing (db.ts's shape-probe rule), so this doubles as a
 *  table-existence probe — a read-only handle can predate a table or a column, and naming
 *  one it lacks would throw and take the whole surface down (the FG-700 aged-store case). */
function hasColumn(db: DatabaseInstance, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
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

/** The live (non-terminal) CI waits, read from the INJECTED handle — never `getDb()`,
 *  so the dashboard's own read-only connection is honoured (BD-9) and no store is minted
 *  here. READ-ONLY over the persisted record: no gh/git/tmux/shell/CLI, exactly like the
 *  requiredCi read (BD-7/BD-12). The PRAGMA probe doubles as the table-existence check —
 *  a read-only handle can predate the ci_waits table, and `SELECT *` on a missing table
 *  would throw and take the whole surface down (db.ts's shape-probe rule: PRAGMA
 *  table_info on a missing table returns zero rows rather than throwing). */
function readLiveCiWaits(db: DatabaseInstance): CiWait[] {
  const cols = db.prepare(`PRAGMA table_info(ci_waits)`).all() as Array<{ name: string }>;
  if (cols.length === 0) return [];
  // Liveness is filtered on lifecycle_state (CI_WAIT_LIVE_WHERE), never the `terminal`
  // byte: a row whose byte lies (e.g. lifecycle=running, terminal=1) must NOT be dropped
  // from Current activity — that byte-lie is precisely how a live wait let the workspace
  // read IDLE again (RF-5). Same corrected predicate as readCiWaits (RF-3).
  const rows = db.prepare(`
    SELECT * FROM ci_waits WHERE ${CI_WAIT_LIVE_WHERE} ORDER BY started_at DESC LIMIT 500
  `).all() as Array<Parameters<typeof rowToCiWait>[0]>;
  // isCiWaitLive re-derives terminality from lifecycle_state (never the byte) as a belt-and-
  // suspenders over the SQL, and is what forces the wait to keep forcing WAITING/never-IDLE.
  return rows.map(rowToCiWait).filter(isCiWaitLive);
}

/** THE #1 RISK (FG-731). A non-terminal wait is ALWAYS shown and ALWAYS forces non-idle
 *  by its MERE PRESENCE — freshness NEVER removes it, unlike the launch / requiredCi
 *  freshness-DROP rule (a dead-waiter wait must not age out and let the workspace read
 *  idle again). EXISTENCE is decoupled from LIVENESS: freshness governs only the LABEL.
 *  A fresh `running` observation renders `CI running m/n`; a stale or never-observed one
 *  degrades to `CI state unavailable` — NEVER a fabricated `running`, and NEVER a drop.
 *  The observed states stay DISTINCT and never collapse into each other, into a fake
 *  success, or into idle. */
function ciWaitDisplay(wait: CiWait, fresh: boolean): { displayState: CiWaitDisplayState; statusLabel: string } {
  // `completed_awaiting_advance` is a persisted LIFECYCLE fact — a forge advance is owed.
  // It is not an observation about NOW, so freshness does not gate it into `unavailable`,
  // and it is neither dropped nor shown as still running.
  if (wait.lifecycleState === "completed_awaiting_advance" || wait.observedState === "completed") {
    return { displayState: "completed_awaiting_advance", statusLabel: CI_WAIT_AWAITING_ADVANCE_LABEL };
  }
  if (!fresh) {
    // Stale or never observed — we do NOT know the live state, so say exactly that. This
    // is the decoupling the ticket's #1 risk turns on: the wait stays present (above),
    // only its label degrades, and it degrades to unavailable, never to a fake `running`.
    const reason = wait.observedAt === null ? "not yet observed" : `last observed ${wait.observedAt}`;
    return { displayState: "unavailable", statusLabel: `${CI_WAIT_UNAVAILABLE_LABEL} — ${reason}` };
  }
  switch (wait.observedState) {
    case "running": {
      const counts = wait.observedM !== null && wait.observedN !== null ? ` ${wait.observedM}/${wait.observedN}` : "";
      return { displayState: "running", statusLabel: `${CI_WAIT_RUNNING_LABEL}${counts}` };
    }
    case "no_runs":
      // Distinct from `unavailable`: the observer LOOKED and found no CI running. Never
      // collapsed into unavailable, into a fake success, or into idle.
      return { displayState: "no_runs", statusLabel: CI_WAIT_NO_RUNS_LABEL };
    case "unavailable":
      return {
        displayState: "unavailable",
        statusLabel: wait.observedReason
          ? `${CI_WAIT_UNAVAILABLE_LABEL} — ${wait.observedReason}`
          : CI_WAIT_UNAVAILABLE_LABEL,
      };
    default:
      // A fresh observedAt with no observedState cannot arise (only an observation writes
      // observed_at) — read as unknown rather than fabricated.
      return { displayState: "unavailable", statusLabel: CI_WAIT_UNAVAILABLE_LABEL };
  }
}

function toCiWaitActivity(wait: CiWait, placement: "run" | "project" | "host", nowMs: number): CiWaitActivity {
  const observedMs = parseMs(wait.observedAt);
  const fresh = observationIsFresh(observedMs, nowMs, CI_WAIT_OBSERVATION_FRESH_MS);
  const { displayState, statusLabel } = ciWaitDisplay(wait, fresh);
  return {
    waitId: wait.id,
    kind: wait.kind,
    url: wait.url,
    startedAt: wait.startedAt,
    observedAt: wait.observedAt,
    placement,
    runId: wait.runId,
    ticketId: wait.ticketId,
    projectDir: wait.projectDir,
    projectLabel: projectLabelOf(wait.projectDir),
    lifecycleState: wait.lifecycleState,
    observedState: wait.observedState,
    observedReason: wait.observedReason,
    m: wait.observedM,
    n: wait.observedN,
    observation: fresh ? "fresh" : "unobserved",
    displayState,
    statusLabel,
  };
}

// ─────────────────────── FG-734: operator waits (derived, no new table) ──────────────
//
// Two DURABLE sources, one derived kind. Nothing here reads prose, a log, or elapsed
// time: an operator wait exists only where a task is parked at a `human` gate or a
// campaign item recorded a `requested_human_action`. Re-derived live every call, so it
// clears the instant the gate is advanced/rejected or the item leaves its park (AC5).

/** The gate a step declares, resolved through the SAME `loadWorkflow` the CLI uses
 *  (status.ts), memoized per (workflow, projectDir) and FAIL-CLOSED: a workflow that
 *  cannot be loaded (missing seed generation, YAML error, unknown name) yields `null`,
 *  and a step whose gate cannot be proven `human` is NOT surfaced as an operator wait —
 *  the weaker claim, never a guess. Kept behind an injectable seam so the derivation
 *  stays hermetically testable without a seed install on disk. */
export type StepGateResolver = (workflow: string, projectDir: string | null, stepId: string) => Gate | null;

export function makeWorkflowGateResolver(): StepGateResolver {
  const cache = new Map<string, ReturnType<typeof loadWorkflow> | null>();
  return (workflow, projectDir, stepId) => {
    const key = `${workflow} ${projectDir ?? ""}`;
    let wf = cache.get(key);
    if (wf === undefined) {
      try {
        wf = loadWorkflow(workflow, projectDir ? { projectDir } : {});
      } catch {
        wf = null;
      }
      cache.set(key, wf);
    }
    if (wf === null) return null;
    const step = wf.steps.find((s) => s.id === stepId);
    return step ? step.gate : null;
  };
}

type HumanGateRow = {
  id: string;
  run_id: string;
  phase: string;
  agent_role: string;
  started_at: string | null;
  workflow: string;
  ticket_id: string | null;
  project_dir: string | null;
  project_dir_canonical?: string | null;
};

/** Tasks parked at a durable gate, on an ACTIVE run — the only writer of `awaiting_gate`
 *  is the CAS at markTaskHeldForGate, reached for BOTH `human` and `verdict` gates, so
 *  the gate kind is resolved per row and only `human` survives. The ticket association is
 *  read off the run metadata (never argv/log), matching how launches are placed. */
function readAwaitingGateTasks(db: DatabaseInstance): HumanGateRow[] {
  const canonical = hasCanonicalColumn(db, "runs") ? ", r.project_dir_canonical" : "";
  // The run metadata carries the ticket id under a `ticketId` key when the run declared
  // one; json_extract returns NULL when absent, which is the honest reading. An aged
  // `runs` table can predate the metadata column entirely (FG-700's aged-store shape), so
  // it is probed and read as no-ticket rather than naming a column that would throw.
  const ticket = hasColumn(db, "runs", "metadata") ? "json_extract(r.metadata, '$.ticketId')" : "NULL";
  return db.prepare(`
    SELECT t.id, t.run_id, t.phase, t.agent_role, t.started_at,
           r.workflow, r.project_dir, ${ticket} AS ticket_id${canonical}
      FROM tasks t
      JOIN runs r ON r.id = t.run_id
     WHERE t.status = 'awaiting_gate'
       AND r.status = 'active'
     ORDER BY t.started_at DESC, t.created_at DESC
  `).all() as HumanGateRow[];
}

function humanGateToOperatorWait(row: HumanGateRow, placement: "run" | "project" | "host"): OperatorWaitActivity {
  const reason = `human gate at step ${row.phase} (${row.agent_role}) in workflow ${row.workflow}`;
  return {
    kind: "waiting_on_operator",
    source: "human_gate",
    waitKey: row.id,
    placement,
    runId: row.run_id,
    taskId: row.id,
    ticketId: typeof row.ticket_id === "string" && row.ticket_id !== "" ? row.ticket_id : null,
    campaignId: null,
    itemId: null,
    projectDir: row.project_dir,
    projectLabel: projectLabelOf(row.project_dir),
    startedAt: row.started_at,
    reason,
    requestedAction: OPERATOR_WAIT_GATE_ACTION,
    blockerKind: "human_gate",
    statusLabel: OPERATOR_WAIT_LABEL,
  };
}

type CampaignStopRow = {
  id: string;
  campaign_id: string;
  ticket_id: string;
  run_id: string | null;
  lifecycle_status: string;
  blocker_kind: string | null;
  reason: string | null;
  requested_human_action: string;
  updated_at: string | null;
  campaign_status: string;
  /** FG-743: 1 only when `ticket_id` is CLOSED across the whole shadow — at least one
   *  `tickets` row carries it and EVERY row that does records `done`, else 0. The
   *  RECONCILIATION signal — a done ticket means the item's work shipped, so a retained
   *  "close the ticket" instruction is already satisfied. 0 on a store with no `tickets`
   *  table (the aged read-only shape), the fail-open direction: absence of proof of
   *  closure is not proof of closure.
   *
   *  FG-743/RF-1: the ALL-rows-done test is deliberate, not MAX-over-rows. `tickets` is
   *  keyed by (project_key, ticket_id) so two projects can each carry an `FG-123`, and
   *  this module cannot resolve a project_key from a workspace path without shelling
   *  `git` (BD-7/BD-18). Reading closure off ANY matching row let a `done` `FG-123` in
   *  project B suppress a LIVE hard-stop on project A's still-active `FG-123` — a
   *  false-negative drop of an unresolved operator decision. Requiring every row to be
   *  `done` scopes conservatively: one still-active row anywhere keeps the wait visible,
   *  the same direction `readClosedTicketIds` takes for the identical collision. */
  ticket_done: number;
  project_dir: string | null;
  project_dir_canonical?: string | null;
};

/** FG-743: a campaign in one of these statuses is OVER (CAMPAIGN_TRANSITIONS in
 *  src/types has each as a terminal sink). Its parked items are HISTORY — inspectable via
 *  `forge campaign show/report` (AC6) — never live operator waits, even when an aged item
 *  still carries a `requested_human_action`. `paused`/`running` are the only nonterminal
 *  statuses and are deliberately absent. */
const TERMINAL_CAMPAIGN_STATUSES: readonly string[] = ["complete", "failed", "abandoned"];

/** FG-743: the campaign/item/ticket lifecycle predicate for a LIVE campaign operator
 *  wait. A parked item that named an operator authority (`requested_human_action`) is a
 *  live wait ONLY when:
 *    - its parent campaign is still nonterminal (paused/running) — a terminal campaign's
 *      parked items are history (AC1/AC2); and
 *    - its work is not already reconciled — a `done` ticket means the item shipped, so a
 *      retained "close the ticket" instruction is already satisfied and no operator action
 *      remains, so the wait is cleared rather than presented with obsolete prose (AC4/AC5).
 *  The row's own park (lifecycle NOT IN complete/failed/pending/running) is already
 *  filtered in SQL; this is the parent + reconciliation half of the same question. */
function isLiveCampaignOperatorWait(row: CampaignStopRow): boolean {
  if (TERMINAL_CAMPAIGN_STATUSES.includes(row.campaign_status)) return false;
  if (row.ticket_done === 1) return false;
  return true;
}

/** Campaign items that STOPPED THEMSELVES and named the operator authority they need —
 *  a non-null `requested_human_action` is the durable hard-stop signal. Only LIVE parks
 *  survive: a `complete`/`failed`/`pending`/`running` item is not a wait (it advanced or
 *  never parked), so the parked set (awaiting_gate / blocked_by_red / awaiting_recovery)
 *  is what remains. FG-743: the park alone is not enough — a stop under a TERMINAL campaign
 *  or against an already-`done` ticket is historical, not live, so the shared
 *  `isLiveCampaignOperatorWait` predicate finishes the membership decision. The item
 *  carries no project dir of its own; the campaign does. */
function readCampaignHardStops(db: DatabaseInstance): CampaignStopRow[] {
  // A read-only handle can predate the campaign tables; PRAGMA doubles as the existence
  // check (zero rows for a missing table), so a store without them reads as no hard stops
  // rather than throwing on the JOIN and taking the whole surface down.
  if (!hasColumn(db, "campaign_items", "requested_human_action") || !hasColumn(db, "campaigns", "project_dir")) return [];
  const canonical = hasCanonicalColumn(db, "campaigns") ? ", c.project_dir_canonical" : "";
  // The `tickets` table can be absent on an aged/read-only handle too; guard it the same
  // way and read every item as not-done (`0`) there rather than naming a table that throws.
  // FG-743/RF-1: closure is ALL-rows-done, not any-row-done. `tickets` is keyed by
  // (project_key, ticket_id), so a `done` `FG-123` in one project must not clear a live
  // hard-stop on a still-active `FG-123` in another. COUNT(*) > 0 rejects the no-matching-
  // row case (an unimported ticket is unproven, not closed); the SUM is 0 iff no matching
  // row is anything other than `done`. This mirrors `readClosedTicketIds` exactly — the one
  // place this module already reconciles the same (project_key, ticket_id) collision.
  const ticketDone = hasColumn(db, "tickets", "status")
    ? `(SELECT CASE WHEN COUNT(*) > 0
                     AND SUM(CASE WHEN t.status = '${CLOSED_TICKET_STATUS}' THEN 0 ELSE 1 END) = 0
                    THEN 1 ELSE 0 END
          FROM tickets t WHERE t.ticket_id = ci.ticket_id)`
    : "0";
  const rows = db.prepare(`
    SELECT ci.id, ci.campaign_id, ci.ticket_id, ci.run_id, ci.lifecycle_status,
           ci.blocker_kind, ci.reason, ci.requested_human_action, ci.updated_at,
           c.status AS campaign_status, ${ticketDone} AS ticket_done,
           c.project_dir${canonical}
      FROM campaign_items ci
      JOIN campaigns c ON c.id = ci.campaign_id
     WHERE ci.requested_human_action IS NOT NULL
       AND ci.lifecycle_status NOT IN ('complete', 'failed', 'pending', 'running')
     ORDER BY ci.updated_at DESC
  `).all() as CampaignStopRow[];
  return rows.filter(isLiveCampaignOperatorWait);
}

function campaignStopToOperatorWait(row: CampaignStopRow, placement: "run" | "project" | "host"): OperatorWaitActivity {
  const reason = row.reason && row.reason !== "" ? row.reason : `campaign item ${row.ticket_id} parked (${row.lifecycle_status})`;
  return {
    kind: "waiting_on_operator",
    source: "campaign_hard_stop",
    waitKey: row.id,
    placement,
    runId: row.run_id,
    taskId: null,
    ticketId: row.ticket_id,
    campaignId: row.campaign_id,
    itemId: row.id,
    projectDir: row.project_dir,
    projectLabel: projectLabelOf(row.project_dir),
    startedAt: row.updated_at,
    reason,
    requestedAction: row.requested_human_action,
    blockerKind: row.blocker_kind,
    statusLabel: OPERATOR_WAIT_LABEL,
  };
}

/** The operator waits IN SCOPE, de-duplicated (AC6). A human-gate task and a campaign
 *  hard-stop that name the SAME run are ONE wait — Forge stopped once — so the human
 *  gate (which carries task identity) wins and the campaign row for that run is dropped.
 *  Scoping/placement mirror `ciWaits`: an unassociated wait is still shown host-wide,
 *  because a decision Forge is blocked on must never let the workspace read idle. */
function deriveOperatorWaits(
  db: DatabaseInstance,
  scope: CurrentActivityScope,
  project: ResolvedProjectScope | undefined,
  resolveGate: StepGateResolver,
): OperatorWaitActivity[] {
  const gates = readAwaitingGateTasks(db).filter((r) => resolveGate(r.workflow, r.project_dir, r.phase) === "human");
  const stops = readCampaignHardStops(db);

  const placementOf = (runId: string | null, projectDir: string | null): "run" | "project" | "host" =>
    runId !== null ? "run" : projectDir !== null ? "project" : "host";
  const inScope = (runId: string | null, id: RowProjectIdentity): boolean => {
    if (scope.runId !== undefined) return runId === scope.runId;
    if (scope.projectDirs !== undefined) return inProjectScope(id, project);
    return true;
  };

  const waits: OperatorWaitActivity[] = [];
  const coveredRuns = new Set<string>();
  for (const g of gates) {
    if (!inScope(g.run_id, { projectDir: g.project_dir, canonical: g.project_dir_canonical ?? null })) continue;
    coveredRuns.add(g.run_id);
    waits.push(humanGateToOperatorWait(g, scope.runId !== undefined ? "run" : scope.projectDirs !== undefined ? "project" : placementOf(g.run_id, g.project_dir)));
  }
  for (const s of stops) {
    if (s.run_id !== null && coveredRuns.has(s.run_id)) continue; // AC6: same run → one entry
    if (!inScope(s.run_id, { projectDir: s.project_dir, canonical: s.project_dir_canonical ?? null })) continue;
    waits.push(campaignStopToOperatorWait(s, scope.runId !== undefined ? "run" : scope.projectDirs !== undefined ? "project" : placementOf(s.run_id, s.project_dir)));
  }
  return waits;
}

type CiPayload = {
  attemptId?: unknown;
  ticketId?: unknown;
  projectDir?: unknown;
  /** FG-693: the observer's PROVEN identity for `projectDir`, written since the fix
   *  batch and absent from every payload recorded before it — which is exactly what
   *  makes an older payload legacy-shaped and decided by the retarget-proof rule. */
  projectDirCanonical?: unknown;
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
/** The payload's recorded project home, as SQL. `json_valid` is not decoration:
 *  `json_extract` on a malformed payload is a hard error that would take the whole
 *  read down, and a row whose payload does not parse is one the loop below skips
 *  anyway. Written as a CASE rather than an `AND` because SQLite does not promise to
 *  short-circuit a conjunction. */
const PAYLOAD_PROJECT_DIR = `CASE WHEN json_valid(payload) THEN json_extract(payload, '$.projectDir') END`;
const PAYLOAD_PROJECT_CANONICAL = `CASE WHEN json_valid(payload) THEN json_extract(payload, '$.projectDirCanonical') END`;

/** Every DISTINCT spelling a run-less CI observation was recorded under that the
 *  scope's own predicate admits. Spellings, not rows: it is one entry per checkout
 *  ever observed, decided once, and the resolution each costs is memoized on the
 *  scope alongside the per-row decisions that follow. Deliberately NOT capped — a cap
 *  ahead of the identity question is the silent truncation this fix removes.
 *
 *  The narrowing is by BYTES because the pair key is the bytes, so a pair is admitted
 *  whole or not at all; which bytes survive is decided by IDENTITY, through the same
 *  predicate the per-row pass applies. */
function inScopeRunlessSpellings(db: DatabaseInstance, project: ResolvedProjectScope): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT ${PAYLOAD_PROJECT_DIR} AS project_dir, ${PAYLOAD_PROJECT_CANONICAL} AS project_dir_canonical
         FROM events
        WHERE event_type = ? AND run_id IS NULL`,
    )
    .all(CI_OBSERVED_EVENT_TYPE) as Array<{ project_dir: string | null; project_dir_canonical: string | null }>;
  const spellings = new Set<string>();
  for (const row of rows) {
    if (typeof row.project_dir !== "string" || row.project_dir === "") continue;
    if (inProjectScope({ projectDir: row.project_dir, canonical: row.project_dir_canonical }, project)) {
      spellings.add(row.project_dir);
    }
  }
  return [...spellings];
}

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
  // Rows that declare no run have no run to be narrowed by, and their pair key is the
  // payload's project BYTES — so a byte clause taken from the OPERATOR'S spellings
  // would be the FG-693 defect, and no clause at all left them competing for the same
  // 500 slots as every other project's run-less rows. 500 newer observations anchored
  // by reviews elsewhere then evicted a requested project's current one, and no later
  // identity check can recover a row SQLite did not return.
  //
  // So the byte set is taken from the DATA and decided by IDENTITY, which is
  // pair-granular by construction: every distinct spelling a run-less observation was
  // recorded under, each put through the SAME per-row predicate below. A pair is
  // therefore admitted whole or not at all — never partially, which is what would
  // promote a superseded row into a slot its successor had already closed. What is
  // excluded is only what identity DECIDED is another project's.
  //
  // The spelling pass costs a scan of the run-less slice, and this surface is polled,
  // so it is not spent where it cannot change the answer: with NO open review, no
  // run-less row can be current under any reference (`workIsCurrent` for a row that
  // declares no run is answered by an open review naming its ticket, and by nothing
  // else), and a row that cannot be current contributes neither an observation nor a
  // declared run. The window may drop them outright there.
  const runlessSpellings =
    project === undefined
      ? undefined
      : currency.openReviews.length === 0
        ? []
        : inScopeRunlessSpellings(db, project);

  const clauses: string[] = [];
  const params: string[] = [];
  const runlessClause =
    runlessSpellings === undefined
      ? "run_id IS NULL"
      : runlessSpellings.length > 0
        ? `(run_id IS NULL AND ${PAYLOAD_PROJECT_DIR} IN (${runlessSpellings.map(() => "?").join(",")}))`
        : null;
  if (scope.runId !== undefined) {
    // A run-scoped read wants that run's rows and nothing else — not the no-run rows a
    // host-wide read has to consider, which were dropped AFTER the limit before.
    if (eligibleRunIds.length === 0) return { observations: [], declaredRunIds: new Set() };
    clauses.push("AND run_id = ?");
    params.push(scope.runId);
  } else if (eligibleRunIds.length === 0) {
    // Rows with no run id stay in: their anchor is a review, resolved per row below.
    if (runlessClause === null) return { observations: [], declaredRunIds: new Set() };
    clauses.push(`AND ${runlessClause}`);
    params.push(...(runlessSpellings ?? []));
  } else {
    clauses.push(
      runlessClause === null
        ? `AND run_id IN (${eligibleRunIds.map(() => "?").join(",")})`
        : `AND (${runlessClause} OR run_id IN (${eligibleRunIds.map(() => "?").join(",")}))`,
    );
    params.push(...(runlessClause === null ? [] : (runlessSpellings ?? [])), ...eligibleRunIds);
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
    // The payload declares the project home, and — since the fix batch — the PROVEN
    // identity beside it. An older payload carries only the spelling, which is what
    // puts it on the legacy-shaped arm of the same one rule.
    const canonical =
      typeof payload.projectDirCanonical === "string" && payload.projectDirCanonical !== ""
        ? payload.projectDirCanonical
        : null;
    if (!inProjectScope({ projectDir, canonical }, project)) continue;

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
export function deriveCurrentActivity(
  db: DatabaseInstance,
  opts: { now?: Date; scope?: CurrentActivityScope; resolveStepGate?: StepGateResolver } = {},
): CurrentActivity {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const scope = opts.scope ?? {};
  // FG-734: resolved ONCE per derivation (memoized inside) so both surfaces prove the
  // same gate the same way. Injectable so the derivation tests stay hermetic.
  const resolveStepGate = opts.resolveStepGate ?? makeWorkflowGateResolver();
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

  // FG-731: the registered CI waits, read from the SAME injected handle over the SAME
  // persisted record — no outbound call. Placed/scoped by the association ids exactly as
  // launches are. Every live wait is something the orchestrator is BLOCKED on, so unlike
  // a launch (which needs a project home or an explicit association to appear host-wide)
  // an unassociated wait is still shown host-wide at `host` placement — an awaited run
  // with no run/project id is precisely the FG-704 case the workspace read idle through.
  const liveWaits = readLiveCiWaits(db);
  let ciWaits: CiWaitActivity[];
  if (scope.runId !== undefined) {
    ciWaits = liveWaits.filter((w) => w.runId === scope.runId).map((w) => toCiWaitActivity(w, "run", nowMs));
  } else if (scope.projectDirs !== undefined) {
    ciWaits = liveWaits
      .filter((w) => inProjectScope({ projectDir: w.projectDir, canonical: w.projectDirCanonical }, project))
      .map((w) => toCiWaitActivity(w, "project", nowMs));
  } else {
    ciWaits = liveWaits.map((w) =>
      toCiWaitActivity(w, w.runId !== null ? "run" : w.projectDir !== null ? "project" : "host", nowMs),
    );
  }

  // FG-734: the operator waits — Forge's intentional stops, derived from durable task and
  // campaign records over the SAME injected handle. Scoped/placed exactly like ciWaits;
  // an unassociated wait is still shown host-wide so a pending decision never reads idle.
  const operatorWaits = deriveOperatorWaits(db, scope, project, resolveStepGate);

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
    ciWaits,
    operatorWaits,
    unassociated,
  };
}

/** The human rendering `forge status` prints, and the exact text the dashboard's
 *  three sections carry. Exported so the agreement test can assert one string
 *  against the other rather than two independently-written renderers. */
/** FG-590 (RF-8): the human suffix for a terminal launch's retention disposition, so the
 *  human `forge status` carries the SAME disposition the JSON surface already annotates.
 *  Empty for a running launch (null disposition) or a row no surface annotated — the human
 *  line then reads exactly as before. */
function retentionSuffix(l: HostLaunchActivity): string {
  switch (l.retentionDisposition) {
    case "within_retention_for_investigation": return "  · retention: retained for investigation";
    case "expired_eligible": return "  · retention: expired — eligible for cleanup";
    case "leaked": return "  · retention: leaked — past retention";
    default: return "";
  }
}

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
    lines.push(`    ${l.statusLabel}  ${l.launchId}${l.unassociated ? "  [unassociated]" : ""}  — ${l.commandLine}${retentionSuffix(l)}`);
  }

  // FG-700: the generic launch diagnostics. Rendered only when there is something to
  // render (the `Unassociated activity` pattern), and under a heading that claims
  // nothing about what the launch is beyond the purpose each row DECLARES. These rows
  // used to print under `Host verification` above; narrowing that label may not cost
  // an operator the diagnostics, so they moved rather than disappeared.
  if (activity.launches.length > 0) {
    lines.push("  Launch activity");
    for (const l of activity.launches) {
      lines.push(`    ${l.statusLabel}  ${l.launchId}  [${l.purpose}]${l.unassociated ? "  [unassociated]" : ""}  — ${l.commandLine}${retentionSuffix(l)}`);
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

  // FG-731: the registered CI waits. Always emitted, like Agents / Host verification /
  // Required CI — the section IS the WAITING/never-IDLE signal on `forge status`, so a
  // non-terminal wait renders a row and an empty set renders the parenthesised absence.
  // A dead-waiter wait past its freshness cutoff still renders (its label degrades to
  // `CI state unavailable`); it is never dropped, which is the whole point of the fix.
  lines.push("  CI waits");
  if (activity.ciWaits.length === 0) {
    lines.push("    (no CI wait registered)");
  } else {
    for (const w of activity.ciWaits) {
      lines.push(`    ${w.statusLabel}  ${w.kind}  ${w.waitId}${w.ticketId ? `  ${w.ticketId}` : ""}  — ${w.url ?? "(no url)"}`);
    }
  }

  // FG-734: the operator waits — Forge's intentional stops. Always emitted, like the
  // sections above, so a `waiting_on_operator` entry IS the WAITING/never-IDLE signal on
  // `forge status`, and an empty set renders the parenthesised absence. Each row names
  // the reason Forge stopped and the action the operator must take.
  lines.push("  Waiting on operator");
  if (activity.operatorWaits.length === 0) {
    lines.push("    (nothing waiting on operator)");
  } else {
    for (const w of activity.operatorWaits) {
      const ident = w.ticketId ?? w.runId ?? w.itemId ?? w.taskId ?? "(no id)";
      lines.push(`    ${w.statusLabel}  ${w.source}  ${ident}  — ${w.reason} · ${w.requestedAction}`);
    }
  }

  if (activity.unassociated.length > 0) {
    lines.push("  Unassociated activity");
    for (const l of activity.unassociated) {
      lines.push(`    ${l.statusLabel}  ${l.launchId}  — ${l.commandLine}${retentionSuffix(l)}`);
    }
  }
  return lines;
}
