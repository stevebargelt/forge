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

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRecord } from "./queries.js";

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

// ─── refusals ────────────────────────────────────────────────────────────────

/** A refusal carries the HTTP status AND the concrete reason. A mutation surface
 *  that refuses without saying why is the operator-blindness failure this ticket
 *  exists to close, one layer up. */
export type MutationRefusal = { ok: false; status: number; error: string };

function refuse(status: number, error: string): MutationRefusal {
  return { ok: false, status, error };
}

// ─── the guards, in the order they run — all of them before any subprocess ───

/** THE BIND-ADDRESS ADMISSION TEST. `HOST` is env-overridable, and the server already
 *  warns at boot that a non-loopback bind puts this unauthenticated surface in front
 *  of any network peer. Reading is one thing; letting a peer drive the host's `forge`
 *  CLI is another, so the WRITE half fails closed off loopback.
 *
 *  It is an opt-out, not a wall: an operator who deliberately runs a shared dashboard
 *  behind their own auth can set FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS=1. The
 *  default is deny because the default is the case nobody thought about. */
export function guardBindAddress(env: NodeJS.ProcessEnv = process.env): MutationRefusal | null {
  if (env["FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS"] === "1") return null;
  const host = env["HOST"] ?? "127.0.0.1";
  if (/^(127\.|::1$|\[::1\]$|localhost$)/.test(host)) return null;
  return refuse(
    403,
    `queue mutations are refused because this dashboard is bound to ${host}, not loopback: the surface has no ` +
      `authentication, and any peer that can reach it could otherwise drive the host's forge CLI. Bind to 127.0.0.1, ` +
      `or set FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS=1 if this dashboard is fronted by your own authentication.`,
  );
}

export type MutationRequestHeaders = {
  contentType?: string | undefined;
  origin?: string | undefined;
  secFetchSite?: string | undefined;
  host?: string | undefined;
};

/**
 * THE ORIGINS THIS DASHBOARD ACTUALLY HAS, derived from the server's OWN configuration
 * — never from the request.
 *
 * A request's Host header is caller-controlled, so checking Origin against it only
 * proves the two agree, which a DNS-REBINDING page satisfies trivially: serve a page
 * at attacker.example, rebind that name to 127.0.0.1, and the browser then sends
 * Origin AND Host of attacker.example plus `Sec-Fetch-Site: same-origin`. Every
 * request-derived guard passes and the loopback dashboard runs the host's forge CLI.
 * Pinning to the configured bind address is what closes it: the attacker's page cannot
 * make the browser send an origin it does not have.
 *
 * The loopback aliases are enumerated because an operator reaches a 127.0.0.1 bind as
 * `localhost` as readily as by address, and both are genuinely this server.
 * FORGE_DASHBOARD_ORIGIN (comma-separated) replaces the derivation outright.
 *
 * NULL means "this deployment has no derivable origin": a non-loopback bind that
 * declared no origin of its own. Only FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS reaches
 * that state (guardBindAddress refuses it otherwise), and it is the operator saying
 * this dashboard is fronted by their own authentication — forge cannot name their
 * hostname, so it falls back to Origin/Host agreement there and pins nothing it
 * would only be guessing at. The unauthenticated loopback surface D2 reasoned about
 * is the one that gets the pin.
 */
export function dashboardOrigins(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const configured = env["FORGE_DASHBOARD_ORIGIN"];
  if (configured !== undefined && configured.trim() !== "") {
    return configured.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter((o) => o !== "");
  }
  const host = (env["HOST"] ?? "127.0.0.1").trim();
  if (!/^(127\.|::1$|\[::1\]$|localhost$)/.test(host)) return null;
  const port = Number(env["PORT"] ?? 8024);
  // Derived from the ACTUAL configured bind, not a fixed triple: a dashboard bound to
  // another loopback address (127.0.0.2 is the reported case) is genuinely itself and
  // must accept its own same-origin mutations. The default aliases stay in the set so a
  // 127.0.0.1 bind is still reachable as `localhost` and `[::1]`; the configured host is
  // added to them (a bare `::1` bracketed for a valid origin). A non-loopback host was
  // already refused above, so nothing foreign enters here.
  const configuredHost = host === "::1" ? "[::1]" : host;
  const hosts = new Set(["127.0.0.1", "localhost", "[::1]", configuredHost]);
  return [...hosts].flatMap((h) => [`http://${h}:${port}`, `https://${h}:${port}`]);
}

/** PURE over the request's headers, so the cross-origin rule can be exercised
 *  exhaustively without a socket. Runs BEFORE the body is read and long before any
 *  subprocess is considered. */
export function guardMutationRequest(
  headers: MutationRequestHeaders,
  allowedOrigins: readonly string[] | null = dashboardOrigins(),
): MutationRefusal | null {
  // Sec-Fetch-Site is the browser's own statement of provenance and cannot be set by
  // page script. `none` is a user-initiated request (address bar, a curl that happens
  // to send it); `same-origin` is this page. Anything else — `cross-site`,
  // `same-site` (a sibling subdomain is not us) — is refused.
  const site = headers.secFetchSite?.trim().toLowerCase();
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return refuse(403, `cross-origin request refused (Sec-Fetch-Site: ${site}). This surface is same-origin only.`);
  }

  const host = headers.host?.trim().toLowerCase();
  const origin = headers.origin?.trim();

  // The HOST the request names must be one this dashboard was configured to serve.
  // This is the DNS-rebinding guard: the browser derives Host from the URL, so a page
  // at attacker.example — however that name resolves — cannot send one of ours.
  if (allowedOrigins !== null) {
    const allowedHosts = new Set(allowedOrigins.map((o) => o.replace(/^https?:\/\//, "").toLowerCase()));
    if (host === undefined || host === "") {
      return refuse(403, "request refused: the request carries no Host header, and this surface checks it.");
    }
    if (!allowedHosts.has(host)) {
      return refuse(
        403,
        `request refused (Host: ${host}). This dashboard answers mutations only at ${[...allowedHosts].join(", ")}; ` +
          `a Host it was not configured for is a rebound name, not this server. Set FORGE_DASHBOARD_ORIGIN if you ` +
          `deliberately serve it elsewhere.`,
      );
    }
    // Origin, checked against the CONFIGURED origin — never against the request's own
    // Host, which the caller supplies and a rebinding page satisfies by construction.
    // A browser sends Origin on every POST; its absence means a non-browser client,
    // which is the same trust position every other route on this unauthenticated
    // loopback surface has.
    if (origin !== undefined && origin !== "") {
      // `Origin: null` (a sandboxed iframe, a file:// page) is never same-origin.
      if (!allowedOrigins.some((o) => o.toLowerCase() === origin.replace(/\/+$/, "").toLowerCase())) {
        return refuse(
          403,
          `cross-origin request refused (Origin: ${origin}). This surface is same-origin only, at ` +
            `${allowedOrigins.join(", ")}.`,
        );
      }
    }
  } else if (origin !== undefined && origin !== "") {
    // No derivable origin (a non-loopback bind behind the operator's own auth): all
    // this can still assert is that the page and the request name the same host.
    if (!host) return refuse(403, "cross-origin request refused: the request carries an Origin but no Host to check it against.");
    if (origin !== `http://${host}` && origin !== `https://${host}`) {
      return refuse(403, `cross-origin request refused (Origin: ${origin}). This surface is same-origin only.`);
    }
  }

  // A NON-SIMPLE content type is the load-bearing CSRF guard: a cross-origin fetch
  // that sets it must preflight, and this server answers preflight 405 with no CORS
  // header at all, so the real request is never sent. A form POST cannot set it.
  const contentType = headers.contentType?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return refuse(
      415,
      `Content-Type must be application/json (got ${headers.contentType ? `"${headers.contentType}"` : "none"}). ` +
        `A simple-request content type is refused: it is the shape a cross-site form can forge.`,
    );
  }

  return null;
}

// ─── the payload, before any of it can become argv ───────────────────────────

/** A ticket id, strictly. Not a normalizer — the id is passed to the CLI verbatim
 *  and the CLI decides whether it exists — but a gate: this charset cannot express a
 *  leading `-`, a path separator, `..`, a shell metacharacter or whitespace. */
const TICKET_ID = /^[A-Za-z][A-Za-z0-9]{0,23}-[0-9]{1,9}$/;

/** Ceilings. Every one of these is an argv element or a body the server must hold in
 *  memory, and an unauthenticated surface does not get to trust the caller's sense of
 *  proportion. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTE_CHARS = 500;
const MAX_ORDER_IDS = 1000;

/** THE LAST GATE BEFORE ARGV. Even a value that passed its own validator is re-checked
 *  here: `execFile` with an array is immune to shell quoting, but NOT to an operand the
 *  child's own parser reads as a flag. Nothing caller-derived may start with `-`. */
function assertOperand(value: string, field: string): MutationRefusal | null {
  if (value.length === 0) return refuse(400, `${field} must not be empty.`);
  if (value.startsWith("-")) return refuse(400, `${field} must not begin with "-": it would be read as a flag by the CLI.`);
  return null;
}

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

function isRefusal(v: unknown): v is MutationRefusal {
  return typeof v === "object" && v !== null && (v as MutationRefusal).ok === false;
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

// ─── the child: which binary, and how it is run ──────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<root>/dashboard/src` → `<root>`. The dashboard is bundled INTO the release
 *  (FG-580), so the forge entry beside it is the one this dashboard belongs to. */
const PACKAGE_ROOT = resolve(HERE, "..", "..");

export type ResolvedForgeBinary = { path: string; source: "env" | "colocated" | "path" };

/** WHICH `forge` THIS SURFACE EXECUTES, most specific first:
 *
 *   1. `FORGE_BIN`, if the operator set it — absolute and existing, or a NAMED
 *      refusal. A typo must not silently fall through to a different binary.
 *   2. THE CO-LOCATED ENTRY — the release entry (`<root>/forge`) or the dev control
 *      entry (`<root>/bin/forge`) beside this dashboard. Preferred over `$PATH`
 *      deliberately: it is the forge this dashboard shipped with, and it cannot be
 *      shadowed by an earlier `forge` on the PATH of whatever shell started the server.
 *   3. `forge` on `$PATH` — the contract SCHEMA-CONTRACT already documents, kept as
 *      the fallback for an installation laid out some other way. */
export function resolveForgeBinary(env: NodeJS.ProcessEnv = process.env): ResolvedForgeBinary | MutationRefusal {
  const override = env["FORGE_BIN"]?.trim();
  if (override) {
    if (!isAbsolute(override)) return refuse(500, `FORGE_BIN must be an absolute path (got ${override}).`);
    if (!existsSync(override)) return refuse(500, `FORGE_BIN points at ${override}, which does not exist.`);
    return { path: override, source: "env" };
  }
  for (const candidate of [resolve(PACKAGE_ROOT, "forge"), resolve(PACKAGE_ROOT, "bin", "forge")]) {
    if (existsSync(candidate)) return { path: candidate, source: "colocated" };
  }
  return { path: "forge", source: "path" };
}

/** An unauthenticated local surface must not be a fork bomb: any local process can
 *  reach it, and each request costs a forge CLI process holding the machine-wide
 *  write lock. Small, deliberate, and reported by name when it bites. */
const MAX_CONCURRENT_MUTATIONS = 4;
let inFlight = 0;

const CHILD_TIMEOUT_MS = 60_000;
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Only a bounded tail of the child's stderr is reflected to the caller. */
const MAX_REPORTED_STDERR = 4 * 1024;

export type ForgeRunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Spawn the CLI. ARGV ARRAY, NO SHELL, cwd pinned to the resolved checkout, bounded
 *  time and bounded output. Never rejects: a failed child is a RESULT, because the
 *  CLI's non-zero exit and its stderr ARE the refusal this surface has to report. */
export function runForgeVerb(
  binary: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ForgeRunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      binary,
      [...argv],
      { cwd, env, timeout: CHILD_TIMEOUT_MS, maxBuffer: MAX_CHILD_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        if (!err) {
          resolvePromise({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const timedOut = err.killed === true || err.signal === "SIGTERM";
        const code = typeof err.code === "number" ? err.code : timedOut ? 124 : 127;
        resolvePromise({
          code,
          stdout,
          stderr: stderr || err.message,
          timedOut,
        });
      },
    );
  });
}

/**
 * THE CLI'S OWN REFUSAL, whichever channel it used.
 *
 * A `--json` verb that REPORTS a refusal (rather than throwing one) writes its whole
 * envelope — `refusal` and `reason` included — to STDOUT and exits non-zero with an
 * EMPTY stderr. A not-ready `queue enqueue` is exactly that shape, and its `reason`
 * carries the concrete refinement proposal, which is the one sentence that tells the
 * operator what to do. Falling through to `execFile`'s synthesized "Command failed:
 * <argv>" there hands them the only string in the exchange that contains no reason at
 * all — the operator blindness this ticket exists to close (found by the browser-tier
 * AC4 case in browser-tests/fg591-queue-board.test.ts).
 *
 * A THROWN refusal (a stale `--expect-version`, a markdown-mode project) still lands
 * on stderr with no stdout, and is still passed through verbatim.
 */
export function cliRefusal(result: ForgeRunResult, verb: string): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    for (const key of ["refusal", "reason", "error"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  const raw = result.stderr.trim() || result.stdout.trim();
  return raw !== "" ? raw : `\`forge queue ${verb}\` exited ${result.code}`;
}

// ─── the handler ─────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | MutationRefusal> {
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        return refuse(413, `the request body exceeds ${MAX_BODY_BYTES} bytes.`);
      }
      chunks.push(buf);
    }
  } catch {
    return refuse(400, "the request body could not be read.");
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // No `Access-Control-Allow-*` header is emitted here or anywhere on this
      // surface — that absence is what makes a browser's preflight fail closed.
      "X-Content-Type-Options": "nosniff",
    })
    .end(JSON.stringify(payload));
}

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

  const bindRefusal = guardBindAddress();
  if (bindRefusal) {
    send(res, bindRefusal.status, { ok: false, error: bindRefusal.error });
    return;
  }

  const headerRefusal = guardMutationRequest({
    contentType: header(req, "content-type"),
    origin: header(req, "origin"),
    secFetchSite: header(req, "sec-fetch-site"),
    host: header(req, "host"),
  });
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

  if (inFlight >= MAX_CONCURRENT_MUTATIONS) {
    send(res, 503, {
      ok: false,
      error: `too many queue mutations in flight (${MAX_CONCURRENT_MUTATIONS}); retry in a moment.`,
    });
    return;
  }

  inFlight += 1;
  let result: ForgeRunResult;
  try {
    result = await runForgeVerb(binary.path, built.argv, cwd);
  } finally {
    inFlight -= 1;
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
      error: cliRefusal(result, built.verb).slice(-MAX_REPORTED_STDERR).trim(),
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

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
