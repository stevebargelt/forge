import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { DB_PATH, briefPromptHostPath } from "../util/paths.js";
import { SCHEMA_SQL } from "../store/schema.js";
import type { Run, Task, RunStatus, WorkflowName, TaskStatus, TaskPackage } from "../types/index.js";
import type { VerdictRow, Finding, RedAuthority } from "../types/index.js";
import type { GateRow } from "../store/gates.js";
import type { GateDecision } from "../types/index.js";
import { loadWorkflow } from "../spine/workflows.js";
import { buildPhaseShape, type PhaseShape } from "./phaseShape.js";

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

export async function getRunWithShouldPoll(
  id: string
): Promise<{ run: Run; tasks: Task[]; verdicts: Record<string, VerdictRow[]>; phaseShape: PhaseShape[]; shouldPoll: boolean } | undefined> {
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

  // Phase shape — workflow definition + per-phase task aggregates. Loaded
  // every request because workflow files are TS imports that Node caches in
  // memory after first import; cost is one Map lookup, not a re-parse.
  // Wrapped in try/catch because a workflow rename could leave a run pointing
  // at an unknown workflow name; the dashboard should still render the run
  // (just without the pill row) rather than 500.
  let phaseShape: PhaseShape[] = [];
  try {
    const wf = await loadWorkflow(run.workflow);
    phaseShape = buildPhaseShape(wf, tasks);
  } catch {
    // Fall through with empty phaseShape — client renders zero pills.
  }

  const shouldPoll = tasks.some((t) => t.status === "running");

  return { run, tasks, verdicts, phaseShape, shouldPoll };
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

// #94 — distinguish gate-rejected failures from crashes/agent errors. A task
// rejected by the human via gate has a gate row with decision='reject' AND
// the task's status flipped to failed; retry would re-run the same agent and
// reproduce the rejected output. Other failure modes (container crash, agent
// error, validation failure) are valid retry targets.
export type FailureMode = "rejected" | "crashed_or_agent_error";

export function getTaskDetail(
  id: string
): {
  task: Task;
  verdicts: VerdictRow[];
  gates: GateRow[];
  briefContext?: BriefContext;
  failureMode?: FailureMode;
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

  // Derive failureMode for failed tasks. If any gate row on this task is a
  // reject decision, the task failed by human gate-reject. Otherwise crash /
  // agent error / validation failure.
  let failureMode: FailureMode | undefined;
  if (task.status === "failed") {
    failureMode = gates.some((g) => g.decision === "reject") ? "rejected" : "crashed_or_agent_error";
  }

  // briefContext serves two surfaces:
  //   (1) awaiting_human_input review task — load the upstream brief's PROMPT.md
  //       so the human can read it before going to run Pencil
  //   (2) awaiting_gate brief task — load THIS task's PROMPT.md so the human
  //       can review the prompt before gating advance
  // (2) is the more common case in practice — every brief-phase task lands
  // awaiting_gate first; only design workflows ever have an awaiting_human_input
  // task that depends on an upstream brief.
  let briefContext: BriefContext | undefined;
  if (task.status === "awaiting_human_input") {
    briefContext = loadBriefContext(task);
  } else if (task.status === "awaiting_gate" && task.phase === "brief") {
    briefContext = loadBriefContextForCurrentTask(task);
  }

  return { task, verdicts, gates, briefContext, failureMode };
}

// Load PROMPT.md for the current task (the one being gated). Used when a
// brief-phase task is awaiting_gate — the prompt-author wrote PROMPT.md and
// the human needs to read it to decide whether to advance.
function loadBriefContextForCurrentTask(task: Task): BriefContext | undefined {
  const promptPathHost = briefPromptHostPath(task.runId, task.id);
  let promptMarkdown: string | undefined;
  if (existsSync(promptPathHost)) {
    try {
      promptMarkdown = readFileSync(promptPathHost, "utf8");
    } catch {
      // tolerate read failures — surface what we have, html.ts handles absent
    }
  }

  const runRow = db()
    .prepare(`SELECT metadata FROM runs WHERE id = ?`)
    .get(task.runId) as { metadata: string | null } | undefined;
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
    briefTaskId: task.id,
    briefResult: task.result,
    promptMarkdown,
    promptPathHost,
    designDir,
  };
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
