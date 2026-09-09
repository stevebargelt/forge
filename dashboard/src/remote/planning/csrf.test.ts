// FG-783 (step 4) UNIT tier — the CSRF / same-origin guard (AC4 CSRF/spoofed-origin, pure).
// No socket, no filesystem: serve-state is INJECTED, so the whole cross-origin rule is
// exercised as a pure function of (headers, serve-state). The FG-782 read path is untouched.
//
// Load-bearing negatives: a cross-site Sec-Fetch-Site, a simple content type, a mismatched
// Origin, a Host that isn't the Serve hostname, and — the DNS-rebind case — the guard PINS to
// the serve-state hostname and never to anything the request could forge (there is no
// X-Forwarded-Host parameter at all).

import { test } from "node:test";
import assert from "node:assert/strict";

import { guardRemotePlanningRequest, type PlanningRequestHeaders } from "./csrf.js";
import type { ServeStateRecord } from "../tailscale/serve-state.js";

/** A serve-state record as `forge remote tailscale setup` would have written. Holds no secret. */
const SERVE_STATE: ServeStateRecord = Object.freeze({
  version: 1,
  serveHost: "board.tailc0ffee.ts.net",
  servePort: 443,
  loopbackPort: 8099,
  target: "http://127.0.0.1:8099",
  url: "https://board.tailc0ffee.ts.net",
  createArgs: ["serve", "https", "/", "http://127.0.0.1:8099"],
  disableArgs: ["serve", "https", "/", "off"],
});

/** A well-formed same-origin request through Serve: JSON content type, same-origin fetch, Host
 *  and Origin equal to the pinned Serve hostname. */
function goodHeaders(over: Partial<PlanningRequestHeaders> = {}): PlanningRequestHeaders {
  return {
    contentType: "application/json",
    secFetchSite: "same-origin",
    host: "board.tailc0ffee.ts.net",
    origin: "https://board.tailc0ffee.ts.net",
    ...over,
  };
}

function assertRefused(headers: PlanningRequestHeaders, status: number, state: ServeStateRecord | null = SERVE_STATE): void {
  const r = guardRemotePlanningRequest(headers, state);
  assert.ok(r, "expected a refusal");
  assert.equal(r!.status, status);
}

test("a well-formed same-origin request through Serve is allowed", () => {
  assert.equal(guardRemotePlanningRequest(goodHeaders(), SERVE_STATE), null, "the pinned same-origin request passes");
});

test("a user-initiated request (Sec-Fetch-Site: none) with a matching Host is allowed", () => {
  assert.equal(guardRemotePlanningRequest(goodHeaders({ secFetchSite: "none" }), SERVE_STATE), null);
});

test("a simple content type is refused (415) — the CSRF preflight lever", () => {
  assertRefused(goodHeaders({ contentType: "text/plain" }), 415);
  assertRefused(goodHeaders({ contentType: "application/x-www-form-urlencoded" }), 415);
  assertRefused(goodHeaders({ contentType: undefined }), 415);
});

test("a cross-site / same-site Sec-Fetch-Site is refused (403)", () => {
  assertRefused(goodHeaders({ secFetchSite: "cross-site" }), 403);
  assertRefused(goodHeaders({ secFetchSite: "same-site" }), 403);
});

test("a mismatched Origin is refused (403) — pinned to the Serve hostname, not the request", () => {
  assertRefused(goodHeaders({ origin: "https://evil.example" }), 403);
  assertRefused(goodHeaders({ origin: "http://board.tailc0ffee.ts.net" }), 403); // wrong scheme
  assertRefused(goodHeaders({ origin: "null" }), 403); // sandboxed iframe / file://
});

test("a Host that isn't the Serve hostname is refused (403) — DNS-rebind guard", () => {
  assertRefused(goodHeaders({ host: "attacker.example" }), 403);
  assertRefused(goodHeaders({ host: "127.0.0.1:8099" }), 403); // the loopback bind is NOT the pin
  assertRefused(goodHeaders({ host: undefined }), 403);
});

test("the pin comes ONLY from serve-state: a forged forwarded host cannot widen it", () => {
  // The guard's signature has no X-Forwarded-Host field, so a forwarded host is structurally
  // unable to enter. Even a request whose Host names the attacker is refused; the ALLOWED set
  // is derived solely from the injected serve-state, whatever the request claims elsewhere.
  const state: ServeStateRecord = { ...SERVE_STATE, serveHost: "real-board.tailc0ffee.ts.net", url: "https://real-board.tailc0ffee.ts.net" };
  // A request pretending (via Host) to be the old hostname is refused against the real pin.
  assertRefused(goodHeaders({ host: "board.tailc0ffee.ts.net", origin: "https://board.tailc0ffee.ts.net" }), 403, state);
  // Only the genuine Serve hostname passes.
  assert.equal(
    guardRemotePlanningRequest({ contentType: "application/json", secFetchSite: "same-origin", host: "real-board.tailc0ffee.ts.net", origin: "https://real-board.tailc0ffee.ts.net" }, state),
    null,
  );
});

test("absent serve-state fails closed (403) — no public origin to pin to", () => {
  assertRefused(goodHeaders(), 403, null);
});

test("the Serve hostname with its explicit :443 port is accepted (Host and Origin)", () => {
  assert.equal(
    guardRemotePlanningRequest(goodHeaders({ host: "board.tailc0ffee.ts.net:443", origin: "https://board.tailc0ffee.ts.net:443" }), SERVE_STATE),
    null,
  );
});
