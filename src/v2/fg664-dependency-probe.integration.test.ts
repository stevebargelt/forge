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

import { DEPENDENCY_LOAD_SCRIPT, DEPENDENCY_PROBE_SCRIPT } from "./spawn.js";
import {
  lockfileHash,
  markDependencyCacheReady,
  parseDependencyProbeOutput,
  readDependencyCacheMarker,
  readDependencyProbeReport,
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

  // (6) THE PREBUILDIFY FIXTURE. `prebuildify`-packaged modules ship EVERY
  //     platform's artifact in one tarball and node-gyp-build picks at require
  //     time. The foreign-platform copies here are deliberately NOT loadable, so
  //     a probe that takes the first `.node` in walk order reports this package
  //     unloadable and refuses every dispatch on a cache that is entirely correct.
  //     The names sort BEFORE this platform's directory, so walk order alone
  //     cannot get this right.
  const multi = join(nm, "prebuilt-multi");
  writePkg(multi, { name: "prebuilt-multi", version: "2.0.0" });
  for (const foreign of ["aix-ppc64", "android-arm64", "darwin-x64", "linux-mips"]) {
    mkdirSync(join(multi, "prebuilds", foreign), { recursive: true });
    writeFileSync(join(multi, "prebuilds", foreign, "node.napi.node"), `a ${foreign} object this machine cannot load\n`);
  }
  const native = join(multi, "prebuilds", `${process.platform}-${process.arch}`);
  mkdirSync(native, { recursive: true });
  copyFileSync(artifact, join(native, "node.napi.node"));

  // (6b) THE MULTI-ARCH PREBUILD FIXTURE (RF-9). `prebuildify` emits a single
  //     `<platform>-<archA>+<archB>` directory for a universal build (that is why
  //     it publishes `darwin-x64+arm64`), and node-gyp-build matches when this arch
  //     appears ANYWHERE in the `+`-list. Here this machine's arch is the SECOND
  //     entry of the tuple, and it is the ONLY loadable artifact — the foreign tuple
  //     ships an object this machine cannot load. A filter that compares only the
  //     first tuple (`name.split("+")[0]`) prunes this directory and refuses a cache
  //     that is entirely correct. Names are derived from process.platform/arch so
  //     the case holds on whatever host runs this tier.
  const foreignPlatform = process.platform === "linux" ? "darwin" : "linux";
  const multiArch = join(nm, "prebuilt-multi-arch");
  writePkg(multiArch, { name: "prebuilt-multi-arch", version: "4.0.0" });
  mkdirSync(join(multiArch, "prebuilds", `${foreignPlatform}-x64+arm64`), { recursive: true });
  writeFileSync(join(multiArch, "prebuilds", `${foreignPlatform}-x64+arm64`, "node.napi.node"), `a ${foreignPlatform} object this machine cannot load\n`);
  const multiNative = join(multiArch, "prebuilds", `${process.platform}-notmine+${process.arch}`);
  mkdirSync(multiNative, { recursive: true });
  copyFileSync(artifact, join(multiNative, "node.napi.node"));

  // (7) A package that BUILDS a native addon and shipped none — `npm ci` that
  //     never compiled, a pruned volume. Indistinguishable from a healthy
  //     environment to a gate that only inspects packages it found artifacts for.
  const stranded = join(nm, "gyp-no-artifact");
  writePkg(stranded, { name: "gyp-no-artifact", version: "3.0.0", gypfile: true });
  writeFileSync(join(stranded, "binding.gyp"), "{ 'targets': [] }\n");

  return nm;
}

/** Run the SHIPPED script, exactly as the probe container runs it. */
function runShippedProbe(
  root: string,
  nonce: string,
  declared: string[] = [],
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, ["-e", DEPENDENCY_PROBE_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_PROBE_ROOTS: root,
      FORGE_PROBE_INSTALL_ROOT: root,
      FORGE_PROBE_NONCE: nonce,
      FORGE_PROBE_DECLARED: declared.join(","),
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/** Run the SHIPPED load command, exactly as ONE load container runs it. The
 *  EXIT STATUS is the verdict — that is the whole protocol. */
function runShippedLoad(artifact: string): { exitCode: number; stderrTail: string } {
  const r = spawnSync(process.execPath, ["-e", DEPENDENCY_LOAD_SCRIPT, artifact], { encoding: "utf8" });
  return { exitCode: r.status ?? 1, stderrTail: (r.stderr ?? "").trim() };
}

/** The two container callbacks the resolver needs, both running SHIPPED bytes
 *  against a real fixture tree on this machine's real node. */
function shippedGate(root: string, declared: string[] = []) {
  return {
    runProbe: async (nonce: string, names?: readonly string[]) => {
      const run = runShippedProbe(root, nonce, names ? [...names] : declared);
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderrTail: run.stderr.trim() };
    },
    runLoad: async (artifact: string) => runShippedLoad(artifact),
  };
}

function pkg(report: DependencyProbeReport, name: string) {
  return report.packages.find((p) => p.name === name);
}

test("FG-664: the SHIPPED probe finds every native artifact, and the SHIPPED load command loads them — including one whose package has no '.' export", () => {
  const root = makeFixtureRoot();

  // Non-vacuity for the defect-2 fixture: bare-name require really does throw for
  // it, so the successful load below is the gate not asking that question — not
  // the fixture failing to reproduce the published shape.
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

  for (const name of ["real-driver", "@img/fixture-linux-arm64"]) {
    const artifact: string | undefined = pkg(report, name)?.artifact;
    assert.ok(artifact, `${name} ships a compiled artifact and the probe must find it`);
    assert.equal(
      runShippedLoad(artifact).exitCode,
      0,
      `${name} must LOAD — a package that is not requireable at its root still is, and treating it otherwise is ` +
        `the regression that refused every read-only dispatch on darwin`,
    );
  }
  assert.equal(pkg(report, "pure-js"), undefined, "a package with no compiled artifact is not a native package");

  const rootRecord = report.roots.find((r) => r.path === root);
  assert.ok(rootRecord, "the mounted root must be recorded");
  assert.equal(rootRecord.installRoot, true);
  assert.ok(rootRecord.entries > 0, "a populated root must not read as empty");
  assert.equal(report.node, process.version, "the report carries the PROBING process's own engine identity");
  assert.equal(report.abi, process.versions.modules);
});

test("FG-664: the SHIPPED load command fails on an unloadable artifact, with the real loader error", () => {
  const root = makeFixtureRoot();
  const nonce = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
  const report = parseDependencyProbeOutput(runShippedProbe(root, nonce).stdout, nonce);
  assert.ok(report);

  const artifact = pkg(report, "broken-native")?.artifact;
  assert.ok(artifact, "the probe still SEES a .node that is not a shared object");
  const load = runShippedLoad(artifact);
  assert.notEqual(load.exitCode, 0, "a .node that is not a shared object must never load");
  assert.match(
    load.stderrTail,
    /ERR_DLOPEN_FAILED|invalid ELF header|not a valid|Exec format|file too short|dlopen/i,
    `the refusal has to carry the real loader error; got: ${load.stderrTail}`,
  );
});

test("FG-664: the reporting container runs NO dependency code at all — a package that forges a report never executes beside the reporter", () => {
  const root = makeFixtureRoot();

  // Non-vacuity: the fixture really does print a complete forged report — twice,
  // the second time from an `exit` listener so it lands AFTER whatever the host
  // process wrote. Under an in-process `require()` shape that line was the LAST
  // readable JSON on the probe container's stdout, and last-line-wins would have
  // handed it to the resolver as the attestation.
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
  assert.equal(jsonLines.length, 1, `exactly one report line, authored by the probe; got ${jsonLines.length}`);

  // THE POINT: the probe never spawned anything. The earlier shape ran each load
  // as a CHILD of this process — same uid, so it could read the nonce out of
  // /proc/<pid>/environ and write a crafted line into /proc/<pid>/fd/1 whatever
  // its own stdio was piped to. The load has to happen somewhere the report is
  // not, and that is a separate container.
  assert.ok(
    !DEPENDENCY_PROBE_SCRIPT.includes("spawnSync") && !DEPENDENCY_PROBE_SCRIPT.includes("child_process"),
    "the probe script must not spawn ANY process — the load belongs in its own container",
  );
  assert.ok(!DEPENDENCY_PROBE_SCRIPT.includes("dlopen"), "and it must not load an artifact itself");

  const report = parseDependencyProbeOutput(run.stdout, nonce);
  assert.ok(report);
  assert.equal(report.node, process.version, "the surviving report is the probe's, not the forgery's");
  assert.equal(pkg(report, "forger")?.version, "6.6.6", "the version came from package.json, read by the probe");
});

test("FG-664: a second report-shaped line REFUSES the read — last-line-wins is a rule an injected line only has to outlast", () => {
  const nonce = "5555555555555555555555555555555a";
  const genuine = JSON.stringify({
    nonce,
    node: process.version,
    abi: process.versions.modules,
    roots: [{ path: "/project/node_modules", entries: 3, installRoot: true }],
    packages: [],
    missing: [],
  });
  const forged = JSON.stringify({
    nonce,
    node: "v0.0.0-forged",
    abi: "0",
    roots: [{ path: "/project/node_modules", entries: 999, installRoot: true }],
    packages: [],
    missing: [],
  });

  assert.ok(parseDependencyProbeOutput(genuine + "\n", nonce), "one report is read");
  assert.equal(
    parseDependencyProbeOutput(genuine + "\n" + forged + "\n", nonce),
    undefined,
    "a stream carrying two reports is contaminated — neither line may be accepted, and the LAST one least of all",
  );
  const read = readDependencyProbeReport(forged + "\n" + genuine + "\n", nonce);
  assert.ok("refusal" in read && /2 report-shaped lines/.test(read.refusal), `got ${JSON.stringify(read)}`);
});

test("FG-664: the SHIPPED probe emits progress on stderr while it scans, so its idle budget is a GAP budget and not a total-runtime one", () => {
  const root = makeFixtureRoot();
  const run = runShippedProbe(root, "7777777777777777777777777777777a");
  assert.equal(run.status, 0);
  assert.match(
    run.stderr,
    /forge-depprobe: probe starting/,
    `the probe must emit a first byte BEFORE it starts walking — the watchdog arms at spawn; stderr: ${run.stderr}`,
  );
  assert.match(run.stderr, /forge-depprobe: scanning /, "and again per mounted root");
  assert.match(run.stderr, /forge-depprobe: scan complete/, "and when the scan is done");
  assert.ok(
    !run.stdout.includes("forge-depprobe:"),
    "progress must never land on stdout — that stream carries exactly one line, the report",
  );
});

test("FG-664: the SHIPPED probe selects THIS platform's prebuild — a multi-platform package is not dlopen'd against a foreign artifact", () => {
  const root = makeFixtureRoot();
  const nonce = "2222222222222222222222222222222a";
  const report = parseDependencyProbeOutput(runShippedProbe(root, nonce).stdout, nonce);
  assert.ok(report);

  const artifact = pkg(report, "prebuilt-multi")?.artifact;
  assert.ok(artifact, "a prebuildify-layout package still reports an artifact");
  assert.match(
    artifact,
    new RegExp(`prebuilds/${process.platform}-${process.arch}/`),
    `the artifact must be THIS platform's; got ${artifact}. Taking the first .node in walk order dlopens a darwin ` +
      `binary inside a linux container and refuses every read-only dispatch, permanently, on a correct cache`,
  );
  assert.equal(runShippedLoad(artifact).exitCode, 0, "and the selected artifact must actually load");
});

test("FG-667 RF-9: the SHIPPED probe selects an artifact whose arch is the SECOND entry of a multi-arch prebuilds tuple", () => {
  const root = makeFixtureRoot();
  const nonce = "6667666766676667666766676667666a";
  const report = parseDependencyProbeOutput(runShippedProbe(root, nonce, ["prebuilt-multi-arch"]).stdout, nonce);
  assert.ok(report);

  const artifact = pkg(report, "prebuilt-multi-arch")?.artifact;
  assert.ok(
    artifact,
    "a prebuildify universal-build package (this arch is the 2nd `+`-entry of the tuple) must still report an artifact — " +
      "matching only the first tuple prunes the directory and permanently refuses a correct cache",
  );
  assert.match(
    artifact,
    new RegExp(`prebuilds/${process.platform}-notmine\\+${process.arch}/`),
    `the artifact must be from the tuple whose arch list CONTAINS this arch; got ${artifact}`,
  );
  assert.equal(
    runShippedLoad(artifact).exitCode,
    0,
    "and the selected artifact must actually load — the foreign tuple in this fixture cannot",
  );
  // The declared driver resolves through the whole gate as loadable, not refused.
  assert.equal(pkg(report, "prebuilt-multi-arch")?.unavailable, undefined, "a served multi-arch tuple is not unavailable");
});

test("FG-664: a DECLARED package that is absent from every mounted root, and one present with no compiled artifact, are both reported", () => {
  const root = makeFixtureRoot();
  const nonce = "3333333333333333333333333333333a";
  const report = parseDependencyProbeOutput(
    runShippedProbe(root, nonce, ["real-driver", "pure-js", "gyp-no-artifact", "never-installed"]).stdout,
    nonce,
  );
  assert.ok(report);

  assert.deepEqual(report.missing, ["never-installed"], "only the declared package that is in NO root is missing");
  const stranded = pkg(report, "gyp-no-artifact");
  assert.ok(stranded, "a declared package that builds a native addon but shipped no artifact must be REPORTED");
  assert.equal(stranded.artifact, undefined, "there is nothing to load");
  assert.match(String(stranded.unavailable), /no compiled \.node artifact/);
  assert.equal(pkg(report, "pure-js"), undefined, "a declared package with no native build is not a driver");
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
    ...shippedGate(root),
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

test("FG-667 RF-9: resolveDependencyEnvironment accepts a declared driver served by the SECOND arch in a prebuild tuple", async () => {
  const { dir, root } = makeProbedProject({ "prebuilt-multi-arch": "^4.0.0" });

  const outcome = await resolveDependencyEnvironment({
    repoRoot: dir,
    image: "agent-dev-worker:fg667-multi-arch",
    platform: "darwin",
    lockOpts: { pollMs: 1 },
    runProvisioner: async () => ({ exitCode: 0, stderrTail: "" }),
    ...shippedGate(root),
  });

  assert.equal(
    outcome.outcome,
    "ready",
    `a declared native served by ${process.platform}-notmine+${process.arch} must not be refused; got ${JSON.stringify(outcome)}`,
  );
  assert.ok(outcome.outcome === "ready");
  const attested = outcome.receipt.packages.find((entry) => entry.name === "prebuilt-multi-arch");
  assert.ok(attested?.loaded, "the receipt must attest that the declared multi-arch driver loaded");
  assert.match(String(attested.artifact), new RegExp(`prebuilds/${process.platform}-notmine\\+${process.arch}/`));
});

test("FG-664: resolveDependencyEnvironment over the SHIPPED probe REFUSES driver_unloadable when a DECLARED native cannot load", async () => {
  const { dir, root } = makeProbedProject({ "broken-native": "^9.0.0" });

  const outcome = await resolveDependencyEnvironment({
    repoRoot: dir,
    image: "agent-dev-worker:fg664-probe",
    platform: "darwin",
    lockOpts: { pollMs: 1 },
    runProvisioner: async () => ({ exitCode: 0, stderrTail: "" }),
    ...shippedGate(root),
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
    ...shippedGate(root),
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
    ...shippedGate(root),
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
    runLoad: async (artifact) => runShippedLoad(artifact),
  });

  assert.ok(outcome.outcome === "refused", `expected a refusal; got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.reason, "probe_unparseable");
});
