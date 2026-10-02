// FG-808: after usage capture on a container dispatch, compare the model the task
// requested with the model(s) the provider reports having served, and record it.
// Shared by both dispatch paths (invoke.ts, runNext.ts) so they cannot disagree.

import { classifyServedModels, type ServedModelCheck } from "../store/model-calls.js";
import { eventsForTask, logEvent, type Event } from "../store/events.js";
import { readTaskManifest, writeTaskManifest, type TaskManifest } from "./task-manifest.js";

export function isServedModelMismatch(check: ServedModelCheck | undefined): boolean {
  return check?.classification === "switched" || check?.classification === "mixed";
}

/** Best-effort, like usage capture itself: a telemetry failure must never alter
 *  task semantics, so every error is swallowed. It also never fails a gate — the
 *  record is informational. */
export function recordServedModelCheck(args: {
  runId: string;
  taskId: string;
  taskDir: string;
  requestedModel: string | undefined;
}): ServedModelCheck | undefined {
  try {
    const check = classifyServedModels(args.taskId, args.requestedModel);
    if (check === undefined) return undefined;
    const manifest = readTaskManifest(args.taskDir);
    if (manifest !== undefined) writeTaskManifest(args.taskDir, { ...manifest, servedModel: check } as TaskManifest);
    // Exactly one mismatch event per task: a completion-path retry or re-entry re-records the manifest only.
    if (isServedModelMismatch(check) && modelMismatchForTask(args.taskId) === undefined) {
      logEvent("task.model_mismatch", { runId: args.runId, taskId: args.taskId, payload: check });
    }
    return check;
  } catch (e) {
    console.error(`forge: served-model check failed [task ${args.taskId}]: ${(e as Error).message}`);
    return undefined;
  }
}

/** The latest recorded mismatch on a task's event stream, or undefined. */
export function modelMismatchFromEvents(events: readonly Event[]): ServedModelCheck | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Event;
    if (e.eventType !== "task.model_mismatch") continue;
    const p = e.payload as ServedModelCheck | null;
    if (p && typeof p.requested === "string" && Array.isArray(p.servedModels)) return p;
  }
  return undefined;
}

export function modelMismatchForTask(taskId: string): ServedModelCheck | undefined {
  return modelMismatchFromEvents(eventsForTask(taskId));
}

/** "requested X, served Y ×n (p%), Z ×m (q%) (switched)", largest share first. */
export function describeServedModelCheck(check: ServedModelCheck): string {
  const served = check.servedModels
    .map((m) => `${m.model} ×${m.count} (${Math.round(m.share * 100)}%)`)
    .join(", ");
  return `requested ${check.requested}, served ${served} (${check.classification})`;
}
