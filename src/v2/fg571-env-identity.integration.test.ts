// FG-571 (FG-553 Child 4) — F29 (hostile caller ENVIRONMENT), F32 (fail-closed release
// identity), F25 (the stable/dev SPLIT). All EXECUTED, all mutation-tested.
//
// The red baseline is real and reproducible on this host (plan Appendix A2): with an
// ABSOLUTE PINNED INTERPRETER and a clean PATH, `NODE_OPTIONS=--import ./evil.mjs` still
// runs attacker code BEFORE forge, and `NODE_OPTIONS=--not-a-real-flag` still prevents
// startup. So interpreter pinning is necessary and NOT sufficient — a caller-applied PATH
// pin is containment, not isolation. The mandatory mutant below ("pin PATH but leave
// NODE_OPTIONS live") is what proves that distinction rather than asserting it.
//
// SAFETY: every promotion and shim install here happens under a mkdtemp FORGE_HOME with an
// explicit --prefix. No `npm link`, and nothing reaches the developer's real ~/.forge, real
// shim, or live control plane. The release is built from a DISPOSABLE source root
// (fg571-harness.ts) rather than by committing in the real repository, so this suite is
// non-destructive on a dirty dev checkout and races nothing when it runs alongside the
// promote/rollback suite under one `npm run test:integration`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST_NAME, SHIM_NAME, renderShim, thawReleaseTree, type BuildReleaseResult } from "./release.js";
import { atomicSymlinkSwap, installShim, promote } from "./promote.js";
import { currentLinkIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "./fg571-harness.js";

/** The REAL checkout: READ for the dev entry and the live-source fixtures below, never
 *  written to and never committed to. */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
let home: string;
let rel: BuildReleaseResult;
let shim: string;
/** The side effect an injected module leaves behind. Its ABSENCE is the F29 assertion. */
let evilMarker: string;
let evilModule: string;
let repoHeadBefore: string;
let repoStatusBefore: string;

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** A PATH with NO node on it at all — F29's sharpest form. */
function nodeFreePath(): string {
  const dir = mkdtempSync(join(workspace, "nopath-"));
  return dir;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { ...r, json };
}

before(async () => {
  repoHeadBefore = gitIn(repoRoot, ["rev-parse", "HEAD"]).trim();
  repoStatusBefore = gitIn(repoRoot, ["status", "--porcelain"]);

  workspace = mkdtempSync(join(tmpdir(), "fg571-env-"));
  home = mkdtempSync(join(tmpdir(), "fg571-env-home-"));
  source = await makeDisposableSourceRoot(repoRoot);
  rel = source.build({ outDir: join(workspace, "release"), rand: "e29e29" });
  promote({ home, candidate: rel.releaseDir });
  shim = installShim({ prefix: workspace, shimText: renderShim(), shimName: SHIM_NAME });

  evilMarker = join(workspace, "INJECTED");
  evilModule = join(workspace, "evil.mjs");
  writeFileSync(evilModule, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(evilMarker)}, "attacker code ran");\n`);
});

after(() => {
  for (const dir of [workspace, home]) {
    if (existsSync(dir)) {
      thawReleaseTree(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Not thawed: it holds no frozen tree, and thawing would walk through its node_modules
  // symlink into the real one.
  if (source) removeDisposableSourceRoot(source);

  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the whole suite left the real checkout's HEAD unmoved");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "the whole suite left the real working tree exactly as it found it");
});

test("FG-571 SAFETY: this suite never runs git against the REAL checkout", () => {
  // Replaces a `git add` + `git commit` against findGitRoot(cwd) that committed the
  // developer's in-progress work, and that raced this file's twin on .git/index.lock when
  // both suites' before() hooks ran under one `npm run test:integration`.
  assert.notEqual(source.root, repoRoot, "the release is built from a disposable checkout, not the real repository");
  assert.ok(!source.root.startsWith(repoRoot), "and that checkout is not inside the real repository");
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the real checkout's HEAD did not move");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "and its working tree is byte-for-byte as this suite found it");
});

// ---------------------------------------------------------------------------
// F29 — hostile caller environment
// ---------------------------------------------------------------------------

test("FG-571 F29 (EXECUTED): stable forge runs with NO node on PATH at all", () => {
  const path = nodeFreePath();
  // Prove the premise: node is genuinely absent from this PATH.
  const probe = spawnSync("node", ["-v"], { env: { PATH: path }, encoding: "utf8" });
  assert.equal((probe.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT", "node is genuinely absent from this PATH");

  const r = run(shim, ["release", "provenance", "--json"], { PATH: path, HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home });
  assert.equal(r.status, 0, `the shim must run with no node on PATH: ${r.stderr}`);
  assert.equal(r.json.execPath, rel.manifest.interpreter, "it ran the manifest-pinned absolute interpreter");
  assert.equal(r.json.bindingLoads, true, "and loaded the release's own native binding");
});

test("FG-571 F29 (EXECUTED): stable forge runs when PATH resolves an INCOMPATIBLE node FIRST", () => {
  // The shim never consults PATH, so a hostile `node` earlier on it is simply irrelevant.
  // If any part of the launcher resolved node from PATH, this would run the impostor.
  const dir = mkdtempSync(join(workspace, "badnode-"));
  const impostor = join(dir, "node");
  writeFileSync(impostor, `#!/bin/sh\necho "IMPOSTOR NODE RAN" >&2\nexit 77\n`);
  chmodSync(impostor, 0o755);
  // The impostor really is what `node` resolves to on this PATH.
  const which = spawnSync("/bin/sh", ["-c", "command -v node"], { env: { PATH: dir }, encoding: "utf8" });
  assert.equal(which.stdout.trim(), impostor, "PATH resolves node to the incompatible impostor");

  const r = run(shim, ["release", "provenance", "--json"], { PATH: dir, HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home });
  assert.equal(r.status, 0, `the shim must ignore PATH's node entirely: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /IMPOSTOR/, "the impostor never ran");
  assert.equal(r.json.execPath, rel.manifest.interpreter, "the pinned interpreter ran instead");
});

test("FG-571 F29 (EXECUTED, the proven red baseline): NODE_OPTIONS=--import <evil> does NOT execute the injected code, and behavior is identical to a clean env", () => {
  const env = { PATH: nodeFreePath(), HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };

  // Baseline: the same command in a clean environment.
  rmSync(evilMarker, { force: true });
  const clean = run(shim, ["release", "provenance", "--json"], env);
  assert.equal(clean.status, 0, clean.stderr);

  // The hostile arm.
  rmSync(evilMarker, { force: true });
  const hostile = run(shim, ["release", "provenance", "--json"], { ...env, NODE_OPTIONS: `--import ${evilModule}` });

  // (1) THE side effect is ABSENT — the injected module never ran.
  assert.ok(!existsSync(evilMarker), "the injected module did NOT run — its side effect is absent");
  // (2) ...AND behavior is identical to the clean env (not merely "fails cleanly", which
  // the plan explicitly rules out as a pass).
  assert.equal(hostile.status, 0, `forge must RUN under a hostile NODE_OPTIONS: ${hostile.stderr}`);
  assert.equal(hostile.json.execPath, clean.json.execPath, "same interpreter");
  assert.equal(hostile.json.releaseId, clean.json.releaseId, "same release identity");
  assert.equal(hostile.json.bindingLoads, clean.json.bindingLoads, "same binding load");
  assert.deepEqual(hostile.json.match, clean.json.match, "same self-verification against the manifest");
});

test("FG-571 F29 MANDATORY MUTANT (EXECUTED): pin PATH but leave NODE_OPTIONS live -> the injection RUNS. PATH pinning is containment, not isolation.", () => {
  // This mutant is the whole argument for the env-sanitization contract. It takes the REAL
  // shim and removes ONLY NODE_OPTIONS from its unset list — everything else (the absolute
  // pinned interpreter, the node-free PATH, the single physical resolution) is unchanged.
  // If an absolute interpreter were sufficient, this would still be safe. It is not.
  const mutantText = renderShim().replace("unset NODE_OPTIONS ", "unset ");
  assert.ok(!/unset .*NODE_OPTIONS/.test(mutantText), "the mutant genuinely no longer unsets NODE_OPTIONS");
  const mutant = join(mkdtempSync(join(workspace, "mutant-prefix-")), "forge");
  writeFileSync(mutant, mutantText);
  chmodSync(mutant, 0o755);

  rmSync(evilMarker, { force: true });
  const r = run(mutant, ["release", "provenance", "--json"], {
    PATH: nodeFreePath(),
    HOME: process.env.HOME ?? "/tmp",
    FORGE_HOME: home,
    NODE_OPTIONS: `--import ${evilModule}`,
  });

  // RED: with PATH pinned and NODE_OPTIONS live, the attacker's code runs inside forge.
  assert.ok(existsSync(evilMarker), "MUTANT: the injected module RAN — pinning the interpreter/PATH alone does not stop it, which is exactly why the unset list exists");
  assert.equal(readFileSync(evilMarker, "utf8"), "attacker code ran");
  assert.equal(r.status, 0, "and it ran BEFORE forge, invisibly — forge itself still succeeded, so nothing would have looked wrong");
});

test("FG-571 F29 (EXECUTED): a NODE_OPTIONS value that would normally PREVENT node startup does not block stable forge", () => {
  const env = { PATH: nodeFreePath(), HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };
  // Prove the premise: this value really does block a node startup.
  const blocked = spawnSync(rel.manifest.interpreter, ["-e", "0"], {
    encoding: "utf8",
    env: { ...env, NODE_OPTIONS: "--not-a-real-flag" },
  });
  assert.notEqual(blocked.status, 0, "the premise: this NODE_OPTIONS blocks a plain node startup");
  assert.match(blocked.stderr, /not allowed in NODE_OPTIONS/i);

  const r = run(shim, ["release", "provenance", "--json"], { ...env, NODE_OPTIONS: "--not-a-real-flag" });
  assert.equal(r.status, 0, `stable forge must still start: ${r.stderr}`);
  assert.equal(r.json.releaseId, rel.manifest.id, "and runs the selected release normally");
});

test("FG-571 F29 (EXECUTED): NODE_PATH and its peers cannot redirect dependency resolution", () => {
  const env = { PATH: nodeFreePath(), HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };
  const clean = run(shim, ["release", "provenance", "--json"], env);

  // A poisoned resolution environment: a NODE_PATH root holding a hostile better-sqlite3,
  // plus the symlink-resolution vars that decide WHICH release a process anchors to.
  const poisonRoot = mkdtempSync(join(workspace, "nodepath-poison-"));
  mkdirSync(join(poisonRoot, "better-sqlite3"), { recursive: true });
  writeFileSync(join(poisonRoot, "better-sqlite3", "package.json"), `{"name":"better-sqlite3","main":"index.js","version":"0.0.0-poison"}`);
  writeFileSync(join(poisonRoot, "better-sqlite3", "index.js"), `throw new Error("POISONED better-sqlite3 was resolved");\n`);

  const r = run(shim, ["release", "provenance", "--json"], {
    ...env,
    NODE_PATH: poisonRoot,
    NODE_PRESERVE_SYMLINKS: "1",
    NODE_PRESERVE_SYMLINKS_MAIN: "1",
  });
  assert.equal(r.status, 0, `resolution must be unaffected: ${r.stderr}`);
  assert.equal(r.json.bindingLoads, true, "the release's OWN better-sqlite3 loaded, not the poisoned one");
  assert.equal(r.json.release.id, clean.json.release.id, "and the process still anchored to the same release");
  assert.deepEqual(r.json.match, clean.json.match, "behavior is identical to the clean environment");
});

test("FG-571 F29 BOUNDED (EXECUTED against the generated sanitizer): every injection var is unset AND every unrelated operator var SURVIVES untouched", () => {
  // Over-broad sanitization is as much a defect as under-broad: `env -i` would break the
  // operator's bedrock auth (AWS_*), their notifications (NTFY_*), their locale, and forge's
  // own FORGE_HOME. This runs the REAL generated snippet — the bytes the shim ships — with a
  // fully populated environment, and reports what survived.
  const code = renderShim()
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"));
  const sanitizer = code.find((l) => l.startsWith("unset "));
  assert.ok(sanitizer, "the shim carries an explicit unset list");
  // BOUNDED: no executable line wipes the environment wholesale. (Comments are excluded —
  // the shim's own prose explains that it never does this.)
  assert.ok(
    !code.some((l) => /\benv\s+-i\b/.test(l) || /\bunset\s+-[Ee]?\b/.test(l)),
    "no code line wipes the environment wholesale — sanitization is an explicit per-variable list",
  );

  const injected = {
    NODE_OPTIONS: `--import ${evilModule}`,
    NODE_PATH: "/tmp/poison",
    NODE_PRESERVE_SYMLINKS: "1",
    NODE_PRESERVE_SYMLINKS_MAIN: "1",
    NODE_REPL_EXTERNAL_MODULE: "/tmp/evil.js",
    NODE_COMPILE_CACHE: "/tmp/cache",
    NODE_V8_COVERAGE: "/tmp/cov",
    NODE_ICU_DATA: "/tmp/icu",
    NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_DEBUG: "http",
    NODE_DEBUG_NATIVE: "http2",
    FORGE_RELEASE_ID: "release-forged-by-the-caller",
  };
  const preserved = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    FORGE_HOME: home,
    AWS_PROFILE: "sgws-bedrock",
    AWS_REGION: "us-east-1",
    NTFY_TOPIC: "forge-ops",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    FORGE_DB_PATH: "/tmp/forge.db",
    CLAUDE_CODE_USE_BEDROCK: "1",
  };

  const r = spawnSync("/bin/sh", ["-c", `${sanitizer}\nenv`], {
    encoding: "utf8",
    env: { ...injected, ...preserved },
  });
  assert.equal(r.status, 0, r.stderr);
  const seen = new Map(
    r.stdout
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
  );

  for (const name of Object.keys(injected)) {
    assert.ok(!seen.has(name), `${name} was sanitized away`);
  }
  // The other half of BOUNDED — and the reason `env -i` is the wrong tool.
  for (const [name, value] of Object.entries(preserved)) {
    assert.equal(seen.get(name), value, `${name} SURVIVED untouched — sanitization is bounded, not broad`);
  }
});

// ---------------------------------------------------------------------------
// F32 — fail-closed release identity
// ---------------------------------------------------------------------------

/** A writable copy of the real release whose manifest a test can corrupt, selected by
 *  pointing `current` at it DIRECTLY. Promotion itself refuses every one of these (asserted
 *  separately) — the shim must fail closed anyway, because "nothing else could have
 *  selected this" is not a property a launcher gets to assume. */
function selectReleaseWithManifest(name: string, mutate: (manifestPath: string) => void): void {
  const dir = join(workspace, name);
  if (!existsSync(dir)) {
    execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", dir, rel.releaseDir]);
    execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"', "sh", dir]);
  }
  mutate(join(dir, RELEASE_MANIFEST_NAME));
  // PRODUCTION's own pointer primitive (symlinkSync + renameSync). Not `mv -T`: that flag is
  // GNU-only — BSD/macOS mv rejects it with `illegal option -- T` (status 64), which would
  // make this suite green on Linux CI and red on the operator's host, i.e. unable to run the
  // acceptance evidence for a security-boundary ticket locally. rename(2) replaces a symlink
  // in place and is portable.
  atomicSymlinkSwap(dir, currentLinkIn(home));
}

const poisonedEnv = () => ({
  PATH: nodeFreePath(),
  HOME: process.env.HOME ?? "/tmp",
  FORGE_HOME: home,
  FORGE_RELEASE_ID: "release-forged-by-the-caller",
});

test("FG-571 F32 (EXECUTED): poisoned FORGE_RELEASE_ID + a VALID manifest -> the forged value is IGNORED; the reported identity is the manifest's", () => {
  promote({ home, candidate: rel.releaseDir });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnv());
  assert.equal(r.status, 0, r.stderr);
  // Asserted FROM THE RUNNING PROCESS: this is the value everything forge starts records.
  assert.equal(r.json.releaseId, rel.manifest.id, "identity came from the manifest");
  assert.notEqual(r.json.releaseId, "release-forged-by-the-caller", "the caller's forged value did not survive");
});

test("FG-571 F32 (EXECUTED): manifest identity MISSING -> named error, FAIL CLOSED — not null, not the ambient value, not a silent run", () => {
  selectReleaseWithManifest("rel-id-missing", (p) => {
    const m = JSON.parse(readFileSync(p, "utf8"));
    delete m.id;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnv());
  assert.notEqual(r.status, 0, "a release with no identity does not run");
  assert.match(r.stderr, /refusing to run — this release's manifest states no identity/i, "the refusal is NAMED");
  assert.match(r.stderr, /release manifest: .*forge-release\.json/, "and says WHERE");
  assert.match(r.stderr, /running:\s+the machine-wide forge shim/, "and says what was running");
  assert.match(r.stderr, /Fix:/, "and how to fix it");
  assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
});

test("FG-571 F32 (EXECUTED): manifest identity MALFORMED -> named error, fail closed", () => {
  selectReleaseWithManifest("rel-id-malformed", (p) => {
    const m = JSON.parse(readFileSync(p, "utf8"));
    // An unquoted/numeric id: the read yields junk rather than a token. Guessing at it is
    // exactly what fail-closed forbids.
    writeFileSync(p, JSON.stringify({ ...m, id: 12345 }, null, 2) + "\n");
  });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnv());
  assert.notEqual(r.status, 0, "a malformed identity does not run");
  assert.match(r.stderr, /refusing to run — this release's manifest states a malformed identity/i, "the refusal is NAMED");
  assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
});

test("FG-571 F32 (EXECUTED): manifest UNREADABLE -> named error, fail closed", () => {
  selectReleaseWithManifest("rel-id-unreadable", (p) => {
    writeFileSync(p, readFileSync(p));
    chmodSync(p, 0o000);
  });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnv());
  assert.notEqual(r.status, 0, "an unreadable manifest does not run");
  assert.match(r.stderr, /refusing to run — this release's manifest is unreadable/i, "the refusal is NAMED");
  assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
  chmodSync(join(workspace, "rel-id-unreadable", RELEASE_MANIFEST_NAME), 0o644);
});

test("FG-571 F32 (EXECUTED): forge-dev + poisoned ambient FORGE_RELEASE_ID -> identity NULL (dev has no manifest — the honest answer)", () => {
  const r = run(join(repoRoot, "bin", "forge-dev"), ["release", "provenance", "--json"], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    FORGE_HOME: home,
    FORGE_RELEASE_ID: "release-forged-by-the-caller",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.releaseId, null, "dev provenance is NULL — not recorded, never manufactured");
  assert.equal(r.json.release, null, "and the dev entry is not inside a release");
});

test("FG-571 F32 MANDATORY MUTANT (EXECUTED): restore FG-569's read-loop (no unset before read) -> the poisoned-env case goes RED — the forged id is recorded as provenance", () => {
  // FG-569's shipped entry exported FORGE_RELEASE_ID only when its read loop FOUND an id.
  // When the read yields nothing — the missing/malformed/unreadable cells above — a
  // CALLER-SUPPLIED value SURVIVES and is recorded as this release's provenance. This
  // mutant restores exactly that behavior on the real shim: the unset is dropped from the
  // sanitize list and the fail-closed guard is replaced by FG-569's loop.
  const real = renderShim();
  const guardStart = real.indexOf("# FG-571 (F32): identity is FAIL-CLOSED");
  const guardEnd = real.indexOf("export FORGE_RELEASE_ID") + "export FORGE_RELEASE_ID".length;
  assert.ok(guardStart > 0 && guardEnd > guardStart, "located the fail-closed guard in the real shim");
  const fg569Loop = [
    `while IFS= read -r ln; do`,
    `  case "$ln" in`,
    `  *\\"id\\":*)`,
    `    ln=\${ln#*\\"id\\": \\"}`,
    `    FORGE_RELEASE_ID=\${ln%%\\"*}`,
    `    export FORGE_RELEASE_ID`,
    `    break ;;`,
    `  esac`,
    `done < "$__forge_m"`,
  ].join("\n");
  const mutantText = real.slice(0, guardStart) + fg569Loop + real.slice(guardEnd);
  const withAmbientLive = mutantText.replace(" FORGE_RELEASE_ID\n", "\n");
  assert.ok(!/unset .*FORGE_RELEASE_ID/.test(withAmbientLive), "the mutant genuinely no longer unsets the ambient carrier");

  const mutant = join(mkdtempSync(join(workspace, "f32-mutant-")), "forge");
  writeFileSync(mutant, withAmbientLive);
  chmodSync(mutant, 0o755);

  // The exact cell FG-569 got wrong: a manifest whose read yields no id.
  selectReleaseWithManifest("rel-id-missing", (p) => {
    const m = JSON.parse(readFileSync(p, "utf8"));
    delete m.id;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  });

  const r = run(mutant, ["release", "provenance", "--json"], poisonedEnv());
  // RED: it RUNS, and it records the caller's forged identity as this release's provenance.
  assert.equal(r.status, 0, "MUTANT: the FG-569 read-loop runs the release instead of refusing");
  assert.equal(
    r.json.releaseId,
    "release-forged-by-the-caller",
    "MUTANT: the caller's forged FORGE_RELEASE_ID SURVIVED and is now this process's provenance — the spoof FG-571 closes",
  );
});

test("FG-571 F32 MANDATORY MUTANT (EXECUTED): degrade a missing identity to null-and-continue -> the fail-closed cases go RED", () => {
  // The other half. Unsetting the ambient carrier alone stops the spoof but silently
  // degrades a real release's provenance to "unknown" — trading a spoofing bug for a
  // correctness bug. This mutant keeps the unset and drops ONLY the refusal, so a release
  // that cannot state who it is runs anyway with null provenance. Both cells above must
  // redden against it, which is what proves the refusal (not just the unset) is doing work.
  const real = renderShim();
  const guardStart = real.indexOf("# FG-571 (F32): identity is FAIL-CLOSED");
  const guardEnd = real.indexOf("export FORGE_RELEASE_ID") + "export FORGE_RELEASE_ID".length;
  const nullAndContinue = [
    `while IFS= read -r __forge_ln; do`,
    `  case "$__forge_ln" in`,
    `  *\\"id\\":*)`,
    `    __forge_v=\${__forge_ln#*\\"id\\": \\"}`,
    `    FORGE_RELEASE_ID=\${__forge_v%%\\"*}`,
    `    export FORGE_RELEASE_ID`,
    `    break ;;`,
    `  esac`,
    `done < "$__forge_m"`,
  ].join("\n");
  const mutantText = real.slice(0, guardStart) + nullAndContinue + real.slice(guardEnd);
  const mutant = join(mkdtempSync(join(workspace, "f32-mutant2-")), "forge");
  writeFileSync(mutant, mutantText);
  chmodSync(mutant, 0o755);

  selectReleaseWithManifest("rel-id-missing", (p) => {
    const m = JSON.parse(readFileSync(p, "utf8"));
    delete m.id;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  });
  const r = run(mutant, ["release", "provenance", "--json"], poisonedEnv());
  // RED: no refusal. The release runs as a supposed release with NO identity — every
  // process it starts records "unknown" provenance and nothing tells the operator.
  assert.equal(r.status, 0, "MUTANT: null-and-continue runs a release that cannot state who it is");
  assert.equal(r.json.releaseId, null, "MUTANT: its provenance silently degraded to unknown instead of refusing");
});

test("FG-571 F32: promotion ALSO refuses a release with no usable identity — the operator learns at promote, with the previous release still selected", () => {
  const idless = join(workspace, "promote-idless");
  execFileSync("/bin/sh", ["-c", 'mkdir -p "$1" && tar -C "$2" -cf - . | tar -C "$1" -xf -', "sh", idless, rel.releaseDir]);
  execFileSync("/bin/sh", ["-c", 'chmod -R u+w "$1"', "sh", idless]);
  const p = join(idless, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, "utf8"));
  delete m.id;
  writeFileSync(p, JSON.stringify(m, null, 2) + "\n");

  promote({ home, candidate: rel.releaseDir });
  assert.throws(() => promote({ home, candidate: idless }), /does not state a usable identity/i);
  const r = run(shim, ["release", "provenance", "--json"], { PATH: nodeFreePath(), HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home });
  assert.equal(r.json.releaseId, rel.manifest.id, "the previously selected release is still what runs");
});

// ---------------------------------------------------------------------------
// F25 — the stable/dev SPLIT (behavioral: prove the split, not filenames)
// ---------------------------------------------------------------------------

/** A live-source checkout we are allowed to BREAK. node_modules is symlinked rather than
 *  copied: forge-dev resolves it from the checkout at run time, and this test must never
 *  touch the real one. */
function makeDevCheckout(): string {
  const dir = mkdtempSync(join(workspace, "dev-checkout-"));
  for (const p of ["src", "bin", "package.json", "package-lock.json"]) {
    execFileSync("/bin/sh", ["-c", 'mkdir -p "$(dirname "$2")" && cp -R "$1" "$2"', "sh", join(repoRoot, p), join(dir, p)]);
  }
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
}

test("FG-571 F25 (EXECUTED, BEHAVIORAL): with the live checkout genuinely BROKEN — forge-dev FAILS, stable forge still EXECUTES the promoted release", () => {
  promote({ home, candidate: rel.releaseDir });
  const dev = makeDevCheckout();
  const devEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home };

  // Working first: the dev entry runs its OWN live source.
  const beforeBreak = run(join(dev, "bin", "forge-dev"), ["release", "provenance", "--json"], devEnv);
  assert.equal(beforeBreak.status, 0, `forge-dev must run against an intact checkout: ${beforeBreak.stderr}`);

  // GENUINELY break the checkout — a real syntax error in the CLI entry's own import graph.
  writeFileSync(join(dev, "src", "cli", "index.ts"), "this is not valid typescript ((( <<< \n");

  // (1) forge-dev MUST FAIL from that checkout.
  const brokenDev = run(join(dev, "bin", "forge-dev"), ["release", "provenance", "--json"], devEnv);
  assert.notEqual(brokenDev.status, 0, "forge-dev must FAIL against a broken live checkout — that IS the dev loop");

  // (2) stable forge MUST still EXECUTE the promoted release.
  const stable = run(shim, ["release", "provenance", "--json"], { PATH: nodeFreePath(), HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home });
  assert.equal(stable.status, 0, `stable forge must be unaffected by a broken dev checkout: ${stable.stderr}`);
  assert.equal(stable.json.releaseId, rel.manifest.id, "it ran the promoted, immutable release");
  assert.equal(stable.json.bindingLoads, true, "including its native binding");
});

test("FG-571 F25 (EXECUTED): the two report DIFFERENT PROVENANCE — asserted from the RUNNING PROCESSES, not from file paths or symlink targets", () => {
  promote({ home, candidate: rel.releaseDir });
  const dev = makeDevCheckout();
  // Both are given the SAME poisoned ambient identity, so any difference is the split
  // itself and not the environment.
  const poison = { HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home, FORGE_RELEASE_ID: "release-forged-by-the-caller" };

  const devRun = run(join(dev, "bin", "forge-dev"), ["release", "provenance", "--json"], { ...poison, PATH: process.env.PATH ?? "/usr/bin:/bin" });
  const stableRun = run(shim, ["release", "provenance", "--json"], { ...poison, PATH: nodeFreePath() });

  assert.equal(devRun.status, 0, devRun.stderr);
  assert.equal(stableRun.status, 0, stableRun.stderr);

  // The provenance divergence, from the running processes themselves.
  assert.equal(devRun.json.releaseId, null, "dev identity is NULL");
  assert.equal(stableRun.json.releaseId, rel.manifest.id, "stable identity is the selected release's manifest id");
  assert.notEqual(devRun.json.releaseId, stableRun.json.releaseId, "the two report DIFFERENT provenance");

  // ...and they are genuinely different runtimes, not one delegating to the other.
  assert.equal(devRun.json.release, null, "dev is not running inside a release");
  assert.equal(stableRun.json.release.id, rel.manifest.id, "stable is");
  assert.notEqual(devRun.json.pid, stableRun.json.pid);
});

test("FG-571 F25 MANDATORY MUTANT (EXECUTED): a forge-dev that delegates to the stable release goes RED — it would destroy the live-source loop", () => {
  // The hollow version the plan names: assert only "stable works" and a forge-dev that
  // silently execs the promoted release passes — while the developer can no longer run the
  // code they just edited. This mutant proves the F25 assertion actually catches it.
  promote({ home, candidate: rel.releaseDir });
  const dev = makeDevCheckout();
  writeFileSync(join(dev, "src", "cli", "index.ts"), "this is not valid typescript ((( <<< \n");

  const delegating = join(dev, "bin", "forge-dev-delegating");
  writeFileSync(delegating, `#!/bin/sh\nexec "\${FORGE_HOME}/current/forge" "$@"\n`);
  chmodSync(delegating, 0o755);

  const r = run(delegating, ["release", "provenance", "--json"], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    FORGE_HOME: home,
  });

  // RED against BOTH F25 assertions above:
  assert.equal(r.status, 0, "MUTANT: a delegating forge-dev SUCCEEDS against a broken checkout — the 'forge-dev must FAIL' assertion reddens");
  assert.equal(
    r.json.releaseId,
    rel.manifest.id,
    "MUTANT: it reports the STABLE release's identity, not null — the provenance-divergence assertion reddens too",
  );

  // The real forge-dev does neither: it runs the broken live source and dies there.
  const real = run(join(dev, "bin", "forge-dev"), ["release", "provenance", "--json"], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    FORGE_HOME: home,
  });
  assert.notEqual(real.status, 0, "the real forge-dev fails on the broken checkout — it never reaches for the release");
});

test("FG-571 F25: the split is INSTALLED only in a disposable prefix — no npm link, and the real shim/current pointer are untouched", () => {
  // The safety property this whole file depends on, asserted rather than assumed.
  assert.ok(shim.startsWith(workspace), "the shim under test lives in a disposable prefix");
  assert.ok(currentLinkIn(home).startsWith(home), "the current pointer under test lives in a disposable forge home");
  const realHome = join(process.env.HOME ?? "/nonexistent", ".forge");
  assert.ok(!shim.startsWith(realHome), "nothing was installed into the real forge home");
  assert.notEqual(home, realHome, "the tests never point FORGE_HOME at the operator's real forge home");
  // package.json declares forge-dev, so an EXPLICIT npm link would create the split on a
  // real machine. This suite never runs one.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.bin["forge-dev"], "./bin/forge-dev", "package.json declares the dev entry");
  assert.equal(pkg.bin["forge"], "./bin/forge", "and the existing entry is unchanged");
});
