// FG-580: the dashboard's HTML responses must carry a Content-Security-Policy that makes
// "no CDN-executed JS" a RUNTIME invariant (operator intent: a self-contained release must
// not execute CDN code). Boots the real server and asserts the served header + that the
// inline importmap is admitted under it (its nonce matches the header's), so the page still
// boots. The full browser boot under this CSP is AC-6 (offline-boot.test.ts, host tier).
//
// Mutation-sensitive:
//  - Drop the CSP header (revert serveShell to a plain writeHead) → the header-present
//    assertion goes RED.
//  - Weaken script-src away from 'self' (e.g. add 'unsafe-inline'/CDN) → the script-src
//    assertion goes RED.
//  - Fail to thread the nonce into renderShell (importmap emitted without a nonce) → the
//    nonce-match assertion goes RED, catching a CSP that would silently break the app.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18771;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-csp-rt-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`Server on port ${TEST_PORT} did not start within ${ms}ms`);
}

await waitForServer();

test("GET / carries a Content-Security-Policy that restricts script-src to 'self'", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, "the HTML response must carry a Content-Security-Policy header");
  assert.match(csp!, /script-src 'self'/, "script-src must be pinned to 'self' — no CDN/unsafe-inline");
  assert.doesNotMatch(csp!, /unsafe-inline|https?:\/\//, "script-src must not admit inline strings or a remote origin");
});

test("the served importmap is admitted by the CSP — its nonce matches the header (page still boots)", async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get("content-security-policy")!;
  const body = await res.text();

  const headerNonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(headerNonce, "the CSP must carry a script nonce for the inline importmap");

  const importmapNonce = body.match(/<script type="importmap" nonce="([^"]+)">/)?.[1];
  assert.ok(importmapNonce, "the inline importmap must carry a nonce attribute");
  assert.equal(importmapNonce, headerNonce, "the importmap nonce must match the CSP nonce — else the browser blocks it and the app never boots");
});

test("each response gets a fresh nonce (a nonce is not a reusable constant)", async () => {
  const a = (await fetch(`${BASE}/`)).headers.get("content-security-policy")!.match(/'nonce-([^']+)'/)?.[1];
  const b = (await fetch(`${BASE}/`)).headers.get("content-security-policy")!.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(a && b);
  assert.notEqual(a, b, "a per-response nonce must differ between requests");
});
