// FG-591 step 12 — THE DASHBOARD'S FIRST WRITE SURFACE.
//
// ─── WHY THIS IS THE PRESCRIBED PATH, NOT A BOUNDARY BREACH ──────────────────
// FORGE-DEC-015 did not forbid dashboard mutations; it CHOSE their shape —
// "dashboards don't bypass the CLI; the CLI's auth/validation/event-emission logic
// stays the single entrypoint for state changes" (docs/SCHEMA-CONTRACT.md, "CLI
// surface (for mutations)"). So every route here shells EXACTLY ONE named `forge
// queue` verb and writes no DB row itself — the dashboard's own handle is opened
// `{ readonly: true }` and stays that way. Nothing in this module imports the store.
//
// FG-679's BD-7 governs the SERVING AND POLLING paths — the read endpoints a browser
// hits on a timer, where an outbound call is a surprise. A named, guarded, operator-
// initiated mutation route is the case DEC-015 already accepted, and the BD-7 runtime
// guard (fg679-serving-path-no-subprocess.integration.test.ts) is neither widened to
// cover this path nor narrowed to excuse it: it keeps its own three paths and stays
// green, and this module's own suite proves the subprocess it makes.
//
// ─── THE THREAT MODEL THIS SURFACE IS BUILT AGAINST ──────────────────────────
// The dashboard has NO AUTHENTICATION and an env-overridable bind address. So:
//
//  1. THE PAGE THE OPERATOR HAS OPEN (cross-site request forgery). A malicious page
//     in another tab can make the browser POST here with the operator's own network
//     position. Two independent guards, both BEFORE any subprocess:
//       * A NON-SIMPLE CONTENT TYPE is REQUIRED (`application/json`). A form or
//         `<img>`-style request cannot set it, and a `fetch` that does forces a CORS
//         PREFLIGHT — which this server answers 405 with NO `Access-Control-Allow-*`
//         header ever emitted, so the browser never sends the real request.
//       * ORIGIN / SEC-FETCH-SITE are checked against this server's own Host. A
//         browser always sends both on a cross-origin fetch; a non-browser client
//         (curl, a script) sends neither and is allowed, which is the same trust
//         model the rest of this loopback surface already has.
//
//  2. ARGUMENT INJECTION INTO THE CHILD. The child is spawned with an ARGV ARRAY and
//     no shell, so quoting is not the risk — an operand that LOOKS LIKE A FLAG is.
//     Every caller-supplied value is validated against a strict charset and then
//     re-checked for a leading `-` before it can become argv (assertOperand).
//
//  3. POINTING FORGE AT AN ARBITRARY DIRECTORY. `--project` is NEVER a caller-
//     supplied path. The project is resolved through the dashboard's OWN registry
//     exactly as `GET /api/queue` resolves it, and the checkout passed to the child
//     is one the registry already observed. An unregistered path is a refusal.
//
//  4. PRIVILEGE ESCALATION BY ROUTE. Arming autonomous dispatch and setting
//     `max_active_runs` are AUTHORITY TO RUN REPO-WRITING CONTAINERS UNATTENDED (D2).
//     They are not here, and cannot be reached from here: the verb set below is a
//     closed exported constant, the argv builder can emit nothing outside it, and a
//     test asserts both over the route table rather than trusting this comment.
//
// ─── WHAT THESE ROUTES ARE ───────────────────────────────────────────────────
// PLANNING intent — which tickets the operator selected and in what order. Queue
// membership is never execution authorization (AC16), so nothing reachable from this
// module claims, launches, releases or cancels anything.
//
// `rank` and `reorder` REQUIRE `expectVersion` (D11): a board composes a move against
// the order it loaded, and a queue that moved underneath it must refuse rather than
// clobber. The CLI owns that compare-and-set; this surface only refuses to submit a
// move that never carried one.

import { isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRecord } from "./queries.js";
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
  type ForgeRunResult,
  type MutationRefusal,
} from "./mutation-guards.js";

// The shared guards moved to mutation-guards.ts (FG-822); re-exported so this module
// stays the one place a reader of the queue surface finds its whole contract.
export {
  cliRefusal,
  dashboardOrigins,
  guardBindAddress,
  guardMutationRequest,
  isLoopbackHost,
  resolveForgeBinary,
  runForgeVerb,
} from "./mutation-guards.js";
export type { ForgeRunResult, MutationRefusal, MutationRequestHeaders, ResolvedForgeBinary } from "./mutation-guards.js";

// ─── the route table ─────────────────────────────────────────────────────────

/** The mutation routes, as a CLOSED table. Adding a capability means adding a row
 *  here, which is what makes "no route arms dispatch or sets capacity" a testable
 *  claim over data rather than a promise about code. */
export const QUEUE_MUTATION_ROUTES = {
  "/api/queue/enqueue": "enqueue",
  "/api/queue/dequeue": "dequeue",
  "/api/queue/rank": "rank",
  "/api/queue/reorder": "reorder",
} as const;

export type QueueMutationRoute = (typeof QUEUE_MUTATION_ROUTES)[keyof typeof QUEUE_MUTATION_ROUTES];

/** The ONLY `forge queue` verbs this surface can ever spawn. `dispatcher arm`,
 *  `dispatcher disarm`, `--max-active-runs`, `dispatcher run` and `cancel` are
 *  deliberately absent (D2) — they authorize or stop unattended container execution,
 *  which is a materially larger capability than reordering a list. */
export const QUEUE_MUTATION_FORGE_VERBS = ["enqueue", "dequeue", "rank-before", "rank-after", "reorder"] as const;

export type QueueMutationForgeVerb = (typeof QUEUE_MUTATION_FORGE_VERBS)[number];

export function isQueueMutationPath(path: string): path is keyof typeof QUEUE_MUTATION_ROUTES {
  return Object.hasOwn(QUEUE_MUTATION_ROUTES, path);
}

// ─── the payload, before any of it can become argv ───────────────────────────

/** A ticket id, strictly. Not a normalizer — the id is passed to the CLI verbatim
 *  and the CLI decides whether it exists — but a gate: this charset cannot express a
 *  leading `-`, a path separator, `..`, a shell metacharacter or whitespace. */
const TICKET_ID = /^[A-Za-z][A-Za-z0-9]{0,23}-[0-9]{1,9}$/;

/** Ceilings. Every one of these is an argv element or a body the server must hold in
 *  memory, and an unauthenticated surface does not get to trust the caller's sense of
 *  proportion. */
const MAX_NOTE_CHARS = 500;
const MAX_ORDER_IDS = 1000;


function ticketIdField(raw: unknown, field: string): string | MutationRefusal {
  if (typeof raw !== "string") return refuse(400, `${field} is required and must be a string.`);
  const value = raw.trim();
  if (!TICKET_ID.test(value)) return refuse(400, `${field} is not a ticket id (expected e.g. FG-123, got ${JSON.stringify(raw)}).`);
  return assertOperand(value, field) ?? value;
}

/** A non-negative integer, parsed STRICTLY — never `parseInt`, under which "2x" is 2
 *  and "1.9" is 1, so a typo becomes a different, valid-looking submission. The same
 *  rule `forge queue`'s own flags are parsed by. */
function integerField(raw: unknown, field: string, min: number): number | MutationRefusal {
  const value =
    typeof raw === "number" ? raw :
    typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw.trim()) ? Number(raw.trim()) :
    NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    return refuse(400, `${field} must be an integer >= ${min} (got ${JSON.stringify(raw)}).`);
  }
  return value;
}


export type BuiltMutation = { ok: true; verb: QueueMutationForgeVerb; argv: string[] };

/** THE ARGV BUILDER. Every route's whole contract with the child process, in one
 *  place, so "spawns exactly the named verb and nothing else" is readable and
 *  testable as a pure function.
 *
 *  `projectDir` is NOT caller-supplied — the handler resolves it through the
 *  dashboard's own registry first. It is asserted as an operand here anyway, because
 *  a guarantee held in only one place is one edit from being lost. */
export function buildForgeArgv(
  route: QueueMutationRoute,
  body: unknown,
  projectDir: string,
): BuiltMutation | MutationRefusal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(400, "the request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;

  if (!isAbsolute(projectDir)) return refuse(500, "the resolved project checkout is not an absolute path.");
  const dirRefusal = assertOperand(projectDir, "the resolved project checkout");
  if (dirRefusal) return dirRefusal;

  const scope = ["--project", projectDir, "--json"];

  switch (route) {
    case "enqueue": {
      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isRefusal(ticketId)) return ticketId;
      const argv = ["queue", "enqueue", ticketId, ...scope];
      const rawNote = input["note"];
      if (rawNote !== undefined && rawNote !== null && rawNote !== "") {
        if (typeof rawNote !== "string") return refuse(400, "note must be a string.");
        if (rawNote.length > MAX_NOTE_CHARS) return refuse(400, `note must be at most ${MAX_NOTE_CHARS} characters.`);
        // Control characters would land in a durable operator record and in this
        // process's own logs. A note is one line of prose.
        if (/[\u0000-\u001f\u007f]/.test(rawNote)) return refuse(400, "note must not contain control characters.");
        const noteRefusal = assertOperand(rawNote, "note");
        if (noteRefusal) return noteRefusal;
        argv.push("--note", rawNote);
      }
      return { ok: true, verb: "enqueue", argv };
    }

    case "dequeue": {
      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isRefusal(ticketId)) return ticketId;
      // DEQUEUE IS A PLANNING ACT (D4). It retains the rank and NEVER releases a live
      // claim — a released reservation over a still-running container is the duplicate
      // execution queue_claims exists to prevent. Stopping work is `forge queue cancel`,
      // which is CLI-only and unreachable from this table.
      return { ok: true, verb: "dequeue", argv: ["queue", "dequeue", ticketId, ...scope] };
    }

    case "rank": {
      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isRefusal(ticketId)) return ticketId;
      const reference = ticketIdField(input["reference"], "reference");
      if (isRefusal(reference)) return reference;
      const placement = input["placement"];
      if (placement !== "before" && placement !== "after") {
        return refuse(400, `placement must be "before" or "after" (got ${JSON.stringify(placement)}).`);
      }
      if (ticketId === reference) return refuse(400, "a ticket cannot be ranked relative to itself.");
      const expectVersion = integerField(input["expectVersion"], "expectVersion", 0);
      if (isRefusal(expectVersion)) return expectVersion;
      const verb: QueueMutationForgeVerb = placement === "before" ? "rank-before" : "rank-after";
      return {
        ok: true,
        verb,
        argv: ["queue", verb, ticketId, reference, "--expect-version", String(expectVersion), ...scope],
      };
    }

    case "reorder": {
      // D11: a reorder ALWAYS carries the version the board loaded. Absent it, this
      // surface refuses to submit at all rather than letting a stale full ordering
      // overwrite a queue that moved underneath the page.
      const expectVersion = integerField(input["expectVersion"], "expectVersion", 0);
      if (isRefusal(expectVersion)) return expectVersion;
      const versionFlags = ["--expect-version", String(expectVersion)];

      const rawOrder = input["order"];
      const hasOrder = rawOrder !== undefined && rawOrder !== null;
      const hasMove = input["ticketId"] !== undefined || input["to"] !== undefined;
      if (hasOrder && hasMove) {
        return refuse(400, "pass either `order` (the whole queue) or `ticketId` + `to` (one move), never both.");
      }

      if (hasOrder) {
        if (!Array.isArray(rawOrder) || rawOrder.length === 0) return refuse(400, "order must be a non-empty array of ticket ids.");
        if (rawOrder.length > MAX_ORDER_IDS) return refuse(400, `order must contain at most ${MAX_ORDER_IDS} ticket ids.`);
        const ids: string[] = [];
        for (const [index, raw] of rawOrder.entries()) {
          const id = ticketIdField(raw, `order[${index}]`);
          if (isRefusal(id)) return id;
          if (ids.includes(id)) return refuse(400, `order lists ${id} more than once.`);
          ids.push(id);
        }
        return { ok: true, verb: "reorder", argv: ["queue", "reorder", "--order", ids.join(","), ...versionFlags, ...scope] };
      }

      const ticketId = ticketIdField(input["ticketId"], "ticketId");
      if (isRefusal(ticketId)) return ticketId;
      const to = integerField(input["to"], "to", 1);
      if (isRefusal(to)) return to;
      return { ok: true, verb: "reorder", argv: ["queue", "reorder", ticketId, "--to", String(to), ...versionFlags, ...scope] };
    }
  }
}

// ─── the handler ─────────────────────────────────────────────────────────────


/** The checkout the child runs in and names with `--project`.
 *
 *  It comes from the dashboard's OWN registry record, never from the request. A
 *  caller-supplied path here would let any local process point `forge` at any
 *  directory on the host — which is a materially different capability from
 *  reordering one project's queue. A `projectDir` parameter may SELECT among the
 *  checkouts the registry already observed for the resolved project, and does
 *  nothing else. */
export function resolveCheckoutDir(owner: ProjectRecord, requestedDir: string | undefined): string | MutationRefusal {
  const existing = owner.checkouts.filter((checkout) => checkout.exists);
  if (requestedDir) {
    const match = existing.find((checkout) => checkout.projectDir === requestedDir);
    if (match) return match.projectDir;
  }
  const first = existing[0];
  if (first) return first.projectDir;
  return refuse(
    409,
    `the project ${owner.label} has no checkout on this host that still exists, so there is nowhere to run \`forge queue\`.`,
  );
}

export type QueueMutationContext = {
  /** Resolved LAZILY — the registry read costs a bounded `git` evidence probe, and no
   *  guard may be paid for after a refusal that should have come first. */
  resolveOwner: () => ProjectRecord | undefined;
  /** The exact `projectDir` the request asked for, used only to SELECT among the
   *  resolved project's own checkouts. */
  requestedProjectDir?: string | undefined;
};

/** Handle one POST to a queue mutation route. The ORDER of the steps is the security
 *  property: every refusal below happens before a subprocess is even resolved, let
 *  alone spawned. */
export async function handleQueueMutation(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: QueueMutationContext,
): Promise<void> {
  if (!isQueueMutationPath(path)) {
    send(res, 404, { ok: false, error: "not found" });
    return;
  }
  const route = QUEUE_MUTATION_ROUTES[path];

  const headerRefusal = guardMutationPost(req, "queue mutations");
  if (headerRefusal) {
    send(res, headerRefusal.status, { ok: false, error: headerRefusal.error });
    return;
  }

  const body = await readBody(req);
  if (isRefusal(body)) {
    send(res, body.status, { ok: false, error: body.error });
    return;
  }
  let parsed: unknown;
  try {
    parsed = body.text.trim() === "" ? {} : JSON.parse(body.text);
  } catch {
    send(res, 400, { ok: false, error: "the request body is not valid JSON." });
    return;
  }

  const owner = context.resolveOwner();
  if (!owner) {
    send(res, 404, {
      ok: false,
      error:
        "no registered project matches this request. Pass ?projectKey= or ?projectDir= naming a project the dashboard already knows.",
    });
    return;
  }
  const cwd = resolveCheckoutDir(owner, context.requestedProjectDir);
  if (isRefusal(cwd)) {
    send(res, cwd.status, { ok: false, error: cwd.error });
    return;
  }

  const built = buildForgeArgv(route, parsed, cwd);
  if (isRefusal(built)) {
    send(res, built.status, { ok: false, error: built.error });
    return;
  }
  // Belt and braces over the closed set: the builder is the only producer, and this
  // is the only consumer. A verb outside the table never reaches a spawn.
  if (!(QUEUE_MUTATION_FORGE_VERBS as readonly string[]).includes(built.verb)) {
    send(res, 500, { ok: false, error: `refusing to spawn an unregistered queue verb (${built.verb}).` });
    return;
  }

  const binary = resolveForgeBinary();
  if (isRefusal(binary)) {
    send(res, binary.status, { ok: false, error: binary.error });
    return;
  }

  const result: ForgeRunResult | null = await withMutationSlot(() => runForgeVerb(binary.path, built.argv, cwd));
  if (result === null) {
    send(res, 503, {
      ok: false,
      error: `too many queue mutations in flight (${MAX_CONCURRENT_MUTATIONS}); retry in a moment.`,
    });
    return;
  }

  if (result.timedOut) {
    send(res, 504, { ok: false, verb: built.verb, error: `\`forge queue ${built.verb}\` did not finish within ${CHILD_TIMEOUT_MS}ms.` });
    return;
  }
  if (result.code !== 0) {
    // THE CLI'S REFUSAL IS THE ANSWER, passed through concretely rather than
    // reworded: a stale `--expect-version`, a markdown-mode project, a not-ready
    // ticket with its refinement proposal. A generic "failed" here would be the
    // operator blindness this ticket exists to close.
    send(res, 409, {
      ok: false,
      verb: built.verb,
      exitCode: result.code,
      error: cliRefusal(result, `queue ${built.verb}`).slice(-MAX_REPORTED_STDERR).trim(),
    });
    return;
  }

  let cliResult: unknown = null;
  try {
    cliResult = JSON.parse(result.stdout);
  } catch {
    cliResult = null;
  }
  send(res, 200, { ok: true, verb: built.verb, result: cliResult });
}
