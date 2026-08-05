// FG-610 (FG-496 Slice E): the durable CLAIM / LEASE / RECOVERY primitives, and
// THE canonical atomic claim-next query FG-591's dispatcher will consume.
//
// This slice ships PRIMITIVES ONLY. Nothing here polls, wakes, launches or drives;
// nothing reads configuration; nothing is reachable from a container, a CLI verb, an
// API route or a dashboard payload. All of that is FG-591.
//
// ─── WHAT A CLAIM IS (and what it is NOT) ────────────────────────────────────
// A claim is a durable SCHEDULING RESERVATION over a queue entry: "this owner
// intends to execute this ticket and holds the right to until its lease lapses".
// Dispatch evidence is EXECUTION. Two facts, deliberately not collapsed:
//   * a claim can exist with nothing running (the crash window, before the launch);
//   * a launch can be running under a claim whose lease has since lapsed.
// So a release `outcome` is a fact about the RESERVATION, never about the work.
// releaseClaim writes the claim row and ONLY the claim row: it never writes
// tickets.status, and `blocked` / `in_progress` stay COMPUTED (queue.ts) and are
// still never stored. A second mutable status vocabulary is exactly what FG-609
// spent its slice not introducing.
//
// ─── THE CLOCK RULE ──────────────────────────────────────────────────────────
// EVERY lease value is written and compared against ONE clock: the store's own
// (storeNowMs, read from SQLite itself — publications.ts). Never an independently
// sourced process clock, which would let two forge processes with skewed clocks
// disagree about whether a lease expired. queue.ts's nowIso stays for AUDIT AND
// DISPLAY only; the ISO stamps written here are derived FROM storeNowMs so the two
// can never drift. Mixing the two clocks is invisible in a single-process test —
// which is precisely why it is stated as a rule rather than left to care.
//
// ─── THE TTL FLOOR IS DERIVED, NOT CHOSEN ────────────────────────────────────
// MIN_LEASE_TTL_MS below is a DERIVED quantity: it must exceed several heartbeat
// intervals PLUS db.ts's busy_timeout (5000ms). A heartbeat is itself a WRITE, and
// every write on this host queues behind the machine-wide BEGIN IMMEDIATE lock that
// the publication lane also contends for. An over-aggressive TTL therefore converts
// an ordinary LOCK-CONTENTION event into a SELF-INFLICTED TAKEOVER — a healthy
// controller's lease expiring under it while its container is still running, which
// is a DUPLICATE EXECUTION. The floor is enforced by refusal, not by comment.
//
// ─── TWO PHASES, ON PURPOSE ──────────────────────────────────────────────────
// claimNextEligible is (1) an ordinary READ that walks FG-609's canonical rank order
// and derives eligibility, naming EVERY exclusion as it is applied, then (2) a SHORT
// writeTransaction that RE-VALIDATES the durable facts the scan depended on and
// inserts the claim. The caller's compatibility predicate is documented and tested
// as PURE and I/O-FREE and is evaluated in phase 1 ONLY — never while holding the
// whole-database write lock every forge process on this host shares. queue.ts
// imposes the same discipline on evaluateReadiness; the reason is stronger here,
// because publications.ts calls this lane the highest-contention cross-process write
// path in the system.
//
// ─── DURABLE EVIDENCE IS BOUND TO A DECISION, NOT TO A POLL ──────────────────
// A GRANTED claim persists the scan evidence that produced it (scan_evidence) and
// appends one `claim` queue_event in the SAME transaction. A scan that grants
// nothing persists NOTHING — it is not a claim attempt. A claim attempt that loses
// the CAS also writes nothing at all. That follows queue.ts's transition-only rule
// for readiness history and keeps an idle dispatcher from becoming a continuous
// O(queue depth) writer on the machine-wide store.
//
// THE ACCEPTED COST, stated rather than discovered: an idle dispatcher that selects
// nothing leaves NO durable explanation of why. The per-candidate reasons are
// returned to the caller in `scanned` on every call; giving the operator a durable
// read surface for them is FG-591's job, not this slice's.
//
// ─── EVERY WRITE GOES THROUGH THE ONE WRITE PATH ─────────────────────────────
// db.ts writeTransaction (BEGIN IMMEDIATE, whole-database lock). No new transaction
// mode, no new locking primitive, no optimistic-concurrency scheme. No claim path
// calls markBacklogDirty: queue state has no container consumer in this slice, so a
// claim that republished snapshots machine-wide would be pure blast radius.
//
// ─── AN EXPIRED LEASE AUTHORIZES NOTHING, AND RENEWS NOTHING ─────────────────
// Two predicates decide whether a controller may drive: claimIsStillHeld (the
// pre-work fence) and heartbeatClaim's CAS (the renewal). BOTH carry
// `lease_expires_at_ms >= now` alongside the owner+generation fence, exactly as
// campaign-controller.ts:campaignLeaseHeldBy and renewCampaignLease do, and for the
// same reason stated there: an expired former owner — stale generation OR a lease
// that merely lapsed — is fenced and the caller FAILS CLOSED rather than driving
// under a dead lease.
//
// Dropping either term is a duplicate-execution vector, not a nicety. Without it
// recoverableClaims and claimIsStillHeld CONTRADICT each other over the same row at
// the same instant — one surface says "take this over", the other says "you are
// still authorized" — and a heartbeat can RESURRECT a claim out of the recovery set
// after a recovery controller has already decided to adopt it. The two surfaces are
// tested to be mutually exclusive at every instant.
//
// ─── THE LAUNCH IDENTITY IS WRITE-ONCE PER GENERATION ────────────────────────
// recordClaimLaunch stamps ONLY the fields it was given: a call carrying just a
// launchId leaves run_id exactly as it was, and vice versa, so the two halves of the
// born-under linkage can be made durable at the two different moments they actually
// become known. Once a field is set it is IMMUTABLE for that generation — an
// identical re-stamp is idempotent (a retry after a crash between the write and its
// ack is a real sequence), a CONFLICTING value refuses BY NAME and writes nothing.
//
// Overwrite is refused rather than allowed because the stamp is the ONLY durable
// pointer to a container that may still be running. Replacing it would orphan that
// container — a takeover would then find an empty-looking slot and start a second
// one, which is the exact duplicate execution this slice exists to prevent. A
// genuinely new launch belongs to a new generation (a takeover) or a new claim, and
// both get their OWN row: campaign_item_launches's born-under-token-per-attempt
// shape, never an overwrite.

import { randomBytes } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { storeNowMs } from "./publications.js";
import { QueueRefusal, appendQueueEvent, isQueueBlocked, readinessView } from "./queue.js";

// ─── the derived TTL floor ───────────────────────────────────────────────────

/** db.ts's busy_timeout: the longest a write waits on the machine-wide lock before
 *  SQLITE_BUSY. A heartbeat is a write, so this is part of the floor. */
export const CLAIM_WRITE_LOCK_WAIT_MS = 5_000;

/** The fastest cadence a controller should be asked to heartbeat at. Faster than
 *  this and the heartbeat itself becomes the contention. */
export const CLAIM_HEARTBEAT_INTERVAL_MS = 5_000;

/** THE DERIVED FLOOR — three heartbeat intervals plus the worst-case write-lock
 *  wait. Below this a healthy controller can lose its own lease to lock contention
 *  and be taken over while still running. Enforced by refusal in every verb that
 *  writes a lease. */
export const MIN_LEASE_TTL_MS = 3 * CLAIM_HEARTBEAT_INTERVAL_MS + CLAIM_WRITE_LOCK_WAIT_MS;

/** The release outcome a takeover stamps on the predecessor it retires. Free TEXT
 *  (there is no CHECK on `outcome`); FG-591 owns the rest of the vocabulary. */
export const TAKEOVER_OUTCOME = "taken_over_after_lease_expiry";

// ─── types ───────────────────────────────────────────────────────────────────

export type ClaimState = "live" | "released";

/** WHAT THE CAPACITY CEILING COUNTS. Required, with NO DEFAULT — the two answers
 *  have materially different operational consequences and the choice belongs to
 *  whoever is building the operator control (FG-591), not to a silent default here:
 *    'project' — N projects at capacity 3 put 3N containers on one machine, so the
 *                ceiling stops describing host load.
 *    'host'    — one project's queue can starve another's.
 *  The ledger carries project_key, so both counts are exact. */
export type CapacityScope = "project" | "host";

export type QueueClaim = {
  id: string;
  projectKey: string;
  ticketId: string;
  owner: string;
  /** The FENCING TOKEN. A takeover inserts a successor at generation+1; every
   *  mutating verb is owner+generation fenced, so a superseded owner writes nothing. */
  generation: number;
  /** The tickets.revision the claim was granted against. */
  ticketRevision: number;
  leaseExpiresAtMs: number;
  heartbeatAtMs: number;
  /** The born-under launch linkage, made durable BEFORE the physical launch. */
  launchId: string | null;
  runId: string | null;
  state: ClaimState;
  outcome: string | null;
  /** The scan that produced this grant, persisted only on a GRANT. */
  scanEvidence: ScanEntry[] | null;
  claimedAt: string;
  releasedAt: string | null;
};

/** One named reason per scanned candidate. This is what makes blocked /
 *  readiness-ineligible / already-claimed / temporarily-incompatible-with-active-runs
 *  DISTINGUISHABLE rather than collapsed into "nothing was eligible". */
export type ScanReason =
  | "eligible"
  /** Ranked, but the operator never selected it for execution. */
  | "not_a_queue_member"
  /** A queue member with no rank: the queue is ordered BY rank, so it has no position. */
  | "unranked"
  /** FG-609 D5, stated EXPLICITLY rather than implied by membership: a deferred
   *  ticket stays RANKED, stays a QUEUE MEMBER and keeps its history — and is
   *  EXECUTION-INELIGIBLE anyway. */
  | "deferred"
  /** Any other non-active lifecycle status (done). */
  | "not_active"
  /** FG-609 D7: the QUEUE projection (isQueueBlocked, the wide all-kinds
   *  derivation), never StructuredTicket.status. */
  | "queue_blocked"
  /** No stored assessment, a STALE one, or an outcome outside ready|exploratory.
   *  evaluateReadiness is NOT re-run here and NOTHING is written on a scan. */
  | "readiness_ineligible"
  /** A live claim whose lease has NOT expired. */
  | "already_claimed"
  /** Otherwise eligible, but admitting it would exceed the ceiling. */
  | "capacity"
  /** The caller's predicate rejected it, carrying the predicate's own reason. */
  | "incompatible";

export type ScanEntry = {
  ticketId: string;
  rank: number | null;
  reason: ScanReason;
  /** The concrete particulars — the lifecycle status, the readiness outcome, the
   *  holding owner, the predicate's reason string. Never a second vocabulary. */
  detail: string | null;
};

/** The already-hydrated candidate a compatibility predicate sees. */
export type ClaimCandidate = {
  ticketId: string;
  rank: number;
  type: string;
  status: string;
  title: string;
  revision: number;
  readinessOutcome: string;
};

/** What is currently reserved in the capacity scope, so a predicate can answer
 *  "temporarily incompatible with the active runs" without doing any I/O. */
export type ActiveClaimSummary = {
  claimId: string;
  projectKey: string;
  ticketId: string;
  owner: string;
  generation: number;
  leaseExpiresAtMs: number;
  launchId: string | null;
  runId: string | null;
};

export type CompatibilityVerdict = { compatible: true } | { compatible: false; reason: string };

/** THE PREDICATE PURITY CONTRACT. `isCompatible` MUST be pure and I/O-free over the
 *  already-hydrated arguments, and deterministic for a given (candidate, active)
 *  pair. It is called in the READ phase only — never inside the write transaction —
 *  so a predicate that queried the store, hit the network or slept would not merely
 *  be slow: it would stall every forge process on this host behind the machine-wide
 *  write lock. It must not mutate its arguments. */
export type CompatibilityPredicate = (
  candidate: ClaimCandidate,
  active: readonly ActiveClaimSummary[],
) => CompatibilityVerdict;

export type ClaimNextRequest = {
  projectKey: string;
  owner: string;
  /** CALLER-SUPPLIED. This module never reads configuration — max_active_runs as an
   *  operator control is FG-591's. */
  capacity: number;
  capacityScope: CapacityScope;
  leaseTtlMs: number;
  isCompatible?: CompatibilityPredicate;
};

export type ClaimNextResult =
  /** Granted. `takenOverFrom` is the RETIRED predecessor when this grant recovered an
   *  expired lease — carrying its launch_id/run_id, so the new owner discovers the
   *  prior launch DIRECTLY rather than finding an empty slot. Deciding what to do
   *  with it (adopt vs relaunch) is FG-591's recovery POLICY, not this primitive's. */
  | { claimed: QueueClaim; reason: "granted"; scanned: ScanEntry[]; takenOverFrom: QueueClaim | null }
  /** THE THREE REFUSALS, decided at the top rather than discovered at a throw site.
   *  NONE of them writes anything:
   *    no_eligible_candidate — the scan selected nothing. Not a claim attempt.
   *    capacity              — a candidate was otherwise eligible but the ceiling is full.
   *    lost                  — a claim attempt whose re-validation failed (a concurrent
   *                            dispatcher won, or a durable fact moved under the scan). */
  | { claimed: null; reason: "no_eligible_candidate" | "capacity" | "lost"; scanned: ScanEntry[]; takenOverFrom: null };

// ─── row mapping ─────────────────────────────────────────────────────────────

type ClaimDbRow = {
  id: string;
  project_key: string;
  ticket_id: string;
  owner: string;
  generation: number;
  ticket_revision: number;
  lease_expires_at_ms: number;
  heartbeat_at_ms: number;
  launch_id: string | null;
  run_id: string | null;
  state: string;
  outcome: string | null;
  scan_evidence: string | null;
  claimed_at: string;
  released_at: string | null;
};

const CLAIM_COLUMNS = `id, project_key, ticket_id, owner, generation, ticket_revision,
  lease_expires_at_ms, heartbeat_at_ms, launch_id, run_id, state, outcome,
  scan_evidence, claimed_at, released_at`;

function toClaim(r: ClaimDbRow): QueueClaim {
  return {
    id: r.id,
    projectKey: r.project_key,
    ticketId: r.ticket_id,
    owner: r.owner,
    generation: r.generation,
    ticketRevision: r.ticket_revision,
    leaseExpiresAtMs: r.lease_expires_at_ms,
    heartbeatAtMs: r.heartbeat_at_ms,
    launchId: r.launch_id,
    runId: r.run_id,
    state: r.state as ClaimState,
    outcome: r.outcome,
    scanEvidence: r.scan_evidence ? (JSON.parse(r.scan_evidence) as ScanEntry[]) : null,
    claimedAt: r.claimed_at,
    releasedAt: r.released_at,
  };
}

function toSummary(c: QueueClaim): ActiveClaimSummary {
  return {
    claimId: c.id,
    projectKey: c.projectKey,
    ticketId: c.ticketId,
    owner: c.owner,
    generation: c.generation,
    leaseExpiresAtMs: c.leaseExpiresAtMs,
    launchId: c.launchId,
    runId: c.runId,
  };
}

// ─── the FG-609 D6 guard ─────────────────────────────────────────────────────

/** EVERY exported entry point — the reads as well as the writes — refuses BY NAME on
 *  a markdown-mode project or one with no resolvable project identity (FG-609 D6);
 *  fg610-queue-claims.test.ts asserts the verb table covers the module's whole export
 *  surface rather than a sample of it. A read is guarded for the same reason a write
 *  is: a recovery caller that reads an EMPTY claim set out of a project the store
 *  cannot resolve concludes "nothing to recover", which is the fail-open this guard
 *  exists to make impossible. In markdown mode the DB tickets table
 *  is a WRITE-ONLY SHADOW of the last import, so a claim granted there would reserve
 *  a row nothing reads and a dispatcher would execute against content the operator no
 *  longer has on disk.
 *
 *  Read with DIRECT SQL. The store must NOT import src/backlog — queue.ts:74-76
 *  states why even the reverse-direction import is kept type-only. */
function requireDbModeProject(projectKey: string, verb: string): void {
  const db = getDb();
  const identity = db
    .prepare(`SELECT 1 AS present FROM project_identity WHERE project_key = ?`)
    .get(projectKey) as { present: number } | undefined;
  if (!identity) {
    throw new QueueRefusal(
      `forge: queue ${verb} refuses — no project_identity row exists for project_key ` +
        `'${projectKey}', so there is no resolvable project to claim work for. Register the ` +
        `project (\`forge backlog migrate\`) before any dispatcher claims against it.`,
      verb,
      null,
    );
  }
  const mode = db
    .prepare(`SELECT mode FROM ticket_storage_mode WHERE project_key = ?`)
    .get(projectKey) as { mode: string } | undefined;
  if (!mode || mode.mode !== "db") {
    throw new QueueRefusal(
      `forge: queue ${verb} refuses — project_key '${projectKey}' is in ` +
        `'${mode?.mode ?? "markdown"}' storage mode. Queue claims are durable DB state (lease, ` +
        `fencing generation, launch identity, claim history) with no Markdown representation, so ` +
        `running it here would reserve rows nothing reads. Cut this project over with ` +
        `\`forge backlog migrate\` first.`,
      verb,
      null,
    );
  }
}

/** E1 — the counting scope fails CLOSED. Both scopes need the project_key of the
 *  project ASKING: the project scope counts it, and the host scope is still asked BY
 *  a project whose identity has to resolve before its answer means anything.
 *
 *  This exists because the fail-open it replaces was silent: `liveClaims(projectKey
 *  ?? "")` queries WHERE project_key = '' and returns [], so a recovery surface
 *  answered "nothing to recover" when it meant "you did not tell me which project". */
function requireScopeProjectKey(projectKey: string | undefined, scope: CapacityScope, verb: string): string {
  if (typeof projectKey !== "string" || projectKey.length === 0) {
    throw new QueueRefusal(
      `forge: queue ${verb} refuses — a ${scope}-scoped claim read needs the project_key of the project ` +
        `asking, and none was supplied. Reading with an empty key would query project_key = '' and return ` +
        `an EMPTY set, so a recovery caller would be told 'nothing to recover' when the truth is 'you did ` +
        `not say which project'. Nothing was read.`,
      verb,
      null,
    );
  }
  return projectKey;
}

function requireLeaseTtl(leaseTtlMs: number, verb: string): void {
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs < MIN_LEASE_TTL_MS) {
    throw new QueueRefusal(
      `forge: queue ${verb} refuses — a lease TTL of ${leaseTtlMs}ms is below the derived floor ` +
        `of ${MIN_LEASE_TTL_MS}ms (${CLAIM_HEARTBEAT_INTERVAL_MS}ms heartbeat × 3 plus the ` +
        `${CLAIM_WRITE_LOCK_WAIT_MS}ms whole-database write-lock wait). A heartbeat is itself a ` +
        `write queued behind that lock, so a shorter lease lets a HEALTHY controller expire its ` +
        `own lease under contention and be taken over while its container is still running. ` +
        `Nothing was written.`,
      verb,
      null,
    );
  }
}

function isoFrom(ms: number): string {
  return new Date(ms).toISOString();
}

/** Claim ids follow the repo's opaque-id convention (newCampaignId's shape) rather
 *  than being derived from the identity. A DERIVED id would be a second idempotency
 *  receipt beside the fencing generation, and it would collide the moment a ticket
 *  is claimed, released and re-claimed — the row's own project_key/ticket_id/
 *  generation carry the identity, and the partial unique index carries the
 *  at-most-one-live rule. */
function newClaimId(): string {
  return `qclaim-${randomBytes(6).toString("hex")}`;
}

/** The NEXT fencing generation for a ticket: strictly above every generation the
 *  ticket has ever carried, retired rows included. Monotonic per ticket, so a stale
 *  owner from ANY earlier claim — not merely the one directly taken over — can never
 *  satisfy an owner+generation-fenced CAS again. Caller holds the write transaction. */
function nextGeneration(projectKey: string, ticketId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(generation), 0) AS g FROM queue_claims WHERE project_key = ? AND ticket_id = ?`,
    )
    .get(projectKey, ticketId) as { g: number };
  return row.g + 1;
}

// ─── reads (recovery + accounting) ───────────────────────────────────────────
//
// Each read comes in two halves: an UNGUARDED internal used on the claim path, which
// has already run the D6 guard once, and the exported wrapper that runs it. Keeping
// them separate is what lets every export be guarded without turning one
// claimNextEligible call into half a dozen repeated identity lookups.

function readClaim(claimId: string): QueueClaim | undefined {
  const row = getDb()
    .prepare(`SELECT ${CLAIM_COLUMNS} FROM queue_claims WHERE id = ?`)
    .get(claimId) as ClaimDbRow | undefined;
  return row ? toClaim(row) : undefined;
}

function liveClaimsFor(projectKey: string): QueueClaim[] {
  return (
    getDb()
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM queue_claims
          WHERE project_key = ? AND state = 'live' ORDER BY claimed_at ASC, id ASC`,
      )
      .all(projectKey) as ClaimDbRow[]
  ).map(toClaim);
}

function liveClaimsInScopeFor(scope: CapacityScope, projectKey: string): QueueClaim[] {
  if (scope === "host") {
    return (
      getDb()
        .prepare(`SELECT ${CLAIM_COLUMNS} FROM queue_claims WHERE state = 'live' ORDER BY claimed_at ASC, id ASC`)
        .all() as ClaimDbRow[]
    ).map(toClaim);
  }
  return liveClaimsFor(projectKey);
}

function liveClaimCountFor(scope: CapacityScope, projectKey: string): number {
  const db = getDb();
  const row = (
    scope === "host"
      ? db.prepare(`SELECT COUNT(*) AS n FROM queue_claims WHERE state = 'live'`).get()
      : db.prepare(`SELECT COUNT(*) AS n FROM queue_claims WHERE project_key = ? AND state = 'live'`).get(projectKey)
  ) as { n: number };
  return row.n;
}

/** One claim by id, within the project that owns it. `projectKey` is not redundant
 *  with the id: it is what the D6 guard has to resolve before any claim state is
 *  handed out, so an id from another project reads as absent rather than as data. */
export function getClaim(projectKey: string, claimId: string): QueueClaim | undefined {
  requireDbModeProject(projectKey, "claim-get");
  const claim = readClaim(claimId);
  return claim && claim.projectKey === projectKey ? claim : undefined;
}

/** Every LIVE claim of a project, oldest first. A live claim occupies a capacity
 *  slot until it is RELEASED — expired lease or not. */
export function liveClaims(projectKey: string): QueueClaim[] {
  requireDbModeProject(projectKey, "claim-live");
  return liveClaimsFor(projectKey);
}

/** Every live claim in the scope. Host scope spans every project's claims; the
 *  project_key is still REQUIRED, because it identifies the project asking and is
 *  what the D6 guard resolves — see requireScopeProjectKey. */
export function liveClaimsInScope(scope: CapacityScope, projectKey?: string): QueueClaim[] {
  const pk = requireScopeProjectKey(projectKey, scope, "claim-live-in-scope");
  requireDbModeProject(pk, "claim-live-in-scope");
  return liveClaimsInScopeFor(scope, pk);
}

/** THE capacity count, taken in the scope the caller nominated. Read inside the
 *  write transaction on the claim path — a count taken outside it is exactly the
 *  over-admission defect, and unlike at-most-one-live-claim NOTHING in SQLite can
 *  enforce a COUNT ceiling, so an over-admission leaves no constraint violation and
 *  no trace in the data. */
export function liveClaimCount(scope: CapacityScope, projectKey: string): number {
  const pk = requireScopeProjectKey(projectKey, scope, "claim-count");
  requireDbModeProject(pk, "claim-count");
  return liveClaimCountFor(scope, pk);
}

/** Live claims whose lease has STRICTLY expired — the recovery set. An expired lease
 *  proves a controller stopped HEARTBEATING; it does NOT prove its container stopped.
 *  That is why the launch identity is durable before the launch: recovery adopts
 *  rather than duplicates.
 *
 *  A row in this set is, at this same instant, one that claimIsStillHeld returns
 *  false for. The two are mutually exclusive by construction and asserted to be. */
export function recoverableClaims(scope: CapacityScope, projectKey?: string): QueueClaim[] {
  const pk = requireScopeProjectKey(projectKey, scope, "claim-recoverable");
  requireDbModeProject(pk, "claim-recoverable");
  const now = storeNowMs();
  return liveClaimsInScopeFor(scope, pk).filter((c) => c.leaseExpiresAtMs < now);
}

/** The full claim history of one ticket, oldest first — retired rows included. A
 *  takeover RETIRES its predecessor and inserts a successor; nothing is ever
 *  overwritten or deleted, so this is the evidence recovery needs most. */
export function claimHistoryForTicket(projectKey: string, ticketId: string): QueueClaim[] {
  requireDbModeProject(projectKey, "claim-history");
  return (
    getDb()
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM queue_claims
          WHERE project_key = ? AND ticket_id = ?
          ORDER BY generation ASC, claimed_at ASC, id ASC`,
      )
      .all(projectKey, ticketId) as ClaimDbRow[]
  ).map(toClaim);
}

// ─── test seam: the window BETWEEN the two phases ────────────────────────────
// Load-bearing for the "a REFUSED claim writes NOTHING" proof on the `lost` path.
// A single process cannot otherwise open the window in which a concurrent
// dispatcher wins the ticket, or a durable fact the scan depended on moves, after
// the scan and before the claim — and "the re-validation is there" is not evidence
// that it fires. queue.ts's setRenumberFailureHookForTest is the precedent. Never
// armed in production; the REAL window is exercised cross-process by
// fg610-claim-race.integration.test.ts.
let _betweenPhasesHook: ((candidateTicketId: string) => void) | null = null;

export function setClaimPhaseHookForTest(fn: ((candidateTicketId: string) => void) | null): void {
  _betweenPhasesHook = fn;
}

// ─── the scan (phase 1: an ordinary READ; nothing is written) ────────────────

type CandidateRow = {
  ticket_id: string;
  title: string;
  type: string;
  status: string;
  priority_rank: number | null;
  revision: number;
  queued: number;
};

/** The scan DOMAIN is every RANKED-OR-QUEUED ticket of the project in canonical
 *  order — deliberately NOT the pre-filtered executable projection.
 *
 *  Scanning the executable projection would make deferred and unranked candidates
 *  ABSENT rather than NAMED, which is how a rank-1 ticket that will not run ends up
 *  with no answer to "why". Read order is FG-609's total order (rank ASC, ticket_id
 *  ASC); a rank VALUE is never keyed off, only the ordering. This query READS the
 *  rank and never writes it. */
function scanDomain(projectKey: string): CandidateRow[] {
  return getDb()
    .prepare(
      `SELECT t.ticket_id, t.title, t.type, t.status, t.priority_rank, t.revision,
              (m.ticket_id IS NOT NULL) AS queued
         FROM tickets t
         LEFT JOIN queue_membership m
           ON m.project_key = t.project_key AND m.ticket_id = t.ticket_id
        WHERE t.project_key = ?
          AND (t.priority_rank IS NOT NULL OR m.ticket_id IS NOT NULL)
        ORDER BY t.priority_rank ASC, t.ticket_id ASC`,
    )
    .all(projectKey) as CandidateRow[];
}

/** The outcomes that permit execution. Identical to FG-609's QUEUEABLE_OUTCOMES —
 *  `exploratory` included, because a spike is executable without acceptance
 *  criteria. No second readiness vocabulary is introduced: this reads the stored
 *  FG-382 assessment and its staleness, and evaluateReadiness is NOT re-run. */
const EXECUTABLE_OUTCOMES = new Set(["ready", "exploratory"]);

// ─── claim-next (THE canonical atomic claim-next query) ──────────────────────

export function claimNextEligible(req: ClaimNextRequest): ClaimNextResult {
  const { projectKey, owner, capacity, capacityScope, leaseTtlMs } = req;
  requireDbModeProject(projectKey, "claim-next");
  requireLeaseTtl(leaseTtlMs, "claim-next");

  const refuse = (reason: "no_eligible_candidate" | "capacity" | "lost", scanned: ScanEntry[]): ClaimNextResult => ({
    claimed: null,
    reason,
    scanned,
    takenOverFrom: null,
  });

  // ── PHASE 1: an ordinary read. No transaction, no write, no lock held. ──────
  const now = storeNowMs();
  const live = liveClaimsFor(projectKey);
  const liveByTicket = new Map(live.map((c) => [c.ticketId, c]));
  const activeInScope = liveClaimsInScopeFor(capacityScope, projectKey).map(toSummary);
  const usedSlots = liveClaimCountFor(capacityScope, projectKey);

  const scanned: ScanEntry[] = [];
  let winner: { row: CandidateRow; predecessor: QueueClaim | null } | null = null;

  for (const row of scanDomain(projectKey)) {
    const rank = row.priority_rank;
    const note = (reason: ScanReason, detail: string | null = null): void => {
      scanned.push({ ticketId: row.ticket_id, rank, reason, detail });
    };

    if (rank === null) {
      note("unranked");
      continue;
    }
    if (row.queued !== 1) {
      note("not_a_queue_member");
      continue;
    }
    // FG-609 D5, EXPLICIT and never implied by membership: a deferred ticket is
    // still ranked, still a queue member and still has its history — and is
    // execution-INELIGIBLE. Named separately from every other non-active status so
    // the filter cannot be mistaken for an incidental status check.
    if (row.status === "deferred") {
      note("deferred", "deferred tickets keep rank, membership and history but never execute");
      continue;
    }
    if (row.status !== "active") {
      note("not_active", row.status);
      continue;
    }
    // FG-609 D7: the QUEUE projection, the wide all-kinds derivation — never
    // StructuredTicket.status, which stays the legacy status-bearing reconstruction.
    if (isQueueBlocked(projectKey, row.ticket_id)) {
      note("queue_blocked", "the queue projection reports this entry blocked");
      continue;
    }
    const readiness = readinessView(projectKey, row.ticket_id);
    if (readiness === null) {
      note("readiness_ineligible", "never assessed");
      continue;
    }
    if (readiness.stale) {
      note("readiness_ineligible", `stale assessment (${readiness.outcome})`);
      continue;
    }
    if (!EXECUTABLE_OUTCOMES.has(readiness.outcome)) {
      note("readiness_ineligible", readiness.outcome);
      continue;
    }

    const held = liveByTicket.get(row.ticket_id);
    // STRICTLY expired, or it is not recoverable. A live lease is not stealable.
    const predecessor = held && held.leaseExpiresAtMs < now ? held : null;
    if (held && predecessor === null) {
      note("already_claimed", `held by ${held.owner} (generation ${held.generation})`);
      continue;
    }

    // A takeover is CAPACITY-NEUTRAL: it retires its predecessor in the same
    // transaction, so the slot count does not move. That is what lets a host sitting
    // at its ceiling with crashed controllers still recover — a plain refusal here
    // would make the ceiling a permanent deadlock instead of an admission test.
    if (predecessor === null && usedSlots + 1 > capacity) {
      note("capacity", `${usedSlots}/${capacity} live claims in ${capacityScope} scope`);
      continue;
    }

    if (req.isCompatible) {
      const candidate: ClaimCandidate = {
        ticketId: row.ticket_id,
        rank,
        type: row.type,
        status: row.status,
        title: row.title,
        revision: row.revision,
        readinessOutcome: readiness.outcome,
      };
      const verdict = req.isCompatible(candidate, activeInScope);
      if (!verdict.compatible) {
        note("incompatible", verdict.reason);
        continue;
      }
    }

    note("eligible");
    winner = { row, predecessor };
    break;
  }

  if (winner === null) {
    // The two no-grant refusals do NOT share a code path. A ceiling that turned
    // away an otherwise-eligible candidate is 'capacity'; anything else is
    // 'no_eligible_candidate'. Neither writes.
    return refuse(scanned.some((s) => s.reason === "capacity") ? "capacity" : "no_eligible_candidate", scanned);
  }

  // ── PHASE 2: the SHORT write transaction. Re-validate every durable fact the
  // scan depended on, then insert. The caller's predicate is NOT re-run here — it
  // is pure and I/O-free by contract, and running caller code under the machine-wide
  // write lock is exactly what phase 1 exists to avoid. ────────────────────────
  const candidateId = winner.row.ticket_id;
  const scanRevision = winner.row.revision;
  _betweenPhasesHook?.(candidateId);

  return writeTransaction((): ClaimNextResult => {
    const db = getDb();
    const txnNow = storeNowMs();

    const fresh = db
      .prepare(
        `SELECT t.ticket_id, t.status, t.priority_rank, t.revision,
                (m.ticket_id IS NOT NULL) AS queued
           FROM tickets t
           LEFT JOIN queue_membership m
             ON m.project_key = t.project_key AND m.ticket_id = t.ticket_id
          WHERE t.project_key = ? AND t.ticket_id = ?`,
      )
      .get(projectKey, candidateId) as
      | { ticket_id: string; status: string; priority_rank: number | null; revision: number; queued: number }
      | undefined;

    if (
      !fresh ||
      fresh.priority_rank === null ||
      fresh.queued !== 1 ||
      fresh.status !== "active" ||
      fresh.revision !== scanRevision
    ) {
      return refuse("lost", scanned);
    }
    if (isQueueBlocked(projectKey, candidateId)) return refuse("lost", scanned);
    const readiness = readinessView(projectKey, candidateId);
    if (!readiness || readiness.stale || !EXECUTABLE_OUTCOMES.has(readiness.outcome)) {
      return refuse("lost", scanned);
    }

    const heldRow = db
      .prepare(`SELECT ${CLAIM_COLUMNS} FROM queue_claims WHERE project_key = ? AND ticket_id = ? AND state = 'live'`)
      .get(projectKey, candidateId) as ClaimDbRow | undefined;
    const held = heldRow ? toClaim(heldRow) : null;
    // A LIVE lease is NOT stealable — re-checked here against the store clock as it
    // stands INSIDE the transaction, not as the scan saw it.
    if (held && held.leaseExpiresAtMs >= txnNow) return refuse("lost", scanned);

    // THE CEILING, counted inside the transaction. A count taken outside it is the
    // over-admission defect: nothing in SQLite can enforce a COUNT.
    const slots = liveClaimCountFor(capacityScope, projectKey);
    if (held === null && slots + 1 > capacity) return refuse("capacity", scanned);

    let takenOverFrom: QueueClaim | null = null;
    const generation = nextGeneration(projectKey, candidateId);

    if (held !== null) {
      // RETIRE the predecessor. The strict lease predicate is IN THE CAS, so a live
      // lease is unstealable by construction rather than by a caller-side check —
      // continuations.ts's `claim_owner IS NULL OR claim_expires_at < ?` shape.
      const retired = db
        .prepare(
          `UPDATE queue_claims
              SET state = 'released', outcome = ?, released_at = ?
            WHERE id = ? AND state = 'live' AND lease_expires_at_ms < ?`,
        )
        .run(TAKEOVER_OUTCOME, isoFrom(txnNow), held.id, txnNow);
      if (retired.changes !== 1) return refuse("lost", scanned);
      takenOverFrom = { ...held, state: "released", outcome: TAKEOVER_OUTCOME, releasedAt: isoFrom(txnNow) };
      appendQueueEvent(
        projectKey,
        candidateId,
        "release",
        {
          claimId: held.id,
          owner: held.owner,
          generation: held.generation,
          outcome: TAKEOVER_OUTCOME,
          // The prior launch identity, surfaced in the history as well as on the
          // returned predecessor — recovery must never have to parse names or argv.
          launchId: held.launchId,
          runId: held.runId,
          takenOverBy: owner,
        },
        isoFrom(txnNow),
      );
    }

    const claim: QueueClaim = {
      id: newClaimId(),
      projectKey,
      ticketId: candidateId,
      owner,
      generation,
      ticketRevision: fresh.revision,
      leaseExpiresAtMs: txnNow + leaseTtlMs,
      heartbeatAtMs: txnNow,
      launchId: null,
      runId: null,
      state: "live",
      outcome: null,
      scanEvidence: scanned,
      claimedAt: isoFrom(txnNow),
      releasedAt: null,
    };

    db.prepare(
      `INSERT INTO queue_claims
         (id, project_key, ticket_id, owner, generation, ticket_revision, lease_expires_at_ms,
          heartbeat_at_ms, launch_id, run_id, state, outcome, scan_evidence, claimed_at, released_at)
       VALUES (@id, @projectKey, @ticketId, @owner, @generation, @ticketRevision, @leaseExpiresAtMs,
               @heartbeatAtMs, NULL, NULL, 'live', NULL, @scanEvidence, @claimedAt, NULL)`,
    ).run({
      id: claim.id,
      projectKey,
      ticketId: candidateId,
      owner,
      generation,
      ticketRevision: claim.ticketRevision,
      leaseExpiresAtMs: claim.leaseExpiresAtMs,
      heartbeatAtMs: claim.heartbeatAtMs,
      // The DURABLE half is bound to a DECISION: the reasons this grant skipped
      // over are persisted here, in the SAME transaction, and only on a grant.
      scanEvidence: JSON.stringify(scanned),
      claimedAt: claim.claimedAt,
    });

    appendQueueEvent(
      projectKey,
      candidateId,
      "claim",
      {
        claimId: claim.id,
        owner,
        generation,
        ticketRevision: claim.ticketRevision,
        leaseExpiresAtMs: claim.leaseExpiresAtMs,
        capacity,
        capacityScope,
        ...(takenOverFrom ? { takeoverOf: takenOverFrom.id } : {}),
      },
      claim.claimedAt,
    );

    return { claimed: claim, reason: "granted", scanned, takenOverFrom };
  });
}

// ─── explicit recovery: takeover of one strictly-expired claim ───────────────

export type TakeoverResult =
  | { claimed: QueueClaim; takenOverFrom: QueueClaim }
  /** live_lease — the predecessor's lease has NOT expired, so it is not stealable.
   *  not_found — no live claim under that id. Neither writes anything. */
  | { claimed: null; reason: "live_lease" | "not_found" };

/** Take over ONE claim whose lease has STRICTLY expired. The predecessor is RETIRED
 *  (state='released', outcome naming the takeover) and a SUCCESSOR is inserted at
 *  generation+1 — never an overwrite, never a delete, so the takeover history and the
 *  predecessor's launch identity both survive.
 *
 *  CAPACITY-NEUTRAL by construction: the retire and the insert are one transaction,
 *  so this is the recovery path that still works with the ceiling full. */
export function takeoverExpiredClaim(req: {
  projectKey: string;
  claimId: string;
  owner: string;
  leaseTtlMs: number;
}): TakeoverResult {
  requireDbModeProject(req.projectKey, "claim-takeover");
  requireLeaseTtl(req.leaseTtlMs, "claim-takeover");

  return writeTransaction((): TakeoverResult => {
    const db = getDb();
    const now = storeNowMs();
    const row = db
      .prepare(`SELECT ${CLAIM_COLUMNS} FROM queue_claims WHERE id = ? AND project_key = ? AND state = 'live'`)
      .get(req.claimId, req.projectKey) as ClaimDbRow | undefined;
    if (!row) return { claimed: null, reason: "not_found" };
    const held = toClaim(row);
    if (held.leaseExpiresAtMs >= now) return { claimed: null, reason: "live_lease" };

    const retired = db
      .prepare(
        `UPDATE queue_claims SET state = 'released', outcome = ?, released_at = ?
          WHERE id = ? AND state = 'live' AND lease_expires_at_ms < ?`,
      )
      .run(TAKEOVER_OUTCOME, isoFrom(now), held.id, now);
    if (retired.changes !== 1) return { claimed: null, reason: "live_lease" };

    const generation = nextGeneration(held.projectKey, held.ticketId);
    const claim: QueueClaim = {
      id: newClaimId(),
      projectKey: held.projectKey,
      ticketId: held.ticketId,
      owner: req.owner,
      generation,
      ticketRevision: held.ticketRevision,
      leaseExpiresAtMs: now + req.leaseTtlMs,
      heartbeatAtMs: now,
      launchId: null,
      runId: null,
      state: "live",
      outcome: null,
      scanEvidence: null,
      claimedAt: isoFrom(now),
      releasedAt: null,
    };
    db.prepare(
      `INSERT INTO queue_claims
         (id, project_key, ticket_id, owner, generation, ticket_revision, lease_expires_at_ms,
          heartbeat_at_ms, launch_id, run_id, state, outcome, scan_evidence, claimed_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'live', NULL, NULL, ?, NULL)`,
    ).run(
      claim.id,
      claim.projectKey,
      claim.ticketId,
      claim.owner,
      claim.generation,
      claim.ticketRevision,
      claim.leaseExpiresAtMs,
      claim.heartbeatAtMs,
      claim.claimedAt,
    );

    appendQueueEvent(
      held.projectKey,
      held.ticketId,
      "release",
      {
        claimId: held.id,
        owner: held.owner,
        generation: held.generation,
        outcome: TAKEOVER_OUTCOME,
        launchId: held.launchId,
        runId: held.runId,
        takenOverBy: req.owner,
      },
      claim.claimedAt,
    );
    appendQueueEvent(
      held.projectKey,
      held.ticketId,
      "claim",
      { claimId: claim.id, owner: req.owner, generation, takeoverOf: held.id, leaseExpiresAtMs: claim.leaseExpiresAtMs },
      claim.claimedAt,
    );

    return { claimed: claim, takenOverFrom: { ...held, state: "released", outcome: TAKEOVER_OUTCOME, releasedAt: isoFrom(now) } };
  });
}

// ─── lease maintenance, launch identity, release ─────────────────────────────

/** Renew the lease under an owner+generation-fenced CAS that ALSO requires the lease
 *  to still be live. Two ways to renew nothing and change 0 rows: a STALE generation
 *  (an owner already taken over), and a lease that has STRICTLY expired.
 *
 *  The expiry term is renewCampaignLease's (campaign-controller.ts), and it is there
 *  for that function's stated reason: the caller must FAIL CLOSED rather than drive
 *  under a dead lease. Without it a heartbeat RESURRECTS a claim out of the recovery
 *  set — recoverableClaims names the row, a recovery controller decides to adopt it,
 *  the original owner's next heartbeat pulls it back, and the subsequent takeover is
 *  refused 'live_lease'. Both controllers then believe they hold the ticket.
 *
 *  A controller that finds itself here has lost its lease, not merely missed a beat:
 *  it must stop, and re-enter through takeoverExpiredClaim (which bumps the fencing
 *  generation) rather than pretending the gap did not happen. */
export function heartbeatClaim(req: {
  projectKey: string;
  claimId: string;
  owner: string;
  generation: number;
  leaseTtlMs: number;
}): QueueClaim | null {
  requireDbModeProject(req.projectKey, "claim-heartbeat");
  requireLeaseTtl(req.leaseTtlMs, "claim-heartbeat");
  return writeTransaction((): QueueClaim | null => {
    const now = storeNowMs();
    const res = getDb()
      .prepare(
        `UPDATE queue_claims SET lease_expires_at_ms = ?, heartbeat_at_ms = ?
          WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'
            AND lease_expires_at_ms >= ?`,
      )
      .run(now + req.leaseTtlMs, now, req.claimId, req.projectKey, req.owner, req.generation, now);
    return res.changes === 1 ? (readClaim(req.claimId) ?? null) : null;
  });
}

/** Make the launch/run identity DURABLE — called BEFORE the physical launch
 *  (campaign_item_launches / review_docs_dispatches ordering). That ordering is the
 *  whole point: a takeover then discovers the prior launch DIRECTLY instead of
 *  finding an empty slot and starting a second container, and it never has to infer
 *  ownership from launch names, argv or timestamps.
 *
 *  PARTIAL BY DESIGN: only the fields actually supplied are written. The launch id
 *  and the run id become known at different moments, so a call carrying one must
 *  leave the other exactly as it stands — writing both unconditionally NULLs out
 *  whichever half it was not given, which erases the born-under linkage the whole
 *  recovery design reads.
 *
 *  WRITE-ONCE per generation: an identical re-stamp is idempotent, a CONFLICTING one
 *  refuses BY NAME and writes nothing (the header says why an overwrite is a
 *  duplicate-execution hazard rather than a nicety). The `IS NULL OR = ?` terms in
 *  the CAS make that structural rather than only pre-checked.
 *
 *  Owner+generation fenced: a superseded owner stamps nothing and gets null. */
export function recordClaimLaunch(req: {
  projectKey: string;
  claimId: string;
  owner: string;
  generation: number;
  launchId?: string;
  runId?: string;
}): QueueClaim | null {
  requireDbModeProject(req.projectKey, "claim-record-launch");

  const stamps: { column: "launch_id" | "run_id"; label: string; value: string }[] = [];
  if (req.launchId !== undefined) stamps.push({ column: "launch_id", label: "launchId", value: req.launchId });
  if (req.runId !== undefined) stamps.push({ column: "run_id", label: "runId", value: req.runId });
  if (stamps.length === 0) {
    throw new QueueRefusal(
      `forge: queue claim-record-launch refuses — neither launchId nor runId was supplied, so there is ` +
        `nothing to make durable. This verb stamps only the fields it is given; a call with neither is a ` +
        `caller bug, not a request to clear both. Nothing was written.`,
      "claim-record-launch",
      null,
    );
  }

  return writeTransaction((): QueueClaim | null => {
    const held = readClaim(req.claimId);
    if (
      !held ||
      held.projectKey !== req.projectKey ||
      held.owner !== req.owner ||
      held.generation !== req.generation ||
      held.state !== "live"
    ) {
      return null;
    }
    for (const s of stamps) {
      const existing = s.column === "launch_id" ? held.launchId : held.runId;
      if (existing !== null && existing !== s.value) {
        throw new QueueRefusal(
          `forge: queue claim-record-launch refuses — claim ${held.id} already carries ${s.label} ` +
            `'${existing}' at generation ${held.generation}, and '${s.value}' would replace it. The stamp is ` +
            `the only durable pointer to a container that may still be RUNNING, so overwriting it would ` +
            `orphan that container and let a takeover start a second one. A new launch is a new generation ` +
            `(take the claim over) or a new claim. Nothing was written.`,
          "claim-record-launch",
          held.ticketId,
        );
      }
    }

    const res = getDb()
      .prepare(
        `UPDATE queue_claims SET ${stamps.map((s) => `${s.column} = ?`).join(", ")}
          WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'
            AND ${stamps.map((s) => `(${s.column} IS NULL OR ${s.column} = ?)`).join(" AND ")}`,
      )
      .run(
        ...stamps.map((s) => s.value),
        req.claimId,
        req.projectKey,
        req.owner,
        req.generation,
        ...stamps.map((s) => s.value),
      );
    return res.changes === 1 ? (readClaim(req.claimId) ?? null) : null;
  });
}

/** THE pre-work authorization fence: does this (owner, generation) hold the claim AT
 *  THIS INSTANT? A pure read — it takes no lock and writes nothing. True only when
 *  the row is live, the owner and generation match exactly, AND the lease has not
 *  expired, which is campaignLeaseHeldBy's predicate verbatim and carries its
 *  reasoning: an expired former owner — stale generation, or a lease that merely
 *  lapsed — is fenced and returns false.
 *
 *  The lease term is what makes this and recoverableClaims MUTUALLY EXCLUSIVE. A row
 *  the recovery surface is offering for takeover must never simultaneously tell its
 *  incumbent it is still authorized to drive; that contradiction is a
 *  duplicate-execution vector, and it is asserted against directly. */
export function claimIsStillHeld(req: {
  projectKey: string;
  claimId: string;
  owner: string;
  generation: number;
}): boolean {
  requireDbModeProject(req.projectKey, "claim-is-still-held");
  const now = storeNowMs();
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM queue_claims
          WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'
            AND lease_expires_at_ms >= ?`,
      )
      .get(req.claimId, req.projectKey, req.owner, req.generation, now) !== undefined
  );
}

/** Release a claim, writing THE CLAIM AND ONLY THE CLAIM.
 *
 *  It never writes tickets.status and never a stored in_progress/blocked value: a
 *  release outcome is a fact about the RESERVATION, not about the work. `outcome` is
 *  free TEXT with no CHECK — FG-591 owns that vocabulary and SQLite cannot widen a
 *  CHECK on the additive-only path.
 *
 *  Owner+generation fenced, so a taken-over owner releases nothing (and in
 *  particular cannot retire the successor's claim). */
export function releaseClaim(req: {
  projectKey: string;
  claimId: string;
  owner: string;
  generation: number;
  outcome: string;
}): QueueClaim | null {
  requireDbModeProject(req.projectKey, "claim-release");
  return writeTransaction((): QueueClaim | null => {
    const now = storeNowMs();
    const at = isoFrom(now);
    const res = getDb()
      .prepare(
        `UPDATE queue_claims SET state = 'released', outcome = ?, released_at = ?
          WHERE id = ? AND project_key = ? AND owner = ? AND generation = ? AND state = 'live'`,
      )
      .run(req.outcome, at, req.claimId, req.projectKey, req.owner, req.generation);
    if (res.changes !== 1) return null;
    const released = readClaim(req.claimId) ?? null;
    if (released) {
      appendQueueEvent(
        req.projectKey,
        released.ticketId,
        "release",
        {
          claimId: released.id,
          owner: req.owner,
          generation: req.generation,
          outcome: req.outcome,
          launchId: released.launchId,
          runId: released.runId,
        },
        at,
      );
    }
    return released;
  });
}
