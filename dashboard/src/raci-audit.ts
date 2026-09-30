// FG-840: the ONE reader of a RACI audit log. `forge raci apply` appends to the
// PROJECT's `<checkout>/.forge/raci-audit.log` since FG-778; the host
// `$FORGE_HOME/raci-audit.log` is read only when no checkout is in scope. Both
// GET /api/governance (routingGovernance) and GET /api/raci read through
// raciAuditTail(), so the two can never show different entries for one checkout.

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { provenPhysical } from "../../src/util/path-identity.js";

export const AUDIT_TAIL_LINES = 20;
export const AUDIT_TAIL_CHUNK_BYTES = 64 * 1024;

/** One parsed JSONL line. Untrusted file content, so not narrowed further; the
 *  fields `forge raci apply` writes are timestamp, action, current_raci, candidate,
 *  candidate_sha256, routes_added/removed/modified, validation, and (FG-834) actor,
 *  rationale, source. Attribution is always `actor`: `forge model policy apply`
 *  writes it as `by`, which the reader renames. */
export type RaciAuditLine = Record<string, unknown>;

export type RaciAuditTail = {
  source: "project" | "host";
  path: string;
  entries: RaciAuditLine[];
  skippedLines: number;
  /** Set when a scoped checkout's log resolves outside `<checkout>/.forge` (a
   *  symlinked `.forge` or log); the log is then not read. */
  refused?: "outside_checkout_forge";
};

/** The last `limit` non-empty lines of a JSONL audit log, newest first. A line that
 *  is not a JSON object is counted in `skippedLines`, never fatal. */
export function readAuditTail(path: string, limit: number = AUDIT_TAIL_LINES): { entries: RaciAuditLine[]; skippedLines: number } {
  if (!existsSync(path)) return { entries: [], skippedLines: 0 };
  const lines = lastNonEmptyLines(path, limit);
  const entries: RaciAuditLine[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(withActor(parsed as RaciAuditLine));
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  return { entries: entries.reverse(), skippedLines };
}

/** Reads backwards from the end of the file one chunk at a time until `limit`
 *  complete non-empty lines (or the start of the file) are in hand, so the read is
 *  bounded by the tail, not the log's size. Decoding starts just after a newline
 *  byte, which never falls inside a multi-byte UTF-8 sequence. */
function lastNonEmptyLines(path: string, limit: number): string[] {
  const fd = openSync(path, "r");
  try {
    let start = fstatSync(fd).size;
    let buf = Buffer.alloc(0);
    let lines: string[] = [];
    while (start > 0) {
      const size = Math.min(AUDIT_TAIL_CHUNK_BYTES, start);
      start -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, start);
      buf = Buffer.concat([chunk, buf]);
      const from = start === 0 ? 0 : buf.indexOf(0x0a) + 1;
      if (from === 0 && start > 0) continue;
      lines = buf.subarray(from).toString("utf8").split("\n").filter((l) => l.trim() !== "");
      if (lines.length >= limit) break;
    }
    return lines.slice(-limit);
  } finally {
    closeSync(fd);
  }
}

function withActor(line: RaciAuditLine): RaciAuditLine {
  if (!("by" in line)) return line;
  const { by, ...rest } = line;
  return "actor" in rest ? rest : { ...rest, actor: by };
}

/** The RACI audit tail for a checkout, or the host log when no checkout is scoped. */
export function raciAuditTail(checkoutDir?: string): RaciAuditTail {
  if (!checkoutDir) {
    const path = join(process.env["FORGE_HOME"] ?? join(homedir(), ".forge"), "raci-audit.log");
    return { source: "host", path, ...readAuditTail(path) };
  }
  const path = join(checkoutDir, ".forge", "raci-audit.log");
  const physical = provenPhysical(path);
  const checkout = provenPhysical(checkoutDir);
  if (physical !== null && (checkout === null || !physical.startsWith(join(checkout, ".forge") + sep))) {
    return { source: "project", path, entries: [], skippedLines: 0, refused: "outside_checkout_forge" };
  }
  return { source: "project", path, ...readAuditTail(path) };
}
