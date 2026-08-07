// FG-576 step 9: receipt state follows actual spawn/exit evidence, never intent.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeDb } from "../store/db.js";
import { listOrchestratorReceiptsForProject } from "../store/orchestrator-receipts.js";
import { loadHeartbeats } from "../util/orchestrator-heartbeats.js";
const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, "..", ".."), cli = ["--import", join(repo, "bin", "forge-loader.mjs"), join(repo, "src", "cli", "index.ts")];
let base = "", home = "", project = "", bin = "", db = "", record = "", heartbeats = "";
const policy = `model_profiles:\n  claude:\n    provider: anthropic\n    auth: api\n    map:\n      default: { model: claude-sonnet-4-6, cost_tier: standard }\ndefaults:\n  profile: claude\n  activity: {}\n`;
function env(extra: Record<string, string> = {}) { return { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: db, FORGE_ORCHESTRATORS_DIR: heartbeats, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_CLAUDE_RECORD: record, ANTHROPIC_API_KEY: "fixture", ...extra }; }
function run(extra: Record<string, string> = {}) { const r = spawnSync(process.execPath, [...cli, "orchestrator"], { cwd: project, env: env(extra), encoding: "utf8", timeout: 30_000 }); closeDb(); return { status: r.status, stderr: r.stderr ?? "" }; }
function receipts() { process.env.FORGE_DB_PATH = db; process.env.FORGE_HOME = home; closeDb(); return listOrchestratorReceiptsForProject(project); }
async function waitFor<T>(condition: () => T | undefined | false, description: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const value = condition();
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`timed out after 30s waiting for ${description}${lastError ? `; last read error: ${lastError}` : ""}`);
}
// realpath the temp base ONCE: the child reports its cwd resolved, so on a host whose
// tmpdir sits behind a symlink (darwin's /var -> /private/var) an unresolved base would
// query for receipts the launcher filed under the physical path.
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-receipt-"))); home = join(base, "home"); project = join(base, "project"); bin = join(base, "bin"); db = join(home, "forge.db"); record = join(base, "record"); heartbeats = join(base, "heartbeats"); for (const d of [home, project, bin, heartbeats]) mkdirSync(d, { recursive: true }); writeFileSync(join(home, "model-policy.yml"), policy); writeFileSync(join(project, "CLAUDE.md"), "<!-- forge:orchestrator-start -->\n"); copyFileSync(join(here, "__fixtures__", "fake-claude.js"), join(bin, "claude")); chmodSync(join(bin, "claude"), 0o755); });
afterEach(() => { closeDb(); rmSync(base, { recursive: true, force: true }); });
test("FG-576 D11/D15: spawn failure, child exit, SIGKILL and unwritable receipt never leave a false running receipt", async () => {
  let r = run({ PATH: join(base, "no-such-bin") }); assert.notEqual(r.status, 0); let receiptRows = receipts(); assert.equal(receiptRows[0]!.state, "spawn_failed"); assert.equal(receiptRows[0]!.claimsRunning, false);
  r = run({ FAKE_CLAUDE_MODE: "exit:17" }); assert.notEqual(r.status, 0); receiptRows = receipts(); assert.equal(receiptRows.find((x) => x.exitCode === 17)?.state, "exited");
  const child = spawn(process.execPath, [...cli, "orchestrator"], { cwd: project, env: env({ FAKE_CLAUDE_MODE: "hold", FAKE_CLAUDE_READY: join(base, "ready") }), stdio: "ignore" });
  await waitFor(() => existsSync(join(base, "ready")), "the fake Claude readiness signal");
  const runningReceipt = await waitFor(
    () => receipts().find((receipt) => receipt.launcherPid === child.pid && receipt.claimsRunning),
    "the launcher's running receipt for the child process",
  );
  const liveHeartbeat = await waitFor(
    () => loadHeartbeats({ heartbeatsDir: heartbeats }).find((heartbeat) => heartbeat.receiptId === runningReceipt.receiptId && heartbeat.sessionId === runningReceipt.sessionKey && heartbeat.sources.includes("launcher")),
    "the launcher's readable heartbeat for that receipt",
  );
  assert.equal(liveHeartbeat.state, "live");
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGKILL");
  await exited;
  assert.equal(loadHeartbeats({ heartbeatsDir: heartbeats })[0]!.state, "orphaned");
  const blocked = join(base, "blocked"); writeFileSync(blocked, "file"); rmSync(record, { force: true }); r = run({ FORGE_DB_PATH: join(blocked, "forge.db") }); assert.notEqual(r.status, 0); assert.match(r.stderr, /nothing was spawned/i); assert.equal(existsSync(record), false); for (const receipt of receipts()) assert.notEqual(receipt.state, "running");
});
