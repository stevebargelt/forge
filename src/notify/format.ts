// Pure SMS body formatting for forge notifications. No env, no network.
// Target: a single Twilio SMS segment (160 chars). Long workflow titles get
// truncated rather than overflowing into a second segment.

import type { Run } from "../types/index.js";

export type NotifyState =
  | "complete"
  | "failed"
  | "blocked_by_red"
  | "awaiting_gate";

const MAX_SMS_LEN = 160;

// Leading "<project>: " segment so a notification says which project it's
// about up front. Derived from the run's projectDir basename; omitted when the
// run has no projectDir. Pure string work — no node:path import.
function projectSegment(run: Run): string {
  if (!run.projectDir) return "";
  const base = run.projectDir.replace(/\/+$/, "").split("/").pop();
  return base ? `${base}: ` : "";
}

// WALK-4: optional failure/action detail folded into a run notification so the
// push answers "what happened and what do I do next" without opening a terminal.
// Kept compact (one SMS segment); the title absorbs truncation. `taskId` is the
// task to act on (the failed task, or the red-blocked task); `failureKind` names
// the failure when known.
export type FailureDetail = { taskId: string; failureKind?: string };

// FG-464: the operator-action model. Every run notification answers "is this on
// ME, and what do I do next". `actionable:false` states are FYI (no action);
// actionable states carry a short label. Kept terse for a one-segment SMS.
export type NotifyAction = { actionable: boolean; label: string };

export function actionForState(state: NotifyState): NotifyAction {
  switch (state) {
    case "complete":      return { actionable: false, label: "no action" };
    case "failed":        return { actionable: true, label: "inspect failure" };
    case "blocked_by_red": return { actionable: true, label: "review red" };
    case "awaiting_gate": return { actionable: true, label: "review gate" };
  }
}

// FG-464: the campaign/ticket context an operator needs to know WHERE a push
// belongs, pulled from run.metadata when present (FG-433 populates ticketId on
// campaign-created runs). Degrades to "" when nothing is recorded.
function contextSegment(run: Run): string {
  const meta = (run.metadata ?? {}) as { ticketId?: unknown; campaignId?: unknown };
  const bits: string[] = [];
  if (typeof meta.ticketId === "string" && meta.ticketId) bits.push(meta.ticketId);
  if (typeof meta.campaignId === "string" && meta.campaignId) bits.push(`campaign ${meta.campaignId}`);
  return bits.length > 0 ? `${bits.join(" ")} ` : "";
}

export function formatRunNotification(
  run: Run,
  state: NotifyState,
  durationMs?: number,
  actionTask?: FailureDetail,
): string {
  const bits: string[] = [];
  if (durationMs !== undefined) bits.push(formatDuration(durationMs));
  // FG-464: the action segment — what to do next, keyed by state. A failure names
  // the kind + the task to inspect; a red-block names the task to review; a clean
  // finish is explicitly "no action" so a non-actionable push is unmistakable at a
  // glance. `actionTask` carries the task to act on (the failed task, or the
  // red-blocked task); the STATE — not its presence — decides which framing.
  if (state === "blocked_by_red") {
    bits.push(`review red${actionTask ? ` → forge show ${actionTask.taskId}` : ""}`);
  } else if (actionTask !== undefined || state === "failed") {
    const kind = actionTask?.failureKind ?? "failed";
    bits.push(`inspect failure: ${kind}${actionTask ? ` → forge show ${actionTask.taskId}` : ""}`);
  } else if (state === "awaiting_gate") {
    bits.push("review gate");
  } else {
    bits.push("no action");
  }
  const titleQuoted = `"${run.title.replaceAll('"', "'")}"`;
  const prefix = `forge: ${projectSegment(run)}${contextSegment(run)}${run.id} [${state}] ${run.workflow} `;
  const suffix = bits.length > 0 ? ` — ${bits.join(" · ")}` : "";

  // If everything fits, emit as-is.
  const full = `${prefix}${titleQuoted}${suffix}`;
  if (full.length <= MAX_SMS_LEN) return full;

  // Truncate the title to fit. Reserve 3 chars for "..." inside the quotes.
  const budget = MAX_SMS_LEN - prefix.length - suffix.length - 2 /* quotes */ - 3 /* ellipsis */;
  if (budget <= 0) {
    // Pathological: even with empty title we're over budget. Drop the title.
    return `${prefix.trimEnd()}${suffix}`.slice(0, MAX_SMS_LEN);
  }
  const truncated = `"${run.title.slice(0, budget)}..."`;
  return `${prefix}${truncated}${suffix}`;
}

// Gate / human-input notifications carry the actionable bit: which task is
// blocked on you and the command to clear it. Same 160-char SMS budget; the
// title is what gets truncated.
export function formatGateNotification(
  run: Run,
  taskId: string,
  phase: string,
  state: NotifyState = "awaiting_gate",
): string {
  const label = "gate";
  const prefix = `forge: ${projectSegment(run)}${run.workflow} `;
  const suffix = ` — ${phase} ${label}: forge gate ${taskId}`;
  const full = `${prefix}"${run.title.replaceAll('"', "'")}"${suffix}`;
  if (full.length <= MAX_SMS_LEN) return full;
  const budget = MAX_SMS_LEN - prefix.length - suffix.length - 2 /* quotes */ - 3 /* ellipsis */;
  if (budget <= 0) return `${prefix.trimEnd()}${suffix}`.slice(0, MAX_SMS_LEN);
  return `${prefix}"${run.title.slice(0, budget)}..."${suffix}`;
}

// ----- Subscription flow SMS bodies (#145) -----
//
// All three include "Reply STOP to opt out" per A2P 10DLC best practice.
// All three stay well under 160 chars (one SMS segment).

export function subscribeRequestBody(code: string): string {
  return `forge: confirm subscription with: forge notify confirm ${code}. Code expires in 10 min. Reply STOP to opt out.`;
}

export function subscribeConfirmedBody(): string {
  return `forge: subscribed. You'll be notified on workflow completion. Reply STOP to opt out.`;
}

export function unsubscribeBody(): string {
  return `forge: unsubscribed. No more messages.`;
}

// Used internally + by trigger.ts when computing elapsed run time.
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}
