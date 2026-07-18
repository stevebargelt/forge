// Glue layer: composes format + twilio, applies the transition filter from
// FORGE_NOTIFY_ON, and fires the SMS. Never throws — notification failures
// must not crash a forge run. Surfaces failures via console.error so the
// human sees them without forge crashing.

import type { Run, Task } from "../types/index.js";
import { formatRunNotification, formatGateNotification, type NotifyState, type FailureDetail } from "./format.js";
import { isTwilioEnabled, notifyTwilio } from "./twilio.js";
import { isNtfyEnabled, notifyNtfy } from "./ntfy.js";
import { tasksForRun } from "../store/tasks.js";
import { failureKindForTask } from "../v2/failure-kind.js";

const DEFAULT_NOTIFY_ON = new Set<NotifyState>([
  "complete",
  "failed",
  "blocked_by_red",
  "awaiting_gate",
]);

// Maps the run.status / task.status value to the NotifyState used in the
// SMS body. Returns null for transitions we don't notify on (e.g. "active").
function statusToNotifyState(status: string): NotifyState | null {
  if (status === "complete") return "complete";
  if (status === "failed") return "failed";
  if (status === "abandoned") return "failed";
  if (status === "blocked_by_red") return "blocked_by_red";
  if (status === "awaiting_gate") return "awaiting_gate";
  // FG-425 (AC5): awaiting_recovery deliberately does NOT page. It is not a failure
  // and it is not a gate: no human decision unblocks it — the next `forge next`
  // converges the publication and reconciles the task on its own. The states forge
  // pages on are the ones a HUMAN has to act on, and an SMS here would be noise that
  // invites exactly the retry the state exists to prevent. It is surfaced on every
  // inspection surface (forge show / status / advise / dashboard) instead.
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

// #198: explicit, provider-agnostic kill switch. NO_NOTIFY=true|1|yes silences
// ALL notification dispatch — ntfy AND twilio — regardless of FORGE_NOTIFY /
// NTFY_URL / TWILIO_* config. Its ONLY purpose is non-production contexts (forge's
// own test suite sets it in test-setup.ts); it is NOT for real runs, where a
// completing forge invoke/new IS the signal the human wants. An unset/empty/
// false/0 value does not suppress, so a real run never goes silent by accident.
export function isNotifySuppressed(): boolean {
  const v = process.env["NO_NOTIFY"]?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export function isAnyProviderEnabled(): boolean {
  if (isNotifySuppressed()) return false;
  return isTwilioEnabled() || isNtfyEnabled();
}

// FG-494 AC2: callers that need to distinguish an attempted dispatch from a
// delivered one (e.g. milestone's audit trail) need the actual per-provider
// outcome, not just "we called a provider". `ok` is true only if every
// enabled provider reported success; `errors` names which provider(s) failed.
export type DispatchResult = { ok: boolean; errors: string[] };

export async function dispatch(body: string, title?: string): Promise<DispatchResult> {
  // Belt-and-suspenders: every caller gates on isAnyProviderEnabled() (already
  // false under NO_NOTIFY), but guard the sender too so a direct dispatch can
  // never reach a provider while suppressed.
  if (isNotifySuppressed()) return { ok: true, errors: [] };
  const errors: string[] = [];
  if (isTwilioEnabled()) {
    const result = await notifyTwilio(body);
    if (!result.ok) {
      console.error(`forge notify: SMS failed — ${result.error}`);
      errors.push(`SMS: ${result.error}`);
    }
  }
  if (isNtfyEnabled()) {
    const result = await notifyNtfy(body, title);
    if (!result.ok) {
      console.error(`forge notify: ntfy failed — ${result.error}`);
      errors.push(`ntfy: ${result.error}`);
    }
  }
  return { ok: errors.length === 0, errors };
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

  const body = formatRunNotification(run, state, computeDurationMs(run), failureDetailForRun(run));
  await dispatch(body, `forge: ${run.workflow} [${state}]`);
}

// WALK-4: since FG-585 a run with an un-superseded failed/unreachable required
// phase settles to "failed" (finalizers emit run.failed; statusToNotifyState
// maps it). Surface the failing task so the notification names the kind and a
// forge show. Picks the first failed top-level task; returns undefined when none
// failed.
export function failureDetailForRun(run: Run): FailureDetail | undefined {
  const failed = tasksForRun(run.id).find(
    (t) => t.parentId === undefined && t.status === "failed",
  );
  if (!failed) return undefined;
  const failureKind = failureKindForTask(failed.id);
  return failureKind ? { taskId: failed.id, failureKind } : { taskId: failed.id };
}

// FG-464: the red-blocked task to point the operator at (`forge show <task>`).
// First top-level task in blocked_by_red; undefined if none is found.
export function blockedTaskForRun(run: Run): FailureDetail | undefined {
  const blocked = tasksForRun(run.id).find(
    (t) => t.parentId === undefined && t.status === "blocked_by_red",
  );
  return blocked ? { taskId: blocked.id } : undefined;
}

export async function notifyOnTaskBlockedByRed(run: Run): Promise<void> {
  if (!isAnyProviderEnabled()) return;

  const filter = parseNotifyOn();
  if (!filter.has("blocked_by_red")) return;

  const body = formatRunNotification(run, "blocked_by_red", undefined, blockedTaskForRun(run));
  await dispatch(body, `forge: ${run.workflow} [blocked_by_red]`);
}

// Fired when a task pauses for a human/verdict gate (or human input). This is
// the "forge is blocked on you" signal — carries the task id + `forge gate`
// command so the push tells you exactly what to act on.
export async function notifyOnGateAwaiting(run: Run, task: Task): Promise<void> {
  if (!isAnyProviderEnabled()) return;

  const state: NotifyState = "awaiting_gate";

  const filter = parseNotifyOn();
  if (!filter.has(state)) return;

  const body = formatGateNotification(run, task.id, task.phase, state);
  await dispatch(body, `forge: ${run.workflow} [${state}]`);
}
