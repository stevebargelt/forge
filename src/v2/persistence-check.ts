// #254: post-task persistence assertion — catch silent work loss.
//
// An agent that writes to an ephemeral container path (the classic case: the
// image's /workspace WORKDIR instead of the /project bind mount — see #254's
// sibling fix in spawn.ts) reports files_modified in result.json while nothing
// lands on the host. The orchestrator gate then sees a green `complete` with a
// file list and advances over an empty diff.
//
// We assert the unambiguous TOTAL-loss signature: a `complete` result that
// claims files_modified but NONE of the claimed paths exist on the host project
// dir. Partial absence is deliberately NOT flagged — it can be a legitimate mix
// of creates and deletes; only the all-absent fingerprint (every claimed file
// missing) is treated as loss. This converts silent discard into a loud,
// diagnosable failure instead of a false `complete`.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type PersistenceCheck =
  | { ok: true }
  | { ok: false; claimed: string[]; missing: string[] };

const PROJECT_MOUNT_PREFIX = "/project/";

export function checkResultPersistence(projectDir: string, result: unknown): PersistenceCheck {
  if (!isObject(result)) return { ok: true };
  if (result["status"] !== "complete") return { ok: true };

  const claimed = extractFilesModified(result);
  if (claimed.length === 0) return { ok: true };

  const missing = claimed.filter((f) => !existsOnHost(projectDir, f));
  // Only the total-absence signature is loss. If even one claimed file landed,
  // persistence is working and any absences are likely intentional deletions.
  if (missing.length === claimed.length) return { ok: false, claimed, missing };
  return { ok: true };
}

export function persistenceErrorMessage(c: { claimed: string[]; missing: string[] }): string {
  const n = c.claimed.length;
  const sample = c.claimed.slice(0, 5).join(", ");
  const more = n > 5 ? `, +${n - 5} more` : "";
  return (
    `work not persisted: result.json reports status=complete with ${n} modified file(s), ` +
    `but none exist on the host project dir — the agent likely wrote to an ephemeral ` +
    `container path (e.g. /workspace) instead of the /project bind mount, so the diff was ` +
    `discarded on container exit. Claimed: ${sample}${more}. ` +
    `(If this task intentionally deleted every one of these files, this is a false positive — ` +
    `re-run with the work persisted, or override.)`
  );
}

// Map a claimed path (as written in files_modified) to its host location.
// Returns null when the path points outside the project mount (e.g. an absolute
// /workspace/... path) — there is no host equivalent, so it counts as missing.
function resolveHostPath(projectDir: string, claimed: string): string | null {
  if (!isAbsolute(claimed)) return join(projectDir, claimed);
  if (claimed.startsWith(PROJECT_MOUNT_PREFIX)) {
    return join(projectDir, claimed.slice(PROJECT_MOUNT_PREFIX.length));
  }
  return null;
}

function existsOnHost(projectDir: string, claimed: string): boolean {
  const p = resolveHostPath(projectDir, claimed);
  return p !== null && existsSync(p);
}

function extractFilesModified(result: Record<string, unknown>): string[] {
  const raw = result["files_modified"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is string => typeof f === "string" && f.length > 0);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
