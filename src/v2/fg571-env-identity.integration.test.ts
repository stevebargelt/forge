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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_EXEC_NAME, RELEASE_MANIFEST_NAME, SHIM_NAME, renderShim, thawReleaseTree, type BuildReleaseResult } from "./release.js";
import { atomicSymlinkSwap, installShim, promote } from "./promote.js";
import { currentLinkIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { canonicalMkdtemp, makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "./fg571-harness.js";

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

  workspace = canonicalMkdtemp("fg571-env-");
  home = canonicalMkdtemp("fg571-env-home-");
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

// F32 UNDER THE CORRECTIVE PASS — the contract is now TWO layers, and each is tested against
// the surface that actually owns it:
//
//   - THE SHIM owns the exported carrier. It reads the forge-authored canonical descriptor,
//     never the manifest, and refuses BY NAME on a missing or malformed one. So "a release that
//     cannot state who it is does not run" is enforced against the DESCRIPTOR.
//   - TRUSTED NODE owns authority. `forge-release.json` remains the only authority on what a
//     release IS, and it is parsed by exactly one parser. After startup, node-preflight
//     re-validates the id the shim carried in against the id the manifest states, and refuses
//     by name on a mismatch.
//
// So a poisoned MANIFEST is now a Node-layer refusal rather than a shim-layer one — the shim
// genuinely does not read the file, and pretending otherwise would be testing a fiction. The
// property the operator cares about is unchanged and still proven end-to-end from a RUNNING
// process: a release that cannot agree with itself about who it is does not run, and a caller's
// forged FORGE_RELEASE_ID never becomes provenance.

/** A PROPERLY PROMOTED unit in its own disposable home, whose published bytes a test then
 *  corrupts. Promoted for real — materialized, validated, descriptor authored, frozen — so the
 *  corruption below is a POST-promotion tamper of a legitimate release, which is the case that
 *  matters: "nothing else could have selected this" is not a property a launcher gets to assume,
 *  and neither is "nothing touched it after I validated it". */
function promotedHomeWith(name: string, mutate: (unitDir: string) => void): string {
  const h = canonicalMkdtemp(`fg571-f32-${name}-`);
  promote({ home: h, candidate: rel.releaseDir });
  const unit = realpathSync(currentLinkIn(h));
  thawReleaseTree(unit);
  mutate(unit);
  return h;
}

const poisonedEnvFor = (h: string) => ({
  PATH: nodeFreePath(),
  HOME: process.env.HOME ?? "/tmp",
  FORGE_HOME: h,
  FORGE_RELEASE_ID: "release-forged-by-the-caller",
});
const poisonedEnv = () => poisonedEnvFor(home);

test("FG-571 F32 (EXECUTED): poisoned FORGE_RELEASE_ID + a VALID manifest -> the forged value is IGNORED; the reported identity is the manifest's", () => {
  promote({ home, candidate: rel.releaseDir });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnv());
  assert.equal(r.status, 0, r.stderr);
  // Asserted FROM THE RUNNING PROCESS: this is the value everything forge starts records.
  assert.equal(r.json.releaseId, rel.manifest.id, "identity came from the manifest");
  assert.notEqual(r.json.releaseId, "release-forged-by-the-caller", "the caller's forged value did not survive");
});

// ── the SHIM's half: the descriptor is what it reads, so the descriptor is what it fails on ──

test("FG-571 F32 (EXECUTED): descriptor MISSING -> named error, FAIL CLOSED — not null, not the ambient value, not a silent run", () => {
  const h = promotedHomeWith("desc-missing", (unit) => rmSync(join(unit, RELEASE_EXEC_NAME), { force: true }));
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnvFor(h));
  assert.notEqual(r.status, 0, "a release that cannot state who it is does not run");
  assert.match(r.stderr, /refusing to run — this release carries no canonical execution descriptor/i, "the refusal is NAMED");
  assert.match(r.stderr, /expected descriptor: .*forge-exec/, "and says WHERE");
  assert.match(r.stderr, /running:\s+the machine-wide forge shim/, "and says what was running");
  assert.match(r.stderr, /Fix:/, "and how to fix it");
  assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
});

/** The descriptor's schema is EXACT — not "at least". Each of these is a distinct way to be
 *  wrong, and every one must be refused by name rather than tolerated or guessed at. */
const BAD_DESCRIPTORS: ReadonlyArray<{ name: string; bytes: (good: string) => string }> = [
  { name: "empty", bytes: () => "" },
  { name: "missing field (interpreter only)", bytes: (g) => `${g.split("\n")[0]}\n` },
  { name: "extra field", bytes: (g) => `${g}extra /tmp/attacker-node\n` },
  { name: "duplicate field", bytes: (g) => `${g.split("\n")[0]}\n${g.split("\n")[0]}\n` },
  { name: "wrong order", bytes: (g) => `${g.split("\n")[1]}\n${g.split("\n")[0]}\n` },
  { name: "wrong prefix", bytes: (g) => g.replace("interpreter ", "interpreterr "), },
  { name: "empty value", bytes: (g) => `interpreter \n${g.split("\n")[1]}\n` },
  { name: "unterminated final line (torn)", bytes: (g) => g.trimEnd() },
  // The character-set half: each of these is a shell metacharacter that must never reach the
  // exec, and each is refused as DATA rather than surviving to be evaluated as syntax.
  { name: "command substitution in the interpreter", bytes: (g) => `interpreter /tmp/$(touch /tmp/pwned)node\n${g.split("\n")[1]}\n` },
  { name: "backtick in the interpreter", bytes: (g) => `interpreter /tmp/\`id\`/node\n${g.split("\n")[1]}\n` },
  { name: "quote in the interpreter", bytes: (g) => `interpreter /tmp/"evil"/node\n${g.split("\n")[1]}\n` },
  { name: "whitespace in the interpreter", bytes: (g) => `interpreter /tmp/evil node\n${g.split("\n")[1]}\n` },
  { name: "non-absolute interpreter", bytes: (g) => `interpreter attacker-node\n${g.split("\n")[1]}\n` },
  { name: "metacharacter in the release id", bytes: (g) => `${g.split("\n")[0]}\nrelease $(touch /tmp/pwned)\n` },
];

for (const { name, bytes } of BAD_DESCRIPTORS) {
  test(`FG-571 F32 (EXECUTED): descriptor MALFORMED -> named error, fail closed — ${name}`, () => {
    const h = promotedHomeWith(`desc-${name.replace(/[^a-z]/gi, "")}`, (unit) => {
      const p = join(unit, RELEASE_EXEC_NAME);
      writeFileSync(p, bytes(readFileSync(p, "utf8")));
    });
    const r = run(shim, ["release", "provenance", "--json"], poisonedEnvFor(h));
    assert.notEqual(r.status, 0, `a ${name} descriptor does not run`);
    assert.match(r.stderr, /refusing to run — this release'?s? (execution descriptor|pinned interpreter)/i, "the refusal is NAMED");
    assert.match(r.stderr, /running:\s+the machine-wide forge shim/, "and says what was running");
    assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
  });
}

// ── trusted NODE's half: the manifest is the authority, re-validated after startup ──

test("FG-571 F32 (EXECUTED): manifest identity MISSING -> trusted Node refuses by name after startup, fail closed", () => {
  const h = promotedHomeWith("man-missing", (unit) => {
    const p = join(unit, RELEASE_MANIFEST_NAME);
    const m = JSON.parse(readFileSync(p, "utf8"));
    delete m.id;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnvFor(h));
  assert.notEqual(r.status, 0, "a release whose manifest states no identity does not run");
  assert.match(r.stderr, /refusing to run — this release's execution descriptor and its manifest disagree about its identity/i, "the refusal is NAMED");
  assert.match(r.stderr, /release manifest: .*forge-release\.json/, "and says WHERE");
  assert.match(r.stderr, /manifest id:\s+\(missing\)/, "and what the authority actually said");
  assert.match(r.stderr, /Fix:/, "and how to fix it");
  assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
});

test("FG-571 F32 (EXECUTED): manifest identity MALFORMED -> trusted Node refuses by name, fail closed", () => {
  const h = promotedHomeWith("man-malformed", (unit) => {
    const p = join(unit, RELEASE_MANIFEST_NAME);
    const m = JSON.parse(readFileSync(p, "utf8"));
    // An unquoted/numeric id. Guessing at it — or coercing it to a string and carrying on — is
    // exactly what fail-closed forbids: the manifest is the authority and it is not stating a
    // release identity.
    writeFileSync(p, JSON.stringify({ ...m, id: 12345 }, null, 2) + "\n");
  });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnvFor(h));
  assert.notEqual(r.status, 0, "a malformed identity does not run");
  assert.match(r.stderr, /refusing to run — this release's execution descriptor and its manifest disagree about its identity/i, "the refusal is NAMED");
  assert.match(r.stderr, /manifest id:\s+12345/, "and names what the manifest said");
  assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
});

test("FG-571 F32 (EXECUTED): manifest UNREADABLE -> named error, fail closed", () => {
  const h = promotedHomeWith("man-unreadable", (unit) => chmodSync(join(unit, RELEASE_MANIFEST_NAME), 0o000));
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnvFor(h));
  assert.notEqual(r.status, 0, "an unreadable manifest does not run");
  assert.match(r.stderr, /refusing to run — this release's manifest is unreadable/i, "the refusal is NAMED");
  assert.doesNotMatch(r.stdout, /release-forged-by-the-caller/, "the ambient value was not used");
});

test("FG-571 F32 (EXECUTED): a descriptor id that DISAGREES with the manifest is refused — the manifest is the authority", () => {
  // Neither half is malformed. Both are well-formed and they simply disagree, which is precisely
  // the shape a divergence attack produces: the launcher carries in one identity while the
  // authority states another. There is no reconciling this — it is a refusal.
  const h = promotedHomeWith("desc-disagrees", (unit) => {
    const p = join(unit, RELEASE_EXEC_NAME);
    writeFileSync(p, readFileSync(p, "utf8").replace(/^release .*$/m, "release release-a-different-identity"));
  });
  const r = run(shim, ["release", "provenance", "--json"], poisonedEnvFor(h));
  assert.notEqual(r.status, 0, "a release that cannot agree with itself about who it is does not run");
  assert.match(r.stderr, /refusing to run — this release's execution descriptor and its manifest disagree about its identity/i);
  assert.match(r.stderr, /launched as:\s+"release-a-different-identity"/, "it names the identity the launcher carried in");
  assert.match(r.stderr, new RegExp(`manifest id:\\s+"${rel.manifest.id}"`), "and the identity the authority states");
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

/** Install a shim text into its own disposable prefix and return the path. */
function mutantShim(label: string, text: string): string {
  const p = join(mkdtempSync(join(workspace, `f32-${label}-`)), "forge");
  writeFileSync(p, text);
  chmodSync(p, 0o755);
  return p;
}

test("FG-571 F32 MANDATORY MUTANT (EXECUTED): drop the unset AND the Node re-validation -> the forged id IS recorded as provenance", () => {
  // FG-569's shipped entry exported FORGE_RELEASE_ID only when its read FOUND an id; when it
  // yielded nothing, a CALLER-SUPPLIED value SURVIVED and became this release's provenance.
  //
  // Reopening that spoof now takes removing BOTH halves of the contract, and that is the
  // finding — not a weakness of the mutant. The shim half (unset the ambient carrier, export
  // the descriptor's id) and the Node half (re-validate the carried id against the manifest)
  // each independently stop it, so the mutant disables both to show what they are jointly
  // holding closed. The single-half mutants below prove neither is decorative.
  const withAmbientLive = renderShim()
    .replace(" FORGE_RELEASE_ID\n", "\n") // drop it from the sanitize list
    .replace("FORGE_RELEASE_ID=$__forge_release\nexport FORGE_RELEASE_ID", ":"); // ...and never set it from the descriptor
  assert.ok(!/unset .*FORGE_RELEASE_ID/.test(withAmbientLive), "the mutant genuinely no longer unsets the ambient carrier");
  assert.ok(!/FORGE_RELEASE_ID=\$__forge_release/.test(withAmbientLive), "and genuinely no longer exports the descriptor's id");

  // The Node half, disabled inside the release's OWN source — the release ships src/, so this
  // is the shipped preflight the promoted unit actually runs.
  const h = promotedHomeWith("mutant-both", (unit) => {
    const p = join(unit, "src", "cli", "node-preflight.ts");
    const src = readFileSync(p, "utf8");
    const call = "  const identity = checkReleaseIdentity(found, process.env.FORGE_RELEASE_ID);";
    assert.ok(src.includes(call), "the shipped preflight no longer re-validates identity — this mutant is stale");
    writeFileSync(p, src.replace(call, "  const identity = { ok: true } as const;"));
  });

  const r = run(mutantShim("mutant-both", withAmbientLive), ["release", "provenance", "--json"], poisonedEnvFor(h));
  // RED: it RUNS, and it records the caller's forged identity as this release's provenance.
  assert.equal(r.status, 0, `MUTANT: the release runs instead of refusing: ${r.stderr}`);
  assert.equal(
    r.json.releaseId,
    "release-forged-by-the-caller",
    "MUTANT: the caller's forged FORGE_RELEASE_ID SURVIVED and is now this process's provenance — the spoof FG-571 closes",
  );

  // ...and the REAL shim, on the very same release, ignores the forged value entirely.
  const real = run(shim, ["release", "provenance", "--json"], poisonedEnvFor(h));
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.json.releaseId, rel.manifest.id, "the fixed shim reports the release's OWN identity");
});

test("FG-571 F32 MANDATORY MUTANT (EXECUTED): drop ONLY the shim's unset -> trusted Node alone still refuses the spoof", () => {
  // Half the mutant above. The ambient carrier survives the sanitizer, but the shim still
  // overwrites it from the descriptor AND Node still re-validates — so the spoof dies anyway.
  // This is what proves the Node-side re-validation is load-bearing rather than ceremony: it
  // catches a carrier the shell layer let through.
  const noUnset = renderShim()
    .replace(" FORGE_RELEASE_ID\n", "\n")
    .replace("FORGE_RELEASE_ID=$__forge_release\nexport FORGE_RELEASE_ID", ":");
  const h = promotedHomeWith("mutant-shim-only", () => {});
  const r = run(mutantShim("shim-only", noUnset), ["release", "provenance", "--json"], poisonedEnvFor(h));
  assert.notEqual(r.status, 0, "the forged carrier is refused by the Node layer even with the shim's guard gone");
  assert.match(r.stderr, /execution descriptor and its manifest disagree about its identity/i);
  assert.match(r.stderr, /launched as:\s+"release-forged-by-the-caller"/, "and it names the caller's forged value as what came in");
});

test("FG-571 F32 MANDATORY MUTANT (EXECUTED): degrade a missing descriptor to null-and-continue -> the fail-closed cases go RED", () => {
  // The other half of the ORIGINAL contract. Unsetting the ambient carrier alone stops the
  // spoof but silently degrades a real release's provenance to "unknown" — trading a spoofing
  // bug for a correctness bug. This mutant keeps the unset and drops ONLY the shim's
  // descriptor-missing refusal, so a release that cannot state who it is runs anyway with null
  // provenance. The descriptor-missing cell above must redden against it, which is what proves
  // the refusal (not just the unset) is doing work.
  const real = renderShim();
  const refusal = real.indexOf('if [ ! -r "$__forge_d" ]; then');
  const refusalEnd = real.indexOf("\nfi\n", refusal) + "\nfi".length;
  assert.ok(refusal > 0 && refusalEnd > refusal, "located the descriptor-missing refusal in the real shim");
  const nullAndContinue = real.slice(0, refusal) + 'if [ ! -r "$__forge_d" ]; then\n  exec "$0-never" "$@"' + real.slice(refusalEnd);

  const h = promotedHomeWith("mutant-null", (unit) => rmSync(join(unit, RELEASE_EXEC_NAME), { force: true }));
  const r = run(mutantShim("null-continue", nullAndContinue), ["release", "provenance", "--json"], poisonedEnvFor(h));
  // RED: no NAMED refusal. Instead of telling the operator what is wrong and how to fix it, the
  // mutant dies in whatever way the missing file happens to produce — which is exactly the
  // "degrades instead of refusing" failure the named guard exists to prevent.
  assert.doesNotMatch(r.stderr, /refusing to run — this release carries no canonical execution descriptor/, "MUTANT: no named refusal");
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
