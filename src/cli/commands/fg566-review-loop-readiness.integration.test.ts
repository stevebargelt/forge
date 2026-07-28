// FG-566 — review-loop-path falsification suite, OPERATOR-VISIBLE half.
//
// The unit half (src/v2/fg566-review-loop-readiness.test.ts) pins the engine's
// projection of a classified readiness result. This file drives the REAL
// `forge review-loop` command against a real temp git repo whose node_modules is
// correctly absent — the exact state of the live instance
// run-review-loop-fg-356-34ce60 — and asserts the half that is only observable
// through the command itself: CLI stdout, the persisted review-loop.md note, the
// review_loop.verification_finished payload, and the host_readiness.* events.
//
// FIXTURES ARE FULLY OFFLINE. The project under test depends on a `file:` package
// vendored inside the repo, so `npm ci` resolves and installs it from the
// workspace with no registry access (~100ms). Its `bin` is what the project's
// typecheck/test scripts invoke, so those scripts FAIL (exit 127, command not
// found) until dependencies are installed and PASS afterwards — reproducing the
// defect without depending on the network. `.gitignore` lists node_modules/, so
// installing leaves the tree porcelain-clean and the candidate git tree unmoved.
//
// A forced SETUP FAILURE is produced by DESYNCING package.json from the lockfile
// — a dependency the manifest declares and the lock does not. `npm ci` refuses an
// out-of-sync tree outright rather than resolving a different graph, so the
// failure is deterministic and offline, and the setup CONTRACT stays unambiguous:
// the refusal is a genuine setup failure, not a "no identifiable contract"
// ambiguity.
//
// It used to be a `preinstall` that exits 1. A lockfile desync is used instead
// because it fails identically under any setup contract an operator might declare.
// The preinstall script survives here as an OBSERVATION POINT: it dumps its own
// environment outside the tree, so one test can assert both that lifecycle scripts
// RUN (they build native bindings; suppressing them is the defect that shipped)
// and that they run under the reduced setup env, with forge's credentials withheld.
//
// ── CONTRACT PINNED HERE (see the unit file's header for the full statement) ──
// This file imports NO symbol introduced by the readiness build step, compares
// new-vocabulary values through String(...), and finds readiness events with
// eventType.startsWith("host_readiness.") — EventType is a closed string-literal
// union, so a test written against a literal not yet in it would fail typecheck
// outright.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import type { InvokeArgs, InvokeResult } from "../../v2/invoke.js";
import { buildReviewLoopDeps, registerReviewLoop, type ReviewLoopContext } from "./review-loop.js";
import { runDir } from "../../util/paths.js";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertHostVerification } from "../../store/host-verifications.js";
import { eventsForRun, logEvent, type Event } from "../../store/events.js";
import { listRuns } from "../../store/runs.js";

/** The literal operator-facing token, asserted as a STRING on both surfaces so
 *  this file never references a StopReason member absent from the current tree. */
const READINESS_TOKEN = "verification_environment_unavailable";

const REFUSAL_REASONS = [
  "no_setup_contract", "ambiguous_setup_contract", "runtime_unresolved", "runtime_abi_mismatch",
  "setup_failed", "setup_timed_out", "setup_contended", "workspace_dirtied_by_setup",
];

const READINESS_OUTCOMES = ["prepared", "reused", "refused", "not_required"];

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

let projectDir = "";
let db: DatabaseInstance;
let prev: DatabaseInstance | null;

/** Where the fixture's `preinstall` lifecycle script dumps the environment it ran
 *  under. Outside the project so its presence is a pure signal. */
function preinstallCanaryPath(): string {
  return join(tmpdir(), `fg566-preinstall-canary-${basename(projectDir)}`);
}

let savedApiKey: string | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg566-rl-"));
  savedApiKey = process.env["ANTHROPIC_API_KEY"];
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  if (savedApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedApiKey;
  db.close();
  rmSync(preinstallCanaryPath(), { force: true });
  if (projectDir && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  mock.restoreAll();
});

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  mock.method(console, "log", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  return lines;
}

const RESULT = (over: Partial<InvokeResult>): InvokeResult => ({ runId: "run-1", taskId: "t-1", status: "complete", ...over });

/** A standalone clone in exactly the state the live instance was in: the ticket
 *  is committed, dependencies are declared with a lockfile, and node_modules is
 *  ABSENT (correctly — it is gitignored). `failSetup` adds a preinstall script
 *  that exits 1, forcing preparation to fail. Returns the --since base sha. */
function writeReadinessProject(opts: { failSetup: boolean }): string {
  gitExec(["init", "-q", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n");
  gitExec(["add", "-A"], projectDir);
  gitExec(["commit", "-m", "initial commit"], projectDir);
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  // The vendored file: dependency. Its bin is what the project's verification
  // scripts invoke, so they cannot run until dependencies are installed.
  mkdirSync(join(projectDir, "fixture"), { recursive: true });
  writeFileSync(
    join(projectDir, "fixture", "package.json"),
    JSON.stringify({ name: "fg566-fixture", version: "1.0.0", bin: { "fg566-ok": "./ok.js" } }),
  );
  writeFileSync(join(projectDir, "fixture", "ok.js"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });

  const pkg: Record<string, unknown> = {
    name: "fg566-project", version: "1.0.0", private: true,
    dependencies: { "fg566-fixture": "file:./fixture" },
    scripts: { typecheck: "fg566-ok", test: "fg566-ok" },
  };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2));

  // Generate the lockfile WITHOUT installing (no node_modules is the whole point).
  execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: projectDir, stdio: "ignore" });

  // A `preinstall` that dumps its environment OUTSIDE the tree, on EVERY fixture.
  // Lifecycle scripts RUN, so this fires — and what it wrote is how the reduced
  // setup env is observed end to end. (Outside the tree deliberately — a mark
  // written INSIDE would also trip the dirtied-by-setup refusal and conflate the
  // two facts.)
  (pkg["scripts"] as Record<string, string>)["preinstall"] =
    `node -e "require('fs').writeFileSync('${preinstallCanaryPath()}',JSON.stringify(process.env))"`;
  writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2));

  if (opts.failSetup) {
    // The forced setup failure: a dependency package.json declares and the
    // lockfile does not. `npm ci` refuses an out-of-sync tree outright (EUSAGE)
    // rather than resolving a different graph, so the failure is deterministic,
    // offline, and independent of which install command the contract chose.
    //
    // It is NOT a failing `preinstall`: a lockfile desync fails the same way under
    // every setup contract an operator might declare, whereas a preinstall-based
    // failure would only force anything for contracts that reach the install phase.
    (pkg["dependencies"] as Record<string, string>)["fg566-absent-from-lockfile"] = "file:./fixture";
    writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2));
  }

  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-566-host-verification-readiness.md"),
    "---\nid: FG-566\ntype: story\nstatus: active\ntitle: host-side verification readiness\n---\n\nBody.\n",
  );

  gitExec(["add", "-A"], projectDir);
  gitExec(["commit", "-m", "(FG-566) project under review"], projectDir);

  assert.equal(existsSync(join(projectDir, "node_modules")), false, "fixture precondition: the clone must have NO node_modules");
  assert.equal(gitExec(["status", "--porcelain"], projectDir).trim(), "", "fixture precondition: the clone must be porcelain-clean");
  return sinceSha;
}

type CliRun = { printed: string; invocations: InvokeArgs[]; events: Event[]; note: string; exitCode: number | undefined };

/** Drive the REAL review-loop command end to end against projectDir. */
async function runReviewLoopCli(sinceSha: string, extraArgs: string[] = []): Promise<CliRun> {
  const invocations: InvokeArgs[] = [];
  const program = new Command();
  registerReviewLoop(program, async (args) => {
    invocations.push(args);
    return RESULT({ result: { verdict: "pass", findings: [] } });
  });

  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  const lines = captureConsoleLog();
  let exitCode: number | undefined;
  try {
    await program.parseAsync(
      ["review-loop", "FG-566", "--since", sinceSha, "--project", projectDir, "--unrouted", ...extraArgs],
      { from: "user" },
    );
    exitCode = process.exitCode;
  } finally {
    mock.restoreAll();
    process.exitCode = prevExitCode;
  }

  const runs = listRuns();
  assert.equal(runs.length, 1, "the loop must create exactly one run row");
  const runId = runs[0]!.id;
  const notePath = join(runDir(runId), "review-loop.md");
  return {
    printed: lines.join("\n"),
    invocations,
    events: eventsForRun(runId),
    note: existsSync(notePath) ? readFileSync(notePath, "utf8") : "",
    exitCode,
  };
}

function readinessEvents(events: Event[]): Event[] {
  // startsWith, never a literal union member: EventType is a closed union, so a
  // literal not yet in it would fail typecheck against the current tree.
  return events.filter((e) => e.eventType.startsWith("host_readiness."));
}

function verificationFinishedPayload(events: Event[]): Record<string, unknown> {
  const finished = events.filter((e) => e.eventType === "review_loop.verification_finished");
  assert.ok(finished.length > 0, "the loop must emit review_loop.verification_finished");
  return finished[finished.length - 1]!.payload as Record<string, unknown>;
}

function readinessField(payload: Record<string, unknown>): { outcome?: unknown; reason?: unknown } | null | undefined {
  return payload["readiness"] as { outcome?: unknown; reason?: unknown } | null | undefined;
}

// ── Falsification 6: a forced preparation failure, end to end ───────────────
//
// RED pre-fix: there is no preparation at all, so the local fallback runs
// `npm run typecheck` against a clone with no binaries, it exits 127, the loop
// converts that into a fixer finding, and the command reports
// `stop reason: verification_failed` — an environment fault presented as a
// verdict on the reviewed code.

test("FG-566 falsification 6 CLI: a forced preparation failure prints verification_environment_unavailable on stdout, NOT a code verdict", async () => {
  const sinceSha = writeReadinessProject({ failSetup: true });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "2"]);

  const terminalLine = run.printed.split("\n").find((l) => l.includes("not closeable") && l.includes(READINESS_TOKEN));
  assert.ok(
    terminalLine,
    `the command's own terminal line must name the environment outcome — an operator reading stdout must not have to infer it. stdout was:\n${run.printed}`,
  );
  assert.ok(
    !run.printed.includes("stop reason: verification_failed"),
    "an unrunnable environment must never be reported as verification_failed",
  );
});

test("FG-566 falsification 6 CLI: a forced preparation failure dispatches NEITHER reviewer NOR fixer and consumes zero rounds", async () => {
  const sinceSha = writeReadinessProject({ failSetup: true });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "2"]);

  assert.deepEqual(
    run.invocations.map((i) => i.agentRole), [],
    "environment preparation is not a review round, a reviewer verdict, or a fixer attempt — no agent may be dispatched",
  );
  assert.ok(!run.note.includes("## Round 1"), `no round may be consumed by a preparation failure. Note was:\n${run.note}`);
});

test("FG-566 falsification 6 CLI: the persisted review-loop.md note carries the token and names the refusal reason", async () => {
  const sinceSha = writeReadinessProject({ failSetup: true });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "2"]);

  assert.ok(run.note.length > 0, "the loop must persist its note even when it stops before any dispatch");
  assert.ok(run.note.includes(READINESS_TOKEN), `the durable note must name the environment outcome. Note was:\n${run.note}`);
  assert.ok(
    REFUSAL_REASONS.some((r) => run.note.includes(r)),
    `the note must name WHICH readiness check refused, from the shared vocabulary ${REFUSAL_REASONS.join("|")}. Note was:\n${run.note}`,
  );
});

test("FG-566 observable contract CLI: review_loop.verification_finished carries readiness { outcome, reason } on a refusal", async () => {
  const sinceSha = writeReadinessProject({ failSetup: true });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "2"]);

  const readiness = readinessField(verificationFinishedPayload(run.events));
  assert.ok(readiness, "the finish event must carry the readiness field the operator surface reads");
  assert.ok(
    READINESS_OUTCOMES.includes(String(readiness.outcome)),
    `readiness.outcome must be one of ${READINESS_OUTCOMES.join("|")}; got ${String(readiness.outcome)}`,
  );
  assert.equal(String(readiness.outcome), "refused");
  assert.ok(
    REFUSAL_REASONS.includes(String(readiness.reason)),
    `a refusal must carry a reason from the shared vocabulary; got ${String(readiness.reason)}`,
  );
});

test("FG-566 observable contract CLI: a refusal emits a host_readiness.* event", async () => {
  const sinceSha = writeReadinessProject({ failSetup: true });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "2"]);

  const readiness = readinessEvents(run.events);
  assert.ok(readiness.length > 0, "a refusal must leave a durable host_readiness.* record, not only a stop reason");
  const payload = readiness[readiness.length - 1]!.payload as Record<string, unknown>;
  assert.ok(
    REFUSAL_REASONS.includes(String(payload["reason"])),
    `the refusal event must carry a vocabulary reason; got ${String(payload["reason"])}`,
  );
  for (const key of ["workspace", "command"]) {
    assert.ok(key in payload, `the refusal event payload must carry '${key}' so the failure is actionable without re-deriving it`);
  }
});

// ── Falsification 6: a fresh clone PREPARES and reaches round 1 ─────────────
//
// RED pre-fix: nothing installs the declared dependency, so `npm run typecheck`
// exits 127 (`fg566-ok: not found`), the reviewer is short-circuited, and the
// loop stops without ever reaching a reviewer verdict.

test("FG-566 falsification 6 CLI: a fresh standalone clone forced onto the local fallback PREPARES and reaches round 1", async () => {
  const sinceSha = writeReadinessProject({ failSetup: false });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "1"]);

  assert.deepEqual(
    run.invocations.map((i) => i.agentRole), ["red-wide"],
    `a prepared workspace verifies green and reaches the REVIEWER — today the fallback fails before it can examine the implementation. Note was:\n${run.note}`,
  );
  assert.ok(run.note.includes("reviewer verdict: pass"), `round 1 must produce a real reviewer verdict. Note was:\n${run.note}`);
  assert.ok(!run.printed.includes(READINESS_TOKEN), "a successful preparation is not an environment failure");
  assert.equal(
    existsSync(join(projectDir, "node_modules")), true,
    "preparation must actually materialize the declared dependencies in the workspace under test",
  );
});

test("FG-566 SETUP ENV CLI: lifecycle scripts RUN during preparation, and they run under the REDUCED env", async () => {
  // Both halves in one place, because they are easy to confuse. Lifecycle scripts
  // execute — a native dependency's bindings are built by exactly this hook, and
  // suppressing it certified workspaces whose bindings could not load as ready.
  // What still holds is the ENV they run under: an explicitly constructed minimal
  // one, so forge's credentials never reach an install script. That is hygiene,
  // not a boundary — host verification assumes the candidate is not hostile, and
  // the candidate-controlled test command runs on this host moments later anyway.
  const sinceSha = writeReadinessProject({ failSetup: false });
  process.env["ANTHROPIC_API_KEY"] = "sk-should-never-reach-a-lifecycle-script";
  await runReviewLoopCli(sinceSha, ["--max-rounds", "1"]);

  assert.equal(existsSync(join(projectDir, "node_modules")), true, "precondition: the install really did run");
  assert.equal(
    existsSync(preinstallCanaryPath()), true,
    "install lifecycle scripts must RUN — suppressing them is what left native dependencies unbuilt",
  );
  const childEnv = JSON.parse(readFileSync(preinstallCanaryPath(), "utf8")) as Record<string, string>;
  assert.equal(childEnv["ANTHROPIC_API_KEY"], undefined, "forge's credentials are still withheld from the setup child");
  assert.equal(childEnv["FORGE_HOME"], undefined);
  assert.equal(childEnv["npm_config_ignore_scripts"], undefined);
});

test("FG-566 falsification 6 CLI: preparation does NOT move the candidate git tree — the workspace stays porcelain-clean", async () => {
  const sinceSha = writeReadinessProject({ failSetup: false });
  const treeBefore = gitExec(["rev-parse", "HEAD^{tree}"], projectDir).trim();
  await runReviewLoopCli(sinceSha, ["--max-rounds", "1"]);

  assert.equal(
    gitExec(["rev-parse", "HEAD^{tree}"], projectDir).trim(), treeBefore,
    "dependencies must not alter the reviewed git tree (FG-621 AC 6)",
  );
  assert.equal(
    gitExec(["status", "--porcelain"], projectDir).trim(), "",
    "preparation must leave the workspace porcelain-clean — a dirtied workspace is a refusal, never a silent proceed",
  );
});

test("FG-566 observable contract CLI: a successful preparation emits host_readiness.* with the shared evidence shape", async () => {
  const sinceSha = writeReadinessProject({ failSetup: false });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "1"]);

  const readiness = readinessEvents(run.events);
  assert.ok(readiness.length > 0, "a successful preparation must leave durable evidence, not only a green verification");
  const payload = readiness[readiness.length - 1]!.payload as Record<string, unknown>;
  for (const key of ["workspace", "treeSha", "lockfileDigest", "nodeVersion", "abi", "setupCommand", "reused"]) {
    assert.ok(
      key in payload,
      `the readiness evidence must carry '${key}' — the fidelity binding (candidate identity, lockfile, runtime/ABI) is what stops readiness being inherited by a different candidate. Payload keys: ${Object.keys(payload).join(", ")}`,
    );
  }
});

test("FG-566 observable contract CLI: review_loop.verification_finished carries readiness outcome prepared|reused after a successful preparation", async () => {
  const sinceSha = writeReadinessProject({ failSetup: false });
  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "1"]);

  const readiness = readinessField(verificationFinishedPayload(run.events));
  assert.ok(readiness, "the finish event must carry the readiness field on the success path too");
  assert.ok(
    ["prepared", "reused"].includes(String(readiness.outcome)),
    `a local fallback that had to make the workspace runnable reports prepared (or reused); got ${String(readiness.outcome)}`,
  );
});

// ── CI reuse stays first-class ─────────────────────────────────────────────
//
// A non-regression guard, not a falsification: pre-fix there is no provisioning
// at all, so this is green by construction. It goes red only if the fix
// over-reaches and makes readiness an unconditional precondition, which would
// make trusted covering evidence pay for a local install it does not need.

test("FG-566 falsification 6 CLI: trusted covering evidence returns BEFORE any local provisioning — no readiness event, no node_modules", async () => {
  writeReadinessProject({ failSetup: true }); // setup WOULD fail if it were ever attempted
  const headSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  insertHostVerification({
    ticketId: "FG-566", projectDir, commitSha: headSha,
    gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-07-27T00:00:00Z",
  });

  const ctx: ReviewLoopContext = {
    ticketId: "FG-566", acceptance: "FG-566", diffProvider: () => "", projectDir,
    scripts: { typecheck: "fg566-ok", test: "fg566-ok" }, unrouted: true, runId: "run-fg566-reuse",
    checkStatusProvider: () => { throw new Error("must not be consulted — a covering host row already exists"); },
    runVerification: () => { throw new Error("must not run local verification — covering evidence exists"); },
  };
  const { deps } = buildReviewLoopDeps(ctx);
  // Read structurally: deps.verify() returns the widened outcome union, and this
  // file deliberately imports no discriminant helper from the readiness module.
  const result = await deps.verify() as unknown as { kind?: string; ok?: boolean; reusedEvidence?: string };

  assert.notEqual(String(result.kind), "environment_unavailable", "a covering host row must never produce an environment refusal");
  assert.equal(result.ok, true);
  assert.ok(result.reusedEvidence, "the covering host row must satisfy verification without a local run");
  assert.deepEqual(
    readinessEvents(eventsForRun("run-fg566-reuse")).map((e) => e.eventType), [],
    "trusted covering evidence must return before readiness is consulted — no local provisioning may be attempted",
  );
  assert.equal(existsSync(join(projectDir, "node_modules")), false, "no install may happen on the reuse path");

  const readiness = readinessField(verificationFinishedPayload(eventsForRun("run-fg566-reuse")));
  if (readiness) {
    assert.equal(
      String(readiness.outcome), "not_required",
      "if the reuse path reports readiness at all it must be not_required — never prepared/reused, which would mean provisioning ran",
    );
  }
});

// ── Backwards compatibility of the widened event payload ───────────────────
//
// A compatibility guard: rows recorded before this ticket carry no readiness
// field at all, and every consumer (the dashboard renderer in particular) must
// keep treating them exactly as it does today.

test("FG-566 observable contract: a LEGACY review_loop.verification_finished payload with no readiness field is still accepted and round-trips unchanged", () => {
  const legacy = {
    attemptId: "att-legacy", round: 1, ticketId: "FG-566", sha: "abc1234", mode: "ci_wait",
    ok: true, reusedEvidence: null, ciOutcome: null, checkContexts: null,
    command: "npm run typecheck && npm run test", tier: "fast",
    steps: [{ name: "typecheck", ok: true }, { name: "test", ok: true }],
  };
  logEvent("review_loop.verification_finished", { runId: "run-fg566-legacy", payload: legacy });

  const payload = verificationFinishedPayload(eventsForRun("run-fg566-legacy"));
  assert.deepEqual(payload, legacy, "a legacy payload must round-trip byte-identically — the readiness field is additive");
  assert.equal("readiness" in payload, false, "consumers must tolerate the field being absent entirely, not merely null");
  assert.equal(readinessField(payload), undefined);
});
