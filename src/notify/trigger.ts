// Glue layer: composes format + twilio, applies the transition filter from
// FORGE_NOTIFY_ON, and fires the SMS. Never throws — notification failures
// must not crash a forge run. Surfaces failures via console.error so the
// human sees them without forge crashing.

import type { Run, Task } from "../types/index.js";
import { formatRunNotification, formatGateNotification, type NotifyState } from "./format.js";
import { isTwilioEnabled, notifyTwilio } from "./twilio.js";
import { isNtfyEnabled, notifyNtfy } from "./ntfy.js";

const DEFAULT_NOTIFY_ON = new Set<NotifyState>([
  "complete",
  "failed",
  "blocked_by_red",
  "awaiting_gate",
  "awaiting_human_input",
]);

// Maps the run.status / task.status value to the NotifyState used in the
// SMS body. Returns null for transitions we don't notify on (e.g. "active").
function statusToNotifyState(status: string): NotifyState | null {
  if (status === "complete") return "complete";
  if (status === "abandoned") return "failed";
  if (status === "blocked_by_red") return "blocked_by_red";
  if (status === "awaiting_gate") return "awaiting_gate";
  if (status === "awaiting_human_input") return "awaiting_human_input";
  return null;
}

function parseNotifyOn(): Set<NotifyState> {
  const raw = process.env["FORGE_NOTIFY_ON"];
  if (!raw || raw.trim().length === 0) return DEFAULT_NOTIFY_ON;
  const valid: NotifyState[] = [
    "complete",
    "failed",
    "blocked_by_red",
    "awaiting_gate",
    "awaiting_human_input",
  ];
  const filter = new Set<NotifyState>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if ((valid as readonly string[]).includes(trimmed)) {
      filter.add(trimmed as NotifyState);
    }
  }
  return filter.size > 0 ? filter : DEFAULT_NOTIFY_ON;
}

function computeDurationMs(run: Run): number | undefined {
  if (!run.completedAt) return undefined;
  const start = new Date(run.createdAt).getTime();
  const end = new Date(run.completedAt).getTime();
  if (isNaN(start) || isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function isAnyProviderEnabled(): boolean {
  return isTwilioEnabled() || isNtfyEnabled();
}

async function dispatch(body: string, title?: string): Promise<void> {
  if (isTwilioEnabled()) {
    const result = await notifyTwilio(body);
    if (!result.ok) console.error(`forge notify: SMS failed — ${result.error}`);
  }
  if (isNtfyEnabled()) {
    const result = await notifyNtfy(body, title);
    if (!result.ok) console.error(`forge notify: ntfy failed — ${result.error}`);
  }
}

export async function notifyOnRunTransition(
  run: Run,
  newStatus: string,
  previousStatus?: string,
): Promise<void> {
  if (!isAnyProviderEnabled()) return;

  // Idempotent re-saves: same-status writes shouldn't double-notify.
  if (previousStatus !== undefined && newStatus === previousStatus) return;

  const state = statusToNotifyState(newStatus);
  if (state === null) return;

  const filter = parseNotifyOn();
  if (!filter.has(state)) return;

  const body = formatRunNotification(run, state, computeDurationMs(run));
  await dispatch(body, `forge: ${run.workflow} [${state}]`);
}

export async function notifyOnTaskBlockedByRed(run: Run): Promise<void> {
  if (!isAnyProviderEnabled()) return;

  const filter = parseNotifyOn();
  if (!filter.has("blocked_by_red")) return;

  const body = formatRunNotification(run, "blocked_by_red");
  await dispatch(body, `forge: ${run.workflow} [blocked_by_red]`);
}

// Fired when a task pauses for a human/verdict gate (or human input). This is
// the "forge is blocked on you" signal — carries the task id + `forge gate`
// command so the push tells you exactly what to act on.
export async function notifyOnGateAwaiting(run: Run, task: Task): Promise<void> {
  if (!isAnyProviderEnabled()) return;

  const state: NotifyState =
    task.status === "awaiting_human_input" ? "awaiting_human_input" : "awaiting_gate";

  const filter = parseNotifyOn();
  if (!filter.has(state)) return;

  const body = formatGateNotification(run, task.id, task.phase, state);
  await dispatch(body, `forge: ${run.workflow} [${state}]`);
}
