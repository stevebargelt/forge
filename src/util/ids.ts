import { randomBytes } from "node:crypto";

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

export function nowIso(): string {
  return new Date().toISOString();
}
