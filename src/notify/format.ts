// Pure SMS body formatting for forge notifications. No env, no network.
// Target: a single Twilio SMS segment (160 chars). Long workflow titles get
// truncated rather than overflowing into a second segment.

import type { Run } from "../types/index.js";

export type NotifyState = "complete" | "failed" | "blocked_by_red";

const MAX_SMS_LEN = 160;

export function formatRunNotification(
  run: Run,
  state: NotifyState,
  durationMs?: number,
): string {
  const duration = durationMs !== undefined ? ` — ${formatDuration(durationMs)}` : "";
  const titleQuoted = `"${run.title.replaceAll('"', "'")}"`;
  const prefix = `forge: ${run.id} [${state}] ${run.workflow} `;
  const suffix = duration;

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
