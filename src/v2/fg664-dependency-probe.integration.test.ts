// FG-664: THE SHIPPED PROBE SCRIPT, EXECUTED.
//
// WHY THIS FILE EXISTS. The first cut of FG-664 shipped
// `DEPENDENCY_PROBE_SCRIPT` and never ran it: `grep -rn DEPENDENCY_PROBE_SCRIPT
// src/` returned only its definition, every test fed
// `resolveDependencyEnvironment` a hand-written one-package report, and the
// operator smoke script hand-rolled its own driver load instead of invoking
// Forge's. That is the exact defect class FG-664 exists to eliminate — a
// verification that does not exercise what ships — and it had a consequence: the
// script `require()`d every top-level package directory containing a `.node` BY
// BARE NAME and marked it unloadable when that threw. `@img/sharp-linux-arm64`,
// which this project's own provisioner installs, publishes `exports` with no "."
// entry, so a bare-name require throws for it no matter how well its artifact
// loads. The fail-closed gate therefore refused EVERY read-only dispatch on
// darwin, permanently, and nothing caught it because nothing ran the script.
//
// So these tests run the CONSTANT, unmodified, over a real fixture
// `node_modules` on this machine's real node — and the fixture deliberately
// contains a package whose `exports` map has no "." entry, so that defect cannot
// come back unobserved.
//
// TIER: integration (`npm run test:integration`). It spawns REAL node processes
// — that is the point, and it is what the unit tier's purity guard forbids.
//
// WHAT THIS TIER STILL CANNOT PROVE. This runs on the host's node and platform,
// not the agent image's, so it says nothing about whether a linux container can
// load a darwin-built artifact. That is the cross-platform half, and it is proven
// where a real kernel and a real image exist — scripts/fg664-reviewer-engine-smoke.sh,
// which since this change runs THIS script rather than a substitute of its own.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { DEPENDENCY_PROBE_SCRIPT } from "./spawn.js";
import {
  lockfileHash,
  markDependencyCacheReady,
  parseDependencyProbeOutput,
  readDependencyCacheMarker,
  resolveDependencyEnvironment,
  type DependencyProbeReport,
} from "./dependency-provisioning.js";

const require_ = createRequire(import.meta.url);

/** The nonce the forging fixture prints. Never minted by a resolution here, so
 *  its appearance anywhere is the forgery succeeding. */
const FORGED_NONCE = "ffffffffffffffffffffffffffffffff";

// The resolver's FG-376 lock and ready marker live under FORGE_HOME; redirect it
// so these cases never touch the operator's real dependency-cache state.
const savedEnv: Record<string, string | undefined> = {};
const ENV_VARS = ["FORGE_HOME", "FORGE_NO_NM_SHADOW"] as const;

beforeEach(() => {
  for (const k of ENV_VARS) savedEnv[k] = process.env[k];
  process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-fg664-probe-home-"));
  tmpDirs.push(process.env.FORGE_HOME);
  delete process.env.FORGE_NO_NM_SHADOW;
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

/** A genuinely loadable compiled artifact for THIS node: the driver this repo
 *  actually ships. Copying it (rather than synthesizing one) is what makes
 *  `loaded: true` mean the container-side mechanism works, not that the fixture
 *  was permissive. */
function realArtifact(): string {
  const root = dirname(require_.resolve("better-sqlite3/package.json"));
  const found = findNode(root, 0);
  assert.ok(found, `no compiled .node under ${root} — this tier needs a real artifact to load`);
  return found;
}

function findNode(dir: string, depth: number): string | undefined {
  if (depth > 4) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".node")) return join(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules") {
      const hit = findNode(join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg664-probe-"));
  tmpDirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function writePkg(dir: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body, null, 2) + "\n");
}

/** A fixture `node_modules` covering every shape the probe has to get right. */
function makeFixtureRoot(): string {
  const nm = join(makeTmpDir(), "node_modules");
  const artifact = realArtifact();

  // (1) An ordinary native package, requireable by bare name — the baseline.
  const driver = join(nm, "real-driver");
  writePkg(driver, { name: "real-driver", version: "1.2.3", main: "index.js" });
  writeFileSync(join(driver, "index.js"), "module.exports = {};\n");
  mkdirSync(join(driver, "build", "Release"), { recursive: true });
  copyFileSync(artifact, join(driver, "build", "Release", "real.node"));

  // (2) THE DEFECT-2 FIXTURE. `exports` byte-equivalent in shape to the published
  //     @img/sharp-linux-arm64@0.34.5: subpaths only, NO "." entry, so a bare-name
  //     `require()` throws ERR_PACKAGE_PATH_NOT_EXPORTED however well the artifact
  //     itself loads. Non-vacuity is asserted below.
  const scoped = join(nm, "@img", "fixture-linux-arm64");
  writePkg(scoped, {
    name: "@img/fixture-linux-arm64",
    version: "0.34.5",
    exports: {
      "./package.json": "./package.json",
      "./sharp.node": "./lib/sharp-linux-arm64.node",
    },
  });
  mkdirSync(join(scoped, "lib"), { recursive: true });
  copyFileSync(artifact, join(scoped, "lib", "sharp-linux-arm64.node"));

  // (3) A native package that genuinely cannot load — the fail-closed direction
  //     has to keep working, and the error has to be legible.
  const broken = join(nm, "broken-native");
  writePkg(broken, { name: "broken-native", version: "9.9.9" });
  writeFileSync(join(broken, "broken.node"), "this is not a shared object\n");

  // (4) THE DEFECT-4 FIXTURE. A native package whose entry point prints a
  //     complete, well-formed report — from an `exit` listener, so under the old
  //     in-process `require()` shape it landed AFTER the genuine one and
  //     last-line-wins preferred it. The probe must never execute this file.
  const forger = join(nm, "forger");
  writePkg(forger, { name: "forger", version: "6.6.6", main: "index.js" });
  writeFileSync(
    join(forger, "index.js"),
    `const forged = ${JSON.stringify(
      JSON.stringify({
        nonce: FORGED_NONCE,
        node: "v0.0.0-forged",
        abi: "0",
        roots: [{ path: "/project/node_modules", entries: 999, installRoot: true }],
        packages: [{ name: "forger", version: "6.6.6", loaded: true }],
      }),
    )};\n` +
      `process.stdout.write(forged + "\\n");\n` +
      `process.on("exit", () => process.stdout.write(forged + "\\n"));\n` +
      `module.exports = {};\n`,
  );
  mkdirSync(join(forger, "build"), { recursive: true });
  copyFileSync(artifact, join(forger, "build", "forger.node"));

  // (5) A pure-JS package: no artifact, so the probe never considers it at all.
  const pure = join(nm, "pure-js");
  writePkg(pure, { name: "pure-js", version: "1.0.0", main: "index.js" });
  writeFileSync(join(pure, "index.js"), "module.exports = {};\n");

  return nm;
}

/** Run the SHIPPED script, exactly as the probe container runs it. */
function runShippedProbe(root: string, nonce: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, ["-e", DEPENDENCY_PROBE_SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, FORGE_PROBE_ROOTS: root, FORGE_PROBE_INSTALL_ROOT: root, FORGE_PROBE_NONCE: nonce },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function pkg(report: DependencyProbeReport, name: string) {
  return report.packages.find((p) => p.name === name);
}

test("FG-664: the SHIPPED probe script runs, and reports a loadable artifact as loaded — including one whose package has no '.' export", () => {
  const root = makeFixtureRoot();

  // Non-vacuity for the defect-2 fixture: bare-name require really does throw for
  // it, so "loaded: true" below is the probe not asking that question — not the
  // fixture failing to reproduce the published shape.
  const byName = spawnSync(process.execPath, ["-e", 'require(process.argv[1])', "@img/fixture-linux-arm64"], {
    encoding: "utf8",
    cwd: dirname(root),
  });
  assert.notEqual(byName.status, 0, "the fixture must be UNrequireable by bare name, or it does not reproduce the defect");
  assert.match(
    byName.stderr,
    /ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main/,
    `expected the published @img/sharp-linux-arm64 failure mode; got: ${byName.stderr}`,
  );

  const nonce = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
  const run = runShippedProbe(root, nonce);
  assert.equal(run.status, 0, `the probe script must exit 0; stderr: ${run.stderr}`);

  const report = parseDependencyProbeOutput(run.stdout, nonce);
  assert.ok(report, `the shipped script must print a report this dispatch can read; stdout was: ${run.stdout}`);

  assert.equal(pkg(report, "real-driver")?.loaded, true, "an ordinary native package must load");
  assert.equal(
    pkg(report, "@img/fixture-linux-arm64")?.loaded,
    true,
    `a package that is not requireable at its root must still be LOADED — this is the regression that refused every ` +
      `read-only dispatch on darwin. Reported: ${JSON.stringify(pkg(report, "@img/fixture-linux-arm64"))}`,
  );
  assert.equal(pkg(report, "pure-js"), undefined, "a package with no compiled artifact is not a native package");

  const rootRecord = report.roots.find((r) => r.path === root);
  assert.ok(rootRecord, "the mounted root must be recorded");
  assert.equal(rootRecord.installRoot, true);
  assert.ok(rootRecord.entries > 0, "a populated root must not read as empty");
  assert.equal(report.node, process.version, "the report carries the PROBING process's own engine identity");
  assert.equal(report.abi, process.versions.modules);
});

test("FG-664: the SHIPPED probe reports an unloadable artifact as unloaded, with the real loader error", () => {
  const root = makeFixtureRoot();
  const nonce = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
  const report = parseDependencyProbeOutput(runShippedProbe(root, nonce).stdout, nonce);
  assert.ok(report);

  const broken = pkg(report, "broken-native");
  assert.equal(broken?.loaded, false, "a .node that is not a shared object must never read as loaded");
  assert.match(
    String(broken?.error),
    /ERR_DLOPEN_FAILED|invalid ELF header|not a valid|Exec format|file too short|dlopen/i,
    `the refusal has to carry the real loader error; got: ${broken?.error}`,
  );
});

test("FG-664: a dependency cannot author the report — its entry point never runs, and its output never reaches the attested stream", () => {
  const root = makeFixtureRoot();

  // Non-vacuity: the fixture really does print a complete forged report — twice,
  // the second time from an `exit` listener so it lands AFTER whatever the host
  // process wrote. Under the previous in-process `require()` shape that line was
  // the LAST readable JSON on the probe container's stdout, and last-line-wins
  // would have handed it to the resolver as the attestation.
  const executed = spawnSync(process.execPath, ["-e", "require(process.argv[1])", join(root, "forger")], {
    encoding: "utf8",
  });
  assert.equal(executed.status, 0, `the forging fixture must load; stderr: ${executed.stderr}`);
  assert.equal(
    (executed.stdout.match(new RegExp(FORGED_NONCE, "g")) ?? []).length,
    2,
    `the fixture must print its forged report on load AND at exit; stdout was: ${executed.stdout}`,
  );

  const nonce = "1234567812345678123456781234567c";
  const run = runShippedProbe(root, nonce);

  assert.ok(
    !run.stdout.includes(FORGED_NONCE),
    `nothing a probed package printed may reach the stream the host reads back; stdout was: ${run.stdout}`,
  );
  assert.ok(!run.stdout.includes("v0.0.0-forged"), "the forged report must be absent entirely");

  const jsonLines = run.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  assert.equal(jsonLines.length, 1, `exactly one report line, authored by the supervisor; got ${jsonLines.length}`);

  const report = parseDependencyProbeOutput(run.stdout, nonce);
  assert.ok(report);
  assert.equal(report.node, process.version, "the surviving report is the supervisor's, not the forgery's");
  // The forging package's ARTIFACT is real, so it is honestly reported loaded —
  // the point is that Forge concluded that from the load child's exit status, not
  // from the package's own say-so.
  assert.equal(pkg(report, "forger")?.loaded, true);
  assert.equal(pkg(report, "forger")?.version, "6.6.6", "the version came from package.json, read by the supervisor");
});

// ── the whole gate, end to end, over the shipped script ──────────────────────

function makeProbedProject(deps: Record<string, string>): { dir: string; root: string } {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg664-probe-subject", dependencies: deps }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, salt: dir }));
  const fixture = makeFixtureRoot();
  const root = join(dir, "node_modules");
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(fixture, { withFileTypes: true })) {
    copyTree(join(fixture, entry.name), join(root, entry.name));
  }
  return { dir, root };
}

function copyTree(from: string, to: string): void {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) copyTree(join(from, e), join(to, e));
  } else {
    copyFileSync(from, to);
  }
}

test("FG-664: resolveDependencyEnvironment over the SHIPPED probe is READY when the project's declared natives load", async () => {
  const { dir, root } = makeProbedProject({ "real-driver": "^1.0.0", "@img/fixture-linux-arm64": "^0.34.5" });

  const outcome = await resolveDependencyEnvironment({
    repoRoot: dir,
    image: "agent-dev-worker:fg664-probe",
    platform: "darwin",
    lockOpts: { pollMs: 1 },
    runProvisioner: async () => ({ exitCode: 0, stderrTail: "" }),
    runProbe: async (nonce) => {
      const run = runShippedProbe(root, nonce);
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderrTail: run.stderr.trim() };
    },
  });

  assert.equal(
    outcome.outcome,
    "ready",
    `the gate must pass on a tree whose declared natives load; got ${JSON.stringify(outcome)}`,
  );
  assert.ok(outcome.outcome === "ready");
  assert.equal(outcome.receipt.abi, process.versions.modules, "the receipt carries the attested ABI");
  assert.ok(
    outcome.receipt.packages.some((p) => p.name === "broken-native" && !p.loaded),
    "an undeclared package that failed to load is still recorded in the receipt — non-fatal, not unseen",
  );
});

test("FG-664: resolveDependencyEnvironment over the SHIPPED probe REFUSES driver_unloadable when a DECLARED native cannot load", async () => {
  const { dir, root } = makeProbedProject({ "broken-native": "^9.0.0" });

  const outcome = await resolveDependencyEnvironment({
    repoRoot: dir,
    image: "agent-dev-worker:fg664-probe",
    platform: "darwin",
    lockOpts: { pollMs: 1 },
    runProvisioner: async () => ({ exitCode: 0, stderrTail: "" }),
    runProbe: async (nonce) => {
      const run = runShippedProbe(root, nonce);
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderrTail: run.stderr.trim() };
    },
  });

  assert.ok(outcome.outcome === "refused", `expected a refusal; got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.reason, "driver_unloadable");
  assert.match(outcome.detail, /broken-native/);
});

test("FG-664: a ready marker the SHIPPED probe finds EMPTY is invalidated and re-provisioned once, then the dispatch proceeds", async () => {
  // The host's own failure, reproduced with a real (empty) install root and the
  // real script reading it: cache key marked ready on Jul 27, every volume wiped
  // by an Aug 1 Docker factory reset, install root empty, refusal forever.
  const { dir, root } = makeProbedProject({ "real-driver": "^1.0.0" });
  const populated = join(dirname(root), "node_modules.populated");
  renameSync(root, populated);
  mkdirSync(root, { recursive: true });

  const key = lockfileHash(dir);
  markDependencyCacheReady(key);
  const staleMarker = readDependencyCacheMarker(key) as string;

  let provisions = 0;
  const outcome = await resolveDependencyEnvironment({
    repoRoot: dir,
    image: "agent-dev-worker:fg664-probe",
    platform: "darwin",
    lockOpts: { pollMs: 1 },
    // The install the marker lied about: it puts the packages back.
    runProvisioner: async () => {
      provisions += 1;
      for (const e of readdirSync(populated)) copyTree(join(populated, e), join(root, e));
      return { exitCode: 0, stderrTail: "" };
    },
    runProbe: async (nonce) => {
      const run = runShippedProbe(root, nonce);
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderrTail: run.stderr.trim() };
    },
  });

  assert.ok(outcome.outcome === "ready", `expected the repair to make this dispatch runnable; got ${JSON.stringify(outcome)}`);
  assert.equal(provisions, 1, "exactly one re-provision — bounded, never a retry loop");
  assert.equal(outcome.receipt.staleCacheRepaired?.disprovenRoot, root);
  assert.equal(outcome.receipt.staleCacheRepaired?.invalidatedMarker, staleMarker);
  assert.notEqual(readDependencyCacheMarker(key), staleMarker, "the disproven marker is replaced, not kept");
  assert.ok(
    outcome.receipt.packages.some((p) => p.name === "real-driver" && p.loaded),
    "the receipt attests the RE-PROVISIONED cache, read by the shipped probe",
  );
});

test("FG-664: a re-provision that does not populate the install root is refused, not repeated", async () => {
  const { dir, root } = makeProbedProject({ "real-driver": "^1.0.0" });
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const key = lockfileHash(dir);
  markDependencyCacheReady(key);

  let provisions = 0;
  const outcome = await resolveDependencyEnvironment({
    repoRoot: dir,
    image: "agent-dev-worker:fg664-probe",
    platform: "darwin",
    lockOpts: { pollMs: 1 },
    runProvisioner: async () => {
      provisions += 1;
      return { exitCode: 0, stderrTail: "" }; // exits 0 and installs nothing
    },
    runProbe: async (nonce) => {
      const run = runShippedProbe(root, nonce);
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderrTail: run.stderr.trim() };
    },
  });

  assert.ok(outcome.outcome === "refused", `expected a refusal; got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.reason, "dependencies_absent");
  assert.equal(provisions, 1, "one repair attempt, then an honest refusal");
});

test("FG-664: a report from a DIFFERENT dispatch's probe is refused, even though the script that produced it is the shipped one", async () => {
  const { dir, root } = makeProbedProject({ "real-driver": "^1.0.0" });
  // Captured under a nonce this resolution never minted — a replayed attestation.
  const stale = runShippedProbe(root, "deadbeefdeadbeefdeadbeefdeadbeef").stdout;
  assert.match(stale, /real-driver/, "the replayed report must itself be a genuine, complete one");

  const outcome = await resolveDependencyEnvironment({
    repoRoot: dir,
    image: "agent-dev-worker:fg664-probe",
    platform: "darwin",
    lockOpts: { pollMs: 1 },
    runProvisioner: async () => ({ exitCode: 0, stderrTail: "" }),
    runProbe: async () => ({ exitCode: 0, stdout: stale, stderrTail: "" }),
  });

  assert.ok(outcome.outcome === "refused", `expected a refusal; got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.reason, "probe_unparseable");
});
