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
import { resolve } from "node:path";
import { resolveBacklogStore } from "../../backlog/storage-mode.js";
import {
  inContainerBacklogMode,
  refuseContainerMutation,
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
import { liveClaims, type QueueClaim, type ScanReason } from "../../store/queue-claims.js";
import {
  evaluateCompatibility,
  hydrateActiveRunFacts,
  type ActiveRunFacts,
} from "../../queue/compatibility.js";
import { getTicket, ticketsForProject } from "../../store/tickets.js";

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
    console.log(JSON.stringify({ projectKey, version: queueVersion(projectKey), ...result }, null, 2));
  } else {
    if (result.refusal) process.stderr.write(`${String(result.refusal)}\n`);
    if (result.message) console.log(String(result.message));
    printQueueAfterWrite(projectKey);
  }
  if (result.refusal) process.exitCode = 1;
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
}
