// FG-566 verify phase: the readiness contract's DURABLE STATE and its LOCK — the
// half of this ticket that lives on the filesystem rather than in a return value.
//
// WHY THIS FILE EXISTS. The suites that landed with the build cover the two
// consumers' dispositions (fg566-review-loop-readiness.test.ts,
// fg566-publication-readiness.worktree.test.ts) and the primitive's security and
// ABI preconditions (fg566-host-readiness-contract.test.ts). None of them touches
// src/v2/host-readiness-store.ts: `withReadinessLock`, `workspaceHasNodeModules`,
// `readinessMatches`, the record round-trip and the `preparing`/`ready` state
// machine had ZERO direct coverage, and the build agent flagged two hardenings as
// deliberately untested because the fanout's file partition gave them nowhere to
// live. They live here.
//
// These are INTEGRATION tests in the substantive sense: nothing about the store is
// mocked. Every assertion runs the real `prepareHostVerification` against a real
// temp workspace, a real record under $FORGE_HOME/host-readiness/ (isolated per
// test process by src/test-setup.ts) and a real O_EXCL lock file. Only the setup
// child is injected — and the last two tests drop that too and run a real one, so
// `defaultRunSetup`'s environment and stderr-tail contracts are proven by
// observation rather than by a recorded argument.
//
// THE TWO HARDENINGS, restated as the defects they prevent:
//   FG-627 MOUNTPOINT  — worktree-lifecycle.ts pre-creates EMPTY <member>/node_modules
//                        directories. Read as "already provisioned", the install is
//                        skipped and FG-566's defect returns through the adjacent
//                        ticket's mechanics.
//   HALF-INSTALLED TREE — a failed `npm ci` leaves a partly-populated node_modules.
//                        Without the `preparing` record written BEFORE setup runs,
//                        the next attempt reads it as a foreign already-provisioned
//                        tree, verifies against it, and blames the code.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { hostConfigPath, hostReadinessDir } from "../util/paths.js";
import { dependencyCacheDir } from "./dependency-provisioning.js";
import { controlRuntimeProfile } from "./launch.js";
import {
  prepareHostVerification,
  resolveVerificationInterpreter,
  type HostReadinessDeps,
  type HostReadinessEvidence,
  type HostReadinessOutcome,
  type SetupRun,
} from "./host-readiness.js";
import {
  hostReadinessLockTimeoutMs,
  readReadinessRecord,
  readinessRecordPath,
  writeReadinessRecord,
} from "./host-readiness-store.js";

let prevDb: DatabaseInstance | null;
const dirs: string[] = [];
const envKeys = [
  "FORGE_HOST_VERIFICATION_SETUP",
  "FORGE_HOST_READINESS_REQUIRE_ABI",
  "FORGE_HOST_READINESS_SETUP_TIMEOUT_MS",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  rmSync(hostConfigPath(), { force: true });
  // A clean keyspace per test: records key off the workspace path, and every
  // workspace here is a fresh mkdtemp, but a leaked LOCK from a failing assertion
  // must not be able to make the next test's contention result look real.
  rmSync(hostReadinessDir(), { recursive: true, force: true });
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

/** A workspace shaped like the thing readiness prepares: declares dependencies,
 *  carries a lockfile, has no node_modules, pins no Node major (so the record's
 *  own ABI is what a later run is checked against — arm 4 of
 *  resolveRuntimeRequirement, which is the arm the store feeds). */
function workspace(opts: { lockfileBody?: string } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg566-store-")));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg566-store-fixture", version: "1.0.0", private: true, dependencies: { "some-dep": "1.0.0" } }),
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    opts.lockfileBody ?? JSON.stringify({ name: "fg566-store-fixture", lockfileVersion: 3 }),
  );
  return dir;
}

/** What a real install leaves behind: a NON-EMPTY node_modules. */
function materializeModules(ws: string): void {
  mkdirSync(join(ws, "node_modules", "some-dep"), { recursive: true });
  writeFileSync(join(ws, "node_modules", "some-dep", "index.js"), "export default 1;\n");
}

type SetupCall = { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };

/** A setup child that SUCCEEDS and actually populates node_modules, so the reuse
 *  path (which requires a non-empty tree, not merely a record) is reachable. */
function installingDeps(calls: SetupCall[], extra: HostReadinessDeps = {}): HostReadinessDeps {
  return {
    runSetup: (cmd, args, opts): SetupRun => {
      calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
      materializeModules(opts.cwd);
      return { ok: true, status: 0, timedOut: false, stderrTail: "" };
    },
    porcelain: () => "",
    ...extra,
  };
}

/** A setup child that FAILS the way a real `npm ci` fails: non-zero, and a
 *  half-populated node_modules left behind. */
function halfInstallingFailure(calls: SetupCall[], extra: HostReadinessDeps = {}): HostReadinessDeps {
  return {
    runSetup: (cmd, args, opts): SetupRun => {
      calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
      mkdirSync(join(opts.cwd, "node_modules", ".package-lock.json-partial"), { recursive: true });
      return { ok: false, status: 1, timedOut: false, stderrTail: "npm ERR! code EINTEGRITY" };
    },
    porcelain: () => "",
    ...extra,
  };
}

/** Outside the forge source root, or the self-host guard (correctly) refuses
 *  first — it is evaluated ahead of every other arm by design.
 *
 *  FG-693: it must be a REAL directory. The guard's comparison is three-valued
 *  now — a source root that does not exist has no identity to compare, so it
 *  refuses as UNPROVEN rather than comparing as separate. Created per call and
 *  registered for teardown like every other fixture directory here. */
function notTheForgeRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg566-store-not-the-forge-root-")));
  dirs.push(dir);
  return dir;
}

function prepare(
  ws: string,
  deps: HostReadinessDeps,
  req: { treeSha?: string; coveredCommandSet?: string[] } = {},
): Promise<HostReadinessOutcome> {
  return prepareHostVerification(
    {
      workspace: ws,
      treeSha: req.treeSha ?? "candidate-aaa",
      coveredCommandSet: req.coveredCommandSet ?? ["npm run test:unit"],
      label: "verify-phase",
    },
    { sourceRoot: notTheForgeRoot(), ...deps },
  );
}

function evidenceOf(outcome: HostReadinessOutcome): HostReadinessEvidence {
  assert.equal(outcome.kind, "ready", `expected ready, got ${outcome.kind}`);
  return (outcome as { evidence: HostReadinessEvidence }).evidence;
}

function refusalOf(outcome: HostReadinessOutcome): {
  reason: string;
  message: string;
  command: string;
  exitStatus: number | null;
  stderrTail: string;
} {
  assert.equal(outcome.kind, "refused", `expected a refusal, got ${outcome.kind}`);
  return (outcome as { refusal: ReturnType<typeof refusalOf> }).refusal;
}

/** The lock the store takes, derived from the ONE exported path helper rather
 *  than by re-implementing recordSlug — so a change to the slug scheme moves this
 *  with it instead of silently pointing at nothing. */
function lockPathFor(ws: string): string {
  return readinessRecordPath(ws).replace(/\.json$/, ".lock");
}

function plantLock(ws: string, info: { pid: number; acquiredAtMs: number }): string {
  const path = lockPathFor(ws);
  mkdirSync(hostReadinessDir(), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...info, workspace: ws }));
  return path;
}

// ── The two hardenings the fanout left uncovered ────────────────────────────

test("FG-566 FG-627 MOUNTPOINT — an EMPTY node_modules directory is NOT 'already provisioned': readiness still prepares", async () => {
  const ws = workspace();
  // Exactly what worktree-lifecycle.ts pre-creates so the container provisioner
  // can bind into a read-only project mount.
  mkdirSync(join(ws, "node_modules"), { recursive: true });

  const calls: SetupCall[] = [];
  const outcome = await prepare(ws, installingDeps(calls));

  // A bare existsSync here would have returned not_required and skipped the
  // install — FG-566's defect, reintroduced through FG-627's mechanics.
  assert.equal(outcome.kind, "ready");
  assert.equal(calls.length, 1, "the empty mountpoint must not suppress the install");
  assert.equal(evidenceOf(outcome).reused, false);
});

test("FG-566 FG-627 MOUNTPOINT — a NON-EMPTY node_modules with no record IS left alone (the operator's live checkout)", async () => {
  const ws = workspace();
  materializeModules(ws);

  const calls: SetupCall[] = [];
  const outcome = await prepare(ws, installingDeps(calls));

  // `npm ci` DELETES node_modules before rebuilding it. A tree forge did not
  // provision is never remediated — it was already runnable.
  assert.equal(outcome.kind, "not_required");
  assert.match((outcome as { why: string }).why, /forge did not provision/);
  assert.equal(calls.length, 0);
});

test("FG-566 HALF-INSTALLED TREE — a FAILED setup leaves a `preparing` record, never a promoted one", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];

  const outcome = await prepare(ws, halfInstallingFailure(calls));

  assert.equal(refusalOf(outcome).reason, "setup_failed");
  const record = readReadinessRecord(ws);
  assert.ok(record, "the workspace must be CLAIMED before setup runs, or a crash leaves it unexplained");
  assert.equal(record?.state, "preparing");
});

test("FG-566 HALF-INSTALLED TREE — the next attempt RE-PREPARES it and does not mistake it for a foreign tree", async () => {
  const ws = workspace();
  const first: SetupCall[] = [];
  await prepare(ws, halfInstallingFailure(first));
  assert.equal(first.length, 1);
  // The failure left modules behind: the exact shape that reads as "already
  // provisioned" to a record-blind check.
  assert.ok(existsSync(join(ws, "node_modules")));

  const second: SetupCall[] = [];
  const outcome = await prepare(ws, installingDeps(second));

  // NOT not_required. "forge did not put it there" is decided by the ABSENCE OF
  // ANY record, not the absence of a MATCHING one.
  assert.equal(outcome.kind, "ready", `a half-installed tree must be re-prepared, got ${outcome.kind}`);
  assert.equal(second.length, 1, "the retry must actually run setup again");
  assert.equal(readReadinessRecord(ws)?.state, "ready");
});

test("FG-566 STATE MACHINE — only `ready` satisfies a reuse: an unrecognized state fails CLOSED and re-prepares", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];
  await prepare(ws, installingDeps(calls));
  assert.equal(calls.length, 1);

  // A record from a future/rolled-back forge, or a hand-edited one.
  const record = readReadinessRecord(ws);
  assert.ok(record);
  writeFileSync(
    readinessRecordPath(ws),
    JSON.stringify({ ...record, state: "provisioned-probably" }),
  );
  assert.equal(readReadinessRecord(ws)?.state, "preparing", "anything not explicitly `ready` is an unfinished preparation");

  const again: SetupCall[] = [];
  const outcome = await prepare(ws, installingDeps(again));
  assert.equal(outcome.kind, "ready");
  assert.equal(evidenceOf(outcome).reused, false);
  assert.equal(again.length, 1);
});

// ── Binding fidelity, through the real record rather than a return value ─────

test("FG-566 BINDING — an identical second request REUSES the assertion: setup runs exactly once", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];

  const first = await prepare(ws, installingDeps(calls));
  const second = await prepare(ws, installingDeps(calls));

  assert.equal(evidenceOf(first).reused, false);
  assert.equal(evidenceOf(second).reused, true);
  assert.equal(calls.length, 1, "a warm, matching assertion must not re-install");
});

test("FG-566 BINDING — a DIFFERENT candidate is never served by the previous candidate's readiness", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];
  await prepare(ws, installingDeps(calls), { treeSha: "candidate-aaa" });

  const outcome = await prepare(ws, installingDeps(calls), { treeSha: "candidate-bbb" });

  assert.equal(evidenceOf(outcome).reused, false, "readiness must never be inherited by a different candidate");
  assert.equal(calls.length, 2);
  assert.equal(readReadinessRecord(ws)?.treeSha, "candidate-bbb");
});

test("FG-566 BINDING — a CHANGED LOCKFILE forces re-preparation even at the same candidate sha", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];
  await prepare(ws, installingDeps(calls));
  const firstDigest = evidenceOf(await prepare(ws, installingDeps(calls))).lockfileDigest;
  assert.equal(calls.length, 1);

  writeFileSync(
    join(ws, "package-lock.json"),
    JSON.stringify({ name: "fg566-store-fixture", lockfileVersion: 3, packages: { "node_modules/dep-two": { version: "2.0.0" } } }),
  );
  const outcome = await prepare(ws, installingDeps(calls));

  assert.equal(evidenceOf(outcome).reused, false);
  assert.notEqual(evidenceOf(outcome).lockfileDigest, firstDigest);
  assert.equal(calls.length, 2);
});

test("FG-566 BINDING — an interpreter whose ABI differs from the one the tree was INSTALLED under is refused, not reused", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];
  await prepare(ws, installingDeps(calls, { probeAbi: () => "127", probeNodeVersion: () => "v22.11.0" }));
  assert.equal(readReadinessRecord(ws)?.abi, "127");

  // Same workspace, same candidate, same lockfile — a different Node. The tree's
  // native bindings were built for ABI 127 and load under 127 only.
  const outcome = await prepare(ws, installingDeps(calls, { probeAbi: () => "137", probeNodeVersion: () => "v24.18.0" }));

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "runtime_abi_mismatch");
  assert.match(refusal.message, /^verification_environment_unavailable: /);
  assert.match(refusal.message, /prior readiness record/);
  assert.equal(calls.length, 1, "a refusal must not run a second install");
});

test("FG-566 BINDING — an ABANDONED `preparing` record never becomes the workspace's required ABI", async () => {
  const ws = workspace();
  const first: SetupCall[] = [];
  const failed = await prepare(ws, halfInstallingFailure(first, { probeAbi: () => "127", probeNodeVersion: () => "v22.11.0" }));
  assert.equal(refusalOf(failed).reason, "setup_failed");
  assert.equal(readReadinessRecord(ws)?.state, "preparing");
  assert.equal(readReadinessRecord(ws)?.abi, "127", "the abandoned record carries the ABI the FAILED attempt ran under");

  // The operator moves to the interpreter this workspace actually needs. The
  // abandoned attempt installed NOTHING under ABI 127, so that record must not be
  // what the new interpreter is checked against — treated as a requirement it
  // outranks the workspace's own declaration and refuses every subsequent attempt
  // identically, forever, with no operator recovery path.
  const second: SetupCall[] = [];
  const outcome = await prepare(ws, installingDeps(second, { probeAbi: () => "137", probeNodeVersion: () => "v24.18.0" }));

  // Asserted on the CALL, not merely on the outcome: a short-circuit elsewhere
  // would satisfy "not a refusal" while still never running setup again.
  assert.equal(second.length, 1, "the setup command must actually run again under the corrected interpreter");
  assert.equal(outcome.kind, "ready", `an abandoned preparing record must not wedge the workspace, got ${JSON.stringify(outcome)}`);
  assert.equal(readReadinessRecord(ws)?.abi, "137");
});

test("FG-566 BINDING — readiness for one workspace is never served to another", async () => {
  const a = workspace();
  const b = workspace();
  const calls: SetupCall[] = [];

  await prepare(a, installingDeps(calls));
  materializeModules(b); // b looks installed, but carries no record of its own
  const outcome = await prepare(b, installingDeps(calls));

  assert.notEqual(outcome.kind, "ready", "workspace b must not inherit workspace a's assertion");
  assert.equal(calls.length, 1);
  assert.equal(readReadinessRecord(a)?.workspace, a);
});

test("FG-566 BINDING — the COVERED COMMAND SET is evidence, never a reuse key", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];
  await prepare(ws, installingDeps(calls), { coveredCommandSet: ["npm run test:unit"] });

  const outcome = await prepare(ws, installingDeps(calls), { coveredCommandSet: ["npm run typecheck", "npm test"] });

  assert.equal(evidenceOf(outcome).reused, true, "a different command set must not invalidate the install");
  assert.equal(calls.length, 1);
  // The evidence reports what THIS request covered, not what the record recorded.
  assert.deepEqual(evidenceOf(outcome).coveredCommandSet, ["npm run typecheck", "npm test"]);
});

// ── The lock: contention, crash recovery, and never wedging a workspace ──────

test("FG-566 LOCK — a LIVE holder that outlasts the bounded wait refuses setup_contended and runs NOTHING", async () => {
  const ws = workspace();
  plantLock(ws, { pid: 424242, acquiredAtMs: Date.now() });
  const calls: SetupCall[] = [];

  const outcome = await prepare(ws, installingDeps(calls, { lock: { isAlive: () => true, waitMs: 40, pollMs: 5 } }));

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "setup_contended");
  assert.equal(refusal.command, "(lock)");
  assert.match(refusal.message, /^verification_environment_unavailable: /);
  assert.equal(calls.length, 0, "forge must never run a second concurrent setup into the same tree");
});

test("FG-566 LOCK — a DEAD holder's lock is broken and preparation proceeds", async () => {
  const ws = workspace();
  const path = plantLock(ws, { pid: 424242, acquiredAtMs: Date.now() });
  const calls: SetupCall[] = [];

  const outcome = await prepare(ws, installingDeps(calls, { lock: { isAlive: () => false, waitMs: 40, pollMs: 5 } }));

  // A dead pid IS proof the install stopped: the setup is a host process, not a
  // container that can outlive us.
  assert.equal(outcome.kind, "ready");
  assert.equal(calls.length, 1);
  assert.equal(existsSync(path), false, "the broken lock must not be left behind");
});

test("FG-566 LOCK — the timeout BACKSTOP breaks a lock held by a live but ancient pid", async () => {
  const ws = workspace();
  plantLock(ws, { pid: 424242, acquiredAtMs: Date.now() - hostReadinessLockTimeoutMs() - 60_000 });
  const calls: SetupCall[] = [];

  // isAlive says yes — the pathological recycled-pid case the backstop exists for.
  const outcome = await prepare(ws, installingDeps(calls, { lock: { isAlive: () => true, waitMs: 40, pollMs: 5 } }));

  assert.equal(outcome.kind, "ready");
  assert.equal(calls.length, 1);
});

test("FG-566 LOCK — a FAILED setup releases the lock: a broken install must not wedge the workspace forever", async () => {
  const ws = workspace();
  const first: SetupCall[] = [];
  const failed = await prepare(ws, halfInstallingFailure(first));
  assert.equal(refusalOf(failed).reason, "setup_failed");
  assert.equal(existsSync(lockPathFor(ws)), false, "the lock must be released on the refusal path too");

  // And the workspace is genuinely usable again once the cause is fixed.
  const second: SetupCall[] = [];
  const outcome = await prepare(ws, installingDeps(second));
  assert.equal(outcome.kind, "ready");
  assert.equal(second.length, 1);
});

test("FG-566 LOCK — a SUCCESSFUL preparation leaves no lock behind", async () => {
  const ws = workspace();
  await prepare(ws, installingDeps([]));
  assert.equal(existsSync(lockPathFor(ws)), false);
});

// ── Refusal classification produced by the primitive itself ──────────────────

test("FG-566 REFUSAL — a setup that MOVES the tree refuses workspace_dirtied_by_setup and is never promoted to ready", async () => {
  const ws = workspace();
  let after = "";
  const calls: SetupCall[] = [];
  const outcome = await prepare(
    ws,
    installingDeps(calls, {
      porcelain: () => after,
      runSetup: (cmd, args, opts): SetupRun => {
        calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
        materializeModules(opts.cwd);
        after = "M  package-lock.json\0"; // npm rewrote the lockfile under test
        return { ok: true, status: 0, timedOut: false, stderrTail: "" };
      },
    }),
  );

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "workspace_dirtied_by_setup");
  assert.match(refusal.stderrTail, /package-lock\.json/, "the refusal must name what moved");
  // FG-621 AC 6: the published tree is byte-for-byte the gated tree. A moved tree
  // may never be recorded as a satisfied assertion, or the NEXT run reuses it.
  assert.equal(readReadinessRecord(ws)?.state, "preparing");
});

test("FG-566 REFUSAL — a TIMED-OUT setup classifies apart from a failed one and names the ceiling", async () => {
  const ws = workspace();
  process.env["FORGE_HOST_READINESS_SETUP_TIMEOUT_MS"] = "5000";

  const outcome = await prepare(ws, {
    porcelain: () => "",
    runSetup: (_cmd, _args, opts): SetupRun => {
      // The ceiling bounds the CONTRACT, not each step, so a multi-step contract
      // cannot outrun the span lease composed from it: the child gets what is left
      // of the operator's ceiling, which for the first step is all of it.
      assert.ok(opts.timeoutMs > 4900 && opts.timeoutMs <= 5000, `the operator's ceiling must reach the child, got ${opts.timeoutMs}`);
      return { ok: false, status: null, timedOut: true, stderrTail: "" };
    },
  });

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "setup_timed_out");
  assert.equal(refusal.exitStatus, null);
  assert.match(refusal.message, /5s setup ceiling/);
});

test("FG-566 REFUSAL — a failed setup carries the exit status and stderr, and says it is NOT a verdict on the code", async () => {
  const ws = workspace();
  const outcome = await prepare(ws, {
    porcelain: () => "",
    runSetup: (): SetupRun => ({ ok: false, status: 17, timedOut: false, stderrTail: "npm ERR! code EINTEGRITY" }),
  });

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "setup_failed");
  assert.equal(refusal.exitStatus, 17);
  assert.equal(refusal.stderrTail, "npm ERR! code EINTEGRITY");
  // The whole point of the ticket: an environment fault must not read as a code verdict.
  assert.match(refusal.message, /NOT a verdict on the code/);
});

// ── Keyspace boundary (FG-376) ───────────────────────────────────────────────

test("FG-566 KEYSPACE — a full prepare/reuse cycle writes host-readiness/ ONLY and never FG-376's dependency-cache", async () => {
  const ws = workspace();
  const calls: SetupCall[] = [];
  await prepare(ws, installingDeps(calls));
  await prepare(ws, installingDeps(calls));
  await prepare(ws, halfInstallingFailure(calls), { treeSha: "candidate-bbb" });

  assert.ok(existsSync(readinessRecordPath(ws)), "the assertion must be durable");
  assert.equal(
    existsSync(dependencyCacheDir()),
    false,
    "the container provisioner's keyspace must never be written by the host readiness path",
  );
});

test("FG-566 KEYSPACE — a torn or truncated record reads as 'never asserted' rather than as an assertion", async () => {
  const ws = workspace();
  await prepare(ws, installingDeps([]));
  writeFileSync(readinessRecordPath(ws), '{"workspace":"');

  assert.equal(readReadinessRecord(ws), null);
  // And the primitive recovers: with modules present but no readable record the
  // tree reads as foreign and is left alone rather than being silently reused.
  const calls: SetupCall[] = [];
  const outcome = await prepare(ws, installingDeps(calls));
  assert.notEqual(outcome.kind, "ready");
  assert.equal(calls.length, 0);
});

// ── The REAL setup child: defaultRunSetup's contracts, unmocked ──────────────

const PINNED_PATH = controlRuntimeProfile({ label: "fg566-store-test" }).path;
const REAL_NODE = resolveVerificationInterpreter(PINNED_PATH);

test("FG-566 REAL CHILD — the pinned PATH and the env withholding survive defaultRunSetup, and lifecycle scripts are NOT suppressed", async (t) => {
  if (!REAL_NODE) return t.skip("no executable node on the pinned verification PATH");
  const ws = workspace();
  const scriptDir = realpathSync(mkdtempSync(join(tmpdir(), "fg566-setup-")));
  dirs.push(scriptDir);
  const dump = join(scriptDir, "env.json");
  writeFileSync(
    join(scriptDir, "setup.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\n`,
  );
  // The structured contract, through the env override: an argv array, so a temp
  // path with a space in it survives verbatim instead of being split.
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([REAL_NODE, join(scriptDir, "setup.mjs")]);
  process.env["FORGE_HOST_READINESS_REQUIRE_ABI"] = process.versions.modules;

  // No runSetup injection: this is the real child, spawned by defaultRunSetup.
  const outcome = await prepare(ws, { porcelain: () => "" });

  assert.equal(outcome.kind, "ready", JSON.stringify(outcome));
  const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
  assert.equal(childEnv["PATH"], PINNED_PATH, "the install must resolve the SAME interpreter the verification will");
  assert.equal(
    childEnv["npm_config_ignore_scripts"],
    undefined,
    "a native dependency's install script IS how its bindings get built — suppressing it certified unloadable workspaces as ready",
  );
  // Explicitly constructed, never `...process.env` — this child's code comes from
  // the tree under test.
  assert.equal(childEnv["FORGE_HOST_VERIFICATION_SETUP"], undefined);
  assert.equal(childEnv["FORGE_HOME"], undefined);
});

test("FG-566 REAL CHILD — a real non-zero setup yields the exit status and the stderr TAIL, not a bare colon", async (t) => {
  if (!REAL_NODE) return t.skip("no executable node on the pinned verification PATH");
  const ws = workspace();
  const scriptDir = realpathSync(mkdtempSync(join(tmpdir(), "fg566-setup-")));
  dirs.push(scriptDir);
  // Noisy enough to exceed the 2000-char tail: the LAST bytes are what name the
  // failure, and a head slice is what left the FG-356 findings reporting nothing
  // after the colon.
  writeFileSync(
    join(scriptDir, "fail.mjs"),
    `process.stderr.write("FIRST_LINE_MARKER\\n" + "x".repeat(4000) + "\\nnpm ERR! LAST_LINE_MARKER\\n");\nprocess.exit(17);\n`,
  );
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([REAL_NODE, join(scriptDir, "fail.mjs")]);
  process.env["FORGE_HOST_READINESS_REQUIRE_ABI"] = process.versions.modules;

  const refusal = refusalOf(await prepare(ws, { porcelain: () => "" }));

  assert.equal(refusal.reason, "setup_failed");
  assert.equal(refusal.exitStatus, 17);
  assert.match(refusal.stderrTail, /LAST_LINE_MARKER/, "the tail must carry what actually named the failure");
  assert.ok(!refusal.stderrTail.includes("FIRST_LINE_MARKER"), "a head slice is the defect, not the fix");
  assert.ok(refusal.stderrTail.startsWith("…"), "a truncated tail must be marked as truncated");
  assert.equal(readReadinessRecord(ws)?.state, "preparing");
});
