// FG-781 AC2 / AC6 / AC7 — with remote mode ENABLED but NO transport adapter wired (the
// FG-781 default), the dedicated remote board:
//   * AC2: refuses every API request without returning project data — the board endpoint
//     answers with the `unauthorized` envelope (board: null), and the shell it serves
//     carries no project payload;
//   * AC6: fails closed even when the request bears spoofed X-Forwarded-* / Tailscale /
//     Cloudflare-style identity/proxy headers — none of them establishes identity, and none
//     is echoed back;
//   * AC7: exposes NO mutation route — every non-GET method is a flat 405, there is no queue/
//     classify path, and the module imports nothing that could mutate;
//   * loopback: enabling remote mode opens ONLY a loopback listener, never a non-loopback
//     bind by itself.
//
// This boots the REAL local server module with remote mode set in the env, so it exercises
// the actual boot hook (../server.ts → maybeStartRemoteBoardFromEnv), not a hand-built
// server. `remoteBoardServer` is the dedicated listener that hook returned.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const LOCAL_PORT = 18783;
const REMOTE_PORT = 18782;

process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "fg781-remote-on-"));
process.env.PORT = String(LOCAL_PORT);
process.env.HOST = "127.0.0.1";
process.env.FORGE_DASHBOARD_REMOTE = "1";
process.env.FORGE_DASHBOARD_REMOTE_PORT = String(REMOTE_PORT);

const serverMod = await import("../server.js");
const BASE = `http://127.0.0.1:${REMOTE_PORT}`;

after(() => {
  serverMod.server.closeAllConnections?.();
  serverMod.server.close();
  serverMod.remoteBoardServer?.closeAllConnections?.();
  serverMod.remoteBoardServer?.close();
});

async function waitFor(url: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`${url} did not become reachable within ${ms}ms`);
}

await waitFor(`${BASE}/`);

// Markers that must NEVER appear in any response body — spoofed identity/proxy values.
const SPOOFED = {
  "x-forwarded-for": "203.0.113.9",
  "x-forwarded-user": "attacker@evil.example",
  "x-forwarded-email": "attacker@evil.example",
  "tailscale-user-login": "spoofed@evil.example",
  "cf-access-authenticated-user-email": "spoofed-cf@evil.example",
  "cf-access-jwt-assertion": "FORGED.JWT.TOKEN",
};

test("enabling remote mode opens a listener, and ONLY on loopback", () => {
  assert.ok(serverMod.remoteBoardServer, "remote mode enabled → the boot hook started a remote listener");
  const addr = serverMod.remoteBoardServer!.address() as AddressInfo;
  assert.equal(addr.port, REMOTE_PORT, "it binds the configured remote loopback port");
  assert.match(addr.address, /^(127\.|::1$)/, "it binds ONLY a loopback address — never a public bind by itself");
});

test("AC2: the board endpoint refuses without project data (no adapter → unauthorized)", async () => {
  const res = await fetch(`${BASE}/api/board`);
  assert.equal(res.status, 401, "no verified identity → HTTP-level refusal");
  const body = await res.json();
  assert.equal(body.state, "unauthorized", "the five-state envelope reports the refusal honestly");
  assert.equal(body.board, null, "a refusal carries NO project data");
  assert.ok(typeof body.generatedAt === "string" && typeof body.generation === "number", "the envelope still carries its freshness stamp");
});

test("AC2: the shell is served but carries no project data", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp && /script-src 'self'/.test(csp), "the remote shell carries its own nonce CSP");
  const body = await res.text();
  assert.ok(!body.includes("/client/"), "the remote shell serves no CLIENT_DIR asset");
  assert.ok(!/projectKey|projectDir|repo-/.test(body), "the shell embeds no project scope or identity");
});

test("AC6: spoofed proxy/identity headers still fail closed and are never echoed", async () => {
  const res = await fetch(`${BASE}/api/board`, { headers: SPOOFED });
  assert.equal(res.status, 401, "spoofed headers do not establish identity");
  const raw = await res.text();
  assert.ok(JSON.parse(raw).board === null, "still no project data");
  for (const value of Object.values(SPOOFED)) {
    assert.ok(!raw.includes(value), `a spoofed identity value was reflected into the response: ${value}`);
  }
});

test("AC7: no mutation route — every non-GET method is a flat 405", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/api/board", "/api/queue/enqueue", "/api/projects/classify", "/"]) {
      const res = await fetch(`${BASE}${path}`, { method });
      assert.equal(res.status, 405, `${method} ${path} must be refused (no mutation surface)`);
      assert.equal(res.headers.get("allow"), "GET", "the only method this surface answers is GET");
    }
  }
});

test("AC7: no CORS header is ever emitted, so a cross-origin caller fails closed", async () => {
  const res = await fetch(`${BASE}/api/board`, { headers: { origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("AC7 (structural): the remote server module imports no mutation code path", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "server.ts"), "utf8");
  // Scope the scrape to the actual module graph — the `import ... from "…"` statements —
  // so a prose reference to a mutation handler in a comment cannot mask (nor trip) it.
  const importSpecifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  assert.ok(!importSpecifiers.some((s) => /queue-mutation/.test(s)), "the remote server must not import the queue-mutation module");
  const importedNames = [...src.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from/g)].flatMap((m) => m[1]!.split(","));
  assert.ok(
    !importedNames.some((n) => /handleQueueMutation|handleProjectsClassify|isQueueMutationPath/.test(n)),
    "no local mutation handler is imported into the remote surface",
  );
  // The ONLY method branch is the GET gate; there is no method === "POST" (etc.) route.
  assert.ok(!/method\s*===\s*["'](POST|PUT|PATCH|DELETE)["']/.test(src), "no non-GET method branch exists");
});

test("an unknown path is a 404, not a fallthrough to any data route", async () => {
  const res = await fetch(`${BASE}/api/queue`);
  assert.equal(res.status, 404, "the local dashboard's data routes are not reachable on the remote surface");
});
