import type { Command } from "commander";
import { getTask } from "../../store/tasks.js";
import { getRun } from "../../store/runs.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { getDb } from "../../store/db.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { eventsForTask, eventsForRun } from "../../store/events.js";
import type { Event } from "../../store/events.js";
import type { Task, Run, VerdictRow } from "../../types/index.js";

export type ShowResult =
  | { kind: "task"; task: Task; verdicts: VerdictRow[]; events: Event[] }
  | { kind: "run"; run: Run; events: Event[] }
  | { kind: "not-found"; id: string };

export function performShow(id: string): ShowResult {
  const task = getTask(id);
  if (task) {
    return { kind: "task", task, verdicts: verdictsForTask(task.id), events: eventsForTask(id) };
  }
  const run = getRun(id);
  if (run) {
    return { kind: "run", run, events: eventsForRun(id) };
  }
  return { kind: "not-found", id };
}

function fmtTime(iso: string): string {
  return iso.slice(11, 19);
}

function payloadSummary(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return ` — ${payload.slice(0, 60)}`;
  if (typeof payload === "object") {
    const keys = Object.keys(payload as Record<string, unknown>);
    if (keys.length === 0) return "";
    return ` — {${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return ` — ${String(payload).slice(0, 60)}`;
}

function printTimeline(events: Event[]): void {
  console.log("");
  console.log("Timeline:");
  if (events.length === 0) {
    console.log("  (no events)");
    return;
  }
  for (const e of events) {
    const taskPart = e.taskId ? `  [task:${e.taskId}]` : "";
    console.log(`  ${fmtTime(e.createdAt)}  ${e.eventType}${taskPart}${payloadSummary(e.payload)}`);
  }
}

export function registerShow(program: Command): void {
  program
    .command("show")
    .argument("<id>", "task or run identifier")
    .description("Show full details of a task or run: package, result, verdicts, timeline")
    .option("--json", "emit JSON instead of human-readable output")
    .action((id: string, opts: { json?: boolean }) => {
      ensureForgeDirs();
      // Open the DB read-only so a concurrent `forge next` can't be blocked by us.
      getDb({ readOnly: true });
      const result = performShow(id);

      if (result.kind === "not-found") {
        throw new Error(`Not found: ${id}`);
      }

      if (result.kind === "task") {
        const { task, verdicts, events } = result;

        if (opts.json) {
          console.log(JSON.stringify({ task, events }, null, 2));
          return;
        }

        console.log(`Task ${task.id}`);
        console.log(`  run:    ${task.runId}`);
        console.log(`  phase:  ${task.phase} (${task.agentRole})`);
        console.log(`  status: ${task.status}`);
        console.log(`  parent: ${task.parentId ?? "(none)"}`);
        console.log(`  created: ${task.createdAt}`);
        if (task.startedAt) console.log(`  started: ${task.startedAt}`);
        if (task.completedAt) console.log(`  completed: ${task.completedAt}`);
        if (task.error) console.log(`  error:   ${task.error}`);
        console.log("");
        console.log("Inputs:");
        console.log(JSON.stringify(task.taskPackage.inputs, null, 2));
        if (task.result) {
          console.log("");
          console.log("Result:");
          console.log(JSON.stringify(task.result, null, 2));
        }
        if (verdicts.length > 0) {
          console.log("");
          console.log("Verdicts:");
          for (const v of verdicts) {
            console.log(
              `  - ${v.redRole} (${v.authority}): ${v.verdict} (${v.confidence.toFixed(2)})`
            );
            for (const f of v.findings) {
              console.log(`      [${f.severity}] ${f.summary}`);
            }
          }
        }
        printTimeline(events);
        return;
      }

      // kind === "run"
      const { run, events } = result;

      if (opts.json) {
        console.log(JSON.stringify({ run, events }, null, 2));
        return;
      }

      console.log(`Run ${run.id}`);
      console.log(`  workflow: ${run.workflow}`);
      console.log(`  status:   ${run.status}`);
      console.log(`  project:  ${run.projectDir ?? "(none)"}`);
      console.log(`  created:  ${run.createdAt}`);
      if (run.completedAt) console.log(`  completed: ${run.completedAt}`);
      printTimeline(events);
    });
}
