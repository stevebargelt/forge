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
  created_at      TEXT NOT NULL
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
`;
