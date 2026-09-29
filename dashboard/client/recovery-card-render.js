// FG-824: the task page's recovery card, as data. A task parked at awaiting_recovery, or
// failed with an orphan kind, gets one card: what failed, what the last `forge recover`
// recorded (read from the task's own timeline), and the next verb. The next verb comes from
// the FG-822 preview (GET /api/task/:id/actions): an eligible re-drive or retry is a button,
// a refused one shows the retry policy's advice. Nothing here decides eligibility.

import { statusToken } from "./status-tokens.js";

/** The failure kinds a lost container or a lost forge process leaves behind — the ones
 *  `forge recover` exists for. Checked against core's ORPHAN_EVIDENCE_KINDS and every
 *  orphan-named FailureKind by dashboard/src/fg824-freshness-recovery.test.ts. */
export const ORPHAN_FAILURE_KINDS = Object.freeze([
  "orphaned",
  "orphaned_work_may_persist",
  "orphaned_needs_finalize",
  "fanout_wave_orphaned",
  "oom_killed",
  "container_crash",
  "idle_timeout",
  "result_missing",
]);

const RECOVERY_ACTIONS = ["recover-re-drive", "retry"];

export function needsRecoveryCard(detail) {
  const task = detail && typeof detail === "object" ? detail.task : null;
  if (!task || typeof task !== "object") return false;
  if (task.status === "awaiting_recovery") return true;
  return typeof detail.failureKind === "string" && ORPHAN_FAILURE_KINDS.includes(detail.failureKind);
}

/** The newest `task.reconciled` a `forge recover` (or `forge publish recover`) wrote, as
 *  one line; null when none is recorded. */
export function lastRecoverOutcome(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const p = e && typeof e.payload === "object" && e.payload !== null ? e.payload : null;
    if (!e || e.eventType !== "task.reconciled" || !p || typeof p.via !== "string") continue;
    if (!/^forge (publish )?recover\b/.test(p.via)) continue;
    const move = typeof p.from === "string" && typeof p.to === "string" ? `${p.from} → ${p.to}` : "reconciled";
    const why = typeof p.reason === "string" ? ` (${p.reason})` : "";
    return { via: p.via, at: typeof e.createdAt === "string" ? e.createdAt : null, text: `${p.via}: ${move}${why}` };
  }
  return null;
}

/** The verb to name when the preview offers no button. Never a --force form: that bypass is
 *  the operator's own call at a terminal, and the policy's advice beneath says so in its words. */
export function defaultRecoveryVerb(detail) {
  const task = detail.task;
  if (task.status === "awaiting_recovery") return `forge next ${task.runId}`;
  if (detail.failureKind === "fanout_wave_orphaned") return `forge recover ${task.taskId} --re-drive`;
  if (detail.failureKind === "orphaned_needs_finalize") return `forge show ${task.taskId}, then forge recover ${task.taskId}`;
  return `forge recover ${task.taskId}`;
}

/** The next step: a button for an eligible recovery action, else the policy's advice. */
export function recoveryNext(detail, load) {
  const verb = defaultRecoveryVerb(detail);
  if (!load) return { mode: "loading", verb };
  if (load.phase !== "ready") return { mode: "advice", verb, advice: `The action preview is unavailable (${load.detail}); run it from a terminal.` };
  for (const action of RECOVERY_ACTIONS) {
    const entry = load.eligible.find((e) => e.action === action);
    if (entry && load.available) return { mode: "button", verb: entry.verb, entry };
    if (entry) return { mode: "advice", verb: entry.verb, advice: load.unavailableReason ?? "this dashboard does not admit mutations; run it from a terminal." };
  }
  const refused = RECOVERY_ACTIONS.map((a) => load.refused.find((r) => r.action === a && r.advice)).find(Boolean)
    ?? load.refused.find((r) => r.action === "recover-re-drive")
    ?? null;
  return { mode: "advice", verb, advice: refused ? refused.advice ?? refused.reason : null };
}

/** The whole card, or null when the task needs none. */
export function recoveryCard(detail, load) {
  if (!needsRecoveryCard(detail)) return null;
  const parked = detail.task.status === "awaiting_recovery";
  return {
    status: statusToken("task", detail.task.status),
    kind: parked ? "awaiting_recovery" : detail.failureKind,
    kindDetail: parked
      ? "the publication advanced the target and then lost its window; its disposition is not settled, so never hand-reset it"
      : "the task's container or forge process was lost before the step finished",
    lastRecover: lastRecoverOutcome(detail.events),
    next: recoveryNext(detail, load),
  };
}
