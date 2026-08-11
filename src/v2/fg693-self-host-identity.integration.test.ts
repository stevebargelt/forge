// FG-693 (step 5): the GUARD CLASS — self-host dispatch refusal and the
// host-readiness refusal — decided by the ONE filesystem-identity contract.
//
// WHY THIS FILE EXISTS SEPARATELY FROM self-host-guard.test.ts. That file proves
// the predicate. AC5 says the seam is what must be tested: "calling the identity
// helper directly does not satisfy this". So every case below drives a REAL
// production entry point — invoke() for dispatch, prepareHostVerification() for
// readiness — and asserts on what those entry points DID (refused / reached the
// container / reached the install), never on compareIdentity's return value.
// _setSourceRootForTest is the sanctioned seam: it lets a test own BOTH sides of
// the comparison while the production path still derives everything else itself.
//
// THE TWO PROPERTIES UNDER TEST, and they pull in opposite directions:
//
//   1. ONE TREE, MANY SPELLINGS ⇒ the guard fires. A symlinked parent, a
//      trailing separator and a relative spelling all name the source tree, and
//      a guard that compares spellings is inert against every one of them. Inert
//      is worse than absent: FG-612 exists because agent writes landed in the
//      live source of every forge process on the host.
//
//   2. UNPROVEN IDENTITY ⇒ the guard fires TOO. The old private canonical()
//      caught realpath's failure and returned a lexically resolved path, so an
//      unresolvable path was compared as though it were a proven separate tree.
//      That is a guard deciding "safe" from a spelling nobody confirmed. Both
//      consumers here take the contract's GUARD-class bias.
//
//   ...and the control that keeps 1 and 2 from degenerating into "always refuse":
//      a genuinely separate tree — including one whose lexical path is a string
//      PREFIX of the source root — must still dispatch and still install.
//
// HOST (darwin): the alias cases below are synthetic symlinks so Linux CI carries
// the class natively. On darwin the same seams must be exercised against the
// NATIVE aliases — /var vs /private/var under the real worktree roots, and the
// npm-link spelling of the machine-wide `forge`, which is the live configuration
// this guard was written for. A green Linux run is not evidence for this ticket.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { listRuns } from "../store/runs.js";
import { invoke, type DockerExecFn } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { _resetSelfHostWarnings, _setSourceRootForTest } from "./self-host-guard.js";
import {
  prepareHostVerification,
  type HostReadinessDeps,
  type HostReadinessOutcome,
} from "./host-readiness.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let stderr: string[];
let cwdBefore: string;
const tmpDirs: string[] = [];
const ENV_KEYS = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

/** The container boundary, counted: "reached dispatch" and "refused before any
 *  container" are the same assertion read in two directions. */
function spyExec(): { exec: DockerExecFn; calls: () => number } {
  let n = 0;
  const exec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    n++;
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
  return { exec, calls: () => n };
}

function ensureRuntime(): void {
  const home = process.env["FORGE_HOME"]!;
  mkdirSync(join(home, "runtimes"), { recursive: true });
  writeFileSync(
    join(home, "runtimes", "claude.yml"),
    `name: claude
description: FG-693 test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(home);
}

/** A real, resolvable directory. realpath'd at creation so the fixture's own
 *  bookkeeping never depends on the aliasing this file is about. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function tempProject(prefix: string): string {
  const dir = tempDir(prefix);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** A workspace shaped like the thing readiness actually prepares: declares
 *  dependencies, carries a lockfile, has no node_modules — so the ONLY reason
 *  it would not reach the install is a refusal. */
function readinessWorkspace(dir: string): string {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg693-fixture", version: "1.0.0", private: true, dependencies: { "some-dep": "1.0.0" } }),
  );
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fg693-fixture", lockfileVersion: 3 }));
  return dir;
}

type SetupCall = { cmd: string; cwd: string };

/** Records what WOULD have been installed without running it, so "did readiness
 *  reach the destructive install?" is directly observable. */
function recordingDeps(calls: SetupCall[], sourceRoot: string): HostReadinessDeps {
  return {
    runSetup: (cmd, _args, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      return { ok: true, status: 0, timedOut: false, stderrTail: "" };
    },
    porcelain: () => "",
    sourceRoot,
  };
}

function prepare(workspace: string, calls: SetupCall[], sourceRoot: string): Promise<HostReadinessOutcome> {
  return prepareHostVerification(
    { workspace, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "fg693" },
    recordingDeps(calls, sourceRoot),
  );
}

function refusalOf(outcome: HostReadinessOutcome): { reason: string; message: string } {
  assert.equal(outcome.kind, "refused", `expected a refusal, got ${outcome.kind}`);
  return (outcome as { refusal: { reason: string; message: string } }).refusal;
}

/** Dispatch through the production entry point, returning the refusal message.
 *  Asserts the refusal landed BEFORE any container and before any run row —
 *  after the first agent file lands, the damage is already done. */
async function refusedDispatch(projectDir: string): Promise<string> {
  const runsBefore = listRuns().length;
  const spy = spyExec();
  let message = "";
  await assert.rejects(
    () => invoke({ agentRole: "engineer", task: "fg693", projectDir, dockerExec: spy.exec }),
    (e: Error) => {
      message = e.message;
      assert.match(e.message, /REFUSING to dispatch/);
      return true;
    },
  );
  assert.equal(spy.calls(), 0, "no container may start");
  assert.equal(listRuns().length, runsBefore, "no run row may be written");
  return message;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  cwdBefore = process.cwd();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FORGE_WORKTREES = "0";
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();
  stderr = [];
  mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  _resetSelfHostWarnings();
});

afterEach(() => {
  process.chdir(cwdBefore);
  _setSourceRootForTest(null);
  mock.restoreAll();
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── 1. ONE TREE, MANY SPELLINGS: the dispatch guard fires through invoke() ────

test("FG-693 DISPATCH — the source tree spelled through a SYMLINKED PARENT still refuses", async () => {
  // The /var → /private/var shape, built synthetically so Linux CI carries it:
  // <box>/link is a symlink to <box>/real, so <box>/link/forge and
  // <box>/real/forge are two spellings of one tree.
  const box = tempDir("fg693-symlink-");
  const real = join(box, "real");
  mkdirSync(join(real, "forge", ".git"), { recursive: true });
  symlinkSync(real, join(box, "link"));
  const root = join(real, "forge");
  const aliased = join(box, "link", "forge");
  assert.notEqual(aliased, root, "fixture: the two spellings must differ as strings");

  _setSourceRootForTest(root);

  const message = await refusedDispatch(aliased);
  assert.match(message, /FG-612/, "an overlap this guard PROVED must read as the FG-612 refusal");
  assert.doesNotMatch(message, /UNRESOLVED/, "both sides resolved — nothing here is unproven");
});

test("FG-693 DISPATCH — a TRAILING-SEPARATOR spelling of the source tree still refuses", async () => {
  const root = tempProject("fg693-trailing-");
  _setSourceRootForTest(root);

  await refusedDispatch(`${root}${sep}`);
});

test("FG-693 DISPATCH — a RELATIVE spelling of the source tree still refuses", async () => {
  const root = tempProject("fg693-relative-");
  _setSourceRootForTest(root);
  process.chdir(dirname(root));

  await refusedDispatch(basename(root));
});

// ── 2. THE CONTROL — a genuinely separate tree still dispatches ───────────────

test("FG-693 DISPATCH — a PREFIX-COLLIDING sibling is proven separate and reaches the container", async () => {
  // `<root>-scratch` startsWith `<root>`: the false positive a naive prefix
  // compare produces, and it would refuse a legitimate project forever. This is
  // also what keeps every refusal above from being satisfied by "always refuse".
  const root = tempProject("fg693-control-");
  const sibling = `${root}-scratch`;
  mkdirSync(join(sibling, ".git"), { recursive: true });
  tmpDirs.push(sibling);
  assert.ok(sibling.startsWith(root), "fixture: the sibling must collide on the string prefix");

  _setSourceRootForTest(root);

  const spy = spyExec();
  const r = await invoke({ agentRole: "engineer", task: "normal work", projectDir: sibling, dockerExec: spy.exec });

  assert.equal(r.status, "complete");
  assert.equal(spy.calls(), 1, "a proven-separate project must reach the container");
  assert.doesNotMatch(stderr.join(""), /REFUSING|live forge source/);
});

// ── 3. UNPROVEN IDENTITY: fires, and NAMES WHICH SIDE ────────────────────────

test("FG-693 DISPATCH — an UNRESOLVABLE PROJECT refuses, names the project side, and labels the spelling", async () => {
  const root = tempProject("fg693-unresolvable-project-");
  _setSourceRootForTest(root);
  const gone = join(tempDir("fg693-gone-"), "deleted-clone");

  const message = await refusedDispatch(gone);

  assert.match(message, /FG-693/, "an unproven identity is its own refusal, not an FG-612 overlap claim");
  assert.match(message, /could not be RULED OUT/);
  assert.match(message, /THE PROJECT PATH DID NOT RESOLVE/, "the operator must learn WHICH side was unproven");
  assert.doesNotMatch(message, /THE FORGE SOURCE ROOT ITSELF DID NOT RESOLVE/, "the source root resolved fine");
  assert.ok(
    message.includes(`${gone} (UNRESOLVED:`),
    `an unresolved spelling may be shown but must be LABELLED, never printed as though canonical:\n${message}`,
  );
});

test("FG-693 DISPATCH — an UNRESOLVABLE SOURCE ROOT is its own loud condition, distinct from an overlap", async () => {
  // assetRoot() can name a release tree a concurrent promote has replaced. The
  // project here is an ordinary, resolvable, unrelated checkout: the ONLY thing
  // wrong is that forge cannot locate the tree it is itself executing from.
  const box = tempDir("fg693-unresolvable-root-");
  const vanished = join(box, "release-replaced-underneath-us");
  mkdirSync(vanished, { recursive: true });
  _setSourceRootForTest(vanished);
  rmSync(vanished, { recursive: true, force: true });
  const project = tempProject("fg693-innocent-project-");

  const message = await refusedDispatch(project);

  assert.match(message, /THE FORGE SOURCE ROOT ITSELF DID NOT RESOLVE/);
  assert.match(message, /promote/, "the known way to reach this must be named");
  assert.doesNotMatch(message, /THE PROJECT PATH DID NOT RESOLVE/, "the project resolved — do not blame it");
  assert.doesNotMatch(
    message,
    /FG-612/,
    `an unproven identity must never be reported as a proven overlap:\n${message}`,
  );
});

// ── 4. READINESS — the refusal with no override, through its real entry point ─

test("FG-693 READINESS — the source root spelled through a symlink still refuses, and installs NOTHING", async () => {
  const box = tempDir("fg693-readiness-alias-");
  const real = join(box, "real");
  mkdirSync(join(real, "forge"), { recursive: true });
  symlinkSync(real, join(box, "link"));
  const root = join(real, "forge");
  const aliasedWorkspace = readinessWorkspace(join(box, "link", "forge"));

  const calls: SetupCall[] = [];
  const outcome = await prepare(aliasedWorkspace, calls, root);

  assert.equal(refusalOf(outcome).reason, "self_host_workspace");
  assert.equal(calls.length, 0, "`npm ci` here deletes the bindings this forge is running on");
});

test("FG-693 READINESS — an UNRESOLVABLE WORKSPACE refuses rather than proceeding to the install", async () => {
  const root = tempDir("fg693-readiness-root-");
  const gone = join(tempDir("fg693-readiness-gone-"), "worktree-already-reaped");

  const calls: SetupCall[] = [];
  const outcome = await prepare(gone, calls, root);

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "self_host_workspace");
  assert.match(refusal.message, /could not be PROVEN to be outside/);
  assert.match(refusal.message, /workspace path\b/, "the refusal must name which side was unproven");
  assert.ok(refusal.message.includes(`${gone} (UNRESOLVED:`), "the unresolved spelling is shown LABELLED");
  assert.equal(calls.length, 0, "an unprovable workspace must never reach the destructive install");
});

test("FG-693 READINESS — an UNRESOLVABLE SOURCE ROOT refuses, loudly, and installs NOTHING", async () => {
  const box = tempDir("fg693-readiness-vanished-");
  const vanished = join(box, "release-replaced-underneath-us");
  mkdirSync(vanished, { recursive: true });
  rmSync(vanished, { recursive: true, force: true });
  const workspace = readinessWorkspace(tempDir("fg693-readiness-ws-"));

  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace, calls, vanished);

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "self_host_workspace");
  assert.match(refusal.message, /forge source root\b/);
  assert.match(refusal.message, /moved or was replaced/, "the loud condition must read as such");
  assert.equal(calls.length, 0);
});

test("FG-693 READINESS — the control: a PROVEN-SEPARATE workspace still reaches the install", async () => {
  // Without this, every refusal above is satisfiable by refusing everything —
  // and a readiness that always refuses is the FG-566 false-red class returning.
  const root = tempDir("fg693-readiness-root-");
  const workspace = readinessWorkspace(tempDir("fg693-readiness-ok-"));

  const calls: SetupCall[] = [];
  const outcome = await prepare(workspace, calls, root);

  assert.notEqual(outcome.kind, "refused", `expected preparation to proceed: ${JSON.stringify(outcome)}`);
  assert.equal(calls.length, 1, "the proven-separate workspace must reach the install it needs");
  assert.equal(calls[0]?.cwd, workspace);
});
