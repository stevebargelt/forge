import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRun } from "../../store/runs.js";
import { tasksForRun, getTask } from "../../store/tasks.js";
import { verdictsForRun, verdictsForTask } from "../../store/verdicts.js";
import { gatesForTask } from "../../store/gates.js";
import { loadWorkflowWithSource } from "../../v2/loader.js";
import { readTaskManifest } from "../../v2/task-manifest.js";
import { redactGraph } from "../../v2/config-graph.js";
import type { ConfigGraph } from "../../v2/config-graph-types.js";
import { taskDir } from "../../util/paths.js";
import { buildRunMap, type RunMapVerdict } from "../../v2/run-map.js";
import { buildTaskExplain } from "../../v2/task-explain.js";
import type { ArtifactRef, RunMapGraph, TaskExplain } from "../../v2/run-explain-types.js";
import type { Workflow } from "../../v2/schema.js";

// `forge explain run <runId> --json` / `forge explain task <taskId> --json` — the
// read-only Run Map + task-level Explain surface for the orchestrator. The JSON is
// buildRunMap / buildTaskExplain output printed UNMODIFIED (byte-identical with the
// in-process dashboard queries, which call the same pure builders and route through
// the same redaction boundary). Human-readable output is a thin secondary renderer
// of the same object. Never writes, never spawns an agent, never runs a subprocess.

/** The same redaction boundary buildConfigGraph rides: blank any secret-looking
 *  string anywhere in the payload before it leaves the process. Reused verbatim
 *  (not re-expressed) so the run-map/explain payloads and the config graph cannot
 *  redact differently. */
function redact<T>(payload: T): T {
  return redactGraph(payload as unknown as ConfigGraph) as unknown as T;
}

/** Load the run's workflow tolerantly: an unresolvable name yields undefined
 *  rather than throwing, so a legacy/renamed workflow degrades to an
 *  execution-only graph. */
function tolerantWorkflow(name: string, projectDir?: string): { workflow?: Workflow; source?: "host" | "project" } {
  try {
    const loaded = loadWorkflowWithSource(name, projectDir ? { projectDir } : {});
    return { workflow: loaded, source: loaded.source };
  } catch {
    return {};
  }
}

/** Gather a run's rows + workflow and build the RunMapGraph. Exported so the
 *  byte-identity with the dashboard query (both return buildRunMap unreshaped) is
 *  a property of one shared builder, not two hand-kept-in-sync projections. */
export function explainRunGraph(runId: string): RunMapGraph {
  const run = getRun(runId);
  if (!run) throw new Error(`run '${runId}' not found`);
  const tasks = tasksForRun(runId);
  const verdicts: RunMapVerdict[] = verdictsForRun(runId).map((v) => ({
    taskId: v.taskId,
    redTaskId: v.redTaskId,
    redRole: v.redRole,
  }));
  const { workflow, source } = tolerantWorkflow(run.workflow, run.projectDir);
  const graph = buildRunMap({
    run,
    tasks,
    verdicts,
    ...(workflow ? { workflow } : {}),
    ...(source ? { workflowSource: source } : {}),
  });
  return redact(graph);
}

/** Gather one task's rows + manifest and build the TaskExplain. */
export function explainTaskGraph(taskId: string): TaskExplain {
  const task = getTask(taskId);
  if (!task) throw new Error(`task '${taskId}' not found`);
  const run = getRun(task.runId);
  const dir = taskDir(task.runId, taskId);
  const manifest = readTaskManifest(dir);
  // Same artifact-availability the dashboard query (taskExplain) supplies, so the
  // shared builder produces byte-identical output on both surfaces (FG-348 AC5).
  // Absent, the builder derives a result-only list and the CLI diverges from the
  // dashboard, which probes all four.
  const artifacts: ArtifactRef[] = [
    { kind: "result", name: "result.json", available: task.result !== undefined && task.result !== null },
    { kind: "stdout", name: "container.stdout.log", available: existsSync(join(dir, "container.stdout.log")) },
    { kind: "stderr", name: "container.stderr.log", available: existsSync(join(dir, "container.stderr.log")) },
    { kind: "manifest", name: "manifest.json", available: manifest !== undefined },
  ];
  const gates = gatesForTask(taskId).map((g) => ({
    decision: g.decision,
    rationale: g.rationale ?? null,
    decidedBy: g.decidedBy,
    decidedAt: g.decidedAt,
  }));
  const verdicts = verdictsForTask(taskId).map((v) => ({
    redTaskId: v.redTaskId,
    redRole: v.redRole,
    verdict: v.verdict,
    confidence: v.confidence,
    authority: v.authority,
    findings: v.findings,
  }));
  const gateType = run ? gateTypeForTask(run.workflow, run.projectDir, task.phase) : undefined;
  const explain = buildTaskExplain({
    task,
    gates,
    verdicts,
    ...(manifest ? { manifest } : {}),
    ...(gateType ? { gateType } : {}),
    artifacts,
  });
  return redact(explain);
}

/** The gate type declared by the workflow step backing a task's phase, or
 *  undefined when the workflow can't be resolved. */
function gateTypeForTask(workflowName: string, projectDir: string | undefined, phase: string): string | undefined {
  const { workflow } = tolerantWorkflow(workflowName, projectDir);
  return workflow?.steps.find((s) => s.id === phase)?.gate;
}

function renderRunMapHuman(graph: RunMapGraph): string {
  const lines: string[] = [];
  lines.push(`# forge run map (v${graph.version})`);
  lines.push(`# run: ${graph.run.runId} — ${graph.run.title} [${graph.run.status}]`);
  lines.push(`# workflow: ${graph.run.workflow}${graph.workflowResolved ? "" : " (unresolved — inferred labels)"}`);
  for (const w of graph.warnings) lines.push(`# ⚠ ${w}`);
  lines.push("");
  lines.push("## Phases");
  for (const p of graph.phases) {
    const deps = p.dependsOn.length ? ` ← ${p.dependsOn.join(", ")}` : "";
    const flags = [p.fanout ? "fanout" : "", p.manual ? "manual" : "", p.inferred ? "inferred" : ""].filter(Boolean).join(",");
    lines.push(`  ${p.id}${p.role ? ` (${p.role})` : ""} gate=${p.gate ?? "?"}${flags ? ` [${flags}]` : ""}${deps}`);
  }
  lines.push("");
  lines.push("## Tasks");
  for (const n of graph.nodes) {
    const badge = n.model?.alias ?? n.model?.model ?? "";
    lines.push(`  ${n.taskId} ${n.role} [${n.status}] ${n.lineage}${badge ? ` model=${badge}` : ""}`);
  }
  if (graph.fanoutGroups.length) {
    lines.push("");
    lines.push("## Fanout groups");
    for (const g of graph.fanoutGroups) lines.push(`  ${g.phase}: ${g.count} children`);
  }
  if (graph.redAttachments.length) {
    lines.push("");
    lines.push("## Reds");
    for (const a of graph.redAttachments) lines.push(`  ${a.redRole} (${a.redTaskId}) → ${a.primaryTaskId} [via ${a.via}]`);
  }
  return lines.join("\n");
}

function renderTaskExplainHuman(explain: TaskExplain): string {
  const lines: string[] = [];
  lines.push(`# forge explain task (v${explain.version})`);
  lines.push(`# task: ${explain.taskId} — ${explain.role} [${explain.status}]`);
  for (const w of explain.warnings) lines.push(`# ⚠ ${w}`);
  lines.push("");
  if (explain.workflowSource) lines.push(`workflow source: ${explain.workflowSource.name ?? "?"} [${explain.workflowSource.source ?? explain.workflowSource.status}]`);
  if (explain.modelResolution) lines.push(`model: ${explain.modelResolution.alias ?? "?"} → ${explain.modelResolution.model ?? "?"} [${explain.modelResolution.status}]`);
  if (explain.runtime) lines.push(`runtime: ${explain.runtime.name ?? "?"} (${explain.runtime.kind ?? "?"}) [${explain.runtime.status}]`);
  if (explain.mountMode) lines.push(`mount: ${explain.mountMode.mountMode ?? "?"} ${explain.mountMode.projectDir ?? ""} [${explain.mountMode.status}]`);
  if (explain.gate) lines.push(`gate: ${explain.gate.gateType ?? "?"} — ${explain.gate.decisions.length} decision(s)`);
  if (explain.reds) lines.push(`reds: ${explain.reds.reds.length}`);
  if (explain.upstream) lines.push(`upstream inputs: ${explain.upstream.inputs.map((i) => i.key).join(", ") || "none"}`);
  if (explain.artifacts) lines.push(`artifacts: ${explain.artifacts.filter((a) => a.available).map((a) => a.kind).join(", ") || "none"}`);
  return lines.join("\n");
}

export function registerExplain(program: Command): void {
  const explain = program
    .command("explain")
    .description("Read-only Run Map + task-level Explain (why Forge ran a task this way). Never writes or spawns.");

  explain
    .command("run <runId>")
    .option("--json", "emit the structured run map as JSON")
    .description("Visualize a run's workflow/execution graph: phases, fanout, reds, gates, per-task control-plane badges.")
    .action((runId: string, opts: { json?: boolean }) => {
      const graph = explainRunGraph(runId);
      console.log(opts.json ? JSON.stringify(graph, null, 2) : renderRunMapHuman(graph));
    });

  explain
    .command("task <taskId>")
    .option("--json", "emit the structured task explain as JSON")
    .description("Explain one task's recorded control-plane provenance: workflow source, model, runtime/auth, mount, gate, reds, inputs, warnings.")
    .action((taskId: string, opts: { json?: boolean }) => {
      const explainOut = explainTaskGraph(taskId);
      console.log(opts.json ? JSON.stringify(explainOut, null, 2) : renderTaskExplainHuman(explainOut));
    });
}
