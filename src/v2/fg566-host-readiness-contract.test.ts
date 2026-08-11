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
  // FG-345: clearing the inherited pin hands the suite to the host's platform
  // default. Keep this unit-tier fixture in the shared non-worktree lane.
  process.env.FORGE_WORKTREES = "0";
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

/** A stand-in forge source root for every test that is not ABOUT the self-host
 *  guard. FG-693: it must be a REAL directory. The guard's comparison is
 *  three-valued now, and a source root that does not exist on disk has no
 *  identity to compare — so it refuses as UNPROVEN rather than comparing as
 *  separate. The old literal path was never created, which made every case below
 *  depend on a lexical compare of two spellings. */
function notTheForgeRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg566-not-the-forge-root-")));
  dirs.push(dir);
  return dir;
}

function prepare(ws: string, deps: HostReadinessDeps): Promise<HostReadinessOutcome> {
  return prepareHostVerification(
    { workspace: ws, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "test" },
    // Every test that is not ABOUT the self-host guard must be outside the forge
    // source root, or the guard (correctly) refuses first.
    { sourceRoot: notTheForgeRoot(), ...deps },
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

// ── FIX 4: the setup child gets a minimal env — and lifecycle scripts RUN ────

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

test("FG-566 LIFECYCLE SCRIPTS — normal npm lifecycle scripts RUN during setup: nothing suppresses them", async () => {
  // The suppression was removed by operator decision, and reinstating it is a
  // regression this test exists to catch. It never was a boundary — forge runs the
  // candidate-controlled `npm run test:unit` on the host moments later — and its
  // only observable effect was that a native dependency's `build/` directory was
  // never produced, so `npm ci` exited zero over a workspace whose bindings could
  // not load and readiness certified it ready.
  const calls: SetupCall[] = [];
  await prepare(workspace(), recordingDeps(calls));

  const env = calls[0]?.env ?? {};
  assert.equal(env["npm_config_ignore_scripts"], undefined, "install lifecycle scripts must not be suppressed");
  assert.equal(env["NPM_CONFIG_IGNORE_SCRIPTS"], undefined);
});

// ── FIX 6 (AC 13-18): the setup contract is STRUCTURED ARGV, never a shell ───

test("FG-566 SETUP GRAMMAR — the default contract is exactly [[\"npm\",\"ci\"]]", async () => {
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace(), recordingDeps(calls));

  assert.equal(outcome.kind, "ready");
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [["npm", "ci"]]);
  assert.deepEqual(resolveSetupCommand(workspace()), {
    kind: "steps",
    steps: [["npm", "ci"]],
    source: "the workspace's package-lock.json",
  });
});

test("FG-566 SETUP GRAMMAR — a SEQUENCE of argv arrays runs each step IN ORDER, each a direct exec", async () => {
  writeFileSync(hostConfigPath(), JSON.stringify({
    hostVerificationSetup: [["npm", "ci"], ["npm", "run", "build:native"]],
  }));
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace(), recordingDeps(calls));

  assert.equal(outcome.kind, "ready");
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [["npm", "ci"], ["npm", "run", "build:native"]]);
  // The evidence names the whole contract, in a rendering that is not shell syntax.
  assert.equal((outcome as { evidence: { setupCommand: string } }).evidence.setupCommand, "npm ci then npm run build:native");
});

test("FG-566 SETUP GRAMMAR — a single argv array preserves an argument containing SPACES, which a split could not", async () => {
  writeFileSync(hostConfigPath(), JSON.stringify({
    hostVerificationSetup: ["npm", "ci", "--cache", "/tmp/a directory with spaces"],
  }));
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace(), recordingDeps(calls));

  assert.equal(outcome.kind, "ready");
  assert.deepEqual(calls[0]?.args, ["ci", "--cache", "/tmp/a directory with spaces"]);
});

test("FG-566 SETUP GRAMMAR — the env override accepts the same structure, as JSON", async () => {
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([["pnpm", "install", "--frozen-lockfile"], ["pnpm", "rebuild"]]);
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace(), recordingDeps(calls));

  assert.equal(outcome.kind, "ready");
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [["pnpm", "install", "--frozen-lockfile"], ["pnpm", "rebuild"]]);
});

test("FG-566 SETUP GRAMMAR — a COMPOUND command is REFUSED, never split on whitespace and mis-executed", async () => {
  // Every one of these mis-executes under a whitespace split: `npm ci && npm run
  // build` becomes `npm` with the literal arguments `ci`, `&&`, `npm`, `run`,
  // `build`, and the failure reads like a broken project rather than a broken
  // contract.
  const compound = [
    "npm ci && npm run build:native",
    "npm ci; npm rebuild",
    "npm ci || true",
    "npm ci | tee install.log",
    "npm ci > install.log",
    "npm ci --cache $(mktemp -d)",
    "npm ci --cache `mktemp -d`",
    `npm ci --cache "/tmp/a directory with spaces"`,
  ];
  for (const raw of compound) {
    process.env["FORGE_HOST_VERIFICATION_SETUP"] = raw;
    const calls: SetupCall[] = [];
    const refusal = refusalOf(await prepare(workspace(), recordingDeps(calls)));
    assert.equal(refusal.reason, "ambiguous_setup_contract", `\`${raw}\` must be refused, not split`);
    assert.equal(calls.length, 0, `\`${raw}\` must execute NOTHING`);
    // The refusal is actionable: it names the source and shows the argv shape.
    assert.match(refusal.message, /FORGE_HOST_VERIFICATION_SETUP/);
    assert.match(refusal.message, /\["npm","ci"\]/);
  }
});

test("FG-566 SETUP GRAMMAR — no shell is ever invoked: the executable is the operator's own, never sh -c", async () => {
  for (const configured of [["npm", "ci"], [["npm", "ci"], ["npm", "rebuild"]]]) {
    writeFileSync(hostConfigPath(), JSON.stringify({ hostVerificationSetup: configured }));
    const calls: SetupCall[] = [];
    await prepare(workspace(), recordingDeps(calls));
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(!/(^|\/)(sh|bash|zsh|dash)$/.test(call.cmd), `a shell must never be the setup executable — got ${call.cmd}`);
      assert.ok(!call.args.includes("-c"), "no `-c` payload: the argv is executed directly");
    }
  }
});

test("FG-566 SETUP GRAMMAR — a malformed structure is refused, not coerced", async () => {
  for (const value of [42, { command: "npm ci" }, [["npm", "ci"], "npm rebuild"], [[]], "[not, json]"]) {
    writeFileSync(hostConfigPath(), JSON.stringify({ hostVerificationSetup: value }));
    const calls: SetupCall[] = [];
    const refusal = refusalOf(await prepare(workspace(), recordingDeps(calls)));
    assert.equal(refusal.reason, "ambiguous_setup_contract", `${JSON.stringify(value)} must be refused`);
    assert.equal(calls.length, 0);
  }
});

test("FG-566 SETUP GRAMMAR — a step that FAILS stops the sequence, and the refusal names THAT step", async () => {
  writeFileSync(hostConfigPath(), JSON.stringify({
    hostVerificationSetup: [["npm", "ci"], ["npm", "run", "build:native"], ["npm", "run", "verify:bindings"]],
  }));
  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace(), {
    porcelain: () => "",
    runSetup: (cmd, args, opts): SetupRun => {
      calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
      // The native build step fails — a node-gyp exit, the case restoring lifecycle
      // scripts newly makes reachable.
      return args.includes("build:native")
        ? { ok: false, status: 1, timedOut: false, stderrTail: "gyp ERR! build error" }
        : { ok: true, status: 0, timedOut: false, stderrTail: "" };
    },
  });

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "setup_failed");
  assert.equal(calls.length, 2, "the sequence stops at the first failure — the third step must not run");
  assert.match(refusal.message, /step 2 of 3/);
  assert.match(refusal.message, /npm run build:native/);
  assert.match(refusal.message, /NOT a verdict on the code/);
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
