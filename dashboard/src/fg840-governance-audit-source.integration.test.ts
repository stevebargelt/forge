// FG-840 — the Routing page's RECORDED panel reads the PROJECT's raci-audit.log when a
// checkout is in scope (forge raci apply audits per project since FG-778) and the host
// log only without a scope, naming which it read; GET /api/raci shows the same entries
// for the same checkout because both routes go through one reader. Real HTTP server,
// scratch FORGE_HOME, a registered git checkout.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 19019;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("./test-support/await-dashboard-ready.js");

const tmpHome = mkdtempSync(join(tmpdir(), "fg840-home-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_DB_PATH = join(tmpHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg840-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");

const projectDir = mkdtempSync(join(tmpdir(), "fg840-proj-"));
execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg840-audit.git"], { cwd: projectDir, stdio: "ignore" });
const checkoutDir = realpathSync(projectDir);
const PROJECT_KEY = repositoryCheckoutIdentity(projectDir).key;
writeTransaction(() => {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`)
    .run("run-840", "feature", "audit fixture", "complete", "2026-09-30T09:00:00Z", projectDir);
});

const entry = (timestamp: string, modified: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    timestamp,
    action: "apply",
    current_raci: "forge-raci.md",
    candidate: "cand.md",
    candidate_sha256: "a".repeat(64),
    routes_added: [],
    routes_removed: [],
    routes_modified: [modified],
    validation: { raci: true, route: true },
    ...extra,
  });

mkdirSync(join(checkoutDir, ".forge"), { recursive: true });
const PROJECT_LOG = join(checkoutDir, ".forge", "raci-audit.log");
writeFileSync(
  PROJECT_LOG,
  [
    entry("2026-09-30T10:00:00.000Z", "implementation_quick"),
    "{corrupt",
    entry("2026-09-30T11:00:00.000Z", "research", { actor: "dashboard", source: "dashboard", rationale: "route research to the researcher" }),
  ].join("\n") + "\n",
);
const HOST_LOG = join(tmpHome, "raci-audit.log");
writeFileSync(HOST_LOG, entry("2026-01-01T00:00:00.000Z", "host_only_route") + "\n");

const { server } = await import("./server.js");
await awaitDashboardReady(BASE, { timeoutMs: 4000 });
after(() => {
  server.closeAllConnections?.();
  server.close();
});
{
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/projects`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server on ${TEST_PORT} did not start`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

async function getJson(path: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const governanceForCheckout = () =>
  getJson(`/api/governance?projectKey=${encodeURIComponent(PROJECT_KEY)}&projectDir=${encodeURIComponent(checkoutDir)}`);

test("integ FG-840: /api/governance under project scope reads the checkout's raci-audit.log and names it", async () => {
  const res = await governanceForCheckout();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const recorded = res.body["recorded"];
  assert.equal(recorded.source, "project");
  assert.equal(realpathSync(recorded.path), realpathSync(PROJECT_LOG));
  assert.deepEqual(recorded.entries.map((e: any) => e.routes_modified[0]), ["research", "implementation_quick"], "the project's entries, newest first");
  assert.equal(recorded.skippedLines, 1);
  assert.equal(recorded.entries[0].actor, "dashboard");
  assert.equal(recorded.entries[0].source, "dashboard");
  assert.equal(recorded.entries[0].rationale, "route research to the researcher");
  assert.equal(recorded.entries[0].candidate_sha256, "a".repeat(64));
  assert.ok(!JSON.stringify(recorded.entries).includes("host_only_route"), "the host log is not read under project scope");
});

test("integ FG-840: /api/governance with no project reads the host log and says so", async () => {
  const res = await getJson("/api/governance");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const recorded = res.body["recorded"];
  assert.equal(recorded.source, "host");
  assert.equal(realpathSync(recorded.path), realpathSync(HOST_LOG));
  assert.deepEqual(recorded.entries.map((e: any) => e.routes_modified[0]), ["host_only_route"]);
  assert.equal(recorded.skippedLines, 0);
});

test("integ FG-840: GET /api/raci returns the same audit tail as /api/governance for the same checkout", async () => {
  const raci = await getJson(`/api/raci?project=${encodeURIComponent(PROJECT_KEY)}`);
  assert.equal(raci.status, 200, JSON.stringify(raci.body));
  const governance = await governanceForCheckout();
  assert.deepEqual(raci.body["audit"].entries, governance.body["recorded"].entries);
  assert.equal(raci.body["audit"].source, "project");
  assert.equal(raci.body["audit"].skippedLines, governance.body["recorded"].skippedLines);
  assert.equal(realpathSync(raci.body["audit"].path), realpathSync(governance.body["recorded"].path));
  assert.deepEqual(raci.body["governance"]["recorded"], raci.body["audit"], "the embedded governance panel agrees too");
});
