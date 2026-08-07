// FG-591 step 2: the dispatcher's POLICY and its fenced IDENTITY.
//
// Two durable facts, both consulted BEFORE any claim is attempted and neither of
// them process lifecycle (D5):
//
//   1. THE POLICY (dispatcher_policy). Is autonomous dispatch armed, how many
//      queue-owned runs may be live at once, in which counting scope, and on what
//      lease/heartbeat cadence. It is the only host-wide settings store forge has,
//      because the dispatcher, the CLI and the dashboard are three processes that
//      must agree on ONE ceiling and the count it is enforced against already lives
//      in this DB.
//
//   2. THE DISPATCHER LEASE (dispatcher_leases). campaign_controller_leases' shape,
//      deliberately mirrored rather than a third lease invented: an instance-stable
//      owner, a generation bumped on every takeover as the fencing token, a renewable
//      expiry, and a heartbeat stamp beside it.
//
// ─── NOTHING HERE IS A REAPER ────────────────────────────────────────────────
// Disarming autonomous dispatch and lowering max_active_runs are ADMISSION TESTS.
// This module writes dispatcher_policy and dispatcher_leases and NOTHING else: no
// path in it reads, updates, releases or even names queue_claims, so a disarm or a
// capacity reduction below current usage cannot touch a live claim or a running
// container by construction, not by care. A disarmed dispatcher keeps heartbeating
// and releasing the leases it already holds — renewal is deliberately NOT gated on
// `armed`, because a dispatcher that stopped renewing while disarmed would lapse its
// lease, invite a takeover, and duplicate the execution the claim primitive exists to
// prevent. Disarm blocks NEW claims. That is all it does.
//
// ─── THE CLOCK RULE ──────────────────────────────────────────────────────────
// Every timestamp written or compared here comes from the STORE's own clock
// (storeNowMs — queue-claims.ts's rule, publications.ts's implementation), never an
// independently sourced process clock. The ISO stamps are DERIVED from the same
// storeNowMs reading, so the epoch-ms and the human-readable column can never drift
// apart within a row.
//
// ─── THE TTL FLOOR IS ENFORCED, NOT DOCUMENTED ───────────────────────────────
// queue-claims' MIN_LEASE_TTL_MS is a DERIVED quantity (three heartbeat intervals
// plus db.ts's whole-database write-lock wait), and a TTL under it lets a HEALTHY
// controller expire its own lease under ordinary lock contention and be taken over
// while its container still runs. Every verb here that writes a TTL — the policy
// setter and both lease-writing verbs — refuses BY NAME below the floor and writes
// nothing. The heartbeat cadence is checked against the TTL by the same reasoning:
// see requirePolicyCadence.
//
// ─── ARMED READS FAIL CLOSED ─────────────────────────────────────────────────
// A store that has never seen an operator arm dispatch is DISARMED. A missing host
// row, a NULL armed column and an explicit 0 are all the same answer, so a fresh
// store cannot dispatch by accident and a partially-written row cannot either.

import { getDb, writeTransaction } from "./db.js";
import { storeNowMs } from "./publications.js";
import { QueueRefusal } from "./queue.js";
import {
  CLAIM_HEARTBEAT_INTERVAL_MS,
  CLAIM_WRITE_LOCK_WAIT_MS,
  MIN_LEASE_TTL_MS,
  type CapacityScope,
} from "./queue-claims.js";

// ─── defaults ────────────────────────────────────────────────────────────────

/** The singleton scope_key. The ceiling VALUE is host-wide because two dispatchers
 *  holding different values while enforcing against ONE shared count means the
 *  effective ceiling is whichever dispatcher ran last. */
export const HOST_POLICY_SCOPE = "host";

/** D8: the dispatcher's lease outlives ordinary host contention by a wide margin —
 *  it fences a process that may sit idle between wakes, not a tight write loop. */
export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/** Renewal cadence. Three renewal attempts fit inside one default TTL, so two
 *  consecutive missed heartbeats still do not lapse a healthy dispatcher. */
export const DEFAULT_HEARTBEAT_MS = 5 * 60_000;

/** A never-configured store admits ONE queue-owned run. The ceiling fails SMALL for
 *  the same reason `armed` fails closed: the cost of an unconfigured store dispatching
 *  too little is a stalled queue an operator can see, and the cost of it dispatching
 *  too much is N containers on a laptop nobody asked for. */
export const DEFAULT_MAX_ACTIVE_RUNS = 1;

/** HOST scope: the resource the ceiling protects is the machine — one Docker daemon,
 *  one auth profile and its rate limits, one ~/.forge/forge.db. A project-scoped
 *  ceiling of N across three registered projects permits 3N concurrent containers,
 *  which is the overload a ceiling exists to prevent. */
export const DEFAULT_CAPACITY_SCOPE: CapacityScope = "host";

/** The campaign planner's precedent. Overridable host-wide and per project. */
export const DEFAULT_WORKFLOW = "feature";

const CAPACITY_SCOPES: readonly CapacityScope[] = ["project", "host"];

// ─── types ───────────────────────────────────────────────────────────────────

export type DispatcherPolicy = {
  /** Fail-closed: absent row, NULL column and explicit 0 all read as false. */
  armed: boolean;
  /** The ceiling on QUEUE-OWNED concurrent runs. Operator-initiated runs, campaign
   *  items and review loops carry no claim row, are structurally invisible to the
   *  count claimNextEligible enforces, and are REPORTED beside this number rather
   *  than subtracted from it. */
  maxActiveRuns: number;
  capacityScope: CapacityScope;
  leaseTtlMs: number;
  heartbeatMs: number;
  /** The workflow a claimed ticket launches under. A per-project row overrides the
   *  host value when the policy is read for that project. */
  defaultWorkflow: string;
  /** false when NO host row has ever been written — every value above is a default
   *  rather than an operator choice, and the operator surface must say so instead of
   *  presenting a default as a decision. */
  configured: boolean;
  /** Who armed/changed it and when. Null until the first write. */
  updatedAt: string | null;
  updatedBy: string | null;
};

export type DispatcherPolicyUpdate = {
  armed?: boolean;
  maxActiveRuns?: number;
  capacityScope?: CapacityScope;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  defaultWorkflow?: string;
  /** REQUIRED. "Arming records who and when" is an acceptance criterion, not a nicety:
   *  arming authorizes unattended repo-writing containers, so the authorizing identity
   *  is part of the record. */
  updatedBy: string;
};

export type DispatcherLease = {
  projectKey: string;
  owner: string;
  /** The FENCING TOKEN. A takeover bumps it; a superseded generation can neither
   *  renew nor release. */
  generation: number;
  leaseExpiresAtMs: number;
  heartbeatAtMs: number;
  /** OPERATOR OUTPUT ONLY. No liveness decision consults host/pid — physical liveness
   *  belongs to the tmux-owned ownership transfer, never to a recorded pid. */
  host: string | null;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DispatcherLeaseGrant =
  /** We hold the lease at the returned generation. `created` = first ever;
   *  `renewed` = we re-acquired our OWN lease (a same-instance restart adopts its own
   *  identity rather than duplicating it); `took_over` = a prior owner's lease was
   *  STRICTLY expired and we adopted it, bumping the generation. */
  | { granted: true; lease: DispatcherLease; mode: "created" | "renewed" | "took_over" }
  /** A DIFFERENT owner holds a still-LIVE lease. Waiting is not evidence of
   *  abandonment: a replacement fails closed and reports who still owns it. */
  | { granted: false; reason: "held_by_live_owner"; lease: DispatcherLease };

/** The operator-surface read. "Nothing is running" and "the dispatcher died four
 *  hours ago" must be DISTINGUISHABLE, and only the heartbeat column can say so. */
export type DispatcherLeaseView = {
  lease: DispatcherLease | null;
  /** The lease has not expired on the STORE clock — the owner is still authorized. */
  live: boolean;
  /** The lease is strictly expired — a takeover is permitted. */
  expired: boolean;
  /** How long since the owner was last actually alive. Null when there is no lease. */
  msSinceHeartbeat: number | null;
  nowMs: number;
};

// ─── refusals ────────────────────────────────────────────────────────────────

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/** The floor queue-claims derives, enforced by refusal in every verb here that
 *  writes a TTL. Named rather than commented, because the failure it prevents — a
 *  healthy dispatcher taken over while its container still runs — is invisible until
 *  it duplicates an execution. */
function requireLeaseTtlFloor(leaseTtlMs: number, verb: string): void {
  if (!isPositiveInt(leaseTtlMs) || leaseTtlMs < MIN_LEASE_TTL_MS) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — a lease TTL of ${String(leaseTtlMs)}ms is below the derived floor of ` +
        `${MIN_LEASE_TTL_MS}ms (${CLAIM_HEARTBEAT_INTERVAL_MS}ms heartbeat × 3 plus the ` +
        `${CLAIM_WRITE_LOCK_WAIT_MS}ms whole-database write-lock wait). A heartbeat is itself a write ` +
        `queued behind that lock, so a shorter lease lets a HEALTHY dispatcher expire its own lease ` +
        `under contention and be taken over while its container is still running. Nothing was written.`,
      verb,
      null,
    );
  }
}

/** The heartbeat cadence, checked against the TTL by the SAME derivation the floor
 *  comes from: a renewal is a write queued behind the machine-wide lock, so a TTL
 *  must survive a missed renewal plus a worst-case lock wait on the retry. At the
 *  shipped defaults (15m TTL, 5m heartbeat) three renewal attempts fit inside one
 *  lease, which is the margin the operator is tuning away from when they narrow it. */
function requirePolicyCadence(leaseTtlMs: number, heartbeatMs: number, verb: string): void {
  if (!isPositiveInt(heartbeatMs) || heartbeatMs < CLAIM_HEARTBEAT_INTERVAL_MS) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — a heartbeat cadence of ${String(heartbeatMs)}ms is below the ` +
        `${CLAIM_HEARTBEAT_INTERVAL_MS}ms floor. Faster than that and the heartbeat itself becomes the ` +
        `write contention it is meant to survive. Nothing was written.`,
      verb,
      null,
    );
  }
  const required = 2 * heartbeatMs + CLAIM_WRITE_LOCK_WAIT_MS;
  if (leaseTtlMs < required) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — a lease TTL of ${leaseTtlMs}ms cannot survive a ${heartbeatMs}ms ` +
        `heartbeat cadence: it needs at least ${required}ms (one missed renewal plus the ` +
        `${CLAIM_WRITE_LOCK_WAIT_MS}ms whole-database write-lock wait on the retry). Below that a ` +
        `dispatcher that loses ONE renewal to ordinary lock contention lapses its own lease and is ` +
        `taken over while its work is still running. Raise the TTL or shorten the heartbeat. ` +
        `Nothing was written.`,
      verb,
      null,
    );
  }
}

function requireUpdatedBy(updatedBy: unknown, verb: string): string {
  if (typeof updatedBy !== "string" || updatedBy.trim().length === 0) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — a policy write must name WHO made it. Arming autonomous dispatch and ` +
        `raising the ceiling are authority to run repo-writing containers unattended, so the ` +
        `authorizing identity is part of the durable record rather than an optional label. ` +
        `Nothing was written.`,
      verb,
      null,
    );
  }
  return updatedBy;
}

/** The same guard queue-claims applies to every claim verb, applied here to the
 *  dispatcher IDENTITY for the same reason: a dispatcher holding a lease over a
 *  project whose tickets live in Markdown could never claim anything, so letting it
 *  acquire one produces a live-looking dispatcher that silently does nothing. Direct
 *  SQL — the store must not import src/backlog. */
function requireDbModeProject(projectKey: string, verb: string): void {
  if (typeof projectKey !== "string" || projectKey.length === 0) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — no project_key was supplied, and a dispatcher lease is keyed per ` +
        `project. Reading or writing with an empty key would fence a project that does not exist. ` +
        `Nothing was written.`,
      verb,
      null,
    );
  }
  const db = getDb();
  const identity = db
    .prepare(`SELECT 1 AS present FROM project_identity WHERE project_key = ?`)
    .get(projectKey) as { present: number } | undefined;
  if (!identity) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — no project_identity row exists for project_key '${projectKey}', so ` +
        `there is no resolvable project to dispatch for. Register the project ` +
        `(\`forge backlog migrate\`) first. Nothing was written.`,
      verb,
      null,
    );
  }
  const mode = db
    .prepare(`SELECT mode FROM ticket_storage_mode WHERE project_key = ?`)
    .get(projectKey) as { mode: string } | undefined;
  if (!mode || mode.mode !== "db") {
    throw new QueueRefusal(
      `forge: ${verb} refuses — project_key '${projectKey}' is in '${mode?.mode ?? "markdown"}' storage ` +
        `mode. The queue, its claims and this dispatcher lease are durable DB state with no Markdown ` +
        `representation, so a dispatcher here would hold an identity over work it can never claim. ` +
        `Cut this project over with \`forge backlog migrate\` first. Nothing was written.`,
      verb,
      null,
    );
  }
}

// ─── the policy ──────────────────────────────────────────────────────────────

type PolicyRow = {
  scope_key: string;
  armed: number | null;
  max_active_runs: number | null;
  capacity_scope: string | null;
  lease_ttl_ms: number | null;
  heartbeat_ms: number | null;
  default_workflow: string | null;
  updated_at: string;
  updated_by: string | null;
};

function readPolicyRow(scopeKey: string): PolicyRow | undefined {
  return getDb().prepare(`SELECT * FROM dispatcher_policy WHERE scope_key = ?`).get(scopeKey) as
    | PolicyRow
    | undefined;
}

function coerceCapacityScope(raw: string | null): CapacityScope {
  return CAPACITY_SCOPES.includes(raw as CapacityScope) ? (raw as CapacityScope) : DEFAULT_CAPACITY_SCOPE;
}

/**
 * The policy as the dispatcher, the CLI and the dashboard all read it. Every value
 * falls back to its documented default when the column is NULL or the row absent, so
 * a partially written row is still a complete, safe answer.
 *
 * `projectKey` overlays ONLY the per-project default_workflow. A project row never
 * carries a ceiling — that is prevented by construction (setProjectDefaultWorkflow is
 * the only writer of a project row, and it writes one column), not by validation.
 */
export function getDispatcherPolicy(projectKey?: string): DispatcherPolicy {
  const host = readPolicyRow(HOST_POLICY_SCOPE);
  const project = projectKey && projectKey !== HOST_POLICY_SCOPE ? readPolicyRow(projectKey) : undefined;

  const leaseTtlMs = host?.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS;
  const heartbeatMs = host?.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS;
  return {
    armed: host?.armed === 1,
    maxActiveRuns: host?.max_active_runs ?? DEFAULT_MAX_ACTIVE_RUNS,
    capacityScope: coerceCapacityScope(host?.capacity_scope ?? null),
    leaseTtlMs,
    heartbeatMs,
    defaultWorkflow: project?.default_workflow ?? host?.default_workflow ?? DEFAULT_WORKFLOW,
    configured: host !== undefined,
    updatedAt: host?.updated_at ?? null,
    updatedBy: host?.updated_by ?? null,
  };
}

/**
 * Write the host-wide policy. A PARTIAL update: only the named fields move, and the
 * MERGED result is validated before anything is written, so raising the heartbeat
 * against an existing narrow TTL refuses by name rather than committing a cadence
 * that cannot survive one missed renewal.
 *
 * This is an ADMISSION test being edited, never a lifecycle command. Lowering
 * maxActiveRuns below current usage and setting armed=false both leave every live
 * claim, lease and container exactly as they were — no code path in this module
 * touches queue_claims at all.
 */
export function setDispatcherPolicy(update: DispatcherPolicyUpdate): DispatcherPolicy {
  const verb = "queue dispatcher policy-set";
  const updatedBy = requireUpdatedBy(update.updatedBy, verb);

  if (update.maxActiveRuns !== undefined) {
    if (typeof update.maxActiveRuns !== "number" || !Number.isSafeInteger(update.maxActiveRuns) || update.maxActiveRuns < 0) {
      throw new QueueRefusal(
        `forge: ${verb} refuses — max_active_runs must be a non-negative whole number, not ` +
          `'${String(update.maxActiveRuns)}'. A ceiling of 0 is legal and means "admit nothing"; a ` +
          `fractional or negative ceiling has no meaning against a count of live claims. ` +
          `Nothing was written.`,
        verb,
        null,
      );
    }
  }
  if (update.capacityScope !== undefined && !CAPACITY_SCOPES.includes(update.capacityScope)) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — capacity scope '${String(update.capacityScope)}' is not one of ` +
        `${CAPACITY_SCOPES.join(" | ")}. The scope decides WHAT the ceiling counts, so an unrecognised ` +
        `value cannot be defaulted quietly. Nothing was written.`,
      verb,
      null,
    );
  }
  if (update.defaultWorkflow !== undefined && (typeof update.defaultWorkflow !== "string" || update.defaultWorkflow.trim().length === 0)) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — the default workflow must be a non-empty workflow name. An empty ` +
        `default is an unresolvable launch target, which is the "nothing started and nothing said ` +
        `why" failure this ticket exists to close. Nothing was written.`,
      verb,
      null,
    );
  }

  const current = getDispatcherPolicy();
  const leaseTtlMs = update.leaseTtlMs ?? current.leaseTtlMs;
  const heartbeatMs = update.heartbeatMs ?? current.heartbeatMs;
  requireLeaseTtlFloor(leaseTtlMs, verb);
  requirePolicyCadence(leaseTtlMs, heartbeatMs, verb);

  const merged = {
    armed: update.armed ?? current.armed,
    maxActiveRuns: update.maxActiveRuns ?? current.maxActiveRuns,
    capacityScope: update.capacityScope ?? current.capacityScope,
    leaseTtlMs,
    heartbeatMs,
    defaultWorkflow: update.defaultWorkflow ?? readPolicyRow(HOST_POLICY_SCOPE)?.default_workflow ?? null,
  };

  return writeTransaction((): DispatcherPolicy => {
    const iso = new Date(storeNowMs()).toISOString();
    getDb()
      .prepare(
        `INSERT INTO dispatcher_policy
           (scope_key, armed, max_active_runs, capacity_scope, lease_ttl_ms, heartbeat_ms,
            default_workflow, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           armed = excluded.armed,
           max_active_runs = excluded.max_active_runs,
           capacity_scope = excluded.capacity_scope,
           lease_ttl_ms = excluded.lease_ttl_ms,
           heartbeat_ms = excluded.heartbeat_ms,
           default_workflow = excluded.default_workflow,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(
        HOST_POLICY_SCOPE,
        merged.armed ? 1 : 0,
        merged.maxActiveRuns,
        merged.capacityScope,
        merged.leaseTtlMs,
        merged.heartbeatMs,
        merged.defaultWorkflow,
        iso,
        updatedBy,
      );
    return getDispatcherPolicy();
  });
}

/**
 * The per-project row, which carries default_workflow and NOTHING else. There is no
 * per-project ceiling by construction: two dispatchers holding different ceilings
 * while enforcing against one shared count would make the effective ceiling
 * whichever ran last.
 */
export function setProjectDefaultWorkflow(opts: {
  projectKey: string;
  workflow: string;
  updatedBy: string;
}): DispatcherPolicy {
  const verb = "queue dispatcher workflow-set";
  const updatedBy = requireUpdatedBy(opts.updatedBy, verb);
  // Checked BEFORE the project guard: a project literally named 'host' would otherwise
  // be refused as unregistered, which describes the wrong problem.
  if (opts.projectKey === HOST_POLICY_SCOPE) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — '${HOST_POLICY_SCOPE}' is the reserved singleton scope_key of the ` +
        `host-wide policy row, so a project may not be named that. Nothing was written.`,
      verb,
      null,
    );
  }
  requireDbModeProject(opts.projectKey, verb);
  if (typeof opts.workflow !== "string" || opts.workflow.trim().length === 0) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — the workflow must be a non-empty workflow name. Nothing was written.`,
      verb,
      null,
    );
  }
  return writeTransaction((): DispatcherPolicy => {
    const iso = new Date(storeNowMs()).toISOString();
    getDb()
      .prepare(
        `INSERT INTO dispatcher_policy (scope_key, default_workflow, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           default_workflow = excluded.default_workflow,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(opts.projectKey, opts.workflow, iso, updatedBy);
    return getDispatcherPolicy(opts.projectKey);
  });
}

// ─── the dispatcher lease ────────────────────────────────────────────────────

type LeaseRow = {
  project_key: string;
  owner: string;
  generation: number;
  lease_expires_at_ms: number;
  heartbeat_at_ms: number;
  host: string | null;
  pid: number | null;
  created_at: string;
  updated_at: string;
};

function toLease(r: LeaseRow): DispatcherLease {
  return {
    projectKey: r.project_key,
    owner: r.owner,
    generation: r.generation,
    leaseExpiresAtMs: r.lease_expires_at_ms,
    heartbeatAtMs: r.heartbeat_at_ms,
    host: r.host,
    pid: r.pid,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function readLease(projectKey: string): DispatcherLease | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM dispatcher_leases WHERE project_key = ?`)
    .get(projectKey) as LeaseRow | undefined;
  return row ? toLease(row) : undefined;
}

export function getDispatcherLease(projectKey: string): DispatcherLease | undefined {
  return readLease(projectKey);
}

/** Every project a dispatcher has ever held a lease in. This is the audience for a
 *  HOST-WIDE change (the policy and the capacity ceiling are one value for the whole
 *  machine): a wake that reached only the project the operator happened to run in
 *  would leave every other live dispatcher on its watchdog. Lapsed leases are
 *  INCLUDED — an expired lease proves only that heartbeating stopped, and a wake for
 *  a project with no dispatcher is inert (it collapses onto one pending row and is
 *  consumed idempotently whenever a dispatcher next runs). */
export function dispatcherLeaseProjectKeys(): string[] {
  const rows = getDb()
    .prepare(`SELECT DISTINCT project_key FROM dispatcher_leases ORDER BY project_key ASC`)
    .all() as { project_key: string }[];
  return rows.map((r) => r.project_key);
}

/**
 * The operator-surface read: is there a dispatcher, is it authorized right now, and
 * when was it last actually alive. A dead dispatcher and an idle one are DIFFERENT
 * answers, and reporting the second when the first is true is the operator blindness
 * this ticket exists to close.
 */
export function dispatcherLeaseView(projectKey: string): DispatcherLeaseView {
  const now = storeNowMs();
  const lease = readLease(projectKey);
  if (!lease) return { lease: null, live: false, expired: false, msSinceHeartbeat: null, nowMs: now };
  const live = lease.leaseExpiresAtMs >= now;
  return {
    lease,
    live,
    expired: !live,
    msSinceHeartbeat: now - lease.heartbeatAtMs,
    nowMs: now,
  };
}

/**
 * Acquire, renew or take over the dispatcher lease for `owner`, in ONE immediate
 * transaction so the read-decide-write cannot race a concurrent dispatcher.
 * campaign-controller.ts:acquireCampaignLease's semantics exactly:
 *   - no lease yet                              → CREATE at generation 1.
 *   - our OWN lease (owner matches — a takeover CHANGES the owner, so an owner match
 *     proves nobody stepped past us)            → RENEW at the SAME generation. This is
 *     the restart-adoption path: a dispatcher whose owner is instance-stable across
 *     restarts re-adopts its own identity instead of waiting out its own lease or
 *     starting a second one.
 *   - a DIFFERENT owner, lease STRICTLY expired → TAKE OVER, bumping the generation.
 *     The superseded owner can then neither renew nor release.
 *   - a DIFFERENT owner, lease still LIVE       → DENIED. Waiting is not evidence of
 *     abandonment; a replacement fails closed and names the live holder.
 *
 * host/pid are recorded for the operator's "who holds this" answer only. Nothing keys
 * off them: physical liveness belongs to the tmux-owned ownership transfer.
 */
export function acquireDispatcherLease(opts: {
  projectKey: string;
  owner: string;
  ttlMs: number;
  host?: string;
  pid?: number;
}): DispatcherLeaseGrant {
  const verb = "queue dispatcher lease-acquire";
  requireDbModeProject(opts.projectKey, verb);
  requireLeaseTtlFloor(opts.ttlMs, verb);
  if (typeof opts.owner !== "string" || opts.owner.trim().length === 0) {
    throw new QueueRefusal(
      `forge: ${verb} refuses — a dispatcher lease needs an instance-stable owner identity, and none ` +
        `was supplied. An anonymous owner cannot be fenced, and an unfenceable lease is how two ` +
        `dispatchers drive the same queue. Nothing was written.`,
      verb,
      null,
    );
  }
  const { projectKey, owner, ttlMs } = opts;
  const host = opts.host ?? null;
  const pid = opts.pid ?? null;

  return writeTransaction((): DispatcherLeaseGrant => {
    const db = getDb();
    const now = storeNowMs();
    const iso = new Date(now).toISOString();
    const existing = readLease(projectKey);

    if (!existing) {
      db.prepare(
        `INSERT INTO dispatcher_leases
           (project_key, owner, generation, lease_expires_at_ms, heartbeat_at_ms, host, pid, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).run(projectKey, owner, now + ttlMs, now, host, pid, iso, iso);
      return { granted: true, lease: readLease(projectKey) as DispatcherLease, mode: "created" };
    }

    if (existing.owner === owner) {
      // Our own lease. Renew at the SAME generation, scoped to (owner, generation) so a
      // concurrent takeover that already stepped past us makes this a no-op and we
      // re-read the winner below rather than resurrecting a superseded identity.
      const res = db
        .prepare(
          `UPDATE dispatcher_leases
              SET lease_expires_at_ms = ?, heartbeat_at_ms = ?, host = ?, pid = ?, updated_at = ?
            WHERE project_key = ? AND owner = ? AND generation = ?`,
        )
        .run(now + ttlMs, now, host, pid, iso, projectKey, owner, existing.generation);
      if ((res.changes ?? 0) > 0) {
        return { granted: true, lease: readLease(projectKey) as DispatcherLease, mode: "renewed" };
      }
      return {
        granted: false,
        reason: "held_by_live_owner",
        lease: readLease(projectKey) as DispatcherLease,
      };
    }

    // A different owner holds it. Only a STRICTLY expired lease may be taken over —
    // `< now`, never `<=`. Waiting is not evidence of abandonment.
    if (existing.leaseExpiresAtMs < now) {
      const res = db
        .prepare(
          `UPDATE dispatcher_leases
              SET owner = ?, generation = ?, lease_expires_at_ms = ?, heartbeat_at_ms = ?,
                  host = ?, pid = ?, updated_at = ?
            WHERE project_key = ? AND generation = ? AND lease_expires_at_ms < ?`,
        )
        .run(
          owner,
          existing.generation + 1,
          now + ttlMs,
          now,
          host,
          pid,
          iso,
          projectKey,
          existing.generation,
          now,
        );
      if ((res.changes ?? 0) > 0) {
        return { granted: true, lease: readLease(projectKey) as DispatcherLease, mode: "took_over" };
      }
      // Lost the takeover race to another fresh dispatcher; report the current holder.
      return {
        granted: false,
        reason: "held_by_live_owner",
        lease: readLease(projectKey) as DispatcherLease,
      };
    }

    return { granted: false, reason: "held_by_live_owner", lease: existing };
  });
}

/**
 * Renew OUR live lease. Scoped to (project_key, owner, generation) AND a still-live
 * expiry, so a renewal after a takeover bumped the generation — or after our own lease
 * strictly lapsed — returns false and the caller FAILS CLOSED rather than dispatching
 * under a dead lease.
 *
 * Deliberately NOT gated on `armed`: a disarmed dispatcher keeps renewing, because a
 * lease that lapses while its claims are still executing invites a takeover and a
 * duplicate container. Disarm blocks new claims, never renewal (D5).
 */
export function renewDispatcherLease(opts: {
  projectKey: string;
  owner: string;
  generation: number;
  ttlMs: number;
}): boolean {
  const verb = "queue dispatcher lease-renew";
  requireLeaseTtlFloor(opts.ttlMs, verb);
  return writeTransaction((): boolean => {
    const now = storeNowMs();
    const res = getDb()
      .prepare(
        `UPDATE dispatcher_leases
            SET lease_expires_at_ms = ?, heartbeat_at_ms = ?, updated_at = ?
          WHERE project_key = ? AND owner = ? AND generation = ? AND lease_expires_at_ms >= ?`,
      )
      .run(
        now + opts.ttlMs,
        now,
        new Date(now).toISOString(),
        opts.projectKey,
        opts.owner,
        opts.generation,
        now,
      );
    return (res.changes ?? 0) > 0;
  });
}

/**
 * The authorization predicate, checked immediately before a dispatch decision and
 * re-checked across it: does owner@generation hold the LIVE lease AT THIS INSTANT?
 * True only when the row exists, owner and generation match exactly, and the lease has
 * not expired on the STORE clock. An expired former owner is fenced.
 */
export function dispatcherLeaseHeldBy(projectKey: string, owner: string, generation: number): boolean {
  const now = storeNowMs();
  const row = getDb()
    .prepare(
      `SELECT 1 FROM dispatcher_leases
        WHERE project_key = ? AND owner = ? AND generation = ? AND lease_expires_at_ms >= ?`,
    )
    .get(projectKey, owner, generation, now);
  return row !== undefined;
}

/**
 * Release the lease on an orderly shutdown. Owner/generation-scoped, so a superseded
 * dispatcher can never clear the live holder's identity.
 *
 * Releasing a dispatcher LEASE releases no CLAIM. The two are separate durable facts:
 * this row says who may decide, queue_claims says what is reserved. A dispatcher that
 * exits while claims are live leaves them to the claim primitive's own lease, takeover
 * and launch-adoption path — which is exactly the recovery FG-610 shipped.
 */
export function releaseDispatcherLease(projectKey: string, owner: string, generation: number): boolean {
  return writeTransaction((): boolean => {
    const res = getDb()
      .prepare(`DELETE FROM dispatcher_leases WHERE project_key = ? AND owner = ? AND generation = ?`)
      .run(projectKey, owner, generation);
    return (res.changes ?? 0) > 0;
  });
}
