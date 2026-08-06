// FG-591: `forge queue` — the operator's PLANNING surface over the queue primitives
// FG-609 and FG-610 already shipped.
//
// ─── WHAT THIS COMMAND GROUP IS AND IS NOT ───────────────────────────────────
// It is planning intent: which tickets the operator selected, in which order, and —
// on `list` — the board as an operator reads it. It is NOT execution authorization.
// Nothing here arms autonomous dispatch, sets a capacity ceiling, claims, launches,
// releases or cancels anything; queue membership alone never starts a container.
//
// ─── WHY THESE VERBS, GIVEN `forge backlog` ALREADY HAS FOUR ─────────────────
// enqueue / dequeue / reorder are the SAME WRITERS, reached by a second spelling:
// every one of them delegates to the identical src/store/queue.ts function that
// `forge backlog <verb>` calls, with no second validation, no second refusal
// vocabulary and no second event type. The gap FG-591 actually closes is two things
// FG-609 has no CLI form for:
//
//   * THE RELATIVE RANK FORM. `rank-before` / `rank-after` express the operator's
//     INTENT ("put FG-7 above FG-3"), which survives the queue moving underneath
//     the submission. A positional `--to 4` does not: it silently means something
//     else the moment anything is enqueued or reordered in between. Both carry
//     `--expect-version`, the compare-and-set FG-609's absolute forms now accept
//     too, so a submission built on a stale view refuses instead of clobbering.
//   * THE READ SURFACE. `queue list` renders the five board projections over the
//     ORTHOGONAL DURABLE FIELDS — rank (nullable), membership, lifecycle status,
//     blocker evidence, dispatch evidence — and, per queued entry, the concrete
//     reason it is not running. It stores nothing: In progress, Blocked and Done are
//     derived on every read and are never toggled by hand.
//
// ─── THE ONE DISTINCTION THE BOARD MUST NOT COLLAPSE ─────────────────────────
// A GENUINE BLOCKER (blocker evidence; isQueueBlocked) and a TEMPORARY SCHEDULING
// INCOMPATIBILITY ("waiting for FG-123 to finish") are different facts with
// different lifetimes and different operator actions. A blocker is durable,
// per-ticket, partly container-visible, and someone has to clear it. A scheduling
// wait is per-evaluation and evaporates the moment the active set changes — nobody
// needs to do anything. So they render in DIFFERENT COLUMNS under DIFFERENT LABELS:
// a compatibility wait stays QUEUED with its explanation and is never shown as
// Blocked, and nothing on this path ever writes a blocker_evidence row.
//
// ─── WHERE `list`'s "why is this not running" COMES FROM ─────────────────────
// It is a LIVE PREVIEW, computed from durable state on this read and written
// nowhere. It mirrors claimNextEligible's own scan classification and reuses that
// module's ScanReason vocabulary verbatim rather than inventing a second one (see
// previewScanReason; fg591-queue-cli.integration.test.ts pins the two together
// against the primitive's real `scanned` output, so they cannot drift silently).
//
// TWO THINGS IT DELIBERATELY DOES NOT DO:
//   * It never reports `capacity`. The ceiling is dispatcher policy, and the ONLY
//     place a count may bound admission is inside claimNextEligible's write
//     transaction. A ceiling "checked" by a read surface is advisory, and printing
//     an advisory number beside a real one reads as a guarantee.
//   * It is not the dispatcher's durable record of a decision. The authoritative
//     answer to "why did nothing start" is the dispatcher's evaluation row; this is
//     what an operator can see about their own queue at any moment, including
//     before a dispatcher has ever run against it.
//
// COMPATIBILITY is evaluated in HOST scope (FG-591 D-capacity-scope: one Docker
// daemon, one machine, one auth profile, one store — the resource being protected
// is the host, not the project), through the same pure predicate the dispatcher
// uses. The read hydrates once and the predicate is I/O-free over that snapshot, so
// this surface cannot drift from the dispatcher's answer by using a different rule.

import type { Command } from "commander";
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { resolveBacklogStore } from "../../backlog/storage-mode.js";
import {
  inContainerBacklogMode,
  refuseContainerMutation,
  ContainerMutationRefused,
} from "../../backlog/container-authority.js";
import {
  dequeueTicket,
  enqueueTicket,
  isInProgress,
  isQueueBlocked,
  moveQueuePosition,
  queueVersion,
  queueView,
  readinessView,
  rankAfter,
  rankBefore,
  setQueueOrder,
  QueueRefusal,
  type QueueEntry,
} from "../../store/queue.js";
import {
  liveClaims,
  liveClaimsInScope,
  type CapacityScope,
  type QueueClaim,
  type ScanEntry,
  type ScanReason,
} from "../../store/queue-claims.js";
import {
  evaluateCompatibility,
  hydrateActiveRunFacts,
  type ActiveRunFacts,
} from "../../queue/compatibility.js";
import { getTicket, ticketsForProject } from "../../store/tickets.js";
import {
  capacityHoldersFrom,
  latestCapacityRefusal,
  recordWake,
  type CapacityHolder,
  type DispatcherEvaluation,
  type WakeKind,
} from "../../store/dispatcher-evidence.js";
import { setDispatcherPolicy, type DispatcherPolicy } from "../../store/dispatcher-policy.js";
import { cancelClaimedTicket } from "../../queue/dispatch-execution.js";
import {
  DISPATCHER_ID_ENV,
  dispatcherHealth,
  resolveDispatcherOwner,
  runDispatcherLoop,
  type DispatcherHealth,
  type DispatcherTick,
} from "../../queue/dispatcher-loop.js";

/** FG-591 D-capacity-scope. The COUNTING scope for capacity is host-wide, and the
 *  compatibility read follows it: a run in another project on this host occupies the
 *  same daemon and the same machine, so a board that hydrated only its own project
 *  would explain a wait it could not see. */
const CAPACITY_SCOPE = "host" as const;

/** The outcomes that permit execution. Identical to FG-609's QUEUEABLE_OUTCOMES and
 *  FG-610's EXECUTABLE_OUTCOMES — no third readiness vocabulary, and readiness is
 *  NOT re-evaluated here (D7: a stale assessment is an operator-actionable board
 *  state, not something a read surface silently refreshes). */
const EXECUTABLE_OUTCOMES = new Set(["ready", "exploratory"]);

// ─── the board projection ────────────────────────────────────────────────────

/** The five views. PROJECTIONS over orthogonal durable fields, not five competing
 *  statuses: nothing stores which one a ticket is in, and nothing toggles one. */
export type BoardProjection = "backlog" | "queued" | "in_progress" | "blocked" | "done";

export const BOARD_PROJECTIONS: readonly BoardProjection[] = [
  "backlog",
  "queued",
  "in_progress",
  "blocked",
  "done",
];

/** Which column an entry renders in. PRECEDENCE, stated because it is the whole
 *  definition:
 *    done       — the lifecycle status says so.
 *    in_progress— dispatch evidence says a task of this ticket is still in flight.
 *                 It is FIRST after done on purpose: a ticket the operator dequeued
 *                 while its container still runs is not-a-queue-member AND executing,
 *                 and that combination is a first-class state (D4), not a gap. Its
 *                 membership is still rendered on the row.
 *    blocked    — the queue's own wide derivation over blocker evidence.
 *    queued     — the operator selected it and it is executable in principle.
 *    backlog    — everything else, INCLUDING a deferred queue member: visible,
 *                 keeping rank, membership and history, and ineligible anyway.
 *  A blocked or in-progress entry keeps its rank and its membership, so clearing the
 *  blocker returns it to exactly the queue position it held (AC6). */
export function projectionOf(entry: {
  status: string;
  queued: boolean;
  blocked: boolean;
  inProgress: boolean;
}): BoardProjection {
  if (entry.status === "done") return "done";
  if (entry.inProgress) return "in_progress";
  if (entry.blocked) return "blocked";
  if (entry.queued && entry.status === "active") return "queued";
  return "backlog";
}

export type BoardReadiness = {
  outcome: string;
  stale: boolean;
  gaps: string[];
  refinementProposal: string | null;
  revision: number | null;
  evaluatedAt: string;
};

export type BoardClaim = {
  claimId: string;
  owner: string;
  generation: number;
  leaseExpiresAtMs: number;
  leaseExpired: boolean;
  launchId: string | null;
  runId: string | null;
};

export type BoardRow = {
  ticketId: string;
  title: string;
  type: string;
  /** The LIFECYCLE status, verbatim. Never the projection. */
  status: string;
  rank: number | null;
  queued: boolean;
  blocked: boolean;
  inProgress: boolean;
  projection: BoardProjection;
  readiness: BoardReadiness | null;
  /** The live preview of claimNextEligible's own classification. `reason` is
   *  queue-claims' ScanReason, unchanged. */
  scan: { reason: ScanReason; detail: string | null };
  /** The RESERVATION, when one is live. Read from the claim table and never joined
   *  with the run record in one query — the claim is authoritative for the
   *  reservation, the run record for the execution. */
  claim: BoardClaim | null;
};

export type BoardView = {
  projectKey: string;
  /** The queue version this view was built from — what `--expect-version` takes. */
  version: number;
  capacityScope: typeof CAPACITY_SCOPE;
  /** Stated in the payload rather than left to be inferred: this surface does not
   *  apply the capacity ceiling (see the header). */
  capacityApplied: false;
  rows: BoardRow[];
};

type ScanPreview = { reason: ScanReason; detail: string | null };

/** claimNextEligible's scan classification, re-derived as a READ. Same order, same
 *  named reasons, same detail strings, same underlying predicates (isQueueBlocked and
 *  readinessView via queueView, liveClaims, and the shared compatibility predicate) —
 *  so an operator reading this sees the reason the dispatcher would record.
 *
 *  The two differences, both deliberate and both stated in the header: `capacity` is
 *  never reported here, and this writes nothing at all. */
function previewScanReason(
  entry: QueueEntry,
  ctx: {
    projectKey: string;
    facts: ActiveRunFacts;
    liveByTicket: Map<string, QueueClaim>;
  },
): ScanPreview {
  // Neither ranked nor queued: outside claimNextEligible's scan domain entirely,
  // which only `--all` can put on the board. Named FIRST so the two checks below
  // stay a faithful mirror of the primitive's own order for every entry the scan
  // actually walks (an in-domain entry is ranked, or queued, or both).
  if (entry.rank === null && !entry.queued) return { reason: "not_a_queue_member", detail: null };
  if (entry.rank === null) return { reason: "unranked", detail: null };
  if (!entry.queued) return { reason: "not_a_queue_member", detail: null };
  if (entry.status === "deferred") {
    return {
      reason: "deferred",
      detail: "deferred tickets keep rank, membership and history but never execute",
    };
  }
  if (entry.status !== "active") return { reason: "not_active", detail: entry.status };
  if (entry.blocked) {
    return { reason: "queue_blocked", detail: "the queue projection reports this entry blocked" };
  }
  if (entry.readiness === null) return { reason: "readiness_ineligible", detail: "never assessed" };
  if (entry.readiness.stale) {
    return {
      reason: "readiness_ineligible",
      detail: `stale assessment (${entry.readiness.outcome})`,
    };
  }
  if (!EXECUTABLE_OUTCOMES.has(entry.readiness.outcome)) {
    return { reason: "readiness_ineligible", detail: entry.readiness.outcome };
  }

  const held = ctx.liveByTicket.get(entry.ticketId);
  // STRICTLY expired, or it is not recoverable — a live lease is not stealable, and
  // an expired one is a takeover candidate rather than an exclusion.
  const recoverable = held !== undefined && held.leaseExpiresAtMs < ctx.facts.hydratedAtMs;
  if (held !== undefined && !recoverable) {
    return {
      reason: "already_claimed",
      detail: `held by ${held.owner} (generation ${held.generation})`,
    };
  }

  const row = getTicket(ctx.projectKey, entry.ticketId);
  if (row === undefined) {
    // The ticket vanished between the queue read and this one. Report it as the
    // scan would rather than crashing a read surface.
    return { reason: "not_active", detail: "the ticket row disappeared mid-read" };
  }
  const verdict = evaluateCompatibility(
    ctx.facts,
    {
      ticketId: entry.ticketId,
      rank: entry.rank,
      type: entry.type,
      status: entry.status,
      title: entry.title,
      revision: row.revision ?? 0,
      readinessOutcome: entry.readiness.outcome,
    },
    ctx.facts.activeRuns.map((f) => ({
      claimId: f.claimId,
      projectKey: f.projectKey,
      ticketId: f.ticketId,
      owner: f.owner,
      generation: f.generation,
      leaseExpiresAtMs: f.leaseExpiresAtMs,
      launchId: f.launchId,
      runId: f.runId,
    })),
  );
  if (!verdict.compatible) return { reason: "incompatible", detail: verdict.reason };
  return { reason: "eligible", detail: null };
}

function toBoardReadiness(entry: QueueEntry): BoardReadiness | null {
  const r = entry.readiness;
  if (r === null) return null;
  return {
    outcome: r.outcome,
    stale: r.stale,
    gaps: r.gaps,
    refinementProposal: r.refinementProposal,
    revision: r.revision,
    evaluatedAt: r.evaluatedAt,
  };
}

/** THE BOARD READ. One pass, no writes, no outbound calls.
 *
 *  `all` widens the domain from the queue-relevant set (ranked OR queued, which is
 *  exactly claimNextEligible's scan domain) to every ticket of the project, so the
 *  Backlog column can show unranked work an operator has not stack-ranked yet. */
export function readBoard(projectKey: string, opts: { all?: boolean } = {}): BoardView {
  const entries = queueView(projectKey);
  const liveByTicket = new Map(liveClaims(projectKey).map((c) => [c.ticketId, c]));
  const facts = hydrateActiveRunFacts({ projectKey, capacityScope: CAPACITY_SCOPE });

  if (opts.all) {
    // The wider domain. Every derived fact is read through the SAME predicates
    // queueView uses — a ticket nobody ranked can still be blocked, still be
    // executing (the dequeued-and-unranked container, which is a real state, not a
    // gap), and still carry the assessment a refused enqueue committed. Defaulting
    // any of those to false would make the widened rows quietly less true than the
    // rest of the board.
    const seen = new Set(entries.map((e) => e.ticketId));
    for (const t of ticketsForProject(projectKey)) {
      if (seen.has(t.ticketId)) continue;
      entries.push({
        ticketId: t.ticketId,
        title: t.title,
        type: t.type,
        status: t.status,
        rank: null,
        queued: false,
        blocked: isQueueBlocked(projectKey, t.ticketId),
        inProgress: isInProgress(projectKey, t.ticketId),
        readiness: readinessView(projectKey, t.ticketId),
      });
    }
  }

  const rows: BoardRow[] = entries.map((entry) => {
    const scan = previewScanReason(entry, { projectKey, facts, liveByTicket });
    const held = liveByTicket.get(entry.ticketId);
    return {
      ticketId: entry.ticketId,
      title: entry.title,
      type: entry.type,
      status: entry.status,
      rank: entry.rank,
      queued: entry.queued,
      blocked: entry.blocked,
      inProgress: entry.inProgress,
      projection: projectionOf(entry),
      readiness: toBoardReadiness(entry),
      scan,
      claim:
        held === undefined
          ? null
          : {
              claimId: held.id,
              owner: held.owner,
              generation: held.generation,
              leaseExpiresAtMs: held.leaseExpiresAtMs,
              leaseExpired: held.leaseExpiresAtMs < facts.hydratedAtMs,
              launchId: held.launchId,
              runId: held.runId,
            },
    };
  });

  return {
    projectKey,
    version: queueVersion(projectKey),
    capacityScope: CAPACITY_SCOPE,
    capacityApplied: false,
    rows,
  };
}

// ─── rendering ───────────────────────────────────────────────────────────────

const PROJECTION_TITLES: Record<BoardProjection, string> = {
  backlog: "Backlog",
  queued: "Queued",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

/** The operator-facing line for a scan reason. The LABELS are the load-bearing part:
 *  `blocked:` and `waiting:` are different words for different facts, and an operator
 *  must be able to tell "someone has to clear this" from "this clears itself when the
 *  active set changes" without reading the detail string. */
function scanLabel(scan: ScanPreview): string | null {
  switch (scan.reason) {
    case "eligible":
      return "ready to dispatch";
    case "incompatible":
      // NOT blocked. A temporary scheduling wait, named as one.
      return `waiting (scheduling): ${scan.detail ?? "temporarily incompatible with the active runs"}`;
    case "queue_blocked":
      return `blocked: ${scan.detail ?? "blocker evidence is recorded against this ticket"}`;
    case "readiness_ineligible":
      return `not ready: ${scan.detail ?? "no assessment"}`;
    case "already_claimed":
      return `claimed: ${scan.detail ?? "a live claim holds this ticket"}`;
    case "deferred":
    case "not_active":
    case "unranked":
      return `ineligible (${scan.reason}): ${scan.detail ?? ""}`.trimEnd();
    case "not_a_queue_member":
      return null;
    case "capacity":
      // Never produced by this surface (see the header); handled for totality.
      return `capacity: ${scan.detail ?? ""}`.trimEnd();
  }
}

function renderRow(row: BoardRow): string[] {
  const rank = row.rank === null ? "  -" : String(row.rank).padStart(3);
  const flags = [
    row.queued ? "queued" : null,
    row.readiness ? `readiness=${row.readiness.outcome}${row.readiness.stale ? " (STALE)" : ""}` : null,
    row.claim ? `claim ${row.claim.owner}${row.claim.leaseExpired ? " (lease EXPIRED)" : ""}` : null,
  ].filter((f): f is string => f !== null);
  const lines = [
    `    ${rank}  ${row.ticketId}  ${row.title}${flags.length > 0 ? `  [${flags.join(", ")}]` : ""}`,
  ];
  const label = scanLabel(row.scan);
  if (label !== null) lines.push(`          ${label}`);
  return lines;
}

export function printBoard(view: BoardView): void {
  console.log(`project ${view.projectKey} — queue version ${view.version}`);
  for (const projection of BOARD_PROJECTIONS) {
    const rows = view.rows.filter((r) => r.projection === projection);
    if (rows.length === 0) continue;
    console.log(`  ${PROJECTION_TITLES[projection]} (${rows.length})`);
    for (const row of rows) for (const line of renderRow(row)) console.log(line);
  }
  if (view.rows.length === 0) console.log("  (no ranked or queued tickets)");
  console.log(
    `  capacity is not applied to this view — the ceiling is enforced inside the claim ` +
      `transaction, in ${view.capacityScope} scope.`,
  );
}

/** The queue as a write verb reports it back: the members, in canonical order, with
 *  the same labels `list` uses. */
function printQueueAfterWrite(projectKey: string): void {
  const view = readBoard(projectKey);
  const members = view.rows.filter((r) => r.queued);
  if (members.length === 0) {
    console.log("  (the operator queue is empty)");
    return;
  }
  console.log("  queue:");
  for (const row of members) for (const line of renderRow(row)) console.log(line);
}

// ─── shared plumbing ─────────────────────────────────────────────────────────

/** THE MARKDOWN-MODE REFUSAL, by name. Same guard and same reasoning as FG-609's
 *  (src/cli/commands/backlog.ts): in markdown mode the DB tickets table is a
 *  WRITE-ONLY SHADOW of the last import, so a queue write would rank and queue rows
 *  nobody reads, and a readiness refusal would quote content the operator no longer
 *  has on disk. `list` refuses for the same reason a write does — a board rendered
 *  from a shadow reads as "nothing is queued" rather than as "this project has no
 *  queue", and those are different answers. */
export function requireQueueProject(verb: string, projectDir: string): string {
  const store = resolveBacklogStore(projectDir);
  if (store.mode !== "db" || !store.projectKey) {
    const why =
      store.projectKey === null
        ? `this project has no resolvable project_key`
        : `this project's backlog is in markdown mode (project_key=${store.projectKey})`;
    throw new QueueRefusal(
      `forge: queue ${verb} refuses — ${why}. The operator queue is durable DB state (rank, ` +
        `membership, readiness, queue history) and there is no Markdown representation of it, so ` +
        `running it here would ${verb === "list" ? "render a board nothing writes" : "write rows nothing reads"}. ` +
        `Cut this project over with \`forge backlog migrate\` first.`,
      verb,
      null,
    );
  }
  return store.projectKey;
}

/** Positions and versions are parsed STRICTLY, never with parseInt — '2x' is 2 and
 *  '1.9' is 1 there, so a typed value that means nothing would silently become a
 *  different, valid-looking move. FG-609's rule, restated for this file's flags. */
function parseCount(raw: string, verb: string, flag: string, allowZero: boolean): number {
  const pattern = allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new QueueRefusal(
      `forge: queue ${verb} refuses — ${flag} must be a whole ${allowZero ? "non-negative" : "positive"} ` +
        `number (${allowZero ? "0, 1, 2, …" : "1, 2, 3, …"}), got '${raw}'. Nothing was written.`,
      verb,
      null,
    );
  }
  return Number(raw);
}

/** The optimistic-concurrency opt-in, as the CLI spells it. Omitted means "apply
 *  unconditionally", which is FG-609's behaviour and stays the default. */
function reorderOptions(verb: string, raw: string | undefined): { expectedVersion?: number } {
  if (raw === undefined) return {};
  return { expectedVersion: parseCount(raw, verb, "--expect-version", true) };
}

type QueueVerbResult = Record<string, unknown> & { message?: string; refusal?: string };

/** One shape for every verb in this group: resolve the project and refuse BY NAME,
 *  run, then render. A refusal exits non-zero with the concrete reason on stderr and
 *  the verb writes nothing. Exported so the dispatcher control verbs land on the same
 *  plumbing rather than a second copy of it. */
export function runQueueVerb(
  verb: string,
  opts: { project?: string; json?: boolean },
  run: (projectKey: string) => QueueVerbResult,
): void {
  runProjectVerb(verb, opts, run, (projectKey) => printQueueAfterWrite(projectKey));
}

/** runQueueVerb's core, with the RENDERING left to the caller. The dispatcher control
 *  verbs land on exactly this project resolution, this refusal handling and this exit
 *  code — they just do not print the operator queue afterwards. */
function runProjectVerb(
  verb: string,
  opts: { project?: string; json?: boolean },
  run: (projectKey: string) => QueueVerbResult,
  renderHuman: (projectKey: string, result: QueueVerbResult) => void,
  jsonEnvelope: (projectKey: string) => Record<string, unknown> = (projectKey) => ({
    projectKey,
    version: queueVersion(projectKey),
  }),
): void {
  const dir = resolve(opts.project ?? process.cwd());
  let projectKey: string;
  try {
    projectKey = requireQueueProject(verb, dir);
  } catch (e) {
    if (!(e instanceof QueueRefusal)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  let result: QueueVerbResult;
  try {
    result = run(projectKey);
  } catch (e) {
    if (!(e instanceof QueueRefusal)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...jsonEnvelope(projectKey), ...result }, null, 2));
  } else {
    if (result.refusal) process.stderr.write(`${String(result.refusal)}\n`);
    if (result.message) console.log(String(result.message));
    renderHuman(projectKey, result);
  }
  if (result.refusal) process.exitCode = 1;
}

/** The dispatcher control verbs' runner: the same resolution, the same named
 *  refusals, the same exit codes — and no operator-queue render, because these verbs
 *  are about the dispatcher, not about the queue's contents. */
function runDispatcherVerb(
  verb: string,
  opts: { project?: string; json?: boolean },
  run: (projectKey: string) => QueueVerbResult,
  renderHuman: (projectKey: string, result: QueueVerbResult) => void = () => {},
): void {
  runProjectVerb(verb, opts, run, renderHuman, (projectKey) => ({ projectKey }));
}

// ─── the dispatcher control surface — EXECUTION AUTHORITY, CLI-ONLY (D2) ─────
//
// Everything above this line is PLANNING intent. Everything below it is
// AUTHORIZATION to run repo-writing containers unattended, and the two are kept
// apart on purpose:
//
//   * `arm` / `set --max-active-runs` decide WHETHER and HOW MANY containers forge
//     may start with nobody watching. That is a materially larger capability than
//     anything on the planning surface, which is why FG-591 D2 keeps it OFF the
//     dashboard's unauthenticated localhost HTTP surface entirely — not disabled
//     there, ABSENT there. A route that arms dispatch would make every local
//     process, and every page the operator happens to have open, a trigger.
//   * every verb here refuses inside an agent container. A dispatched agent that
//     could arm dispatch, raise the ceiling or cancel a peer's run would be
//     escalating from "write my own result" to "start and stop host containers",
//     and the host store it would have to reach for that is the SHARED
//     forge-claude-oauth volume, so the answer would be wrong as well as
//     privileged. Default-deny, including on the read verb.
//   * `run` is the long-lived process. It never arms anything: starting a
//     dispatcher and authorizing it to claim are two separate operator acts, so
//     neither can be performed by accident while doing the other.
//
// THE ADMISSION-TEST RULE, restated because it is the one thing that must not be
// implemented as convenience: disarming and lowering the ceiling are facts
// consulted BEFORE a claim. Neither is a reaper. No verb here terminates a
// container, releases a claim or shortens a lease, and `queue cancel` — the one
// verb that does stop work — stops it FIRST and lets the claim's own lease owner
// retire the reservation afterwards (D4).

/** WHO a policy write is recorded as.
 *
 *  The OS identity is ALWAYS the record and `--by` cannot replace it, only annotate
 *  it. A local CLI cannot authenticate its caller — anyone who can run forge can
 *  write this store — so the honest thing is to record the identity the host will
 *  attribute the launched containers to, and let the operator add a label BESIDE it
 *  rather than INSTEAD of it. A free-text-only field would make the audit record of
 *  "who authorized unattended execution" say whatever the caller typed. */
export function resolveOperatorIdentity(label?: string): string {
  let who = "unknown-user";
  try {
    who = userInfo().username || who;
  } catch {
    /* no passwd entry (a minimal container, an nss edge) — recorded as unknown, never guessed */
  }
  let where = "unknown-host";
  try {
    where = hostname() || where;
  } catch {
    /* same */
  }
  const base = `${who}@${where}`;
  const trimmed = label?.trim();
  return trimmed ? `${trimmed} (${base})` : base;
}

/** THE SIX ANSWERS THE AC REQUIRES TO BE DISTINGUISHABLE, plus the three that are
 *  not "nothing is running" at all. Every one is read out of DURABLE state — the
 *  policy row, the lease row and the dispatcher's own evaluation record — and none
 *  is inferred from the absence of something.
 *
 *    dispatching         — the last pass GRANTED. Work is being started.
 *    disarmed            — autonomous dispatch is off. The operator's own choice.
 *    dispatcher_down     — no dispatcher, a dead one, or a live lease whose watchdog
 *                          deadline passed. NOT the same as "nothing to do", and
 *                          collapsing the two is the blindness this ticket closes.
 *    no_capacity         — the ceiling refused an otherwise-eligible candidate. Under
 *                          a host-scoped ceiling this NAMES the holding projects.
 *    blocked             — the scan walked the queue and its candidates carry blocker
 *                          evidence. Someone has to clear it.
 *    incompatible        — a TEMPORARY scheduling wait. Nobody has to do anything; it
 *                          clears when the active set changes. Never rendered as
 *                          blocked, and never written to blocker_evidence.
 *    no_eligible_work    — the scan ran and selected nothing for any other reason.
 *    lost                — a claim attempt lost its re-validation; the next pass
 *                          re-scans.
 *    awaiting_evaluation — a dispatcher holds the lease but no pass has evaluated the
 *                          queue under the CURRENT authorization yet. */
export type DispatcherStatusState =
  | "dispatching"
  | "disarmed"
  | "dispatcher_down"
  | "no_capacity"
  | "blocked"
  | "incompatible"
  | "no_eligible_work"
  | "lost"
  | "awaiting_evaluation";

export const DISPATCHER_STATUS_STATES: readonly DispatcherStatusState[] = [
  "dispatching",
  "disarmed",
  "dispatcher_down",
  "no_capacity",
  "blocked",
  "incompatible",
  "no_eligible_work",
  "lost",
  "awaiting_evaluation",
];

export type StatusEvaluationView = {
  id: number;
  reason: DispatcherEvaluation["reason"];
  detail: string | null;
  dispatcherOwner: string;
  dispatcherGeneration: number | null;
  claimedTicketId: string | null;
  wakeKind: string | null;
  capacityScope: CapacityScope | null;
  capacityLimit: number | null;
  capacityUsed: number | null;
  capacityHolders: CapacityHolder[] | null;
  evaluatedAt: string;
  evaluatedAtMs: number;
  /** How many candidates the pass actually walked. Null when nothing was scanned —
   *  which is a different fact from "the queue was scanned and was empty". */
  scannedCount: number | null;
};

export type DispatcherStatus = {
  projectKey: string;
  state: DispatcherStatusState;
  headline: string;
  /** EVERY independently-true reason a new claim cannot be granted right now. `state`
   *  is one answer chosen by precedence; this is the whole list, so a precedence rule
   *  never hides a second thing the operator would have to fix. */
  blockers: string[];
  armed: boolean;
  policy: {
    maxActiveRuns: number;
    capacityScope: CapacityScope;
    leaseTtlMs: number;
    heartbeatMs: number;
    defaultWorkflow: string;
    /** false when no policy row has ever been written: every value beside it is a
     *  documented default rather than an operator decision, and saying so is the
     *  difference between "configured to 1" and "never configured". */
    configured: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
  };
  /** The dispatcher IDENTITY, or null when no process has ever held one. */
  dispatcher: {
    owner: string;
    generation: number;
    leaseExpiresAtMs: number;
    leaseExpiresAt: string;
    live: boolean;
    expired: boolean;
    msSinceHeartbeat: number | null;
    host: string | null;
    pid: number | null;
  } | null;
  lastEvaluation: StatusEvaluationView | null;
  /** True when the policy was written AFTER the last recorded pass: the state below
   *  is an honest record of a decision made under different authorization, and the
   *  next wake or watchdog tick is what will re-decide under the current one. */
  evaluationPredatesPolicy: boolean;
  /** The last pass that the CEILING refused, kept separately from the last pass:
   *  the latest pass may since have granted, and "which project held the slots when
   *  I waited" is still the operator's question. */
  lastCapacityRefusal: StatusEvaluationView | null;
  /** Read out of the recorded scan evidence, never re-derived. Two lists because
   *  they are two different facts with two different operator actions. */
  blockedCandidates: { ticketId: string; detail: string | null }[];
  incompatibleWaits: { ticketId: string; detail: string | null }[];
  capacity: {
    scope: CapacityScope;
    limit: number;
    /** Live claims in scope AT THIS READ. A report — the ceiling is enforced only
     *  inside claimNextEligible's write transaction and never here. */
    used: number;
    holders: CapacityHolder[];
    /** The other projects holding slots under a host-scoped ceiling. Empty is a real
     *  answer, not a missing one. */
    otherProjects: string[];
  };
  watchdog: {
    /** The deadline the last pass ARMED. */
    deadlineMs: number | null;
    deadlineAt: string | null;
    /** false when no pass has ever run — distinct from a pass that armed no deadline. */
    everEvaluated: boolean;
    overdue: boolean;
  };
  pendingWakes: number;
  liveClaims: {
    claimId: string;
    ticketId: string;
    owner: string;
    generation: number;
    launchId: string | null;
    runId: string | null;
    leaseExpiresAtMs: number;
    leaseExpired: boolean;
  }[];
  nowMs: number;
};

function scanEntriesWith(evaluation: DispatcherEvaluation | undefined, reason: ScanReason): ScanEntry[] {
  return (evaluation?.scanEvidence ?? []).filter((e) => e.reason === reason);
}

function toEvaluationView(e: DispatcherEvaluation | undefined): StatusEvaluationView | null {
  if (e === undefined) return null;
  return {
    id: e.id,
    reason: e.reason,
    detail: e.detail,
    dispatcherOwner: e.dispatcherOwner,
    dispatcherGeneration: e.dispatcherGeneration,
    claimedTicketId: e.claimedTicketId,
    wakeKind: e.wakeKind,
    capacityScope: e.capacityScope,
    capacityLimit: e.capacityLimit,
    capacityUsed: e.capacityUsed,
    capacityHolders: e.capacityHolders,
    evaluatedAt: e.evaluatedAt,
    evaluatedAtMs: e.evaluatedAtMs,
    scannedCount: e.scanEvidence === null ? null : e.scanEvidence.length,
  };
}

/**
 * WHICH of the six answers this is, derived from the durable record alone.
 *
 * Pure and exported so the precedence is testable without a store: the ONLY inputs
 * are the policy row's `armed`, the health read's own alert (which is itself derived
 * from the lease row and the last pass's armed watchdog deadline) and the recorded
 * evaluation. Nothing here guesses from an absence.
 *
 * PRECEDENCE, stated because it is the whole definition:
 *   1. disarmed        — the operator turned it off. No other fact can produce a
 *                        claim while that is true, so it is the answer.
 *   2. dispatcher_down — nothing is looking. A recorded evaluation then describes the
 *                        past, not now, so it must not be reported as the current
 *                        reason.
 *   3. the evaluation  — the dispatcher is armed and alive, so the last pass IS the
 *                        current reason.
 * Whatever precedence hides still appears in `blockers`.
 */
export function classifyDispatcherState(input: {
  armed: boolean;
  maxActiveRuns: number;
  healthAlert: string | null;
  latest: DispatcherEvaluation | undefined;
  policyUpdatedAtMs: number | null;
}): {
  state: DispatcherStatusState;
  headline: string;
  blockers: string[];
  blockedCandidates: { ticketId: string; detail: string | null }[];
  incompatibleWaits: { ticketId: string; detail: string | null }[];
  /** The recorded pass predates the current policy write, so it describes a decision
   *  made under a different authorization. Said out loud rather than left to be
   *  noticed: `no_capacity`, read a second after the ceiling was raised, is a true
   *  record of the past and a misleading answer about now. */
  evaluationPredatesPolicy: boolean;
} {
  const { armed, latest } = input;
  const evaluationPredatesPolicy =
    latest !== undefined && input.policyUpdatedAtMs !== null && input.policyUpdatedAtMs > latest.evaluatedAtMs;
  const blockedCandidates = scanEntriesWith(latest, "queue_blocked").map((e) => ({
    ticketId: e.ticketId,
    detail: e.detail,
  }));
  const incompatibleWaits = scanEntriesWith(latest, "incompatible").map((e) => ({
    ticketId: e.ticketId,
    detail: e.detail,
  }));

  const blockers: string[] = [];
  if (!armed) {
    blockers.push(
      `autonomous dispatch is DISARMED — no claim will be granted for any project on this host until ` +
        `\`forge queue dispatcher arm\` is run. Work already running is unaffected.`,
    );
  }
  if (armed && input.maxActiveRuns === 0) {
    blockers.push(
      `max_active_runs is 0 — dispatch is armed but the ceiling admits nothing. This is a legal ` +
        `configuration ("admit nothing") and is reported rather than corrected.`,
    );
  }
  if (input.healthAlert !== null) blockers.push(input.healthAlert);

  // The evaluation-derived answer, computed even when precedence will not use it, so
  // the reasoning stays in one place.
  let evalState: DispatcherStatusState;
  let evalHeadline: string;
  if (latest === undefined) {
    evalState = "awaiting_evaluation";
    evalHeadline =
      `no dispatcher pass has ever evaluated this project's queue, so there is no durable answer to ` +
      `"why is nothing running" yet.`;
  } else if (latest.reason === "disabled" && armed) {
    // The record is honest and STALE: it was written while dispatch was off, and
    // dispatch has been armed since. Reporting it as `disarmed` would contradict the
    // policy row; reporting it as a scan result would invent a scan that never ran.
    evalState = "awaiting_evaluation";
    evalHeadline =
      `the latest recorded pass ran while dispatch was DISARMED (${latest.evaluatedAt}); no pass has ` +
      `evaluated the queue since it was armed. The next wake or watchdog tick will.`;
  } else if (latest.reason === "disabled") {
    evalState = "disarmed";
    evalHeadline = latest.detail ?? `autonomous dispatch is disarmed; nothing was scanned.`;
  } else if (latest.reason === "granted") {
    evalState = "dispatching";
    evalHeadline = `the last pass CLAIMED ${latest.claimedTicketId ?? "a ticket"} — work is being started.`;
  } else if (latest.reason === "no_capacity") {
    const others = [
      ...new Set((latest.capacityHolders ?? []).map((h) => h.projectKey).filter((k) => k !== latest.projectKey)),
    ];
    evalState = "no_capacity";
    evalHeadline =
      `the ceiling refused an otherwise-eligible candidate: ${latest.capacityUsed ?? "?"}/` +
      `${latest.capacityLimit ?? "?"} live claims in ${latest.capacityScope ?? "?"} scope` +
      `${others.length > 0 ? `, with slots held by ${others.join(", ")}` : ""}. Nothing was terminated and ` +
      `no rank moved.`;
  } else if (latest.reason === "incompatible_only") {
    evalState = "incompatible";
    const first = incompatibleWaits[0];
    evalHeadline =
      `a queued, ready candidate is waiting on SCHEDULING, not on a blocker: ` +
      `${first ? `${first.ticketId} — ${first.detail ?? "cannot safely overlap the active set"}` : (latest.detail ?? "temporarily incompatible with the active set")} ` +
      `It keeps its rank and its membership and is reconsidered as soon as the active set changes.`;
  } else if (latest.reason === "lost") {
    evalState = "lost";
    evalHeadline =
      `the last claim attempt lost its re-validation — a concurrent dispatcher won the ticket, or a ` +
      `durable fact moved under the scan. Nothing was written; the next pass re-scans.`;
  } else if (blockedCandidates.length > 0) {
    evalState = "blocked";
    evalHeadline =
      `the scan walked the queue and ${blockedCandidates.length} candidate` +
      `${blockedCandidates.length === 1 ? " carries" : "s carry"} blocker evidence ` +
      `(${blockedCandidates.map((b) => b.ticketId).join(", ")}). A blocker is durable and per-ticket: ` +
      `someone has to clear it.`;
  } else {
    evalState = "no_eligible_work";
    evalHeadline = latest.detail ?? `the scan selected nothing.`;
  }

  if (evalState === "no_capacity" || evalState === "blocked" || evalState === "incompatible") {
    blockers.push(evalHeadline);
  }

  const state: DispatcherStatusState = !armed ? "disarmed" : input.healthAlert !== null ? "dispatcher_down" : evalState;
  const headline =
    state === "disarmed" && latest?.reason !== "disabled"
      ? `autonomous dispatch is DISARMED. New claims are refused before anything is scanned; running work ` +
        `and its leases are untouched.`
      : state === "dispatcher_down"
        ? (input.healthAlert as string)
        : evalHeadline;

  return { state, headline, blockers, blockedCandidates, incompatibleWaits, evaluationPredatesPolicy };
}

/**
 * THE OPERATOR'S "why is nothing running" READ. A pure read: it renews nothing,
 * starts nothing and writes nothing, so it is safe from a CLI, a test or a handler.
 */
export function readDispatcherStatus(projectKey: string): DispatcherStatus {
  const health: DispatcherHealth = dispatcherHealth(projectKey);
  const policy: DispatcherPolicy = health.policy;
  const holders = capacityHoldersFrom(liveClaimsInScope(policy.capacityScope, projectKey));
  const classified = classifyDispatcherState({
    armed: policy.armed,
    maxActiveRuns: policy.maxActiveRuns,
    healthAlert: health.alert,
    latest: health.latestEvaluation,
    policyUpdatedAtMs: policy.updatedAt === null ? null : Date.parse(policy.updatedAt),
  });

  const lease = health.lease.lease;
  return {
    projectKey,
    state: classified.state,
    headline: classified.headline,
    blockers: classified.blockers,
    armed: policy.armed,
    policy: {
      maxActiveRuns: policy.maxActiveRuns,
      capacityScope: policy.capacityScope,
      leaseTtlMs: policy.leaseTtlMs,
      heartbeatMs: policy.heartbeatMs,
      defaultWorkflow: policy.defaultWorkflow,
      configured: policy.configured,
      updatedAt: policy.updatedAt,
      updatedBy: policy.updatedBy,
    },
    dispatcher:
      lease === null
        ? null
        : {
            owner: lease.owner,
            generation: lease.generation,
            leaseExpiresAtMs: lease.leaseExpiresAtMs,
            leaseExpiresAt: new Date(lease.leaseExpiresAtMs).toISOString(),
            live: health.lease.live,
            expired: health.lease.expired,
            msSinceHeartbeat: health.lease.msSinceHeartbeat,
            host: lease.host,
            pid: lease.pid,
          },
    lastEvaluation: toEvaluationView(health.latestEvaluation),
    evaluationPredatesPolicy: classified.evaluationPredatesPolicy,
    lastCapacityRefusal: toEvaluationView(latestCapacityRefusal(projectKey)),
    blockedCandidates: classified.blockedCandidates,
    incompatibleWaits: classified.incompatibleWaits,
    capacity: {
      scope: policy.capacityScope,
      limit: policy.maxActiveRuns,
      used: holders.length,
      holders,
      otherProjects: [...new Set(holders.map((h) => h.projectKey).filter((k) => k !== projectKey))],
    },
    watchdog: {
      deadlineMs: health.nextWatchdogAtMs ?? null,
      deadlineAt:
        typeof health.nextWatchdogAtMs === "number" ? new Date(health.nextWatchdogAtMs).toISOString() : null,
      everEvaluated: health.nextWatchdogAtMs !== undefined,
      overdue: health.watchdogOverdue,
    },
    pendingWakes: health.pendingWakes,
    liveClaims: health.liveClaims.map((c) => ({
      claimId: c.id,
      ticketId: c.ticketId,
      owner: c.owner,
      generation: c.generation,
      launchId: c.launchId,
      runId: c.runId,
      leaseExpiresAtMs: c.leaseExpiresAtMs,
      leaseExpired: c.leaseExpiresAtMs < health.nowMs,
    })),
    nowMs: health.nowMs,
  };
}

function relativeMs(ms: number | null): string {
  if (ms === null) return "unknown";
  const abs = Math.abs(ms);
  const s = Math.round(abs / 1000);
  const rendered = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(s / 3600).toFixed(1)}h`;
  return ms >= 0 ? `${rendered} ago` : `in ${rendered}`;
}

export function printDispatcherStatus(status: DispatcherStatus): void {
  console.log(`dispatcher — project ${status.projectKey}`);
  console.log(`  state:     ${status.state}`);
  console.log(`  ${status.headline}`);
  console.log(
    `  armed:     ${status.armed ? "YES" : "no"}  (max_active_runs=${status.policy.maxActiveRuns}, ` +
      `${status.policy.capacityScope} scope, lease ${status.policy.leaseTtlMs}ms, heartbeat ` +
      `${status.policy.heartbeatMs}ms, workflow ${status.policy.defaultWorkflow})`,
  );
  console.log(
    status.policy.configured
      ? `             set by ${status.policy.updatedBy ?? "?"} at ${status.policy.updatedAt ?? "?"}`
      : `             NEVER CONFIGURED — every value above is a documented default, not a decision.`,
  );
  if (status.dispatcher === null) {
    console.log(`  lease:     none — no dispatcher has ever held this project's lease.`);
  } else {
    const d = status.dispatcher;
    console.log(
      `  lease:     ${d.owner} generation ${d.generation} — ${d.live ? "LIVE" : "EXPIRED"}, expires ` +
        `${d.leaseExpiresAt}, last heartbeat ${relativeMs(d.msSinceHeartbeat)}` +
        `${d.host ? ` (host ${d.host}${d.pid === null ? "" : `, pid ${d.pid}`})` : ""}`,
    );
  }
  if (status.lastEvaluation === null) {
    console.log(`  last look: none recorded.`);
  } else {
    const e = status.lastEvaluation;
    console.log(
      `  last look: ${e.reason} at ${e.evaluatedAt} (${relativeMs(status.nowMs - e.evaluatedAtMs)}) by ` +
        `${e.dispatcherOwner}#${e.dispatcherGeneration ?? "-"}, woken by ${e.wakeKind ?? "watchdog/refill"}, ` +
        `${e.scannedCount === null ? "nothing scanned" : `${e.scannedCount} candidate(s) scanned`}`,
    );
    if (e.detail) console.log(`             ${e.detail}`);
    if (status.evaluationPredatesPolicy) {
      console.log(
        `             NOTE: the policy was written AFTER this pass, so it records a decision made under ` +
          `different authorization. The next wake or watchdog tick re-decides under the current one.`,
      );
    }
  }
  console.log(
    `  watchdog:  ${
      !status.watchdog.everEvaluated
        ? "no pass has ever armed a deadline"
        : status.watchdog.deadlineAt === null
          ? "the last pass armed NO deadline — the dispatcher stopped re-arming"
          : `next at ${status.watchdog.deadlineAt} (${relativeMs(status.nowMs - (status.watchdog.deadlineMs as number))})${status.watchdog.overdue ? " — OVERDUE" : ""}`
    }`,
  );
  console.log(
    `  capacity:  ${status.capacity.used}/${status.capacity.limit} live claims in ` +
      `${status.capacity.scope} scope` +
      `${status.capacity.otherProjects.length > 0 ? `, slots held by ${status.capacity.otherProjects.join(", ")}` : ""}`,
  );
  for (const h of status.capacity.holders) {
    console.log(
      `               ${h.claimId}  ${h.projectKey}/${h.ticketId}  owner ${h.owner}` +
        `${h.runId ? `  run ${h.runId}` : h.launchId ? `  launch ${h.launchId}` : `  (no launch yet)`}`,
    );
  }
  if (status.blockedCandidates.length > 0) {
    console.log(`  blocked:   ${status.blockedCandidates.map((b) => b.ticketId).join(", ")} — someone must clear these`);
  }
  for (const w of status.incompatibleWaits) {
    console.log(`  waiting (scheduling): ${w.ticketId} — ${w.detail ?? "cannot safely overlap the active set"}`);
  }
  console.log(`  pending wakes: ${status.pendingWakes}`);
  if (status.blockers.length > 0) {
    console.log(`  why no NEW claim can be granted right now:`);
    for (const b of status.blockers) console.log(`    - ${b}`);
  }
}

/** The forge CLI's own argv prefix, so a launched child is THIS forge. campaign.ts's
 *  formula verbatim rather than a second derivation. */
function forgeSelfArgv(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? ""];
}

/** The container refusal for the EXECUTION-AUTHORITY verbs. Deliberately not
 *  refuseContainerMutation: that message is about ticket mutation and this is about
 *  starting and stopping host containers, which is a different (larger) capability
 *  and deserves its own words. The READ verb refuses too — a container's host-store
 *  resolution lands on the shared forge-claude-oauth volume, so it would answer
 *  plausibly and wrongly about another project's dispatcher. */
function refuseDispatcherVerbInContainer(verb: string): never {
  throw new ContainerMutationRefused(
    `forge: refusing \`queue ${verb}\` — this is the dispatcher's EXECUTION-AUTHORITY surface and no ` +
      `agent container may reach it. Arming autonomous dispatch, changing the capacity ceiling, running ` +
      `the dispatcher and cancelling a claim all decide whether host containers start and stop; a ` +
      `dispatched agent granting itself any of them would be escalating from "write my own result" to ` +
      `"drive the host". The host store is unreachable from here in any case, so the answer would be ` +
      `wrong as well as privileged. Run this on the host.`,
  );
}

type PolicyFlagOpts = {
  maxActiveRuns?: string;
  leaseTtl?: string;
  heartbeat?: string;
  workflow?: string;
  by?: string;
};

/** The policy write shared by `arm`, `disarm` and `set`. `armed` is passed
 *  explicitly (never inferred from the flags) so no flag can arm dispatch as a side
 *  effect of tuning it. */
function writePolicy(
  verb: string,
  projectKey: string,
  armed: boolean | undefined,
  opts: PolicyFlagOpts,
): QueueVerbResult {
  const updatedBy = resolveOperatorIdentity(opts.by);
  const before = readDispatcherStatus(projectKey).policy;

  const policy = setDispatcherPolicy({
    ...(armed === undefined ? {} : { armed }),
    ...(opts.maxActiveRuns === undefined
      ? {}
      : { maxActiveRuns: parseCount(opts.maxActiveRuns, verb, "--max-active-runs", true) }),
    ...(opts.leaseTtl === undefined ? {} : { leaseTtlMs: parseCount(opts.leaseTtl, verb, "--lease-ttl", false) }),
    ...(opts.heartbeat === undefined ? {} : { heartbeatMs: parseCount(opts.heartbeat, verb, "--heartbeat", false) }),
    ...(opts.workflow === undefined ? {} : { defaultWorkflow: opts.workflow }),
    updatedBy,
  });

  // The wake, so a running dispatcher re-evaluates on the CHANGE rather than at the
  // next watchdog tick (AC15 names capacity and policy changes as wake sources). The
  // policy is host-wide but a wake is per-project: this records one for the project
  // the operator ran in, and every OTHER project's dispatcher picks the change up on
  // its own watchdog. That is the documented fallback doing exactly its job — the
  // change is durable the instant it is written, and no claim can be granted against
  // the old value once it is.
  const capacityMoved = policy.maxActiveRuns !== before.maxActiveRuns || policy.capacityScope !== before.capacityScope;
  const kind: WakeKind = capacityMoved ? "capacity_changed" : "policy_changed";
  recordWake({
    projectKey,
    kind,
    wakeKey: capacityMoved ? "capacity" : "policy",
    detail:
      `${verb} by ${updatedBy}: armed=${policy.armed}, max_active_runs=${policy.maxActiveRuns}, ` +
      `${policy.capacityScope} scope, lease ${policy.leaseTtlMs}ms, heartbeat ${policy.heartbeatMs}ms`,
  });

  const notes: string[] = [];
  if (policy.maxActiveRuns < before.maxActiveRuns) {
    notes.push(
      `The ceiling went from ${before.maxActiveRuns} to ${policy.maxActiveRuns}. This is an ADMISSION test, ` +
        `not a reaper: nothing running was terminated, no claim was released and no lease was shortened. ` +
        `Live claims above the new ceiling simply keep running until they finish.`,
    );
  }
  if (armed === false) {
    notes.push(
      `Disarm blocks NEW claims only. Running containers keep running, their claims keep their leases, ` +
        `and the dispatcher keeps heartbeating them. To stop work, use \`forge queue cancel <ticket>\`.`,
    );
  }
  if (armed === true) {
    notes.push(
      `Arming AUTHORIZES unattended container execution up to ${policy.maxActiveRuns} concurrent ` +
        `queue-owned run(s) in ${policy.capacityScope} scope, recorded against ${updatedBy}. It does not ` +
        `start a dispatcher — run \`forge queue dispatcher run\` for that.`,
    );
  }

  return {
    action: verb,
    scope: "host",
    armed: policy.armed,
    policy: {
      maxActiveRuns: policy.maxActiveRuns,
      capacityScope: policy.capacityScope,
      leaseTtlMs: policy.leaseTtlMs,
      heartbeatMs: policy.heartbeatMs,
      defaultWorkflow: policy.defaultWorkflow,
      updatedAt: policy.updatedAt,
      updatedBy: policy.updatedBy,
    },
    wake: kind,
    notes,
    message: [
      `${verb}: autonomous dispatch is ${policy.armed ? "ARMED" : "DISARMED"} host-wide ` +
        `(max_active_runs=${policy.maxActiveRuns}, ${policy.capacityScope} scope), recorded against ` +
        `${policy.updatedBy ?? updatedBy} at ${policy.updatedAt ?? "?"}.`,
      ...notes,
    ].join("\n  "),
  };
}

// ─── the command group ───────────────────────────────────────────────────────

export function registerQueue(program: Command): void {
  const queue = program
    .command("queue")
    .description(
      "The operator work queue: stack-rank, select, and read the board. Planning intent only — " +
        "queue membership is never execution authorization.",
    );

  // FG-609's container rule, applied to this group's WRITERS. They write host
  // operator state (rank, membership, readiness, queue history) that lives only in
  // the host store — no snapshot representation, no container consumer — so they
  // refuse under EVERY container authority mode, markdown dispatch included. The
  // ENFORCEMENT half is the docker mount, not this check.
  const CONTAINER_REFUSED_VERBS = new Set([
    "enqueue",
    "dequeue",
    "rank-before",
    "rank-after",
    "reorder",
  ]);
  queue.hook("preAction", (_thisCommand, actionCommand) => {
    const verb = actionCommand.name();
    if (inContainerBacklogMode() && CONTAINER_REFUSED_VERBS.has(verb)) refuseContainerMutation(verb);
  });

  queue
    .command("list")
    .description(
      "Render the operator board: the five projections over rank, membership, lifecycle status, " +
        "blocker evidence and dispatch evidence, with the reason each queued item is not running.",
    )
    .option("--all", "include every ticket of the project, not just the ranked or queued ones")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON instead of the human-readable board")
    .action((opts: { all?: boolean; project?: string; json?: boolean }) => {
      const dir = resolve(opts.project ?? process.cwd());
      let projectKey: string;
      try {
        projectKey = requireQueueProject("list", dir);
      } catch (e) {
        if (!(e instanceof QueueRefusal)) throw e;
        process.stderr.write(`${e.message}\n`);
        process.exitCode = 1;
        return;
      }
      const view = readBoard(projectKey, opts.all ? { all: true } : {});
      if (opts.json) console.log(JSON.stringify(view, null, 2));
      else printBoard(view);
    });

  queue
    .command("enqueue")
    .argument("<id>", "ticket id (e.g. FG-123)")
    .description(
      "Select a ticket for execution. Refused unless its CURRENT revision evaluates ready (or " +
        "exploratory); the readiness assessment is recorded either way.",
    )
    .option("--note <text>", "operator note recorded with the membership")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((idArg: string, opts: { note?: string; project?: string; json?: boolean }) => {
      runQueueVerb("enqueue", opts, (projectKey) => {
        const res = enqueueTicket(projectKey, idArg, opts.note ? { note: opts.note } : {});
        if (!res.ok) {
          // The refusal COMMITTED its assessment — that is the audit record — so this
          // is reported, not thrown, and the exit code still says it did not queue.
          return {
            action: "enqueue",
            ticketId: idArg,
            enqueued: false,
            reason: res.reason,
            readiness: res.readiness,
            refusal: res.reason,
          };
        }
        return {
          action: "enqueue",
          ticketId: idArg,
          enqueued: true,
          position: res.position,
          queue: res.queue,
          readiness: res.readiness,
          message: `Queued ${idArg} at position ${res.position} (readiness: ${res.readiness.outcome})`,
        };
      });
    });

  queue
    .command("dequeue")
    .argument("<id>", "ticket id (e.g. FG-123)")
    .description(
      "Unselect a ticket. Its RANK IS RETAINED, and a live claim is NEVER released — dequeue is a " +
        "planning act. Use `forge queue cancel` to stop work that is already running.",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((idArg: string, opts: { project?: string; json?: boolean }) => {
      runQueueVerb("dequeue", opts, (projectKey) => {
        const res = dequeueTicket(projectKey, idArg);
        return {
          action: "dequeue",
          ticketId: idArg,
          queue: res.queue,
          message: `Dequeued ${idArg} (rank retained; any running work is untouched)`,
        };
      });
    });

  const relative = (placement: "before" | "after"): void => {
    const verb = `rank-${placement}`;
    queue
      .command(verb)
      .argument("<id>", "the queued ticket to move")
      .argument("<reference>", "the queued ticket to place it relative to")
      .description(
        `Move a queued ticket to immediately ${placement.toUpperCase()} another one. Relative intent, ` +
          `not a position: it still means the same thing if the queue moved.`,
      )
      .option("--expect-version <n>", "the queue version this was composed against (see `forge queue list`)")
      .option("--project <dir>", "project directory (default: cwd)")
      .option("--json", "emit JSON result")
      .action(
        (
          idArg: string,
          referenceArg: string,
          opts: { expectVersion?: string; project?: string; json?: boolean },
        ) => {
          runQueueVerb(verb, opts, (projectKey) => {
            const move = placement === "before" ? rankBefore : rankAfter;
            const res = move(projectKey, idArg, referenceArg, reorderOptions(verb, opts.expectVersion));
            return {
              action: verb,
              ticketId: idArg,
              relativeTo: referenceArg,
              position: res.position,
              queue: res.queue,
              message: `Moved ${idArg} ${placement} ${referenceArg} (queue position ${res.position})`,
            };
          });
        },
      );
  };
  relative("before");
  relative("after");

  queue
    .command("reorder")
    .argument("[id]", "ticket id to move (with --to)")
    .description(
      "Reorder the queue, atomically. Either move one ticket with --to, or set the whole order with " +
        "--order. Carry --expect-version to refuse rather than clobber a queue that moved.",
    )
    .option("--to <n>", "1-based position in the queue to move <id> to")
    .option("--order <ids>", "comma-separated exact permutation of the current queue")
    .option("--expect-version <n>", "the queue version this was composed against (see `forge queue list`)")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action(
      (
        idArg: string | undefined,
        opts: {
          to?: string;
          order?: string;
          expectVersion?: string;
          project?: string;
          json?: boolean;
        },
      ) => {
        runQueueVerb("reorder", opts, (projectKey) => {
          const reorderOpts = reorderOptions("reorder", opts.expectVersion);
          if (opts.order !== undefined) {
            if (idArg !== undefined || opts.to !== undefined) {
              throw new QueueRefusal(
                `forge: queue reorder refuses — --order sets the whole queue, so it cannot be combined ` +
                  `with a ticket id or --to.`,
                "reorder",
                idArg ?? null,
              );
            }
            const desired = opts.order
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            const res = setQueueOrder(projectKey, desired, reorderOpts);
            return {
              action: "reorder",
              queue: res.queue,
              message: `Queue order: ${res.queue.join(" → ")}`,
            };
          }
          if (idArg === undefined || opts.to === undefined) {
            throw new QueueRefusal(
              `forge: queue reorder refuses — pass either \`<id> --to <n>\` to move one ticket, or ` +
                `\`--order <id,id,...>\` to set the whole queue order.`,
              "reorder",
              idArg ?? null,
            );
          }
          const res = moveQueuePosition(
            projectKey,
            idArg,
            parseCount(opts.to, "reorder", "--to", false),
            reorderOpts,
          );
          return {
            action: "reorder",
            ticketId: idArg,
            position: res.position,
            queue: res.queue,
            message: `Moved ${idArg} to queue position ${res.position}`,
          };
        });
      },
    );

  registerDispatcher(queue);
}

// ─── the dispatcher verbs ────────────────────────────────────────────────────

function registerDispatcher(queue: Command): void {
  const dispatcher = queue
    .command("dispatcher")
    .description(
      "Autonomous dispatch control: arm/disarm, capacity, the long-lived dispatcher process, and the " +
        "durable answer to 'why is nothing running'. CLI-only — deliberately not exposed over HTTP.",
    );

  // EVERY verb under `dispatcher`, and `queue cancel` below, refuses inside an agent
  // container — including the read. See refuseDispatcherVerbInContainer.
  dispatcher.hook("preAction", (_thisCommand, actionCommand) => {
    if (inContainerBacklogMode()) refuseDispatcherVerbInContainer(`dispatcher ${actionCommand.name()}`);
  });

  const policyFlags = (cmd: Command): Command =>
    cmd
      .option("--max-active-runs <n>", "the ceiling on concurrent QUEUE-OWNED runs (0 admits nothing)")
      .option("--lease-ttl <ms>", "dispatcher lease TTL in ms (refused below the derived floor)")
      .option("--heartbeat <ms>", "dispatcher heartbeat cadence in ms")
      .option("--workflow <name>", "the workflow a claimed ticket launches under")
      .option("--by <label>", "an operator label recorded BESIDE the OS identity, never instead of it")
      .option("--project <dir>", "project directory (default: cwd)")
      .option("--json", "emit JSON result");

  policyFlags(
    dispatcher
      .command("arm")
      .description(
        "AUTHORIZE unattended dispatch host-wide. Records who and when. Does not start a dispatcher, " +
          "and never starts a container by itself.",
      ),
  ).action((opts: PolicyFlagOpts & { project?: string; json?: boolean }) => {
    runDispatcherVerb("dispatcher arm", opts, (projectKey) => writePolicy("dispatcher arm", projectKey, true, opts));
  });

  policyFlags(
    dispatcher
      .command("disarm")
      .description(
        "Withdraw authorization for NEW claims. An admission test, never a reaper: running work, its " +
          "claims and their leases are untouched.",
      ),
  ).action((opts: PolicyFlagOpts & { project?: string; json?: boolean }) => {
    runDispatcherVerb("dispatcher disarm", opts, (projectKey) =>
      writePolicy("dispatcher disarm", projectKey, false, opts),
    );
  });

  policyFlags(
    dispatcher
      .command("set")
      .description(
        "Change capacity and lease policy WITHOUT changing whether dispatch is armed. Lowering the " +
          "ceiling below current usage terminates nothing.",
      ),
  ).action((opts: PolicyFlagOpts & { project?: string; json?: boolean }) => {
    runDispatcherVerb("dispatcher set", opts, (projectKey) => {
      if (
        opts.maxActiveRuns === undefined &&
        opts.leaseTtl === undefined &&
        opts.heartbeat === undefined &&
        opts.workflow === undefined
      ) {
        throw new QueueRefusal(
          `forge: queue dispatcher set refuses — no policy flag was given, so there is nothing to set. ` +
            `Pass at least one of --max-active-runs, --lease-ttl, --heartbeat or --workflow. Writing an ` +
            `unchanged policy row would record an authorization event that changed nothing. Nothing was ` +
            `written.`,
          "dispatcher set",
          null,
        );
      }
      return writePolicy("dispatcher set", projectKey, undefined, opts);
    });
  });

  dispatcher
    .command("status")
    .description(
      "Why is nothing running? Distinguishes disarmed, no capacity (naming which project holds the " +
        "host slots), no eligible work, blocked, temporarily incompatible, and a dead/stale dispatcher.",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON instead of the human-readable status")
    .action((opts: { project?: string; json?: boolean }) => {
      const dir = resolve(opts.project ?? process.cwd());
      let projectKey: string;
      try {
        projectKey = requireQueueProject("dispatcher status", dir);
      } catch (e) {
        if (!(e instanceof QueueRefusal)) throw e;
        process.stderr.write(`${e.message}\n`);
        process.exitCode = 1;
        return;
      }
      const status = readDispatcherStatus(projectKey);
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else printDispatcherStatus(status);
    });

  dispatcher
    .command("run")
    .description(
      "THE long-lived dispatcher process. Adopts or creates the fenced identity, wakes on queue, run, " +
        "blocker, readiness, capacity and recovery events, and claims only while ARMED. Start it under " +
        "tmux ownership (`forge launch run -- forge queue dispatcher run`), never from an interactive " +
        "agent turn.",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option(
      "--dispatcher-id <id>",
      `this dispatcher INSTANCE's stable identity (default: $${DISPATCHER_ID_ENV}); must stay stable across restarts`,
    )
    .option("--checkout <dir>", "explicit checkout to launch runs in (required when a project has several)")
    .option("--workflow <name>", "override the policy's default workflow for launches from this process")
    .option("--watchdog-interval <ms>", "the low-frequency health bound on a lost signal")
    .option("--wake-poll <ms>", "how often to look for durable wakes while idle")
    .option("--max-ticks <n>", "stop after this many evaluated ticks (a bounded, one-shot dispatcher)")
    .option("--once", "evaluate exactly once and stop (equivalent to --max-ticks 1)")
    .option("--json", "emit a JSON summary when the loop stops")
    .action(
      async (opts: {
        project?: string;
        dispatcherId?: string;
        checkout?: string;
        workflow?: string;
        watchdogInterval?: string;
        wakePoll?: string;
        maxTicks?: string;
        once?: boolean;
        json?: boolean;
      }) => {
        const verb = "dispatcher run";
        const dir = resolve(opts.project ?? process.cwd());
        let projectKey: string;
        try {
          projectKey = requireQueueProject(verb, dir);
        } catch (e) {
          if (!(e instanceof QueueRefusal)) throw e;
          process.stderr.write(`${e.message}\n`);
          process.exitCode = 1;
          return;
        }

        // The identity refusal, by name. An anonymous or host-derived owner cannot
        // fence a same-host peer, so two dispatchers would both read as the holder and
        // both decide — and a restart could neither adopt its own lease nor be told
        // apart from a second process.
        const env = opts.dispatcherId
          ? { ...process.env, [DISPATCHER_ID_ENV]: opts.dispatcherId }
          : process.env;
        const ownerRes = resolveDispatcherOwner(projectKey, env);
        if (!ownerRes.ok) {
          process.stderr.write(`forge: queue ${verb} refuses — ${ownerRes.error}\n`);
          process.exitCode = 1;
          return;
        }

        let maxTicks: number | undefined;
        let watchdogIntervalMs: number | undefined;
        let wakePollMs: number | undefined;
        try {
          maxTicks = opts.once ? 1 : opts.maxTicks === undefined ? undefined : parseCount(opts.maxTicks, verb, "--max-ticks", false);
          watchdogIntervalMs =
            opts.watchdogInterval === undefined
              ? undefined
              : parseCount(opts.watchdogInterval, verb, "--watchdog-interval", false);
          wakePollMs = opts.wakePoll === undefined ? undefined : parseCount(opts.wakePoll, verb, "--wake-poll", false);
        } catch (e) {
          if (!(e instanceof QueueRefusal)) throw e;
          process.stderr.write(`${e.message}\n`);
          process.exitCode = 1;
          return;
        }

        // The startup banner states the authorization it is running under rather than
        // implying one. A dispatcher started while DISARMED is a legitimate and useful
        // thing — it heartbeats and reconciles the claims that already exist — and it
        // must not look like it will start work.
        const startStatus = readDispatcherStatus(projectKey);
        if (!opts.json) {
          console.log(
            `dispatcher ${ownerRes.owner} starting for ${projectKey} — dispatch is ` +
              `${startStatus.armed ? "ARMED" : "DISARMED"} (max_active_runs=${startStatus.policy.maxActiveRuns}, ` +
              `${startStatus.policy.capacityScope} scope).`,
          );
          if (!startStatus.armed) {
            console.log(
              `  DISARMED: this process will hold its lease, heartbeat and reconcile existing claims, and ` +
                `claim NOTHING new. \`forge queue dispatcher arm\` authorizes it; running it does not.`,
            );
          }
        }

        // Ctrl-C / SIGTERM stops the DECIDER, not the work. The loop releases only its
        // own dispatcher lease on an orderly stop; every live claim keeps its lease and
        // every container keeps running, to be adopted by the successor.
        const controller = new AbortController();
        const stop = (): void => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);

        try {
          const summary = await runDispatcherLoop({
            projectKey,
            owner: ownerRes.owner,
            forgeBin: forgeSelfArgv(),
            // The checkout every launch runs in. Defaulting it to the directory the
            // dispatcher was STARTED in is a deliberate narrowing of step 7's
            // ambiguous-checkout refusal, and it is not a guess: requireQueueProject
            // above already proved this directory resolves to THIS project_key in db
            // mode, so it is a checkout the operator both chose and stood in. Without
            // the default, a project with two observed checkouts (the ordinary linked
            // worktree shape) could never dispatch at all. --checkout overrides it.
            projectDir: opts.checkout ? resolve(opts.checkout) : dir,
            workflow: opts.workflow,
            host: hostname(),
            pid: process.pid,
            signal: controller.signal,
            ...(maxTicks === undefined ? {} : { maxTicks }),
            ...(watchdogIntervalMs === undefined ? {} : { watchdogIntervalMs }),
            ...(wakePollMs === undefined ? {} : { wakePollMs }),
            seams: {
              onTick: (tick: DispatcherTick) => {
                if (opts.json) return;
                const grants = tick.cycle?.grants.length ?? 0;
                console.log(
                  `  tick (${tick.trigger}): ${tick.cycle?.finalReason ?? tick.skipped ?? "no cycle"} — ` +
                    `${grants} grant(s), ${tick.launches.length} launch action(s), ` +
                    `${tick.reconciled.length} reservation(s) retired, ${tick.wakes.length} wake(s) consumed`,
                );
              },
            },
          });

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  projectKey,
                  owner: summary.owner,
                  generation: summary.generation,
                  ticks: summary.ticks.length,
                  iterations: summary.iterations,
                  stopReason: summary.stopReason,
                  alert: summary.alert,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(`dispatcher stopped: ${summary.stopReason} after ${summary.ticks.length} tick(s).`);
          }
          // A lost lease is LOUD and non-zero: it means this process was not (or is no
          // longer) the dispatcher, which reads identically to "idle" if it is reported
          // quietly. D9 — nothing auto-restarts.
          if (summary.alert !== null) {
            process.stderr.write(`forge: queue ${verb} — ${summary.alert}\n`);
            process.exitCode = 1;
          }
        } catch (e) {
          if (!(e instanceof QueueRefusal)) throw e;
          process.stderr.write(`${e.message}\n`);
          process.exitCode = 1;
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
      },
    );

  // ─── cancel: the ONE verb that stops work (D4) ─────────────────────────────
  //
  // Deliberately a sibling of the planning verbs rather than of dispatcher control:
  // an operator cancels a TICKET's work, and the dispatcher policy is not involved.
  // What matters is the ORDER, which is structural in cancelClaimedTicket and
  // restated here because reversing it is the duplicate-execution defect: stop the
  // work, remove the launch, and only then let the claim's own lease owner retire the
  // reservation. Dequeue, unrank and defer never reach this path.
  queue
    .command("cancel")
    .argument("<id>", "ticket id whose claimed work should be stopped (e.g. FG-123)")
    .description(
      "Stop the work a queue claim is running, THEN retire the reservation. The only verb here that " +
        "stops a container — dequeue never does.",
    )
    .option("--no-abandon-run", "kill the run's tasks but leave the run row active")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((idArg: string, opts: { abandonRun?: boolean; project?: string; json?: boolean }) => {
      if (inContainerBacklogMode()) refuseDispatcherVerbInContainer("cancel");
      runDispatcherVerb("cancel", opts, (projectKey) => {
        const res = cancelClaimedTicket({
          projectKey,
          ticketId: idArg,
          abandonRun: opts.abandonRun !== false,
        });
        if (res.kind === "no_live_claim") {
          return { action: "cancel", ticketId: idArg, cancelled: false, refusal: `forge: queue cancel — ${res.detail}` };
        }
        // The reservation ended, so a slot may have freed. Recorded with the SAME
        // idempotency key the dispatcher's own terminal observer derives, so the two
        // collapse into one pending record instead of racing to two.
        const runId = res.released?.runId ?? null;
        recordWake({
          projectKey,
          kind: "run_terminal",
          wakeKey: runId === null ? `claim:${res.claimId}` : `run:${runId}`,
          detail: `${idArg}: cancelled by operator; reservation ${res.released === null ? "not retired" : "released"}`,
        });
        return {
          action: "cancel",
          ticketId: idArg,
          cancelled: true,
          claimId: res.claimId,
          workStopped: res.cancelOutcome,
          launchRemoved: res.launchRemoved,
          released: res.released === null ? null : { claimId: res.released.id, outcome: res.released.outcome },
          releaseRefused: res.releaseRefused,
          message:
            `Cancelled ${idArg}: the work was stopped first ` +
            `(${res.cancelOutcome === null ? "no run had been bound to the reservation yet" : res.cancelOutcome.kind}` +
            `${res.launchRemoved === null ? "" : `, launch ${res.launchRemoved} removed`}), then the ` +
            `reservation ${res.released === null ? "could NOT be retired" : `was released as '${res.released.outcome ?? "cancelled"}'`} ` +
            `by its own lease owner.` +
            (res.releaseRefused === null ? "" : `\n  ${res.releaseRefused}`),
        };
      });
    });
}
