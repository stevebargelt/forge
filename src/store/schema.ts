// SQLite schema, exactly as specified in the spine sketch. One-time migration.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  metadata        TEXT,
  project_dir     TEXT
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
  -- FG-351: per-task git worktree path. Null when worktree mode is disabled (default).
  -- Set BEFORE runContainer and readable after process restart. Task branch identity
  -- is deterministically derived as forge/<runId>/<taskId> — no separate DB column needed.
  worktree_path     TEXT
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
  project_dir         TEXT
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
  ci_url      TEXT
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
  PRIMARY KEY (project_key, ticket_id)
);

-- Ticket events — append-shaped audit, keyed by (project_key, ticket_id). A
-- deterministic natural id (event_key) makes re-import idempotent: the same
-- logical event UPSERTs rather than duplicating. The composite FK to tickets
-- forbids orphan/cross-project event rows; ON DELETE CASCADE prunes an event when
-- its owning ticket is removed (the reconcile removal path relies on it).
CREATE TABLE IF NOT EXISTS ticket_events (
  event_key   TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket
  ON ticket_events(project_key, ticket_id);

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
CREATE TABLE IF NOT EXISTS blocker_evidence (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  reason      TEXT,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (project_key, ticket_id, source),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_blocker_evidence_ticket
  ON blocker_evidence(project_key, ticket_id);
`;
