// The guards every dashboard mutation route shares (FG-591 queue planning, FG-822
// task actions): the bind-address admission test, same-origin + non-simple content
// type, the leading-dash operand check, the bounded body read, and the one way a
// `forge` child is resolved and run. queue-mutation.ts carries the threat model these
// answer; a route that copies a guard instead of calling it here is how the two drift.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── refusals ────────────────────────────────────────────────────────────────

/** A refusal carries the HTTP status AND the concrete reason. A mutation surface
 *  that refuses without saying why is the operator-blindness failure this ticket
 *  exists to close, one layer up. */
export type MutationRefusal = { ok: false; status: number; error: string };

export function refuse(status: number, error: string): MutationRefusal {
  return { ok: false, status, error };
}

/** A GENUINE loopback bind, not a hostname that merely SPELLS like one. The prior
 *  string-prefix test (`^127\.`) trusted any name beginning `127.` — including a public
 *  DNS name like `127.evil.test` that resolves off-loopback — which widened the
 *  same-origin trust to a foreign origin (RF-1/RF-4). Accept only `localhost`, the IPv6
 *  loopback, or a dotted-quad in 127.0.0.0/8 validated by its parsed octets. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  const octets = h.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((o) => /^(0|[1-9][0-9]{0,2})$/.test(o) && Number(o) <= 255)) return false;
  return Number(octets[0]) === 127;
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
export function guardBindAddress(env: NodeJS.ProcessEnv = process.env, subject = "queue mutations"): MutationRefusal | null {
  if (env["FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS"] === "1") return null;
  const host = env["HOST"] ?? "127.0.0.1";
  if (isLoopbackHost(host)) return null;
  return refuse(
    403,
    `${subject} are refused because this dashboard is bound to ${host}, not loopback: the surface has no ` +
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
  if (!isLoopbackHost(host)) return null;
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

const MAX_BODY_BYTES = 64 * 1024;

/** THE LAST GATE BEFORE ARGV. Even a value that passed its own validator is re-checked
 *  here: `execFile` with an array is immune to shell quoting, but NOT to an operand the
 *  child's own parser reads as a flag. Nothing caller-derived may start with `-`. */
export function assertOperand(value: string, field: string): MutationRefusal | null {
  if (value.length === 0) return refuse(400, `${field} must not be empty.`);
  if (value.startsWith("-")) return refuse(400, `${field} must not begin with "-": it would be read as a flag by the CLI.`);
  return null;
}

export function isRefusal(v: unknown): v is MutationRefusal {
  return typeof v === "object" && v !== null && (v as MutationRefusal).ok === false;
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
export const MAX_CONCURRENT_MUTATIONS = 4;
let inFlight = 0;

/** One slot across EVERY mutation registry — they all spawn the same CLI against the
 *  same machine-wide write lock. Null when the slots are taken. */
export async function withMutationSlot<T>(run: () => Promise<T>): Promise<T | null> {
  if (inFlight >= MAX_CONCURRENT_MUTATIONS) return null;
  inFlight += 1;
  try {
    return await run();
  } finally {
    inFlight -= 1;
  }
}

export const CHILD_TIMEOUT_MS = 60_000;
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Only a bounded tail of the child's stderr is reflected to the caller. */
export const MAX_REPORTED_STDERR = 4 * 1024;

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
  return raw !== "" ? raw : `\`forge ${verb}\` exited ${result.code}`;
}

export async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<{ ok: true; text: string } | MutationRefusal> {
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) {
        req.destroy();
        return refuse(413, `the request body exceeds ${maxBytes} bytes.`);
      }
      chunks.push(buf);
    }
  } catch {
    return refuse(400, "the request body could not be read.");
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

export function send(res: ServerResponse, status: number, payload: unknown): void {
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

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The two header-level guards in the order every mutation route runs them — bind
 *  address, then same-origin and content type — before the body is read. */
export function guardMutationPost(req: IncomingMessage, subject: string): MutationRefusal | null {
  return (
    guardBindAddress(process.env, subject) ??
    guardMutationRequest({
      contentType: header(req, "content-type"),
      origin: header(req, "origin"),
      secFetchSite: header(req, "sec-fetch-site"),
      host: header(req, "host"),
    })
  );
}
