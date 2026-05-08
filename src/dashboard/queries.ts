import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { DB_PATH, briefPromptHostPath } from "../util/paths.js";
import { SCHEMA_SQL } from "../store/schema.js";
import type { Run, Task, RunStatus, WorkflowName, TaskStatus, TaskPackage } from "../types/index.js";
import type { VerdictRow, Finding, RedAuthority } from "../types/index.js";
import type { GateRow } from "../store/gates.js";
import type { GateDecision } from "../types/index.js";

let _db: DatabaseInstance | null = null;

function db(): DatabaseInstance {
  if (!_db) _db = new Database(DB_PATH, { readonly: true });
  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

// Test seam: replace the singleton with a test DB.
export function setQueryDbForTest(testDb: DatabaseInstance): void {
  _db = testDb;
}

type RunRow = {
  id: string;
  workflow: string;
  title: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  metadata: string | null;
  project_dir: string | null;
};

type TaskRow = {
  id: string;
  run_id: string;
  parent_id: string | null;
  phase: string;
  agent_role: string;
  agent_alias: string | null;
  agent_model: string | null;
  status: string;
  task_package: string;
  result: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
};

type VerdictDbRow = {
  id: string;
  task_id: string;
  red_task_id: string;
  red_role: string;
  verdict: string;
  confidence: number;
  authority: string;
  findings: string;
  created_at: string;
};

type GateDbRow = {
  id: string;
  task_id: string;
  decision: string;
  rationale: string | null;
  decided_at: string;
  decided_by: string;
};

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    workflow: row.workflow as WorkflowName,
    title: row.title,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    projectDir: row.project_dir ?? undefined,
  };
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id ?? undefined,
    phase: row.phase,
    agentRole: row.agent_role,
    agentAlias: row.agent_alias ?? undefined,
    agentModel: row.agent_model ?? undefined,
    status: row.status as TaskStatus,
    taskPackage: JSON.parse(row.task_package) as TaskPackage,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function rowToVerdict(row: VerdictDbRow): VerdictRow {
  return {
    id: row.id,
    taskId: row.task_id,
    redTaskId: row.red_task_id,
    redRole: row.red_role,
    verdict: row.verdict as VerdictRow["verdict"],
    confidence: row.confidence,
    authority: row.authority as RedAuthority,
    findings: JSON.parse(row.findings) as Finding[],
    createdAt: row.created_at,
  };
}

function rowToGate(row: GateDbRow): GateRow {
  return {
    id: row.id,
    taskId: row.task_id,
    decision: row.decision as GateDecision,
    rationale: row.rationale ?? undefined,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function listRunsForDashboard(): (Run & { taskCount: number })[] {
  const rows = db()
    .prepare(
      `SELECT runs.*, (SELECT COUNT(*) FROM tasks WHERE tasks.run_id = runs.id) AS task_count
       FROM runs
       ORDER BY runs.created_at DESC`
    )
    .all() as (RunRow & { task_count: number })[];
  return rows.map((r) => ({ ...rowToRun(r), taskCount: r.task_count ?? 0 }));
}

export function getRunWithShouldPoll(
  id: string
): { run: Run; tasks: Task[]; verdicts: Record<string, VerdictRow[]>; shouldPoll: boolean } | undefined {
  const runRow = db().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  if (!runRow) return undefined;

  const run = rowToRun(runRow);
  const taskRows = db()
    .prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC`)
    .all(id) as TaskRow[];
  const tasks = taskRows.map(rowToTask);

  const verdicts: Record<string, VerdictRow[]> = {};
  for (const task of tasks) {
    const vRows = db()
      .prepare(`SELECT * FROM verdicts WHERE task_id = ? ORDER BY created_at ASC`)
      .all(task.id) as VerdictDbRow[];
    verdicts[task.id] = vRows.map(rowToVerdict);
  }

  const shouldPoll = tasks.some((t) => t.status === "running");

  return { run, tasks, verdicts, shouldPoll };
}

// Context for an awaiting_human_input review task: the upstream brief task's
// captured output (parameters, openQuestions, notes) plus the literal PROMPT.md
// the prompt-author wrote, read from the brief task's host workspace. The
// dashboard renders this so the human can review the prompt + status without
// leaving the browser tab.
export type BriefContext = {
  briefTaskId: string;
  briefResult?: unknown; // the prompt-author's structured result
  promptMarkdown?: string; // PROMPT.md contents (may be missing if file isn't there)
  promptPathHost: string;
  designDir?: string;
};

export function getTaskDetail(
  id: string
): {
  task: Task;
  verdicts: VerdictRow[];
  gates: GateRow[];
  briefContext?: BriefContext;
} | undefined {
  const taskRow = db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  if (!taskRow) return undefined;

  const task = rowToTask(taskRow);

  const vRows = db()
    .prepare(`SELECT * FROM verdicts WHERE task_id = ? ORDER BY created_at ASC`)
    .all(id) as VerdictDbRow[];
  const verdicts = vRows.map(rowToVerdict);

  const gRows = db()
    .prepare(`SELECT * FROM gates WHERE task_id = ? ORDER BY decided_at ASC`)
    .all(id) as GateDbRow[];
  const gates = gRows.map(rowToGate);

  const briefContext = task.status === "awaiting_human_input"
    ? loadBriefContext(task)
    : undefined;

  return { task, verdicts, gates, briefContext };
}

// Find the most recent completed `brief` task in the same run and load its
// output + PROMPT.md from disk. Used to render the prompt body inline on the
// dashboard's awaiting_human_input detail screen so the human doesn't have to
// leave the browser to read it.
function loadBriefContext(reviewTask: Task): BriefContext | undefined {
  const briefRow = db()
    .prepare(
      `SELECT * FROM tasks WHERE run_id = ? AND phase = 'brief' AND status = 'complete'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(reviewTask.runId) as TaskRow | undefined;
  if (!briefRow) return undefined;

  const briefTask = rowToTask(briefRow);
  const promptPathHost = briefPromptHostPath(briefTask.runId, briefTask.id);
  let promptMarkdown: string | undefined;
  if (existsSync(promptPathHost)) {
    try {
      promptMarkdown = readFileSync(promptPathHost, "utf8");
    } catch {
      // tolerate read failures — surface what we have, html.ts copes with the absent case
    }
  }

  const runRow = db()
    .prepare(`SELECT metadata FROM runs WHERE id = ?`)
    .get(reviewTask.runId) as { metadata: string | null } | undefined;
  let designDir: string | undefined;
  if (runRow?.metadata) {
    try {
      const meta = JSON.parse(runRow.metadata) as { designDir?: unknown };
      if (typeof meta.designDir === "string") designDir = meta.designDir;
    } catch {
      // ignore malformed metadata
    }
  }

  return {
    briefTaskId: briefTask.id,
    briefResult: briefTask.result,
    promptMarkdown,
    promptPathHost,
    designDir,
  };
}
