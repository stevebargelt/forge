// FG-576 step 10 — `forge show` explains the live orchestrator choice, and reads
// LIVENESS rather than a stale status column.
//
// The defect this closes is concrete: an interactive orchestrator is never a
// reconcile candidate (reconciliation probes a CONTAINER, and there isn't one), and
// `forge claude` marks its task complete only inside the child-exit handler — so a
// SIGKILL or a lost terminal leaves an `active` row that no surface ever corrects.
// The fix is a JOIN: the receipt says what was SELECTED and that a spawn was once
// confirmed; the launcher-owned liveness record says whether anything is alive NOW.
//
// What each test proves, by acceptance criterion:
//
//   AC11  a running receipt with a live launcher renders all TEN recorded fields
//         (profile, runtime, provider, model, auth, adapter, resolved_by, session
//         operation, identity strength, capability limitations) in BOTH the human
//         and the --json surface — what was selected and why.
//   AC7   the SAME receipt whose launcher identity is provably gone renders as
//         ORPHANED and NOT running — asserted against the SURFACE PROJECTION, not
//         merely against the record file — and the receipt row is not mutated or
//         deleted by the read.
//   AC7   interaction evidence that is ABSENT never renders as healthy, and a
//         hook-only record (recent turns, no process fence) is still not `running`.
//   AC12  a Codex receipt renders provider/runtime/adapter as openai/codex-cli/codex
//         and SHOWS its recorded usage limitation rather than omitting it — and no
//         usage number is invented anywhere.
//   AC13  every fixture lives under a disposable FORGE_HOME / FORGE_DB_PATH /
//         FORGE_ORCHESTRATORS_DIR. No real auth, no provider CLI, no billed session.
//
// Plus the read-only invariant (#298): the default `forge show` path — and
// `--reconcile` addressed at a receipt — leave the store and the liveness directory
// byte-identical.
//
// The liveness fixtures fence on THIS test process: the "alive" record carries this
// process's real pid + OS start token (the CLI child probes it and finds it running),
// and the "dead" record carries the same pid with a mutated start token, which is
// exactly the recycled-pid case D14 requires to read as DEAD rather than unknown.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../../store/schema.js";
import { ORCHESTRATOR_RECEIPT_COLUMNS, rowToOrchestratorReceipt, type OrchestratorReceiptRow } from "../../store/orchestrator-receipts.js";
import { captureProcessIdentity } from "../../util/process-identity.js";
import { projectOrchestratorReceipt } from "./show.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CLI = join(REPO, "src", "cli", "index.ts");

const PROJECT = "/tmp/test-project";
const NOW = "2026-08-07T12:00:00.000Z";

const CLAUDE_SESSION = "11111111-2222-3333-4444-555555555555";
const CODEX_SESSION = "99999999-8888-7777-6666-555555555555";
const HOOK_ONLY_SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let home = "";
let dbPath = "";
let hbDir = "";

type Receipt = {
  receipt_id: string;
  session_key: string;
  state: string;
  project_name: string | null;
  resolved_profile: string | null;
  runtime: string;
  provider: string;
  model: string | null;
  auth_mode: string | null;
  resolved_by: string | null;
  adapter: string;
  session_operation: string;
  session_target?: string | null;
  provider_session_id?: string | null;
  identity_strength: string;
  identity_basis?: string | null;
  carrier_acceptance?: string;
  carrier_generation?: string | null;
  limitations?: { capability: string; note: string }[];
  task_id?: string | null;
};

function insertReceipt(db: Database.Database, r: Receipt): void {
  db.prepare(
    `INSERT INTO orchestrator_receipts (${ORCHESTRATOR_RECEIPT_COLUMNS})
     VALUES (@receipt_id, @session_key, @state, @created_at, @updated_at, @project_dir, @project_name,
             @resolved_profile, @runtime, @provider, @model, @auth_mode, @resolved_by, @adapter,
             @session_operation, @session_target, @provider_session_id, @identity_strength,
             @identity_basis, @carrier_generation, @carrier_path, @carrier_acceptance,
             @carrier_evidence, @limitations, @task_id, @launcher_pid, @launcher_identity,
             @started_at, @closed_at, @exit_code, @exit_signal, @failure_reason)`,
  ).run({
    receipt_id: r.receipt_id,
    session_key: r.session_key,
    state: r.state,
    created_at: NOW,
    updated_at: NOW,
    project_dir: PROJECT,
    project_name: r.project_name,
    resolved_profile: r.resolved_profile,
    runtime: r.runtime,
    provider: r.provider,
    model: r.model,
    auth_mode: r.auth_mode,
    resolved_by: r.resolved_by,
    adapter: r.adapter,
    session_operation: r.session_operation,
    session_target: r.session_target ?? null,
    provider_session_id: r.provider_session_id ?? null,
    identity_strength: r.identity_strength,
    identity_basis: r.identity_basis ?? null,
    carrier_generation: r.carrier_generation ?? null,
    carrier_path: null,
    carrier_acceptance: r.carrier_acceptance ?? "unproven",
    carrier_evidence: null,
    limitations: JSON.stringify(r.limitations ?? []),
    task_id: r.task_id ?? null,
    launcher_pid: process.pid,
    launcher_identity: "fixture",
    started_at: r.state === "pending" ? null : NOW,
    closed_at: null,
    exit_code: null,
    exit_signal: null,
    failure_reason: null,
  });
}

/** A launcher liveness record whose process fence points at THIS test process —
 *  provably alive from the CLI child's perspective. */
function writeAliveLauncherRecord(sessionId: string): void {
  const identity = captureProcessIdentity(process.pid);
  assert.ok(identity.startToken, "this platform must supply a process start token for the fence fixture");
  writeFileSync(
    join(hbDir, `${sessionId}.launcher.json`),
    JSON.stringify({
      kind: "forge-launcher-orchestrator",
      version: 1,
      sessionId,
      projectDir: PROJECT,
      startedAt: NOW,
      refreshedAt: NOW,
      provider: "anthropic",
      runtime: "claude-code",
      adapter: "claude",
      process: identity,
    }),
  );
}

/** The same pid with a MUTATED start token — the recycled-pid case. The pid is
 *  held (by this test process), so only the fence can tell that the launcher that
 *  recorded it is gone. */
function writeDeadLauncherRecord(sessionId: string): void {
  const identity = captureProcessIdentity(process.pid);
  writeFileSync(
    join(hbDir, `${sessionId}.launcher.json`),
    JSON.stringify({
      kind: "forge-launcher-orchestrator",
      version: 1,
      sessionId,
      projectDir: PROJECT,
      startedAt: NOW,
      refreshedAt: NOW,
      provider: "anthropic",
      runtime: "claude-code",
      adapter: "claude",
      process: { ...identity, startToken: `${identity.startToken ?? "x"}-recycled` },
    }),
  );
}

/** The legacy Claude hook shape: interaction evidence only, no process fence. */
function writeHookRecord(sessionId: string, lastSeen: string): void {
  writeFileSync(
    join(hbDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, projectDir: PROJECT, startedAt: NOW, lastSeen }),
  );
}

function forge(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_DB_PATH: dbPath,
      FORGE_ORCHESTRATORS_DIR: hbDir,
      NO_NOTIFY: "true",
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function showJson(id: string): Record<string, any> {
  const res = forge("show", id, "--json");
  assert.equal(res.status, 0, `forge show ${id} --json failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as Record<string, any>;
}

/** A semantic snapshot of everything `forge show` could plausibly mutate.
 *
 *  Deliberately NOT a hash of forge.db: the store runs in WAL mode, so a write
 *  can land in forge.db-wal and leave the main file's bytes untouched — a
 *  file-hash comparison would pass over exactly the mutation it claims to catch.
 *  Reading the rows back through SQLite sees the WAL too. */
function storeSnapshot(): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify({
      receipts: db.prepare(`SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts ORDER BY receipt_id`).all(),
      tasks: db.prepare("SELECT * FROM tasks ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      // #298's own regression: a reconcile writes task.reconciled / run.reconciled.
      events: db.prepare("SELECT count(*) AS n FROM events").get(),
    });
  } finally {
    db.close();
  }
}

function hashDir(dir: string): string {
  const h = createHash("sha256");
  for (const name of readdirSync(dir).sort()) {
    h.update(name).update(readFileSync(join(dir, name)));
  }
  return h.digest("hex");
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "fg576-show-"));
  dbPath = join(home, "forge.db");
  hbDir = join(home, "orchestrators");
  mkdirSync(hbDir, { recursive: true });
  mkdirSync(PROJECT, { recursive: true });

  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  // A run + task so the task-bound projection has something to hang off: the
  // `forge claude` shape whose row stays `running` after the launcher is killed.
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'invoke', 'orchestrator', 'active', ?, ?)`,
  ).run("run-fg576", NOW, PROJECT);
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at)
     VALUES (?, 'run-fg576', 'orchestrate', 'orchestrator', 'running', '{}', ?, ?)`,
  ).run("task-fg576", NOW, NOW);

  // The Claude receipt every liveness case re-reads. One receipt, two worlds:
  // the alive fence and the dead fence are swapped in the liveness dir, never here.
  insertReceipt(db, {
    receipt_id: "orx-claude01",
    session_key: CLAUDE_SESSION,
    state: "running",
    project_name: "test-project",
    resolved_profile: "claude-subscription",
    runtime: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    auth_mode: "anthropic-oauth",
    resolved_by: "policy:overrides.agents.orchestrator",
    adapter: "claude",
    session_operation: "new",
    provider_session_id: CLAUDE_SESSION,
    identity_strength: "asserted",
    identity_basis: "forge minted --session-id",
    carrier_acceptance: "accepted",
    carrier_generation: "gen-2026-08-07",
    task_id: "task-fg576",
  });

  // AC12: Codex — an honest provider/runtime/adapter and an explicit limitation.
  insertReceipt(db, {
    receipt_id: "orx-codex01",
    session_key: CODEX_SESSION,
    state: "running",
    project_name: "test-project",
    resolved_profile: "codex-subscription",
    runtime: "codex-cli",
    provider: "openai",
    model: "gpt-5-codex",
    auth_mode: "openai-subscription",
    resolved_by: "policy:defaults.profile",
    adapter: "codex",
    session_operation: "continue",
    session_target: "most-recent",
    provider_session_id: null,
    identity_strength: "correlated",
    identity_basis: "newest rollout file in the project window",
    limitations: [
      { capability: "usage_capture", note: "codex supplies no equivalent per-session usage evidence; no values are recorded" },
      { capability: "remote_control", note: "no remote-control surface is claimed for codex" },
    ],
  });

  // A hook-only session: recent interaction evidence, NO launcher process fence.
  insertReceipt(db, {
    receipt_id: "orx-hookonly",
    session_key: HOOK_ONLY_SESSION,
    state: "running",
    project_name: "test-project",
    resolved_profile: "claude-subscription",
    runtime: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    auth_mode: "anthropic-oauth",
    resolved_by: "policy:defaults.profile",
    adapter: "claude",
    session_operation: "new",
    identity_strength: "asserted",
  });

  // Pre-spawn: recorded, never live.
  insertReceipt(db, {
    receipt_id: "orx-pending1",
    session_key: "cccccccc-dddd-eeee-ffff-000000000000",
    state: "pending",
    project_name: "test-project",
    resolved_profile: "claude-subscription",
    runtime: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    auth_mode: "anthropic-oauth",
    resolved_by: "cli:--profile",
    adapter: "claude",
    session_operation: "new",
    identity_strength: "asserted",
  });
  db.close();

  writeAliveLauncherRecord(CODEX_SESSION);
  writeHookRecord(HOOK_ONLY_SESSION, new Date(Date.now() - 60_000).toISOString());
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function receiptRow(receiptId: string): OrchestratorReceiptRow {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(`SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts WHERE receipt_id = ?`)
      .get(receiptId) as OrchestratorReceiptRow;
  } finally {
    db.close();
  }
}

describe("FG-576 AC11 — forge show explains the live orchestrator choice", () => {
  test("a running receipt with a provably alive launcher renders RUNNING and all ten recorded fields (human + --json)", () => {
    writeAliveLauncherRecord(CLAUDE_SESSION);

    const human = forge("show", "orx-claude01");
    assert.equal(human.status, 0, human.stderr);
    const out = human.stdout;
    assert.match(out, /Orchestrator orx-claude01/);
    assert.match(out, /state:\s+running\s+\(receipt records: running\)/);
    assert.match(out, /launcher process ALIVE \(identity fence\)/);
    // AC11's ten fields, each named on the surface an operator reads.
    assert.match(out, /profile:\s+claude-subscription/);
    assert.match(out, /runtime:\s+claude-code/);
    assert.match(out, /provider:\s+anthropic/);
    assert.match(out, /model:\s+claude-opus-5/);
    assert.match(out, /auth:\s+anthropic-oauth/);
    assert.match(out, /adapter:\s+claude/);
    assert.match(out, /resolved_by:\s+policy:overrides\.agents\.orchestrator/);
    assert.match(out, /operation:\s+new/);
    assert.match(out, /identity:\s+asserted/);
    assert.match(out, /limitations:/);
    // ...and WHY, not merely what.
    assert.match(out, /provably alive by process identity/);

    const json = showJson("orx-claude01");
    assert.equal(json["liveness"].running, true);
    assert.equal(json["liveness"].presentation, "running");
    assert.equal(json["diagnostic"].running, true);
    assert.deepEqual(
      {
        resolvedProfile: json["selection"].resolvedProfile,
        runtime: json["selection"].runtime,
        provider: json["selection"].provider,
        model: json["selection"].model,
        authMode: json["selection"].authMode,
        adapter: json["selection"].adapter,
        resolvedBy: json["selection"].resolvedBy,
        sessionOperation: json["selection"].sessionOperation,
        identityStrength: json["selection"].identityStrength,
        limitations: json["selection"].limitations,
      },
      {
        resolvedProfile: "claude-subscription",
        runtime: "claude-code",
        provider: "anthropic",
        model: "claude-opus-5",
        authMode: "anthropic-oauth",
        adapter: "claude",
        resolvedBy: "policy:overrides.agents.orchestrator",
        sessionOperation: "new",
        identityStrength: "asserted",
        limitations: [],
      },
    );
    // AC7: no provider hook for this session => interaction UNKNOWN, and unknown
    // is never promoted to healthy just because the process is alive.
    assert.equal(json["liveness"].interaction, "unknown");
    assert.equal(json["liveness"].health, "unknown");
    assert.match(json["liveness"].explanation, /absence of a provider hook is never reported as healthy liveness/);
  });

  test("addressable by canonical session key and by the provider's own session id", () => {
    writeAliveLauncherRecord(CLAUDE_SESSION);
    for (const id of [CLAUDE_SESSION, "orx-claude01"]) {
      const json = showJson(id);
      assert.equal(json["orchestrator"].receiptId, "orx-claude01");
    }
  });
});

describe("FG-576 AC7 — liveness, not a stale status column", () => {
  test("the SAME receipt renders ORPHANED and NOT running once its launcher identity is provably gone", () => {
    // Same row, same store — only the process fence in the liveness record changes.
    writeAliveLauncherRecord(CLAUDE_SESSION);
    assert.equal(showJson("orx-claude01")["liveness"].running, true);

    writeDeadLauncherRecord(CLAUDE_SESSION);
    const json = showJson("orx-claude01");
    assert.equal(json["liveness"].running, false, "a dead launcher identity must never report running");
    assert.equal(json["liveness"].presentation, "orphaned");
    assert.equal(json["liveness"].processLiveness, "dead");
    // The receipt still RECORDS running — the surface answer differs from the
    // column, which is the whole point of the join.
    assert.equal(json["orchestrator"].state, "running");
    assert.equal(json["orchestrator"].claimsRunning, true);
    assert.equal(receiptRow("orx-claude01").state, "running", "the read must not rewrite the receipt");

    const human = forge("show", "orx-claude01");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /state:\s+orphaned\s+\(receipt records: running\)/);
    assert.match(human.stdout, /launcher process DEAD/);
    assert.match(human.stdout, /provably GONE/);
    assert.doesNotMatch(human.stdout, /state:\s+running/);
  });

  test("a receipt claiming running with NO liveness record is unverified — never running, never healthy", () => {
    rmSync(join(hbDir, `${CLAUDE_SESSION}.launcher.json`), { force: true });
    const json = showJson("orx-claude01");
    assert.equal(json["liveness"].running, false);
    assert.equal(json["liveness"].presentation, "unverified");
    assert.equal(json["liveness"].livenessRecord, false);
    assert.equal(json["liveness"].health, "unknown");
    assert.match(json["liveness"].explanation, /liveness could not be PROVEN/);
  });

  test("hook interaction evidence alone does not make a session running (no process fence)", () => {
    const json = showJson("orx-hookonly");
    assert.equal(json["liveness"].running, false);
    assert.equal(json["liveness"].presentation, "unverified");
    assert.equal(json["liveness"].processLiveness, "unknown");
    assert.equal(json["liveness"].interaction, "recent");
    assert.deepEqual(json["liveness"].livenessSources, ["provider-hook"]);
    assert.match(json["liveness"].explanation, /evidence of ACTIVITY, not of a live process/);
  });

  test("a pending receipt is recorded but never rendered as live", () => {
    const json = showJson("orx-pending1");
    assert.equal(json["liveness"].running, false);
    assert.equal(json["liveness"].presentation, "pending");
    assert.match(json["liveness"].explanation, /BEFORE spawn/);
  });

  test("a task whose interactive orchestrator is orphaned does not read as ordinary live work", () => {
    writeDeadLauncherRecord(CLAUDE_SESSION);
    const human = forge("show", "task-fg576");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /orchestrator: orx-claude01\s+orphaned/);
    assert.match(human.stdout, /launcher process DEAD/);

    const json = showJson("task-fg576");
    assert.equal(json["diagnostic"].orchestrator.liveness.running, false);
    assert.equal(json["diagnostic"].orchestrator.liveness.presentation, "orphaned");
    assert.equal(json["diagnostic"].orchestrator.receipt.receiptId, "orx-claude01");
    // The task row itself is untouched: the projection explains it, never repairs it.
    assert.equal(json["task"].status, "running");
  });

  test("the pure projection is the same decision the CLI renders", () => {
    const receipt = rowToOrchestratorReceipt(receiptRow("orx-claude01"));
    const dead = projectOrchestratorReceipt(receipt, {
      sessionId: receipt.sessionKey,
      projectDir: PROJECT,
      startedAt: NOW,
      lastSeen: NOW,
      isLive: false,
      state: "orphaned",
      processLiveness: "dead",
      interaction: "unknown",
      health: "unknown",
      finalizable: true,
      sources: ["launcher"],
      files: [],
    });
    assert.equal(dead.presentation, "orphaned");
    assert.equal(dead.running, false);
    const alive = projectOrchestratorReceipt(receipt, {
      sessionId: receipt.sessionKey,
      projectDir: PROJECT,
      startedAt: NOW,
      lastSeen: NOW,
      isLive: true,
      state: "live",
      processLiveness: "alive",
      interaction: "unknown",
      health: "unknown",
      finalizable: false,
      sources: ["launcher"],
      files: [],
    });
    assert.equal(alive.presentation, "running");
    assert.equal(alive.running, true);
  });
});

describe("FG-576 AC12 — a Codex receipt is rendered honestly", () => {
  test("provider/runtime/adapter are openai/codex-cli/codex and the usage limitation is SHOWN, not omitted", () => {
    const human = forge("show", "orx-codex01");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /provider:\s+openai/);
    assert.match(human.stdout, /runtime:\s+codex-cli/);
    assert.match(human.stdout, /adapter:\s+codex/);
    assert.match(human.stdout, /identity:\s+correlated — newest rollout file in the project window/);
    assert.match(human.stdout, /operation:\s+continue \(target most-recent\)/);
    assert.match(human.stdout, /- usage_capture: codex supplies no equivalent per-session usage evidence/);
    assert.doesNotMatch(human.stdout, /anthropic/);

    const json = showJson("orx-codex01");
    assert.equal(json["selection"].provider, "openai");
    assert.equal(json["selection"].runtime, "codex-cli");
    assert.equal(json["selection"].adapter, "codex");
    assert.equal(json["selection"].limitations.length, 2);
    assert.equal(json["selection"].limitations[0].capability, "usage_capture");
    // Its carrier was never proven accepted, so the surface says so (AC8's shape).
    assert.equal(json["orchestrator"].carrier.acceptance, "unproven");
  });
});

describe("FG-576 — the default forge show path performs no writes", () => {
  test("human, --json and --reconcile against a receipt leave the store and the liveness dir byte-identical", () => {
    writeAliveLauncherRecord(CLAUDE_SESSION);
    const storeBefore = storeSnapshot();
    const hbBefore = hashDir(hbDir);

    for (const args of [
      ["show", "orx-claude01"],
      ["show", "orx-claude01", "--json"],
      ["show", "orx-codex01"],
      // Reconciliation probes a CONTAINER; an interactive orchestrator has none,
      // so even the explicit mutating flag must change nothing here.
      ["show", "orx-claude01", "--reconcile"],
    ]) {
      const res = forge(...args);
      assert.equal(res.status, 0, `forge ${args.join(" ")} failed: ${res.stderr}`);
    }

    assert.equal(storeSnapshot(), storeBefore, "forge show must not mutate the store");
    assert.equal(hashDir(hbDir), hbBefore, "forge show must not rewrite or GC the liveness records");
  });
});
