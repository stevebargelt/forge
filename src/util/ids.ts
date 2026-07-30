import { randomBytes, randomUUID } from "node:crypto";

function shortId(): string {
  return randomBytes(3).toString("hex");
}

export function newRunId(slug: string): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return `run-${safe || "untitled"}-${shortId()}`;
}

export function newTaskId(phase: string): string {
  return `task-${phase}-${shortId()}`;
}

export function newVerdictId(): string {
  return `verdict-${shortId()}${shortId()}`;
}

export function newGateId(): string {
  return `gate-${shortId()}${shortId()}`;
}

export function newReviewId(): string {
  return `review-${shortId()}${shortId()}`;
}

export function newFixBatchId(): string {
  return `fix-batch-${shortId()}${shortId()}`;
}

export function newCampaignId(): string {
  return `campaign-${shortId()}${shortId()}`;
}

export function newCampaignItemId(): string {
  return `citem-${shortId()}${shortId()}`;
}

// FG-487: pairing discriminator for host-side verification start/finish event
// pairs (review-loop rounds, campaign reconcile host-gate execs) — a crashed
// process restarting the same round/ticket/sha, or a retried gate exec, can
// produce two starts at the same identity; only attemptId disambiguates which
// finish belongs to which start.
export function newAttemptId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
