// FG-781 AC1 — with remote mode DISABLED (the default), no remote route or asset is served,
// and the local dashboard is byte-for-byte unchanged against the baseline where the remote
// module is never started.
//
// The baseline IS remote-off: the boot hook (../server.ts) calls maybeStartRemoteBoardFromEnv
// with no FORGE_DASHBOARD_REMOTE set, so it returns null and binds nothing. This test boots
// the real local server exactly that way and proves:
//   (a) no remote listener exists — the exported hook result is null;
//   (b) the remote board's paths are NOT served by the local server — the board endpoint is
//       the local server's own 404, and the remote asset prefix falls through to the local
//       SPA shell, never the remote board;
//   (c) the local dashboard's own responses/headers are intact (the shell + its /client/
//       importmap under the local CSP), i.e. the additive boot hook changed nothing.
//
// Mutation-sensitive: make the boot hook run when disabled, or fold a remote route into the
// local server, and (a)/(b) go RED.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18781;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "fg781-mode-off-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
// DELIBERATELY not set: FORGE_DASHBOARD_REMOTE. Also actively clear it in case the ambient
// env carries it, so "disabled" is the real state under test.
delete process.env.FORGE_DASHBOARD_REMOTE;
delete process.env.FORGE_DASHBOARD_REMOTE_PORT;

const serverMod = await import("../server.js");

after(() => {
  serverMod.server.closeAllConnections?.();
  serverMod.server.close();
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

test("AC1: with remote mode disabled, no remote listener is started", () => {
  assert.equal(serverMod.remoteBoardServer, null, "the mode-gated boot hook must return null when remote mode is off");
});

test("AC1: the remote board endpoint is NOT a route on the local server (its own 404)", async () => {
  const res = await fetch(`${BASE}/api/board`);
  assert.equal(res.status, 404, "the local server has no /api/board route");
  const body = await res.json();
  assert.deepEqual(body, { error: "not found" }, "it is the local server's ordinary unknown-/api/ 404, not a remote envelope");
  assert.ok(!("state" in (body as object)), "no five-state remote envelope is served off the local surface");
});

test("AC1: the remote asset prefix is NOT served by the local server", async () => {
  const res = await fetch(`${BASE}/remote-client/board.js`);
  // A non-/api/ path on the local server falls through to its SPA shell (existing
  // behaviour), NOT the remote board asset — proving the remote asset set is absent here.
  const body = await res.text();
  assert.ok(!body.includes("__REMOTE_BOARD__"), "the local server must not serve the remote board bootstrap");
  assert.ok(body.includes("/client/main.js"), "the local server serves its own SPA shell for unknown non-/api/ paths, unchanged");
});

test("AC1: the local dashboard shell + headers are unchanged (additive hook changed nothing)", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp && /script-src 'self'/.test(csp), "the local CSP is intact");
  const body = await res.text();
  assert.ok(body.includes("/client/main.js"), "the local shell still loads its own client bundle");
  assert.ok(body.includes('type="importmap"'), "the local shell still carries its vendored importmap");
  assert.ok(body.includes("forge dashboard"), "the local shell title is unchanged");
});
