import type {
  AgentRef,
  RedConfig,
  TaskPackage,
  Task,
  Verdict,
  Workflow,
  Phase,
  Run,
} from "../types/index.js";
import { spawn } from "./spawn.js";
import { composeSystemPrompt } from "./composeSystemPrompt.js";
import { filterConstraints, loadAllConstraints } from "./constraints.js";
import { getTask, insertTask, setTaskStatus, tasksForRunPhase } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { logEvent } from "../store/events.js";
import { newTaskId, newVerdictId, nowIso } from "../util/ids.js";

export type SpawnRedArgs = {
  blueTask: Task;
  redConfig: RedConfig;
  run: Run;
  workflow: Workflow;
  phase: Phase;
  projectDir: string;
};

// Spawn wide and/or narrow reds in parallel, write verdicts, set blocked_by_red on
// authoritative fail + gateOnVerdict, return the verdicts for caller use.
export async function spawnRed(args: SpawnRedArgs): Promise<Verdict[]> {
  const { blueTask, redConfig, run, workflow, phase, projectDir } = args;

  // Build force-constraint anti-prompts for this role/workflow/phase — narrow red sees them
  // as failureModes.
  const forceConstraints = filterConstraints(loadAllConstraints(), {
    role: blueTask.agentRole,
    workflow: workflow.name,
    phase: phase.name,
    level: "force",
  });
  const failureModes = forceConstraints
    .map((c) => c.antiPrompt)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const spec = upstreamPhaseOutput(workflow, phase, run.id);
  const artifact = blueTask.result ? JSON.stringify(blueTask.result, null, 2) : "(no blue result)";

  const launches: Promise<{ ref: AgentRef; verdict: Verdict; redTaskId: string }>[] = [];
  if (redConfig.wide) {
    launches.push(
      runOneRed({
        ref: redConfig.wide,
        run,
        workflow,
        phase,
        blueTask,
        artifact,
        spec,
        failureModes,
        projectDir,
      })
    );
  }
  if (redConfig.narrow) {
    launches.push(
      runOneRed({
        ref: redConfig.narrow,
        run,
        workflow,
        phase,
        blueTask,
        artifact,
        spec,
        failureModes,
        projectDir,
      })
    );
  }

  const results = redConfig.parallel
    ? await Promise.all(launches)
    : await sequentially(launches);

  const verdicts: Verdict[] = [];
  for (const r of results) {
    insertVerdict({
      id: newVerdictId(),
      taskId: blueTask.id,
      redTaskId: r.redTaskId,
      redRole: r.ref.role,
      verdict: r.verdict.verdict,
      confidence: r.verdict.confidence,
      authority: redConfig.authority,
      findings: r.verdict.findings,
      createdAt: nowIso(),
    });
    logEvent("verdict.received", {
      runId: run.id,
      taskId: blueTask.id,
      payload: { redRole: r.ref.role, verdict: r.verdict.verdict },
    });
    verdicts.push(r.verdict);
  }

  // blocked_by_red: authoritative fail + gateOnVerdict ⇒ block the gate automatically.
  if (
    redConfig.gateOnVerdict &&
    redConfig.authority === "authoritative" &&
    verdicts.some((v) => v.verdict === "fail")
  ) {
    setTaskStatus(blueTask.id, "blocked_by_red");
    logEvent("task.blocked_by_red", { runId: run.id, taskId: blueTask.id });
  } else {
    // Default after reds finish: blue moves to awaiting_gate (per state-transition spec).
    if (phase.gate !== "auto") {
      setTaskStatus(blueTask.id, "awaiting_gate");
    }
  }

  return verdicts;
}

async function sequentially<T>(promises: Promise<T>[]): Promise<T[]> {
  const out: T[] = [];
  for (const p of promises) out.push(await p);
  return out;
}

type RunOneRedArgs = {
  ref: AgentRef;
  run: Run;
  workflow: Workflow;
  phase: Phase;
  blueTask: Task;
  artifact: string;
  spec?: string;
  failureModes: string[];
  projectDir: string;
};

async function runOneRed(args: RunOneRedArgs): Promise<{
  ref: AgentRef;
  verdict: Verdict;
  redTaskId: string;
}> {
  const redTaskId = newTaskId(`red-${args.phase.name}`);
  const composed = composeSystemPrompt({
    role: args.ref.role,
    agentDir: args.ref.agentDir,
    run: args.run,
    workflow: args.workflow,
    phase: args.phase,
    taskPackageFraming:
      "# Output schema\n\nWrite to /task/result.json: {status:'complete'|'failed', verdict:'pass'|'fail'|'inconclusive', confidence: 0.0-1.0, findings: [{severity, summary, evidence, hypothesis}], notes?: string}",
  });
  const taskPackage: TaskPackage = {
    taskId: redTaskId,
    runId: args.run.id,
    phase: args.phase.name,
    role: args.ref.role,
    inputs: {},
    composedSystemPrompt: composed,
    artifact: args.artifact,
    spec: args.spec,
    failureModes: args.failureModes,
  };
  // Persist a row for the red task too, so the audit trail covers both blue and red.
  insertTask({
    id: redTaskId,
    runId: args.run.id,
    parentId: args.blueTask.id,
    phase: args.phase.name,
    agentRole: args.ref.role,
    status: "pending",
    taskPackage,
    createdAt: nowIso(),
  });
  logEvent("task.created", { runId: args.run.id, taskId: redTaskId });

  const result = await spawn({
    taskPackage,
    agentConfig: args.ref,
    projectDir: args.projectDir,
    readOnlyProject: true, // OS-level enforcement for red agents
  });

  const verdict = parseVerdict(result.output);
  return { ref: args.ref, verdict, redTaskId };
}

function parseVerdict(output: unknown): Verdict {
  const obj = (output ?? {}) as Record<string, unknown>;
  const verdict =
    obj.verdict === "pass" || obj.verdict === "fail" || obj.verdict === "inconclusive"
      ? obj.verdict
      : "inconclusive";
  const confidence =
    typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
      ? obj.confidence
      : 0.5;
  const findings = Array.isArray(obj.findings) ? (obj.findings as Verdict["findings"]) : [];
  return {
    verdict,
    confidence,
    findings,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
  };
}

function upstreamPhaseOutput(workflow: Workflow, phase: Phase, runId: string): string | undefined {
  const idx = workflow.phases.findIndex((p) => p.name === phase.name);
  if (idx <= 0) return undefined;
  const upstream = workflow.phases[idx - 1]!;
  const tasks = tasksForRunPhase(runId, upstream.name).filter((t) => t.status === "complete");
  if (tasks.length === 0) return undefined;
  return tasks
    .map((t) => `### ${t.id}\n\n\`\`\`json\n${JSON.stringify(t.result, null, 2)}\n\`\`\``)
    .join("\n\n");
}
