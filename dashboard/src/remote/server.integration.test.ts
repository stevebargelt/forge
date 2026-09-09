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

import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createRemoteBoardServer, maybeStartRemoteBoardFromEnv, REMOTE_PLAN_ENDPOINT, REMOTE_PLAN_AUDIT_ENDPOINT } from "./server.js";
import type { BoundRemoteIdentityResolver, RemoteIdentityResolution, VerifiedIdentity } from "./identity.js";
import type { ProjectRecord } from "../queries.js";
import type { IdentityGrant, IdentityMapping } from "./mapping.js";
import type { ServeStateRecord } from "./tailscale/serve-state.js";
import { applyMigrations, setDbForTest, writeTransaction } from "../../../src/store/db.js";
import { SCHEMA_SQL } from "../../../src/store/schema.js";
import { upsertTicket, getTicket, type TicketRow } from "../../../src/store/tickets.js";
import { queueVersion, queueView } from "../../../src/store/queue.js";
import { resetPublishBarrierForTest } from "../../../src/backlog/snapshot.js";
import { planningAnnotations, remotePlanningAudit } from "../../../src/store/remote-planning.js";

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

test("AC7 (re-anchored): the ONLY mutation route is POST /api/plan; every other non-GET is a flat 405", async () => {
  // PUT/PATCH/DELETE anywhere, and POST to any NON-planning path, are a flat 405 with the
  // surface's method set and NO Access-Control-Allow-* header. (An OPTIONS preflight lands here
  // too, so a cross-origin POST is refused before the real request is sent.)
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const path of ["/api/board", "/api/plan", "/api/queue/enqueue", "/"]) {
      const res = await fetch(`${BASE}${path}`, { method });
      assert.equal(res.status, 405, `${method} ${path} must be refused`);
      assert.equal(res.headers.get("allow"), "GET, POST", "the surface answers only GET and POST");
      assert.equal(res.headers.get("access-control-allow-origin"), null, "no CORS header on the 405 path");
    }
  }
  for (const path of ["/api/board", "/api/queue/enqueue", "/api/projects/classify", "/"]) {
    const res = await fetch(`${BASE}${path}`, { method: "POST" });
    assert.equal(res.status, 405, `POST ${path} (not the planning route) must be refused`);
  }
  // POST to the planning route is the ONE mutation route — but with NO transport adapter wired
  // (the FG-781 default this boot uses) it fails closed at identity resolution: 401, never 405,
  // and never an applied mutation.
  const plan = await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "enqueue", requestId: "r1", ticketId: "FG-1" }),
  });
  assert.equal(plan.status, 401, "no adapter → the planning route fails closed at identity, not a 405");
  assert.equal(plan.headers.get("access-control-allow-origin"), null, "no CORS header on the planning refusal");
  assert.equal((await plan.json()).ok, false, "the refusal carries no applied outcome");
});

test("AC7: no CORS header is ever emitted, so a cross-origin caller fails closed", async () => {
  const res = await fetch(`${BASE}/api/board`, { headers: { origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("AC7/AC5 (structural): the remote server reaches mutation ONLY through the closed store authority", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "server.ts"), "utf8");
  // Scope the scrape to the actual module graph — the `import ... from "…"` statements —
  // so a prose reference to a mutation handler in a comment cannot mask (nor trip) it.
  const importSpecifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  // The local dashboard's CLI-shelling mutation surface must never enter the remote module graph.
  assert.ok(!importSpecifiers.some((s) => /queue-mutation/.test(s)), "the remote server must not import the queue-mutation module");
  const importedNames = [...src.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from/g)].flatMap((m) => m[1]!.split(","));
  assert.ok(
    !importedNames.some((n) => /handleQueueMutation|handleProjectsClassify|isQueueMutationPath/.test(n)),
    "no local (CLI-shell) mutation handler is imported into the remote surface",
  );
  // FG-783: the ONE write path is the atomic store authority, delegated to via the closed envelope
  // + CSRF guards. Prove those are the surface's only mutation entrypoints.
  assert.ok(importSpecifiers.some((s) => /remote-planning\.js$/.test(s)), "the remote server delegates writes to the store authority");
  assert.ok(importedNames.some((n) => /\bapplyRemotePlanningCommand\b/.test(n)), "the store authority is the write entrypoint");
  assert.ok(importedNames.some((n) => /\bvalidatePlanningEnvelope\b/.test(n)), "the body is validated through the closed envelope");
  assert.ok(importedNames.some((n) => /\bguardRemotePlanningRequest\b/.test(n)), "the CSRF/same-origin guard fronts the write");
  // There is EXACTLY ONE non-GET method branch, and it is POST pinned to the planning endpoint.
  const postBranches = [...src.matchAll(/req\.method\s*===\s*["']([A-Z]+)["']/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(postBranches)].filter((m) => m !== "GET"), ["POST"], "the only non-GET method branch is POST");
  assert.ok(/req\.method\s*===\s*"POST"\s*&&\s*path\s*===\s*REMOTE_PLAN_ENDPOINT/.test(src), "POST is pinned to the single planning route");
});

test("an unknown path is a 404, not a fallthrough to any data route", async () => {
  const res = await fetch(`${BASE}/api/queue`);
  assert.equal(res.status, 404, "the local dashboard's data routes are not reachable on the remote surface");
});

// FG-782 step 2: the identity resolver is now uniformly async, and the board handler awaits
// it. Prove the async wiring stays fail-closed end to end — a resolver whose promise REJECTS
// (an adapter's out-of-band whois blowing up, say) must land in the server's fail-closed
// finalizer over a real loopback listener: a closed response with NO project data and NO
// Access-Control header, never a crash, a hang, or an unhandled rejection.
test("async handler: a rejected identity resolution fails closed with no data and no CORS", async () => {
  const rejectingResolver: BoundRemoteIdentityResolver = async () => {
    throw new Error("adapter whois exploded");
  };
  let handlerError: unknown;
  const srv: Server = createRemoteBoardServer({ resolveIdentity: rejectingResolver });
  // If the rejection escaped as an unhandled rejection instead of the finalizer, this catches
  // it and fails the test rather than letting the process warn and continue.
  const onUnhandled = (err: unknown) => {
    handlerError = err;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address() as AddressInfo;
    assert.match(addr.address, /^(127\.|::1$)/, "the ad-hoc server still binds loopback only");
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/board`);
    assert.ok(res.status >= 400, "a rejected resolution is a closed (>=400) response, never a 2xx success");
    assert.equal(res.headers.get("access-control-allow-origin"), null, "no CORS header is opened on the failure path");
    const raw = await res.text();
    assert.ok(!/projectKey|projectDir|"board":\{/.test(raw), "the closed response carries NO project data");
    // Let any stray microtask settle so an escaped rejection would have surfaced.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(handlerError, undefined, "the rejection landed in the server finalizer, not an unhandled rejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// FG-782 step 7: the boot transport REGISTRY, wired through the real boot hook
// (maybeStartRemoteBoardFromEnv). These prove three things end to end over a real loopback
// listener, driving a FAKE daemon (injected confirmPeer) + a FAKE mapping (injected
// loadMapping) through the SAME selectRemoteAdapter path production uses:
//   (a) with FORGE_DASHBOARD_REMOTE_TRANSPORT=tailscale a whois-confirmed, mapped identity
//       passes the identity+scope gate and reaches its single project's board (AC2/AC3);
//   (b) even with a transport wired, the bind stays loopback-only — the remote backend never
//       widens past 127.0.0.1 (AC2);
//   (c) absent the transport selector, no adapter is wired and every request is the FG-781
//       fail-closed 401 refusal — the default is unchanged.
// No real tailnet, no real DB seeding: lookupProject returns a synthetic project record, so an
// authorized read passes the gate and then either serves (200) or degrades on the empty store
// (503) — the load-bearing assertion is that it is NOT the unauthorized refusal.

const TRANSPORT_A_DIR = "/home/steve/checkouts/alpha-transport";

function projectAlpha(): ProjectRecord {
  return {
    key: "repo-alpha",
    label: "Alpha",
    color: "#123456",
    description: null,
    projectDir: TRANSPORT_A_DIR,
    primaryCheckout: TRANSPORT_A_DIR,
    projectDirs: [TRANSPORT_A_DIR],
    checkouts: [],
    lastRunAt: null,
    runCount: 0,
    inFlightCount: 0,
    liveSessions: 0,
  } as unknown as ProjectRecord;
}

/** A fake daemon that confirms ANY non-empty address as one tailnet login — the injected
 *  stand-in for `tailscale whois`. The adapter hands it the Serve-set X-Forwarded-For address
 *  (the tailnet caller), never the loopback socket peer. */
const fakeConfirmPeer = (peerAddr: string) =>
  typeof peerAddr === "string" && peerAddr.trim() !== "" ? { login: "steve@example.com" } : null;

/** The Serve-shaped headers a real Tailscale Serve proxy sets in front of the loopback backend:
 *  the tailnet caller's address and the login Serve authed. The adapter whois-confirms the
 *  address and requires the login to equal that whois answer. */
const SERVE_HEADERS = {
  "x-forwarded-for": "100.101.102.103",
  "tailscale-user-login": "steve@example.com",
};

/** A fake operator mapping authorizing exactly that login for exactly one project, read-only. */
const STEVE_GRANT: IdentityGrant = { login: "steve@example.com", projectKey: "repo-alpha", capabilities: ["read"] };
const fakeMapping: IdentityMapping = {
  lookup: (login) => (login === "steve@example.com" ? STEVE_GRANT : null),
  size: 1,
};

const transportOpened: Server[] = [];
after(() => {
  for (const s of transportOpened) {
    s.closeAllConnections?.();
    s.close();
  }
});

function waitListening(srv: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    if (srv.listening) return resolve(srv.address() as AddressInfo);
    srv.once("listening", () => resolve(srv.address() as AddressInfo));
    srv.once("error", reject);
  });
}

test("FG-782 AC2/AC3: transport='tailscale' + fake daemon → an authorized identity reaches its single project over a loopback listener", async () => {
  const srv = maybeStartRemoteBoardFromEnv(
    {
      FORGE_DASHBOARD_REMOTE: "1",
      FORGE_DASHBOARD_REMOTE_PORT: "0",
      FORGE_DASHBOARD_REMOTE_TRANSPORT: "tailscale",
    } as unknown as NodeJS.ProcessEnv,
    {
      lookupProject: (key) => (key === "repo-alpha" ? projectAlpha() : undefined),
      transportDeps: { confirmPeer: fakeConfirmPeer, loadMapping: () => fakeMapping },
    },
  );
  assert.ok(srv, "with remote mode on and a recognised transport, the boot hook started the listener");
  transportOpened.push(srv!);
  const addr = await waitListening(srv!);

  // (b) AC2: a wired transport must NOT widen the bind — still loopback only.
  assert.match(addr.address, /^(127\.|::1$)/, "even with the tailscale transport selected, the bind stays loopback-only (AC2)");

  // (a) AC2/AC3: the whois-confirmed + mapped identity passes the identity + scope gate. The
  // request arrives on the loopback backend (fetch → 127.0.0.1) carrying the Serve-set headers,
  // exactly as the real Serve proxy fronts it.
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/board`, { headers: SERVE_HEADERS });
  assert.notEqual(res.status, 401, "the confirmed, mapped identity is NOT the no-adapter refusal — the transport adapter resolved it");
  const body = await res.json();
  assert.notEqual(body.state, "unauthorized", "an authorized transport identity is not refused");
  if (body.state === "live" || body.state === "stale") {
    assert.equal(body.board.projectSummary.projectKey, "repo-alpha", "and it gets ONLY its granted project, server-authoritatively");
  }

  // RF-1 end to end: the SAME listener refuses when the Serve-set identity headers are absent or
  // forged. A bare request (no X-Forwarded-For / Tailscale-User-Login) has no tailnet address to
  // confirm → 401; a forged login the fake daemon contradicts (whois says steve, header claims
  // the attacker) → 401. Neither is authorized as the local proxy/host.
  const bare = await fetch(`http://127.0.0.1:${addr.port}/api/board`);
  assert.equal(bare.status, 401, "no Serve headers → no whois-confirmable tailnet caller → refused");
  const forged = await fetch(`http://127.0.0.1:${addr.port}/api/board`, {
    headers: { "x-forwarded-for": "100.101.102.103", "tailscale-user-login": "attacker@evil.example" },
  });
  assert.equal(forged.status, 401, "a Tailscale-User-Login whois contradicts is refused, no data");
  assert.equal((await forged.json()).board, null, "the forged-login refusal carries NO project data");
});

test("FG-782: absent FORGE_DASHBOARD_REMOTE_TRANSPORT, no adapter is wired and every request is the FG-781 401 refusal", async () => {
  const srv = maybeStartRemoteBoardFromEnv(
    // Same fake-daemon deps present — but WITHOUT the transport selector, they are never wired.
    { FORGE_DASHBOARD_REMOTE: "1", FORGE_DASHBOARD_REMOTE_PORT: "0" } as unknown as NodeJS.ProcessEnv,
    {
      lookupProject: (key) => (key === "repo-alpha" ? projectAlpha() : undefined),
      transportDeps: { confirmPeer: fakeConfirmPeer, loadMapping: () => fakeMapping },
    },
  );
  assert.ok(srv, "remote mode is on, so the listener still starts — it just has no adapter");
  transportOpened.push(srv!);
  const addr = await waitListening(srv!);
  assert.match(addr.address, /^(127\.|::1$)/, "the listener binds loopback-only");

  const res = await fetch(`http://127.0.0.1:${addr.port}/api/board`);
  assert.equal(res.status, 401, "no transport selected → no adapter → the FG-781 fail-closed refusal");
  const body = await res.json();
  assert.equal(body.state, "unauthorized", "the five-state envelope reports the refusal");
  assert.equal(body.board, null, "a refusal carries NO project data");
});

// ─── FG-783: the bounded planning POST surface (AC1–AC6) ─────────────────────
//
// Drives the REAL remote board handler (createRemoteBoardServer) against a REAL on-disk store
// (no subprocess, no mocks), with an INJECTED identity resolver, project lookup, and Serve-state
// CSRF pin — the same seams FG-782 uses. node:http is used instead of fetch so a request can set
// the Host / Origin / Sec-Fetch-Site / X-Forwarded-Host headers the Serve proxy (and an attacker)
// would set, which fetch forbids. Every negative asserts BOTH the closed status AND zero mutation.

const PLAN_PK = "pk-fg783-listener";
const PLAN_DIR = "/home/steve/checkouts/fg783-plan";
const PLAN_ACTOR = "operator@ts.net";
const PLAN_TRANSPORT = "tailscale";
const SERVE_HOST = "board.tail1234.ts.net";

// A body evaluateReadiness (FG-382) calls READY, so enqueue applies through the readiness gate.
const PLAN_READY_BODY = [
  "## Problem",
  "Something is wrong.",
  "",
  "## Goal",
  "Make it right.",
  "",
  "## Acceptance Criteria",
  "- it works",
].join("\n");

const SERVE_STATE: ServeStateRecord = {
  version: 1,
  serveHost: SERVE_HOST,
  servePort: 443,
  loopbackPort: 1,
  target: "http://127.0.0.1:1",
  url: `https://${SERVE_HOST}`,
  createArgs: ["x"],
  disableArgs: ["x"],
};

function planTicket(id: string): TicketRow {
  return {
    projectKey: PLAN_PK,
    ticketId: id,
    type: "story",
    status: "active",
    title: `title ${id}`,
    body: PLAN_READY_BODY,
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: "2026-09-08T00:00:00Z",
    importedFrom: null,
  };
}

function planProject(): ProjectRecord {
  return {
    key: PLAN_PK,
    label: "Plan",
    color: "#111111",
    description: null,
    projectDir: PLAN_DIR,
    primaryCheckout: PLAN_DIR,
    projectDirs: [PLAN_DIR],
    checkouts: [],
    lastRunAt: null,
    runCount: 0,
    inFlightCount: 0,
    liveSessions: 0,
  } as unknown as ProjectRecord;
}

function grantResolution(over: Partial<VerifiedIdentity> = {}): RemoteIdentityResolution {
  const identity: VerifiedIdentity = {
    subject: PLAN_ACTOR,
    capabilities: ["read", "plan"],
    projectScope: { projectKey: PLAN_PK, memberDirs: [PLAN_DIR] },
    provenance: { adapter: PLAN_TRANSPORT },
    ...over,
  };
  return { ok: true, identity, ignoredIdentityHeaders: [], confirmedIdentityHeaders: [] };
}

type PostResult = { status: number; json: any; headers: Record<string, string | string[] | undefined>; text: string };

function post(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<PostResult> {
  const { method = "POST", headers = {}, body } = opts;
  const data = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolvePromise({ status: res.statusCode ?? 0, json, headers: res.headers, text });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** The Serve-shaped headers a legitimate same-origin submit carries, with per-call overrides. */
function goodHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    host: SERVE_HOST,
    "content-type": "application/json",
    origin: `https://${SERVE_HOST}`,
    "sec-fetch-site": "same-origin",
    ...over,
  };
}

describe("FG-783: the bounded planning POST surface", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseInstance;
  let prevDb: DatabaseInstance | null;
  let srv: Server;
  let port: number;
  // The resolution the injected resolver hands back — tests swap it to drive identity negatives.
  let planResolution: RemoteIdentityResolution;

  function openOnDisk(path: string): DatabaseInstance {
    const d = new Database(path);
    d.pragma("journal_mode = WAL");
    d.pragma("foreign_keys = ON");
    d.exec(SCHEMA_SQL);
    applyMigrations(d);
    return d;
  }

  function queuedIds(): string[] {
    return queueView(PLAN_PK)
      .filter((e) => e.queued)
      .map((e) => e.ticketId);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fg783-listener-"));
    dbPath = join(dir, "forge.db");
    db = openOnDisk(dbPath);
    prevDb = setDbForTest(db);
    resetPublishBarrierForTest();
    writeTransaction(() => {
      for (const id of ["FG-1", "FG-2", "FG-3"]) upsertTicket(planTicket(id));
    });
    planResolution = grantResolution();
    srv = createRemoteBoardServer({
      resolveIdentity: (async () => planResolution) as BoundRemoteIdentityResolver,
      lookupProject: (key) => (key === PLAN_PK ? planProject() : undefined),
      readServeState: () => SERVE_STATE,
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });

  afterEach(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    setDbForTest(prevDb as DatabaseInstance);
    try {
      if (db.open) db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1: each action applies through its authority and returns the recorded outcome ──
  test("AC1: a plan-granted identity applies each of the four actions", async () => {
    // enqueue (readiness gate)
    for (const id of ["FG-1", "FG-2", "FG-3"]) {
      const res = await post(port, REMOTE_PLAN_ENDPOINT, {
        headers: goodHeaders(),
        body: { action: "enqueue", requestId: `enq-${id}`, ticketId: id },
      });
      assert.equal(res.status, 200, `enqueue ${id} applies`);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.outcome, "applied");
      assert.equal(res.json.replayed, false);
    }
    assert.deepEqual(queuedIds(), ["FG-1", "FG-2", "FG-3"]);

    // change-rank (relative before/after → position, under a queueVersion CAS)
    const vRank = queueVersion(PLAN_PK);
    const rank = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "change-rank", requestId: "rank-1", ticketId: "FG-3", reference: "FG-1", placement: "before", expectVersion: vRank },
    });
    assert.equal(rank.status, 200, "change-rank applies");
    assert.equal(rank.json.outcome, "applied");
    assert.deepEqual(queuedIds(), ["FG-3", "FG-1", "FG-2"], "FG-3 ranked before FG-1");

    // reorder-queue (whole-order permutation, under a queueVersion CAS)
    const vReorder = queueVersion(PLAN_PK);
    const reorder = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "reorder-queue", requestId: "reorder-1", order: ["FG-1", "FG-2", "FG-3"], expectVersion: vReorder },
    });
    assert.equal(reorder.status, 200, "reorder-queue applies");
    assert.deepEqual(queuedIds(), ["FG-1", "FG-2", "FG-3"]);

    // dequeue (retains rank)
    const dequeue = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "dequeue", requestId: "deq-1", ticketId: "FG-2" },
    });
    assert.equal(dequeue.status, 200, "dequeue applies");
    assert.deepEqual(queuedIds(), ["FG-1", "FG-3"]);

    // append-annotation (bound to the ticket revision)
    const rev = getTicket(PLAN_PK, "FG-1")!.revision!;
    const annotate = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "append-annotation", requestId: "an-1", ticketId: "FG-1", ticketRevision: rev, body: "ship before the demo" },
    });
    assert.equal(annotate.status, 200, "append-annotation applies");
    assert.equal(planningAnnotations(PLAN_PK, "FG-1").length, 1);

    // AC1: the audit ledger recorded actor / transport / request-id / precondition / outcome.
    const audit = remotePlanningAudit(PLAN_PK);
    assert.ok(audit.length >= 6, "every applied command left an audit row");
    for (const row of audit) {
      assert.equal(row.actor, PLAN_ACTOR, "actor is the SERVER-AUTHORITATIVE subject, never the body");
      assert.equal(row.transport, PLAN_TRANSPORT, "transport comes from the identity provenance");
      assert.equal(row.projectKey, PLAN_PK, "project key is server-authoritative");
    }
  });

  // ── AC2: replay returns the recorded outcome without re-applying ──
  test("AC2: a replayed request-id returns the recorded outcome and re-applies nothing", async () => {
    const first = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "enqueue", requestId: "dup-1", ticketId: "FG-1" },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.replayed, false);
    assert.deepEqual(queuedIds(), ["FG-1"]);
    const auditAfterFirst = remotePlanningAudit(PLAN_PK).length;

    const replay = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "enqueue", requestId: "dup-1", ticketId: "FG-1" },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true, "the redelivery is served from the ledger");
    assert.equal(replay.json.outcome, "applied");
    assert.deepEqual(queuedIds(), ["FG-1"], "replay did not enqueue twice");
    assert.equal(remotePlanningAudit(PLAN_PK).length, auditAfterFirst, "replay added no new ledger row");
  });

  // ── AC3: a stale precondition refuses with zero mutation and a safe summary ──
  test("AC3: a stale queueVersion refuses with the current safe summary and no mutation", async () => {
    for (const id of ["FG-1", "FG-2", "FG-3"]) {
      await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: { action: "enqueue", requestId: `e-${id}`, ticketId: id } });
    }
    const stale = queueVersion(PLAN_PK);
    // Advance the queue so `stale` is no longer current.
    await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "reorder-queue", requestId: "advance", order: ["FG-2", "FG-1", "FG-3"], expectVersion: stale },
    });
    const orderNow = queuedIds();

    const refused = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "reorder-queue", requestId: "stale-1", order: ["FG-3", "FG-2", "FG-1"], expectVersion: stale },
    });
    assert.equal(refused.status, 409, "a stale precondition is a conflict, not a success");
    assert.equal(refused.json.ok, false);
    assert.equal(refused.json.outcome, "refused");
    assert.equal(refused.json.summary.queueVersion, queueVersion(PLAN_PK), "the safe summary carries the CURRENT version to re-read");
    assert.deepEqual(queuedIds(), orderNow, "the stale reorder mutated nothing");
  });

  // ── AC4: a read-only identity cannot mutate ──
  test("AC4: a read-only (no 'plan') identity is refused with no mutation", async () => {
    planResolution = grantResolution({ capabilities: ["read"] });
    const res = await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: { action: "enqueue", requestId: "ro-1", ticketId: "FG-1" } });
    assert.equal(res.status, 403, "a read grant never implies plan");
    assert.equal(res.json.ok, false);
    assert.deepEqual(queuedIds(), [], "no mutation");
    assert.equal(remotePlanningAudit(PLAN_PK).length, 0);
  });

  // ── AC4: an unauthorized / no-adapter request fails closed ──
  test("AC4: no verified identity (no adapter) fails closed", async () => {
    planResolution = { ok: false, reason: "no-adapter", ignoredIdentityHeaders: [] };
    const res = await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: { action: "enqueue", requestId: "na-1", ticketId: "FG-1" } });
    assert.equal(res.status, 401);
    assert.deepEqual(queuedIds(), []);
    assert.equal(remotePlanningAudit(PLAN_PK).length, 0);
  });

  // ── AC4: a cross-project claim is refused (server-authoritative scope) ──
  test("AC4: a cross-project scope claim is refused", async () => {
    planResolution = grantResolution({ projectScope: { projectKey: PLAN_PK, memberDirs: ["/home/steve/checkouts/some-other-project"] } });
    const res = await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: { action: "enqueue", requestId: "xp-1", ticketId: "FG-1" } });
    assert.equal(res.status, 401, "claimed dirs not within the granted project's own dirs → refused");
    assert.deepEqual(queuedIds(), []);
  });

  // ── AC4: CSRF — cross-site Sec-Fetch-Site ──
  test("AC4: a cross-site Sec-Fetch-Site is refused", async () => {
    const res = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders({ "sec-fetch-site": "cross-site" }),
      body: { action: "enqueue", requestId: "csrf-1", ticketId: "FG-1" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(queuedIds(), []);
  });

  // ── AC4: CSRF — a simple content type forces the guard closed ──
  test("AC4: a simple (form-forgeable) content type is refused", async () => {
    const res = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders({ "content-type": "text/plain" }),
      body: { action: "enqueue", requestId: "csrf-2", ticketId: "FG-1" },
    });
    assert.equal(res.status, 415);
    assert.deepEqual(queuedIds(), []);
  });

  // ── AC4: CSRF — a spoofed Origin, and a forged X-Forwarded-Host, cannot stand in for Serve ──
  test("AC4: a spoofed Origin is refused", async () => {
    const res = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders({ origin: "https://evil.example" }),
      body: { action: "enqueue", requestId: "csrf-3", ticketId: "FG-1" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(queuedIds(), []);
  });

  test("AC4: a forged X-Forwarded-Host cannot stand in for the Serve hostname", async () => {
    // The guard pins Host to the serve-state hostname and NEVER reads X-Forwarded-Host. A request
    // whose real Host is anything but the Serve hostname is refused, no matter what XFH claims.
    const res = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders({ host: "attacker.example", "x-forwarded-host": SERVE_HOST }),
      body: { action: "enqueue", requestId: "csrf-4", ticketId: "FG-1" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(queuedIds(), []);
  });

  // ── AC4: CSRF — a preflight gets 405 and NO Access-Control-Allow-* header ──
  test("AC4: a CORS preflight OPTIONS gets 405 with no Access-Control-Allow-* header", async () => {
    const res = await post(port, REMOTE_PLAN_ENDPOINT, {
      method: "OPTIONS",
      headers: goodHeaders({ "access-control-request-method": "POST", origin: "https://evil.example" }),
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
  });

  // ── AC4: a malformed body fails closed ──
  test("AC4: a malformed JSON body is refused", async () => {
    const res = await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: "{ not json" });
    assert.equal(res.status, 400);
    assert.deepEqual(queuedIds(), []);
  });

  // ── AC4: an oversized body fails closed ──
  test("AC4: an oversized body is refused (413)", async () => {
    const big = { action: "append-annotation", requestId: "big-1", ticketId: "FG-1", ticketRevision: 1, body: "x".repeat(70 * 1024) };
    const res = await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: big });
    assert.equal(res.status, 413);
    assert.deepEqual(queuedIds(), []);
  });

  // ── AC4: a body that supplies a server-authoritative key is refused ──
  test("AC4: a body-supplied server-authoritative key is refused, not honoured", async () => {
    const res = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "enqueue", requestId: "forge-1", ticketId: "FG-1", actor: "root@evil", projectKey: "pk-other" },
    });
    assert.equal(res.status, 400, "a forged actor/projectKey is refused loudly, never silently used");
    assert.deepEqual(queuedIds(), []);
  });

  // ── AC5/AC6: every named excluded action is unreachable even fabricated as a POST ──
  test("AC6: every excluded action fabricated as a POST is unreachable", async () => {
    const excluded = [
      "complete",
      "close",
      "gate",
      "gate-override",
      "override",
      "run",
      "campaign",
      "merge",
      "publish",
      "review",
      "disposition",
      "terminal",
      "process",
      "cleanup",
      "credential",
      "raci",
      "routing",
      "model-policy",
      "queue enqueue", // an attempt to smuggle a CLI verb string
      "../../etc/passwd",
    ];
    for (const action of excluded) {
      const res = await post(port, REMOTE_PLAN_ENDPOINT, {
        headers: goodHeaders(),
        body: { action, requestId: `x-${action.replace(/[^a-z]/gi, "")}`, ticketId: "FG-1" },
      });
      assert.equal(res.status, 400, `the excluded action ${JSON.stringify(action)} is refused by the closed registry`);
    }
    assert.deepEqual(queuedIds(), [], "no excluded action mutated anything");
    assert.equal(remotePlanningAudit(PLAN_PK).length, 0, "no excluded action reached the store authority");
  });

  // ── RF-2: a revisioned ticket annotates through the real route, and a stale revision refuses ──
  test("RF-2: an annotation carrying the loaded ticket revision applies; a stale revision refuses", async () => {
    const rev = getTicket(PLAN_PK, "FG-1")!.revision!;
    const ok = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "append-annotation", requestId: "rev-ok", ticketId: "FG-1", ticketRevision: rev, body: "ship before the demo" },
    });
    assert.equal(ok.status, 200, "annotating at the current revision applies");
    assert.equal(planningAnnotations(PLAN_PK, "FG-1").length, 1);

    // Supersede the ticket, then submit against the now-stale revision the board had loaded.
    writeTransaction(() => upsertTicket({ ...planTicket("FG-1"), body: PLAN_READY_BODY + "\n- and more" }));
    const currentRev = getTicket(PLAN_PK, "FG-1")!.revision!;
    assert.notEqual(rev, currentRev);
    const stale = await post(port, REMOTE_PLAN_ENDPOINT, {
      headers: goodHeaders(),
      body: { action: "append-annotation", requestId: "rev-stale", ticketId: "FG-1", ticketRevision: rev, body: "stale note" },
    });
    assert.equal(stale.status, 409, "a superseded revision is a conflict, not a success");
    assert.equal(stale.json.outcome, "refused");
    assert.equal(planningAnnotations(PLAN_PK, "FG-1").length, 1, "the stale annotation wrote nothing");
    assert.equal(stale.json.summary.ticketRevision, currentRev, "the safe summary names the current revision to re-read");
  });

  // ── RF-1: the same-project, read-gated planning audit read ──
  test("RF-1: GET /api/plan/audit returns only this project's rows, gated on 'read'", async () => {
    for (const id of ["FG-1", "FG-2"]) {
      await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: { action: "enqueue", requestId: `aud-${id}`, ticketId: id } });
    }
    const audit = await post(port, REMOTE_PLAN_AUDIT_ENDPOINT, { method: "GET", headers: { host: SERVE_HOST } });
    assert.equal(audit.status, 200);
    assert.equal(audit.json.ok, true);
    assert.equal(audit.json.projectKey, PLAN_PK);
    assert.equal(audit.json.rows.length, 2, "the audit lists this project's ledger rows");
    for (const row of audit.json.rows) {
      assert.equal(row.actor, PLAN_ACTOR);
      assert.equal(row.transport, PLAN_TRANSPORT);
      assert.ok(["enqueue"].includes(row.action));
      assert.ok(typeof row.createdAt === "string" && row.createdAt.length > 0);
      // The redacted DTO carries no secrets/paths and no server-internal keys.
      for (const forbidden of ["projectKey", "resultSummary", "result_summary", "secret", "token"]) {
        assert.ok(!(forbidden in row), `the audit row must not carry ${forbidden}`);
      }
    }

    // A read-only identity may still read the audit (it is a READ). A no-plan grant is enough.
    planResolution = grantResolution({ capabilities: ["read"] });
    const readOnlyAudit = await post(port, REMOTE_PLAN_AUDIT_ENDPOINT, { method: "GET", headers: { host: SERVE_HOST } });
    assert.equal(readOnlyAudit.status, 200, "the audit is gated on 'read', not 'plan'");

    // With NO read capability the audit is refused.
    planResolution = grantResolution({ capabilities: ["plan"] });
    const noRead = await post(port, REMOTE_PLAN_AUDIT_ENDPOINT, { method: "GET", headers: { host: SERVE_HOST } });
    assert.equal(noRead.status, 403, "a plan-only identity without 'read' cannot read the audit");
  });

  // ── RF-1: the audit read is scoped to the identity's own project ──
  test("RF-1: the audit read never returns another project's rows", async () => {
    // Seed a foreign project's ledger row directly through the store authority.
    const OTHER = "pk-other-audit";
    writeTransaction(() => upsertTicket({ ...planTicket("OT-1"), projectKey: OTHER }));
    const { applyRemotePlanningCommand } = await import("../../../src/store/remote-planning.js");
    applyRemotePlanningCommand({ requestId: "other-1", actor: "someone@else", transport: "tailscale", projectKey: OTHER, action: "enqueue", targetId: "OT-1", at: "2026-09-08T00:00:00Z" });

    // This identity is scoped to PLAN_PK; its audit read must not see OTHER's row.
    await post(port, REMOTE_PLAN_ENDPOINT, { headers: goodHeaders(), body: { action: "enqueue", requestId: "mine-1", ticketId: "FG-1" } });
    const audit = await post(port, REMOTE_PLAN_AUDIT_ENDPOINT, { method: "GET", headers: { host: SERVE_HOST } });
    assert.equal(audit.status, 200);
    assert.equal(audit.json.projectKey, PLAN_PK);
    assert.ok(audit.json.rows.every((r: { targetId: string }) => r.targetId !== "OT-1"), "no foreign project row leaks into the audit");
    assert.ok(audit.json.rows.some((r: { requestId: string }) => r.requestId === "mine-1"), "this project's own row is present");
  });
});
