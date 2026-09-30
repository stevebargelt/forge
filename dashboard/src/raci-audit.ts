// FG-840: the ONE reader of a RACI audit log. `forge raci apply` appends to the
// PROJECT's `<checkout>/.forge/raci-audit.log` since FG-778; the host
// `$FORGE_HOME/raci-audit.log` is read only when no checkout is in scope. Both
// GET /api/governance (routingGovernance) and GET /api/raci read through
// raciAuditTail(), so the two can never show different entries for one checkout.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUDIT_TAIL_LINES = 20;

/** One parsed JSONL line. Untrusted file content, so not narrowed further; the
 *  fields `forge raci apply` writes are timestamp, action, current_raci, candidate,
 *  candidate_sha256, routes_added/removed/modified, validation, and (FG-834) actor,
 *  rationale, source. */
export type RaciAuditLine = Record<string, unknown>;

export type RaciAuditTail = {
  source: "project" | "host";
  path: string;
  entries: RaciAuditLine[];
  skippedLines: number;
};

/** The last `limit` non-empty lines of a JSONL audit log, newest first. A line that
 *  is not a JSON object is counted in `skippedLines`, never fatal. */
export function readAuditTail(path: string, limit: number = AUDIT_TAIL_LINES): { entries: RaciAuditLine[]; skippedLines: number } {
  if (!existsSync(path)) return { entries: [], skippedLines: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").slice(-limit);
  const entries: RaciAuditLine[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed as RaciAuditLine);
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  return { entries: entries.reverse(), skippedLines };
}

/** The RACI audit tail for a checkout, or the host log when no checkout is scoped. */
export function raciAuditTail(checkoutDir?: string): RaciAuditTail {
  const source = checkoutDir ? "project" : "host";
  const path = checkoutDir
    ? join(checkoutDir, ".forge", "raci-audit.log")
    : join(process.env["FORGE_HOME"] ?? join(homedir(), ".forge"), "raci-audit.log");
  return { source, path, ...readAuditTail(path) };
}
