// FG-847 — A TICKET BODY EDITED FROM THE DASHBOARD, THROUGH THE CLI'S OWN VERB, AND THE
// READINESS READ THAT TELLS THE OPERATOR WHAT TO EDIT.
//
//  * GET /api/backlog/<id>/readiness — readinessReportForRow (core src/store/queue.ts), the
//    derivation `forge readiness <id> --json` prints: { outcome, gaps, refinementProposal,
//    revision, evaluatedAt, stale } over the CURRENT revision, plus the title and body that
//    verdict describes (the Refine editor's seed). Pure over the stored row — no subprocess.
//
//  * POST /api/backlog/<id>/edit — one ACTION_ROUTES row (action-mutation.ts). Body
//    { projectKey, projectDir?, body, baseRevision? }. Shells exactly
//    `forge backlog edit <id> --body - [--base-revision <n>]` with the body on the child's
//    STDIN — never argv —
//    in the registry's own checkout, the actor carried as FORGE_ACTOR=dashboard (the CLI
//    records it on `backlog.ticket_edited`). A body edit is reversible and visible, so there
//    is no preview; the response carries the new revision and the re-run verdict. DB-mode
//    projects only: the DB is the store of record, and a markdown file edit is not this.

import type { IncomingMessage, ServerResponse } from "node:http";
import { runInReadOnlyDbScope } from "@forge/store-db";
import { getTicket } from "../../src/store/tickets.js";
import { readinessReportForRow, type ReadinessReport } from "../../src/store/queue.js";
import type { ProjectRecord } from "./queries.js";
import { resolveCheckoutDir } from "./queue-mutation.js";
import {
  CHILD_TIMEOUT_MS,
  MAX_CONCURRENT_MUTATIONS,
  MAX_REPORTED_STDERR,
  assertOperand,
  cliRefusal,
  guardMutationPost,
  isRefusal,
  readBody,
  refuse,
  resolveForgeBinary,
  runForgeVerb,
  send,
  withMutationSlot,
  type MutationRefusal,
} from "./mutation-guards.js";

export const BACKLOG_EDIT_PATH = /^\/api\/backlog\/([^/]+)\/edit$/;
export const BACKLOG_READINESS_PATH = /^\/api\/backlog\/([^/]+)\/readiness$/;

/** The largest ticket body the edit route accepts, in UTF-8 bytes. Every ticket in this
 *  repo's store is under 16 KiB; four times that is room without being a payload. */
export const MAX_TICKET_BODY_BYTES = 64 * 1024;
/** The JSON request around it: JSON.stringify escapes newlines and quotes to two bytes. */
const MAX_REQUEST_BYTES = 2 * MAX_TICKET_BODY_BYTES + 4 * 1024;

const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELDS = ["projectKey", "projectDir", "body", "baseRevision"] as const;

export function ticketIdOperand(raw: string): string | MutationRefusal {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return refuse(400, "the ticket id is not valid URI encoding.");
  }
  const dash = assertOperand(value, "the ticket id");
  if (dash) return dash;
  if (!TICKET_ID.test(value)) return refuse(400, `the ticket id ${JSON.stringify(value)} is not a ticket id.`);
  return value;
}

export type BacklogEditRequest = { projectKey: string; projectDir: string | undefined; body: string; baseRevision: number | undefined };

/** PURE: the body checked against the one shape the route takes. */
export function parseBacklogEditRequest(input: unknown): BacklogEditRequest | MutationRefusal {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return refuse(400, "the request body must be a JSON object.");
  const fields = input as Record<string, unknown>;
  const extra = Object.keys(fields).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) return refuse(400, `this route takes ${FIELDS.join(", ")}; refusing ${extra.join(", ")}.`);
  const projectKey = fields["projectKey"];
  if (typeof projectKey !== "string" || projectKey.trim() === "") return refuse(400, "projectKey is required: the registered project the ticket belongs to.");
  const projectDir = fields["projectDir"];
  if (projectDir !== undefined && projectDir !== null && typeof projectDir !== "string") return refuse(400, "projectDir must be a string.");
  const body = fields["body"];
  if (typeof body !== "string") return refuse(400, "body is required: the ticket's whole replacement body, as text.");
  if (body.trim() === "") return refuse(400, "body must not be empty: an edit replaces the whole body.");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_TICKET_BODY_BYTES) return refuse(413, `body is ${bytes} bytes; a ticket body edited here is at most ${MAX_TICKET_BODY_BYTES} bytes (MAX_TICKET_BODY_BYTES).`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) return refuse(400, "body must not contain control characters other than tab and newline.");
  const baseRevision = fields["baseRevision"];
  if (baseRevision !== undefined && baseRevision !== null && !(typeof baseRevision === "number" && Number.isInteger(baseRevision) && baseRevision >= 0)) {
    return refuse(400, "baseRevision must be a non-negative integer: the revision the editor was seeded from.");
  }
  return { projectKey, projectDir: projectDir ?? undefined, body, baseRevision: baseRevision ?? undefined };
}

/** THE ARGV. Exactly one shape; the body is never in it. The base revision, when the editor
 *  was seeded from one, is the CLI's compare-and-set operand — checked inside its write
 *  transaction, not just here before the spawn. */
export function backlogEditArgv(ticketId: string, baseRevision?: number): string[] {
  const argv = ["backlog", "edit", ticketId, "--body", "-"];
  if (baseRevision !== undefined) argv.push("--base-revision", String(baseRevision));
  return argv;
}

// ─── the read ────────────────────────────────────────────────────────────────

export type TicketIdentity = { projectKey: string; storageMode: "db" | "markdown" } | null;

export type TicketReadiness =
  | { kind: "no-truth" }
  | { kind: "markdown"; projectKey: string }
  | { kind: "missing"; projectKey: string }
  | { kind: "ok"; projectKey: string; title: string; body: string; report: ReadinessReport };

/** The ticket's readiness as `forge readiness --json` reports it. Read-only store scope. */
export function readTicketReadiness(identity: TicketIdentity, ticketId: string): TicketReadiness {
  if (!identity) return { kind: "no-truth" };
  const { projectKey } = identity;
  if (identity.storageMode !== "db") return { kind: "markdown", projectKey };
  return runInReadOnlyDbScope((): TicketReadiness => {
    const row = getTicket(projectKey, ticketId);
    if (!row) return { kind: "missing", projectKey };
    return { kind: "ok", projectKey, title: row.title, body: row.body, report: readinessReportForRow(row) };
  });
}

/** A lookup that is not "ok", as the refusal both routes give for it. */
export function readinessRefusal(lookup: Exclude<TicketReadiness, { kind: "ok" }>, ticketId: string, label: string): MutationRefusal {
  switch (lookup.kind) {
    case "no-truth":
      return refuse(404, `the project ${label} has no ticket store (it was never imported), so ${ticketId} cannot be read here.`);
    case "markdown":
      return refuse(409, `the project ${label} keeps its tickets in markdown (project_key ${lookup.projectKey}); the dashboard reads and edits DB-mode tickets only — the DB is the store of record.`);
    case "missing":
      return refuse(404, `no ticket ${ticketId} in project ${label}.`);
  }
}

export function readinessPayload(lookup: Extract<TicketReadiness, { kind: "ok" }>): ReadinessReport & { projectKey: string; title: string; body: string } {
  return { ...lookup.report, projectKey: lookup.projectKey, title: lookup.title, body: lookup.body };
}

// ─── the edit ────────────────────────────────────────────────────────────────

export type BacklogEditContext = {
  /** Resolved only after every header and body guard has passed. */
  resolveProject: (projectKey: string) => ProjectRecord | undefined;
  ticketIdentity: (project: ProjectRecord) => TicketIdentity;
  actor: string;
};

const ACTION = "backlog-edit";

export async function handleBacklogEditMutation(req: IncomingMessage, res: ServerResponse, path: string, context: BacklogEditContext): Promise<void> {
  const m = path.match(BACKLOG_EDIT_PATH);
  if (!m) {
    send(res, 404, { ok: false, error: "not found" });
    return;
  }
  const headerRefusal = guardMutationPost(req, "ticket edits");
  if (headerRefusal) {
    send(res, headerRefusal.status, { ok: false, action: ACTION, error: headerRefusal.error });
    return;
  }
  const ticketId = ticketIdOperand(m[1]!);
  if (isRefusal(ticketId)) {
    send(res, ticketId.status, { ok: false, action: ACTION, error: ticketId.error });
    return;
  }
  const raw = await readBody(req, MAX_REQUEST_BYTES);
  if (isRefusal(raw)) {
    send(res, raw.status, { ok: false, action: ACTION, error: raw.error });
    return;
  }
  let parsed: unknown;
  try {
    parsed = raw.text.trim() === "" ? {} : JSON.parse(raw.text);
  } catch {
    send(res, 400, { ok: false, action: ACTION, error: "the request body is not valid JSON." });
    return;
  }
  const request = parseBacklogEditRequest(parsed);
  if (isRefusal(request)) {
    send(res, request.status, { ok: false, action: ACTION, error: request.error });
    return;
  }
  const owner = context.resolveProject(request.projectKey);
  if (!owner) {
    send(res, 404, { ok: false, action: ACTION, error: `no registered project has the key ${JSON.stringify(request.projectKey)}.` });
    return;
  }
  const checkout = resolveCheckoutDir(owner, request.projectDir);
  if (isRefusal(checkout)) {
    send(res, checkout.status, { ok: false, action: ACTION, error: checkout.error });
    return;
  }
  const identity = context.ticketIdentity(owner);
  const before = readTicketReadiness(identity, ticketId);
  if (before.kind !== "ok") {
    const refusal = readinessRefusal(before, ticketId, owner.label);
    send(res, refusal.status, { ok: false, action: ACTION, error: refusal.error });
    return;
  }
  const previousRevision = before.report.revision;
  // The fast path. The authoritative check is the CLI's compare-and-set (--base-revision).
  if (request.baseRevision !== undefined && previousRevision !== null && request.baseRevision !== previousRevision) {
    send(res, 409, {
      ok: false,
      action: ACTION,
      revision: previousRevision,
      error: `${ticketId} is at revision r${previousRevision}, not r${request.baseRevision} the editor was seeded from — someone edited it meanwhile. Reload it and re-apply your change; nothing was written.`,
    });
    return;
  }

  const argv = backlogEditArgv(ticketId, request.baseRevision);
  const command = `forge ${argv.join(" ")}`;
  const binary = resolveForgeBinary();
  if (isRefusal(binary)) {
    send(res, binary.status, { ok: false, action: ACTION, error: binary.error });
    return;
  }
  const env = { ...process.env, FORGE_ACTOR: context.actor };
  const result = await withMutationSlot(() => runForgeVerb(binary.path, argv, checkout, env, request.body));
  if (result === null) {
    send(res, 503, { ok: false, action: ACTION, error: `too many dashboard mutations in flight (${MAX_CONCURRENT_MUTATIONS}); retry in a moment.` });
    return;
  }
  const summary = { action: ACTION, verb: command, ticketId, exitCode: result.code, stdout: result.stdout.slice(-MAX_REPORTED_STDERR).trim() };
  if (result.timedOut) {
    send(res, 504, { ok: false, ...summary, error: `\`${command}\` did not finish within ${CHILD_TIMEOUT_MS}ms.` });
    return;
  }
  if (result.code !== 0) {
    const error = cliRefusal(result, `backlog edit ${ticketId}`).slice(-MAX_REPORTED_STDERR);
    if (/\brevision_moved\b/.test(error)) {
      const current = readTicketReadiness(identity, ticketId);
      send(res, 409, { ok: false, ...summary, refusal: "revision_moved", revision: current.kind === "ok" ? current.report.revision : null, error });
      return;
    }
    send(res, 409, { ok: false, ...summary, error });
    return;
  }
  const after = readTicketReadiness(identity, ticketId);
  if (after.kind !== "ok") {
    send(res, 200, { ok: true, ...summary, previousRevision, revision: null, readiness: null, error: `the edit applied, but ${ticketId} could not be re-read.` });
    return;
  }
  send(res, 200, { ok: true, ...summary, previousRevision, revision: after.report.revision, readiness: readinessPayload(after) });
}
