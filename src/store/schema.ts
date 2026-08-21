// SQLite schema, exactly as specified in the spine sketch. One-time migration.

// FG-608 (reopen): ticket_events' CONSTRAINT shape has two consumers — the CREATE
// below, and the rebuild migration in db.ts that converges a table whose shape
// diverged before `CREATE TABLE IF NOT EXISTS` could ever fix it. They must be the
// same text, so they are: the rebuild creates its replacement table from this
// builder, and the canonical PK/column lists here are what db.ts detects against.
export const TICKET_EVENTS_COLUMNS = [
  "event_key",
  "project_key",
  "ticket_id",
  "event_type",
  "payload",
  "created_at",
] as const;

export const TICKET_EVENTS_PRIMARY_KEY = ["project_key", "ticket_id", "event_key"] as const;

// Always on the final table name: the rebuild creates its index only after the
// replacement has been renamed into place (index names are database-wide, so the
// old table's index must be gone first).
export const TICKET_EVENTS_INDEX_NAME = "idx_ticket_events_ticket";

const TICKET_EVENTS_INDEX_BODY = `${TICKET_EVENTS_INDEX_NAME} ON ticket_events(project_key, ticket_id)`;

// The canonical definition as sqlite_master records it — SQLite stores the CREATE
// text verbatim, minus `IF NOT EXISTS`. db.ts detects index divergence by comparing
// the live sqlite_master.sql against THIS string (whitespace-normalized), which is
// one comparison covering columns and their order, DESC, COLLATE, UNIQUE and
// partiality — none of which PRAGMA index_info reports — and which cannot drift from
// the DDL because it is built from the same body the DDL is.
export const TICKET_EVENTS_INDEX_CANONICAL_SQL = `CREATE INDEX ${TICKET_EVENTS_INDEX_BODY}`;

export const TICKET_EVENTS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${TICKET_EVENTS_INDEX_BODY}`;

export function ticketEventsTableSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  event_key   TEXT NOT NULL,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id, event_key),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
)`;
}

// FG-693 — THE CANONICAL PROJECT-IDENTITY COLUMN, and what the pair of columns means.
//
// Five tables are keyed on a project directory: runs, campaigns, host_verifications,
// orchestrator_receipts and launch_observations. Each already carries a `project_dir`
// holding whatever spelling the caller supplied. On macOS `/tmp` and `/private/tmp`
// name one tree, as do `/var` and `/private/var`; a symlinked parent, a relative
// spelling and a trailing separator produce the same class of alias anywhere. So a raw
// `project_dir` cannot answer "is this the same checkout" — which is the defect FG-693
// exists to close.
//
// Each of those tables therefore gains ONE additive column, `project_dir_canonical`.
// The two columns answer two different questions and NEITHER substitutes for the other:
//
//   project_dir            — WHAT THE CALLER WROTE. Audit evidence. Its bytes are
//                            preserved VERBATIM and are NEVER rewritten, backfilled or
//                            converged by any migration. It may be shown to an operator
//                            (presentation fidelity is useful) and it decides NOTHING.
//   project_dir_canonical  — PROVEN filesystem identity, or NULL. It is written only
//                            when the filesystem actually answered for the path; when
//                            resolution failed the column is NULL. A LEXICALLY resolved
//                            path is NEVER stored here.
//
// NULL IS A FIRST-CLASS VALUE and means "identity was never proven for this row". That
// is exactly the ambiguity this column exists to remove: canonicalReceiptProjectDir
// (src/store/orchestrator-receipts.ts) delegates to projectIdentity, whose fallback
// writes a lexically-resolved path on realpath failure — so `orchestrator_receipts`
// today holds an unmarked MIX of proven and guessed values under one column, with no
// way for a reader to tell them apart. A separate column with an honest NULL is how a
// reader can. Every pre-change row reads back NULL, which is the truth about it: nothing
// proved its identity, and no migration may pretend otherwise.
//
// NOTHING IS BACKFILLED. Resolving a stored spelling at migration time would establish
// only that it resolves TODAY — never that it resolves to the tree the row was written
// against — so a backfill would mint proof that does not exist. The read-time
// compatibility rule for NULL-canonical rows lives in the store modules (FG-693 steps 4
// and 6), not here.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  metadata        TEXT,
  project_dir     TEXT,
  -- FG-693: PROVEN canonical identity of project_dir, or NULL when it was never proven.
  -- project_dir above keeps the caller's bytes verbatim; this column is what a lookup
  -- or a project-scoped aggregation compares, so one checkout spelled two ways is one
  -- project. Never a lexical fallback. See the block comment above SCHEMA_SQL.
  project_dir_canonical TEXT,
  -- FG-638: exactly one review authority model per run. NOT NULL with a DEFAULT so a
  -- row written by a binary that predates the ledger (or by an INSERT that omits the
  -- column) reads back the legacy verdict/blocked_by_red model rather than NULL.
  review_mode     TEXT NOT NULL DEFAULT 'legacy_verdict',
  -- FG-663: the DURABLE project a run belongs to, captured at CREATION while the
  -- checkout is still readable, and read back thereafter — NEVER re-derived from a
  -- project_dir that may be gone. This is SAME-PROJECT identity and is orthogonal to
  -- project_dir_canonical (SAME-CHECKOUT identity): a disposable clone and its
  -- canonical checkout share this value but differ in project_dir_canonical. Holds a
  -- pk- key (the declared/registered project_key) when the checkout declares or maps to
  -- one, else the resolved repo- evidence key captured at creation, else NULL when
  -- there is no project_dir. Nullable with NO default: a pre-FG-663 row's project was
  -- never captured, and NULL is the only honest reading — legacy rows fall back to the
  -- live read-time resolution path. See the resolver in src/store/runs.ts.
  project_identity TEXT
);
-- FG-563 (CP1, FIX5): the check-before-spawn hot path (runByDispatchKey, fired on
-- every continuation wake/dispatch) resolves the ONE physical run created under a
-- deterministic dispatch receipt. An expression index over the JSON-extracted
-- receipt lets that lookup use an indexed equality probe instead of a full-table
-- scan + per-row JSON.parse.
--
-- FG-563 (FIX A/FIX B, round 2): this index is NOT created here. An expression
-- index over json_extract(metadata, ...) is INVALID against a runs table that
-- has no metadata column, and SCHEMA_SQL is exec'd on EVERY DB open (FG-568,
-- read opens included). A foreign/minimal runs fixture without a metadata column
-- (e.g. the dashboard read tests) would make CREATE INDEX throw SQLITE_ERROR and
-- fail every open. So the index moved to applyMigrations (db.ts), guarded on the
-- presence of the metadata column via PRAGMA table_info -- and it is UNIQUE there
-- (FIX B) so two concurrent same-host controllers cannot both insert a physical run
-- under the same continuation dispatch receipt. Production runs always has
-- metadata, so it is created exactly as before; a metadata-less open no longer
-- throws.

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  parent_id       TEXT REFERENCES tasks(id),
  phase           TEXT NOT NULL,
  agent_role      TEXT NOT NULL,
  agent_alias     TEXT,
  agent_model     TEXT,
  status          TEXT NOT NULL,
  task_package    TEXT NOT NULL,
  result          TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  error           TEXT,
  -- AWN-7: per-task model resolution record (policy mode). Null in legacy mode
  -- (no model-policy.yml) and for pre-AWN-7 rows. agent_alias/agent_model above
  -- already carry the capability alias + concrete model; these add the named
  -- policy decision that explains the selection. resolved_auth is the EFFECTIVE
  -- mode (never 'auto'). resolved_by names the rule that chose the profile.
  resolved_profile  TEXT,
  resolved_provider TEXT,
  resolved_auth     TEXT,
  resolved_by       TEXT,
  -- FG-560: two INDEPENDENT provenance axes, distinct from resolved_by (which
  -- records how the PROFILE was selected). resolved_capability_source is where the
  -- capability alias came from ('explicit' from the step activity vs 'role-derived'
  -- from the agent default); resolved_mapping_path is how the concrete model was
  -- read out of the profile map ('exact' hit vs 'default-fallback' to map.default).
  -- Null in legacy mode (no model-policy.yml) and for pre-FG-560 rows. On the aged
  -- host DB the CREATE below no-ops, so the ALTER in ADDITIVE_COLUMNS is what adds
  -- these columns there — mirroring the resolved_* columns exactly.
  resolved_capability_source TEXT,
  resolved_mapping_path      TEXT,
  -- FG-351: per-task git worktree path. Null when worktree mode is disabled (default).
  -- Set BEFORE runContainer and readable after process restart. Task branch identity
  -- is deterministically derived as forge/<runId>/<taskId> — no separate DB column needed.
  worktree_path     TEXT,
  -- FG-621: the commit the task's private clone was created AT. Recorded with
  -- worktree_path, BEFORE the container starts, so base selection is an asserted
  -- fact rather than something inferred from where HEAD happened to be. Null for
  -- the linked-worktree/shared-mount paths and for pre-FG-621 rows.
  base_sha          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS verdicts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  red_task_id     TEXT NOT NULL REFERENCES tasks(id),
  red_role        TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  confidence      REAL NOT NULL,
  authority       TEXT NOT NULL,
  findings        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  -- FG-523 (F16): the red's gate_on_verdict config, captured at verdict-insert
  -- time. Dispatch blocks on the in-hand config; the later gate re-check
  -- (aggregateVerdicts) reads rows — without this column the two sites derive
  -- blocking from different data. Nullable: legacy rows read back NULL and
  -- fail closed (treated as true), preserving pre-migration behavior.
  gate_on_verdict INTEGER
);
CREATE INDEX IF NOT EXISTS idx_verdicts_task ON verdicts(task_id);

CREATE TABLE IF NOT EXISTS gates (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  decision        TEXT NOT NULL,
  rationale       TEXT,
  decided_at      TEXT NOT NULL,
  decided_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gates_task ON gates(task_id);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  task_id         TEXT,
  event_type      TEXT NOT NULL,
  payload         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
-- FG-487: dashboard verification-visibility queries filter by event_type IN
-- (...) and order by created_at; without this the "in progress" / "phases"
-- polls (4x per 2s tick per open tab) full-scan the whole table.
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at);

-- #155: model_calls — one row per Anthropic API request (deduped by request_id).
-- Populated by spawn.ts at task-completion (and by "forge usage backfill" for
-- historical runs). Drives "forge usage" rollups + dashboard usage view.
--
-- Note re: the original schema (#27 era): cost was an INTEGER hardcoded-table-
-- multiply. We dropped it — OAuth has no per-token cost; Anthropic + Bedrock
-- prices drift; cache tiers complicate the math. Token counts are the stable
-- signal; users multiply by current prices themselves when they want dollars.
CREATE TABLE IF NOT EXISTS model_calls (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id                  TEXT REFERENCES tasks(id),   -- nullable: backfill leaves null when log lacks a clean owner
  request_id               TEXT NOT NULL,                -- Anthropic req_xxx, used for dedupe across stream events
  model                    TEXT NOT NULL,                -- e.g. claude-opus-4-7 (normalized, no provider prefix)
  alias                    TEXT,                         -- workflow-declared alias (spec-writer / default / fast-orchestrator)
  input_tokens             INTEGER NOT NULL DEFAULT 0,   -- fresh (uncached) input tokens
  output_tokens            INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens        INTEGER NOT NULL DEFAULT 0,   -- read from prompt cache — ~10% the cost of fresh input
  cache_creation_tokens    INTEGER NOT NULL DEFAULT 0,   -- written to prompt cache — ~125% the cost of fresh input
  created_at               TEXT NOT NULL                  -- ISO timestamp from the message event
);
-- task_id index is created by applyMigrations (it only exists after the
-- ALTER TABLE adds the column on existing DBs; including it here would fail
-- on the IF-NOT-EXISTS path because CREATE INDEX doesn't honor "IF column
-- exists"). request_id + created_at indexes are also created there for
-- symmetry — see db.ts.

CREATE TABLE IF NOT EXISTS campaigns (
  id                  TEXT PRIMARY KEY,
  status              TEXT NOT NULL,
  source_kind         TEXT NOT NULL,
  source_input        TEXT NOT NULL,
  mode                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  metadata            TEXT,
  plan_hash           TEXT,
  approved_by         TEXT,
  approved_at         TEXT,
  approval_rationale  TEXT,
  approved_plan_hash  TEXT,
  project_dir         TEXT,
  -- FG-693: PROVEN canonical identity of project_dir, or NULL. See SCHEMA_SQL's header.
  project_dir_canonical TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS campaign_items (
  id                     TEXT PRIMARY KEY,
  campaign_id            TEXT NOT NULL REFERENCES campaigns(id),
  item_order             INTEGER NOT NULL,
  ticket_id              TEXT NOT NULL,
  run_id                 TEXT,
  branch                 TEXT,
  worktree_path          TEXT,
  pr_url                 TEXT,
  lifecycle_status       TEXT NOT NULL,
  outcome                TEXT,
  blocker_kind           TEXT,
  continue_policy        TEXT,
  reason                 TEXT,
  requested_human_action TEXT,
  -- FG-596: the item's LOGICAL attempt generation. Additive, non-null with a safe
  -- default so pre-FG-596 rows read back 0 (the "never allocated" marker; a real
  -- attempt is >= 1). New DBs get it here; existing DBs via applyMigrations (db.ts).
  attempt_generation     INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_items_campaign ON campaign_items(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_items_status ON campaign_items(lifecycle_status);

-- FG-419: host-side verification evidence, recorded after real host commands complete.
-- run_id is nullable (TEXT to match runs.id type); gate_name is the logical gate being
-- verified (default "npm run test:all", overridable via .forge/config.json).
-- FG-474: source distinguishes a row backed by a REAL host command execution ('host',
-- the default) from one backed by a green required CI check ('ci') — done-audit and
-- reconcile-collect's evidence-reuse consult both need to tell the two apart. ci_url
-- carries the CI check's details URL for ci-sourced rows (null for host-sourced ones).
CREATE TABLE IF NOT EXISTS host_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  gate_name   TEXT NOT NULL,
  command     TEXT NOT NULL,
  exit_code   INTEGER NOT NULL,
  run_id      TEXT REFERENCES runs(id),
  recorded_at TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'host',
  ci_url      TEXT,
  -- FG-693: PROVEN canonical identity of project_dir, or NULL. Gate evidence is the
  -- ACTING class — a row whose identity was never proven must not silently satisfy a
  -- gate for a checkout it cannot be shown to belong to — so the NULL here is what a
  -- reader needs in order to decline rather than guess. See SCHEMA_SQL's header.
  project_dir_canonical TEXT
);
CREATE INDEX IF NOT EXISTS idx_host_verifications_lookup
  ON host_verifications(ticket_id, project_dir, commit_sha, gate_name);

-- FG-425: the serialized integration publisher's durable state. Three tables,
-- all keyed on CANONICAL project identity (realpath-canonicalized projectDir).
-- New tables, so no ALTER migration is needed: getDb() execs this SCHEMA_SQL on
-- every open, and CREATE TABLE IF NOT EXISTS brings an existing DB forward.
--
-- publication_attempts is the AD-5/AD-6 record: publication INTENT is written
-- here BEFORE any target mutation, and recovery is derived from
-- {base_sha, candidate_sha, current target sha} alone — never from working-tree
-- contents. published_sha must always equal candidate_sha (AD-6).
CREATE TABLE IF NOT EXISTS publication_attempts (
  attempt_id    TEXT PRIMARY KEY,
  project_key   TEXT NOT NULL,
  canonical_dir TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  target        TEXT NOT NULL,
  base_sha      TEXT,
  candidate_sha TEXT,
  published_sha TEXT,
  state         TEXT NOT NULL,
  park_reason   TEXT,
  worktree_path TEXT,
  rebuild_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publication_attempts_project
  ON publication_attempts(project_key, created_at);

-- The FIFO lane (AD-2). ORDERING authority, and only that: enqueue_seq is the
-- DURABLE enqueue key, assigned when the request is RECORDED — before any
-- contention. FIFO derives from this column, never from lock-acquisition order
-- (OS lock grants are unordered). lease_expires_at_ms is owner-written and
-- owner-renewed; a takeover is permitted ONLY when it is actually in the past.
-- Waiting is not evidence of abandonment: a live waiter renews and is never
-- evictable, however long it waits.
CREATE TABLE IF NOT EXISTS publication_lane (
  attempt_id          TEXT PRIMARY KEY REFERENCES publication_attempts(attempt_id),
  project_key         TEXT NOT NULL,
  enqueue_seq         INTEGER NOT NULL,
  run_id              TEXT NOT NULL,
  state               TEXT NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  enqueued_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publication_lane_order
  ON publication_lane(project_key, enqueue_seq);

-- The publication MUTEX. Mutual-exclusion authority, deliberately SEPARATE from
-- the lane's ordering authority — collapsing the two would make correctness
-- depend on the lane being exact, and it is only approximate. Held ONLY across
-- CAS + fast-forward (+ working-tree checkout update); NEVER across validation.
CREATE TABLE IF NOT EXISTS publication_locks (
  project_key    TEXT PRIMARY KEY,
  attempt_id     TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms  INTEGER NOT NULL
);

-- FG-562 (BD-5): the durable continuation-claim primitive. A controller that
-- observes a launch terminal state claims exactly ONE next action through a
-- phase-bound compare-and-set here; delivery is at-least-once, advancement is
-- exactly-once-claimed. Same additive-only shape as the FG-425 publication trio:
-- a brand-new table via CREATE TABLE IF NOT EXISTS on the ordinary open path, so
-- an old binary that knows nothing of it is never broken (BD-15). EVERY
-- idempotency constraint stays INSIDE this table — the UNIQUE INDEX on
-- dispatch_key is SAFE precisely because only NEW binaries ever insert here.
--
-- consumer_kind and state are UNCONSTRAINED TEXT with NO CHECK (FG-585 precedent:
-- enum-as-convention). An old/new binary must never fight an enum constraint the
-- other side doesn't share.
--
-- next_action is a CANONICALLY-serialized structured action (stable key order),
-- NEVER an opaque shell string: the CAS compares next_action = ? and derives
-- dispatch_key from it, so its serialization must be identical across processes
-- and versions.
--
-- claim_expires_at is a renewable lease (epoch ms); a takeover is permitted ONLY
-- when it is strictly in the past, mirroring publication_lane.lease_expires_at_ms.
--
-- dispatch_key is the deterministic idempotency receipt derived from
-- (continuation_id, source_launch_id, canonical next_action) and written at CLAIM
-- time, BEFORE dispatch — so a recovery after a claim-to-dispatch crash adopts the
-- ORIGINAL dispatch by key instead of issuing a duplicate (F17).
--
-- last_observed_status is the canonical LaunchStatus.state recorded on wake (BD-3
-- evidence). It is NEVER derived by reading an exit file directly — the controller
-- goes through readLaunch/classifyExit and records the classifier's verdict here.
CREATE TABLE IF NOT EXISTS continuations (
  continuation_id      TEXT PRIMARY KEY,
  consumer_kind        TEXT NOT NULL,
  source_launch_id     TEXT NOT NULL,
  current_phase        TEXT NOT NULL,
  next_action          TEXT NOT NULL,
  state                TEXT NOT NULL,
  claim_owner          TEXT,
  claim_expires_at     INTEGER,
  dispatch_key         TEXT,
  dispatched_run_id    TEXT,
  dispatched_task_id   TEXT,
  last_observed_status TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_continuations_launch
  ON continuations(source_launch_id);
-- The idempotency receipt is unique across the table. Partial so the many rows
-- with no dispatch_key yet (never claimed) do not collide — SQLite treats each
-- NULL as distinct anyway, but the partial index states the intent and is safe
-- because only new binaries ever write this column.
CREATE UNIQUE INDEX IF NOT EXISTS idx_continuations_dispatch_key
  ON continuations(dispatch_key) WHERE dispatch_key IS NOT NULL;

-- FG-562 (Finding 2): a durable, append-only audit of STALE observations — a
-- delayed launch-completion event whose source_launch_id no longer matches the
-- slot's current launch (the phase already advanced past it). The launch-bound
-- observe matches 0 rows in continuations; rather than SILENTLY discarding that
-- evidence (the audit-loss the AC forbids), it appends a row here. Audit-only: the
-- claim path never reads this table, and a stale observation NEVER advances a phase.
-- Purely additive (CREATE TABLE IF NOT EXISTS on the ordinary open path), so an old
-- binary that predates it is never broken (BD-15) — the same additive contract as
-- continuations itself.
CREATE TABLE IF NOT EXISTS continuation_stale_observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  continuation_id  TEXT NOT NULL,
  source_launch_id TEXT NOT NULL,
  current_phase    TEXT NOT NULL,
  status           TEXT NOT NULL,
  observed_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_continuation_stale_obs_cont
  ON continuation_stale_observations(continuation_id);

-- FG-563 (BD-9, Slice 4): the durable lost-signal watchdog audit — DISTINCT from
-- continuation_stale_observations. The two answer DIFFERENT questions and must
-- never be conflated:
--   continuation_stale_observations  — "a launch-completion event arrived for a
--                                       SUPERSEDED launch" (the slot already moved
--                                       past that launch): observed-and-ignored.
--   continuation_lost_signal_recoveries — "the low-frequency health WATCHDOG
--                                       discovered a launch that reached a terminal
--                                       disposition but was NEVER advanced (the
--                                       normal completion event was lost), and the
--                                       watchdog itself recovered it": a genuine
--                                       lost-signal recovery.
--
-- A row is written ONLY when a WATCHDOG-triggered consume advances a
-- terminal-but-unadvanced continuation (BD-9: the watchdog recorded that it
-- recovered a lost signal BEFORE advancing). It is NEVER written when the normal
-- delivery event already advanced the slot (F18: no false lost-signal claim), nor
-- when the watchdog fires while the launch is STILL RUNNING (it re-arms, writing
-- nothing). It answers, WITHOUT transcript archaeology: which controller recovered
-- it (controller), which launch (source_launch_id), and that it was
-- recovered-by-watchdog rather than by normal delivery (recovery_trigger).
--
-- Purely additive (CREATE TABLE IF NOT EXISTS on the ordinary open path) with NO
-- ALTER to runs — the SAME BD-15 old/new-binary compatibility discipline as
-- continuations / continuation_stale_observations: only a NEW binary ever writes
-- it, so an OLD binary that predates it is never broken. consumer_kind /
-- recovery_trigger are UNCONSTRAINED TEXT (enum-as-convention, FG-585) — no CHECK
-- an old/new binary could fight.
CREATE TABLE IF NOT EXISTS continuation_lost_signal_recoveries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  continuation_id    TEXT NOT NULL,
  source_launch_id   TEXT NOT NULL,
  current_phase      TEXT NOT NULL,
  consumer_kind      TEXT NOT NULL,
  controller         TEXT NOT NULL,
  observed_status    TEXT NOT NULL,
  recovery_trigger   TEXT NOT NULL,
  dispatch_key       TEXT,
  dispatched_run_id  TEXT,
  dispatched_task_id TEXT,
  recovered_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_continuation_lost_signal_cont
  ON continuation_lost_signal_recoveries(continuation_id);
CREATE INDEX IF NOT EXISTS idx_continuation_lost_signal_launch
  ON continuation_lost_signal_recoveries(source_launch_id);

-- FG-564 (Slice 5b, D1/AC7): the durable campaign-controller LEASE. A campaign's
-- physical controller/drive is a longer-lived owner than the FG-562 per-phase
-- continuation claim; the campaign 'running' status is NOT a singleton fence (it
-- cannot distinguish two controller instances). This table fences the ONE live
-- physical driver: an instance-stable owner (campaign@<campaignId>@<controllerInstanceId>),
-- a generation/epoch bumped on every takeover, and a renewable expiry lease.
--
-- Same additive-only BD-15 contract as the FG-425/FG-562 tables: a brand-new table
-- via CREATE TABLE IF NOT EXISTS on the ordinary open path, so an old binary that
-- knows nothing of it is never broken. EVERY idempotency constraint stays INSIDE the
-- table (campaign_id is the PRIMARY KEY — one lease per campaign) and is SAFE because
-- only new binaries ever write here. owner is UNCONSTRAINED TEXT (no CHECK).
--
-- lease_expires_at_ms is a renewable lease (epoch ms, the store's own clock via
-- storeNowMs); a takeover is permitted ONLY when it is STRICTLY in the past, mirroring
-- publication_lane.lease_expires_at_ms and continuations.claim_expires_at. generation
-- is the fencing token: a takeover bumps it, so an EXPIRED original owner's stale
-- generation can never write/advance/audit/re-drive after a newer controller took over.
CREATE TABLE IF NOT EXISTS campaign_controller_leases (
  campaign_id         TEXT PRIMARY KEY REFERENCES campaigns(id),
  owner               TEXT NOT NULL,
  generation          INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- FG-564 (Slice 5b, AC10): the durable item-attempt LAUNCH LINKAGE. FG-596's
-- launchDriveItemUnderForge receives a random source_launch_id locally and then waits;
-- this table makes the relationship between (campaign_id, item_id, attempt_generation)
-- and that launch DURABLE before a continuation waiter is relied on. Recovery discovers
-- it DIRECTLY — never by parsing launch names, argv, timestamps, or other heuristics.
--
-- The row carries an IMMUTABLE born-under fencing token (controller_owner +
-- controller_generation) stamped once at launch time: the campaign-controller lease
-- owner/generation the launch was born under. AC-ADOPT-DRIVE compares this original
-- born-under token against the currently-held lease immediately before physical work.
--
-- The composite (campaign_id, item_id, attempt_generation) is the PRIMARY KEY: exactly
-- one launch linkage per item-attempt, so a rearmed retry (a NEW attempt_generation)
-- gets its OWN row and a stale prior-attempt completion can never satisfy the new one.
-- Additive-only BD-15: only new binaries write it; source_launch_id is separately
-- indexed so recovery can resolve a linkage from a launch id.
CREATE TABLE IF NOT EXISTS campaign_item_launches (
  campaign_id           TEXT NOT NULL REFERENCES campaigns(id),
  item_id               TEXT NOT NULL,
  attempt_generation    INTEGER NOT NULL,
  source_launch_id      TEXT NOT NULL,
  controller_owner      TEXT NOT NULL,
  controller_generation INTEGER NOT NULL,
  run_id                TEXT,
  state                 TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (campaign_id, item_id, attempt_generation)
);
CREATE INDEX IF NOT EXISTS idx_campaign_item_launches_campaign
  ON campaign_item_launches(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_item_launches_source_launch
  ON campaign_item_launches(source_launch_id);

-- FG-606 (FG-496 Slice A): the DB ticket schema + project identity registry.
-- ALL of the following are BRAND-NEW tables created via CREATE TABLE IF NOT
-- EXISTS on the ordinary open path — the same additive-only BD-15 contract as
-- the FG-425 / FG-562 tables above: an old binary that predates them is never
-- broken, and user_version is NOT bumped (FG-568 forward-gate contract).
--
-- CRUCIAL distinction from the FG-563 index hazard: FG-563's index was invalid
-- because it referenced a column on a PRE-EXISTING foreign table (runs) whose
-- minimal fixtures might lack the column, and CREATE INDEX runs on EVERY open.
-- The indexes below are over NEW tables that this very SCHEMA_SQL creates with a
-- known, complete shape in the same exec — there is no foreign minimal shape to
-- throw against — so plain column indexes here are safe. No expression/partial
-- index is used; the identity uniqueness lives in inline table constraints.

-- The project-identity REGISTRY: the single durable arbiter of which project_key
-- a repository owns. Keyed on repositoryCheckoutIdentity's CONVERGING evidence
-- key (remote > git-common-dir > path), which groups linked worktrees and
-- independent clones. TWO-DIRECTIONAL DB-level uniqueness, both inline:
--   project_key       PRIMARY KEY  -> one repository-evidence key per project_key
--                                     (a copied key into an unrelated repo is refused)
--   repo_evidence_key UNIQUE       -> one project_key per repository-evidence key
--                                     (two worktrees can never split into two backlogs)
CREATE TABLE IF NOT EXISTS project_identity (
  project_key          TEXT PRIMARY KEY,
  repo_evidence_key    TEXT NOT NULL UNIQUE,
  repo_evidence_source TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

-- Tickets — the non-authoritative shadow. Keyed by (project_key, ticket_id) so
-- FG-123 in two different projects (even sharing a prefix) coexist as distinct
-- rows. status is limited to active/done/deferred (NO blocked — legacy blocked
-- maps to active + a blocker_evidence row). frontmatter carries any extra
-- YAML keys as JSON so nothing is lost on import.
-- imported_from is the CANONICAL source directory (realpath) the ticket was last
-- imported from. It is the reconcile PROVENANCE key: two linked worktrees of one
-- project share a project_key but have different Markdown sets, so removal
-- reconciliation must prune only the tickets THIS source directory previously
-- imported and no longer has — never a sibling worktree's tickets. Nullable so a
-- direct upsert (non-import caller) need not supply it.
CREATE TABLE IF NOT EXISTS tickets (
  project_key   TEXT NOT NULL,
  ticket_id     TEXT NOT NULL,
  type          TEXT NOT NULL,
  -- The DB status vocabulary is exactly active/done/deferred (NO blocked — legacy
  -- blocked maps to active + a blocker_evidence row). A CHECK enforces it at the
  -- SQLite layer so a direct write (bypassing the DbTicketStatus TS type) cannot
  -- introduce an out-of-vocabulary status.
  status        TEXT NOT NULL CHECK (status IN ('active', 'done', 'deferred')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  created       TEXT,
  closed        TEXT,
  closed_commit TEXT,
  epic          TEXT,
  frontmatter   TEXT,
  imported_at   TEXT NOT NULL,
  imported_from TEXT,
  -- FG-609 (FG-496 Slice D): the CANONICAL operator stack rank. Nullable — an
  -- unranked ticket is a perfectly valid backlog item, not a deprioritized one.
  -- This is a STACK RANK across the project's ranked tickets (dense contiguous
  -- integers, renumbered whole by every rank-changing verb), NOT a P0-P4 score and
  -- NOT a queue position: there is exactly ONE rank, so a backlog priority and a
  -- queue position can never drift apart.
  --
  -- DELIBERATELY UNINDEXED. An index would pin the column undroppable and shrink
  -- the FG-608 parity guard's coverage (its UNDROPPABLE set). The queue-ordering
  -- index lives on queue_membership, a brand-new table that never travels the
  -- ALTER path. Ordering reads are per-project over a few hundred rows.
  --
  -- NO UNIQUE constraint. SQLite has no deferrable unique index, so an
  -- in-transaction renumber would transit duplicate states and abort. Read order
  -- is made TOTAL instead — rank ASC, then ticket_id ASC — so equal ranks are
  -- deterministic rather than arbitrary. A rank VALUE is not stable across moves;
  -- nothing durable may key off one, only off the ordering.
  priority_rank INTEGER,
  PRIMARY KEY (project_key, ticket_id)
);

-- Ticket events — append-shaped audit, keyed by (project_key, ticket_id). A
-- deterministic natural id (event_key) makes re-import idempotent: the same
-- logical event UPSERTs rather than duplicating. The composite FK to tickets
-- forbids orphan/cross-project event rows; ON DELETE CASCADE prunes an event when
-- its owning ticket is removed (the reconcile removal path relies on it).
${ticketEventsTableSql("ticket_events")};
${TICKET_EVENTS_INDEX_SQL};

-- Ticket relations — keyed by (project_key, ticket_id). The composite PRIMARY
-- KEY makes re-import idempotent (the same relation UPSERTs, never duplicates).
-- The composite FK to tickets forbids orphan/cross-project relation rows (the
-- OWNING side only — related_id is a free reference, possibly to a ticket not in
-- this shadow); ON DELETE CASCADE prunes a relation when its ticket is removed.
CREATE TABLE IF NOT EXISTS ticket_relations (
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  related_id  TEXT NOT NULL,
  rel_type    TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id, related_id, rel_type),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);

-- Host-side storage mode, keyed by project_key (default 'markdown'). Stored in
-- the DB, NOT per-worktree config, so two worktrees can never disagree about
-- which store is authoritative. Nothing reads this for behavior in Slice A.
CREATE TABLE IF NOT EXISTS ticket_storage_mode (
  project_key TEXT PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT 'markdown',
  updated_at  TEXT NOT NULL
);

-- Id-allocation sequence per (project_key, prefix). Defined here; the allocation
-- BEHAVIOR lands in Slice B once Markdown is no longer authoritative.
CREATE TABLE IF NOT EXISTS ticket_id_sequence (
  project_key TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  next_seq    INTEGER NOT NULL,
  PRIMARY KEY (project_key, prefix)
);

-- Minimal durable blocker evidence (introduced HERE, not Slice D). Import maps a
-- legacy status:blocked ticket to active + a row here, so blocker state survives
-- the Slice C cutover (which precedes Slice D). The UNIQUE natural key
-- (project_key, ticket_id, source) makes re-import idempotent. Slice D ENRICHES
-- this table; it does not introduce it.
--
-- FG-609 (Slice D) ENRICHES this table with four ADDITIVE columns. The UNIQUE
-- natural key is NOT widened and the table is NOT rebuilt: every enriched kind
-- folds its discriminating identity into the 'source' value instead (see
-- blocked-source.ts), so two distinct dependency blockers on one ticket are two
-- rows rather than one silently overwriting the other.
--
-- kind carries a DEFAULT so every Slice A row reads back 'legacy_blocked' with no
-- backfill — its original fact, reason, source and created_at are preserved
-- untouched. It is free TEXT with NO CHECK (enum-as-convention, FG-585): an
-- in-flight older writer's inserts must never fight a constraint it doesn't know.
CREATE TABLE IF NOT EXISTS blocker_evidence (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  reason      TEXT,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'legacy_blocked',
  -- Free-form JSON describing the blocker (the dependency's id, the campaign, the
  -- run). Never parsed for a status decision — only rendered.
  detail      TEXT,
  -- READINESS BINDING: the ticket body hash this evidence was observed against, so
  -- an operator can see that a blocker predates the ticket's current revision.
  body_hash   TEXT,
  -- The QUEUE PROJECTION this row feeds ('blocked' | 'not_ready' | NULL). This is
  -- a derived-projection hint for the operator queue, NOT a status: it never makes
  -- a ticket read back as status 'blocked' on any surface, and it never makes a
  -- ticket queue-eligible.
  queue_projection TEXT,
  UNIQUE (project_key, ticket_id, source),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_blocker_evidence_ticket
  ON blocker_evidence(project_key, ticket_id);

-- FG-608 (FG-496 Slice C): the authoritative-cutover substrate. Every table and
-- column below is ADDITIVE — brand-new tables via CREATE TABLE IF NOT EXISTS, and
-- new columns on tickets / ticket_storage_mode applied by applyMigrations with
-- a PRAGMA table_info guard. SCHEMA_VERSION is NOT bumped and user_version is NOT
-- touched: the FG-568 additive-only open-path contract (BD-15) still holds, so an
-- older forge binary sharing ~/.forge/forge.db is never broken by these.
--
-- BLAST RADIUS, stated plainly: db.ts execs SCHEMA_SQL + applyMigrations on EVERY
-- writable open, so these tables/columns appear machine-wide for every project on
-- the next writable open — migrated or not. That is safe precisely because they are
-- additive and nothing reads them for a markdown-mode project.

-- The durable per-source registry (FG-608 default (b)). source_id is NOT a realpath:
-- imported_from is realpathSync(projectDir), and FG-345/FG-621 transient clones
-- under ~/.forge/worktrees/** are reaper-deleted, so a path-derived identity either
-- collides between two clones of one repo or evaporates when a clone is reaped.
-- The id is minted once per physical checkout and persisted inside that checkout's
-- git admin dir (never git-tracked, moves with the repo) — see resolveSourceIdentity
-- in src/store/backlog-import.ts. last_path is INFORMATIONAL ONLY (operator output);
-- nothing keys off it. forgotten_at is set by the operator forge backlog
-- forget-source verb for a permanently-removed source.
CREATE TABLE IF NOT EXISTS backlog_sources (
  project_key     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  last_path       TEXT,
  last_scanned_at TEXT,
  forgotten_at    TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (project_key, source_id)
);

-- Per-source MEMBERSHIP — the removal-reconciliation substrate. One row per
-- (source, thing the source's Markdown claims). Prune deletes a row from the
-- product tables only when NO live source claims it; absence of a source is never
-- evidence of absence of a ticket.
--
-- kind/member_key generalize over the three shapes that need provenance and had
-- none: tickets (member_key ''), ticket_relations (member_key
-- '<related_id><rel_type>') and blocker_evidence (member_key '<source>').
-- ticket_relations and blocker_evidence carry NO provenance columns of their own
-- (see their definitions above), which is exactly why the blocker_evidence inverse
-- deletion had nothing to reason with before this table existed.
CREATE TABLE IF NOT EXISTS ticket_source_membership (
  project_key TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  member_key  TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (project_key, source_id, kind, ticket_id, member_key)
);
CREATE INDEX IF NOT EXISTS idx_ticket_source_membership_lookup
  ON ticket_source_membership(project_key, kind, ticket_id, member_key);

-- The live per-project snapshot targets (FG-608 1d). One row per running container
-- that holds a read-only snapshot directory mount for this project_key. Fan-out
-- reads this: every host-side ticket write refreshes every live target.
CREATE TABLE IF NOT EXISTS backlog_snapshot_targets (
  project_key TEXT NOT NULL,
  target_dir  TEXT NOT NULL,
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (project_key, target_dir)
);

-- Operator-visible publication state. The snapshot is a DERIVED artifact: a failed
-- publication must never fail or roll back the authoritative host write, so the
-- failure has to be durable and queryable instead. state is 'ok' or 'stale'; a
-- stale row is surfaced in forge backlog output so an unpublished amendment is
-- never indistinguishable from an up-to-date container.
CREATE TABLE IF NOT EXISTS backlog_snapshot_publications (
  project_key  TEXT NOT NULL,
  target_dir   TEXT NOT NULL,
  state        TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_ok_at   TEXT,
  last_error   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_key, target_dir)
);

-- FG-608 F7 (recheck): the per-project PUBLICATION ORDINAL — the snapshot
-- publisher's ordering stamp. The project-wide max ticket revision CANNOT serve as
-- one: editing any ticket that is not the highest-revision ticket leaves it
-- unchanged, so two publishers built from CONSECUTIVE states carry EQUAL stamps and
-- the older build renames over the newer one and records 'ok'. This counter is
-- bumped in the same write transaction that dirties the project, so consecutive
-- states are strictly ordered no matter which ticket moved.
CREATE TABLE IF NOT EXISTS backlog_publication_ordinal (
  project_key TEXT PRIMARY KEY,
  ordinal     INTEGER NOT NULL
);

-- Dispatch-time ticket evidence. The dispatched revision/body hash and the LIVE
-- authority are two separate records and neither overwrites the other — when they
-- differ, forge backlog show surfaces BOTH rather than pretending the original
-- task package changed.
CREATE TABLE IF NOT EXISTS ticket_dispatch_evidence (
  task_id      TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  body_hash    TEXT NOT NULL,
  dispatched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_dispatch_evidence_ticket
  ON ticket_dispatch_evidence(project_key, ticket_id);

-- FG-638 (evidence-led review, Change 1): the durable review ledger. Two BRAND-NEW
-- tables on the additive-only open path — an old binary that predates them is never
-- broken and user_version is NOT bumped. The raw verdicts table above is untouched:
-- it stays the immutable provenance record, and a ledger finding points BACK at the
-- verdicts that produced it via sources_json rather than rewriting them.
--
-- The four SHAs are four different questions and none substitutes for another:
--   base_sha               — the implementation comparison base
--   contract_confirmed_sha — the frozen anchor discovery reviewed
--   candidate_sha          — the mutable current candidate, as remediation lands
--   trusted_remote_sha     — the fetched remote identity for final tip equality
CREATE TABLE IF NOT EXISTS reviews (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT,
  subject_task_id        TEXT,
  ticket_id              TEXT,
  base_sha               TEXT,
  contract_confirmed_sha TEXT,
  candidate_sha          TEXT,
  trusted_remote_sha     TEXT,
  contract_json          TEXT,
  lens_outcomes_json     TEXT,
  -- FG-649: WHICH checkout this review's stages act on. Recorded when the review is
  -- opened and re-recorded whenever an operator overrides it with --project, so
  -- "forge review continue" resolves its dispatch workspace from the review row rather
  -- than from the cwd of whatever process happens to run it. Since the coordinator now
  -- COMMITS the fix cycle, a wrong cwd is no longer a wrong read -- it is a write into
  -- the wrong repository. Nullable: a row written before FG-649 has none, and continue
  -- then adopts the run's project_dir (recording what it adopted) or refuses by name.
  -- There is deliberately no cwd fallback.
  workspace_dir          TEXT,
  -- FG-639: which lifecycle stages are COMPLETE, and at which sha each completed.
  -- The state column says where the review is; this says what it has already DONE, which
  -- is a different question and the one "forge review continue" has to answer after a
  -- crash: a stage recorded at the current candidate is never repeated merely because the
  -- process died, and a stage recorded at a SUPERSEDED sha is correctly not complete for
  -- the candidate that exists now.
  stage_evidence_json    TEXT,
  -- FG-689: the shard plan discovery is OWED, recorded BEFORE any lens container starts.
  -- A SEPARATE column from lens_outcomes_json on purpose: what is owed and what was
  -- delivered have two lifecycles and two writers, and neither is derivable from the
  -- other -- a lens whose every shard crashed delivers nothing, and nothing in the
  -- outcomes can then say how many shards were expected. It cannot ride
  -- stage_evidence_json either: the discovery stage record is written only AFTER
  -- completeness passes, i.e. it does not exist at the one moment the gate needs to read
  -- what was expected. Nullable: a review opened before FG-689 (or one whose discovery
  -- has not planned yet) reads back undefined.
  shard_plan_json        TEXT,
  -- Copied from the run at creation so a read surface never has to join to answer
  -- "which authority model settles this review".
  review_mode            TEXT NOT NULL DEFAULT 'evidence_led'
                           CHECK (review_mode IN ('legacy_verdict', 'legacy_review_loop', 'evidence_led')),
  state                  TEXT NOT NULL DEFAULT 'confirming_contract'
                           CHECK (state IN ('confirming_contract', 'discovering', 'awaiting_disposition',
                                            'fixing', 'documenting', 'verifying', 'rechecking',
                                            'shipping_review', 'settled', 'blocked_environment', 'failed')),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  settled_at             TEXT
);

-- One row per accepted observation. id is Forge-assigned and globally unique
-- (<review-id>/RF-n); finding_ref is the RF-n an operator types. A model-supplied
-- id is never honored — see ingestFindings in store/reviews.ts.
--
-- disposition and resolution are SEPARATE fields on purpose: disposition answers what
-- Forge decided to do, resolution answers whether an accepted fix is proven complete.
-- Collapsing them is how "we decided to fix it" silently reads as "it is fixed".
CREATE TABLE IF NOT EXISTS review_findings (
  id                       TEXT PRIMARY KEY,
  review_id                TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  ordinal                  INTEGER NOT NULL,
  finding_ref              TEXT NOT NULL,
  fingerprint              TEXT,
  summary                  TEXT NOT NULL DEFAULT '',
  severity                 TEXT,
  risk_lens                TEXT,
  finding_type             TEXT,
  evidence                 TEXT,
  hypothesis               TEXT,
  reachability             TEXT,
  file                     TEXT,
  line                     INTEGER,
  quoted_text              TEXT,
  acceptance_ref           TEXT,
  invariant_ref            TEXT,
  -- Every reviewer/verdict that produced this observation, as a JSON array. A
  -- deduplicated finding keeps them all; the count is provenance, never an
  -- "independent review count".
  sources_json             TEXT NOT NULL DEFAULT '[]',
  disposition              TEXT NOT NULL DEFAULT 'untriaged'
                             CHECK (disposition IN ('untriaged', 'fix_now', 'accepted_risk', 'deferred',
                                                    'rejected_premise', 'duplicate', 'architecture_question')),
  disposition_rationale    TEXT,
  disposition_evidence     TEXT,
  decided_by               TEXT,
  decided_at               TEXT,
  decided_candidate_sha    TEXT,
  duplicate_of             TEXT,
  followup_ticket_id       TEXT,
  resolution               TEXT,
  resolution_evidence_kind TEXT,
  resolution_evidence      TEXT,
  discovered_sha           TEXT,
  resolved_sha             TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (review_id, ordinal)
);
-- Only over NOT-NULL-without-default columns, deliberately: the FG-608 parity guard
-- strips every column ADD COLUMN could restore, and an index over a restorable column
-- would make it undroppable and shrink that guard's coverage.
CREATE INDEX IF NOT EXISTS idx_review_findings_review ON review_findings(review_id);

-- FG-639 (evidence-led review, Change 2 / PRD Appendix A): the durable FixBatch.
-- Two more brand-new tables on the additive-only open path; user_version untouched.
--
-- A batch is IMMUTABLE AT A REVISION. Nothing updates payload_json or payload_sha256
-- after insert — a changed disposition set or a changed candidate creates the NEXT
-- revision and supersedes this one, so a fixer that is already running stays bound to
-- the scope it was dispatched with. The state and dispatch_task_id columns are the only
-- mutable ones and neither is part of the payload the fixer sees.
--
-- payload_sha256 is what makes the delivery snapshot verifiable: forge materializes
-- the payload into the task input mount and re-hashes the FILE before container
-- start. SQLite stays authoritative; the files are a snapshot of it.
CREATE TABLE IF NOT EXISTS fix_batches (
  id                  TEXT PRIMARY KEY,
  review_id           TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  revision            INTEGER NOT NULL,
  candidate_sha       TEXT NOT NULL,
  supersedes_batch_id TEXT,
  payload_json        TEXT NOT NULL,
  payload_sha256      TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'dispatched', 'ingested', 'superseded')),
  dispatch_task_id    TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (review_id, revision)
);

-- One row per (batch, task, finding). The composite primary key IS the idempotence
-- key: delivery is at-least-once, so re-ingesting the same fixer result must not
-- apply it twice, and an INSERT that conflicts on this key is a no-op rather than a
-- second application. Agents never write here — the host ingests from the task's
-- output area.
CREATE TABLE IF NOT EXISTS fix_batch_results (
  batch_id           TEXT NOT NULL REFERENCES fix_batches(id) ON DELETE CASCADE,
  task_id            TEXT NOT NULL,
  finding_id         TEXT NOT NULL,
  result             TEXT NOT NULL
                       CHECK (result IN ('fixed', 'scope_change', 'not_fixed')),
  summary            TEXT,
  files_changed_json TEXT NOT NULL DEFAULT '[]',
  evidence           TEXT,
  interaction        TEXT,
  evidence_path      TEXT,
  evidence_sha256    TEXT,
  -- FG-710 Shape B: the candidate-bound executed-assertion identity the fixer named for a
  -- demonstrated 'fixed' finding, surfaced to the recheck so Stage 8 executes THIS assertion.
  -- Nullable; a scope_change / not_fixed result and a non-demonstrated finding carry NULL.
  executed_assertion TEXT,
  ingested_at        TEXT NOT NULL,
  PRIMARY KEY (batch_id, task_id, finding_id)
);

-- FG-710 Shape A/AC4: the DURABLE refused-delivery record. When a fixer's result.json is
-- refused BEFORE ingestion (a schema-invalid Shape-A result, or a Shape-B demonstrated 'fixed'
-- naming no executed assertion), the code remediation in the task workspace is COMPLETE but has
-- no adoption path — the coordinator owns the commit, so the orchestrator cannot land it by
-- hand. This row preserves the completed work: the raw result bytes, a re-appliable diff patch
-- (including untracked files), the porcelain status, and every refusal reason. A supported
-- repair-retry re-enters the SAME batch/revision (never a new revision) informed by this record
-- and emits a CORRECTED result.json for the same edits.
--
-- Keyed (batch_id, revision) — NOT a new FIX_BATCH_STATES value: the batch lifecycle is
-- unchanged, and this is a separate recovery ledger beside it. Brand-new table, so the
-- CREATE TABLE IF NOT EXISTS here IS the additive migration (no ADDITIVE_COLUMNS entry needed);
-- user_version is untouched (FG-568 forward-gate contract), so an older binary is never broken.
--
-- state: 'open' (a repair is owed) -> 'repairing' (a repair dispatch has claimed it, via a
-- compare-and-set so two concurrent 'forge review continue' cannot both dispatch) -> 'superseded'
-- (a corrected result ingested and the cycle committed). A repair that refuses again returns it
-- to 'open'. repair_attempts is the cap counter: at most 2 repairs, then the review PARKS.
CREATE TABLE IF NOT EXISTS fix_batch_refused_deliveries (
  batch_id                  TEXT NOT NULL REFERENCES fix_batches(id) ON DELETE CASCADE,
  revision                  INTEGER NOT NULL,
  raw_result_bytes          TEXT,
  diff_patch                TEXT,
  porcelain_status          TEXT,
  refusal_reasons_json      TEXT NOT NULL DEFAULT '[]',
  captured_at_candidate_sha TEXT NOT NULL,
  repair_attempts           INTEGER NOT NULL DEFAULT 0,
  state                     TEXT NOT NULL DEFAULT 'open'
                              CHECK (state IN ('open', 'repairing', 'superseded')),
  -- RF-1: the repair LEASE. Stamped (store clock) when a pass claims open -> repairing, so a
  -- concurrent review-continue pass can tell a LIVE repair from a crash-stranded one. A repairing
  -- record with a live lease is in flight and re-driving it would dispatch a second repair over the
  -- same batch/worktree; only a strictly-expired lease is re-driven. NULL on an aged row and on a
  -- record that has never been claimed -- read as "no live lease".
  lease_expires_at_ms       INTEGER,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  PRIMARY KEY (batch_id, revision)
);

-- FG-655: the docs stage's DURABLE DISPATCH BINDING. One more brand-new table on the
-- additive-only open path; user_version untouched.
--
-- Stage 6 authors a git commit — an irreversible external write — and the ledger writes
-- that record it (candidate advance, stage record) are separate SQLite transactions after
-- it. The only thing that makes a crash in that window recoverable is being able to say,
-- from durable state alone, "a docs agent was ALREADY dispatched for this review". Without
-- that fact the re-entry runs a second documentation-maintainer over its own committed
-- output. state and dispatch_task_id are the two columns that matter for re-entry, exactly
-- as they are for fix_batches above.
--
-- dispatch_run_id rides beside dispatch_task_id because the delivery is located by BOTH: a
-- review may hold no run id at dispatch time, and a task id alone cannot find the task dir.
--
-- The row is created BEFORE the dispatch and marked delivered from invoke's mint-time hook,
-- so no container write can precede the binding. It is retired only when the stage
-- COMPLETES, or when a clean tree at the candidate proves a dead delivery left nothing
-- behind. A refusal retires nothing.
CREATE TABLE IF NOT EXISTS review_docs_dispatches (
  id               TEXT PRIMARY KEY,
  review_id        TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  candidate_sha    TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open', 'dispatched', 'retired')),
  dispatch_task_id TEXT,
  dispatch_run_id  TEXT,
  created_at       TEXT NOT NULL,
  retired_at       TEXT,
  retired_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_docs_dispatches_review ON review_docs_dispatches(review_id);
-- FG-655 RF-4: AT MOST ONE LIVE BINDING PER REVIEW, enforced by the store rather than by
-- call-site ordering. openDocsDispatch reads for a live binding and then inserts, and two
-- concurrent "forge review continue" processes can both read nothing and both insert — each
-- then dispatching a documentation-maintainer into the same checkout. Partial over the LIVE
-- state (retired rows are history and there are many of them per review), matching
-- idx_continuations_dispatch_key's precedent. Additive-only open path: the table is FG-655's
-- own, so no aged database carries rows this could reject, and user_version is untouched.
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_docs_dispatches_live
  ON review_docs_dispatches(review_id) WHERE state != 'retired';

-- FG-609 (FG-496 Slice D): the durable OPERATOR QUEUE primitives. Three brand-new
-- tables arriving whole via CREATE TABLE IF NOT EXISTS on the ordinary open path —
-- the same additive-only BD-15 contract as every table above. user_version is NOT
-- bumped, so an older forge binary sharing ~/.forge/forge.db is never broken.
--
-- THE MODEL, in three orthogonal facts about a ticket:
--   tickets.priority_rank  — WHERE it sits in the operator's stack rank (above)
--   queue_membership       — WHETHER the operator selected it for execution
--   lifecycle status       — active/done/deferred, unchanged and untouched here
-- The EXECUTABLE QUEUE is the intersection: queued AND active AND ranked, ordered
-- by rank ASC then ticket_id ASC. in_progress and blocked are COMPUTED from
-- other tables on every read and are NEVER stored — they are not a second mutable
-- status vocabulary alongside the lifecycle one.

-- Explicit queue membership. An operator-selected SUBSET, orthogonal to both rank
-- and lifecycle: dequeuing does not unrank, and a lifecycle change never clears
-- membership (so a deferred-then-reactivated ticket returns to the same position).
CREATE TABLE IF NOT EXISTS queue_membership (
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  enqueued_by TEXT,
  note        TEXT,
  PRIMARY KEY (project_key, ticket_id),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);
-- THE queue-ordering index, and the only one this slice adds. It is here rather
-- than on tickets(priority_rank) on purpose: this table is born whole from the
-- CREATE above and never travels the ALTER path, so indexing it cannot pin any
-- ALTER-restorable column undroppable.
CREATE INDEX IF NOT EXISTS idx_queue_membership_project
  ON queue_membership(project_key, ticket_id);

-- Revision-bound readiness. The outcome of the EXISTING evaluateReadiness
-- (src/readiness/readiness.ts, FG-382) — no new readiness vocabulary — bound to
-- the ticket's body_hash at evaluation time. Editing a ticket changes that hash,
-- so the stored row goes STALE by comparison and every read surface says so.
--
-- This row is a CACHE PLUS AN AUDIT RECORD and is NEVER the authority for an
-- enqueue decision: enqueue re-evaluates the CURRENT revision and stores that
-- outcome, so a refusal reason can never be quoted from stale content and a stale
-- assessment is never a dead end. One row per ticket; the transition HISTORY lives
-- in queue_events.
CREATE TABLE IF NOT EXISTS readiness_assessments (
  project_key         TEXT NOT NULL,
  ticket_id           TEXT NOT NULL,
  body_hash           TEXT NOT NULL,
  outcome             TEXT NOT NULL,
  gaps_json           TEXT NOT NULL DEFAULT '[]',
  refinement_proposal TEXT,
  revision            INTEGER,
  evaluated_at        TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);

-- Append-only queue history: enqueue, dequeue, rank, unrank, reorder and readiness
-- transitions each append exactly one row, INSIDE the same write transaction as
-- the state change they record, so order and history cannot diverge.
--
-- DELIBERATELY NOT ticket_events. That table is import-reconstructable,
-- UPSERT-idempotent by a deterministic event key, and subject to
-- rebuildTicketEventsIfDivergent; queue events are host-OPERATOR facts with no
-- Markdown provenance, and collapsing two identical operator actions into one row
-- by event key would destroy exactly the history this table exists to keep.
--
-- NO FOREIGN KEY to tickets, deliberately: the audit record must survive its
-- subject through FG-608 removal reconciliation ("a done ticket leaves the active
-- queue while its queue history remains auditable"). The precedent is
-- ticket_source_membership / ticket_dispatch_evidence. Membership and readiness
-- assessments above are live state about a live ticket and DO cascade.
CREATE TABLE IF NOT EXISTS queue_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_events_ticket
  ON queue_events(project_key, ticket_id);
CREATE INDEX IF NOT EXISTS idx_queue_events_project
  ON queue_events(project_key, id);

-- FG-610 (FG-496 Slice E): the durable CLAIM / LEASE / RECOVERY ledger. ONE more
-- brand-new table arriving whole via CREATE TABLE IF NOT EXISTS on the ordinary
-- open path — the same additive-only BD-15 contract as every table above.
-- user_version is NOT bumped, so an older forge binary sharing ~/.forge/forge.db
-- opens this store and is never broken by the table's existence.
--
-- WHAT A ROW IS. A claim is a durable SCHEDULING RESERVATION over a queue entry:
-- "this owner intends to execute this ticket, and holds the right to until its
-- lease lapses". It is NOT execution evidence and NOT a ticket lifecycle status.
-- blocked and in_progress remain COMPUTED (see queue.ts) and are still never
-- stored; a release outcome describes the RESERVATION, never the work.
--
-- NO CHECK ON outcome, deliberately. FG-591 (the dispatcher) owns the release
-- vocabulary, and SQLite cannot WIDEN a CHECK on an additive-only path — the
-- constraint would have to be rebuilt, which this contract forbids. runs.status and
-- campaign_controller_leases.owner are the precedent for free TEXT here.
-- fix_batches.state is NOT the precedent: its vocabulary shipped complete in its own
-- ticket. state DOES carry no CHECK for the same reason plus one more — it is
-- named by the partial index below, and an aged binary must never fight it.
--
-- NO FOREIGN KEY to tickets or queue_membership, deliberately — queue_events'
-- precedent. An operator dequeue, an unrank, or FG-608 removal reconciliation must
-- never CASCADE-delete the recovery record for a container that is still executing.
-- Losing that row is how a takeover finds an empty slot and launches a duplicate.
--
-- THE LEASE. lease_expires_at_ms / heartbeat_at_ms are epoch ms on the STORE's own
-- clock (storeNowMs, publications.ts), never a process clock — two forge processes
-- with skewed clocks must not disagree about expiry. generation is the fencing
-- token: a takeover inserts a SUCCESSOR row with generation+1 and RETIRES its
-- predecessor (state='released'), so a stale owner can never heartbeat, stamp a
-- launch, or release after being taken over, and the takeover history survives.
--
-- launch_id / run_id are the born-under launch linkage, stamped BEFORE the physical
-- launch (campaign_item_launches' precedent) so recovery discovers a prior launch
-- DIRECTLY rather than by parsing names, argv or timestamps.
CREATE TABLE IF NOT EXISTS queue_claims (
  id                  TEXT PRIMARY KEY,
  project_key         TEXT NOT NULL,
  ticket_id           TEXT NOT NULL,
  owner               TEXT NOT NULL,
  generation          INTEGER NOT NULL,
  ticket_revision     INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  heartbeat_at_ms     INTEGER NOT NULL,
  launch_id           TEXT,
  run_id              TEXT,
  state               TEXT NOT NULL,
  outcome             TEXT,
  scan_evidence       TEXT,
  claimed_at          TEXT NOT NULL,
  released_at         TEXT
);
-- AT MOST ONE LIVE CLAIM PER TICKET, enforced by the STORE rather than by call-site
-- ordering. Two processes that both read "no live claim" and both insert cannot both
-- win: the second INSERT is rejected by this index even if a code path ever forgets
-- its transaction. idx_review_docs_dispatches_live is the precedent. Partial over the
-- LIVE state because released rows are history and there are many per ticket.
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_claims_live
  ON queue_claims(project_key, ticket_id) WHERE state = 'live';
-- The capacity count's index. BOTH indexes are on this BRAND-NEW table only: it is
-- born whole from the CREATE above and never travels the ALTER path, so indexing it
-- cannot pin an ALTER-restorable column undroppable and the FG-608 parity guard's
-- UNDROPPABLE set does not grow. Every column named here (project_key, ticket_id,
-- state) is NOT NULL with NO DEFAULT, so ADD COLUMN could not restore it anyway.
CREATE INDEX IF NOT EXISTS idx_queue_claims_scope
  ON queue_claims(project_key, state);

-- FG-679 (BD-12): the durable record of what was OBSERVED about a forge launch,
-- so a read-only reader (the dashboard, forge status) can answer "is host
-- verification running?" WITHOUT probing tmux. Before this table a launch's status
-- was derived at read time from a LIVE tmux probe (readLaunch/listLaunches), which
-- no serving path may do.
--
-- Brand-new table via CREATE TABLE IF NOT EXISTS on the ordinary open path — the
-- additive-only contract (FG-568/BD-15): an older binary that knows nothing of it
-- reads and ignores it. No CHECK and no UNIQUE beyond the primary key, so an
-- old/new binary never fights a constraint the other does not share.
--
-- EXACTLY ONE MUTABLE ROW PER LAUNCH. Current-state-per-launch is bounded by the
-- number of launches; append-only per-interval rows would instead grow without
-- bound and tax the FG-487 event surfaces that already scan events.
--
-- state is the canonical LaunchStatus.state STRUCTURED value
-- ('running'|'exited_ok'|'exited_error'|'signaled'|'terminated_unattributed'|
-- 'owner_gone'|'unknown') — NEVER a pre-rendered string and never a collapsed
-- label. src/v2/launch.ts's statusLine stays the ONE human rendering (BD-4), so
-- the four distinct facts it prints stay four facts on every surface.
--
-- association_kind is WHICH CHANNEL DECIDED the project home, recorded in the data
-- rather than re-derived by each reader (BD-2/BD-3/BD-14/FG-684):
--   'explicit' — submission-time structured metadata resolved it.
--   'cwd'      — the launch's cwd resolved to a registered project home. Also what
--                an explicitly associated launch reads when its declared run
--                resolved no project and the cwd supplied one.
--   'none'     — no registered project home; host-level "Unassociated activity".
-- RUN-level placement and the unassociated label follow the DECLARED run/task/
-- ticket ids on the row, not this label.
-- Ownership is NEVER inferred from the launch name, argv, or log text (FG-492).
--
-- observed_at is what makes freshness a FACT rather than an inference: a row
-- older than the reader's cutoff renders unobserved since <t>, never running
-- and never terminal.
--
-- purpose is WHAT THE LAUNCH IS, declared at submission and recorded here
-- (FG-700). It is a SEPARATE field from the association ids with SEPARATE
-- semantics: association answers WHERE a launch belongs (run / project / host
-- placement), purpose answers WHAT it is. Neither decides the other. Enum-as-
-- convention (FG-585), no CHECK: 'host_verification' | 'agent_invoke' |
-- 'review' | 'campaign' | 'dashboard' | 'generic'. NULL (every row written
-- before this column existed) and any value this binary does not recognize read
-- as 'generic' — the weakest claim, never a more specific one. Before FG-700 the
-- readers treated the mere PRESENCE of run_id/task_id/ticket_id as proof that a
-- launch was host verification, so every associated agent, review and campaign
-- launch rendered under the Host verification label.
CREATE TABLE IF NOT EXISTS launch_observations (
  launch_id        TEXT PRIMARY KEY,
  name             TEXT,
  command          TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  project_dir      TEXT,
  association_kind TEXT NOT NULL,
  run_id           TEXT,
  task_id          TEXT,
  ticket_id        TEXT,
  campaign_id      TEXT,
  item_id          TEXT,
  started_at       TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  state            TEXT NOT NULL,
  exit_code        INTEGER,
  signal           TEXT,
  purpose          TEXT,
  -- FG-693: PROVEN canonical identity of project_dir, or NULL. cwd is deliberately
  -- NOT given one: it is the launch's working directory as recorded, not a project
  -- key, and nothing decides project ownership from it — association_kind already
  -- records which channel decided the project home. See SCHEMA_SQL's header.
  project_dir_canonical TEXT,
  terminal         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_observations_run
  ON launch_observations(run_id);
CREATE INDEX IF NOT EXISTS idx_launch_observations_project
  ON launch_observations(project_dir);
CREATE INDEX IF NOT EXISTS idx_launch_observations_observed
  ON launch_observations(observed_at);

-- FG-731: ci_waits — the durable record of a Forge-owned CI WAIT. The FOURTH,
-- DISTINCT CI surface, and deliberately not any of the other three:
--   * NOT launch_observations — a launch's terminal authority is a LOCAL tmux owner
--     (owner_gone is terminal). A CI run is REMOTE on GitHub, so an owner/waiter dying
--     never makes the run terminal — only RE-OBSERVATION does. The opposite rule.
--   * NOT the review-loop's candidate-sha-bound ci_observed event stream — this wait is
--     not bound to a tracked candidate sha (the FG-704 workflow_dispatch case is a run
--     bound to no candidate at all).
--   * NOT requiredCi — that stays exactly as-is; this surface rides ALONGSIDE it.
--
-- Brand-new table via CREATE TABLE IF NOT EXISTS on the ordinary open path — the same
-- additive-only BD-15 contract as continuations / queue_claims / launch_observations
-- above. SCHEMA_SQL is exec'd on EVERY writable open, so this CREATE is itself the
-- additive migration that brings an aged ~/.forge/forge.db forward; a whole new table
-- needs no ADDITIVE_COLUMNS entry (that list exists only for new COLUMNS on tables that
-- CREATE TABLE IF NOT EXISTS would no-op over). No CHECK and no UNIQUE beyond the
-- primary key (enum-as-convention, FG-585), so an old/new binary never fights a
-- constraint the other lacks. user_version is NOT bumped.
--
-- TWO INDEPENDENT STATE AXES, and they must not be conflated:
--   lifecycle_state — the STATE-MACHINE position that decides liveness:
--       registered -> running -> completed_awaiting_advance -> {advanced|cancelled|abandoned}
--     'terminal' is DERIVED from it (advanced/cancelled/abandoned are terminal; a
--     'completed_awaiting_advance' is a REAL non-terminal state — a forge advance is owed,
--     it is not a leak). TERMINAL AUTHORITY IS REMOTE: nothing here terminalizes on lease
--     expiry — a dead waiter leaves a live wait, because the CI run is still real on GitHub.
--   observed_state — the LAST-OBSERVED aggregate CI state, one of
--       running (+ observed_m/observed_n), no_runs, unavailable (+ observed_reason), completed.
--     'no_runs' ("no CI is running") and 'unavailable' ("CI state could not be determined")
--     are DISTINCT and neither may collapse into the other or into a fake success/idle.
--     NULL until the first observation — a register-before-poll row has looked at nothing.
--
-- observed_at is the last time a WRITER looked. It governs the LABEL a later step renders
-- (fresh -> "running m/n"; stale -> "unavailable"), NEVER whether the wait exists: liveness
-- is 'terminal = 0', independent of freshness.
--
-- REMOTE IDENTITY is whatever lets ANY forge process re-query gh without the original
-- waiter: repo + actions_run_id (push/dispatch), or pr_number + head_sha + check_suite_ref
-- (pr_checks). For workflow_dispatch the run id is unknown at trigger time, so the dispatch
-- REQUEST is stored (workflow_file + dispatch_ref + dispatch_inputs) and actions_run_id/url
-- are filled on first observation.
--
-- ASSOCIATION (run_id / ticket_id / project_dir + its PROVEN canonical form) is modeled on
-- launch association (FG-679/FG-700) so the Step-2b derivation can place and scope the row
-- with the SAME inProjectScope/resolveProjectScope machinery. It is a DIFFERENT axis from
-- the remote identity: a forge run id is not the Actions run id (actions_run_id).
-- Ownership is never inferred from a name, argv, or log text (FG-492).
CREATE TABLE IF NOT EXISTS ci_waits (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  -- remote identity
  repo                  TEXT,
  actions_run_id        TEXT,
  pr_number             INTEGER,
  head_sha              TEXT,
  check_suite_ref       TEXT,
  workflow_file         TEXT,
  dispatch_ref          TEXT,
  dispatch_inputs       TEXT,
  url                   TEXT,
  started_at            TEXT NOT NULL,
  -- state machine
  lifecycle_state       TEXT NOT NULL,
  terminal              INTEGER NOT NULL,
  terminal_disposition  TEXT,
  -- last-observed aggregate CI state
  observed_state        TEXT,
  observed_reason       TEXT,
  observed_m            INTEGER,
  observed_n            INTEGER,
  observed_at           TEXT,
  -- owner/waiter identity + renewable epoch-ms lease (observability + adopt-on-recovery
  -- ONLY; NEVER terminal authority)
  owner                 TEXT,
  lease_expires_at_ms   INTEGER,
  -- association (FG-679/FG-700 shape)
  run_id                TEXT,
  ticket_id             TEXT,
  project_dir           TEXT,
  project_dir_canonical TEXT
);
CREATE INDEX IF NOT EXISTS idx_ci_waits_run ON ci_waits(run_id);
CREATE INDEX IF NOT EXISTS idx_ci_waits_project ON ci_waits(project_dir);
CREATE INDEX IF NOT EXISTS idx_ci_waits_live ON ci_waits(terminal);

-- FG-745: workspace_purposes — WHAT a Forge-owned on-disk workspace IS, so the
-- Projects tab can represent operator projects while a disposable clone, per-task
-- worktree, or deliberately-retained evidence fixture stays on disk without becoming
-- a peer top-level project. A brand-new table via CREATE TABLE IF NOT EXISTS on the
-- ordinary open path — the same additive-only BD-15 contract as launch_observations /
-- ci_waits above: SCHEMA_SQL is exec'd on EVERY writable open, so this CREATE is
-- itself the additive migration that brings an aged ~/.forge/forge.db forward, and a
-- whole new table needs no ADDITIVE_COLUMNS entry. user_version is NOT bumped.
--
-- path is the PROVEN canonical identity (FG-693 provenPhysical / realpath) of the
-- workspace directory — the ONE name for that tree — resolved BEFORE the write
-- transaction opens. path_as_written keeps the caller's spelling verbatim (audit
-- only, decides nothing). kind is the CLOSED workspace vocabulary
-- (operator | disposable_clone | worktree | evidence_fixture | unclassified),
-- enum-as-convention (FG-585) with NO CHECK so an old/new binary never fights a
-- constraint the other lacks; an absent table, a NULL, or an unknown value all decode
-- to 'unclassified' — the VISIBLE fail-safe, inverted from launch_observations'
-- fail-closed 'generic'. project_identity/run_id/task_id are the FG-663 owner declared
-- at creation (or supplied at operator repair); reason carries an FG-677 retention
-- outcome (active_process_cwd, ownership_ambiguous, …). Artifact status is a RECORDED
-- FACT — never inferred from a path prefix, basename, ticket-shaped name, run count,
-- missing remote, or age.
-- No secondary index: reads are by path (the primary key) — a single-row lookup or a
-- bounded path-IN-list join for the projection. An index on project_identity would pin
-- that column undroppable and force an edit to the fg608-migration-parity UNDROPPABLE
-- set for no query that needs it.
CREATE TABLE IF NOT EXISTS workspace_purposes (
  path             TEXT PRIMARY KEY,
  path_as_written  TEXT NOT NULL,
  kind             TEXT NOT NULL,
  project_identity TEXT,
  run_id           TEXT,
  task_id          TEXT,
  reason           TEXT,
  source           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- FG-745 (review RF-2): the APPEND-ONLY audit log of operator classify/repair
-- decisions on a workspace purpose. The purpose row above holds only the CURRENT
-- value: classifyWorkspacePurpose UPDATEs kind/source in place, so a reclassification
-- that changes a top-level project's VISIBILITY (unclassified/operator -> an artifact
-- kind, or the reverse) left no durable record of what it changed or when. The
-- unauthenticated operator surface makes that gap a security concern — AC8 requires the
-- repair to be auditable and reversible, which the current value alone is not.
--
-- Each row is ONE classify decision: prior_kind (what the purpose read BEFORE — an
-- absent row reads 'unclassified', the visible fail-safe, so a fresh classify records
-- that) -> new_kind, with the source, the acting operator when one is supplied (the
-- surface is unauthenticated, so actor is NULL when no identity is available, never
-- fabricated), and the timestamp. Written inside the SAME writeTransaction as the
-- purpose upsert, so the audit row and the value it explains are one atomic unit (AC8).
--
-- A brand-new table via CREATE TABLE IF NOT EXISTS on the ordinary open path — the same
-- additive-only BD-15 contract as workspace_purposes above; user_version is NOT bumped.
-- Keyed on path only for reads (WHERE path = ? ORDER BY at); the append is a bare INSERT
-- so no index pins a column undroppable.
CREATE TABLE IF NOT EXISTS workspace_purpose_events (
  id               INTEGER PRIMARY KEY,
  path             TEXT NOT NULL,
  prior_kind       TEXT NOT NULL,
  new_kind         TEXT NOT NULL,
  source           TEXT NOT NULL,
  actor            TEXT,
  at               TEXT NOT NULL
);

-- FG-591 (the operator work queue and its dispatcher): FOUR brand-new tables, all
-- arriving whole via CREATE TABLE IF NOT EXISTS on the ordinary open path — the same
-- additive-only BD-15 contract as every table above. user_version is NOT bumped, so
-- an older forge binary sharing ~/.forge/forge.db opens this store unharmed.
--
-- NO CHECK on any vocabulary these tables own (enum-as-convention, FG-585). FG-591's
-- release/reason/wake vocabularies are still being widened by the ticket that owns
-- them, and SQLite cannot WIDEN a CHECK on an additive-only path.
--
-- NO FOREIGN KEY to tickets or queue_membership, deliberately — queue_claims' stated
-- precedent. An operator dequeue, an unrank, or FG-608 removal reconciliation must
-- never CASCADE away a wake or an evaluation belonging to a container that may still
-- be executing. Losing that evidence is how "nothing started and nothing said why"
-- happens, which is the failure FG-591 exists to close.

-- THE POLICY, and the only host-wide setting store forge has. ~/.forge holds files,
-- not settings rows, and the dispatcher, the CLI and the dashboard are three
-- processes that must agree on ONE ceiling — enforced against a count that already
-- lives in this DB. So the policy lives here.
--
-- ONE TABLE, TWO ROW SHAPES, discriminated by scope_key:
--   scope_key = 'host'  — THE singleton: armed, max_active_runs, capacity_scope,
--                         lease_ttl_ms, heartbeat_ms. The ceiling VALUE is host-wide
--                         because two dispatchers holding different values while
--                         enforcing against one shared count means the effective
--                         ceiling is whichever ran last — an incoherence with no owner.
--   scope_key = <project_key> — an optional per-project row carrying only
--                         default_workflow. A project row NEVER carries a ceiling.
-- Every setting column is NULLABLE and NULL means "not set at this scope". The armed
-- column reads FAIL-CLOSED: a NULL/absent policy is DISARMED, so a store that has
-- never seen an operator arm it never dispatches.
--
-- Policy is a FACT CONSULTED BEFORE CLAIMING (D5) — never process lifecycle. Nothing
-- here is a reaper: disarming and lowering max_active_runs are admission tests, and a
-- row in this table has never terminated a container.
CREATE TABLE IF NOT EXISTS dispatcher_policy (
  scope_key        TEXT PRIMARY KEY,
  armed            INTEGER,
  max_active_runs  INTEGER,
  capacity_scope   TEXT,
  lease_ttl_ms     INTEGER,
  heartbeat_ms     INTEGER,
  default_workflow TEXT,
  updated_at       TEXT NOT NULL,
  updated_by       TEXT
);

-- THE DISPATCHER'S DURABLE IDENTITY AND FENCED LEASE. campaign_controller_leases'
-- shape, deliberately mirrored rather than a third lease invented: an instance-stable
-- owner, a generation bumped on every takeover as the fencing token, and a renewable
-- expiry. Keyed per project — the ceiling is host-wide but the scan domain, the queue
-- and the dispatcher identity are per-project.
--
-- lease_expires_at_ms / heartbeat_at_ms are epoch ms on the STORE's own clock
-- (storeNowMs, publications.ts), never a process clock — two forge processes with
-- skewed clocks must not disagree about expiry. A takeover is permitted ONLY when the
-- lease is STRICTLY in the past; waiting is not evidence of abandonment.
--
-- heartbeat_at_ms is kept beside the expiry because they answer different questions:
-- the expiry says whether a takeover is permitted, the heartbeat says when the owner
-- was last actually alive. "Nothing is running" and "the dispatcher died four hours
-- ago" must be distinguishable on the operator surface, and only the second column
-- can say so.
--
-- host / pid are OPERATOR OUTPUT ONLY — the "who holds this" answer. Nothing keys off
-- them and no liveness decision consults them: physical liveness belongs to the
-- tmux-owned ownership transfer, never to a recorded pid.
--
-- NO FOREIGN KEY to project_identity: a dispatcher lease must outlive a registry edit,
-- and losing the lease row while a dispatcher still runs is how a second one starts.
CREATE TABLE IF NOT EXISTS dispatcher_leases (
  project_key         TEXT PRIMARY KEY,
  owner               TEXT NOT NULL,
  generation          INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  heartbeat_at_ms     INTEGER NOT NULL,
  host                TEXT,
  pid                 INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- DURABLE WAKES. The dispatcher re-evaluates on queue changes, run terminal
-- transitions, blocker/readiness changes, capacity changes and recovery events.
-- A wake is a DURABLE AT-LEAST-ONCE RECORD rather than an in-process signal, so a
-- restart cannot lose one; polling stays a fallback and never the only correctness
-- mechanism.
--
-- IDEMPOTENT BY CONSTRUCTION. (project_key, kind, wake_key) is the caller's
-- idempotency key and the partial UNIQUE index below collapses a duplicate poke onto
-- the one PENDING record — so a signal delivered twice is harmless without the caller
-- having to dedupe. The index is PARTIAL over 'pending' on purpose: once a wake is
-- consumed the NEXT change to the same subject deserves its own record, and consumed
-- rows are history.
--
-- state is the COMPARE-AND-SET consume column (continuations.ts's shape): a consumer
-- writes state='consumed' WHERE id = ? AND state = 'pending', and exactly one of two
-- concurrent consumers sees changes = 1. Free TEXT with no CHECK, and named by the
-- partial index — an aged binary must never fight either.
CREATE TABLE IF NOT EXISTS dispatcher_wakes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  wake_key       TEXT NOT NULL,
  detail         TEXT,
  state          TEXT NOT NULL,
  consumed_by    TEXT,
  consumed_at_ms INTEGER,
  created_at     TEXT NOT NULL
);
-- AT MOST ONE PENDING WAKE PER (project, kind, key), enforced by the STORE rather
-- than by call-site ordering — idx_queue_claims_live's precedent. Two processes that
-- both observe the same run transition cannot leave two pending records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatcher_wakes_pending
  ON dispatcher_wakes(project_key, kind, wake_key) WHERE state = 'pending';
-- The consume scan's index. Every column named here (project_key, state, id) is a
-- primary key or NOT NULL with NO DEFAULT, so ADD COLUMN could not restore it anyway
-- and indexing it cannot grow the FG-608 parity guard's UNDROPPABLE set.
CREATE INDEX IF NOT EXISTS idx_dispatcher_wakes_scan
  ON dispatcher_wakes(project_key, state, id);

-- THE DURABLE ANSWER TO "WHY DID NOTHING START". One row per evaluation PASS,
-- INCLUDING the passes that granted nothing — that is the whole point. An idle queue
-- that leaves no record of why is the operator blindness this ticket is about, and
-- queue_claims cannot carry it: a claim row exists only on a GRANT, and its
-- scan_evidence with it.
--
-- reason is the TOP-LEVEL outcome from a closed vocabulary owned by FG-591 —
-- granted | disabled | no_capacity | no_eligible_work | lost | incompatible_only —
-- carried as free TEXT with NO CHECK for the FG-585 reason above.
--
-- scan_evidence is the per-candidate ScanEntry[] as claimNextEligible returns it,
-- serialized as JSON. NOT a second vocabulary: queue-claims' ScanReason is the only
-- one, so "passed over because blocked" and "passed over because temporarily
-- incompatible with the active set" stay the distinct facts that table already makes
-- them.
--
-- A TEMPORARY SCHEDULING INCOMPATIBILITY LIVES HERE AND NOWHERE ELSE. It is
-- per-evaluation and evaporates when the active set changes. It must never be written
-- to blocker_evidence, which is durable, per-ticket, partly container-visible, and
-- drives the Blocked projection through isQueueBlocked — a scheduling wait written
-- there would silently reinterpret the ticket's status for every agent container.
--
-- capacity_* records the ceiling as it was ENFORCED, not as it is re-derived at read
-- time. capacity_holders is the JSON holder list (projectKey/ticketId/owner/runId)
-- that lets a per-project board explain a HOST-scoped refusal by naming the other
-- project holding the slots — without it, a host-scope refusal is unreadable from any
-- single board.
--
-- next_watchdog_at_ms is the pass's own re-arm deadline, recorded rather than
-- recomputed, so "when will this be looked at again" is a durable fact on the
-- operator surface. It is a HEALTH bound and never an estimate of ticket duration.
CREATE TABLE IF NOT EXISTS dispatcher_evaluations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key           TEXT NOT NULL,
  dispatcher_owner      TEXT NOT NULL,
  dispatcher_generation INTEGER,
  reason                TEXT NOT NULL,
  detail                TEXT,
  claimed_ticket_id     TEXT,
  claim_id              TEXT,
  capacity_scope        TEXT,
  capacity_limit        INTEGER,
  capacity_used         INTEGER,
  capacity_holders      TEXT,
  scan_evidence         TEXT,
  wake_kind             TEXT,
  next_watchdog_at_ms   INTEGER,
  evaluated_at_ms       INTEGER NOT NULL,
  evaluated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatcher_evaluations_project
  ON dispatcher_evaluations(project_key, id);

-- FG-576 (D7/D11/D15): THE LAUNCHER-OWNED ORCHESTRATOR LAUNCH RECEIPT. One row per
-- interactive orchestrator session "forge orchestrator" / "forge claude" launches,
-- carrying the WHOLE pre-spawn decision (AC6) and the explanation of it (AC11).
--
-- Brand-new table arriving whole via CREATE TABLE IF NOT EXISTS on the ordinary open
-- path — the same additive-only BD-15 contract as every table above. user_version is
-- NOT bumped, so an older forge binary sharing ~/.forge/forge.db opens this store
-- unharmed and simply never reads the table.
--
-- NO CHECK on any vocabulary this table owns (enum-as-convention, FG-585): the
-- provider/runtime/adapter/state/strength vocabularies grow as adapters are added, and
-- SQLite cannot WIDEN a CHECK on an additive-only path. Legality is enforced by the
-- accessors in src/store/orchestrator-receipts.ts, which refuse by name.
--
-- NO FOREIGN KEY to tasks or runs, deliberately — queue_claims' and dispatcher_*'s
-- stated precedent. A receipt is the evidence that an interactive session was launched;
-- a CASCADE that deleted it because some other row went away is how "a live session
-- with no receipt" happens, which is the failure this table exists to close.
--
-- state IS THE LIFECYCLE, EXPLICITLY (D15) — never inferred, and never inferred from
-- the ABSENCE of a provider hook:
--   'pending'      persisted BEFORE spawn. NOT live and never rendered as live.
--   'running'      only after a CONFIRMED spawn. A CLAIM the launcher was alive when
--                  it wrote it — never proof of present liveness. A surface reports
--                  running only after joining the launcher-owned liveness record.
--   'exited'       terminal: the child exited (exit_code / exit_signal carry which).
--   'spawn_failed' terminal: the child never started.
--   'orphaned'     the LAUNCHER was lost. Per D17 this asserts launcher loss ONLY and
--                  says NOTHING about the child's disposition; it must never be
--                  rendered as "session exited" or "child stopped".
--
-- provider / runtime / adapter are FIRST-CLASS COLUMNS, never derived at read time and
-- never defaulted. A Codex receipt read by a reader that knows only the generic columns
-- must still report provider='openai' — a default of any kind would let one provider's
-- session be read as another's.
--
-- identity_strength is the HONEST PARITY GAP (AC9): 'asserted' (Forge minted the id and
-- passed it to the provider — Claude), 'correlated' (matched after spawn from recorded
-- evidence — Codex), 'ambiguous' (two candidates in the correlation window; a guess was
-- REFUSED), 'unknown'. identity_basis records what the correlation was based on. It
-- defaults to the WEAKEST value so a row this binary cannot interpret never reads as
-- asserted.
--
-- carrier_* is instruction provenance (AC8): which seed generation supplied the
-- Forge-owned instruction carrier, where it was bound from, and whether the provider
-- gave POSITIVE EVIDENCE it accepted it. It defaults to 'unproven' — constructing a
-- flag is not evidence it was honored, so the fail-closed value is the default and
-- 'accepted' must always be written deliberately.
--
-- limitations is the JSON [{capability, note}] list of what the selected provider
-- CANNOT supply (AC12: "no equivalent usage evidence" is a RECORDED VALUE here, never a
-- fabricated number somewhere else).
--
-- Every indexed column is a primary key or NOT NULL with NO DEFAULT, so ADD COLUMN
-- could not restore it anyway and indexing it cannot grow the FG-608 parity guard's
-- UNDROPPABLE set.
CREATE TABLE IF NOT EXISTS orchestrator_receipts (
  receipt_id          TEXT PRIMARY KEY,
  session_key         TEXT NOT NULL,
  state               TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  project_dir         TEXT NOT NULL,
  project_name        TEXT,
  resolved_profile    TEXT,
  runtime             TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT,
  auth_mode           TEXT,
  resolved_by         TEXT,
  adapter             TEXT NOT NULL,
  session_operation   TEXT NOT NULL,
  session_target      TEXT,
  provider_session_id TEXT,
  identity_strength   TEXT NOT NULL DEFAULT 'unknown',
  identity_basis      TEXT,
  carrier_generation  TEXT,
  carrier_path        TEXT,
  carrier_acceptance  TEXT NOT NULL DEFAULT 'unproven',
  carrier_evidence    TEXT,
  limitations         TEXT,
  task_id             TEXT,
  launcher_pid        INTEGER,
  launcher_identity   TEXT,
  started_at          TEXT,
  closed_at           TEXT,
  exit_code           INTEGER,
  exit_signal         TEXT,
  failure_reason      TEXT,
  -- FG-693: PROVEN canonical identity of project_dir, or NULL. project_dir stays NOT
  -- NULL and keeps the launcher's bytes; this column is added NULLABLE because a
  -- receipt written before FG-693 has no proven identity and none can be invented for
  -- it. This is the table whose single canonicalDir column held an unmarked mix of
  -- proven and lexically-guessed values. See SCHEMA_SQL's header.
  project_dir_canonical TEXT
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_receipts_project
  ON orchestrator_receipts(project_dir, created_at);
CREATE INDEX IF NOT EXISTS idx_orchestrator_receipts_state
  ON orchestrator_receipts(state, created_at);
CREATE INDEX IF NOT EXISTS idx_orchestrator_receipts_session
  ON orchestrator_receipts(session_key);
`;

// THE ADDITIVE COLUMN LIST — the machine-checked half of the additive-only
// open-path contract (FG-568/BD-15). Declared here as data so applyMigrations
// (db.ts) and the CREATE shapes above cannot drift: schema.ts owns the shape,
// db.ts owns the idempotent, PRAGMA-guarded ALTER.
//
// WHY IT IS EXHAUSTIVE rather than "the columns we remember adding late" (FG-608
// reopen). `forge backlog migrate` failed on the dogfood host with "table tickets
// has no column named imported_from": SCHEMA_SQL's CREATE named the column, so
// every fresh DB (all tests, all CI) had it — but CREATE TABLE IF NOT EXISTS
// no-ops against the host's older `tickets`, and no ALTER existed, so the column
// was silently absent on exactly the DBs that matter. A migration list curated by
// memory reproduces that failure once per forgotten column.
//
// The invariant instead: BECAUSE the open path is additive-only, every historical
// shape of a known table is a strict SUBSET of its fresh shape. So this list must
// carry EVERY column SQLite's ADD COLUMN can restore — nullable, or NOT NULL with
// a DEFAULT, and not part of the primary key. Most entries are no-ops on every DB
// that exists today; that is the point. Completeness is what makes the invariant
// checkable, and fg608-migration-parity.test.ts checks it: it strips a fresh DB
// down to the oldest shape SQLite permits, migrates it, and demands PRAGMA
// table_info parity with a fresh one. A new SCHEMA_SQL column without an entry
// here fails that test.
//
// Adding a column above therefore means adding it here too. Nothing else.
export type AdditiveColumn = { table: string; column: string; ddl: string };

export const ADDITIVE_COLUMNS: AdditiveColumn[] = [
  { table: "runs", column: "completed_at", ddl: "ALTER TABLE runs ADD COLUMN completed_at TEXT" },
  { table: "runs", column: "metadata", ddl: "ALTER TABLE runs ADD COLUMN metadata TEXT" },
  { table: "runs", column: "project_dir", ddl: "ALTER TABLE runs ADD COLUMN project_dir TEXT" },
  // FG-638: exactly one review authority model per run. NOT NULL with a DEFAULT so
  // every pre-FG-638 run row reads back 'legacy_verdict' without a backfill — a
  // legacy run with no `reviews` row is unambiguous rather than null-and-guessed.
  { table: "runs", column: "review_mode", ddl: "ALTER TABLE runs ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'legacy_verdict'" },
  // FG-693: PROVEN canonical project identity. Nullable with NO default, deliberately:
  // a pre-FG-693 row's identity was never proven, and NULL is the only honest reading
  // of it. A DEFAULT of any kind — or a backfill that resolved the stored spelling at
  // migration time — would mint proof that does not exist, since resolving a spelling
  // TODAY says nothing about the tree it named when the row was written.
  { table: "runs", column: "project_dir_canonical", ddl: "ALTER TABLE runs ADD COLUMN project_dir_canonical TEXT" },
  // FG-663: the durable project a run belongs to. Nullable with NO default, for the
  // same reason as project_dir_canonical above: a pre-FG-663 row's project was never
  // captured, so NULL is the only honest reading — any default would attribute those
  // rows to a project nothing proved they belong to. Additive-only, no user_version
  // bump: safe for a concurrent deployed peer binary (FG-568/BD-15).
  { table: "runs", column: "project_identity", ddl: "ALTER TABLE runs ADD COLUMN project_identity TEXT" },

  { table: "tasks", column: "parent_id", ddl: "ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id)" },
  { table: "tasks", column: "agent_alias", ddl: "ALTER TABLE tasks ADD COLUMN agent_alias TEXT" },
  { table: "tasks", column: "agent_model", ddl: "ALTER TABLE tasks ADD COLUMN agent_model TEXT" },
  { table: "tasks", column: "result", ddl: "ALTER TABLE tasks ADD COLUMN result TEXT" },
  { table: "tasks", column: "started_at", ddl: "ALTER TABLE tasks ADD COLUMN started_at TEXT" },
  { table: "tasks", column: "completed_at", ddl: "ALTER TABLE tasks ADD COLUMN completed_at TEXT" },
  { table: "tasks", column: "error", ddl: "ALTER TABLE tasks ADD COLUMN error TEXT" },
  // AWN-7: the per-task model resolution record (policy mode).
  { table: "tasks", column: "resolved_profile", ddl: "ALTER TABLE tasks ADD COLUMN resolved_profile TEXT" },
  { table: "tasks", column: "resolved_provider", ddl: "ALTER TABLE tasks ADD COLUMN resolved_provider TEXT" },
  { table: "tasks", column: "resolved_auth", ddl: "ALTER TABLE tasks ADD COLUMN resolved_auth TEXT" },
  { table: "tasks", column: "resolved_by", ddl: "ALTER TABLE tasks ADD COLUMN resolved_by TEXT" },
  // FG-560: the two provenance axes. Mirror the resolved_* entries above — nullable,
  // idempotent (PRAGMA-guarded in db.ts), so the aged host DB gains them without a
  // rebuild and a fresh DB gets them from SCHEMA_SQL's CREATE.
  { table: "tasks", column: "resolved_capability_source", ddl: "ALTER TABLE tasks ADD COLUMN resolved_capability_source TEXT" },
  { table: "tasks", column: "resolved_mapping_path", ddl: "ALTER TABLE tasks ADD COLUMN resolved_mapping_path TEXT" },
  // FG-351 / FG-621: the private-clone path and the commit it was created at.
  { table: "tasks", column: "worktree_path", ddl: "ALTER TABLE tasks ADD COLUMN worktree_path TEXT" },
  { table: "tasks", column: "base_sha", ddl: "ALTER TABLE tasks ADD COLUMN base_sha TEXT" },

  // FG-523 (F16): nullable with NO default — an existing row reads back NULL, which
  // aggregateVerdicts treats as "blocks" (fail closed), exactly as before it existed.
  { table: "verdicts", column: "gate_on_verdict", ddl: "ALTER TABLE verdicts ADD COLUMN gate_on_verdict INTEGER" },

  { table: "gates", column: "rationale", ddl: "ALTER TABLE gates ADD COLUMN rationale TEXT" },

  { table: "events", column: "run_id", ddl: "ALTER TABLE events ADD COLUMN run_id TEXT" },
  { table: "events", column: "task_id", ddl: "ALTER TABLE events ADD COLUMN task_id TEXT" },
  { table: "events", column: "payload", ddl: "ALTER TABLE events ADD COLUMN payload TEXT" },

  // #155: the model_calls reshape. The 0.1.x legacy columns (prompt_tokens/
  // completion_tokens/cost) are deliberately NOT dropped here — see
  // LEGACY_MODEL_CALLS_COLUMNS and runDestructiveConvergenceMigration in db.ts.
  { table: "model_calls", column: "task_id", ddl: "ALTER TABLE model_calls ADD COLUMN task_id TEXT REFERENCES tasks(id)" },
  { table: "model_calls", column: "alias", ddl: "ALTER TABLE model_calls ADD COLUMN alias TEXT" },
  { table: "model_calls", column: "input_tokens", ddl: "ALTER TABLE model_calls ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0" },
  { table: "model_calls", column: "output_tokens", ddl: "ALTER TABLE model_calls ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0" },
  { table: "model_calls", column: "cache_read_tokens", ddl: "ALTER TABLE model_calls ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0" },
  { table: "model_calls", column: "cache_creation_tokens", ddl: "ALTER TABLE model_calls ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0" },

  { table: "campaigns", column: "metadata", ddl: "ALTER TABLE campaigns ADD COLUMN metadata TEXT" },
  // FG-391 / FG-392: plan hash, the approval record, and the campaign's project dir.
  { table: "campaigns", column: "plan_hash", ddl: "ALTER TABLE campaigns ADD COLUMN plan_hash TEXT" },
  { table: "campaigns", column: "approved_by", ddl: "ALTER TABLE campaigns ADD COLUMN approved_by TEXT" },
  { table: "campaigns", column: "approved_at", ddl: "ALTER TABLE campaigns ADD COLUMN approved_at TEXT" },
  { table: "campaigns", column: "approval_rationale", ddl: "ALTER TABLE campaigns ADD COLUMN approval_rationale TEXT" },
  { table: "campaigns", column: "approved_plan_hash", ddl: "ALTER TABLE campaigns ADD COLUMN approved_plan_hash TEXT" },
  { table: "campaigns", column: "project_dir", ddl: "ALTER TABLE campaigns ADD COLUMN project_dir TEXT" },
  // FG-693: see the runs entry above for why this is nullable, undefaulted and unbackfilled.
  { table: "campaigns", column: "project_dir_canonical", ddl: "ALTER TABLE campaigns ADD COLUMN project_dir_canonical TEXT" },

  { table: "campaign_items", column: "run_id", ddl: "ALTER TABLE campaign_items ADD COLUMN run_id TEXT" },
  { table: "campaign_items", column: "branch", ddl: "ALTER TABLE campaign_items ADD COLUMN branch TEXT" },
  { table: "campaign_items", column: "worktree_path", ddl: "ALTER TABLE campaign_items ADD COLUMN worktree_path TEXT" },
  { table: "campaign_items", column: "pr_url", ddl: "ALTER TABLE campaign_items ADD COLUMN pr_url TEXT" },
  { table: "campaign_items", column: "outcome", ddl: "ALTER TABLE campaign_items ADD COLUMN outcome TEXT" },
  { table: "campaign_items", column: "blocker_kind", ddl: "ALTER TABLE campaign_items ADD COLUMN blocker_kind TEXT" },
  { table: "campaign_items", column: "continue_policy", ddl: "ALTER TABLE campaign_items ADD COLUMN continue_policy TEXT" },
  { table: "campaign_items", column: "reason", ddl: "ALTER TABLE campaign_items ADD COLUMN reason TEXT" },
  { table: "campaign_items", column: "requested_human_action", ddl: "ALTER TABLE campaign_items ADD COLUMN requested_human_action TEXT" },
  // FG-596: NOT NULL with DEFAULT 0 — the "never allocated" marker a pre-FG-596 row
  // reads back without a backfill; a real attempt is >= 1.
  { table: "campaign_items", column: "attempt_generation", ddl: "ALTER TABLE campaign_items ADD COLUMN attempt_generation INTEGER NOT NULL DEFAULT 0" },

  { table: "host_verifications", column: "run_id", ddl: "ALTER TABLE host_verifications ADD COLUMN run_id TEXT REFERENCES runs(id)" },
  // FG-474: DEFAULT 'host' so every pre-existing row (all host-run, by construction)
  // classifies correctly without a backfill.
  { table: "host_verifications", column: "source", ddl: "ALTER TABLE host_verifications ADD COLUMN source TEXT NOT NULL DEFAULT 'host'" },
  { table: "host_verifications", column: "ci_url", ddl: "ALTER TABLE host_verifications ADD COLUMN ci_url TEXT" },
  // FG-693: see the runs entry above. Gate evidence is the one population where a
  // fabricated canonical value would be worst — it would let one checkout's green gate
  // satisfy another's — so the undefaulted NULL is load-bearing, not incidental.
  { table: "host_verifications", column: "project_dir_canonical", ddl: "ALTER TABLE host_verifications ADD COLUMN project_dir_canonical TEXT" },

  { table: "publication_attempts", column: "base_sha", ddl: "ALTER TABLE publication_attempts ADD COLUMN base_sha TEXT" },
  { table: "publication_attempts", column: "candidate_sha", ddl: "ALTER TABLE publication_attempts ADD COLUMN candidate_sha TEXT" },
  { table: "publication_attempts", column: "published_sha", ddl: "ALTER TABLE publication_attempts ADD COLUMN published_sha TEXT" },
  { table: "publication_attempts", column: "park_reason", ddl: "ALTER TABLE publication_attempts ADD COLUMN park_reason TEXT" },
  { table: "publication_attempts", column: "worktree_path", ddl: "ALTER TABLE publication_attempts ADD COLUMN worktree_path TEXT" },
  { table: "publication_attempts", column: "rebuild_count", ddl: "ALTER TABLE publication_attempts ADD COLUMN rebuild_count INTEGER NOT NULL DEFAULT 0" },

  { table: "continuations", column: "claim_owner", ddl: "ALTER TABLE continuations ADD COLUMN claim_owner TEXT" },
  { table: "continuations", column: "claim_expires_at", ddl: "ALTER TABLE continuations ADD COLUMN claim_expires_at INTEGER" },
  { table: "continuations", column: "dispatch_key", ddl: "ALTER TABLE continuations ADD COLUMN dispatch_key TEXT" },
  { table: "continuations", column: "dispatched_run_id", ddl: "ALTER TABLE continuations ADD COLUMN dispatched_run_id TEXT" },
  { table: "continuations", column: "dispatched_task_id", ddl: "ALTER TABLE continuations ADD COLUMN dispatched_task_id TEXT" },
  { table: "continuations", column: "last_observed_status", ddl: "ALTER TABLE continuations ADD COLUMN last_observed_status TEXT" },

  // FG-679: launch_observations arrives WHOLE as a brand-new table, so every entry
  // here is a no-op on every DB that exists today. They are declared anyway because
  // the additive-only invariant is only CHECKABLE if the list is exhaustive
  // (fg608-migration-parity strips a fresh DB to the oldest shape SQLite permits and
  // demands table_info parity) — a list curated by memory is how FG-608's
  // "no column named imported_from" reached the dogfood host. The NOT NULL columns
  // with no default (command, cwd, association_kind, started_at, observed_at, state,
  // terminal) are deliberately absent: ADD COLUMN cannot restore them.
  { table: "launch_observations", column: "name", ddl: "ALTER TABLE launch_observations ADD COLUMN name TEXT" },
  { table: "launch_observations", column: "project_dir", ddl: "ALTER TABLE launch_observations ADD COLUMN project_dir TEXT" },
  { table: "launch_observations", column: "run_id", ddl: "ALTER TABLE launch_observations ADD COLUMN run_id TEXT" },
  { table: "launch_observations", column: "task_id", ddl: "ALTER TABLE launch_observations ADD COLUMN task_id TEXT" },
  { table: "launch_observations", column: "ticket_id", ddl: "ALTER TABLE launch_observations ADD COLUMN ticket_id TEXT" },
  { table: "launch_observations", column: "campaign_id", ddl: "ALTER TABLE launch_observations ADD COLUMN campaign_id TEXT" },
  { table: "launch_observations", column: "item_id", ddl: "ALTER TABLE launch_observations ADD COLUMN item_id TEXT" },
  { table: "launch_observations", column: "exit_code", ddl: "ALTER TABLE launch_observations ADD COLUMN exit_code INTEGER" },
  { table: "launch_observations", column: "signal", ddl: "ALTER TABLE launch_observations ADD COLUMN signal TEXT" },
  // FG-700: the first launch_observations column that is NOT a no-op — every store
  // created since FG-679 carries the table WITHOUT it. Nullable and undefaulted on
  // purpose: an existing row's purpose was never declared, and NULL is how it says so
  // (it reads as `generic`, never as host verification). user_version is NOT bumped.
  { table: "launch_observations", column: "purpose", ddl: "ALTER TABLE launch_observations ADD COLUMN purpose TEXT" },
  // FG-693: the SECOND launch_observations column that is not a no-op — every store
  // created since FG-679 carries the table without it. Nullable and undefaulted for the
  // same reason as the runs entry above. `cwd` gets no companion column: it is the
  // launch's working directory, not a project key, and nothing decides ownership from it.
  { table: "launch_observations", column: "project_dir_canonical", ddl: "ALTER TABLE launch_observations ADD COLUMN project_dir_canonical TEXT" },

  // FG-731: ci_waits is a whole new table, but the fresh-vs-migrated parity guard strips
  // EVERY restorable column off EVERY table and relies on this list to restore it — so a
  // new table's nullable columns are declared here exactly like launch_observations' were.
  // The five non-restorable columns (id PK; kind/started_at/lifecycle_state/terminal, all
  // NOT NULL with no default) are re-created only by the CREATE and are correctly absent
  // here. run_id and project_dir are index-referenced (undroppable) and so ALSO appear in
  // the parity guard's UNDROPPABLE set — the same dual listing launch_observations uses.
  { table: "ci_waits", column: "repo", ddl: "ALTER TABLE ci_waits ADD COLUMN repo TEXT" },
  { table: "ci_waits", column: "actions_run_id", ddl: "ALTER TABLE ci_waits ADD COLUMN actions_run_id TEXT" },
  { table: "ci_waits", column: "pr_number", ddl: "ALTER TABLE ci_waits ADD COLUMN pr_number INTEGER" },
  { table: "ci_waits", column: "head_sha", ddl: "ALTER TABLE ci_waits ADD COLUMN head_sha TEXT" },
  { table: "ci_waits", column: "check_suite_ref", ddl: "ALTER TABLE ci_waits ADD COLUMN check_suite_ref TEXT" },
  { table: "ci_waits", column: "workflow_file", ddl: "ALTER TABLE ci_waits ADD COLUMN workflow_file TEXT" },
  { table: "ci_waits", column: "dispatch_ref", ddl: "ALTER TABLE ci_waits ADD COLUMN dispatch_ref TEXT" },
  { table: "ci_waits", column: "dispatch_inputs", ddl: "ALTER TABLE ci_waits ADD COLUMN dispatch_inputs TEXT" },
  { table: "ci_waits", column: "url", ddl: "ALTER TABLE ci_waits ADD COLUMN url TEXT" },
  { table: "ci_waits", column: "terminal_disposition", ddl: "ALTER TABLE ci_waits ADD COLUMN terminal_disposition TEXT" },
  { table: "ci_waits", column: "observed_state", ddl: "ALTER TABLE ci_waits ADD COLUMN observed_state TEXT" },
  { table: "ci_waits", column: "observed_reason", ddl: "ALTER TABLE ci_waits ADD COLUMN observed_reason TEXT" },
  { table: "ci_waits", column: "observed_m", ddl: "ALTER TABLE ci_waits ADD COLUMN observed_m INTEGER" },
  { table: "ci_waits", column: "observed_n", ddl: "ALTER TABLE ci_waits ADD COLUMN observed_n INTEGER" },
  { table: "ci_waits", column: "observed_at", ddl: "ALTER TABLE ci_waits ADD COLUMN observed_at TEXT" },
  { table: "ci_waits", column: "owner", ddl: "ALTER TABLE ci_waits ADD COLUMN owner TEXT" },
  { table: "ci_waits", column: "lease_expires_at_ms", ddl: "ALTER TABLE ci_waits ADD COLUMN lease_expires_at_ms INTEGER" },
  { table: "ci_waits", column: "run_id", ddl: "ALTER TABLE ci_waits ADD COLUMN run_id TEXT" },
  { table: "ci_waits", column: "ticket_id", ddl: "ALTER TABLE ci_waits ADD COLUMN ticket_id TEXT" },
  { table: "ci_waits", column: "project_dir", ddl: "ALTER TABLE ci_waits ADD COLUMN project_dir TEXT" },
  { table: "ci_waits", column: "project_dir_canonical", ddl: "ALTER TABLE ci_waits ADD COLUMN project_dir_canonical TEXT" },

  // FG-745: workspace_purposes arrives WHOLE as a brand-new table (CREATE TABLE IF NOT
  // EXISTS in SCHEMA_SQL), so on a fresh/aged store none of these ALTERs ever fires —
  // the CREATE already has them. They exist ONLY so the fresh-vs-migrated parity guard
  // (fg608-migration-parity) can strip every restorable column and prove applyMigrations
  // restores it, exactly as launch_observations / ci_waits do. The NOT NULL columns
  // (path_as_written, kind, source, created_at, updated_at) are undroppable and covered
  // by the list-completeness half of that guard, so they are deliberately not listed.
  { table: "workspace_purposes", column: "project_identity", ddl: "ALTER TABLE workspace_purposes ADD COLUMN project_identity TEXT" },
  { table: "workspace_purposes", column: "run_id", ddl: "ALTER TABLE workspace_purposes ADD COLUMN run_id TEXT" },
  { table: "workspace_purposes", column: "task_id", ddl: "ALTER TABLE workspace_purposes ADD COLUMN task_id TEXT" },
  { table: "workspace_purposes", column: "reason", ddl: "ALTER TABLE workspace_purposes ADD COLUMN reason TEXT" },

  // FG-745 (review RF-2): the workspace_purpose_events audit table arrives WHOLE too;
  // only its nullable `actor` column is restorable, so it is the one entry the parity
  // guard needs (the NOT NULL columns are undroppable and covered by list-completeness).
  { table: "workspace_purpose_events", column: "actor", ddl: "ALTER TABLE workspace_purpose_events ADD COLUMN actor TEXT" },

  { table: "continuation_lost_signal_recoveries", column: "dispatch_key", ddl: "ALTER TABLE continuation_lost_signal_recoveries ADD COLUMN dispatch_key TEXT" },
  { table: "continuation_lost_signal_recoveries", column: "dispatched_run_id", ddl: "ALTER TABLE continuation_lost_signal_recoveries ADD COLUMN dispatched_run_id TEXT" },
  { table: "continuation_lost_signal_recoveries", column: "dispatched_task_id", ddl: "ALTER TABLE continuation_lost_signal_recoveries ADD COLUMN dispatched_task_id TEXT" },

  { table: "campaign_item_launches", column: "run_id", ddl: "ALTER TABLE campaign_item_launches ADD COLUMN run_id TEXT" },

  { table: "tickets", column: "body", ddl: "ALTER TABLE tickets ADD COLUMN body TEXT NOT NULL DEFAULT ''" },
  { table: "tickets", column: "created", ddl: "ALTER TABLE tickets ADD COLUMN created TEXT" },
  { table: "tickets", column: "closed", ddl: "ALTER TABLE tickets ADD COLUMN closed TEXT" },
  { table: "tickets", column: "closed_commit", ddl: "ALTER TABLE tickets ADD COLUMN closed_commit TEXT" },
  { table: "tickets", column: "epic", ddl: "ALTER TABLE tickets ADD COLUMN epic TEXT" },
  { table: "tickets", column: "frontmatter", ddl: "ALTER TABLE tickets ADD COLUMN frontmatter TEXT" },
  // THE FG-608-reopen column. Present in the CREATE since FG-606 and missing from
  // every DB whose `tickets` predates it — including the dogfood host's, where the
  // import INSERT that names it failed migrate outright.
  { table: "tickets", column: "imported_from", ddl: "ALTER TABLE tickets ADD COLUMN imported_from TEXT" },
  // FG-608 (i): the MONOTONIC revision counter, bumped on EVERY authoritative write.
  // This is what dispatch evidence records and what answers "did the live ticket
  // advance" — a content hash cannot, because edit-and-revert returns the original
  // hash. DEFAULT 1 so pre-FG-608 rows read back a valid revision.
  { table: "tickets", column: "revision", ddl: "ALTER TABLE tickets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1" },
  // FG-608 (ii): the CONTENT basis. body_hash is the hash of the row's current
  // authoritative content, recomputed on every write; import_basis_hash is that same
  // hash frozen at the last import. They diverge exactly when the DB row was edited
  // since its import basis — the import conflict rule's entire question. A counter
  // cannot answer it (it advances for an import too).
  { table: "tickets", column: "body_hash", ddl: "ALTER TABLE tickets ADD COLUMN body_hash TEXT" },
  { table: "tickets", column: "import_basis_hash", ddl: "ALTER TABLE tickets ADD COLUMN import_basis_hash TEXT" },
  // FG-609 (Slice D): the operator stack rank. Nullable with no default — an
  // unranked ticket is a valid backlog item, and every DB whose `tickets` predates
  // Slice D reads back NULL, which is exactly "not ranked yet". Left UNINDEXED so
  // it stays ALTER-droppable and the FG-608 parity guard's UNDROPPABLE set is
  // untouched.
  { table: "tickets", column: "priority_rank", ddl: "ALTER TABLE tickets ADD COLUMN priority_rank INTEGER" },

  { table: "ticket_events", column: "payload", ddl: "ALTER TABLE ticket_events ADD COLUMN payload TEXT" },

  { table: "ticket_storage_mode", column: "mode", ddl: "ALTER TABLE ticket_storage_mode ADD COLUMN mode TEXT NOT NULL DEFAULT 'markdown'" },
  // FG-608 default (d): the first DB-only edit is RECORDED, so `mode --set markdown`
  // can REFUSE afterward instead of relying on the operator remembering that
  // backlog/*.md froze.
  { table: "ticket_storage_mode", column: "first_db_edit_at", ddl: "ALTER TABLE ticket_storage_mode ADD COLUMN first_db_edit_at TEXT" },
  { table: "ticket_storage_mode", column: "first_db_edit_ticket", ddl: "ALTER TABLE ticket_storage_mode ADD COLUMN first_db_edit_ticket TEXT" },
  // WHICH forge performed the flip. This host runs several forge checkouts from
  // source against one ~/.forge/forge.db, and additive migrations never bump
  // user_version — so an OLDER binary opens the migrated DB happily and keeps
  // reading the frozen backlog/*.md. Nothing in the DB can stop it, so name it in
  // the flip record and in the cutover UX rather than pretend it is prevented.
  { table: "ticket_storage_mode", column: "flipped_at", ddl: "ALTER TABLE ticket_storage_mode ADD COLUMN flipped_at TEXT" },
  { table: "ticket_storage_mode", column: "flipped_by_revision", ddl: "ALTER TABLE ticket_storage_mode ADD COLUMN flipped_by_revision TEXT" },

  { table: "blocker_evidence", column: "reason", ddl: "ALTER TABLE blocker_evidence ADD COLUMN reason TEXT" },
  // FG-609 (Slice D): the enrichment. `kind` is NOT NULL WITH A DEFAULT, which is
  // what makes the enrichment lossless: every Slice A row on the aged host DB
  // reads back 'legacy_blocked' without a backfill, keeping its original fact,
  // reason, source and created_at exactly as written. No CHECK — an older writer's
  // inserts must never fight a constraint it does not know about.
  { table: "blocker_evidence", column: "kind", ddl: "ALTER TABLE blocker_evidence ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy_blocked'" },
  { table: "blocker_evidence", column: "detail", ddl: "ALTER TABLE blocker_evidence ADD COLUMN detail TEXT" },
  { table: "blocker_evidence", column: "body_hash", ddl: "ALTER TABLE blocker_evidence ADD COLUMN body_hash TEXT" },
  { table: "blocker_evidence", column: "queue_projection", ddl: "ALTER TABLE blocker_evidence ADD COLUMN queue_projection TEXT" },

  { table: "backlog_sources", column: "last_path", ddl: "ALTER TABLE backlog_sources ADD COLUMN last_path TEXT" },
  { table: "backlog_sources", column: "last_scanned_at", ddl: "ALTER TABLE backlog_sources ADD COLUMN last_scanned_at TEXT" },
  { table: "backlog_sources", column: "forgotten_at", ddl: "ALTER TABLE backlog_sources ADD COLUMN forgotten_at TEXT" },

  { table: "backlog_snapshot_targets", column: "task_id", ddl: "ALTER TABLE backlog_snapshot_targets ADD COLUMN task_id TEXT" },
  { table: "backlog_snapshot_targets", column: "released_at", ddl: "ALTER TABLE backlog_snapshot_targets ADD COLUMN released_at TEXT" },

  { table: "backlog_snapshot_publications", column: "attempts", ddl: "ALTER TABLE backlog_snapshot_publications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0" },
  { table: "backlog_snapshot_publications", column: "last_ok_at", ddl: "ALTER TABLE backlog_snapshot_publications ADD COLUMN last_ok_at TEXT" },
  { table: "backlog_snapshot_publications", column: "last_error", ddl: "ALTER TABLE backlog_snapshot_publications ADD COLUMN last_error TEXT" },

  // FG-638: the review ledger. Both tables are brand-new, so a real old DB gets them
  // whole from CREATE TABLE IF NOT EXISTS and none of these ALTERs ever fires there.
  // They exist because the parity guard strips a fresh DB back to the oldest shape
  // SQLite permits and demands the migration path restore it — which is exactly the
  // check that would have caught tickets.imported_from.
  { table: "reviews", column: "run_id", ddl: "ALTER TABLE reviews ADD COLUMN run_id TEXT" },
  { table: "reviews", column: "subject_task_id", ddl: "ALTER TABLE reviews ADD COLUMN subject_task_id TEXT" },
  { table: "reviews", column: "ticket_id", ddl: "ALTER TABLE reviews ADD COLUMN ticket_id TEXT" },
  { table: "reviews", column: "base_sha", ddl: "ALTER TABLE reviews ADD COLUMN base_sha TEXT" },
  { table: "reviews", column: "contract_confirmed_sha", ddl: "ALTER TABLE reviews ADD COLUMN contract_confirmed_sha TEXT" },
  { table: "reviews", column: "candidate_sha", ddl: "ALTER TABLE reviews ADD COLUMN candidate_sha TEXT" },
  { table: "reviews", column: "trusted_remote_sha", ddl: "ALTER TABLE reviews ADD COLUMN trusted_remote_sha TEXT" },
  { table: "reviews", column: "contract_json", ddl: "ALTER TABLE reviews ADD COLUMN contract_json TEXT" },
  { table: "reviews", column: "lens_outcomes_json", ddl: "ALTER TABLE reviews ADD COLUMN lens_outcomes_json TEXT" },
  { table: "reviews", column: "stage_evidence_json", ddl: "ALTER TABLE reviews ADD COLUMN stage_evidence_json TEXT" },
  {
    table: "reviews",
    column: "review_mode",
    ddl:
      "ALTER TABLE reviews ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'evidence_led' " +
      "CHECK (review_mode IN ('legacy_verdict', 'legacy_review_loop', 'evidence_led'))",
  },
  {
    table: "reviews",
    column: "state",
    ddl:
      "ALTER TABLE reviews ADD COLUMN state TEXT NOT NULL DEFAULT 'confirming_contract' " +
      "CHECK (state IN ('confirming_contract', 'discovering', 'awaiting_disposition', 'fixing', " +
      "'documenting', 'verifying', 'rechecking', 'shipping_review', 'settled', 'blocked_environment', 'failed'))",
  },
  { table: "reviews", column: "settled_at", ddl: "ALTER TABLE reviews ADD COLUMN settled_at TEXT" },
  // FG-649: the review's own workspace binding. Additive and nullable — a pre-FG-649 row
  // reads back NULL, which is the legacy shape `forge review continue` adopts a run's
  // project_dir for (and records) rather than guessing from cwd.
  { table: "reviews", column: "workspace_dir", ddl: "ALTER TABLE reviews ADD COLUMN workspace_dir TEXT" },
  // FG-689: the expected shard set, recorded before dispatch. Additive and nullable — a
  // pre-FG-689 row reads back NULL, which the gate reads as "no plan recorded" rather
  // than as an empty plan that nothing is owed against.
  { table: "reviews", column: "shard_plan_json", ddl: "ALTER TABLE reviews ADD COLUMN shard_plan_json TEXT" },

  { table: "review_findings", column: "fingerprint", ddl: "ALTER TABLE review_findings ADD COLUMN fingerprint TEXT" },
  { table: "review_findings", column: "summary", ddl: "ALTER TABLE review_findings ADD COLUMN summary TEXT NOT NULL DEFAULT ''" },
  { table: "review_findings", column: "severity", ddl: "ALTER TABLE review_findings ADD COLUMN severity TEXT" },
  { table: "review_findings", column: "risk_lens", ddl: "ALTER TABLE review_findings ADD COLUMN risk_lens TEXT" },
  { table: "review_findings", column: "finding_type", ddl: "ALTER TABLE review_findings ADD COLUMN finding_type TEXT" },
  { table: "review_findings", column: "evidence", ddl: "ALTER TABLE review_findings ADD COLUMN evidence TEXT" },
  { table: "review_findings", column: "hypothesis", ddl: "ALTER TABLE review_findings ADD COLUMN hypothesis TEXT" },
  { table: "review_findings", column: "reachability", ddl: "ALTER TABLE review_findings ADD COLUMN reachability TEXT" },
  { table: "review_findings", column: "file", ddl: "ALTER TABLE review_findings ADD COLUMN file TEXT" },
  { table: "review_findings", column: "line", ddl: "ALTER TABLE review_findings ADD COLUMN line INTEGER" },
  { table: "review_findings", column: "quoted_text", ddl: "ALTER TABLE review_findings ADD COLUMN quoted_text TEXT" },
  { table: "review_findings", column: "acceptance_ref", ddl: "ALTER TABLE review_findings ADD COLUMN acceptance_ref TEXT" },
  { table: "review_findings", column: "invariant_ref", ddl: "ALTER TABLE review_findings ADD COLUMN invariant_ref TEXT" },
  { table: "review_findings", column: "sources_json", ddl: "ALTER TABLE review_findings ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'" },
  {
    table: "review_findings",
    column: "disposition",
    ddl:
      "ALTER TABLE review_findings ADD COLUMN disposition TEXT NOT NULL DEFAULT 'untriaged' " +
      "CHECK (disposition IN ('untriaged', 'fix_now', 'accepted_risk', 'deferred', 'rejected_premise', " +
      "'duplicate', 'architecture_question'))",
  },
  { table: "review_findings", column: "disposition_rationale", ddl: "ALTER TABLE review_findings ADD COLUMN disposition_rationale TEXT" },
  { table: "review_findings", column: "disposition_evidence", ddl: "ALTER TABLE review_findings ADD COLUMN disposition_evidence TEXT" },
  { table: "review_findings", column: "decided_by", ddl: "ALTER TABLE review_findings ADD COLUMN decided_by TEXT" },
  { table: "review_findings", column: "decided_at", ddl: "ALTER TABLE review_findings ADD COLUMN decided_at TEXT" },
  { table: "review_findings", column: "decided_candidate_sha", ddl: "ALTER TABLE review_findings ADD COLUMN decided_candidate_sha TEXT" },
  { table: "review_findings", column: "duplicate_of", ddl: "ALTER TABLE review_findings ADD COLUMN duplicate_of TEXT" },
  { table: "review_findings", column: "followup_ticket_id", ddl: "ALTER TABLE review_findings ADD COLUMN followup_ticket_id TEXT" },
  { table: "review_findings", column: "resolution", ddl: "ALTER TABLE review_findings ADD COLUMN resolution TEXT" },
  { table: "review_findings", column: "resolution_evidence_kind", ddl: "ALTER TABLE review_findings ADD COLUMN resolution_evidence_kind TEXT" },
  { table: "review_findings", column: "resolution_evidence", ddl: "ALTER TABLE review_findings ADD COLUMN resolution_evidence TEXT" },
  { table: "review_findings", column: "discovered_sha", ddl: "ALTER TABLE review_findings ADD COLUMN discovered_sha TEXT" },
  { table: "review_findings", column: "resolved_sha", ddl: "ALTER TABLE review_findings ADD COLUMN resolved_sha TEXT" },

  // FG-639: the FixBatch tables. Only the restorable columns appear — review_id,
  // revision, candidate_sha, payload_json, payload_sha256 and created_at are NOT NULL
  // without a DEFAULT, and the fix_batch_results primary key is composite, so
  // ADD COLUMN could never put any of those back.
  { table: "fix_batches", column: "supersedes_batch_id", ddl: "ALTER TABLE fix_batches ADD COLUMN supersedes_batch_id TEXT" },
  {
    table: "fix_batches",
    column: "state",
    ddl:
      "ALTER TABLE fix_batches ADD COLUMN state TEXT NOT NULL DEFAULT 'open' " +
      "CHECK (state IN ('open', 'dispatched', 'ingested', 'superseded'))",
  },
  { table: "fix_batches", column: "dispatch_task_id", ddl: "ALTER TABLE fix_batches ADD COLUMN dispatch_task_id TEXT" },

  { table: "fix_batch_results", column: "summary", ddl: "ALTER TABLE fix_batch_results ADD COLUMN summary TEXT" },
  {
    table: "fix_batch_results",
    column: "files_changed_json",
    ddl: "ALTER TABLE fix_batch_results ADD COLUMN files_changed_json TEXT NOT NULL DEFAULT '[]'",
  },
  { table: "fix_batch_results", column: "evidence", ddl: "ALTER TABLE fix_batch_results ADD COLUMN evidence TEXT" },
  { table: "fix_batch_results", column: "interaction", ddl: "ALTER TABLE fix_batch_results ADD COLUMN interaction TEXT" },
  { table: "fix_batch_results", column: "evidence_path", ddl: "ALTER TABLE fix_batch_results ADD COLUMN evidence_path TEXT" },
  { table: "fix_batch_results", column: "evidence_sha256", ddl: "ALTER TABLE fix_batch_results ADD COLUMN evidence_sha256 TEXT" },
  // FG-710 Shape B: the executed-assertion identity a demonstrated `fixed` finding must name.
  { table: "fix_batch_results", column: "executed_assertion", ddl: "ALTER TABLE fix_batch_results ADD COLUMN executed_assertion TEXT" },

  // FG-710: fix_batch_refused_deliveries. Brand-new, so a real old DB gets it whole from the
  // CREATE TABLE IF NOT EXISTS above and none of these ALTERs ever fires there. They are declared
  // for the FG-608 parity guard, which strips a fresh DB to the oldest shape SQLite permits and
  // demands the migration path restore it. Only the RESTORABLE columns appear: batch_id/revision
  // are the primary key and captured_at_candidate_sha, created_at and updated_at are NOT NULL with
  // NO DEFAULT, so ADD COLUMN could never put them back and listing them would be a lie.
  {
    table: "fix_batch_refused_deliveries",
    column: "raw_result_bytes",
    ddl: "ALTER TABLE fix_batch_refused_deliveries ADD COLUMN raw_result_bytes TEXT",
  },
  {
    table: "fix_batch_refused_deliveries",
    column: "diff_patch",
    ddl: "ALTER TABLE fix_batch_refused_deliveries ADD COLUMN diff_patch TEXT",
  },
  {
    table: "fix_batch_refused_deliveries",
    column: "porcelain_status",
    ddl: "ALTER TABLE fix_batch_refused_deliveries ADD COLUMN porcelain_status TEXT",
  },
  {
    table: "fix_batch_refused_deliveries",
    column: "refusal_reasons_json",
    ddl: "ALTER TABLE fix_batch_refused_deliveries ADD COLUMN refusal_reasons_json TEXT NOT NULL DEFAULT '[]'",
  },
  {
    table: "fix_batch_refused_deliveries",
    column: "repair_attempts",
    ddl: "ALTER TABLE fix_batch_refused_deliveries ADD COLUMN repair_attempts INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "fix_batch_refused_deliveries",
    column: "state",
    ddl:
      "ALTER TABLE fix_batch_refused_deliveries ADD COLUMN state TEXT NOT NULL DEFAULT 'open' " +
      "CHECK (state IN ('open', 'repairing', 'superseded'))",
  },
  // RF-1: the repair lease. Nullable INTEGER with no default, so ADD COLUMN restores it on an
  // aged DB and the FG-608 parity guard is satisfied.
  {
    table: "fix_batch_refused_deliveries",
    column: "lease_expires_at_ms",
    ddl: "ALTER TABLE fix_batch_refused_deliveries ADD COLUMN lease_expires_at_ms INTEGER",
  },

  // FG-655: the docs dispatch binding. Brand-new, so a real old DB gets it whole from the
  // CREATE above and none of these ever fires there — they exist for the FG-608 parity
  // guard. id, review_id, candidate_sha and created_at are the primary key and the
  // NOT-NULL-without-DEFAULT columns, so ADD COLUMN could never restore them and listing
  // them would be a lie.
  {
    table: "review_docs_dispatches",
    column: "state",
    ddl:
      "ALTER TABLE review_docs_dispatches ADD COLUMN state TEXT NOT NULL DEFAULT 'open' " +
      "CHECK (state IN ('open', 'dispatched', 'retired'))",
  },
  { table: "review_docs_dispatches", column: "dispatch_task_id", ddl: "ALTER TABLE review_docs_dispatches ADD COLUMN dispatch_task_id TEXT" },
  { table: "review_docs_dispatches", column: "dispatch_run_id", ddl: "ALTER TABLE review_docs_dispatches ADD COLUMN dispatch_run_id TEXT" },
  { table: "review_docs_dispatches", column: "retired_at", ddl: "ALTER TABLE review_docs_dispatches ADD COLUMN retired_at TEXT" },
  { table: "review_docs_dispatches", column: "retired_reason", ddl: "ALTER TABLE review_docs_dispatches ADD COLUMN retired_reason TEXT" },

  // FG-609: the queue tables. All three are brand-new, so a real old DB gets them
  // whole from CREATE TABLE IF NOT EXISTS and none of these ALTERs ever fires
  // there. They exist because the FG-608 parity guard strips a fresh DB back to the
  // oldest shape SQLite permits and demands the migration path restore it — the
  // check that would have caught tickets.imported_from. Only the RESTORABLE columns
  // appear: the primary-key columns and the NOT-NULL-without-DEFAULT ones
  // (enqueued_at, body_hash, outcome, evaluated_at, event_type, created_at) can
  // never be put back by ADD COLUMN, so listing them would be a lie.
  { table: "queue_membership", column: "enqueued_by", ddl: "ALTER TABLE queue_membership ADD COLUMN enqueued_by TEXT" },
  { table: "queue_membership", column: "note", ddl: "ALTER TABLE queue_membership ADD COLUMN note TEXT" },

  { table: "readiness_assessments", column: "gaps_json", ddl: "ALTER TABLE readiness_assessments ADD COLUMN gaps_json TEXT NOT NULL DEFAULT '[]'" },
  { table: "readiness_assessments", column: "refinement_proposal", ddl: "ALTER TABLE readiness_assessments ADD COLUMN refinement_proposal TEXT" },
  { table: "readiness_assessments", column: "revision", ddl: "ALTER TABLE readiness_assessments ADD COLUMN revision INTEGER" },

  { table: "queue_events", column: "payload", ddl: "ALTER TABLE queue_events ADD COLUMN payload TEXT" },

  // FG-610 (Slice E): queue_claims. Brand-new, so a real old DB gets it whole from
  // CREATE TABLE IF NOT EXISTS and none of these ALTERs ever fires there. They are
  // declared anyway for the SAME reason FG-609's, FG-655's and FG-679's brand-new
  // tables are: the additive-only invariant is only CHECKABLE if this list is
  // EXHAUSTIVE, and fg608-migration-parity.test.ts enforces exhaustiveness by
  // stripping a fresh DB to the oldest shape SQLite permits and demanding parity. A
  // restorable column with no entry here fails that test — that is the mechanism
  // that would have caught tickets.imported_from.
  //
  // Only the RESTORABLE columns appear. id is the primary key, and project_key,
  // ticket_id, owner, generation, ticket_revision, lease_expires_at_ms,
  // heartbeat_at_ms, state and claimed_at are NOT NULL with NO DEFAULT, so ADD
  // COLUMN could never put any of them back and listing them would be a lie.
  { table: "queue_claims", column: "launch_id", ddl: "ALTER TABLE queue_claims ADD COLUMN launch_id TEXT" },
  { table: "queue_claims", column: "run_id", ddl: "ALTER TABLE queue_claims ADD COLUMN run_id TEXT" },
  { table: "queue_claims", column: "outcome", ddl: "ALTER TABLE queue_claims ADD COLUMN outcome TEXT" },
  { table: "queue_claims", column: "scan_evidence", ddl: "ALTER TABLE queue_claims ADD COLUMN scan_evidence TEXT" },
  { table: "queue_claims", column: "released_at", ddl: "ALTER TABLE queue_claims ADD COLUMN released_at TEXT" },

  // FG-591: the four dispatcher tables. All brand-new, so a real old DB gets each of
  // them WHOLE from CREATE TABLE IF NOT EXISTS and none of these ALTERs ever fires
  // there. They are declared anyway for the SAME reason FG-609's, FG-610's, FG-655's
  // and FG-679's brand-new tables are: the additive-only invariant is only CHECKABLE
  // if this list is EXHAUSTIVE, and fg608-migration-parity.test.ts enforces
  // exhaustiveness by stripping a fresh DB to the oldest shape SQLite permits and
  // demanding parity. A restorable column with no entry here fails that test — the
  // mechanism that would have caught tickets.imported_from.
  //
  // Only the RESTORABLE columns appear. Each table's primary key and its NOT NULL
  // columns with NO DEFAULT are deliberately absent: ADD COLUMN could never put them
  // back, so listing them would be a lie.
  { table: "dispatcher_policy", column: "armed", ddl: "ALTER TABLE dispatcher_policy ADD COLUMN armed INTEGER" },
  { table: "dispatcher_policy", column: "max_active_runs", ddl: "ALTER TABLE dispatcher_policy ADD COLUMN max_active_runs INTEGER" },
  { table: "dispatcher_policy", column: "capacity_scope", ddl: "ALTER TABLE dispatcher_policy ADD COLUMN capacity_scope TEXT" },
  { table: "dispatcher_policy", column: "lease_ttl_ms", ddl: "ALTER TABLE dispatcher_policy ADD COLUMN lease_ttl_ms INTEGER" },
  { table: "dispatcher_policy", column: "heartbeat_ms", ddl: "ALTER TABLE dispatcher_policy ADD COLUMN heartbeat_ms INTEGER" },
  { table: "dispatcher_policy", column: "default_workflow", ddl: "ALTER TABLE dispatcher_policy ADD COLUMN default_workflow TEXT" },
  { table: "dispatcher_policy", column: "updated_by", ddl: "ALTER TABLE dispatcher_policy ADD COLUMN updated_by TEXT" },

  { table: "dispatcher_leases", column: "host", ddl: "ALTER TABLE dispatcher_leases ADD COLUMN host TEXT" },
  { table: "dispatcher_leases", column: "pid", ddl: "ALTER TABLE dispatcher_leases ADD COLUMN pid INTEGER" },

  { table: "dispatcher_wakes", column: "detail", ddl: "ALTER TABLE dispatcher_wakes ADD COLUMN detail TEXT" },
  { table: "dispatcher_wakes", column: "consumed_by", ddl: "ALTER TABLE dispatcher_wakes ADD COLUMN consumed_by TEXT" },
  { table: "dispatcher_wakes", column: "consumed_at_ms", ddl: "ALTER TABLE dispatcher_wakes ADD COLUMN consumed_at_ms INTEGER" },

  { table: "dispatcher_evaluations", column: "dispatcher_generation", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN dispatcher_generation INTEGER" },
  { table: "dispatcher_evaluations", column: "detail", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN detail TEXT" },
  { table: "dispatcher_evaluations", column: "claimed_ticket_id", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN claimed_ticket_id TEXT" },
  { table: "dispatcher_evaluations", column: "claim_id", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN claim_id TEXT" },
  { table: "dispatcher_evaluations", column: "capacity_scope", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN capacity_scope TEXT" },
  { table: "dispatcher_evaluations", column: "capacity_limit", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN capacity_limit INTEGER" },
  { table: "dispatcher_evaluations", column: "capacity_used", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN capacity_used INTEGER" },
  { table: "dispatcher_evaluations", column: "capacity_holders", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN capacity_holders TEXT" },
  { table: "dispatcher_evaluations", column: "scan_evidence", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN scan_evidence TEXT" },
  { table: "dispatcher_evaluations", column: "wake_kind", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN wake_kind TEXT" },
  { table: "dispatcher_evaluations", column: "next_watchdog_at_ms", ddl: "ALTER TABLE dispatcher_evaluations ADD COLUMN next_watchdog_at_ms INTEGER" },

  // FG-576: orchestrator_receipts. Brand-new, so a real old DB gets it whole from
  // CREATE TABLE IF NOT EXISTS and none of these ALTERs ever fires there. They are
  // declared anyway for the SAME reason FG-609's, FG-610's, FG-655's, FG-679's and
  // FG-591's brand-new tables are: the additive-only invariant is only CHECKABLE if
  // this list is EXHAUSTIVE, and fg608-migration-parity.test.ts enforces that by
  // stripping a fresh DB to the oldest shape SQLite permits and demanding parity.
  //
  // Only the RESTORABLE columns appear. receipt_id is the primary key, and
  // session_key, state, created_at, updated_at, project_dir, runtime, provider,
  // adapter and session_operation are NOT NULL with NO DEFAULT, so ADD COLUMN could
  // never put any of them back and listing them would be a lie.
  //
  // identity_strength and carrier_acceptance carry FAIL-CLOSED defaults, so a row
  // restored onto an older shape reads as 'unknown'/'unproven' — never as an asserted
  // session identity or an accepted instruction carrier nothing proved (AC8/AC9).
  { table: "orchestrator_receipts", column: "project_name", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN project_name TEXT" },
  { table: "orchestrator_receipts", column: "resolved_profile", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN resolved_profile TEXT" },
  { table: "orchestrator_receipts", column: "model", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN model TEXT" },
  { table: "orchestrator_receipts", column: "auth_mode", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN auth_mode TEXT" },
  { table: "orchestrator_receipts", column: "resolved_by", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN resolved_by TEXT" },
  { table: "orchestrator_receipts", column: "session_target", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN session_target TEXT" },
  { table: "orchestrator_receipts", column: "provider_session_id", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN provider_session_id TEXT" },
  { table: "orchestrator_receipts", column: "identity_strength", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN identity_strength TEXT NOT NULL DEFAULT 'unknown'" },
  { table: "orchestrator_receipts", column: "identity_basis", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN identity_basis TEXT" },
  { table: "orchestrator_receipts", column: "carrier_generation", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN carrier_generation TEXT" },
  { table: "orchestrator_receipts", column: "carrier_path", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN carrier_path TEXT" },
  { table: "orchestrator_receipts", column: "carrier_acceptance", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN carrier_acceptance TEXT NOT NULL DEFAULT 'unproven'" },
  { table: "orchestrator_receipts", column: "carrier_evidence", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN carrier_evidence TEXT" },
  { table: "orchestrator_receipts", column: "limitations", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN limitations TEXT" },
  { table: "orchestrator_receipts", column: "task_id", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN task_id TEXT" },
  { table: "orchestrator_receipts", column: "launcher_pid", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN launcher_pid INTEGER" },
  { table: "orchestrator_receipts", column: "launcher_identity", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN launcher_identity TEXT" },
  { table: "orchestrator_receipts", column: "started_at", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN started_at TEXT" },
  { table: "orchestrator_receipts", column: "closed_at", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN closed_at TEXT" },
  { table: "orchestrator_receipts", column: "exit_code", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN exit_code INTEGER" },
  { table: "orchestrator_receipts", column: "exit_signal", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN exit_signal TEXT" },
  { table: "orchestrator_receipts", column: "failure_reason", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN failure_reason TEXT" },
  // FG-693: see the runs entry above. project_dir stays NOT NULL and keeps the
  // launcher's bytes; this companion is nullable because a receipt written before
  // FG-693 has no proven identity — and because canonicalReceiptProjectDir's lexical
  // fallback means some of those rows' recorded values are guesses, which is precisely
  // what a NULL here refuses to inherit.
  { table: "orchestrator_receipts", column: "project_dir_canonical", ddl: "ALTER TABLE orchestrator_receipts ADD COLUMN project_dir_canonical TEXT" },
];

// FG-693 — THE LOOKUP INDEXES THE CANONICAL COLUMNS NEED, declared as DATA for the
// same reason ADDITIVE_COLUMNS is: schema.ts owns the shape, db.ts owns the guarded,
// idempotent application, and the two cannot drift.
//
// WHY THEY ARE NOT IN SCHEMA_SQL, which is where a `CREATE INDEX IF NOT EXISTS` would
// otherwise belong. Every table below ALREADY EXISTS on an aged store, so its
// project_dir_canonical arrives by ALTER — from ADDITIVE_COLUMNS, inside applyMigrations,
// which runs AFTER db.ts has exec'd SCHEMA_SQL. A CREATE INDEX in SCHEMA_SQL naming a
// column the live table does not yet have throws SQLITE_ERROR, and SCHEMA_SQL is exec'd
// on EVERY writable open — so the index would brick every open of every aged store on
// the machine before the ALTER that adds its column could ever run. That is the FG-563
// hazard exactly (see the comment above `runs` in SCHEMA_SQL, and idx_model_calls_task
// in db.ts, which lives on the migration path for the identical reason).
//
// So these belong on the guarded migration path, AFTER the additive loop. They are
// deliberately NOT created from SCHEMA_SQL and they must NOT be moved there.
//
// They are also, deliberately, plain non-unique indexes: two DIFFERENT rows may share a
// canonical project dir (that is the normal case — many runs in one checkout), and NULL
// is the common value on aged rows.
//
// APPLIED FROM applyMigrations (src/store/db.ts), immediately after the additive-column
// loop, under that loop's two guards (table present, column present). Applying them there
// keeps
// fresh-vs-migrated parity intact, because fg608-migration-parity's strip runs against a
// SCHEMA_SQL-only database — the indexes do not exist yet at strip time, so the columns
// stay droppable and the guard's UNDROPPABLE set does not grow. Creating them from
// SCHEMA_SQL would both brick aged opens AND shrink that guard's coverage.
export type CanonicalIdentityIndex = { table: string; column: string; index: string; ddl: string };

export const CANONICAL_IDENTITY_INDEXES: CanonicalIdentityIndex[] = [
  {
    table: "runs",
    column: "project_dir_canonical",
    index: "idx_runs_project_canonical",
    ddl: "CREATE INDEX IF NOT EXISTS idx_runs_project_canonical ON runs(project_dir_canonical)",
  },
  {
    // FG-663: the same-project identity lookup. Rides the identical guarded, post-ALTER
    // application path as the FG-693 canonical indexes above (table present, column
    // present), so on an aged store it is created only after ADDITIVE_COLUMNS has added
    // runs.project_identity. Plain non-unique: many runs share one project identity, and
    // NULL is the common value on legacy rows. Backs the project-scoped identity arm the
    // dashboard reads add (FG-663 AC5).
    table: "runs",
    column: "project_identity",
    index: "idx_runs_project_identity",
    ddl: "CREATE INDEX IF NOT EXISTS idx_runs_project_identity ON runs(project_identity)",
  },
  {
    table: "campaigns",
    column: "project_dir_canonical",
    index: "idx_campaigns_project_canonical",
    ddl: "CREATE INDEX IF NOT EXISTS idx_campaigns_project_canonical ON campaigns(project_dir_canonical)",
  },
  {
    // Mirrors idx_host_verifications_lookup's column ORDER with the canonical dir in
    // place of the as-written one, so the covering-evidence lookup keeps an indexed
    // probe and ticket_id stays a usable prefix for the legacy NULL-canonical scan.
    table: "host_verifications",
    column: "project_dir_canonical",
    index: "idx_host_verifications_canonical_lookup",
    ddl:
      "CREATE INDEX IF NOT EXISTS idx_host_verifications_canonical_lookup " +
      "ON host_verifications(ticket_id, project_dir_canonical, commit_sha, gate_name)",
  },
  {
    // Mirrors idx_orchestrator_receipts_project, which is (project_dir, created_at).
    table: "orchestrator_receipts",
    column: "project_dir_canonical",
    index: "idx_orchestrator_receipts_project_canonical",
    ddl:
      "CREATE INDEX IF NOT EXISTS idx_orchestrator_receipts_project_canonical " +
      "ON orchestrator_receipts(project_dir_canonical, created_at)",
  },
  {
    // Mirrors idx_launch_observations_project.
    table: "launch_observations",
    column: "project_dir_canonical",
    index: "idx_launch_observations_project_canonical",
    ddl:
      "CREATE INDEX IF NOT EXISTS idx_launch_observations_project_canonical " +
      "ON launch_observations(project_dir_canonical)",
  },
  {
    // FG-731: mirrors idx_ci_waits_project (project_dir) with the canonical dir. ci_waits
    // is a whole-new table, so on a real store the column arrives with the CREATE rather
    // than an ALTER — but the guarded apply path is identical (table present, column
    // present), and pairing the canonical column with its index keeps the FG-693
    // one-ALTER-one-index invariant whole for it too.
    table: "ci_waits",
    column: "project_dir_canonical",
    index: "idx_ci_waits_project_canonical",
    ddl:
      "CREATE INDEX IF NOT EXISTS idx_ci_waits_project_canonical " +
      "ON ci_waits(project_dir_canonical)",
  },
];
