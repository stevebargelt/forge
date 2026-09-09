// FG-783 (step 4): the CSRF / same-origin guard for the Remote Board planning surface.
//
// ─── THE THREAT, BEHIND TAILSCALE SERVE ──────────────────────────────────────
// FG-782 fronts the loopback listener with Tailscale Serve at a private ts.net hostname and
// verifies WHO is calling via `tailscale whois`. That answers authentication — but not CSRF.
// A page in the operator's OWN browser, served from any other origin, can still try to make
// the browser POST a planning mutation to `https://<serveHost>/api/plan` on the operator's
// authenticated network position. Three independent guards, all BEFORE the body is read and
// long before any store authority is touched:
//
//   1. A NON-SIMPLE CONTENT TYPE is required (`application/json`). A form / `<img>` / simple
//      `fetch` cannot set it, and a `fetch` that does forces a CORS PREFLIGHT — which the
//      listener answers 405 with NO `Access-Control-Allow-*` header, so the real request is
//      never sent.
//   2. SEC-FETCH-SITE is the browser's own, script-unsettable statement of provenance. Only
//      `same-origin` (this page) and `none` (a user-initiated navigation / a non-browser
//      client) are allowed; `cross-site` / `same-site` are refused.
//   3. ORIGIN / HOST are PINNED to the Serve-fronted public hostname read from Forge-owned
//      serve-state (readServeState().serveHost / .url), NEVER derived from the request Host,
//      an X-Forwarded-Host, or the loopback bind. This is the DNS-rebinding guard: the browser
//      derives Origin/Host from the URL, so an attacker page — however its name resolves —
//      cannot make the browser send one of OURS. Deriving the allowed origin from the request
//      would defeat the guard entirely (a rebound name satisfies Host==Origin trivially).
//
// FAIL CLOSED WHEN THE PIN IS UNKNOWN. If serve-state is absent (never set up, corrupt, or
// version-mismatched — readServeState returns null), there is no public origin to pin to, so
// this guard REFUSES rather than fall back to trusting the request. A planning mutation must
// not be accepted on a surface whose own public identity Forge cannot name.
//
// This module reads NO header value to establish trust that isn't cross-checked against the
// serve-state pin, and it is given ONLY the four headers below — there is deliberately no
// parameter through which an X-Forwarded-Host could enter. Pure over (headers, serve-state).

import { readServeState, type ServeStateRecord } from "../tailscale/serve-state.js";

/** A refusal carries the HTTP status AND the concrete reason. Structurally identical to the
 *  envelope's PlanningRefusal; kept local so this module stays self-contained. */
export type PlanningRefusal = { readonly ok: false; readonly status: number; readonly error: string };

function refuse(status: number, error: string): PlanningRefusal {
  return { ok: false, status, error };
}

/**
 * The ONLY request headers this guard consults. There is deliberately NO field for
 * X-Forwarded-Host / X-Forwarded-Proto: a forwarded-host header is attacker-influenceable and
 * is never a trust input here. The allowed origin comes solely from serve-state.
 */
export interface PlanningRequestHeaders {
  readonly contentType?: string | undefined;
  readonly origin?: string | undefined;
  readonly secFetchSite?: string | undefined;
  readonly host?: string | undefined;
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/** The hosts (with and without the tailnet HTTPS port) this surface will answer to, derived
 *  ONLY from serve-state's serveHost. */
function allowedHosts(state: ServeStateRecord): Set<string> {
  const host = state.serveHost.trim().toLowerCase();
  return new Set([host, `${host}:${state.servePort}`]);
}

/** The origins this surface will accept, derived ONLY from serve-state (its recorded url plus
 *  the https origin implied by serveHost / servePort). Never from the request. */
function allowedOrigins(state: ServeStateRecord): Set<string> {
  const host = state.serveHost.trim().toLowerCase();
  return new Set([
    normalizeOrigin(state.url),
    `https://${host}`,
    `https://${host}:${state.servePort}`,
  ]);
}

/**
 * Guard one inbound planning request against CSRF / cross-origin forgery. Returns a refusal to
 * fail closed, or `null` to allow the request to proceed to envelope validation.
 *
 * `serveState` is injectable for tests; in production it defaults to the Forge-owned record.
 */
export function guardRemotePlanningRequest(
  headers: PlanningRequestHeaders,
  serveState: ServeStateRecord | null = readServeState(),
): PlanningRefusal | null {
  // (1) Non-simple content type. A simple-request content type is the shape a cross-site form
  //     can forge; requiring application/json forces a preflight the listener answers 405.
  const contentType = headers.contentType?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return refuse(
      415,
      `Content-Type must be application/json (got ${headers.contentType ? `"${headers.contentType}"` : "none"}). ` +
        `A simple-request content type is refused: it is the shape a cross-site form can forge.`,
    );
  }

  // (2) Sec-Fetch-Site — the browser's own provenance statement, unsettable by page script.
  const site = headers.secFetchSite?.trim().toLowerCase();
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return refuse(403, `cross-origin request refused (Sec-Fetch-Site: ${site}). This surface is same-origin only.`);
  }

  // (3) The pin. Absent serve-state → fail closed: no public origin to check against.
  if (serveState === null) {
    return refuse(
      403,
      "planning mutations are refused: Forge has no recorded Serve state to pin the public origin to. " +
        "Run `forge remote tailscale setup` before accepting remote planning commands.",
    );
  }

  const hosts = allowedHosts(serveState);
  const host = headers.host?.trim().toLowerCase();
  if (host === undefined || host === "") {
    return refuse(403, "request refused: the request carries no Host header, and this surface checks it against the Serve hostname.");
  }
  if (!hosts.has(host)) {
    return refuse(
      403,
      `request refused (Host: ${host}). This surface answers planning mutations only at ${[...hosts].join(", ")} ` +
        `(the Serve-fronted hostname); a Host it was not configured for is a rebound name, not this server.`,
    );
  }

  // Origin, checked against the serve-state pin — never against the request's own Host, which a
  // rebinding page satisfies by construction. A browser sends Origin on every cross-origin POST;
  // its absence means a non-browser client, the same trust position the read surface already has.
  const origin = headers.origin?.trim();
  if (origin !== undefined && origin !== "") {
    const origins = allowedOrigins(serveState);
    // `Origin: null` (a sandboxed iframe, a file:// page) normalizes to "null" and is never in
    // the pinned set, so it is refused here.
    if (!origins.has(normalizeOrigin(origin))) {
      return refuse(
        403,
        `cross-origin request refused (Origin: ${origin}). This surface is same-origin only, at ${[...origins].join(", ")}.`,
      );
    }
  }

  return null;
}
