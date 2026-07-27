// FG-566 fixer round: the falsification suite for the readiness contract's own
// preconditions — the four that are SECURITY or CORRECTNESS boundaries rather
// than loop behaviour (which fg566-review-loop-readiness.test.ts already pins).
//
// Every test here fails against the pre-fix module:
//   TRUST BOUNDARY  — the setup command was read from `<configDir>/.forge/config.json`
//                     and both consumers passed a project directory as configDir, so
//                     the tree under review chose a binary forge ran on the host.
//   ABI TAUTOLOGY   — requireAbi came from process.versions.modules and abi came from
//                     probing process.execPath, so checkAbi compared a value to itself
//                     and returned ok on every real invocation.
//   SELF-HOST       — nothing stopped `npm ci` (which DELETES node_modules) from
//                     running in the forge checkout this process loads better-sqlite3
//                     from.
//   SETUP ENV       — the whole of process.env was handed to a child running lifecycle
//                     scripts out of merged agent content.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { hostConfigPath } from "../util/paths.js";
import {
  pinnedVerificationEnv,
  prepareHostVerification,
  resolveSetupCommand,
  resolveVerificationInterpreter,
  type HostReadinessDeps,
  type HostReadinessOutcome,
  type SetupRun,
} from "./host-readiness.js";
import { hostReadinessSetupTimeoutMs } from "./host-readiness-store.js";
import { gateSpanLeaseMs, readinessSpanLeaseMs } from "./publication-lane.js";

let prevDb: DatabaseInstance | null;
const dirs: string[] = [];
const envKeys = [
  "FORGE_HOST_VERIFICATION_SETUP", "FORGE_HOST_READINESS_REQUIRE_ABI",
  "FORGE_WORKTREES", "FORGE_NO_WORKTREES", "ANTHROPIC_API_KEY",
  "FORGE_HOST_READINESS_SETUP_TIMEOUT_MS", "FORGE_INTEGRATION_GATE_TIMEOUT_MS",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  rmSync(hostConfigPath(), { force: true });
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(hostConfigPath(), { force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NODE_MAJOR = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

/** A workspace shaped like the thing readiness actually prepares: declares
 *  dependencies, carries a lockfile, has no node_modules. */
function workspace(opts: { nvmrc?: string; engines?: string; hostileConfig?: string; lockfile?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg566-ws-")));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fg566-fixture", version: "1.0.0", private: true,
    dependencies: { "some-dep": "1.0.0" },
    ...(opts.engines ? { engines: { node: opts.engines } } : {}),
  }));
  if (opts.lockfile !== false) writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fg566-fixture", lockfileVersion: 3 }));
  if (opts.nvmrc) writeFileSync(join(dir, ".nvmrc"), `${opts.nvmrc}\n`);
  if (opts.hostileConfig) {
    // The reviewed tree's OWN operator config — the file the pre-fix code read.
    mkdirSync(join(dir, ".forge"), { recursive: true });
    writeFileSync(join(dir, ".forge", "config.json"), JSON.stringify({ hostVerificationSetup: opts.hostileConfig }));
  }
  return dir;
}

type SetupCall = { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };

/** Records what would have been executed and reports success WITHOUT running it —
 *  so "did readiness reach the install?" is directly observable. */
function recordingDeps(calls: SetupCall[], extra: HostReadinessDeps = {}): HostReadinessDeps {
  return {
    runSetup: (cmd, args, opts): SetupRun => {
      calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
      return { ok: true, status: 0, timedOut: false, stderrTail: "" };
    },
    porcelain: () => "",
    ...extra,
  };
}

function prepare(ws: string, deps: HostReadinessDeps): Promise<HostReadinessOutcome> {
  return prepareHostVerification(
    { workspace: ws, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "test" },
    // Every test that is not ABOUT the self-host guard must be outside the forge
    // source root, or the guard (correctly) refuses first.
    { sourceRoot: join(tmpdir(), "fg566-not-the-forge-root"), ...deps },
  );
}

function refusalOf(outcome: HostReadinessOutcome): { reason: string; message: string } {
  assert.equal(outcome.kind, "refused", `expected a refusal, got ${outcome.kind}`);
  const refusal = (outcome as { refusal: { reason: string; message: string } }).refusal;
  return refusal;
}

// ── FIX 1: the tree under review may never select the host-executed command ──

test("FG-566 TRUST BOUNDARY — a hostile `.forge/config.json` INSIDE the workspace under test can never select the setup command", async () => {
  const calls: SetupCall[] = [];
  const ws = workspace({ hostileConfig: "/tmp/pwned-binary --exfiltrate" });
  const outcome = await prepare(ws, recordingDeps(calls));

  assert.equal(outcome.kind, "ready");
  assert.equal(calls.length, 1);
  // The lockfile-derived FIXED argv, not the workspace's choice.
  assert.equal(calls[0]?.cmd, "npm");
  assert.deepEqual(calls[0]?.args, ["ci"]);
});

test("FG-566 TRUST BOUNDARY — resolveSetupCommand takes NO directory the caller could bind to the workspace", async () => {
  // A structural assertion, not a behavioural one: the pre-fix signature was
  // (configDir, workspace) and BOTH consumers passed a project dir for configDir.
  assert.equal(resolveSetupCommand.length, 1);
});

test("FG-566 TRUST BOUNDARY — the HOST-LEVEL operator config IS honoured (that is where the contract lives now)", async () => {
  writeFileSync(hostConfigPath(), JSON.stringify({ hostVerificationSetup: "operator-setup --declared" }));
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace({ hostileConfig: "/tmp/pwned-binary" }), recordingDeps(calls));

  assert.equal(outcome.kind, "ready");
  assert.equal(calls[0]?.cmd, "operator-setup");
  assert.deepEqual(calls[0]?.args, ["--declared"]);
});

test("FG-566 TRUST BOUNDARY — no host contract and no lockfile refuses no_setup_contract and runs NOTHING", async () => {
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace({ lockfile: false, hostileConfig: "/tmp/pwned-binary" }), recordingDeps(calls));

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "no_setup_contract");
  assert.equal(calls.length, 0);
  // The refusal points the operator at the HOST config, never at a project path.
  assert.match(refusal.message, new RegExp(hostConfigPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ── FIX 2: the ABI comparison must have two independent sides ────────────────

test("FG-566 ABI TAUTOLOGY — a workspace pinning a DIFFERENT Node major than the runtime refuses runtime_abi_mismatch and installs NOTHING", async () => {
  // The required side comes from the WORKSPACE (.nvmrc); the actual side is a real
  // probe of the real interpreter on the pinned PATH. No probe is injected — if the
  // two sides were still wired to the same source this could not fail.
  const calls: SetupCall[] = [];
  const older = await prepare(workspace({ nvmrc: String(NODE_MAJOR - 1) }), recordingDeps(calls));
  const newer = await prepare(workspace({ nvmrc: String(NODE_MAJOR + 1) }), recordingDeps(calls));

  assert.equal(refusalOf(older).reason, "runtime_abi_mismatch");
  assert.equal(refusalOf(newer).reason, "runtime_abi_mismatch");
  assert.equal(calls.length, 0, "a refused runtime must never reach the install");
  assert.match(refusalOf(older).message, /\.nvmrc/);
});

test("FG-566 ABI TAUTOLOGY — package.json engines.node is the same independent source when there is no .nvmrc", async () => {
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace({ engines: `^${NODE_MAJOR - 1}` }), recordingDeps(calls));

  assert.equal(refusalOf(outcome).reason, "runtime_abi_mismatch");
  assert.equal(calls.length, 0);
});

test("FG-566 ABI — a workspace pinning the runtime's OWN major proceeds, and the evidence names both sides", async () => {
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace({ nvmrc: String(NODE_MAJOR) }), recordingDeps(calls));

  assert.equal(outcome.kind, "ready");
  assert.equal(calls.length, 1);
  const evidence = (outcome as { evidence: { requiredAbi: string; abi: string; interpreter: string } }).evidence;
  assert.match(evidence.requiredAbi, /\.nvmrc/);
  assert.equal(evidence.abi, process.versions.modules);
  // The interpreter is the one resolved off the PINNED PATH, not an assumption.
  assert.equal(evidence.interpreter, resolveVerificationInterpreter(pinnedVerificationEnv("t").PATH ?? ""));
});

test("FG-566 ABI — the operator's explicit ABI requirement is checked too, and a mismatch refuses", async () => {
  process.env["FORGE_HOST_READINESS_REQUIRE_ABI"] = String(Number(process.versions.modules) + 1);
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace(), recordingDeps(calls));

  assert.equal(refusalOf(outcome).reason, "runtime_abi_mismatch");
  assert.equal(calls.length, 0);
});

test("FG-566 ABI — an unprobeable interpreter refuses runtime_unresolved rather than passing silently", async () => {
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace(), recordingDeps(calls, { probeAbi: () => undefined }));

  assert.equal(refusalOf(outcome).reason, "runtime_unresolved");
  assert.equal(calls.length, 0);
});

test("FG-566 ABI — the covered verification runs under the SAME pinned PATH readiness certified", () => {
  const pinned = pinnedVerificationEnv("test").PATH ?? "";
  assert.equal(pinned.split(":")[0], dirname(process.execPath));
});

test("FG-566 ABI RANGE — a RANGE the host satisfies must not refuse, and an EXACT declaration it does not still must", async () => {
  // The regression: `firstMajor` took the FIRST digit run out of the declaration,
  // so ">=18" became an exact pin of 18 and was handed to checkAbi — equality by
  // design — which no interpreter above 18 can ever satisfy. Every workspace
  // declaring a range was permanently refused runtime_abi_mismatch.
  for (const range of [`>=${NODE_MAJOR - 6}`, `^${NODE_MAJOR - 2} || ^${NODE_MAJOR}`, `>=${NODE_MAJOR - 6} <${NODE_MAJOR + 1}`]) {
    const calls: SetupCall[] = [];
    const outcome = await prepare(workspace({ engines: range }), recordingDeps(calls));
    assert.equal(outcome.kind, "ready", `engines.node ${range} on Node ${NODE_MAJOR} must not refuse`);
    assert.equal(calls.length, 1, `engines.node ${range} must reach the install`);
  }
  // …and the same for a .nvmrc, which is consulted first.
  const nvmrcCalls: SetupCall[] = [];
  assert.equal((await prepare(workspace({ nvmrc: `>=${NODE_MAJOR - 6}` }), recordingDeps(nvmrcCalls))).kind, "ready");

  // NOT the tautology coming back: the check still has two independent sides, so an
  // EXACT declaration the host does not satisfy refuses, and a range that genuinely
  // excludes the host refuses too.
  const exactCalls: SetupCall[] = [];
  const exact = await prepare(workspace({ nvmrc: String(NODE_MAJOR - 1) }), recordingDeps(exactCalls));
  assert.equal(refusalOf(exact).reason, "runtime_abi_mismatch");
  const excludingCalls: SetupCall[] = [];
  const excluding = await prepare(workspace({ engines: `>=${NODE_MAJOR + 1}` }), recordingDeps(excludingCalls));
  assert.equal(refusalOf(excluding).reason, "runtime_abi_mismatch");
  assert.equal(exactCalls.length + excludingCalls.length, 0, "a refused runtime must never reach the install");
});

test("FG-566 ABI RANGE — an unreadable declaration establishes NO requirement rather than refusing", async () => {
  for (const declaration of ["lts/*", "*", "not-a-version", ">=18.17 || garbage"]) {
    const calls: SetupCall[] = [];
    const outcome = await prepare(workspace({ nvmrc: declaration, engines: declaration }), recordingDeps(calls));
    assert.equal(outcome.kind, "ready", `\`${declaration}\` must fall through to no requirement, not refuse`);
    assert.equal((outcome as { evidence: { requiredAbi: string } }).evidence.requiredAbi, "(none)");
    assert.equal(calls.length, 1);
  }
});

// ── FIX 3: never install into the forge checkout this process is running from ─

test("FG-566 SELF-HOST — a workspace overlapping the forge source root refuses self_host_workspace and executes NO install", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg566-forge-root-")));
  dirs.push(root);
  const ws = join(root, "checkout");
  mkdirSync(ws);
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { d: "1" } }));
  writeFileSync(join(ws, "package-lock.json"), "{}");

  const calls: SetupCall[] = [];
  const outcome = await prepareHostVerification(
    { workspace: ws, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "review-loop" },
    { ...recordingDeps(calls), sourceRoot: root },
  );

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "self_host_workspace");
  assert.equal(calls.length, 0, "an install in the forge source root deletes the bindings this process is running on");
});

test("FG-566 SELF-HOST — the guard is reached FIRST: a self-host tree that already has node_modules is REFUSED, not waved through as not_required", async () => {
  // The ordering defect. The `hasModules && !record` arm returned not_required
  // BEFORE the self-host comparison, so for the operator's live forge checkout —
  // which always has node_modules and no readiness record — the refusal below was
  // simply unreachable. The destructive outcome was avoided only incidentally, and
  // a STALE self-host tree was certified as needing nothing instead of refused.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg566-forge-root-")));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { d: "1" } }));
  writeFileSync(join(root, "package-lock.json"), "{}");
  mkdirSync(join(root, "node_modules", "d"), { recursive: true });
  writeFileSync(join(root, "node_modules", "d", "package.json"), "{}");

  const calls: SetupCall[] = [];
  const outcome = await prepareHostVerification(
    { workspace: root, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "review-loop" },
    { ...recordingDeps(calls), sourceRoot: root },
  );

  assert.equal(refusalOf(outcome).reason, "self_host_workspace");
  assert.equal(calls.length, 0);
});

test("FG-566 SELF-HOST — the guard precedes EVERY not_required arm, including an empty command set and a workspace with no package.json", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg566-forge-root-")));
  dirs.push(root);

  const requests = [
    { why: "no package.json at all", coveredCommandSet: ["npm run test:unit"] },
    { why: "no verification commands to cover", coveredCommandSet: [] },
  ];
  for (const { why, coveredCommandSet } of requests) {
    const calls: SetupCall[] = [];
    const outcome = await prepareHostVerification(
      { workspace: root, treeSha: "deadbeef", coveredCommandSet, label: "review-loop" },
      { ...recordingDeps(calls), sourceRoot: root },
    );
    assert.equal(refusalOf(outcome).reason, "self_host_workspace", why);
  }
});

test("FG-566 SELF-HOST — the refusal is independent of worktree mode and of the FORGE_NO_WORKTREES override", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg566-forge-root-")));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { d: "1" } }));
  writeFileSync(join(root, "package-lock.json"), "{}");

  for (const env of [{ FORGE_WORKTREES: "1" }, { FORGE_NO_WORKTREES: "1" }, {}]) {
    delete process.env["FORGE_WORKTREES"];
    delete process.env["FORGE_NO_WORKTREES"];
    Object.assign(process.env, env);
    const calls: SetupCall[] = [];
    const outcome = await prepareHostVerification(
      { workspace: root, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "review-loop" },
      { ...recordingDeps(calls), sourceRoot: root },
    );
    assert.equal(refusalOf(outcome).reason, "self_host_workspace", `env ${JSON.stringify(env)}`);
    assert.equal(calls.length, 0);
  }
});

// ── FIX 4: the setup child gets a minimal env and no lifecycle scripts ───────

test("FG-566 SETUP ENV — the setup child never receives forge's process environment", async () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-should-never-reach-a-lifecycle-script";
  const calls: SetupCall[] = [];
  await prepare(workspace(), recordingDeps(calls));

  const env = calls[0]?.env ?? {};
  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(env["FORGE_HOME"], undefined);
  // …but it does get what a package manager genuinely needs.
  assert.equal(env["HOME"], process.env["HOME"]);
  assert.equal((env["PATH"] ?? "").split(":")[0], dirname(process.execPath));
});

test("FG-566 SETUP ENV — package lifecycle scripts are suppressed on the setup child", async () => {
  const calls: SetupCall[] = [];
  await prepare(workspace(), recordingDeps(calls));
  assert.equal(calls[0]?.env["npm_config_ignore_scripts"], "true");
});

// ── FIX 5: readiness is its own declared span with its own composed lease ────

test("FG-566 LEASE — the readiness span lease is COMPOSED from the setup ceiling and the gate span, never a literal", () => {
  assert.equal(readinessSpanLeaseMs(), hostReadinessSetupTimeoutMs() + gateSpanLeaseMs());
  assert.ok(readinessSpanLeaseMs() > gateSpanLeaseMs());

  process.env["FORGE_HOST_READINESS_SETUP_TIMEOUT_MS"] = "1230000";
  process.env["FORGE_INTEGRATION_GATE_TIMEOUT_MS"] = "450000";
  // Raising either ceiling moves the lease with it — that is what "cannot silently
  // desync" means.
  assert.equal(readinessSpanLeaseMs(), 1230000 + 450000 + 60_000);
});
