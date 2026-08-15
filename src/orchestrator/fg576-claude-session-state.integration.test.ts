// FG-576 step 8 / FG-448 — CLAUDE PROVIDER-STATE READS BIND TO THE RECEIPT'S
// ASSERTED IDENTITY, and the remote-control URL is a live credential with a
// session-length lifetime.
//
// Every test here reaches Claude Code's state root ONLY through the new env seam
// (FORGE_CLAUDE_STATE_DIR → src/util/paths.ts claudeStateDir), pointed at a fake
// root in a disposable temp dir. The operator's ~/.claude is never read, HOME is
// never mutated, no auth is touched and nothing is spawned — AC13 is a property of
// the harness, and the HOME assertion below states it rather than assuming it.
//
// The centrepiece is deliberately the WRONG-SESSION case: two transcripts in one
// project dir where the NON-owning one is newest. The reader this step replaces
// took the newest, which is how an unrelated session's LIVE CONTROL CREDENTIAL gets
// attributed to a session that does not own it.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../store/db.js";
import {
  closeOrchestratorReceipt,
  getOrchestratorReceipt,
  markOrchestratorReceiptRunning,
  newOrchestratorReceiptId,
  persistPendingOrchestratorReceipt,
} from "../store/orchestrator-receipts.js";
import { insertRun } from "../store/runs.js";
import { getTask, insertTask } from "../store/tasks.js";
import {
  extractUsageFromTranscript,
  normalizeModelId,
  usageForTask,
  usageModelMismatches,
} from "../store/model-calls.js";
import { claudeStateDir, orchestratorRemoteControlDir } from "../util/paths.js";
import { listProjects } from "../util/projects.js";
import { resolveOrchestratorLaunch, type OrchestratorDecision, type OrchestratorSessionOperation } from "../v2/orchestrator-resolve.js";
import type { AuthProbe } from "../v2/provider-doctor.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  captureClaudeOrchestratorUsage,
  clearRemoteControlLink,
  findClaudeTranscript,
  findRemoteControlUrlInText,
  readRemoteControlLink,
  remoteControlLinksForProject,
  stashRemoteControlLink,
  startRemoteControlCapture,
} from "./claude-session-state.js";
import type { AdapterLaunchContext } from "./adapter.js";

const POLICY = `
schema_version: 2
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
  claude-bedrock:
    provider: anthropic
    auth: bedrock
    map:
      default: { model: us.anthropic.claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: {}
`;

const OWNER_SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const OWNER_URL = "https://claude.ai/code/session_01OWNEROWNEROWNEROWNER";
const OTHER_URL = "https://claude.ai/code/session_01OTHEROTHEROTHEROTHER";

const ALWAYS_AVAILABLE = (provider: string, mode: string): AuthProbe =>
  ({ provider, mode, status: "available", detail: "fixture probe" }) as AuthProbe;

const MANAGED_ENV = [
  "FORGE_HOME",
  "FORGE_DB_PATH",
  "FORGE_CLAUDE_STATE_DIR",
  "CLAUDE_CONFIG_DIR",
  "FORGE_ORCHESTRATORS_DIR",
] as const;

let base: string;
let home: string;
let claudeState: string;
let projectDir: string;
let otherProjectDir: string;
let envSnapshot: Record<string, string | undefined>;
let homeAtStart: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-claude-state-")));
  home = join(base, "forge-home");
  claudeState = join(base, "fake-claude-state");
  projectDir = join(base, "project");
  otherProjectDir = join(base, "other-project");
  for (const dir of [home, claudeState, projectDir, otherProjectDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, "model-policy.yml"), POLICY, "utf8");
  writeFileSync(join(projectDir, "CLAUDE.md"), `<!-- forge:orchestrator-start -->\n`, "utf8");

  envSnapshot = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
  homeAtStart = process.env["HOME"];
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  process.env["FORGE_CLAUDE_STATE_DIR"] = claudeState;
  delete process.env["CLAUDE_CONFIG_DIR"];
  closeDb();
});

afterEach(() => {
  closeDb();
  // AC13, stated rather than assumed: no test in this file may mutate HOME.
  assert.equal(process.env["HOME"], homeAtStart, "a test mutated HOME");
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function transcriptDir(dir: string): string {
  return join(claudeState, "projects", dir.replace(/\//g, "-"));
}

type UsageLine = { requestId: string; model: string; input?: number; output?: number };

/** A Claude Code transcript, in the shape the real one has: one JSON object per
 *  line, each carrying its own sessionId and cwd. */
function writeTranscript(
  dir: string,
  sessionId: string,
  opts: { url?: string; usage?: UsageLine[]; extraLines?: string[]; mtimeSeconds?: number } = {},
): string {
  const target = transcriptDir(dir);
  mkdirSync(target, { recursive: true });
  const path = join(target, `${sessionId}.jsonl`);
  const lines: string[] = [
    JSON.stringify({ sessionId, cwd: dir, type: "user", timestamp: "2026-08-07T00:00:00.000Z", message: { role: "user", content: "hi" } }),
  ];
  if (opts.url) {
    lines.push(
      JSON.stringify({
        sessionId,
        cwd: dir,
        type: "system",
        timestamp: "2026-08-07T00:00:01.000Z",
        content: `Remote control enabled: ${opts.url}`,
      }),
    );
  }
  for (const u of opts.usage ?? []) {
    lines.push(
      JSON.stringify({
        sessionId,
        cwd: dir,
        type: "assistant",
        timestamp: "2026-08-07T00:00:02.000Z",
        message: {
          id: u.requestId,
          role: "assistant",
          model: u.model,
          usage: {
            input_tokens: u.input ?? 100,
            output_tokens: u.output ?? 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      }),
    );
  }
  lines.push(...(opts.extraLines ?? []));
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  if (opts.mtimeSeconds !== undefined) utimesSync(path, opts.mtimeSeconds, opts.mtimeSeconds);
  return path;
}

function decisionFor(overrides: { cliProfile?: string; operation?: OrchestratorSessionOperation } = {}): OrchestratorDecision {
  const res = resolveOrchestratorLaunch({
    projectDir,
    authProbe: ALWAYS_AVAILABLE as never,
    ...overrides,
  });
  assert.ok(res.ok, `fixture policy failed to resolve: ${res.ok ? "" : res.refusal.message}`);
  return res.decision;
}

type Fixture = { ctx: AdapterLaunchContext; receiptId: string; taskId: string };

/** A launch that has already reached `running`: the receipt exists, the
 *  instrumentation run/task exist, and the adapter context names them. This is the
 *  state the adapter's onSpawnConfirmed / closeOut actually run in. */
function launchedSession(
  opts: { sessionKey?: string; operation?: OrchestratorSessionOperation; dir?: string } = {},
): Fixture {
  const dir = opts.dir ?? projectDir;
  const operation: OrchestratorSessionOperation = opts.operation ?? { kind: "new" };
  const sessionKey = opts.sessionKey ?? OWNER_SESSION;
  const decision = decisionFor({ operation });
  const receiptId = newOrchestratorReceiptId();
  const runId = `run-${receiptId}`;
  const taskId = `task-${receiptId}`;

  insertRun({ id: runId, workflow: "orchestrator", title: "fixture", status: "active", createdAt: new Date().toISOString(), projectDir: dir });
  insertTask({
    id: taskId,
    runId,
    phase: "session",
    agentRole: "orchestrator",
    status: "running",
    taskPackage: { taskId, runId, phase: "session", role: "orchestrator", inputs: { projectDir: dir }, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  });

  persistPendingOrchestratorReceipt({
    receiptId,
    sessionKey,
    projectDir: dir,
    projectName: "fixture-project",
    resolvedProfile: decision.profile ?? null,
    runtime: decision.runtime,
    provider: decision.provider,
    model: decision.modelExplicit ? decision.model : null,
    authMode: decision.auth,
    resolvedBy: decision.resolvedBy,
    adapter: decision.adapter,
    sessionOperation: operation.kind,
    providerSessionId: operation.kind === "continue" ? null : sessionKey,
    identityStrength: operation.kind === "continue" ? "unknown" : "asserted",
    taskId,
    launcherPid: process.pid,
  });
  markOrchestratorReceiptRunning(receiptId, { launcherPid: process.pid, launcherIdentity: "fixture" });

  return {
    receiptId,
    taskId,
    ctx: {
      decision,
      projectDir: dir,
      projectName: "fixture-project",
      sessionKey,
      receiptId,
      runId,
      taskId,
      operation,
      passthrough: [],
      parentEnv: process.env,
    },
  };
}

function adapter(overrides: Parameters<typeof createClaudeAdapter>[0] = {}) {
  return createClaudeAdapter({ remoteControlPollMs: 5, ...overrides });
}

// ---------------------------------------------------------------------------
// AC13 — the seam itself
// ---------------------------------------------------------------------------

test("integ FG-576 AC13: the Claude state root resolves through the env seam, so no test reads the operator's ~/.claude", () => {
  assert.equal(claudeStateDir(), claudeState);

  process.env["FORGE_CLAUDE_STATE_DIR"] = "";
  delete process.env["FORGE_CLAUDE_STATE_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config-seam");
  assert.equal(claudeStateDir(), join(base, "claude-config-seam"));

  // Resolved at CALL time. A module-eval snapshot would have frozen the operator's
  // real root at import and every read below would have gone there.
  process.env["FORGE_CLAUDE_STATE_DIR"] = claudeState;
  assert.equal(claudeStateDir(), claudeState);
  assert.ok(orchestratorRemoteControlDir().startsWith(home), orchestratorRemoteControlDir());
});

// ---------------------------------------------------------------------------
// FG-448 — correct-session capture
// ---------------------------------------------------------------------------

test("integ FG-576/FG-448: with the NON-owning transcript newest, the URL and the usage bind to the receipt's asserted session", () => {
  // The owning session's transcript is OLDER. The previous reader took the newest
  // .jsonl in the project dir, which is exactly how an unrelated live session's
  // control credential gets attributed to a session that does not own it.
  writeTranscript(projectDir, OWNER_SESSION, {
    url: OWNER_URL,
    usage: [{ requestId: "req_owner_1", model: "claude-sonnet-4-6" }],
    mtimeSeconds: 1_000_000,
  });
  writeTranscript(projectDir, OTHER_SESSION, {
    url: OTHER_URL,
    usage: [{ requestId: "req_other_1", model: "claude-sonnet-4-6" }],
    mtimeSeconds: 2_000_000,
  });

  const fixture = launchedSession();
  const a = adapter();
  a.onSpawnConfirmed(fixture.ctx, { pid: 4242 });

  const link = readRemoteControlLink(OWNER_SESSION);
  assert.ok(link, "the live session's remote-control URL was not captured — FG-448 makes capture required");
  assert.equal(link.url, OWNER_URL);
  assert.equal(link.receiptId, fixture.receiptId);
  assert.equal(link.projectDir, projectDir);

  // The unrelated, NEWER session's credential is nowhere: not under its own key
  // (nothing captured it) and not under the owner's.
  assert.equal(readRemoteControlLink(OTHER_SESSION), undefined);
  assert.notEqual(link.url, OTHER_URL);

  a.closeOut(fixture.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });

  const rows = usageForTask(fixture.taskId);
  assert.deepEqual(rows.map((r) => r.requestId), ["req_owner_1"]);
  assert.equal(rows[0]!.taskId, fixture.taskId, "usage must carry the receipt's task id (AC12)");
  assert.equal(rows[0]!.inputTokens, 100);
});

test("integ FG-576 AC10/FG-448: a --continue launch asserts no identity, so nothing is captured by recency", () => {
  writeTranscript(projectDir, OTHER_SESSION, {
    url: OTHER_URL,
    usage: [{ requestId: "req_other_1", model: "claude-sonnet-4-6" }],
  });

  const fixture = launchedSession({ operation: { kind: "continue" }, sessionKey: "33333333-3333-4333-8333-333333333333" });
  const a = adapter();
  a.onSpawnConfirmed(fixture.ctx, { pid: 4242 });
  a.closeOut(fixture.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });

  assert.equal(readRemoteControlLink(fixture.ctx.sessionKey), undefined);
  assert.equal(remoteControlLinksForProject(projectDir).length, 0);
  assert.equal(usageForTask(fixture.taskId).length, 0, "usage was attributed to a session Forge never asserted");
});

test("integ FG-576/FG-448: a credential captured for project A is never returned for project B", () => {
  writeTranscript(projectDir, OWNER_SESSION, { url: OWNER_URL });
  const fixture = launchedSession();
  adapter().onSpawnConfirmed(fixture.ctx, { pid: 1 });

  assert.equal(remoteControlLinksForProject(projectDir).length, 1);
  assert.deepEqual(remoteControlLinksForProject(otherProjectDir), []);
});

// ---------------------------------------------------------------------------
// FG-448 — stale-session refusal and the session-length lifetime
// ---------------------------------------------------------------------------

test("integ FG-576/FG-448: an ended receipt yields no URL, and the stale credential file is removed", () => {
  writeTranscript(projectDir, OWNER_SESSION, { url: OWNER_URL });
  const fixture = launchedSession();
  adapter().onSpawnConfirmed(fixture.ctx, { pid: 1 });

  const credentialFile = join(orchestratorRemoteControlDir(), `${OWNER_SESSION}.json`);
  assert.equal(existsSync(credentialFile), true);
  assert.ok(readRemoteControlLink(OWNER_SESSION));

  // The launcher was SIGKILLed: close-out never ran, so the file is still there.
  // The receipt is the authority, and a read that cannot prove the session is still
  // running yields nothing — and takes the stale credential with it.
  closeOrchestratorReceipt(fixture.receiptId, { state: "orphaned", reason: "launcher lost" });

  assert.equal(readRemoteControlLink(OWNER_SESSION), undefined, "an ended session's control credential was served");
  assert.equal(existsSync(credentialFile), false, "the stale credential file survived the read");
});

test("integ FG-576/FG-448: close-out removes the credential on a clean exit and on a spawn failure alike", () => {
  writeTranscript(projectDir, OWNER_SESSION, { url: OWNER_URL });

  const clean = launchedSession();
  const a1 = adapter();
  a1.onSpawnConfirmed(clean.ctx, { pid: 1 });
  assert.ok(readRemoteControlLink(OWNER_SESSION));
  a1.closeOut(clean.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });
  assert.equal(existsSync(join(orchestratorRemoteControlDir(), `${OWNER_SESSION}.json`)), false);

  // A spawn that never happened: nothing to capture, nothing left behind, and the
  // orchestrator task is settled rather than left `running` with no process.
  const failed = launchedSession({ sessionKey: "44444444-4444-4444-8444-444444444444" });
  const a2 = adapter();
  a2.closeOut(failed.ctx, { state: "spawn_failed", exitCode: null, signal: null, reason: "ENOENT" });
  assert.equal(readRemoteControlLink(failed.ctx.sessionKey), undefined);
  assert.equal(getTask(failed.taskId)?.status, "failed");
});

test("integ FG-576/FG-448: a credential whose receipt does not exist at all is refused and removed", () => {
  assert.equal(
    stashRemoteControlLink({
      sessionKey: OWNER_SESSION,
      receiptId: "orx-doesnotexist",
      projectDir,
      url: OWNER_URL,
      capturedAt: new Date().toISOString(),
    }),
    true,
  );
  assert.equal(readRemoteControlLink(OWNER_SESSION), undefined);
  assert.equal(existsSync(join(orchestratorRemoteControlDir(), `${OWNER_SESSION}.json`)), false);
});

// ---------------------------------------------------------------------------
// Fail-closed: absence, unreadable state, malformed JSON
// ---------------------------------------------------------------------------

test("integ FG-576/FG-448: a missing transcript yields no link, no usage and no error", () => {
  const fixture = launchedSession();
  const a = adapter();
  a.onSpawnConfirmed(fixture.ctx, { pid: 1 });
  a.closeOut(fixture.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });

  assert.equal(readRemoteControlLink(OWNER_SESSION), undefined);
  assert.equal(usageForTask(fixture.taskId).length, 0);
  assert.equal(getTask(fixture.taskId)?.status, "complete", "a missing transcript must not fail the session");
});

test("integ FG-576/FG-448: transcript state that cannot be read as a file yields no link, no usage and no error", () => {
  // A DIRECTORY where the transcript should be. Chosen over chmod 000 on purpose:
  // this test must assert the same thing when the suite runs as root, which a
  // permission bit cannot express.
  mkdirSync(join(transcriptDir(projectDir), `${OWNER_SESSION}.jsonl`), { recursive: true });

  const fixture = launchedSession();
  const a = adapter();
  a.onSpawnConfirmed(fixture.ctx, { pid: 1 });
  a.closeOut(fixture.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });

  assert.equal(findClaudeTranscript(projectDir, OWNER_SESSION), null);
  assert.equal(readRemoteControlLink(OWNER_SESSION), undefined);
  assert.equal(usageForTask(fixture.taskId).length, 0);
});

test("integ FG-576/FG-448: malformed transcript JSON yields no link, no usage and no error", () => {
  writeTranscript(projectDir, OWNER_SESSION, {
    extraLines: ["{not json at all", '{"sessionId":', " garbage"],
  });

  const fixture = launchedSession();
  const a = adapter();
  a.onSpawnConfirmed(fixture.ctx, { pid: 1 });
  a.closeOut(fixture.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });

  assert.equal(readRemoteControlLink(OWNER_SESSION), undefined);
  assert.equal(usageForTask(fixture.taskId).length, 0);
  assert.equal(getTask(fixture.taskId)?.status, "complete");
});

test("integ FG-576/FG-448: a corrupt credential file is not served", () => {
  mkdirSync(orchestratorRemoteControlDir(), { recursive: true });
  writeFileSync(join(orchestratorRemoteControlDir(), `${OWNER_SESSION}.json`), "{ broken", "utf8");
  assert.equal(readRemoteControlLink(OWNER_SESSION), undefined);

  // A hand-written file whose `url` is not a Claude remote-control URL is rejected
  // outright rather than handed to a browser.
  writeFileSync(
    join(orchestratorRemoteControlDir(), `${OTHER_SESSION}.json`),
    JSON.stringify({ kind: "forge-orchestrator-remote-control", sessionKey: OTHER_SESSION, receiptId: "orx-x", projectDir, url: "https://evil.example/x" }),
    "utf8",
  );
  assert.equal(readRemoteControlLink(OTHER_SESSION), undefined);
});

test("FG-576/FG-448: the URL extractor accepts only the Claude remote-control form", () => {
  assert.equal(findRemoteControlUrlInText(`see ${OWNER_URL} now`), OWNER_URL);
  assert.equal(findRemoteControlUrlInText("https://claude.ai/code/"), null);
  assert.equal(findRemoteControlUrlInText("https://evil.example/code/session_0123"), null);
  assert.equal(findRemoteControlUrlInText("no url here"), null);
});

test("FG-576/FG-448: capture is a no-op for an identity Forge did not assert", () => {
  writeTranscript(projectDir, OTHER_SESSION, { url: OTHER_URL });
  const capture = startRemoteControlCapture({
    projectDir,
    sessionKey: OTHER_SESSION,
    receiptId: "orx-whatever",
    providerSessionId: OTHER_SESSION,
    identityStrength: "correlated",
  });
  assert.equal(capture.tick(), null);
  capture.stop();
  assert.equal(existsSync(orchestratorRemoteControlDir()), false);
});

// ---------------------------------------------------------------------------
// AC12 — usage binds to the receipt, mismatch is surfaced not rewritten
// ---------------------------------------------------------------------------

test("integ FG-576 AC12: a provider/receipt model mismatch is reported, and neither the row nor the receipt is rewritten", () => {
  writeTranscript(projectDir, OWNER_SESSION, {
    usage: [{ requestId: "req_1", model: "claude-opus-4-7" }],
  });

  const fixture = launchedSession();
  const reported: string[] = [];
  adapter({ report: (line) => reported.push(line) }).closeOut(fixture.ctx, {
    state: "exited",
    exitCode: 0,
    signal: null,
    reason: null,
  });

  const rows = usageForTask(fixture.taskId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.model, "claude-opus-4-7", "the provider's own model value was rewritten");
  assert.equal(getOrchestratorReceipt(fixture.receiptId)?.model, "claude-sonnet-4-6", "the receipt was rewritten");

  assert.equal(reported.length, 1, reported.join("\n"));
  assert.match(reported[0]!, /claude-opus-4-7/);
  assert.match(reported[0]!, /claude-sonnet-4-6/);
  assert.match(reported[0]!, /req_1/);
});

test("FG-576 AC12: a bedrock-prefixed receipt model and the provider's short form are the same selection", () => {
  assert.equal(normalizeModelId("us.anthropic.claude-sonnet-4-6"), "claude-sonnet-4-6");
  const rows = [
    { taskId: "t", requestId: "r1", model: "claude-sonnet-4-6", alias: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, createdAt: "now" },
  ];
  assert.deepEqual(usageModelMismatches(rows, "us.anthropic.claude-sonnet-4-6"), []);
  assert.equal(usageModelMismatches(rows, null).length, 0, "legacy mode records no model, so nothing can disagree");
  assert.equal(usageModelMismatches(rows, "claude-opus-4-7").length, 1);
});

test("FG-576 AC12: transcript extraction refuses entries belonging to another session", () => {
  const path = writeTranscript(projectDir, OWNER_SESSION, {
    usage: [{ requestId: "req_owner", model: "claude-sonnet-4-6" }],
    extraLines: [
      JSON.stringify({
        sessionId: OTHER_SESSION,
        cwd: projectDir,
        type: "assistant",
        message: { id: "req_foreign", role: "assistant", model: "claude-sonnet-4-6", usage: { input_tokens: 9, output_tokens: 9 } },
      }),
    ],
  });

  const bound = extractUsageFromTranscript(path, { taskId: "t", sessionId: OWNER_SESSION });
  assert.deepEqual(bound.map((r) => r.requestId), ["req_owner"]);

  // Without the binding the foreign entry is taken — which is what makes the
  // sessionId filter defense in depth rather than decoration.
  const unbound = extractUsageFromTranscript(path, { taskId: "t" });
  assert.equal(unbound.length, 2);
});

test("integ FG-576 AC12: usage is not written when there is no receipt task to bind it to", () => {
  writeTranscript(projectDir, OWNER_SESSION, { usage: [{ requestId: "req_1", model: "claude-sonnet-4-6" }] });
  const fixture = launchedSession();

  const capture = captureClaudeOrchestratorUsage({
    projectDir,
    sessionKey: OWNER_SESSION,
    receiptId: fixture.receiptId,
    providerSessionId: OWNER_SESSION,
    identityStrength: "asserted",
    taskId: null,
    expectedModel: "claude-sonnet-4-6",
  });

  assert.equal(capture.rowCount, 0);
  assert.match(capture.skipped ?? "", /nothing for usage rows to bind to/);
  assert.equal(capture.error, null);
  assert.equal(usageForTask(fixture.taskId).length, 0);
});

// ---------------------------------------------------------------------------
// The credential is never durable
// ---------------------------------------------------------------------------

test("integ FG-576/FG-448: the URL never reaches a durable write path, during the session or after it", () => {
  writeTranscript(projectDir, OWNER_SESSION, {
    url: OWNER_URL,
    usage: [{ requestId: "req_1", model: "claude-sonnet-4-6" }],
  });

  const fixture = launchedSession();
  const a = adapter();
  a.onSpawnConfirmed(fixture.ctx, { pid: 1 });
  assert.ok(readRemoteControlLink(OWNER_SESSION), "precondition: the URL was captured");

  // WHILE LIVE: the credential exists, but nothing durable carries it. The receipt
  // is the durable record of the launch and the project projection is assembled
  // ACROSS projects — a credential in either is a leak that outlives the session.
  const receipt = JSON.stringify(getOrchestratorReceipt(fixture.receiptId));
  assert.equal(receipt.includes("claude.ai/code"), false, "the receipt persisted a live control credential");
  const projects = JSON.stringify(listProjects());
  assert.equal(projects.includes("claude.ai/code"), false, "a cross-project projection carried a control credential");

  a.closeOut(fixture.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });

  // AFTER the session: gone from the ephemeral store, and still absent everywhere
  // durable — including the usage rows the same close-out just wrote.
  assert.equal(readRemoteControlLink(OWNER_SESSION), undefined);
  assert.deepEqual(remoteControlLinksForProject(projectDir), []);
  assert.equal(JSON.stringify(getOrchestratorReceipt(fixture.receiptId)).includes("claude.ai/code"), false);
  assert.equal(JSON.stringify(usageForTask(fixture.taskId)).includes("claude.ai/code"), false);
  assert.equal(JSON.stringify(getTask(fixture.taskId)).includes("claude.ai/code"), false);
  assert.equal(JSON.stringify(listProjects()).includes("claude.ai/code"), false);

  // And nothing was written into the project itself.
  for (const name of readdirSync(projectDir)) {
    const body = readFileSync(join(projectDir, name), "utf8");
    assert.equal(body.includes("claude.ai/code"), false, `${name} carries the control credential`);
  }
});

// ---------------------------------------------------------------------------
// Nothing here writes to the fake Claude state root
// ---------------------------------------------------------------------------

test("integ FG-576 AC13: the Claude state root is only ever READ — a session leaves it byte-identical", () => {
  const path = writeTranscript(projectDir, OWNER_SESSION, {
    url: OWNER_URL,
    usage: [{ requestId: "req_1", model: "claude-sonnet-4-6" }],
  });
  const before = readFileSync(path, "utf8");
  const beforeEntries = readdirSync(transcriptDir(projectDir));

  const fixture = launchedSession();
  const a = adapter();
  a.onSpawnConfirmed(fixture.ctx, { pid: 1 });
  a.closeOut(fixture.ctx, { state: "exited", exitCode: 0, signal: null, reason: null });

  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(transcriptDir(projectDir)), beforeEntries);
});

test("FG-576/FG-448: clearing a credential twice is a no-op, not a failure", () => {
  clearRemoteControlLink(OWNER_SESSION);
  clearRemoteControlLink(OWNER_SESSION);
  clearRemoteControlLink("../../etc/passwd");
  assert.equal(readRemoteControlLink("../../etc/passwd"), undefined);
});
