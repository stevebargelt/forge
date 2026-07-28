// FG-566 (ACs 13-18) — the readiness contract at its REAL EXECUTION SINK.
//
// The contract suite (fg566-host-readiness-contract.test.ts) proves what the
// PARSER decides by injecting `runSetup` and reading back the argv it was handed.
// That is the right shape for grammar tests, and it is also why every claim below
// is still open there: an injected `runSetup` can never show that no shell runs,
// that the reduced env is what a child actually receives, or that a multi-step
// contract is bounded as a whole — because nothing was ever executed.
//
// So this file removes the injection. `runSetup` is the module's own
// `defaultRunSetup` (execFileSync) in every test here, and every claim is read
// off a REAL child process or a REAL `npm ci`:
//
//   NO SHELL          — argv elements containing `$HOME`, a backtick, `;`, `&&`,
//                       `|`, `*` and a quote arrive at the child BYTE-IDENTICAL.
//                       A `sh -c` (or `shell: true`) anywhere on this path expands
//                       or re-splits at least one of them, so this is a structural
//                       assertion about the sink, not a re-reading of a comment.
//   SETUP ENV         — the child's environment is the ALLOWLIST and nothing else,
//                       with decoys planted in process.env. Catches a future
//                       `...process.env` even if the specific keys asserted today
//                       change.
//   SETUP CEILING     — the ceiling bounds the WHOLE contract. A per-step ceiling
//                       lets an N-step contract outrun readinessSpanLeaseMs(); the
//                       three markers below tell the two readings apart without a
//                       wall-clock assertion.
//   PROVENANCE        — a hostile `<workspace>/.forge/config.json` still selects
//                       nothing, proven by what the HOST actually executed.
//   LIFECYCLE + NATIVE— a real `npm ci` really does build a native-shaped
//                       dependency's bindings, and the built module really loads.
//   FIXTURE HONESTY   — the same fixture under PRE-FIX behaviour
//                       (`npm_config_ignore_scripts`): `npm ci` exits ZERO, no
//                       `build/` is produced, and the import dies at module load.
//                       That is the fixture failing for the STATED reason rather
//                       than passing on some unrelated short-circuit.
//   HERMETIC          — the same preparation succeeds against an unroutable
//                       registry, so nothing here touches the network, and the
//                       build step is plain `node`, so nothing needs a toolchain.
//   KEYSPACE          — a real prepare writes host-readiness/ and never FG-376's
//                       dependency-cache.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { hostConfigPath } from "../util/paths.js";
import { dependencyCacheDir } from "./dependency-provisioning.js";
import { prepareHostVerification, type HostReadinessDeps, type HostReadinessOutcome } from "./host-readiness.js";
import { readReadinessRecord, readinessRecordPath } from "./host-readiness-store.js";

let prevDb: DatabaseInstance | null;
const dirs: string[] = [];
const files: string[] = [];

const ENV_KEYS = [
  "FORGE_HOST_VERIFICATION_SETUP",
  "FORGE_HOST_READINESS_REQUIRE_ABI",
  "FORGE_HOST_READINESS_SETUP_TIMEOUT_MS",
  "ANTHROPIC_API_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "FG566_DECOY",
  "npm_config_registry",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(hostConfigPath(), { force: true });
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(hostConfigPath(), { force: true });
  for (const f of files.splice(0)) rmSync(f, { force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A path OUTSIDE every workspace. A marker written inside one would also trip
 *  the dirtied-by-setup refusal and conflate two independent facts. */
function outsidePath(name: string): string {
  const p = join(tmpdir(), `fg566-exec-${name}-${process.pid}-${files.length}`);
  files.push(p);
  return p;
}

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fg566-${prefix}-`)));
  dirs.push(dir);
  return dir;
}

/** The minimum shape readiness will actually prepare: declares dependencies, has
 *  a lockfile, has no node_modules. `hostileSetup` writes the file the PRE-FIX
 *  code read the setup command out of — the tree under review's OWN config. */
function bareWorkspace(opts: { hostileSetup?: unknown } = {}): string {
  const dir = scratch("ws");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fg566-exec-fixture", version: "1.0.0", private: true, dependencies: { "some-dep": "1.0.0" } }),
  );
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fg566-exec-fixture", lockfileVersion: 3 }));
  if (opts.hostileSetup !== undefined) {
    mkdirSync(join(dir, ".forge"), { recursive: true });
    writeFileSync(join(dir, ".forge", "config.json"), JSON.stringify({ hostVerificationSetup: opts.hostileSetup }));
  }
  return dir;
}

/** No `runSetup` — every test in this file goes through the module's own
 *  execFileSync. `sourceRoot` is a directory nothing is under, so the self-host
 *  guard (correctly evaluated first) does not preempt what is being measured. */
function prepare(workspace: string, deps: HostReadinessDeps = {}): Promise<HostReadinessOutcome> {
  return prepareHostVerification(
    { workspace, treeSha: "deadbeef", coveredCommandSet: ["npm run test:unit"], label: "exec-test" },
    { sourceRoot: join(tmpdir(), "fg566-not-the-forge-root"), porcelain: () => "", ...deps },
  );
}

function refusalOf(outcome: HostReadinessOutcome): { reason: string; message: string; stderrTail: string } {
  assert.equal(outcome.kind, "refused", `expected a refusal, got ${outcome.kind}`);
  return (outcome as { refusal: { reason: string; message: string; stderrTail: string } }).refusal;
}

// ---------------------------------------------------------------------------
// NO SHELL — asserted at the sink, not read off a comment.
// ---------------------------------------------------------------------------

test("FG-566 REAL SINK — argv reaches the setup child BYTE-IDENTICAL: no shell expands, globs or re-splits any element", async () => {
  const argvDump = outsidePath("argv");
  // Every element here means something to a shell and nothing to execFile.
  // `$HOME` would expand, the backtick and `$( )` would substitute, `*` would
  // glob, `;`/`&&`/`|` would terminate the command, and the quote characters
  // would be stripped. Under execFile all seven arrive verbatim.
  const hostile = ["$HOME", "`id`", "$(id)", "a * b", "one;two", "x && y", "p | q", `"quoted"`, "'single'"];
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([
    ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(1)))`, ...hostile],
  ]);

  const outcome = await prepare(bareWorkspace());

  assert.equal(outcome.kind, "ready", "precondition: the contract must have been executed at all");
  assert.ok(existsSync(argvDump), "the setup child really ran");
  assert.deepEqual(
    JSON.parse(readFileSync(argvDump, "utf8")) as string[],
    hostile,
    "every argv element must arrive verbatim — any difference means a shell (or a re-split) is on this path",
  );
});

test("FG-566 REAL SINK — a directory that only a GLOB could name is never reached: the setup child sees the literal `*`", async () => {
  // The complement of the test above, stated as a consequence rather than a
  // string comparison: a shell would have expanded `*` against the cwd into the
  // fixture's real filenames, so the child would see MORE than one argument.
  const argvDump = outsidePath("glob");
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([
    ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(1)))`, "*"],
  ]);

  const ws = bareWorkspace();
  const outcome = await prepare(ws);

  assert.equal(outcome.kind, "ready");
  assert.deepEqual(JSON.parse(readFileSync(argvDump, "utf8")) as string[], ["*"], "the glob was never expanded");
});

// ---------------------------------------------------------------------------
// SETUP ENV — the allowlist, and NOTHING outside it.
// ---------------------------------------------------------------------------

test("FG-566 REAL SINK — the setup child's environment contains NOTHING outside the allowlist, with decoys planted in process.env", async () => {
  // A key-by-key assertion would keep passing if `...process.env` came back and
  // only the specific keys asserted today were deleted. This asserts the
  // COMPLEMENT: whatever the child received, every key of it is either forge's
  // three explicit settings or a member of SETUP_ENV_PASSTHROUGH.
  const allowed = new Set([
    "PATH", "npm_config_audit", "npm_config_fund",
    "HOME", "TMPDIR", "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
    "npm_config_registry", "npm_config_cache", "NPM_CONFIG_USERCONFIG",
  ]);
  process.env["ANTHROPIC_API_KEY"] = "sk-must-never-reach-a-setup-child";
  process.env["AWS_SESSION_TOKEN"] = "must-never-reach-a-setup-child";
  process.env["GITHUB_TOKEN"] = "must-never-reach-a-setup-child";
  process.env["FG566_DECOY"] = "must-never-reach-a-setup-child";

  const envDump = outsidePath("env");
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([
    ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env))`],
  ]);

  const outcome = await prepare(bareWorkspace());
  assert.equal(outcome.kind, "ready");

  const childEnv = JSON.parse(readFileSync(envDump, "utf8")) as Record<string, string>;
  // Node itself injects nothing into a child's env; anything here that is not on
  // the allowlist came from forge's process environment.
  const leaked = Object.keys(childEnv).filter((k) => !allowed.has(k));
  assert.deepEqual(leaked, [], `the setup child received keys outside the allowlist: ${leaked.join(", ")}`);

  // …and the allowlist is genuinely populated, so the assertion above is not
  // passing because the env is empty.
  assert.equal(childEnv["HOME"], process.env["HOME"]);
  assert.equal(childEnv["npm_config_audit"], "false");
  assert.equal(childEnv["npm_config_fund"], "false");
  // LIFECYCLE SCRIPTS RUN: the suppression the reopen dropped is not reinstated
  // by any spelling, observed at the child rather than at the parent's env object.
  for (const spelling of ["npm_config_ignore_scripts", "NPM_CONFIG_IGNORE_SCRIPTS", "npm_config_foreground_scripts"]) {
    assert.equal(childEnv[spelling], undefined, `${spelling} must not be set on the setup child`);
  }
});

// ---------------------------------------------------------------------------
// THE SETUP CEILING bounds the WHOLE contract, not each step.
// ---------------------------------------------------------------------------

test("FG-566 REAL SINK — the setup ceiling bounds the WHOLE contract: a multi-step contract cannot outrun readinessSpanLeaseMs()", async () => {
  // readinessSpanLeaseMs() is composed from ONE setup ceiling plus the gate span.
  // A per-step ceiling would let an N-step contract run for N ceilings and outlive
  // the very lease that covers it — so the reading has to be falsifiable, not
  // asserted in a comment.
  //
  // Each step sleeps, then drops a marker. The two readings are distinguishable
  // by the markers alone, with no wall-clock assertion to flake on:
  //   per-step ceiling  → step 1 (1.8s < 2.6s) and step 2 (1.8s < 2.6s) both
  //                       finish, step 3 runs, ALL THREE markers exist, ready.
  //   whole-contract    → step 1 finishes, step 2 is left ~0.8s and is killed,
  //                       step 3 never runs — ONE marker, setup_timed_out.
  const m1 = outsidePath("step1");
  const m2 = outsidePath("step2");
  const m3 = outsidePath("step3");
  const sleepThenMark = (ms: number, marker: string): string[] => [
    "node", "-e", `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "1"), ${ms})`,
  ];

  process.env["FORGE_HOST_READINESS_SETUP_TIMEOUT_MS"] = "2600";
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([
    sleepThenMark(1800, m1),
    sleepThenMark(1800, m2),
    sleepThenMark(0, m3),
  ]);

  const startedAt = Date.now();
  const outcome = await prepare(bareWorkspace());
  const elapsed = Date.now() - startedAt;

  const refusal = refusalOf(outcome);
  assert.equal(refusal.reason, "setup_timed_out", "the CONTRACT exceeded the ceiling — that is a timeout, not a failure");
  assert.equal(existsSync(m1), true, "precondition: step 1 fits inside the ceiling and really ran to completion");
  assert.equal(
    existsSync(m2),
    false,
    "step 2 must be bounded by what the ceiling has LEFT, not handed a fresh one — a per-step ceiling would have let it finish",
  );
  assert.equal(existsSync(m3), false, "a timed-out step stops the sequence: nothing after it may run");
  assert.match(refusal.message, /step 2 of 3/, "the refusal names WHICH step exhausted the ceiling");
  // A loose bound only — the markers above are the real discriminator. This one
  // catches "the ceiling was never applied at all", which no marker would.
  assert.ok(elapsed < 2600 + 4000, `the whole contract must be bounded by the ceiling; took ${elapsed}ms`);
});

test("FG-566 REAL SINK — the ceiling is not over-tightened: a single step that fits the ceiling still completes", async () => {
  // The other direction of the same knob. A budget computed wrong (e.g. an
  // off-by-one that hands step 1 zero) would refuse every contract forever, which
  // is the failure mode that blocks the path rather than merely permitting too
  // much.
  const marker = outsidePath("single");
  process.env["FORGE_HOST_READINESS_SETUP_TIMEOUT_MS"] = "5000";
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([
    ["node", "-e", `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "1"), 300)`],
  ]);

  const outcome = await prepare(bareWorkspace());

  assert.equal(outcome.kind, "ready", "a step comfortably inside the ceiling must not be refused");
  assert.equal(existsSync(marker), true);
});

// ---------------------------------------------------------------------------
// PROVENANCE — proven by what the HOST executed, not by what the parser returned.
// ---------------------------------------------------------------------------

test("FG-566 REAL SINK — a hostile `<workspace>/.forge/config.json` selects NOTHING: the host executed the lockfile-derived npm ci, and the hostile binary never ran", async () => {
  // The pre-fix defect end to end: the setup command was read from
  // `<configDir>/.forge/config.json` and both consumers passed a project
  // directory, so the tree under review chose a binary forge ran under its own
  // host identity. Here the workspace names a command that would leave an
  // unmistakable mark on the host — and the mark is what is asserted, not the
  // parser's return value.
  const pwned = outsidePath("pwned");
  const ws = bareWorkspace({
    hostileSetup: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(pwned)}, "pwned")`],
  });

  // `npm ci` against a lockfile with no packages section: it is what the
  // provenance rule allows, and whether it succeeds is beside the point — what
  // matters is which argv the host ran.
  const outcome = await prepare(ws);

  assert.equal(existsSync(pwned), false, "the workspace under test must never be able to select the host-executed command");
  const command = outcome.kind === "refused"
    ? (outcome as { refusal: { command: string } }).refusal.command
    : (outcome as { evidence: { setupCommand: string } }).evidence.setupCommand;
  assert.equal(command, "npm ci", "the fixed lockfile-derived argv is what ran — the reviewed tree can only ENABLE it, never choose it");
});

test("FG-566 REAL SINK — a hostile workspace config cannot even force an AMBIGUOUS refusal: a value that WOULD be refused from a trusted source is not read at all", async () => {
  // The weaker influence a workspace might still hope for: not choosing the
  // command, but DENYING verification by planting a value forge would refuse.
  // `npm ci && curl evil.example` is refused `ambiguous_setup_contract` when an
  // OPERATOR declares it (the contract suite pins that). Declared by the tree
  // under review it must do nothing at all — the workspace prepares green.
  const hostile = writeNativeProject();
  mkdirSync(join(hostile, ".forge"), { recursive: true });
  writeFileSync(join(hostile, ".forge", "config.json"), JSON.stringify({ hostVerificationSetup: "npm ci && curl evil.example" }));
  const clean = writeNativeProject();

  const withHostile = await prepare(hostile);
  const without = await prepare(clean);

  assert.equal(withHostile.kind, "ready", "the hostile config must not be able to deny verification either");
  assert.equal(withHostile.kind, without.kind, "the hostile config changed nothing about the outcome");
  assert.equal(
    (withHostile as { evidence: { setupCommand: string } }).evidence.setupCommand,
    (without as { evidence: { setupCommand: string } }).evidence.setupCommand,
    "…and nothing about which argv ran",
  );
});

// ---------------------------------------------------------------------------
// THE NATIVE FIXTURE — built for real, and honest about what it proves.
// ---------------------------------------------------------------------------

const NATIVE_DEP = "fg566-native-dep";

/** The publication suite's `writeNativeVendorDep`, rebuilt here so its two claims
 *  can be measured directly rather than inferred from a green publish:
 *  a `file:` package that ships NO usable entrypoint until its `install`
 *  lifecycle script has produced `build/binding.mjs`, which its index STATICALLY
 *  imports. `install` is plain `node` — no node-gyp, no python, no compiler — and
 *  the package is vendored inside the repo, so nothing here touches a registry.
 *  That is what makes it hermetic while still being a genuine "installed" vs
 *  "installed and usable" discriminator. */
function writeNativeProject(opts: { buildExit?: number } = {}): string {
  const dir = scratch("native");
  const depDir = join(dir, "vendor", NATIVE_DEP);
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
          `process.stderr.write("FG566_NATIVE_BUILD_FAILURE: gyp ERR! build error — no toolchain\\n");`,
          `process.exit(${opts.buildExit});`,
        ].join("\n")
      : [
          `import { mkdirSync, writeFileSync } from "node:fs";`,
          `mkdirSync(new URL("./build/", import.meta.url), { recursive: true });`,
          `writeFileSync(new URL("./build/binding.mjs", import.meta.url), "export const binding = 'built';\\n");`,
        ].join("\n"),
  );
  // STATIC, so an unbuilt package fails at MODULE LOAD — the fixture's stand-in
  // for better-sqlite3's `Could not locate the bindings file`.
  writeFileSync(join(depDir, "index.js"), `export { binding as name } from "./build/binding.mjs";\n`);

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fg566-native-project", version: "1.0.0", private: true, type: "module",
      dependencies: { [NATIVE_DEP]: `file:./vendor/${NATIVE_DEP}` },
    }, null, 2),
  );
  writeFileSync(join(dir, "loader.mjs"), `import { name } from ${JSON.stringify(NATIVE_DEP)};\nprocess.stdout.write(name);\n`);
  // Generated WITHOUT installing — node_modules must be absent, which is the whole
  // premise. `--package-lock-only` runs no lifecycle script.
  execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: dir, stdio: "ignore" });
  assert.equal(existsSync(join(dir, "node_modules")), false, "fixture precondition: no node_modules");
  return dir;
}

/** Load the dependency the way a real test suite would — through its package
 *  entrypoint, statically. Returns the stdout, or the failure output. */
function loadDependency(dir: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync(process.execPath, ["./loader.mjs"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n") };
  }
}

test("FG-566 NATIVE (real npm ci) — preparation BUILDS the native dependency's bindings, and the built module actually loads", async () => {
  const dir = writeNativeProject();

  const outcome = await prepare(dir);

  assert.equal(outcome.kind, "ready", `a native dependency must be prepared, not merely unpacked — got ${outcome.kind}`);
  assert.equal(
    existsSync(join(dir, "vendor", NATIVE_DEP, "build", "binding.mjs")),
    true,
    "the install lifecycle script ran: `build/` exists, which is the only thing that distinguishes installed from usable",
  );
  const loaded = loadDependency(dir);
  assert.equal(loaded.ok, true, `the prepared workspace must be able to LOAD its dependency; got:\n${loaded.output}`);
  assert.equal(loaded.output, "built");
  assert.equal(readReadinessRecord(dir)?.state, "ready", "the assertion is durable");
});

test("FG-566 NATIVE FIXTURE HONESTY — under PRE-FIX suppression the identical fixture is certified installed and is UNLOADABLE", async () => {
  // The claim the fixture exists to support, measured rather than asserted:
  // suppressing install lifecycle scripts does NOT make `npm ci` fail. It exits
  // ZERO over a package with no `build/` — so readiness had nothing to object to,
  // and the failure surfaced later as a verdict on the code. This is the live
  // better-sqlite3 shape, reproduced with no toolchain.
  const dir = writeNativeProject();

  execFileSync("npm", ["ci"], {
    cwd: dir,
    // The ONE difference from the test above. Everything else — fixture, command,
    // cwd — is identical, so a divergence can only come from this.
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    stdio: "ignore",
  });

  assert.equal(existsSync(join(dir, "node_modules")), true, "PRE-FIX: `npm ci` reported SUCCESS and populated node_modules");
  assert.equal(
    existsSync(join(dir, "vendor", NATIVE_DEP, "build", "binding.mjs")),
    false,
    "PRE-FIX: the bindings were never built — exactly the `node_modules/better-sqlite3/` with no `build/` the live instance had",
  );
  const loaded = loadDependency(dir);
  assert.equal(loaded.ok, false, "PRE-FIX: the dependency cannot load, so every test importing it dies before asserting anything");
  assert.match(
    loaded.output,
    /ERR_MODULE_NOT_FOUND|Cannot find module/,
    `the fixture must fail for the STATED reason — an unbuilt binding at module load. Got:\n${loaded.output}`,
  );
});

test("FG-566 NATIVE FIXTURE HONESTY — a failed native BUILD is a setup failure, and its own stderr is what the operator is handed", async () => {
  const dir = writeNativeProject({ buildExit: 9 });

  const refusal = refusalOf(await prepare(dir));

  assert.equal(refusal.reason, "setup_failed", "a build that exited non-zero failed the SETUP — nothing was verified");
  assert.match(refusal.stderrTail, /FG566_NATIVE_BUILD_FAILURE/, "the build's own output is carried, not a bare colon");
  assert.match(refusal.message, /NOT a verdict on the code/);
  // And this arm is only reachable BECAUSE lifecycle scripts run: with them
  // suppressed the same fixture installs clean (the test above), so `setup_failed`
  // could never fire and the failure would arrive later, wearing a code verdict.
  assert.equal(existsSync(join(dir, "vendor", NATIVE_DEP, "build", "binding.mjs")), false);
});

test("FG-566 NATIVE FIXTURE HERMETIC — the same preparation succeeds against an UNROUTABLE registry: no network, no toolchain", async () => {
  // If any step reached a registry, this registry would fail it. `npm_config_registry`
  // is on the setup allowlist, so the value set here really is what the child uses.
  process.env["npm_config_registry"] = "http://127.0.0.1:1/";
  const dir = writeNativeProject();

  const outcome = await prepare(dir);

  assert.equal(outcome.kind, "ready", "a vendored `file:` dependency needs no registry at all");
  assert.equal(existsSync(join(dir, "vendor", NATIVE_DEP, "build", "binding.mjs")), true);
  // No toolchain either: the build step is plain node. A fixture that shelled out
  // to node-gyp/make/cc would be measuring the container image, not the contract.
  const depPkg = JSON.parse(readFileSync(join(dir, "vendor", NATIVE_DEP, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(depPkg.scripts["install"], "node ./build.mjs");
  assert.doesNotMatch(JSON.stringify(depPkg.scripts), /gyp|make|cc |gcc|clang|python/, "the fixture must need no compiler toolchain");
});

test("FG-566 NATIVE FIXTURE HONESTY — the publication suite's own native helper still declares an install script and STATICALLY imports its build output", () => {
  // A real `npm ci` above proves THIS file's fixture is honest. The publication
  // worktree suite carries its own copy, and the two properties that make it a
  // discriminator are exactly the two a later edit would quietly drop — a
  // lifecycle script to run, and a STATIC import that fails at module load when it
  // did not. Weakening either turns falsifications 7-9 green for the wrong reason.
  const source = readFileSync(join(import.meta.dirname, "fg566-publication-readiness.worktree.test.ts"), "utf8");
  const helper = source.slice(source.indexOf("function writeNativeVendorDep"));
  assert.ok(helper.length > 0, "the publication suite must still carry a native fixture helper");
  const body = helper.slice(0, helper.indexOf("\nfunction "));
  assert.match(body, /scripts:\s*\{\s*install:/, "the native fixture must still install via a LIFECYCLE SCRIPT");
  assert.match(body, /export \{ binding as name \} from "\.\/build\/binding\.mjs"/, "the entrypoint must still STATICALLY import the build output");
  assert.match(body, /process\.exit\(\$\{opts\.buildExit\}\)/, "the build-failure arm must still exit non-zero");
});

// ---------------------------------------------------------------------------
// KEYSPACE — measured across a REAL install, not an injected one.
// ---------------------------------------------------------------------------

test("FG-566 KEYSPACE (real install) — a real prepare writes host-readiness/ ONLY and never FG-376's dependency-cache", async () => {
  const dir = writeNativeProject();

  assert.equal(await prepare(dir).then((o) => o.kind), "ready");
  assert.ok(existsSync(readinessRecordPath(dir)), "the host-side assertion is durable in its own keyspace");
  assert.equal(
    existsSync(dependencyCacheDir()),
    false,
    "FG-376's container keyspace must never be written by the host readiness path — a marker here makes runNext skip container provisioning against an empty volume",
  );
});
