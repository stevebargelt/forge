// FG-566: the PUBLICATION-path falsification suite for the shared host-side
// verification readiness contract.
//
// THE DEFECT, as observed live (run-…-dogfood-693dbc, candidate 871423232dbc):
// `createCandidateWorktree` builds a FRESH publication worktree from a base sha.
// A fresh worktree has no `node_modules` — it cannot, `node_modules` is gitignored
// and a worktree is materialized from the git tree alone. The FG-357 integration
// gate then runs the project's own `npm run test:unit` in it, dies with
// `ERR_MODULE_NOT_FOUND` before it can execute a single assertion, and the
// publisher records that as `validation_failed` → `integration_failed`. That is an
// ENVIRONMENT fault reported as a verdict on the reviewed CODE.
//
// This suite pins falsifications 1-5 of the ticket, end to end, against REAL git
// worktrees and a REAL npm project. It drives `publishIntegration` through its
// existing public surface only.
//
// WHY THE FIXTURE LOOKS LIKE THIS. The project under test is a genuine npm project
// whose `test:unit` script statically imports a bare specifier. That specifier
// resolves ONLY if dependencies were installed into the workspace, so "was this
// workspace prepared?" is answered by the gate's own exit status rather than by any
// forge-internal bookkeeping this suite is not allowed to see. Its single
// dependency is a `file:` dependency vendored INSIDE the repo, so `npm ci` succeeds
// with no network at all (~150ms) and the suite is hermetic. `node_modules` is
// gitignored, so a successful preparation leaves the candidate porcelain-clean —
// which is exactly what falsification 5 needs to be able to assert.
//
// TYPECHECK CONSTRAINT (build-fanout): this file must compile against the tree as
// it stands BEFORE the readiness primitive exists. So it imports NO symbol from
// `host-readiness.ts` / `host-readiness-store.ts`, compares new-vocabulary union
// members through `String(...)`, and finds readiness events by
// `eventType.startsWith("host_readiness.")` rather than by a literal that is not
// yet a member of the closed `EventType` union.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getPublicationAttempt } from "../store/publications.js";
import { eventsForRun } from "../store/events.js";
import { insertRun } from "../store/runs.js";
import { publishIntegration, type PublishOutcome, type ValidationResult } from "./integration-publisher.js";
import { localTargetFor, readTargetSha } from "./publication-target.js";

let prevDb: DatabaseInstance | null;
const dirsToRemove: string[] = [];

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  // Candidate worktrees first (they live under the test FORGE_HOME), then the
  // project repos — a publication worktree removed after its repo is gone would
  // only leave stale git metadata behind in a directory we are about to delete.
  for (const d of dirsToRemove.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The PublishOutcome arms that exist TODAY. A preparation refusal must be none of
// them: the plan requires a NEW arm, distinct from `validation_failed`, so that a
// readiness fault can never be read as the gate's verdict on the candidate.
// Compared as plain strings so this list needs no new-vocabulary import.
// ---------------------------------------------------------------------------
const EXISTING_PUBLISH_OUTCOMES = [
  "published",
  "merge_failed",
  "validation_failed",
  "parked",
  "refused",
  "recovery_pending",
];

/** The refusal-event payload shape the contract owes an operator. */
const REFUSAL_PAYLOAD_KEYS = ["reason", "workspace", "command", "exitStatus", "stderrTail"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const PROJECT_NAME = "fg566-fixture";

/** A vendored `file:` dependency — an installable package with no registry. */
function writeVendorDep(dir: string, dep: string): void {
  const depDir = join(dir, "vendor", dep);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "package.json"), `${JSON.stringify({ name: dep, version: "1.0.0", type: "module", main: "index.js" }, null, 2)}\n`);
  writeFileSync(join(depDir, "index.js"), `export const name = ${JSON.stringify(dep)};\n`);
}

/** A vendored dependency shaped like a NATIVE one: it ships no usable entrypoint
 *  until its `install` lifecycle script has produced `build/`. This is
 *  better-sqlite3's shape with node-gyp swapped for a script that needs no
 *  toolchain and no network — `binding.mjs` stands in for
 *  `build/Release/better_sqlite3.node`, and the STATIC import of it in index.js is
 *  what makes an unbuilt package fail at module load, exactly as
 *  `Could not locate the bindings file` does.
 *
 *  THIS IS THE FIXTURE THE SUITE WAS MISSING. Every dependency above is pure
 *  JavaScript, which is precisely why suppressed lifecycle scripts sailed through
 *  it: `npm ci` exits zero either way, and only a package that must BUILD can tell
 *  the difference between "installed" and "installed and usable".
 *
 *  `buildExit` non-zero is the native BUILD FAILURE case — a node-gyp that cannot
 *  compile. */
function writeNativeVendorDep(dir: string, dep: string, opts: { buildExit?: number } = {}): void {
  const depDir = join(dir, "vendor", dep);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    join(depDir, "package.json"),
    `${JSON.stringify(
      { name: dep, version: "1.0.0", type: "module", main: "index.js", scripts: { install: "node ./build.mjs" } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(depDir, "build.mjs"),
    opts.buildExit
      ? [
          `process.stderr.write("FG566_NATIVE_BUILD_FAILURE: gyp ERR! build error — no toolchain for ${dep}\\n");`,
          `process.exit(${opts.buildExit});`,
          ``,
        ].join("\n")
      : [
          `import { mkdirSync, writeFileSync } from "node:fs";`,
          `mkdirSync(new URL("./build/", import.meta.url), { recursive: true });`,
          `writeFileSync(new URL("./build/binding.mjs", import.meta.url), "export const binding = 'built';\\n");`,
          ``,
        ].join("\n"),
  );
  writeFileSync(join(depDir, "index.js"), `export { binding as name } from "./build/binding.mjs";\n`);
}

function packageJson(deps: string[]): string {
  return `${JSON.stringify(
    {
      name: PROJECT_NAME,
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { "test:unit": "node ./gate.mjs" },
      dependencies: Object.fromEntries(deps.map((d) => [d, `file:./vendor/${d}`])),
    },
    null,
    2,
  )}\n`;
}

/** A hand-written lockfile in exactly the shape `npm install --package-lock-only`
 *  produces for `file:` dependencies — hand-written so fixture construction never
 *  shells out to npm, and so `lockDeps` can be made deliberately INCONSISTENT with
 *  package.json to force a setup failure. */
function lockfile(deps: string[]): string {
  const packages: Record<string, unknown> = {
    "": {
      name: PROJECT_NAME,
      version: "1.0.0",
      dependencies: Object.fromEntries(deps.map((d) => [d, `file:./vendor/${d}`])),
    },
  };
  for (const d of deps) {
    packages[`node_modules/${d}`] = { resolved: `vendor/${d}`, link: true };
    packages[`vendor/${d}`] = { version: "1.0.0" };
  }
  return `${JSON.stringify({ name: PROJECT_NAME, version: "1.0.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

/** The project's `test:unit` entrypoint.
 *
 *  The bare-specifier imports are the whole mechanism: they are STATIC, so a
 *  workspace that was never prepared dies at module load with ERR_MODULE_NOT_FOUND
 *  and the log line below is never written. A log line therefore PROVES the gate
 *  executed with its dependencies resolvable, in that exact directory.
 *
 *  `verdict.txt` is the genuine-code-failure switch: it is a TRACKED file, so a
 *  task branch can commit a real, reproducible test failure that manifests only
 *  AFTER preparation succeeded (falsification 3 — the inverse defect). */
function gateScript(deps: string[], gateLog: string): string {
  const imports = deps.map((d, i) => `import { name as d${i} } from ${JSON.stringify(d)};`);
  const list = `[${deps.map((_, i) => `d${i}`).join(", ")}]`;
  return [
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";`,
    ...imports,
    `const LOG = ${JSON.stringify(gateLog)};`,
    `appendFileSync(`,
    `  LOG,`,
    `  JSON.stringify({ cwd: process.cwd(), deps: ${list}, nodeModules: existsSync("node_modules") }) + "\\n",`,
    `);`,
    `let verdict = "pass";`,
    `try {`,
    `  verdict = readFileSync("verdict.txt", "utf8").trim();`,
    `} catch {`,
    `  /* no verdict file — the gate passes */`,
    `}`,
    `if (verdict !== "pass") {`,
    `  process.stderr.write("FG566_GENUINE_TEST_FAILURE: verdict.txt says " + verdict + "\\n");`,
    `  process.exit(1);`,
    `}`,
    ``,
  ].join("\n");
}

/** THE SETUP-CONTRACT HEDGE, stated openly.
 *
 *  The ticket fixes the SETUP CONTRACT's provenance — the operator supplies the
 *  command, the workspace under test supplies only data — but the concrete
 *  `.forge/config.json` key that carries it is the readiness primitive's to name,
 *  and this suite is built in the same fanout and cannot import it. So the fixture
 *  writes EVERY plausible spelling with the SAME value, and that value is
 *  semantically identical to the `npm ci` an npm-project-with-a-lockfile would get
 *  by default. Whichever way the primitive resolves the contract — configured key
 *  or lockfile default — it resolves to the same command, so this suite pins
 *  BEHAVIOR (preparation happens before the gate, and a refusal is classified) and
 *  never a key name.
 *
 *  The command is written so it survives BOTH plausible execution shapes: run
 *  through a shell, or split on whitespace and exec'd directly. */
const SETUP_CONFIG_KEYS = [
  "verificationSetup",
  "verificationSetupCommand",
  "hostVerificationSetup",
  "hostReadinessSetup",
  "setupCommand",
  "projectSetup",
  "dependencySetup",
  "bootstrap",
  "bootstrapCommand",
];

function writeForgeConfig(dir: string, setupCommand: string): void {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  const config: Record<string, unknown> = { baseBranch: "main" };
  for (const k of SETUP_CONFIG_KEYS) config[k] = setupCommand;
  writeFileSync(join(dir, ".forge", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

type Fixture = {
  dir: string;
  /** Absolute path, OUTSIDE the repo, that every gate execution appends to. */
  gateLog: string;
  runId: string;
};

type GateRun = { cwd: string; deps: string[]; nodeModules: boolean };

type ProjectOpts = {
  /** Dependencies package.json declares and the gate imports. */
  deps?: string[];
  /** Dependencies that must BUILD during install to be importable — the native
   *  shape. Declared and imported exactly like `deps`. */
  nativeDeps?: string[];
  /** Non-zero ⇒ the native dependency's build script fails with that exit code. */
  nativeBuildExit?: number;
  /** Dependencies the LOCKFILE records. Defaults to `deps`; making it differ puts
   *  package.json and the lockfile out of sync, which is how falsification 2 forces
   *  a deterministic, offline setup failure (`npm ci` exits EUSAGE). */
  lockDeps?: string[];
  /** The operator-declared setup contract. */
  setupCommand?: string;
};

const GOOD_SETUP = "npm ci --no-audit --no-fund";

function makeProject(runId: string, opts: ProjectOpts = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "fg566-pub-"));
  dirsToRemove.push(root);
  const dir = join(root, "project");
  const gateLog = join(root, "gate-runs.jsonl");
  mkdirSync(dir, { recursive: true });

  const nativeDeps = opts.nativeDeps ?? [];
  const deps = [...(opts.deps ?? ["dep-one"]), ...nativeDeps];
  const lockDeps = opts.lockDeps ?? deps;

  // `vendor/*/build/` is the native dependency's build OUTPUT, gitignored the way
  // every real project gitignores one — so a preparation that runs lifecycle
  // scripts still leaves the candidate porcelain-clean (falsification 5).
  writeFileSync(join(dir, ".gitignore"), "node_modules/\nvendor/*/build/\n");
  for (const d of new Set([...deps, ...lockDeps])) {
    if (nativeDeps.includes(d)) writeNativeVendorDep(dir, d, { ...(opts.nativeBuildExit ? { buildExit: opts.nativeBuildExit } : {}) });
    else writeVendorDep(dir, d);
  }
  writeFileSync(join(dir, "package.json"), packageJson(deps));
  writeFileSync(join(dir, "package-lock.json"), lockfile(lockDeps));
  writeFileSync(join(dir, "gate.mjs"), gateScript(deps, gateLog));
  writeFileSync(join(dir, "verdict.txt"), "pass\n");
  // A setup contract that FAILS is expressed as a committed script rather than an
  // inline shell snippet, so it runs identically under a shell and under a direct
  // exec, and so its stderr is a stable token this suite can look for.
  writeFileSync(
    join(dir, "forge-setup-fails.mjs"),
    [
      `process.stderr.write("FG566_FORCED_SETUP_FAILURE: the project setup contract cannot be satisfied\\n");`,
      `process.exit(17);`,
      ``,
    ].join("\n"),
  );
  writeForgeConfig(dir, opts.setupCommand ?? GOOD_SETUP);

  git(dir, ["init", "-q", "-b", "main"]);
  commit(dir, "seed");

  insertRun({
    id: runId,
    workflow: "fg566",
    title: "fg566 publication readiness",
    status: "active",
    projectDir: dir,
    createdAt: new Date().toISOString(),
    metadata: {},
  });

  return { dir, gateLog, runId };
}

/** A task branch carrying an agent's committed work — the shape the publisher is
 *  handed at every call site. Branches off the CURRENT `main`, so a branch created
 *  after a previous publication fast-forwards rather than merging. */
function branchWithWork(p: Fixture, label: string, mutate: (dir: string) => void): string {
  const branch = `forge/${p.runId}/${label}`;
  git(p.dir, ["checkout", "-q", "-b", branch, "main"]);
  mutate(p.dir);
  commit(p.dir, `${label} work`);
  git(p.dir, ["checkout", "-q", "main"]);
  return branch;
}

function gateRuns(p: Fixture): GateRun[] {
  if (!existsSync(p.gateLog)) return [];
  return readFileSync(p.gateLog, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GateRun);
}

/** Candidate worktrees live under the test FORGE_HOME; reclaim them per test so a
 *  long worktree tier does not accumulate installed dependency trees. */
function trackCandidate(out: PublishOutcome): void {
  const wt = (out as { candidateWorktree?: string }).candidateWorktree;
  if (typeof wt === "string" && wt.length > 0) dirsToRemove.push(wt);
}

/** `attemptId` is present on every arm that exists today, but a preparation refusal
 *  is a NEW arm this file may not name, so its fields are read structurally. */
function attemptIdOf(out: PublishOutcome): string {
  const id = (out as { attemptId?: string }).attemptId;
  assert.equal(typeof id, "string", "every publication outcome carries its attemptId");
  return String(id);
}

/** Readiness events, found by PREFIX — `host_readiness.*` is not yet a member of
 *  the closed EventType union, and a literal that is not a member does not compile. */
function readinessRefusals(runId: string): Record<string, unknown>[] {
  return eventsForRun(runId)
    .filter((e) => e.eventType.startsWith("host_readiness."))
    .map((e) => e.payload)
    .filter((pl): pl is Record<string, unknown> => typeof pl === "object" && pl !== null)
    .filter((pl) => "reason" in pl);
}

const ok = (): ValidationResult => ({ ok: true });

const laneOpts = { pollMs: 10, log: () => {} };

// ---------------------------------------------------------------------------
// Falsification 1 — the headline defect.
// ---------------------------------------------------------------------------
test("FG-566 falsification 1: a fresh candidate worktree with NO node_modules is PREPARED and gated GREEN (today: ERR_MODULE_NOT_FOUND recorded as integration_failed)", async () => {
  const runId = "fg566-f1";
  const p = makeProject(runId);
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "agent-work.txt"), "the agent's output\n");
  });

  let depsPresentWhenAlsoValidateRan: boolean | undefined;
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: (candidateDir) => {
      depsPresentWhenAlsoValidateRan = existsSync(join(candidateDir, "node_modules"));
      return ok();
    },
  });
  trackCandidate(out);

  assert.equal(
    out.kind,
    "published",
    `a fresh candidate must be PREPARED before the gate runs, not gated against an unrunnable tree — got ${String(out.kind)}`,
  );
  if (out.kind !== "published") return;

  // The gate really executed, in the candidate worktree, with dependencies
  // resolvable. A gate that died at module load writes nothing here.
  const runs = gateRuns(p);
  assert.equal(runs.length, 1, "the integration gate ran exactly once, and it ran to completion");
  assert.equal(
    runs[0]?.cwd,
    realpathSync(out.candidateWorktree),
    "the gate ran in the per-attempt candidate worktree — preparation is bound to THAT workspace",
  );
  assert.equal(runs[0]?.nodeModules, true, "dependencies were present in the candidate when the gate ran");
  assert.equal(depsPresentWhenAlsoValidateRan, true);

  // Preparation is a PRECONDITION, established before verification — never a
  // post-hoc reinterpretation of a gate that already failed.
  assert.equal(readTargetSha(localTargetFor(p.dir)), out.publishedSha);
  assert.equal(getPublicationAttempt(out.attemptId)?.state, "published");

  // The live checkout is never touched as remediation.
  assert.equal(
    existsSync(join(p.dir, "node_modules")),
    false,
    "preparation must NEVER install into the live main checkout — only into the workspace under test",
  );
  assert.equal(git(p.dir, ["status", "--porcelain"]), "", "the publish target is clean");
});

// ---------------------------------------------------------------------------
// Falsification 2 — a preparation failure is an ENVIRONMENT outcome, and nothing
// is published.
// ---------------------------------------------------------------------------
test("FG-566 falsification 2: a preparation failure is classified environment/readiness — NOT validation_failed — and publishes NOTHING", async () => {
  const runId = "fg566-f2";
  // Both plausible setup contracts fail, deterministically and offline: the
  // configured command exits 17, and the lockfile is out of sync with package.json
  // so a default `npm ci` exits EUSAGE.
  const p = makeProject(runId, { lockDeps: [], setupCommand: "node ./forge-setup-fails.mjs" });
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "agent-work.txt"), "the agent's output\n");
  });
  const baseBefore = readTargetSha(localTargetFor(p.dir));

  let alsoValidateRan = false;
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => {
      alsoValidateRan = true;
      return ok();
    },
  });
  trackCandidate(out);

  assert.ok(
    !EXISTING_PUBLISH_OUTCOMES.includes(String(out.kind)),
    `a preparation failure needs its OWN PublishOutcome arm — reusing an existing one re-creates the ` +
      `misclassification this ticket exists to remove. Got ${String(out.kind)}.`,
  );
  assert.notEqual(
    String(out.kind),
    "validation_failed",
    "an environment fault must never be reported as the gate's verdict on the candidate",
  );

  // Nothing published, no ref movement, no evidence of a gate verdict.
  assert.equal(readTargetSha(localTargetFor(p.dir)), baseBefore, "the target ref is byte-identical");
  assert.equal(existsSync(join(p.dir, "agent-work.txt")), false, "the candidate's work is not on the target");
  assert.equal(getPublicationAttempt(attemptIdOf(out))?.publishedSha, undefined);
  assert.equal(gateRuns(p).length, 0, "the gate must NOT run against a workspace that could not be prepared");
  assert.equal(alsoValidateRan, false, "no part of the validation set runs after a readiness refusal");

  // The refusal is DURABLE and ACTIONABLE — the shared evidence half of the contract.
  const refusals = readinessRefusals(runId);
  assert.equal(refusals.length, 1, "readiness stops ONCE, with one classified refusal event");
  const payload = refusals[0] ?? {};
  for (const key of REFUSAL_PAYLOAD_KEYS) {
    assert.ok(key in payload, `the refusal payload must carry \`${key}\` — got keys ${JSON.stringify(Object.keys(payload))}`);
  }
  assert.ok(String(payload["reason"]).length > 0, "the refusal names a reason from the shared vocabulary");
  assert.match(String(payload["workspace"]), /publications/, "the refusal names the exact workspace it refused for");
  assert.ok(String(payload["command"]).length > 0, "the refusal names the setup command it ran");
  assert.ok(String(payload["stderrTail"]).length > 0, "the refusal carries the failure's stderr — diagnosis without an `ls`");
});

// ---------------------------------------------------------------------------
// Falsification 3 — THE INVERSE DEFECT, and the more dangerous one.
// ---------------------------------------------------------------------------
test("FG-566 falsification 3 (INVERSE DEFECT): a GENUINE test failure after a SUCCESSFUL preparation is still an integration failure — never laundered into an infrastructure outcome", async () => {
  const runId = "fg566-f3";
  const p = makeProject(runId);
  // A real, reproducible code failure: the task branch commits a tracked file that
  // makes the project's own test:unit exit non-zero. It can only manifest AFTER
  // preparation succeeded — an unprepared workspace never gets that far.
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "verdict.txt"), "fail\n");
  });
  const baseBefore = readTargetSha(localTargetFor(p.dir));

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => {
      assert.fail("the extra validation set must not run once the integration gate has failed");
    },
  });
  trackCandidate(out);

  assert.equal(out.kind, "validation_failed", "a real code failure keeps EXISTING behavior");
  if (out.kind !== "validation_failed") return;
  assert.match(out.error, /FG566_GENUINE_TEST_FAILURE/, "the gate's own failure output is what is reported");
  assert.doesNotMatch(
    out.error,
    /ERR_MODULE_NOT_FOUND/,
    "the failure is the code's, not the environment's — preparation had already succeeded",
  );

  // Proof the failure came from a PREPARED workspace: the gate ran to completion.
  const runs = gateRuns(p);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.nodeModules, true, "the gate that failed was running against a prepared workspace");

  assert.equal(readinessRefusals(runId).length, 0, "a code failure must NOT emit a readiness refusal");
  assert.equal(readTargetSha(localTargetFor(p.dir)), baseBefore, "a failed gate publishes nothing");
  assert.equal(getPublicationAttempt(out.attemptId)?.state, "failed");
});

// ---------------------------------------------------------------------------
// Falsification 4 — readiness binding. Never inherited by a different candidate.
// ---------------------------------------------------------------------------
test("FG-566 falsification 4 (candidate + lockfile fidelity): readiness prepared for one candidate is NOT accepted for another, and a CHANGED LOCKFILE forces re-preparation", async () => {
  const runId = "fg566-f4a";
  const p = makeProject(runId, { deps: ["dep-one"] });

  const branchA = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "a.txt"), "a\n");
  });
  const outA = await publishIntegration({
    runId,
    taskId: "task-a",
    projectDir: p.dir,
    sources: [{ branch: branchA, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => ok(),
  });
  trackCandidate(outA);
  assert.equal(outA.kind, "published", `the first candidate must be prepared and gated — got ${String(outA.kind)}`);

  // A SECOND candidate, on the SAME project and the SAME runtime, whose LOCKFILE
  // differs: it declares (and its gate imports) a second dependency. Readiness
  // inherited from candidate A — keyed on the project rather than on {workspace,
  // tree identity, lockfile digest, runtime ABI} — would leave dep-two missing and
  // this gate would die exactly the way the pre-fix path does.
  const branchB = branchWithWork(p, "task-b", (dir) => {
    writeVendorDep(dir, "dep-two");
    writeFileSync(join(dir, "package.json"), packageJson(["dep-one", "dep-two"]));
    writeFileSync(join(dir, "package-lock.json"), lockfile(["dep-one", "dep-two"]));
    writeFileSync(join(dir, "gate.mjs"), gateScript(["dep-one", "dep-two"], p.gateLog));
  });
  const outB = await publishIntegration({
    runId,
    taskId: "task-b",
    projectDir: p.dir,
    sources: [{ branch: branchB, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => ok(),
  });
  trackCandidate(outB);
  assert.equal(
    outB.kind,
    "published",
    `a changed lockfile must force RE-preparation of the new candidate — got ${String(outB.kind)}`,
  );

  const runs = gateRuns(p);
  assert.equal(runs.length, 2, "each candidate was gated once");
  assert.notEqual(runs[0]?.cwd, runs[1]?.cwd, "each candidate is its own workspace — a distinct readiness binding");
  assert.deepEqual(runs[0]?.deps, ["dep-one"]);
  assert.deepEqual(
    runs[1]?.deps,
    ["dep-one", "dep-two"],
    "the second candidate's CHANGED lockfile was installed — readiness was not inherited from the first",
  );
  assert.ok(runs.every((r) => r.nodeModules));
});

test("FG-566 falsification 4 (moved base): an AD-1 rebuild gets a FRESH worktree and is PREPARED afresh — readiness never crosses a rebuild", async () => {
  const runId = "fg566-f4b";
  const p = makeProject(runId);
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "agent-work.txt"), "the agent's output\n");
  });

  const validated: string[] = [];
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: (_dir, candidateSha) => {
      validated.push(candidateSha);
      if (validated.length === 1) {
        // An external writer lands on the target while we validate: the base moves,
        // and AD-1 rebuilds onto it in a BRAND NEW `-r1` worktree.
        writeFileSync(join(p.dir, "external.txt"), "someone else\n");
        commit(p.dir, "external");
      }
      return ok();
    },
  });
  trackCandidate(out);

  assert.equal(out.kind, "published", `the rebuilt candidate must be prepared and gated — got ${String(out.kind)}`);
  if (out.kind !== "published") return;
  assert.equal(out.rebuilds, 1, "precondition: the base really moved and AD-1 rebuilt once");

  const runs = gateRuns(p);
  assert.equal(runs.length, 2, "the gate re-ran against the rebuilt candidate");
  assert.notEqual(runs[0]?.cwd, runs[1]?.cwd, "the rebuild ran in a FRESH worktree path");
  assert.match(String(runs[1]?.cwd), /-r1$/, "AD-4: the rebuild's worktree identity is distinct from r0's");
  assert.ok(
    runs.every((r) => r.nodeModules),
    "BOTH the original candidate and the rebuild were prepared — a rebuild cannot inherit r0's readiness",
  );
  assert.equal(out.publishedSha, validated[1], "what published is the SECOND, re-validated candidate");
});

// ---------------------------------------------------------------------------
// Falsification 5 — preparation must not move the tree it prepares.
// ---------------------------------------------------------------------------
test("FG-566 falsification 5: with preparation in the path, the GATED tree and the PUBLISHED tree are byte-for-byte identical (FG-621 AC 6)", async () => {
  const runId = "fg566-f5";
  const p = makeProject(runId);
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "agent-work.txt"), "the agent's output\n");
  });

  let gatedTree: string | undefined;
  let gatedHead: string | undefined;
  let gatedPorcelain: string | undefined;
  let depsPresent: boolean | undefined;
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    // Runs AFTER the integration gate, so it observes the candidate in exactly the
    // state preparation + the gate left it in.
    alsoValidate: (candidateDir) => {
      depsPresent = existsSync(join(candidateDir, "node_modules"));
      gatedHead = git(candidateDir, ["rev-parse", "HEAD"]);
      gatedTree = git(candidateDir, ["rev-parse", "HEAD^{tree}"]);
      gatedPorcelain = git(candidateDir, ["status", "--porcelain"]);
      return ok();
    },
  });
  trackCandidate(out);

  assert.equal(out.kind, "published", `preparation must be IN the path for this to mean anything — got ${String(out.kind)}`);
  if (out.kind !== "published") return;

  assert.equal(depsPresent, true, "precondition: preparation really did install into the candidate");
  assert.equal(
    gatedHead,
    out.candidateSha,
    "preparation did not move the candidate's HEAD — it is not allowed to commit, amend, or rebase",
  );
  assert.equal(
    gatedPorcelain,
    "",
    "preparation left the candidate PORCELAIN-CLEAN — no installed artifact and no rewritten lockfile enters the tree",
  );

  // The tree that passed the gate is the tree that published, byte for byte.
  assert.equal(out.publishedSha, out.candidateSha, "AD-6: publishedSha === candidateSha");
  assert.equal(git(p.dir, ["rev-parse", `${out.publishedSha}^{tree}`]), gatedTree, "gated tree === published tree");
  assert.equal(readTargetSha(localTargetFor(p.dir)), out.publishedSha);

  // And no dependency artifact ever entered the published commit.
  const tracked = git(p.dir, ["ls-tree", "-r", "--name-only", out.publishedSha]).split("\n");
  assert.ok(
    !tracked.some((f) => f.startsWith("node_modules/")),
    "dependencies must NOT alter the candidate Git tree or the published commit",
  );
  assert.equal(git(p.dir, ["status", "--porcelain"]), "", "the publish target's working tree is clean after publication");
});

// ---------------------------------------------------------------------------
// Falsifications 7-9 — THE NATIVE DEPENDENCY. Everything above is pure
// JavaScript, and that is exactly why suppressed install lifecycle scripts
// shipped: `npm ci` exits zero with or without them, so a JS-only fixture cannot
// tell "installed" from "installed and usable". Only a package that must BUILD
// can.
//
// THE LIVE FAILURE, reproduced: a candidate worktree prepared by the pre-fix code
// contained `node_modules/better-sqlite3/` with `binding.gyp`, `deps`, `lib`,
// `src` — and NO `build/` directory. `npm ci` reported success, readiness
// certified the workspace ready, and every DB-backed test then died on
// `Error: Could not locate the bindings file`, recorded as a verdict on the code.
// ---------------------------------------------------------------------------

test("FG-566 falsification 7 (NATIVE): a candidate whose dependency must BUILD during install is prepared and gated GREEN (pre-fix: install scripts suppressed ⇒ no build/ ⇒ the gate dies at module load)", async () => {
  const runId = "fg566-f7";
  const p = makeProject(runId, { nativeDeps: ["native-dep"] });
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "agent-work.txt"), "the agent's output\n");
  });

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => ok(),
  });
  trackCandidate(out);

  assert.equal(
    out.kind,
    "published",
    `a native dependency must be BUILT by preparation, not merely unpacked — got ${String(out.kind)}`,
  );
  if (out.kind !== "published") return;

  const runs = gateRuns(p);
  assert.equal(runs.length, 1, "the gate ran to completion — an unbuilt native package dies at module load instead");
  assert.deepEqual(
    runs[0]?.deps,
    ["dep-one", "built"],
    "the gate imported the BUILT artifact: `built` is produced only by the install lifecycle script",
  );

  // Falsification 5 still holds with lifecycle scripts in the path: the build
  // output is gitignored, so preparation did not move the tree it prepared.
  assert.equal(out.publishedSha, out.candidateSha, "the gated tree is the published tree");
  assert.equal(git(p.dir, ["status", "--porcelain"]), "", "the publish target is clean");
  assert.equal(readinessRefusals(runId).length, 0, "a successful native build is not a refusal");
});

test("FG-566 falsification 8 (NATIVE BUILD FAILURE): a failed native build during setup is a READINESS failure — nothing published, no target ref movement, and NO gate verdict", async () => {
  const runId = "fg566-f8";
  // The build script exits non-zero, the way node-gyp does on a host with no
  // toolchain. Pre-fix this was UNREACHABLE: the build never ran at all, so the
  // workspace was certified ready and the failure surfaced later as a code verdict.
  const p = makeProject(runId, { nativeDeps: ["native-dep"], nativeBuildExit: 9 });
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "agent-work.txt"), "the agent's output\n");
  });
  const baseBefore = readTargetSha(localTargetFor(p.dir));

  let alsoValidateRan = false;
  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => {
      alsoValidateRan = true;
      return ok();
    },
  });
  trackCandidate(out);

  assert.ok(
    !EXISTING_PUBLISH_OUTCOMES.includes(String(out.kind)),
    `a native build failure is an ENVIRONMENT outcome, not a verdict on the candidate — got ${String(out.kind)}`,
  );
  assert.equal(readTargetSha(localTargetFor(p.dir)), baseBefore, "the target ref is byte-identical");
  assert.equal(existsSync(join(p.dir, "agent-work.txt")), false, "nothing was published");
  assert.equal(gateRuns(p).length, 0, "the gate must not run against a workspace whose bindings could not be built");
  assert.equal(alsoValidateRan, false);

  const refusals = readinessRefusals(runId);
  assert.equal(refusals.length, 1, "readiness stops ONCE, with one classified refusal");
  const payload = refusals[0] ?? {};
  assert.equal(payload["reason"], "setup_failed", "a build that exited non-zero failed the SETUP, and that is what it is called");
  assert.match(
    String(payload["stderrTail"]),
    /FG566_NATIVE_BUILD_FAILURE/,
    "the build's own output is what the operator is handed — diagnosis without an `ls`",
  );
});

test("FG-566 falsification 9 (NATIVE, INVERSE DEFECT): a genuine test failure after a SUCCESSFUL native build is still a code verdict", async () => {
  const runId = "fg566-f9";
  const p = makeProject(runId, { nativeDeps: ["native-dep"] });
  const branch = branchWithWork(p, "task-a", (dir) => {
    writeFileSync(join(dir, "verdict.txt"), "fail\n");
  });
  const baseBefore = readTargetSha(localTargetFor(p.dir));

  const out = await publishIntegration({
    runId,
    taskId: "task-build-1",
    projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => ok(),
  });
  trackCandidate(out);

  // The half that gets broken by accident: making native build failures
  // environmental must not make ANY failure environmental.
  assert.equal(out.kind, "validation_failed", `a real code failure keeps EXISTING behavior — got ${String(out.kind)}`);
  if (out.kind !== "validation_failed") return;
  assert.match(out.error, /FG566_GENUINE_TEST_FAILURE/);
  assert.equal(readinessRefusals(runId).length, 0, "a code failure must NOT emit a readiness refusal");

  const runs = gateRuns(p);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.deps, ["dep-one", "built"], "the gate that failed was running against a BUILT workspace");
  assert.equal(readTargetSha(localTargetFor(p.dir)), baseBefore, "a failed gate publishes nothing");
});
