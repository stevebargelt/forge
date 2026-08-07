// FG-576 step 11 / FG-448 / D13 — THE REMOTE-CONTROL CREDENTIAL, over the REAL
// route handlers.
//
// The URL `https://claude.ai/code/session_…` is a LIVE CONTROL CREDENTIAL: anyone
// holding it can drive that Claude Code session. This dashboard has no
// authentication and an env-overridable bind address, so every assertion below is
// made on the JSON PAYLOAD — never on rendered DOM. Client-side masking is not a
// control; the value must not be in the response at all.
//
// Six properties, each of which has a concrete way of going wrong:
//
//   1. LOOPBACK, SCOPED, LIVE — the URL is served for this project's live session.
//   2. OFF LOOPBACK — no url field, HTTP 200, no error, and NO opt-in (the write
//      surface's FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS escape hatch is deliberately
//      not honored for a credential).
//   3. CROSS-PROJECT — /api/projects (assembled across every project on the host)
//      never carries one, and an alpha-scoped request cannot reach beta's session.
//   4. NOT-LIVE — a receipt whose launcher is provably dead yields no URL, is not
//      counted active, and does not light the project LIVE indicator (AC7).
//   5. CLOSED — once the receipt closes, the URL is gone from every response.
//   6. UNSCOPED — refused outright; there is no cross-project form of this route.
//
// AC13: a disposable HOME / FORGE_HOME, a disposable DB, fake receipts and fake
// liveness records. No billed session is started, no real auth is touched, and the
// operator's ~/.forge and ~/.claude are never read or written.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { captureProcessIdentity } from "../../src/util/process-identity.js";

const TEST_PORT = 18791;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const testHome = mkdtempSync(join(tmpdir(), "forge-fg576-cred-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
const heartbeatsDir = join(forgeHome, "orchestrators");
const credentialDir = join(heartbeatsDir, "remote-control");
for (const dir of [forgeHome, reposRoot, heartbeatsDir, credentialDir]) mkdirSync(dir, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_DB_PATH = join(forgeHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;

after(() => rmSync(testHome, { recursive: true, force: true }));

// ─── two registered projects ────────────────────────────────────────────────

function checkout(name: string, remote: string): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return dir;
}

const ALPHA = checkout("alpha", "git@github.com:example/alpha.git");
const BETA = checkout("beta", "git@github.com:example/beta.git");

// ─── liveness fixtures ──────────────────────────────────────────────────────

/** A fence for THIS process — genuinely, provably alive. */
const ALIVE = captureProcessIdentity(process.pid);
/** A pid nothing holds, on this host: `identify` finds nothing, so it is DEAD —
 *  not `unknown`. This is the SIGKILLed-launcher case, and the whole point is that
 *  it must never read as running. */
const DEAD = { pid: 2147483646, host: hostname(), startToken: "test-start-token:never" };

function writeLauncherRecord(sessionId: string, projectDir: string, receiptId: string, identity: unknown): void {
  writeFileSync(
    join(heartbeatsDir, `${sessionId}.launcher.json`),
    JSON.stringify({
      kind: "forge-launcher-orchestrator",
      version: 1,
      sessionId,
      projectDir,
      startedAt: "2026-08-07T10:00:00.000Z",
      refreshedAt: "2026-08-07T10:00:00.000Z",
      provider: "anthropic",
      runtime: "claude-code",
      adapter: "claude",
      receiptId,
      process: identity,
    }),
  );
}

function writeCredential(sessionKey: string, receiptId: string, projectDir: string, url: string): void {
  writeFileSync(
    join(credentialDir, `${sessionKey}.json`),
    JSON.stringify({
      kind: "forge-orchestrator-remote-control",
      version: 1,
      sessionKey,
      receiptId,
      projectDir,
      url,
      capturedAt: "2026-08-07T10:00:05.000Z",
    }),
  );
}

const ALPHA_LIVE = { session: "aaaaaaaa-1111-2222-3333-444444444444", receipt: "orx-alphalive01", url: "https://claude.ai/code/session_01ALPHALiveAAAAAAAAAAAAA" };
const ALPHA_DEAD = { session: "bbbbbbbb-1111-2222-3333-444444444444", receipt: "orx-alphadead01", url: "https://claude.ai/code/session_01ALPHADeadBBBBBBBBBBBBB" };
const BETA_LIVE = { session: "cccccccc-1111-2222-3333-444444444444", receipt: "orx-betalive001", url: "https://claude.ai/code/session_01BETALiveCCCCCCCCCCCCCC" };

writeLauncherRecord(ALPHA_LIVE.session, ALPHA, ALPHA_LIVE.receipt, ALIVE);
writeLauncherRecord(ALPHA_DEAD.session, ALPHA, ALPHA_DEAD.receipt, DEAD);
writeLauncherRecord(BETA_LIVE.session, BETA, BETA_LIVE.receipt, ALIVE);

// The credential exists for ALL THREE — including the dead one. That is the
// realistic state: a SIGKILLed launcher never runs its close-out, so the file is
// still on disk. Nothing may serve it.
writeCredential(ALPHA_LIVE.session, ALPHA_LIVE.receipt, ALPHA, ALPHA_LIVE.url);
writeCredential(ALPHA_DEAD.session, ALPHA_DEAD.receipt, ALPHA, ALPHA_DEAD.url);
writeCredential(BETA_LIVE.session, BETA_LIVE.receipt, BETA, BETA_LIVE.url);

// ─── the store ──────────────────────────────────────────────────────────────

const database = new Database(join(forgeHome, "forge.db"));
database.exec(SCHEMA_SQL);
{
  const insertRun = database.prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)");
  const insertTask = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,created_at,started_at) VALUES (?,?,?,?,?,'{}',?,?)",
  );
  const at = "2026-08-07T10:00:00.000Z";
  insertRun.run("run-alpha", "session", "Alpha session", "active", at, ALPHA);
  insertRun.run("run-beta", "session", "Beta session", "active", at, BETA);
  // Two orchestrator TASK rows in alpha: one behind a live launcher, one behind a
  // dead one. Both say `running` in the DB — that is exactly the phantom AC7 closes.
  insertTask.run("task-alpha-live", "run-alpha", "session", "orchestrator", "running", at, at);
  insertTask.run("task-alpha-dead", "run-alpha", "session", "orchestrator", "running", at, at);
  insertTask.run("task-beta-live", "run-beta", "session", "orchestrator", "running", at, at);

  const insertReceipt = database.prepare(`
    INSERT INTO orchestrator_receipts
      (receipt_id, session_key, state, created_at, updated_at, project_dir, project_name, resolved_profile,
       runtime, provider, model, auth_mode, resolved_by, adapter, session_operation, session_target,
       provider_session_id, identity_strength, identity_basis, carrier_generation, carrier_path,
       carrier_acceptance, carrier_evidence, limitations, task_id, launcher_pid, launcher_identity,
       started_at, closed_at, exit_code, exit_signal, failure_reason)
    VALUES (@receipt_id, @session_key, 'running', @at, @at, @project_dir, @project_name, 'claude-subscription',
            'claude-code', 'anthropic', 'claude-opus-5', 'anthropic-oauth', 'defaults.profile', 'claude', 'new', NULL,
            @session_key, 'asserted', 'forge minted --session-id', 'gen-1', '/forge/gen-1/carrier.md',
            'not_applicable', NULL, @limitations, @task_id, 4711, 'tok', @at, NULL, NULL, NULL, NULL)
  `);
  insertReceipt.run({
    receipt_id: ALPHA_LIVE.receipt, session_key: ALPHA_LIVE.session, at, project_dir: ALPHA, project_name: "Alpha",
    task_id: "task-alpha-live", limitations: "[]",
  });
  insertReceipt.run({
    receipt_id: ALPHA_DEAD.receipt, session_key: ALPHA_DEAD.session, at, project_dir: ALPHA, project_name: "Alpha",
    task_id: "task-alpha-dead", limitations: "[]",
  });
  insertReceipt.run({
    receipt_id: BETA_LIVE.receipt, session_key: BETA_LIVE.session, at, project_dir: BETA, project_name: "Beta",
    task_id: "task-beta-live", limitations: JSON.stringify([{ capability: "usage", note: "no equivalent usage evidence" }]),
  });
}
database.close();

// ─── boot ───────────────────────────────────────────────────────────────────

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

for (let attempt = 0; attempt < 75; attempt += 1) {
  try {
    await fetch(`${BASE}/`);
    break;
  } catch {
    if (attempt === 74) throw new Error("dashboard test server did not start");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

type OrchestratorRow = Record<string, unknown> & { receiptId: string; running: boolean; presentation: string };
type ScopeView = { orchestrators: OrchestratorRow[]; activeCount: number; remoteControl: { available: boolean; withheldReason: string | null } };

async function get(path: string): Promise<{ status: number; headers: Headers; body: unknown; text: string }> {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
}

async function orchestrators(query: string): Promise<{ view: ScopeView; text: string; headers: Headers }> {
  const res = await get(`/api/orchestrators${query}`);
  assert.equal(res.status, 200, `expected 200 for ${query}, got ${res.status}: ${res.text}`);
  return { view: res.body as ScopeView, text: res.text, headers: res.headers };
}

function row(view: ScopeView, receiptId: string): OrchestratorRow {
  const found = view.orchestrators.find((entry) => entry.receiptId === receiptId);
  assert.ok(found, `receipt ${receiptId} missing from the scoped payload`);
  return found;
}

const alphaQuery = `?projectDir=${encodeURIComponent(ALPHA)}`;
const betaQuery = `?projectDir=${encodeURIComponent(BETA)}`;

// ─── 0. the fixture really is what it claims ────────────────────────────────

test("precondition: the fixtures classify as genuinely alive and genuinely dead", async () => {
  const { view } = await orchestrators(alphaQuery);
  assert.equal(
    row(view, ALPHA_LIVE.receipt).presentation,
    "running",
    "the live fixture must be provably alive by process identity, or every assertion below is vacuous",
  );
  assert.equal(row(view, ALPHA_DEAD.receipt).presentation, "orphaned");
});

// ─── 1. loopback + scoped + live ────────────────────────────────────────────

test("D13: on a loopback bind the scoped read returns the URL for this project's live session only", async () => {
  const { view, headers } = await orchestrators(alphaQuery);
  assert.equal(view.remoteControl.available, true);
  assert.equal(view.remoteControl.withheldReason, null);
  assert.equal(row(view, ALPHA_LIVE.receipt)["remoteControlUrl"], ALPHA_LIVE.url);
  // A credential-bearing response must not be cached anywhere.
  assert.match(headers.get("cache-control") ?? "", /no-store/);
});

test("AC7: the dead-launcher session's credential is on disk and is still not served", async () => {
  const { view, text } = await orchestrators(alphaQuery);
  const dead = row(view, ALPHA_DEAD.receipt);
  assert.equal(dead.running, false);
  assert.ok(!("remoteControlUrl" in dead), "an orphaned session must carry no credential key at all");
  assert.ok(!text.includes(ALPHA_DEAD.url), "the dead session's URL appeared somewhere in the payload");
  // The row itself is retained: the receipt is evidence of what was launched.
  assert.equal(dead.presentation, "orphaned");
  assert.equal(view.activeCount, 1, "only the provably-live session counts as active");
});

test("AC11: the scoped row explains what was selected and why", async () => {
  const { view } = await orchestrators(alphaQuery);
  const live = row(view, ALPHA_LIVE.receipt);
  for (const field of [
    "resolvedProfile", "runtime", "provider", "model", "authMode", "adapter", "resolvedBy",
    "sessionOperation", "identityStrength", "limitations", "recordedState", "processLiveness",
    "interaction", "health",
  ]) {
    assert.ok(field in live, `AC11 field ${field} is missing from the scoped payload`);
  }
  assert.equal(live["provider"], "anthropic");
  assert.equal(live["runtime"], "claude-code");
  assert.equal(live["adapter"], "claude");
  assert.equal(live["resolvedBy"], "defaults.profile");
  // AC7: a launcher-only record has NO provider interaction evidence, and that
  // renders as `unknown` rather than as anything healthier.
  assert.equal(live["interaction"], "unknown");
  assert.notEqual(live["health"], "healthy");
});

test("AC12: a recorded capability limitation is shown, not omitted", async () => {
  const { view } = await orchestrators(betaQuery);
  assert.deepEqual(row(view, BETA_LIVE.receipt)["limitations"], [
    { capability: "usage", note: "no equivalent usage evidence" },
  ]);
});

// ─── 2. off loopback ────────────────────────────────────────────────────────

// `HOST` is read at REQUEST time by the bind guard (queue-mutation.ts), so flipping
// it here exercises exactly the predicate a non-loopback deployment would hit. The
// socket stays on 127.0.0.1; the guard's answer is what is under test.
async function withHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOST;
  process.env.HOST = host;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HOST;
    else process.env.HOST = previous;
  }
}

test("D13: off a loopback bind the response is 200 with NO url field and NO error", async () => {
  const { view, text } = await withHost("0.0.0.0", () => orchestrators(alphaQuery));
  assert.equal(view.remoteControl.available, false);
  assert.ok(view.remoteControl.withheldReason, "the operator is told WHY, without being given the value");
  assert.match(String(view.remoteControl.withheldReason), /not loopback/);
  // Fail closed, not fail loud: the rows still render so the operator can see what
  // is running. Only the credential is absent.
  assert.equal(view.orchestrators.length, 2);
  for (const entry of view.orchestrators) {
    assert.ok(!("remoteControlUrl" in entry), "a url field survived a non-loopback bind");
  }
  assert.ok(!text.includes("claude.ai/code/session_"), "a credential-shaped value survived a non-loopback bind");
  assert.ok(!("error" in view), "withholding a credential is not an error");
});

test("D13: the queue-mutation remote opt-out does NOT re-enable the credential off loopback", async () => {
  // FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS is the WRITE surface's deliberate opt-out
  // for an operator running the dashboard behind their own authentication. This
  // ticket builds no such opt-in for a live session control credential, and reusing
  // that flag by accident is exactly how one would appear.
  process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS = "1";
  try {
    const { view, text } = await withHost("10.0.0.5", () => orchestrators(alphaQuery));
    assert.equal(view.remoteControl.available, false);
    assert.ok(!text.includes("claude.ai/code/session_"));
  } finally {
    delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
  }
});

// ─── 3. cross-project ───────────────────────────────────────────────────────

test("FG-448: the cross-project projection never carries a credential", async () => {
  const projects = await get("/api/projects");
  assert.equal(projects.status, 200);
  assert.ok(
    !projects.text.includes("claude.ai/code/session_"),
    "/api/projects is assembled across every project on the host and must never carry a credential",
  );
  assert.ok(!/"(remoteControlUrl)"\s*:/.test(projects.text), "a credential key appeared in the cross-project projection");
});

test("FG-448: a receipt for project A is unreachable from a request scoped to project B", async () => {
  const { view: alpha, text: alphaText } = await orchestrators(alphaQuery);
  const { view: beta, text: betaText } = await orchestrators(betaQuery);

  assert.deepEqual(alpha.orchestrators.map((e) => e.receiptId).sort(), [ALPHA_DEAD.receipt, ALPHA_LIVE.receipt].sort());
  assert.deepEqual(beta.orchestrators.map((e) => e.receiptId), [BETA_LIVE.receipt]);

  assert.ok(!alphaText.includes(BETA_LIVE.url), "beta's credential reached an alpha-scoped response");
  assert.ok(!betaText.includes(ALPHA_LIVE.url), "alpha's credential reached a beta-scoped response");
  assert.equal(row(beta, BETA_LIVE.receipt)["remoteControlUrl"], BETA_LIVE.url);
});

// ─── 4. the project LIVE indicator ──────────────────────────────────────────

test("AC7: a dead launcher does not light the project LIVE indicator", async () => {
  const projects = (await get("/api/projects")).body as Array<Record<string, unknown>>;
  const alpha = projects.find((p) => (p["projectDirs"] as string[] | undefined)?.includes(ALPHA));
  assert.ok(alpha, "alpha is not registered");
  // Alpha has TWO launcher records and one is provably dead. The indicator counts
  // liveness, not records — so it reads 1, not 2.
  assert.equal(alpha["liveSessions"], 1);
});

test("AC7: an orchestrator task row behind a dead launcher is annotated as not running", async () => {
  const rows = (await get(`/api/in-flight?projectDir=${encodeURIComponent(ALPHA)}`)).body as Array<Record<string, unknown>>;
  const live = rows.find((r) => r["taskId"] === "task-alpha-live");
  const dead = rows.find((r) => r["taskId"] === "task-alpha-dead");
  assert.ok(live && dead, "both orchestrator task rows should still be listed");
  // Both DB rows say `running`; the joined answer is what differs.
  assert.equal(live["status"], "running");
  assert.equal(dead["status"], "running");
  assert.equal((live["orchestrator"] as Record<string, unknown>)["running"], true);
  assert.equal((dead["orchestrator"] as Record<string, unknown>)["running"], false);
  assert.equal((dead["orchestrator"] as Record<string, unknown>)["presentation"], "orphaned");
  // And no credential rides on the in-flight payload, which is cross-project by default.
  assert.ok(!JSON.stringify(rows).includes("claude.ai/code/session_"));
});

// ─── 5. the closed receipt ──────────────────────────────────────────────────

test("FG-448: once the receipt closes, the URL is absent from every subsequent response", async () => {
  // Precondition: it is being served right now.
  assert.equal(row((await orchestrators(alphaQuery)).view, ALPHA_LIVE.receipt)["remoteControlUrl"], ALPHA_LIVE.url);

  // Close it the way the launcher's close-out does. The credential FILE is left on
  // disk deliberately — a SIGKILLed launcher never removes it, so the receipt, not
  // the file's absence, has to be what stops the credential being served.
  const write = new Database(join(forgeHome, "forge.db"));
  write.prepare("UPDATE orchestrator_receipts SET state = 'exited', closed_at = ?, exit_code = 0 WHERE receipt_id = ?")
    .run("2026-08-07T11:00:00.000Z", ALPHA_LIVE.receipt);
  write.close();

  const { view, text } = await orchestrators(alphaQuery);
  assert.ok(!text.includes(ALPHA_LIVE.url), "the URL survived the receipt closing");
  assert.equal(view.orchestrators.find((e) => e.receiptId === ALPHA_LIVE.receipt), undefined);
  assert.equal(view.activeCount, 0);
});

// ─── 6. no unscoped form ────────────────────────────────────────────────────

test("FG-448: the orchestrator read has no cross-project form", async () => {
  const unscoped = await get("/api/orchestrators");
  assert.equal(unscoped.status, 400);
  assert.match(String((unscoped.body as Record<string, unknown>)["error"]), /project scope is required/);
  assert.ok(!unscoped.text.includes("claude.ai/code/session_"));

  // An unregistered path is refused rather than served: the project is resolved
  // through the dashboard's own registry, never taken from the request.
  const foreign = await get(`/api/orchestrators?projectDir=${encodeURIComponent("/not/a/registered/checkout")}`);
  assert.equal(foreign.status, 404);
  assert.ok(!foreign.text.includes("claude.ai/code/session_"));
});
