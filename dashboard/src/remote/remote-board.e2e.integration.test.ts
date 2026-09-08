// FG-781 seam coverage: exercise the process-level boot hook and an authorized request over
// a real HTTP socket.  The focused tests cover the mapper and handler independently; this
// file makes sure neither boundary changes when they are composed.
import "../../../src/test-setup.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const root = mkdtempSync(join(tmpdir(), "fg781-http-seam-"));
const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { getDb } = await import("../../../src/store/db.js");
const { insertRun } = await import("../../../src/store/runs.js");
const { createCampaign, addCampaignItem, updateCampaignStatus } = await import("../../../src/store/campaigns.js");
const { repositoryCheckoutIdentity } = await import("../../../src/util/repository-identity.js");
const { projectsForDashboard } = await import("../queries.js");
const { createRemoteBoardServer } = await import("./server.js");

const AT = "2026-09-01T10:00:00Z";
const trees = join(root, "trees");
mkdirSync(trees, { recursive: true });

// Synchronous fixture creation keeps module initialization deterministic. (execFileSync is
// intentionally avoided in request paths; this is test-only fixture setup.)
import { execFileSync } from "node:child_process";
function fixtureCheckout(name: string, remote: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const alphaDir = fixtureCheckout("alpha", "git@github.com:forge/fg781-alpha.git");
const bravoDir = fixtureCheckout("bravo", "git@github.com:forge/fg781-bravo.git");
const charlieDir = fixtureCheckout("charlie", "git@github.com:forge/fg781-charlie.git");
const alphaKey = repositoryCheckoutIdentity(alphaDir).key;
const bravoKey = repositoryCheckoutIdentity(bravoDir).key;
const charlieKey = repositoryCheckoutIdentity(charlieDir).key;
const db = getDb();

const projects = [
  ["pk-alpha", alphaKey, "FG-ALPHA", "Alpha-only-title", alphaDir],
  ["pk-bravo", bravoKey, "FG-BRAVO", "Bravo-foreign-title", bravoDir],
  ["pk-charlie", charlieKey, "FG-CHARLIE", "Charlie-foreign-title", charlieDir],
] as const;
for (const [pk, repo, ticket, title] of projects) {
  db.prepare("INSERT INTO project_identity (project_key,repo_evidence_key,repo_evidence_source,created_at) VALUES (?,?,'remote',?)").run(pk, repo, AT);
  db.prepare("INSERT INTO ticket_storage_mode (project_key,mode,updated_at) VALUES (?,'db',?)").run(pk, AT);
  db.prepare("INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,imported_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(pk, ticket, "story", "active", title, `RAW_LOG_${ticket} TRANSCRIPT_${ticket} API_KEY=secret-${ticket} bearer-token-${ticket} /absolute/${ticket}/path https://control.invalid/${ticket}`, AT, AT);
  db.prepare("INSERT INTO queue_membership (project_key,ticket_id,enqueued_at,enqueued_by,note) VALUES (?,?,?,?,?)")
    .run(pk, ticket, AT, `queue-user-${ticket}`, `QUEUE_NOTE_${ticket}`);
  insertRun({ id: `run-${ticket}`, workflow: "feature", title: `activity-${ticket}`, status: "active", createdAt: AT, projectDir: projects.find((p) => p[0] === pk)![4] });
  db.prepare("INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,created_at,started_at) VALUES (?,?,'build','engineer','running',?,?,?)")
    .run(`task-${ticket}`, `run-${ticket}`, JSON.stringify({ transcript: `TRANSCRIPT_${ticket}`, credential: `bearer-token-${ticket}` }), AT, AT);
  const campaign = createCampaign({ sourceKind: "epic", sourceInput: { epicId: ticket }, mode: "serial", metadata: { goal: `campaign-${ticket}` }, projectDir: projects.find((p) => p[0] === pk)![4] });
  updateCampaignStatus(campaign.id, "running");
  addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: ticket });
}

const alpha = projectsForDashboard().find((project) => project.key === alphaKey);
assert.ok(alpha, "fixture must register the granted project");
const foreignTokens = ["FG-BRAVO", "Bravo-foreign-title", bravoDir, "run-FG-BRAVO", "campaign-FG-BRAVO", "FG-CHARLIE", "Charlie-foreign-title", charlieDir, "run-FG-CHARLIE", "campaign-FG-CHARLIE"];
const sensitiveTokens = ["RAW_LOG_FG-ALPHA", "TRANSCRIPT_FG-ALPHA", "API_KEY=secret-FG-ALPHA", "bearer-token-FG-ALPHA", "/absolute/FG-ALPHA/path", "https://control.invalid/FG-ALPHA"];

function listen(server: ReturnType<typeof createRemoteBoardServer>): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}
function close(server: ReturnType<typeof createRemoteBoardServer>): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

test("AC3/AC4/AC5: a verified adapter grant traverses the real listener without foreign or sensitive data", async () => {
  const remote = createRemoteBoardServer({
    adapter: { kind: "test-proxy", verifyIdentity: () => ({ subject: "verified-user", capabilities: ["read"], projectScope: { projectKey: alphaKey, memberDirs: alpha!.projectDirs }, provenance: { adapter: "test-proxy" } }) },
    lookupProject: (key) => key === alphaKey ? alpha : undefined,
    now: () => Date.parse(AT),
  });
  const base = await listen(remote);
  try {
    const response = await fetch(`${base}/api/board`, { headers: { "x-forwarded-user": "spoofed@example.test" } });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const envelope = JSON.parse(raw);
    assert.equal(envelope.state, "live");
    assert.equal(envelope.generation, Date.parse(AT));
    assert.equal(envelope.generatedAt, new Date(Date.parse(AT)).toISOString());
    assert.ok(envelope.board, "an authorized adapter grant reaches the assembled board");
    assert.match(raw, /FG-ALPHA/, "non-vacuous: granted project data is present");
    for (const token of [...foreignTokens, ...sensitiveTokens]) assert.ok(!raw.includes(token), `remote HTTP response leaked ${token}`);

    // The remote listener accepts no local dashboard mutation path, regardless of method.
    const fingerprintBefore = createHash("sha256").update(JSON.stringify(db.prepare("SELECT project_key,ticket_id,enqueued_at FROM queue_membership ORDER BY project_key,ticket_id").all())).digest("hex");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) for (const path of ["/api/board", "/api/queue/enqueue", "/api/projects/classify"]) {
      const refused = await fetch(`${base}${path}`, { method });
      assert.equal(refused.status, 405, `${method} ${path} is refused by the remote listener`);
    }
    const fingerprintAfter = createHash("sha256").update(JSON.stringify(db.prepare("SELECT project_key,ticket_id,enqueued_at FROM queue_membership ORDER BY project_key,ticket_id").all())).digest("hex");
    assert.equal(fingerprintAfter, fingerprintBefore, "refused remote mutations leave the real store byte-for-byte equivalent");
  } finally { await close(remote); }
});

async function boot(port: number, remotePort: number, enabled: string | undefined): Promise<{ child: ChildProcess; base: string; remote: string }> {
  const child = spawn(process.execPath, [resolve(dashboardRoot, "..", "node_modules", "tsx", "dist", "cli.mjs"), "src/server.ts"], {
    // Run from the dashboard workspace: its package boundary supplies the @forge/* aliases
    // used by the actual production entrypoint.
    cwd: dashboardRoot,
    env: { ...process.env, FORGE_HOME: forgeHome, PORT: String(port), HOST: "127.0.0.1", FORGE_DASHBOARD_REMOTE_PORT: String(remotePort), ...(enabled ? { FORGE_DASHBOARD_REMOTE: enabled } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  // tsx's cold loader plus the dashboard's production import graph can take several seconds
  // in a fresh integration worker.  This is a bounded readiness wait, not a background task.
  for (let i = 0; i < 400; i++) { try { if ((await fetch(`${base}/`)).ok) return { child, base, remote: `http://127.0.0.1:${remotePort}` }; } catch {} await new Promise((r) => setTimeout(r, 25)); }
  child.kill(); throw new Error(`dashboard child did not boot: ${output}`);
}
async function stop(child: ChildProcess): Promise<void> { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
async function cannotConnect(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1_000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error(`unexpectedly connected to ${host}:${port}`)); });
    socket.once("error", () => { clearTimeout(timer); resolve(); });
  });
}

test("AC1/AC2/AC6: actual server-entry children preserve local responses and expose only loopback fail-closed remote mode", async () => {
  const [localOff, remoteOff, localDisabled, remoteDisabled, localEnabled, remoteEnabled] = await Promise.all(Array.from({ length: 6 }, freePort));
  const off = await boot(localOff!, remoteOff!, undefined);
  const disabled = await boot(localDisabled!, remoteDisabled!, "0");
  const enabled = await boot(localEnabled!, remoteEnabled!, "1");
  try {
    const capture = async (base: string) => Promise.all(["/api/board", "/client/main.js"].map(async (path) => {
      const response = await fetch(base + path);
      const headers: Array<[string, string]> = [];
      response.headers.forEach((value, key) => headers.push([key, value]));
      return [path, response.status, headers.sort(), await response.text()];
    }));
    assert.deepEqual(await capture(off.base), await capture(disabled.base), "remote-disabled boot is byte-identical to ordinary boot for fixed local responses and headers");
    await assert.rejects(fetch(`${off.remote}/api/board`), "disabled mode does not listen on its configured remote port");
    const remote = await fetch(`${enabled.remote}/api/board`, { headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-user": "attacker@test", "tailscale-user-name": "spoof", "cf-access-jwt-assertion": "forged" } });
    assert.equal(remote.status, 401); const raw = await remote.text(); assert.equal(JSON.parse(raw).board, null);
    for (const token of ["FG-ALPHA", "FG-BRAVO", "203.0.113.9", "attacker@test", "forged"]) assert.ok(!raw.includes(token));
    const publicAddress = Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
    assert.ok(publicAddress, "fixture host must expose a non-loopback interface to prove the listener did not bind it");
    await cannotConnect(publicAddress!, remoteEnabled!);
    assert.deepEqual(await capture(off.base), await capture(enabled.base), "enabling the dedicated listener leaves local dashboard responses unchanged");
  } finally { await Promise.all([stop(off.child), stop(disabled.child), stop(enabled.child)]); }
});

after(() => rmSync(root, { recursive: true, force: true }));
