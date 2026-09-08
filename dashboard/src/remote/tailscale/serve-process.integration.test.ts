// FG-782 process integration: boot the production dashboard entry with the real Tailscale
// adapter, a PATH-resolved fake `tailscale`, a real Forge DB, and a real mapping file.
import "../../../../src/test-setup.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "fg782-serve-process-"));
const forgeHome = join(root, "forge-home");
const trees = join(root, "trees");
const fakeBin = join(root, "bin");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(trees, { recursive: true });
mkdirSync(fakeBin, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = trees;

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { getDb } = await import("../../../../src/store/db.js");
const { insertRun } = await import("../../../../src/store/runs.js");
const { repositoryCheckoutIdentity } = await import("../../../../src/util/repository-identity.js");

function checkout(name: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", `git@github.com:forge/${name}.git`], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const alphaDir = checkout("alpha");
const bravoDir = checkout("bravo");
const alphaKey = repositoryCheckoutIdentity(alphaDir).key;
const bravoKey = repositoryCheckoutIdentity(bravoDir).key;
const db = getDb();
for (const [key, dir, ticket, title] of [[alphaKey, alphaDir, "FG-ALPHA-PROCESS", "alpha-visible-token"], [bravoKey, bravoDir, "FG-BRAVO-PROCESS", "bravo-foreign-token"]] as const) {
  db.prepare("INSERT INTO project_identity (project_key,repo_evidence_key,repo_evidence_source,created_at) VALUES (?,?, 'remote', ?)").run(`pk-${key}`, key, "2026-09-08T00:00:00Z");
  db.prepare("INSERT INTO ticket_storage_mode (project_key,mode,updated_at) VALUES (?, 'db', ?)").run(`pk-${key}`, "2026-09-08T00:00:00Z");
  db.prepare("INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,imported_at) VALUES (?,?,'story','active',?,?,?,?)").run(`pk-${key}`, ticket, title, title, "2026-09-08T00:00:00Z", "2026-09-08T00:00:00Z");
  insertRun({ id: `run-${key}`, workflow: "feature", title, status: "active", createdAt: "2026-09-08T00:00:00Z", projectDir: dir });
}
writeFileSync(join(forgeHome, "remote-board-identity.yml"), `version: 1\nidentities:\n  - login: alice@example.com\n    project: ${alphaKey}\n    capabilities: [read]\n`);
writeFileSync(join(fakeBin, "tailscale"), `#!/bin/sh
if [ "$1" = whois ]; then
  if [ "\${TS_FAKE_DOWN:-0}" = 1 ]; then exit 1; fi
  printf '%s\\n' '{"UserProfile":{"LoginName":"alice@example.com"},"Node":{"Name":"alice.tailnet.ts.net."}}'
  exit 0
fi
exit 1
`);
chmodSync(join(fakeBin, "tailscale"), 0o755);

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}
async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* booting */ }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`timed out waiting for ${url}`);
}
async function cannotConnect(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 800);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error(`unexpectedly connected to ${host}:${port}`)); });
    socket.once("error", () => { clearTimeout(timer); resolve(); });
  });
}
async function boot(extra: Record<string, string> = {}): Promise<{ child: ChildProcess; local: string; remote: string; remotePort: number }> {
  const [localPort, remotePort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(process.execPath, [resolve(dashboardRoot, "..", "node_modules", "tsx", "dist", "cli.mjs"), "src/server.ts"], {
    cwd: dashboardRoot,
    env: { ...process.env, ...extra, PATH: `${fakeBin}:${process.env.PATH}`, FORGE_HOME: forgeHome, FORGE_PROJECT_SCAN_ROOTS: trees, PORT: String(localPort), HOST: "127.0.0.1", FORGE_DASHBOARD_REMOTE: "1", FORGE_DASHBOARD_REMOTE_TRANSPORT: "tailscale", FORGE_DASHBOARD_REMOTE_PORT: String(remotePort) },
    stdio: "ignore",
  });
  const local = `http://127.0.0.1:${localPort}`;
  await waitFor(`${local}/`);
  return { child, local, remote: `http://127.0.0.1:${remotePort}`, remotePort };
}
async function stop(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((done) => child.once("exit", () => done()));
}

test("FG-782 AC2-AC4: real boot uses fake whois, limits the board to its mapped project, and honors revocation", async () => {
  const run = await boot();
  try {
    const publicAddress = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    assert.ok(publicAddress, "host exposes a non-loopback address for bind verification");
    await cannotConnect(publicAddress!, run.remotePort);
    await cannotConnect(publicAddress!, Number(new URL(run.local).port));

    const serveHeaders = { "x-forwarded-for": "100.64.0.8", "tailscale-user-login": "alice@example.com" };
    const granted = await fetch(`${run.remote}/api/board`, { headers: serveHeaders });
    assert.equal(granted.status, 200);
    const grantedRaw = await granted.text();
    assert.match(grantedRaw, /alpha-visible-token/, "the whois-confirmed mapped identity receives its own seeded project");
    for (const secret of ["bravo-foreign-token", "FG-BRAVO-PROCESS", bravoDir]) assert.ok(!grantedRaw.includes(secret), `foreign project data leaked: ${secret}`);

    const refusedHeaders: Array<Record<string, string>> = [
      { "x-forwarded-for": "100.64.0.8", "tailscale-user-login": "mallory@example.com" },
      { "x-forwarded-for": "100.64.0.8", "tailscale-user-login": "unmapped@example.com" },
      { "tailscale-user-login": "alice@example.com" },
      { "x-forwarded-for": "not-an-address", "tailscale-user-login": "alice@example.com" },
    ];
    for (const headers of refusedHeaders) {
      const refused = await fetch(`${run.remote}/api/board`, { headers });
      assert.equal(refused.status, 401);
      const raw = await refused.text();
      assert.equal(JSON.parse(raw).board, null);
      assert.ok(!raw.includes("alpha-visible-token"));
    }

    writeFileSync(join(forgeHome, "remote-board-identity.yml"), "version: 1\nidentities: []\n");
    const revoked = await fetch(`${run.remote}/api/board`, { headers: serveHeaders });
    assert.equal(revoked.status, 401, "mapping deletion is honored without a dashboard restart");
    assert.equal((await revoked.json()).board, null);
  } finally { await stop(run.child); }
});

test("FG-782 AC3: a daemon-unreachable fake causes a closed remote response, never a fallback", async () => {
  writeFileSync(join(forgeHome, "remote-board-identity.yml"), `version: 1\nidentities:\n  - login: alice@example.com\n    project: ${alphaKey}\n    capabilities: [read]\n`);
  const run = await boot({ TS_FAKE_DOWN: "1" });
  try {
    const response = await fetch(`${run.remote}/api/board`, { headers: { "x-forwarded-for": "100.64.0.8", "tailscale-user-login": "alice@example.com" } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).board, null);
  } finally { await stop(run.child); }
});

after(() => rmSync(root, { recursive: true, force: true }));
