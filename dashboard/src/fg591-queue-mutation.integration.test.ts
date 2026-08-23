// FG-591 step 12 — the dashboard's FIRST WRITE SURFACE, exercised as a real HTTP
// server against a real store, a real registry and a real `forge` binary.
//
// WHAT THIS SUITE HAS TO PROVE, and why each case is shaped the way it is:
//
//  1. A CROSS-ORIGIN OR SIMPLE-REQUEST POST IS REFUSED BEFORE ANY SUBPROCESS STARTS.
//     "Before" is the whole claim, so it is asserted twice, two ways: over real HTTP
//     with a RECORDING BINARY (the call log must be empty), and through the handler
//     directly with a project resolver that FAILS THE TEST IF IT IS CALLED — the
//     registry read is itself a bounded `git` probe, so a guard that ran after it
//     would have spawned something before refusing.
//
//  2. EACH ROUTE SPAWNS EXACTLY ONE NAMED `forge queue` VERB WITH THE EXPECTED ARGV
//     AND NOTHING ELSE. The recording binary logs its cwd and every argument
//     separately, so an extra flag, a lost `--expect-version` or a smuggled operand
//     is visible rather than swallowed by string joining.
//
//  3. NO ROUTE CAN ARM DISPATCH OR SET CAPACITY (D2). Asserted over the ROUTE TABLE
//     and the closed verb set — data, not a promise — and driven: an arm-shaped path
//     is a 404 and an arm-shaped payload is a 400, both with an empty call log.
//
//  4. THE DASHBOARD WRITES NO DB ROW ON ANY PATH. Every route is driven with the
//     recording binary (which writes nothing) and the store's bytes are compared
//     before and after.
//
//  5. THE FG-679 SERVING-PATH GUARD IS NEITHER WIDENED NOR NARROWED. Its own file is
//     read and asserted: it still covers exactly its three paths, still keeps its
//     /api/in-flight negative control, and has NOT been extended to cover a mutation
//     route (which would make it red) — and it still passes on its own, which is a
//     separate command this suite does not fake by re-implementing.
//
// The last two tests drive the REAL co-located `bin/forge` — no stub — so the argv
// this surface builds is proven against the actual CLI: a live enqueue lands a real
// queue_membership row, and a stale --expect-version refuses by name with the CLI's
// own words reaching the operator.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";

const TEST_PORT = 18801;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SAME_ORIGIN = `http://127.0.0.1:${TEST_PORT}`;

// --- env before ANY forge module is evaluated (the fg591-queue-routes precedent):
// both the store handle and the dashboard's read-only handle resolve FORGE_HOME per
// call, and both must land on this test's private store. ---
const tmpHome = mkdtempSync(join(tmpdir(), "fg591-queue-mut-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_DB_PATH = join(tmpHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg591-mut-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { upsertTicket, setStorageMode } = await import("../../src/store/tickets.js");
const { rankTicket, enqueueTicket, queueView, queueVersion } = await import("../../src/store/queue.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const { authorityTestkitBinEnv } = await import("../../src/backlog/container-authority.testkit-spawn.js");
const {
  QUEUE_MUTATION_ROUTES,
  QUEUE_MUTATION_FORGE_VERBS,
  buildForgeArgv,
  dashboardOrigins,
  guardBindAddress,
  guardMutationRequest,
  handleQueueMutation,
  resolveForgeBinary,
} = await import("./queue-mutation.js");

const PK = "pk-fg591-mutation";
const AT = "2026-08-06T09:00:00Z";

// A body evaluateReadiness (FG-382) calls READY: Problem, Goal, bulleted AC.
const READY_BODY = ["## Problem", "It hurts.", "", "## Goal", "Stop it.", "", "## Acceptance Criteria", "- it works"].join("\n");

function fixtureCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg591-mut-proj-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg591-mutation.git"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const projectDir = fixtureCheckout();

// ── the fixture, written through the real store modules ─────────────────────
{
  const database = getDb();
  writeTransaction(() => {
    database
      .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)`)
      .run(PK, repositoryCheckoutIdentity(projectDir).key, "remote", AT);
    database
      .prepare(`INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)`)
      .run("run-fg591-mut", "feature", "mutation fixture", "complete", AT, projectDir);
  });
  setStorageMode(PK, "db", AT);

  for (const id of ["FG-301", "FG-302", "FG-303"]) {
    upsertTicket({
      projectKey: PK,
      ticketId: id,
      type: "story",
      status: "active",
      title: `title ${id}`,
      body: READY_BODY,
      created: "2026-01-01",
      closed: null,
      closedCommit: null,
      epic: null,
      frontmatter: null,
      importedAt: AT,
      importedFrom: null,
    } as never);
    rankTicket(PK, id, undefined, AT);
  }
  for (const id of ["FG-301", "FG-302"]) {
    const res = enqueueTicket(PK, id, { by: "operator" }, AT);
    assert.ok(res.ok, `fixture enqueue ${id} refused`);
  }
}

// ── the recording binary: a real executable, logging cwd and every argument ──
//
// A stub rather than a spy: `execFile` resolves and runs a real process, so a test
// that patched a module binding would prove nothing about what actually executes.
const RIG = mkdtempSync(join(tmpdir(), "fg591-mut-rig-"));
const CALL_LOG = join(RIG, "calls.log");
const STUB = join(RIG, "forge-stub");
writeFileSync(CALL_LOG, "");
writeFileSync(
  STUB,
  [
    "#!/bin/sh",
    `{ printf 'CALL\\t%s\\n' "$PWD"; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "${CALL_LOG}"`,
    'if [ -n "$STUB_FAIL" ]; then printf \'%s\\n\' "$STUB_FAIL" >&2; exit 1; fi',
    "printf '{\"stub\":true}\\n'",
    "exit 0",
  ].join("\n"),
);
chmodSync(STUB, 0o755);

type RecordedCall = { cwd: string; argv: string[] };

function recordedCalls(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  for (const line of readFileSync(CALL_LOG, "utf8").split("\n")) {
    if (line.startsWith("CALL\t")) calls.push({ cwd: line.slice(5), argv: [] });
    else if (line.startsWith("ARG\t")) calls[calls.length - 1]?.argv.push(line.slice(4));
  }
  return calls;
}

function resetCalls(): void {
  writeFileSync(CALL_LOG, "");
}

/** The stub is in force for every test EXCEPT the two real-CLI legs at the bottom,
 *  which delete it so the co-located `bin/forge` is resolved instead. */
function useStub(): void {
  process.env.FORGE_BIN = STUB;
}
useStub();

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/projects`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`Server on port ${TEST_PORT} did not start within ${ms}ms`);
}
await waitForServer();

/** The queue's members in canonical rank order. `queueView` reports every RANKED
 *  ticket too (rank and membership are orthogonal durable fields, which is the whole
 *  point of the board), so the membership half is selected explicitly. */
function queuedIds(): string[] {
  return queueView(PK).filter((entry) => entry.queued).map((entry) => entry.ticketId);
}

type PostOptions = { headers?: Record<string, string>; body?: unknown; raw?: string; query?: string };

async function post(path: string, options: PostOptions = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const query = options.query ?? `?projectDir=${encodeURIComponent(projectDir)}`;
  const res = await fetch(`${BASE}${path}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SAME_ORIGIN, ...options.headers },
    body: options.raw ?? JSON.stringify(options.body ?? {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// ─── 1. refused BEFORE any subprocess ────────────────────────────────────────

test("integ FG-591 D1: a CROSS-ORIGIN post is refused, and nothing is spawned", async () => {
  resetCalls();
  for (const origin of ["http://evil.example", "null", "http://127.0.0.1:9999", "https://127.0.0.1.evil.example"]) {
    const res = await post("/api/queue/enqueue", { headers: { Origin: origin }, body: { ticketId: "FG-303" } });
    assert.equal(res.status, 403, `Origin ${origin} must be refused`);
    assert.match(String(res.body["error"]), /cross-origin/i);
  }
  // Sec-Fetch-Site is the browser's own provenance claim and cannot be set by page
  // script — a cross-site fetch that somehow reached us is refused on it alone.
  for (const site of ["cross-site", "same-site"]) {
    const res = await post("/api/queue/enqueue", {
      headers: { "Sec-Fetch-Site": site, Origin: SAME_ORIGIN },
      body: { ticketId: "FG-303" },
    });
    assert.equal(res.status, 403, `Sec-Fetch-Site: ${site} must be refused`);
  }
  assert.deepEqual(recordedCalls(), [], "a refused cross-origin POST spawned a process");
});

test("integ FG-591 D1: a SIMPLE-REQUEST content type is refused (the shape a cross-site form can forge), and nothing is spawned", async () => {
  resetCalls();
  for (const contentType of ["application/x-www-form-urlencoded", "text/plain;charset=UTF-8", "multipart/form-data", "text/html"]) {
    const res = await post("/api/queue/enqueue", {
      headers: { "Content-Type": contentType },
      raw: "ticketId=FG-303",
    });
    assert.equal(res.status, 415, `${contentType} must be refused`);
    assert.match(String(res.body["error"]), /application\/json/);
  }
  assert.deepEqual(recordedCalls(), [], "a refused simple-request POST spawned a process");
});

test("integ FG-591 D1: a CORS PREFLIGHT gets 405 and NO Access-Control-Allow-* header — the browser never sends the real request", async () => {
  resetCalls();
  for (const path of Object.keys(QUEUE_MUTATION_ROUTES)) {
    const res = await fetch(`${BASE}${path}`, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    await res.text();
    assert.equal(res.status, 405, `${path} preflight must not be answered`);
    for (const header of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials"]) {
      assert.equal(res.headers.get(header), null, `${path} must never emit ${header}`);
    }
  }
  assert.deepEqual(recordedCalls(), [], "a preflight spawned a process");
});

test("integ FG-591 D1: the guard runs BEFORE the project is even resolved — a refusal never pays for a registry probe", async () => {
  // The HTTP cases above prove no `forge` ran. This proves no `git` ran either: the
  // handler's project resolution is the registry's bounded git evidence read, and a
  // resolver that is never called cannot have spawned it.
  const refusals: Array<{ name: string; headers: Record<string, string> }> = [
    { name: "cross-origin", headers: { "content-type": "application/json", origin: "http://evil.example", host: `127.0.0.1:${TEST_PORT}` } },
    { name: "cross-site", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", host: `127.0.0.1:${TEST_PORT}` } },
    { name: "form content type", headers: { "content-type": "application/x-www-form-urlencoded", host: `127.0.0.1:${TEST_PORT}` } },
    { name: "no content type", headers: { host: `127.0.0.1:${TEST_PORT}` } },
  ];
  for (const { name, headers } of refusals) {
    let resolved = false;
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ ticketId: "FG-303" }))]), { headers }) as unknown as IncomingMessage;
    const captured: { status?: number } = {};
    const res = {
      writeHead(status: number) {
        captured.status = status;
        return this;
      },
      end() {
        return this;
      },
    } as unknown as ServerResponse;
    await handleQueueMutation(req, res, "/api/queue/enqueue", {
      resolveOwner: () => {
        resolved = true;
        throw new Error("the project registry must not be consulted for a request that is already refused");
      },
    });
    assert.equal(resolved, false, `${name}: the registry was consulted before the guard refused`);
    assert.ok(captured.status === 403 || captured.status === 415, `${name}: unexpected status ${captured.status}`);
  }
});

test("integ FG-591: on a NON-LOOPBACK bind the write half fails closed, and spawns nothing", async () => {
  resetCalls();
  const realHost = process.env.HOST;
  // The server is already listening on loopback; the admission test reads the bind
  // address per request, which is what a live `HOST=0.0.0.0` dashboard would have.
  process.env.HOST = "0.0.0.0";
  try {
    const res = await post("/api/queue/enqueue", { body: { ticketId: "FG-303" } });
    assert.equal(res.status, 403, "an unauthenticated surface exposed to the network must not drive the host's CLI");
    assert.match(String(res.body["error"]), /not loopback/);
    assert.deepEqual(recordedCalls(), [], "a non-loopback bind spawned a process anyway");

    // An opt-out, not a wall: the operator who fronted this with their own auth says so.
    process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS = "1";
    const allowed = await post("/api/queue/enqueue", { body: { ticketId: "FG-303" } });
    assert.equal(allowed.status, 200, "the explicit opt-out must be honoured");
    assert.equal(recordedCalls().length, 1);
  } finally {
    delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
    if (realHost === undefined) delete process.env.HOST;
    else process.env.HOST = realHost;
  }
});

test("FG-591: the bind-address admission test, as a pure function", () => {
  for (const host of ["127.0.0.1", "127.0.0.5", "::1", "[::1]", "localhost", undefined]) {
    assert.equal(guardBindAddress(host === undefined ? {} : { HOST: host }), null, `${host} is loopback`);
  }
  for (const host of ["0.0.0.0", "192.168.1.10", "::", "10.0.0.4", "dashboard.internal"]) {
    assert.equal(guardBindAddress({ HOST: host })?.status, 403, `${host} is not loopback`);
    assert.equal(guardBindAddress({ HOST: host, FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS: "1" }), null, `${host} with the explicit opt-out`);
  }
  assert.equal(guardBindAddress({ HOST: "0.0.0.0", FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS: "true" })?.status, 403, "only an exact 1 opts out");
});

test("FG-591: the header guard is exhaustive over provenance, as a pure function", () => {
  const host = "127.0.0.1:8024";
  // The CONFIGURED origins of a default loopback dashboard — the server's own, never
  // the request's. Passed explicitly so the guard is exercised without env fiddling.
  const pinned = dashboardOrigins({ HOST: "127.0.0.1", PORT: "8024" });
  const guard = (h: Parameters<typeof guardMutationRequest>[0]) => guardMutationRequest(h, pinned);
  const ok = { contentType: "application/json", host };
  assert.equal(guard(ok), null, "a same-origin JSON request with no browser headers is allowed");
  assert.equal(guard({ ...ok, origin: `http://${host}` }), null);
  assert.equal(guard({ ...ok, origin: `https://${host}` }), null, "a TLS-terminating proxy keeps Host and is still same-origin");
  assert.equal(guard({ ...ok, host: "localhost:8024", origin: "http://localhost:8024" }), null, "localhost IS this server");
  assert.equal(guard({ ...ok, secFetchSite: "same-origin" }), null);
  assert.equal(guard({ ...ok, secFetchSite: "none" }), null, "an address-bar / non-browser request is not cross-origin");
  assert.equal(guard({ ...ok, contentType: "application/json; charset=utf-8" }), null);

  assert.equal(guard({ ...ok, origin: "http://evil.example" })?.status, 403);
  assert.equal(guard({ ...ok, origin: "null" })?.status, 403, "a sandboxed iframe's null origin is never same-origin");
  assert.equal(guard({ ...ok, origin: `http://${host}`, host: undefined })?.status, 403, "an Origin with no Host to check it against is refused");
  assert.equal(guard({ ...ok, secFetchSite: "cross-site" })?.status, 403);
  assert.equal(guard({ ...ok, secFetchSite: "same-site" })?.status, 403, "a sibling subdomain is not us");
  assert.equal(guardMutationRequest({ contentType: "text/plain", host }, pinned)?.status, 415);
  assert.equal(guardMutationRequest({ host }, pinned)?.status, 415, "a missing content type is refused, not defaulted");
});

test("FG-591 (RF-7): a DNS-rebinding origin is refused, because the check is pinned to the CONFIGURED origin", () => {
  const pinned = dashboardOrigins({ HOST: "127.0.0.1", PORT: "8024" });
  // The attack, exactly: attacker.example is rebound to 127.0.0.1, so the browser
  // reaches this loopback server while believing it is on the attacker's own origin.
  // Every header is therefore self-consistent and browser-set — Origin and Host agree,
  // Sec-Fetch-Site really is same-origin, and the JSON content type needs no preflight.
  const rebound = {
    contentType: "application/json",
    host: "attacker.example:8024",
    origin: "http://attacker.example:8024",
    secFetchSite: "same-origin",
  };
  const refusal = guardMutationRequest(rebound, pinned);
  assert.equal(refusal?.status, 403, "a rebound name that agrees with itself must NOT be treated as same-origin");
  assert.match(String(refusal?.error), /Host: attacker\.example:8024/);
  // The pre-fix guard compared Origin to the request's own Host, which this passes.
  assert.equal(
    rebound.origin,
    `http://${rebound.host}`,
    "the request is self-consistent — that is why comparing Origin to Host could never reject it",
  );

  // The two ways an operator legitimately serves this elsewhere, both explicit.
  assert.equal(dashboardOrigins({ HOST: "0.0.0.0" }), null, "a non-loopback bind derives no origin to pin");
  assert.deepEqual(dashboardOrigins({ FORGE_DASHBOARD_ORIGIN: "https://forge.internal, https://forge.lan/" }), [
    "https://forge.internal",
    "https://forge.lan",
  ]);
  assert.equal(
    guardMutationRequest({ contentType: "application/json", host: "forge.internal", origin: "https://forge.internal" }, [
      "https://forge.internal",
    ]),
    null,
    "a declared origin is honoured",
  );
});

test("FG-692 (RF-11): a non-default loopback bind pins its OWN origin, so it accepts its own same-origin mutations", () => {
  // 127.0.0.2 is loopback (guardBindAddress admits it) but is not the default
  // 127.0.0.1 — the pre-fix hardcoded triple excluded it and refused every mutation.
  const pinned = dashboardOrigins({ HOST: "127.0.0.2", PORT: "8024" });
  assert.ok(pinned, "a loopback bind derives an origin set");
  assert.ok(
    pinned.includes("http://127.0.0.2:8024"),
    "the ACTUAL configured host is in the pinned set, not just the default triple",
  );

  // Its own same-origin POST is admitted.
  assert.equal(
    guardMutationRequest(
      { contentType: "application/json", host: "127.0.0.2:8024", origin: "http://127.0.0.2:8024", secFetchSite: "same-origin" },
      pinned,
    ),
    null,
    "the dashboard accepts a same-origin mutation from its own bind",
  );

  // A foreign origin is STILL refused — the RF-7 guarantee is intact, and the request
  // Host header is never trusted as the source of same-origin truth.
  const foreign = guardMutationRequest(
    { contentType: "application/json", host: "attacker.example:8024", origin: "http://attacker.example:8024", secFetchSite: "same-origin" },
    pinned,
  );
  assert.equal(foreign?.status, 403, "a rebound foreign origin is still refused");
  assert.match(String(foreign?.error), /Host: attacker\.example:8024/, "the refusal names the bind mismatch");
});

test("FG-692 (RF-1/RF-4): a public DNS host that merely SPELLS like loopback is refused, not trusted", () => {
  // The pre-fix `^127\.` prefix test admitted any name beginning `127.` — including a
  // public DNS name that resolves off-loopback — widening same-origin trust to a foreign
  // origin. Every one of these is NOT a loopback bind.
  for (const host of ["127.evil.test", "127.0.0.1.evil.example", "127x0x0x1", "127.0.0.256", "127.0.0"]) {
    assert.equal(guardBindAddress({ HOST: host })?.status, 403, `${host} must not be admitted as a loopback bind`);
    assert.equal(dashboardOrigins({ HOST: host, PORT: "8024" }), null, `${host} must derive no pinned origin`);
  }

  // The concrete demonstrated attack: HOST=127.evil.test, PORT=8024. The origin set is
  // null (no derivable origin), so a request that names 127.evil.test as its own Host is
  // no longer accepted as same-origin against a pinned loopback set.
  const pinned = dashboardOrigins({ HOST: "127.evil.test", PORT: "8024" });
  assert.equal(pinned, null, "no origin is pinned for a non-loopback public hostname");
  const req = { contentType: "application/json", host: "127.evil.test:8024", origin: "http://127.evil.test:8024", secFetchSite: "same-origin" };
  // With a genuine loopback pin, that foreign host is refused outright.
  const loopbackPin = dashboardOrigins({ HOST: "127.0.0.1", PORT: "8024" });
  assert.equal(guardMutationRequest(req, loopbackPin)?.status, 403, "a 127.<dns> host is not this loopback server");

  // Genuine loopback binds still pass, including a non-default one in 127.0.0.0/8.
  for (const host of ["127.0.0.1", "127.0.0.5", "127.255.255.254", "::1", "[::1]", "localhost"]) {
    assert.equal(guardBindAddress({ HOST: host }), null, `${host} is a genuine loopback bind`);
    assert.ok(dashboardOrigins({ HOST: host, PORT: "8024" }), `${host} derives a pinned origin`);
  }
});

// ─── 2. exactly the named verb, exactly this argv ────────────────────────────

test("integ FG-591: each route spawns EXACTLY ONE named `forge queue` verb with the expected argv and nothing else", async () => {
  const cases: Array<{ path: string; body: unknown; argv: string[] }> = [
    {
      path: "/api/queue/enqueue",
      body: { ticketId: "FG-303" },
      argv: ["queue", "enqueue", "FG-303", "--project", projectDir, "--json"],
    },
    {
      path: "/api/queue/enqueue",
      body: { ticketId: "FG-303", note: "operator asked for this next" },
      argv: ["queue", "enqueue", "FG-303", "--project", projectDir, "--json", "--note", "operator asked for this next"],
    },
    {
      path: "/api/queue/dequeue",
      body: { ticketId: "FG-302" },
      argv: ["queue", "dequeue", "FG-302", "--project", projectDir, "--json"],
    },
    {
      path: "/api/queue/rank",
      body: { ticketId: "FG-302", reference: "FG-301", placement: "before", expectVersion: 7 },
      argv: ["queue", "rank-before", "FG-302", "FG-301", "--expect-version", "7", "--project", projectDir, "--json"],
    },
    {
      path: "/api/queue/rank",
      body: { ticketId: "FG-301", reference: "FG-302", placement: "after", expectVersion: 0 },
      argv: ["queue", "rank-after", "FG-301", "FG-302", "--expect-version", "0", "--project", projectDir, "--json"],
    },
    {
      path: "/api/queue/reorder",
      body: { ticketId: "FG-302", to: 1, expectVersion: 3 },
      argv: ["queue", "reorder", "FG-302", "--to", "1", "--expect-version", "3", "--project", projectDir, "--json"],
    },
    {
      path: "/api/queue/reorder",
      body: { order: ["FG-302", "FG-301"], expectVersion: 3 },
      argv: ["queue", "reorder", "--order", "FG-302,FG-301", "--expect-version", "3", "--project", projectDir, "--json"],
    },
  ];

  for (const testCase of cases) {
    resetCalls();
    const res = await post(testCase.path, { body: testCase.body });
    assert.equal(res.status, 200, `${testCase.path} -> ${res.status}: ${JSON.stringify(res.body)}`);
    const calls = recordedCalls();
    assert.equal(calls.length, 1, `${testCase.path} must spawn exactly one process, saw ${calls.length}`);
    assert.deepEqual(calls[0]!.argv, testCase.argv, `${testCase.path} argv`);
    assert.equal(calls[0]!.cwd, projectDir, "the child runs in the REGISTERED checkout, never the dashboard's cwd");
  }
});

test("integ FG-591 D11: a rank or reorder with NO expectVersion never reaches the CLI", async () => {
  resetCalls();
  for (const [path, body] of [
    ["/api/queue/rank", { ticketId: "FG-302", reference: "FG-301", placement: "before" }],
    ["/api/queue/reorder", { ticketId: "FG-302", to: 1 }],
    ["/api/queue/reorder", { order: ["FG-302", "FG-301"] }],
  ] as const) {
    const res = await post(path, { body });
    assert.equal(res.status, 400, `${path} without expectVersion must refuse`);
    assert.match(String(res.body["error"]), /expectVersion/);
  }
  assert.deepEqual(recordedCalls(), [], "a version-less reorder was submitted anyway");
});

test("integ FG-591: a payload that tries to smuggle a FLAG into argv is refused, not quoted", async () => {
  resetCalls();
  const hostile: Array<[string, unknown]> = [
    ["/api/queue/enqueue", { ticketId: "--max-active-runs" }],
    ["/api/queue/enqueue", { ticketId: "-rf" }],
    ["/api/queue/enqueue", { ticketId: "FG-303 --project /etc" }],
    ["/api/queue/enqueue", { ticketId: "../../etc/passwd" }],
    ["/api/queue/enqueue", { ticketId: "FG-303; rm -rf /" }],
    ["/api/queue/enqueue", { ticketId: "FG-303", note: "--project" }],
    ["/api/queue/enqueue", { ticketId: ["FG-303"] }],
    ["/api/queue/dequeue", { ticketId: "" }],
    ["/api/queue/rank", { ticketId: "FG-301", reference: "FG-302", placement: "--help", expectVersion: 1 }],
    ["/api/queue/rank", { ticketId: "FG-301", reference: "FG-301", placement: "before", expectVersion: 1 }],
    ["/api/queue/reorder", { ticketId: "FG-301", to: "1; touch /tmp/pwned", expectVersion: 1 }],
    ["/api/queue/reorder", { order: ["FG-301", "FG-301"], expectVersion: 1 }],
    ["/api/queue/reorder", { order: [], expectVersion: 1 }],
    ["/api/queue/reorder", { order: ["FG-301"], ticketId: "FG-302", to: 1, expectVersion: 1 }],
  ];
  for (const [path, body] of hostile) {
    const res = await post(path, { body });
    assert.equal(res.status, 400, `${path} ${JSON.stringify(body)} must be refused: got ${JSON.stringify(res.body)}`);
  }
  const res = await post("/api/queue/enqueue", { raw: "{not json" });
  assert.equal(res.status, 400);
  assert.deepEqual(recordedCalls(), [], "a hostile payload reached the CLI");
});

test("integ FG-591: an unregistered project is a refusal, and `--project` is NEVER a caller-supplied path", async () => {
  resetCalls();
  const res = await post("/api/queue/enqueue", {
    query: `?projectDir=${encodeURIComponent("/tmp/not-a-registered-checkout")}`,
    body: { ticketId: "FG-303" },
  });
  assert.equal(res.status, 404, "an unregistered path must not become a --project argument");
  assert.deepEqual(recordedCalls(), [], "an unregistered project reached the CLI");

  // And the builder itself cannot be handed one: the checkout is an operand like any
  // other, re-checked at the last gate before argv.
  const built = buildForgeArgv("enqueue", { ticketId: "FG-303" }, "--project");
  assert.equal((built as { ok: boolean }).ok, false, "a flag-shaped checkout must be refused by the builder too");
});

// ─── 3. no route arms dispatch or sets capacity (D2) ─────────────────────────

test("FG-591 D2: NO route on this surface can arm dispatch or set capacity — asserted over the route table", () => {
  assert.deepEqual(Object.keys(QUEUE_MUTATION_ROUTES).sort(), [
    "/api/queue/dequeue",
    "/api/queue/enqueue",
    "/api/queue/rank",
    "/api/queue/reorder",
  ]);
  assert.deepEqual([...QUEUE_MUTATION_FORGE_VERBS].sort(), ["dequeue", "enqueue", "rank-after", "rank-before", "reorder"]);

  // The argv builder is the ONLY producer of a spawn, and it is total over the route
  // table: whatever the body says, the verb comes from this closed set. Arming, the
  // ceiling, `dispatcher run` and `cancel` are unreachable — they stop or authorize
  // unattended container execution, and that stays CLI-only.
  const forbidden = /(dispatcher|arm|disarm|max-active-runs|lease-ttl|cancel|new|invoke|campaign|gate|retry)/;
  for (const route of Object.values(QUEUE_MUTATION_ROUTES)) {
    for (const body of [
      { ticketId: "FG-301", reference: "FG-302", placement: "before", expectVersion: 1, to: undefined },
      { ticketId: "FG-301", expectVersion: 1, to: 1, verb: "dispatcher", dispatcher: "arm", maxActiveRuns: 99 },
    ]) {
      const built = buildForgeArgv(route, body, "/tmp/checkout");
      if (!("argv" in built)) continue;
      assert.equal(built.argv[0], "queue", `${route} must only ever run \`forge queue\``);
      assert.ok((QUEUE_MUTATION_FORGE_VERBS as readonly string[]).includes(built.argv[1]!), `${route} verb ${built.argv[1]}`);
      for (const arg of built.argv) {
        assert.doesNotMatch(arg, forbidden, `${route} argv must not carry ${arg}`);
      }
    }
  }
});

test("integ FG-591 D2: an arm-shaped REQUEST is a 404 on this surface and spawns nothing", async () => {
  resetCalls();
  for (const path of [
    "/api/queue/dispatcher/arm",
    "/api/queue/dispatcher",
    "/api/queue/arm",
    "/api/queue/capacity",
    "/api/queue/cancel",
    "/api/queue",
  ]) {
    const res = await post(path, { body: { armed: true, maxActiveRuns: 99, ticketId: "FG-303" } });
    assert.ok(res.status === 404 || res.status === 405, `${path} -> ${res.status}`);
  }
  assert.deepEqual(recordedCalls(), [], "an arm-shaped request spawned a process");
});

// ─── 4. the dashboard writes no DB row on any path ───────────────────────────

test("integ FG-591: the dashboard writes NO DB row on any path — the store's bytes are unchanged across every route", async () => {
  const dbFiles = [join(tmpHome, "forge.db"), join(tmpHome, "forge.db-wal")];
  const digest = (): string => {
    const hash = createHash("sha256");
    for (const file of dbFiles) hash.update(existsSync(file) ? readFileSync(file) : Buffer.alloc(0));
    return hash.digest("hex");
  };
  const before = digest();
  resetCalls();
  for (const [path, body] of [
    ["/api/queue/enqueue", { ticketId: "FG-303" }],
    ["/api/queue/dequeue", { ticketId: "FG-301" }],
    ["/api/queue/rank", { ticketId: "FG-302", reference: "FG-301", placement: "before", expectVersion: 0 }],
    ["/api/queue/reorder", { order: ["FG-301", "FG-302"], expectVersion: 0 }],
  ] as const) {
    const res = await post(path, { body });
    assert.equal(res.status, 200, `${path} -> ${res.status}`);
  }
  assert.equal(recordedCalls().length, 4, "every route went through the CLI");
  // The stub writes nothing, so any change here came from the dashboard itself.
  assert.equal(digest(), before, "the dashboard wrote to the store directly");
});

test("integ FG-591: the CLI's own refusal reaches the operator verbatim, with a non-2xx status", async () => {
  resetCalls();
  process.env.STUB_FAIL = "forge: queue reorder refuses — the queue moved (expected version 3, current 9).";
  try {
    const res = await post("/api/queue/reorder", { body: { order: ["FG-301", "FG-302"], expectVersion: 3 } });
    assert.equal(res.status, 409);
    assert.equal(res.body["ok"], false);
    assert.match(String(res.body["error"]), /the queue moved \(expected version 3, current 9\)/);
    assert.equal(res.body["verb"], "reorder");
  } finally {
    delete process.env.STUB_FAIL;
  }
});

// ─── 5. the FG-679 guard is neither widened nor narrowed ─────────────────────

test("FG-591 / FG-679: the serving-path no-subprocess guard is neither WIDENED to cover a mutation route nor NARROWED", () => {
  const guardPath = resolve(import.meta.dirname, "fg679-serving-path-no-subprocess.integration.test.ts");
  const source = readFileSync(guardPath, "utf8");
  const paths = source.match(/const NEW_PATHS = \[[\s\S]*?\];/);
  assert.ok(paths, "the guard's NEW_PATHS list must still exist");
  // NOT WIDENED: BD-7 governs the serving and polling paths. A mutation route inside
  // that list would simply be red — it spawns a process by design — and folding it in
  // is how a guard gets "relaxed" into meaninglessness.
  assert.doesNotMatch(paths[0], /\/api\/queue/, "the FG-679 guard must not be widened to cover a queue route");
  // NOT NARROWED: it still covers its own three paths, and still keeps the
  // /api/in-flight negative control that proves its instrumentation can SEE a spawn.
  for (const path of ["/api/current-activity", "/api/launches/launch-guard-aaaaaa", "/api/launches/launch-guard-aaaaaa/log"]) {
    assert.ok(paths[0].includes(path), `the FG-679 guard must still cover ${path}`);
  }
  assert.match(source, /\/api\/in-flight/, "the negative control must survive");
  assert.match(source, /shim:docker inspect/, "the negative control's live-instrumentation assertion must survive");
});

// ─── 6. the REAL binary: the argv this surface builds, against the real CLI ──

test("integ FG-591: the REAL co-located `forge` runs the enqueue this surface submits, and the membership row lands", async () => {
  // No stub. resolveForgeBinary falls to the entry beside this dashboard — in a dev
  // checkout `bin/forge`, in a release the release entry — which is the forge this
  // dashboard belongs to and cannot be shadowed by an earlier one on $PATH.
  delete process.env.FORGE_BIN;
  const resolved = resolveForgeBinary();
  assert.ok("path" in resolved, "the co-located forge entry must resolve");
  assert.equal((resolved as { source: string }).source, "colocated");
  assert.ok(existsSync((resolved as { path: string }).path));

  // Inside an agent container the compiled-in authority mount exists, and `forge
  // queue` refuses every mutation under container authority by design (FG-609). The
  // child is pointed at a neutral mount through the SAME published seam every other
  // CLI-spawning suite uses; on a host this changes nothing.
  Object.assign(process.env, authorityTestkitBinEnv());

  try {
    assert.equal(queuedIds().includes("FG-303"), false, "FG-303 starts outside the queue");
    const res = await post("/api/queue/enqueue", { body: { ticketId: "FG-303", note: "from the board" } });
    assert.equal(res.status, 200, `the real CLI refused: ${JSON.stringify(res.body)}`);
    assert.equal(res.body["verb"], "enqueue");
    const result = res.body["result"] as Record<string, unknown> | null;
    assert.ok(result && result["enqueued"] === true, `the CLI's --json result must come back: ${JSON.stringify(result)}`);

    // Read the durable truth with a SECOND connection, not the CLI's own report.
    const second = new Database(join(tmpHome, "forge.db"), { readonly: true });
    try {
      const row = second
        .prepare(`SELECT ticket_id, enqueued_by FROM queue_membership WHERE project_key = ? AND ticket_id = ?`)
        .get(PK, "FG-303") as { ticket_id: string; enqueued_by: string } | undefined;
      assert.ok(row, "the enqueue this surface submitted must be durable");
    } finally {
      second.close();
    }
  } finally {
    useStub();
  }
});

test("integ FG-591 D11: through the REAL CLI, a reorder carrying a STALE version refuses by name and changes nothing", async () => {
  delete process.env.FORGE_BIN;
  Object.assign(process.env, authorityTestkitBinEnv());
  try {
    const before = queuedIds();
    assert.ok(before.length >= 2, "the queue needs an order to try to clobber");
    const stale = queueVersion(PK) - 1;
    const res = await post("/api/queue/reorder", { body: { order: [...before].reverse(), expectVersion: stale } });
    assert.equal(res.status, 409, `a stale version must refuse: ${JSON.stringify(res.body)}`);
    assert.match(String(res.body["error"]), /version/i, "the refusal must name the reason");
    assert.deepEqual(queuedIds(), before, "a refused reorder must leave the order byte-identical");
  } finally {
    useStub();
  }
});
