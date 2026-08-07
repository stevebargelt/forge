// FG-576 step 5 — the SHARED LAUNCH PRIMITIVE's lifecycle, end to end.
//
// Everything here runs against a FAKE `claude` on PATH and disposable
// FORGE_HOME / FORGE_DB_PATH / FORGE_ORCHESTRATORS_DIR / CLAUDE_CONFIG_DIR roots.
// No billed interactive session is ever started, no real auth is read or mutated,
// and the operator's installed Claude settings are never written (AC13). The one
// thing the fixture executable does is record what it was launched with.
//
// The assertions are about the ORDER of durable effects, because that order is the
// contract D11 and D15 name and the thing a phantom orchestrator violates:
//
//   pending exists BEFORE the child          (D15 — a receipt is never a liveness claim)
//   running + liveness ONLY after a spawn     (D15/AC6 — confirmed, not attempted)
//   an unwritable receipt spawns NOTHING      (D11 — never launch unrecorded)
//   every terminal path closes the receipt    (AC7 — no `running` with nothing behind it)
//   a killed launcher reads as orphaned       (D14/D17 — by process identity, not elapsed time)

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../store/db.js";
import {
  getOrchestratorReceipt,
  listOrchestratorReceiptsForProject,
  markOrchestratorReceiptRunning,
  persistPendingOrchestratorReceipt,
  OrchestratorReceiptWriteError,
  type SpawnConfirmation,
} from "../store/orchestrator-receipts.js";
import { loadHeartbeats } from "../util/orchestrator-heartbeats.js";
import { runOrchestratorLaunch } from "./launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");
// FG-569's exec-not-spawn entry, verbatim: ONE node process with tsx loaded
// in-process. It has to be this and not `node_modules/.bin/tsx`, because the tsx
// CLI forks a child — the pid the test holds would then be a wrapper, and the
// `orphaned` assertion below (which SIGKILLs the launcher) would kill the wrapper
// while the real launcher lived on. The bug that shape hides is the exact one D14
// exists to catch, so the harness must not reintroduce it.
const LOADER = join(REPO_ROOT, "bin", "forge-loader.mjs");
const CLI_ARGV = ["--import", LOADER, CLI_ENTRY];
const FAKE_CLAUDE = join(HERE, "__fixtures__", "fake-claude.js");

const POLICY = `
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
  codex-subscription:
    provider: openai
    auth: subscription
    map:
      default: { model: gpt-5.6-terra, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: {}
`;

type Roots = {
  base: string;
  home: string;
  db: string;
  orchestrators: string;
  project: string;
  bin: string;
  record: string;
  ready: string;
  claudeConfig: string;
};

let roots: Roots;
let envSnapshot: Record<string, string | undefined>;

const MANAGED_ENV = [
  "FORGE_HOME",
  "FORGE_DB_PATH",
  "FORGE_ORCHESTRATORS_DIR",
  "CLAUDE_CONFIG_DIR",
  "FAKE_CLAUDE_RECORD",
  "FAKE_CLAUDE_READY",
  "FAKE_CLAUDE_MODE",
  "FAKE_CLAUDE_HELP",
  "PATH",
  "AWS_PROFILE",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_API_KEY",
] as const;

function makeRoots(): Roots {
  // realpath, because the child reports its cwd resolved and a /tmp symlink would
  // turn "did the child start in the project root?" into a path-shape accident.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-launch-")));
  const home = join(base, "forge-home");
  const project = join(base, "project");
  const bin = join(base, "bin");
  const orchestrators = join(base, "orchestrators");
  const claudeConfig = join(base, "claude-config");
  for (const dir of [home, project, bin, orchestrators, claudeConfig]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(home, "model-policy.yml"), POLICY, "utf8");
  writeFileSync(join(project, "CLAUDE.md"), `<!-- forge:orchestrator-start -->\nproject policy\n`, "utf8");

  // The fake goes on PATH under the real name, so `spawn("claude", ...)` resolves
  // to it exactly the way it would resolve the operator's binary.
  const fake = join(bin, "claude");
  copyFileSync(FAKE_CLAUDE, fake);
  chmodSync(fake, 0o755);

  return {
    base,
    home,
    db: join(home, "forge.db"),
    orchestrators,
    project,
    bin,
    record: join(base, "record.json"),
    ready: join(base, "ready"),
    claudeConfig,
  };
}

/** The disposable environment. Deliberately built by OVERRIDING the process env
 *  rather than by curating a minimal one: PATH is prefixed so the fake wins, and the
 *  four Forge roots are redirected, which is what AC13 requires. */
function launchEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    FORGE_HOME: roots.home,
    FORGE_DB_PATH: roots.db,
    FORGE_ORCHESTRATORS_DIR: roots.orchestrators,
    CLAUDE_CONFIG_DIR: roots.claudeConfig,
    FAKE_CLAUDE_RECORD: roots.record,
    PATH: `${roots.bin}:${process.env["PATH"] ?? ""}`,
    ...overrides,
  };
}

function applyEnv(overrides: Record<string, string> = {}): void {
  const env = launchEnv(overrides);
  for (const key of MANAGED_ENV) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The in-process store must re-open at the redirected path, never at the suite's.
  closeDb();
}

function runCli(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [...CLI_ARGV, ...args], {
    cwd: roots.project,
    encoding: "utf8",
    env: launchEnv(overrides),
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readRecord(): { argv: string[]; cwd: string; env: Record<string, string> } {
  assert.ok(existsSync(roots.record), "the fake claude recorded nothing — it was never launched");
  return JSON.parse(readFileSync(roots.record, "utf8"));
}

function countFlag(argv: string[], flag: string): number {
  return argv.filter((token) => token === flag || token.startsWith(`${flag}=`)).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  roots = makeRoots();
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  closeDb();
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  rmSync(roots.base, { recursive: true, force: true });
});

// ─── AC15: --explain inspects the effective choice and spawns NOTHING ────────

test("integ FG-576 AC15: --explain prints all seven recorded fields and launches nothing", () => {
  const res = runCli(["orchestrator", "--explain"]);

  assert.equal(res.status, 0, res.stderr);
  for (const field of ["profile", "runtime", "provider", "model", "auth", "adapter", "resolved_by"]) {
    assert.match(res.stdout, new RegExp(`^${field}\\s`, "m"), `--explain omitted '${field}':\n${res.stdout}`);
  }
  assert.match(res.stdout, /claude-subscription/);
  assert.match(res.stdout, /claude-sonnet-4-6/);
  assert.match(res.stdout, /claude-code/);

  // Nothing was spawned and nothing was recorded: --explain is an inspection
  // surface, so a receipt here would itself be a false record.
  assert.equal(existsSync(roots.record), false, "--explain spawned the provider CLI");
  applyEnv();
  assert.equal(listOrchestratorReceiptsForProject(roots.project).length, 0);
});

// ─── AC2 / AC4 / AC6: what actually reaches the child ───────────────────────

test("integ FG-576 AC2/AC4/AC6: the launch carries the policy model, the asserted session id and the Forge carrier — each exactly once", () => {
  const res = runCli(["orchestrator"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();

  // Every Forge-owned flag appears EXACTLY once. A duplicate would mean the
  // operator's effective model/session/instruction surface is decided by argv
  // ordering rather than by the recorded decision.
  for (const flag of ["-n", "--model", "--session-id", "--append-system-prompt-file"]) {
    assert.equal(countFlag(record.argv, flag), 1, `${flag} appears ${countFlag(record.argv, flag)}× in ${record.argv.join(" ")}`);
  }
  assert.equal(record.argv[record.argv.indexOf("--model") + 1], "claude-sonnet-4-6");
  assert.equal(record.cwd, roots.project, "the child did not start in the resolved project root");
  assert.equal(record.env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], "1");

  applyEnv();
  const receipts = listOrchestratorReceiptsForProject(roots.project);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;

  // The asserted identity is the SAME one on argv, on the receipt and on the
  // liveness record — that shared key is what makes one session count once (D12).
  assert.equal(record.argv[record.argv.indexOf("--session-id") + 1], receipt.sessionKey);
  assert.equal(receipt.identityStrength, "asserted");
  assert.equal(receipt.providerSessionId, receipt.sessionKey);

  // The instruction carrier resolves inside FORGE'S OWN root, never an operator
  // config root, and its provenance is recorded (AC8's shape, applied to Claude).
  const carrierArg = record.argv[record.argv.indexOf("--append-system-prompt-file") + 1]!;
  assert.ok(carrierArg.startsWith(roots.home), `carrier ${carrierArg} escaped the Forge root ${roots.home}`);
  assert.equal(receipt.carrier.path, carrierArg);
  assert.equal(receipt.carrier.acceptance, "accepted");
  assert.match(String(receipt.carrier.evidence), /claude --help advertises --append-system-prompt-file/);

  // Recorded decision, in full (AC6/AC11's inputs).
  assert.equal(receipt.resolvedProfile, "claude-subscription");
  assert.equal(receipt.runtime, "claude-oauth");
  assert.equal(receipt.provider, "anthropic");
  assert.equal(receipt.model, "claude-sonnet-4-6");
  assert.equal(receipt.authMode, "subscription");
  assert.equal(receipt.adapter, "claude-code");
  assert.equal(receipt.sessionOperation, "new");
  assert.match(String(receipt.resolvedBy), /defaults\.profile/);

  // Closed honestly, and the launcher's own artifacts are gone with it.
  assert.equal(receipt.state, "exited");
  assert.equal(receipt.exitCode, 0);
  assert.equal(existsSync(carrierArg), false, "the instruction carrier outlived the session");
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);
});

test("integ FG-576 AC4: --model is recorded verbatim with its own resolved_by and reaches argv once", () => {
  const res = runCli(["orchestrator", "--model", "opus"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "--model"), 1);
  assert.equal(record.argv[record.argv.indexOf("--model") + 1], "opus");

  applyEnv();
  const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(receipt.model, "opus", "an explicit --model must be recorded VERBATIM, not normalized");
  assert.match(String(receipt.resolvedBy), /model: cli\.--model/);
});

// ─── D15 / AC6 / AC7: the lifecycle order, and an honest close on SIGKILL ────

test("integ FG-576 D15/AC6/AC7: the receipt is pending before spawn, running only after, and closes honestly on SIGKILL", async () => {
  applyEnv({ FAKE_CLAUDE_MODE: "hold", FAKE_CLAUDE_READY: roots.ready });

  let child: ChildProcess | undefined;
  const spawnFn: typeof spawn = ((cmd: string, args: string[], opts: object) => {
    child = spawn(cmd, args, opts as never);
    return child;
  }) as unknown as typeof spawn;

  let observedBeforeSpawn: { state: string; heartbeats: number } | undefined;

  const launch = runOrchestratorLaunch({
    commandName: "forge orchestrator",
    cwd: roots.project,
    heartbeatsDir: roots.orchestrators,
    spawnFn,
    stdio: "ignore",
    out: () => {},
    err: () => {},
    onBeforeSpawn: ({ receiptId }) => {
      observedBeforeSpawn = {
        state: String(getOrchestratorReceipt(receiptId)?.state),
        heartbeats: loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length,
      };
    },
  });

  await waitFor(() => existsSync(roots.ready));
  await waitFor(() => loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length === 1);

  // D15: the receipt existed and was NOT live before the child did.
  assert.deepEqual(observedBeforeSpawn, { state: "pending", heartbeats: 0 });

  const live = loadHeartbeats({ heartbeatsDir: roots.orchestrators })[0]!;
  const running = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(running.state, "running");
  assert.equal(running.claimsRunning, true);
  assert.equal(live.sessionId, running.sessionKey, "the liveness record and the receipt share one canonical identity");
  assert.equal(live.provider, "anthropic");
  assert.equal(live.runtime, "claude-oauth");
  assert.equal(live.adapter, "claude-code");
  // AC7: Claude's Stop hook has not fired, so there is NO interaction evidence —
  // and its absence renders as `unknown`, never as healthy.
  assert.equal(live.interaction, "unknown");
  assert.equal(live.health, "unknown");
  assert.equal(live.processLiveness, "alive");

  child!.kill("SIGKILL");
  const outcome = await launch;

  assert.equal(outcome.spawned, true);
  assert.equal(outcome.exitCode, 128);
  const closed = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(closed.state, "exited");
  assert.equal(closed.exitSignal, "SIGKILL");
  assert.equal(closed.terminal, true);
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);
});

// ─── AC7 / D14 / D17: a launcher killed mid-session reads as orphaned ────────

test("integ FG-576 AC7/D17: a launcher killed mid-session leaves a record that classifies as orphaned, not running", async () => {
  const cli = spawn(process.execPath, [...CLI_ARGV, "orchestrator"], {
    cwd: roots.project,
    env: launchEnv({ FAKE_CLAUDE_MODE: "hold", FAKE_CLAUDE_READY: roots.ready }),
    stdio: "ignore",
  });

  try {
    await waitFor(() => loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length === 1, 60_000);
    assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators })[0]!.state, "live");

    // The launcher dies with no chance to close anything — the crash case.
    cli.kill("SIGKILL");
    await new Promise<void>((r) => cli.on("exit", () => r()));

    const after = loadHeartbeats({ heartbeatsDir: roots.orchestrators })[0]!;
    // Classified by PROCESS IDENTITY, not by elapsed heartbeat time: the record is
    // seconds old, and it is still correctly dead.
    assert.equal(after.state, "orphaned");
    assert.equal(after.isLive, false);
    assert.equal(after.processLiveness, "dead");
    assert.equal(after.health, "unknown", "absence of a provider hook must never read as healthy (AC7)");

    // The receipt still CLAIMS a confirmed spawn — which is true of the moment it
    // was written. It is the liveness join, not this column, that says `running`.
    applyEnv();
    const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
    assert.equal(receipt.claimsRunning, true);
    assert.equal(receipt.launcherPid, cli.pid);
  } finally {
    try {
      cli.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

// ─── Terminal honesty: a child that never started ───────────────────────────

test("integ FG-576 AC7: a spawn failure closes the receipt as spawn_failed and exits non-zero", () => {
  // An EMPTY bin dir as the whole PATH: `claude` cannot be resolved (not the fake,
  // and not the container's real one either), while the launcher itself still runs
  // because it is invoked through process.execPath rather than through PATH. The
  // readiness probe establishes nothing (which is recorded), and the SPAWN is what
  // fails — an absent binary is an environment failure, not a policy refusal.
  const emptyBin = join(roots.base, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  const res = runCli(["orchestrator"], { PATH: emptyBin });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /failed to spawn claude/);
  applyEnv();
  const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(receipt.state, "spawn_failed");
  assert.equal(receipt.claimsRunning, false);
  assert.match(String(receipt.failureReason), /ENOENT|spawn/i);
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);
});

// ─── D11: an unwritable receipt refuses BEFORE spawn ────────────────────────

test("integ FG-576 D11: a receipt that cannot be written refuses before spawn, names the target and a retry, and creates no child", () => {
  // A regular FILE where the store's directory should be: SQLite cannot open a
  // database under it, so the pre-spawn write fails for a real, reportable reason.
  const blocker = join(roots.base, "blocked");
  writeFileSync(blocker, "not a directory", "utf8");

  const res = runCli(["orchestrator"], { FORGE_DB_PATH: join(blocker, "forge.db") });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, new RegExp(join(blocker, "forge.db").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(res.stderr, /retry/i);
  assert.match(res.stderr, /nothing was spawned/i);
  assert.equal(existsSync(roots.record), false, "a child was created despite an unrecordable launch");
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);
});

// ─── D11's MIRROR: a go-live write that fails AFTER a confirmed spawn ───────
//
// Pre-spawn, an unwritable receipt refuses the launch. Post-spawn refusing is gone —
// the child is up — so the failure mode is the opposite one: a live session whose
// receipt is stuck `pending`. D15 allows `exited` only from `running`, so without the
// held retry below the close is refused too and the session that really ran is
// recorded forever as one that never started.

test("integ FG-576 D11/D15: a go-live write that fails after spawn is held and retried, so the session still closes honestly", async () => {
  applyEnv();

  const attempts: (SpawnConfirmation | undefined)[] = [];
  const errors: string[] = [];
  const outcome = await runOrchestratorLaunch({
    commandName: "forge orchestrator",
    cwd: roots.project,
    heartbeatsDir: roots.orchestrators,
    stdio: "ignore",
    out: () => {},
    err: (line) => errors.push(line),
    markRunningFn: (receiptId, confirmation) => {
      attempts.push(confirmation);
      if (attempts.length === 1) {
        throw new OrchestratorReceiptWriteError("forge: simulated store failure", receiptId, "<test store>", null);
      }
      return markOrchestratorReceiptRunning(receiptId, confirmation);
    },
  });

  assert.equal(outcome.spawned, true);
  assert.equal(outcome.exitCode, 0);
  assert.equal(attempts.length, 2, "the held go-live write was never retried");

  const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(receipt.state, "exited");
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.terminal, true);
  // The retry records when the spawn was ACTUALLY confirmed, not when it was retried.
  assert.equal(receipt.startedAt, attempts[0]?.startedAt);
  // The gap was reported while it was open, rather than discovered afterwards.
  assert.match(errors.join("\n"), /still records 'pending'/);
});

test("integ FG-576 D11/D15: a go-live write that never succeeds is named, and no state is invented for it", async () => {
  applyEnv();

  const errors: string[] = [];
  const outcome = await runOrchestratorLaunch({
    commandName: "forge orchestrator",
    cwd: roots.project,
    heartbeatsDir: roots.orchestrators,
    stdio: "ignore",
    out: () => {},
    err: (line) => errors.push(line),
    markRunningFn: (receiptId) => {
      throw new OrchestratorReceiptWriteError("forge: simulated store failure", receiptId, "<test store>", null);
    },
  });

  assert.equal(outcome.spawned, true);
  const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
  // Still `pending`: `spawn_failed` is the only other edge out of it, and the spawn
  // did not fail. Forge says what happened instead of recording a lie.
  assert.equal(receipt.recordedState, "pending");
  const reported = errors.join("\n");
  assert.match(reported, new RegExp(receipt.receiptId));
  assert.match(reported, /ran and has now exited/);
  assert.equal(loadHeartbeats({ heartbeatsDir: roots.orchestrators }).length, 0);
});

// ─── D6: passthrough is not a second way to change the launch ───────────────

for (const [name, tokens] of [
  ["--model", ["--model", "opus"]],
  ["--model= form", ["--model=opus"]],
  ["--resume", ["--resume", "abc"]],
  ["--session-id", ["--session-id", "11111111-1111-4111-8111-111111111111"]],
  ["--append-system-prompt-file", ["--append-system-prompt-file", "/tmp/evil.md"]],
  ["--print", ["--print"]],
] as const) {
  test(`integ FG-576 D6: passthrough cannot set ${name}`, () => {
    const res = runCli(["orchestrator", "--", ...tokens]);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /D6/);
    assert.match(res.stderr, /cannot be passed through/);
    assert.equal(existsSync(roots.record), false, "the refused passthrough still reached a child");
    applyEnv();
    assert.equal(
      listOrchestratorReceiptsForProject(roots.project).length,
      0,
      "a launch refused at the gate must not be recorded at all",
    );
  });
}

test("integ FG-576 D6: a provider-native flag Forge does not own still reaches the child, exactly once", () => {
  const res = runCli(["orchestrator", "--", "--add-dir", "/tmp"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "--add-dir"), 1);
  assert.deepEqual(record.argv.slice(-2), ["--add-dir", "/tmp"]);
});

// ─── Session operations ─────────────────────────────────────────────────────

test("integ FG-576: --continue and --resume together are refused before spawn", () => {
  const res = runCli(["orchestrator", "--continue", "--resume", "abc"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--continue and --resume/);
  assert.equal(existsSync(roots.record), false);
});

test("integ FG-576 AC10: --continue records no asserted identity rather than guessing one", () => {
  const res = runCli(["orchestrator", "--continue"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "--continue"), 1);
  assert.equal(countFlag(record.argv, "--session-id"), 0, "Claude chooses the conversation for --continue; Forge must not assert an id");

  applyEnv();
  const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(receipt.sessionOperation, "continue");
  assert.equal(receipt.identityStrength, "unknown");
  assert.equal(receipt.providerSessionId, null);
  assert.ok(
    receipt.limitations.some((l) => l.capability === "session-operations"),
    "the --continue identity gap must be a RECORDED limitation, not an omission",
  );
});

test("integ FG-576 AC10: resume adopts the identifier as the canonical session key", () => {
  const target = "22222222-2222-4222-8222-222222222222";
  const res = runCli(["orchestrator", "--resume", target]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  assert.equal(countFlag(record.argv, "--resume"), 1);
  assert.equal(record.argv[record.argv.indexOf("--resume") + 1], target);

  applyEnv();
  const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(receipt.sessionOperation, "resume");
  assert.equal(receipt.sessionTarget, target);
  assert.equal(receipt.sessionKey, target);
  assert.match(String(receipt.identityBasis), /no Forge receipt recorded it/);
});

test("integ FG-576 AC10: a Codex-minted identifier is refused by RECEIPT lookup, not by identifier format", async () => {
  applyEnv();

  // Both providers use bare UUIDs, so this identifier is indistinguishable from a
  // Claude one by shape. Only the durable receipt that minted it can say otherwise.
  const codexId = "33333333-3333-4333-8333-333333333333";
  persistPendingOrchestratorReceipt({
    sessionKey: codexId,
    projectDir: roots.project,
    runtime: "codex-subscription",
    provider: "openai",
    adapter: "codex",
    sessionOperation: "new",
    providerSessionId: codexId,
  });

  const errors: string[] = [];
  const outcome = await runOrchestratorLaunch({
    commandName: "forge orchestrator",
    cwd: roots.project,
    heartbeatsDir: roots.orchestrators,
    resumeSessionId: codexId,
    stdio: "ignore",
    out: () => {},
    err: (line) => errors.push(line),
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.spawned, false);
  const message = errors.join("\n");
  assert.match(message, /cannot be resumed in Claude Code/);
  assert.match(message, /codex/);
  assert.match(message, /not guessed from\s+its format/);
  assert.equal(existsSync(roots.record), false);
});

test("integ FG-576: an unsafe resume identifier is refused rather than sanitized", async () => {
  applyEnv();
  const errors: string[] = [];
  const outcome = await runOrchestratorLaunch({
    commandName: "forge orchestrator",
    cwd: roots.project,
    heartbeatsDir: roots.orchestrators,
    resumeSessionId: "../../etc/passwd",
    stdio: "ignore",
    out: () => {},
    err: (line) => errors.push(line),
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(errors.join("\n"), /not a usable session identifier/);
  assert.equal(existsSync(roots.record), false);
});

// ─── AC5: the pre-spawn refusal is structural ───────────────────────────────

test("integ FG-576 AC5: an unsupported runtime fails before spawn, naming the profile, the runtime and a remedy", () => {
  writeFileSync(
    join(roots.home, "model-policy.yml"),
    `
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
  pi-groq:
    provider: groq
    runtime: pi-apikey
    auth: api
    map:
      default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard, tool_capable: true }
defaults:
  profile: claude-subscription
  activity: {}
overrides:
  agents:
    orchestrator: pi-groq
`,
    "utf8",
  );

  const res = runCli(["orchestrator"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /pi-groq/);
  assert.match(res.stderr, /pi-apikey/);
  assert.match(res.stderr, /Fix:/);
  assert.equal(existsSync(roots.record), false, "an unsupported runtime reached a spawn");
  applyEnv();
  assert.equal(listOrchestratorReceiptsForProject(roots.project).length, 0);
});

// ─── AC14 at this boundary: `forge claude` runs through THIS primitive ──────

test("integ FG-576 AC14: `forge claude` launches through the shared primitive and records the same lifecycle", () => {
  const res = runCli(["claude", "--print-nothing-just-exit"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  // Step 6 rewired the shortcut onto this file's primitive (it was an unresolved
  // passthrough before). It still sets the display name and still forwards the
  // provider-native tail — but now the policy model, the asserted session id and
  // the Forge-owned carrier come from here, so the two commands cannot drift.
  assert.deepEqual(record.argv.slice(0, 2), ["-n", "project"]);
  assert.deepEqual(record.argv.slice(-1), ["--print-nothing-just-exit"]);
  for (const flag of ["--model", "--session-id", "--append-system-prompt-file"]) {
    assert.equal(countFlag(record.argv, flag), 1, `${flag} in ${record.argv.join(" ")}`);
  }

  applyEnv();
  const receipts = listOrchestratorReceiptsForProject(roots.project);
  assert.equal(receipts.length, 1, "`forge claude` must record exactly one orchestrator receipt");
  assert.equal(receipts[0]!.adapter, "claude-code");
  assert.equal(receipts[0]!.state, "exited");
});
