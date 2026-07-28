// FG-566 (ACs 13-18) — THE INVERSE DEFECT, restated for the NATIVE case, on the
// REVIEW-LOOP path.
//
// WHY THIS FILE EXISTS. Dropping lifecycle-script suppression makes strictly MORE
// code run during setup: a dependency's `preinstall`/`install`/`postinstall` now
// execute, and any of them can exit non-zero. That is the whole point — a native
// build that fails must fail SETUP rather than be skipped into a workspace whose
// bindings cannot load. But it is also exactly the pressure that turns real code
// failures into environment outcomes, because the easy way to make native build
// failures environmental is to make failure-after-setup environmental too.
//
// So both halves are pinned here, on the SAME fixture, differing only in whether
// the native build succeeds:
//
//   NATIVE BUILD FAILURE DURING SETUP  → a readiness REFUSAL. Named reason
//     (`setup_failed`), the build's own stderr, zero rounds, and NEITHER the
//     reviewer NOR the fixer dispatched. Nothing was verified, so there is no
//     verdict on the code to report.
//   GENUINE FAILURE AFTER A SUCCESSFUL NATIVE BUILD → a CODE VERDICT. An ordinary
//     failed verification that reaches the FIXER and consumes its round, with
//     readiness reporting `prepared`. Never the environment stop reason.
//
// The publication half of the same pair lives in
// src/v2/fg566-publication-readiness.worktree.test.ts (falsifications 8 and 9);
// the review-loop half was only covered with an INJECTED readiness outcome
// (src/v2/fg566-review-loop-readiness.test.ts), so nothing yet drove a real
// lifecycle script, a real build failure and a real post-setup code failure
// through the actual `forge review-loop` command. This file does.
//
// FULLY OFFLINE. The dependency is a `file:` package vendored inside the repo and
// its build step is plain `node` — no registry, no node-gyp, no toolchain.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import type { InvokeArgs, InvokeResult } from "../../v2/invoke.js";
import { registerReviewLoop } from "./review-loop.js";
import { runDir } from "../../util/paths.js";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { eventsForRun, type Event } from "../../store/events.js";
import { listRuns } from "../../store/runs.js";

/** The operator-facing token, compared as a STRING on every surface. */
const READINESS_TOKEN = "verification_environment_unavailable";
const NATIVE_DEP = "fg566-native-dep";
/** Emitted by the dependency's build script when it is made to fail. */
const BUILD_FAILURE = "FG566_NATIVE_BUILD_FAILURE";
/** Emitted by the project's OWN verification script — a real code failure that
 *  can only be reached once the dependency loaded, i.e. once setup succeeded. */
const CODE_FAILURE = "FG566_GENUINE_TEST_FAILURE";

let projectDir = "";
let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg566-native-"));
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (projectDir && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  mock.restoreAll();
});

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

/** A standalone clone in the state the live instance was in — dependencies
 *  declared, lockfile committed, `node_modules` correctly ABSENT — whose single
 *  dependency must BUILD during install to be importable.
 *
 *  `buildExit` non-zero makes that build fail the way node-gyp does on a host with
 *  no toolchain. `verdict` is the project's own test outcome AFTER a successful
 *  build: a tracked file, so a genuine code failure is committed content rather
 *  than an environment condition. Returns the `--since` base sha. */
function writeNativeProject(opts: { buildExit?: number; verdict: "pass" | "fail" }): string {
  gitExec(["init", "-q", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  // `vendor/*/build/` is the build OUTPUT, gitignored the way a real project
  // gitignores one — so preparation with lifecycle scripts in the path still
  // leaves the reviewed tree porcelain-clean.
  writeFileSync(join(projectDir, ".gitignore"), "node_modules/\nvendor/*/build/\n");
  gitExec(["add", "-A"], projectDir);
  gitExec(["commit", "-m", "initial commit"], projectDir);
  const sinceSha = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  const depDir = join(projectDir, "vendor", NATIVE_DEP);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    join(depDir, "package.json"),
    JSON.stringify({
      name: NATIVE_DEP, version: "1.0.0", type: "module", main: "index.js",
      scripts: { install: "node ./build.mjs" },
    }),
  );
  writeFileSync(
    join(depDir, "build.mjs"),
    opts.buildExit
      ? [
          `process.stderr.write("${BUILD_FAILURE}: gyp ERR! build error — no toolchain\\n");`,
          `process.exit(${opts.buildExit});`,
        ].join("\n")
      : [
          `import { mkdirSync, writeFileSync } from "node:fs";`,
          `mkdirSync(new URL("./build/", import.meta.url), { recursive: true });`,
          `writeFileSync(new URL("./build/binding.mjs", import.meta.url), "export const binding = 'built';\\n");`,
        ].join("\n"),
  );
  // STATIC: an unbuilt package fails at MODULE LOAD, exactly as
  // `Could not locate the bindings file` does.
  writeFileSync(join(depDir, "index.js"), `export { binding as name } from "./build/binding.mjs";\n`);

  // The project's OWN verification script. Its import of the dependency is what
  // makes "was this workspace prepared?" answerable from the script's exit status
  // alone; `verdict.txt` is what makes a failure AFTER that a code failure.
  writeFileSync(
    join(projectDir, "check.mjs"),
    [
      `import { readFileSync } from "node:fs";`,
      `import { name } from ${JSON.stringify(NATIVE_DEP)};`,
      `if (name !== "built") { process.stderr.write("the binding did not load\\n"); process.exit(2); }`,
      `if (readFileSync("verdict.txt", "utf8").trim() !== "pass") {`,
      `  process.stderr.write("${CODE_FAILURE}: the project's own assertions failed\\n");`,
      `  process.exit(1);`,
      `}`,
    ].join("\n"),
  );
  writeFileSync(join(projectDir, "verdict.txt"), `${opts.verdict}\n`);
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({
      name: "fg566-native-project", version: "1.0.0", private: true, type: "module",
      dependencies: { [NATIVE_DEP]: `file:./vendor/${NATIVE_DEP}` },
      scripts: { typecheck: "node ./check.mjs", test: "node ./check.mjs" },
    }, null, 2),
  );
  // Generated WITHOUT installing: no node_modules is the premise, and
  // `--package-lock-only` runs no lifecycle script.
  execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: projectDir, stdio: "ignore" });

  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-566-host-verification-readiness.md"),
    "---\nid: FG-566\ntype: story\nstatus: active\ntitle: host-side verification readiness\n---\n\nBody.\n",
  );

  gitExec(["add", "-A"], projectDir);
  gitExec(["commit", "-m", "(FG-566) project under review"], projectDir);

  assert.equal(existsSync(join(projectDir, "node_modules")), false, "fixture precondition: the clone must have NO node_modules");
  assert.equal(existsSync(buildOutput()), false, "fixture precondition: the native binding must be UNBUILT");
  assert.equal(gitExec(["status", "--porcelain"], projectDir).trim(), "", "fixture precondition: the clone must be porcelain-clean");
  return sinceSha;
}

function buildOutput(): string {
  return join(projectDir, "vendor", NATIVE_DEP, "build", "binding.mjs");
}

type CliRun = { printed: string; invocations: InvokeArgs[]; events: Event[]; note: string };

/** Drive the REAL review-loop command end to end against projectDir. */
async function runReviewLoopCli(sinceSha: string, extraArgs: string[] = []): Promise<CliRun> {
  const invocations: InvokeArgs[] = [];
  const program = new Command();
  registerReviewLoop(program, async (args): Promise<InvokeResult> => {
    invocations.push(args);
    // A reviewer that passes and a fixer that changes nothing: whatever the loop
    // does, it is not doing it because an agent failed.
    return { runId: "run-1", taskId: "t-1", status: "complete", result: { verdict: "pass", findings: [] } };
  });

  const lines: string[] = [];
  mock.method(console, "log", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const prevExitCode = process.exitCode;
  process.exitCode = undefined as unknown as number;
  try {
    await program.parseAsync(
      ["review-loop", "FG-566", "--since", sinceSha, "--project", projectDir, "--unrouted", ...extraArgs],
      { from: "user" },
    );
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
  };
}

/** Readiness events by PREFIX — `host_readiness.*` members are compared as
 *  strings so this file names no closed-union literal. */
function readinessPayloads(events: Event[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.eventType.startsWith("host_readiness."))
    .map((e) => e.payload)
    .filter((pl): pl is Record<string, unknown> => typeof pl === "object" && pl !== null);
}

function readinessFields(events: Event[]): ({ outcome?: unknown; reason?: unknown } | undefined)[] {
  const finished = events.filter((e) => e.eventType === "review_loop.verification_finished");
  assert.ok(finished.length > 0, "the loop must emit review_loop.verification_finished");
  return finished.map((e) => (e.payload as Record<string, unknown>)["readiness"] as { outcome?: unknown; reason?: unknown } | undefined);
}

// ---------------------------------------------------------------------------
// HALF ONE — a native BUILD FAILURE during setup is a READINESS refusal.
// ---------------------------------------------------------------------------

test("FG-566 NATIVE + REVIEW LOOP — a failed native build during setup is a READINESS refusal: named reason, zero rounds, no reviewer and no fixer", async () => {
  // Pre-fix this arm was UNREACHABLE on this path twice over: there was no
  // preparation at all, and once there was, suppressed lifecycle scripts meant the
  // build never ran, so `npm ci` exited zero and the workspace was certified ready.
  const sinceSha = writeNativeProject({ buildExit: 9, verdict: "pass" });

  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "2"]);

  assert.ok(
    run.printed.split("\n").some((l) => l.includes("not closeable") && l.includes(READINESS_TOKEN)),
    `a native build failure must be reported as an environment outcome on stdout. stdout was:\n${run.printed}`,
  );
  assert.ok(
    !run.printed.includes("stop reason: verification_failed"),
    "a workspace whose bindings could not be built was never verified — that is not a verdict on the code",
  );
  assert.deepEqual(
    run.invocations.map((i) => i.agentRole), [],
    "preparation is not a review round: neither the reviewer nor the fixer may be dispatched",
  );
  assert.ok(!run.note.includes("## Round 1"), `zero rounds may be consumed. Note was:\n${run.note}`);

  const refusal = readinessPayloads(run.events).find((pl) => "reason" in pl);
  assert.ok(refusal, "the refusal must leave a durable host_readiness.* record");
  assert.equal(refusal["reason"], "setup_failed", "a build that exited non-zero failed the SETUP, and that is what it is called");
  assert.match(
    String(refusal["stderrTail"]),
    new RegExp(BUILD_FAILURE),
    "the BUILD's own output is what the operator is handed — diagnosis without an `ls node_modules`",
  );
  assert.equal(existsSync(buildOutput()), false, "the binding really was never built");
});

// ---------------------------------------------------------------------------
// HALF TWO — a GENUINE failure AFTER a successful native build is a CODE VERDICT.
// This is the half that breaks by accident, and the more dangerous one.
// ---------------------------------------------------------------------------

test("FG-566 NATIVE + REVIEW LOOP (INVERSE DEFECT) — a genuine verification failure AFTER a successful native build reaches the FIXER and consumes its round", async () => {
  // Same fixture, same lifecycle script, same install — the ONLY difference from
  // the test above is that the build succeeds and the project's own assertions
  // then fail. Making native build failures environmental must not make this
  // environmental too.
  const sinceSha = writeNativeProject({ verdict: "fail" });

  const run = await runReviewLoopCli(sinceSha, ["--max-rounds", "2"]);

  // Proof the failure came from a PREPARED workspace: the lifecycle script ran and
  // its output loaded, or `check.mjs` could not have reached its own assertions.
  assert.equal(existsSync(join(projectDir, "node_modules")), true, "precondition: preparation really installed");
  assert.equal(existsSync(buildOutput()), true, "precondition: the install lifecycle script really built the binding");

  assert.ok(
    !run.printed.includes(READINESS_TOKEN),
    `a real code failure must NEVER be laundered into an environment outcome. stdout was:\n${run.printed}`,
  );
  assert.ok(
    !run.note.includes(READINESS_TOKEN),
    `…and the durable note must not claim one either. Note was:\n${run.note}`,
  );
  assert.deepEqual(
    readinessPayloads(run.events).filter((pl) => "reason" in pl), [],
    "no readiness refusal may be emitted for a failure that happened after readiness had already returned",
  );

  // Readiness SUCCEEDED on every round — it has no say in what happened next.
  // Round 1 prepares; a later round reuses that same assertion (the workspace,
  // tree, lockfile and ABI are unchanged), which is the warm path working, not a
  // second install.
  const readiness = readinessFields(run.events);
  assert.ok(readiness.every(Boolean), "every finish event must carry the readiness field on this path too");
  assert.equal(String(readiness[0]?.outcome), "prepared", "round 1 had to make the workspace runnable");
  assert.deepEqual(
    [...new Set(readiness.map((r) => String(r?.outcome)))].filter((o) => !["prepared", "reused"].includes(o)),
    [],
    `every round's readiness must be a SUCCESS outcome; got ${JSON.stringify(readiness.map((r) => r?.outcome))}`,
  );

  // EXISTING behaviour, unchanged: the failure feeds the fixer and burns its round.
  assert.ok(
    run.invocations.some((i) => i.agentRole === "engineer"),
    `a genuine verification failure must still reach the FIXER. Dispatched: ${JSON.stringify(run.invocations.map((i) => i.agentRole))}`,
  );
  assert.ok(run.note.includes("## Round 1"), `a real failure consumes its round. Note was:\n${run.note}`);
  assert.ok(
    run.note.includes(CODE_FAILURE),
    `the reported failure must be the CODE's own output, not an environment message. Note was:\n${run.note}`,
  );
  assert.ok(
    !run.note.includes("ERR_MODULE_NOT_FOUND"),
    "the failure is the code's, not an unresolvable import — preparation had already succeeded",
  );

  // And preparation still did not move the tree it prepared, with lifecycle
  // scripts in the path.
  assert.equal(
    gitExec(["status", "--porcelain"], projectDir).trim(), "",
    "the build output is gitignored: preparation left the reviewed tree porcelain-clean",
  );
});
