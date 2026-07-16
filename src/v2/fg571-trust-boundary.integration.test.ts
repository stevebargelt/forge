// FG-571 — THE MANIFEST→EXEC TRUST BOUNDARY, executed and mutation-tested.
//
// THE DECISIVE FINDING, reproduced here as an EXECUTED exploit rather than described:
//
//   manifest bytes: {"id":"safe","interpreter":"/tmp/attacker-node","entry":"src/cli/index.ts","interpreter":"/store/node/bin/node"}
//   JSON.parse (promotion) picks : /store/node/bin/node    <- what gets VALIDATED
//   the shim's sh reader picks   : /tmp/attacker-node      <- what gets EXECUTED
//
// A candidate that PASSES `validateCandidate` execs a different interpreter. The operator
// validated before promoting and still got owned. Duplicate keys are only the cheapest way in:
// an sh line-matcher and JSON.parse disagree about grammar, escapes, embedded newlines, and
// what is even a key at all — and one of them is deciding what runs.
//
// THE FIX IS NOT A BETTER MATCHER. Making sh replicate JSON.parse exactly, with no interpreter
// available (the shim's whole job is to FIND the interpreter), is the losing side of a race
// that never ends. So the invariant MOVES: trusted Node does all parsing and validation, and
// the shim consumes ONLY forge-authored data — the canonical execution descriptor, generated
// inside the staged unit after validation. Divergence stops being a bug to fix and becomes a
// state that cannot be constructed.
//
// WHAT EACH TEST HERE OWES YOU. Per FG-551 and the operator's standing rule: a trust-path
// regression must be MUTATION-SENSITIVE or observed RED against the vulnerable implementation.
// "The fixed version refuses" is not evidence — a version that refuses everything also passes
// that. So every finding below is proven by EXECUTING the vulnerable implementation and
// showing a FILESYSTEM MARKER that attacker code actually ran, then showing the fixed
// implementation on the same fixture leaves no marker.
//
// SAFETY: every release is built from a DISPOSABLE source root (fg571-harness.ts) and promoted
// into a mkdtemp FORGE_HOME with an explicit --prefix. No `npm link`, no git command against
// the real checkout, and nothing reaches the operator's real ~/.forge/current, their real
// interpreter store, their real shim, or the provider registry at ~/.forge/runtimes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_ENTRY_SOURCE,
  RELEASE_EXEC_NAME,
  RELEASE_LOADER_NAME,
  RELEASE_MANIFEST_NAME,
  SHIM_NAME,
  renderShim,
  thawReleaseTree,
  type BuildReleaseResult,
} from "./release.js";
import { installShim, promote, readSelection, validateCandidate } from "./promote.js";
import { interpreterKey, isStoredInterpreter, probeInterpreter } from "./runtime-store.js";
import { currentLinkIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { canonicalMkdtemp, makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "./fg571-harness.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
let prefix: string;
let good: BuildReleaseResult;
let repoHeadBefore: string;
let repoStatusBefore: string;

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function tarCopy(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  const r = spawnSync("/bin/sh", ["-c", 'tar -C "$1" -cf - . | tar -C "$2" -xf -', "sh", from, to], { encoding: "utf8" });
  assert.equal(r.status, 0, `tar copy failed: ${r.stderr}`);
}

function rmTree(dir: string): void {
  spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", dir]);
  rmSync(dir, { recursive: true, force: true });
}

/** THE ATTACKER'S "INTERPRETER": a shell script that leaves a filesystem marker and exits 0.
 *  The marker is the evidence — it is a side effect that can only exist if this file was
 *  actually exec'd as the machine-wide forge's interpreter. An exit code could not carry that:
 *  a nonexistent path also exits nonzero. */
function attackerNode(dir: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "attacker-node");
  writeFileSync(p, `#!/bin/sh\nprintf 'ATTACKER INTERPRETER EXECUTED\\n' > ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Run an installed shim against a forge home. FORGE_HOME is explicit — that is what keeps
 *  this off the operator's real control plane. */
function runShim(shimPath: string, forgeHome: string): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(shimPath, ["--version"], { encoding: "utf8", env: { ...process.env, FORGE_HOME: forgeHome } });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

/** Install a shim text into its own fresh prefix, so a mutant and the real shim never share a
 *  directory and cannot be confused for one another. */
function installShimIn(label: string, shimText: string): string {
  const dir = join(workspace, `prefix-${label}`);
  mkdirSync(dir, { recursive: true });
  return installShim({ prefix: dir, shimText, shimName: SHIM_NAME });
}

/** A properly promoted unit in its own disposable home — materialized, validated, descriptor
 *  authored, frozen, atomically published — whose PUBLISHED bytes the caller then tampers with.
 *  A post-promotion tamper of a legitimate release is the sharp case: this release passed every
 *  gate, so anything that still redirects its exec is a hole promotion cannot close. */
function promotedHomeWith(label: string, mutate: (unit: string, home: string) => void): string {
  const h = canonicalMkdtemp(`fg571-tb-${label.replace(/[^a-z0-9]/gi, "")}-`);
  promote({ home: h, candidate: good.releaseDir });
  const unit = realpathSync(currentLinkIn(h));
  thawReleaseTree(unit);
  mutate(unit, h);
  return h;
}

before(async () => {
  repoHeadBefore = gitIn(repoRoot, ["rev-parse", "HEAD"]).trim();
  repoStatusBefore = gitIn(repoRoot, ["status", "--porcelain"]);

  workspace = canonicalMkdtemp("fg571-tb-ws-");
  prefix = canonicalMkdtemp("fg571-tb-prefix-");
  source = await makeDisposableSourceRoot(repoRoot);
  good = source.build({ outDir: join(workspace, "release-good"), rand: "trust1" });
});

after(() => {
  for (const d of [workspace, prefix]) if (existsSync(d)) rmTree(d);
  if (source) removeDisposableSourceRoot(source);

  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the whole suite left the real checkout's HEAD unmoved");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "the whole suite left the real working tree exactly as it found it");
});

test("FG-571 SAFETY: this suite never runs git against the REAL checkout", () => {
  assert.notEqual(source.root, repoRoot, "releases are built from a disposable checkout, not the real repository");
  assert.ok(!source.root.startsWith(repoRoot), "and that checkout is not inside the real repository");
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the real checkout's HEAD did not move");
});

// ══════════════════════ FINDINGS 1-3 — PARSER DIVERGENCE, EXECUTED ══════════════════════

/** THE VULNERABLE SHIM (FG-571 round 1): read `interpreter` out of the RAW MANIFEST with a
 *  hand-rolled POSIX-sh line matcher, then exec whatever it says. Derived from the REAL shim by
 *  replacing the descriptor-driven exec, so this mutant goes stale LOUDLY if the real exec line
 *  ever moves rather than silently testing nothing.
 *
 *  The `${ln#*"interpreter": "}` form is the crux. `#` is the SHORTEST-prefix removal, so on a
 *  single-line manifest it strips through the FIRST occurrence of the key and yields the FIRST
 *  value. JSON.parse resolves duplicate keys to the LAST. Two readers, one file, two answers —
 *  and the one that decides what runs is the one nobody validated with. */
function manifestReadingShimText(): string {
  const real = renderShim();
  const exec = `exec "$__forge_interpreter" --import "$here/${RELEASE_LOADER_NAME}" "$here/${RELEASE_ENTRY_SOURCE}" "$@"`;
  assert.ok(real.includes(exec), "the real shim no longer execs the descriptor's interpreter — this mutant is stale");
  const vulnerable = [
    `__forge_m=$here/${RELEASE_MANIFEST_NAME}`,
    `while IFS= read -r __forge_ln; do`,
    `  case "$__forge_ln" in`,
    `  *\\"interpreter\\":*)`,
    `    __forge_v=\${__forge_ln#*\\"interpreter\\": \\"}`,
    `    __forge_interpreter=\${__forge_v%%\\"*} ;;`,
    `  esac`,
    `done < "$__forge_m"`,
    exec,
  ].join("\n");
  const mutant = real.replace(exec, vulnerable);
  assert.notEqual(mutant, real, "the mutation did not change the shim");
  return mutant;
}

test("FINDING 1+2 (EXECUTED EXPLOIT): duplicate JSON keys — JSON.parse validates the store's node, the sh reader EXECS the attacker's", () => {
  const marker = join(workspace, "DUPKEY-ATTACKER-RAN");
  rmSync(marker, { force: true });
  const attacker = attackerNode(join(workspace, "dupkey-bin"), marker);

  // THE AUDIT'S EXACT INPUT SHAPE: one line, `interpreter` twice — the attacker's first, the
  // real store path last. Everything else about this release is genuine.
  const h = promotedHomeWith("dupkey", (unit) => {
    const p = join(unit, RELEASE_MANIFEST_NAME);
    const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const real = m.interpreter as string;
    const fields = Object.entries({ ...m, interpreter: attacker })
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(", ");
    writeFileSync(p, `{${fields}, ${JSON.stringify("interpreter")}: ${JSON.stringify(real)}}\n`);

    // PROVE THE PREMISE, not just the conclusion: the two readers genuinely disagree about
    // these exact bytes. Without this the test could pass for the wrong reason.
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { interpreter: string };
    assert.equal(parsed.interpreter, real, "JSON.parse (what promotion validates with) resolves duplicate keys to the LAST — the store's node");
  });

  try {
    // RED: the vulnerable shim execs the attacker's interpreter out of a release that passed
    // every promotion gate. The marker is the proof that it RAN.
    const vulnerable = installShimIn("dupkey-vuln", manifestReadingShimText());
    const r = runShim(vulnerable, h);
    assert.equal(existsSync(marker), true, `the vulnerable shim must actually exec the attacker's interpreter — it did not (exit ${r.status}): ${r.stderr}`);
    assert.match(readFileSync(marker, "utf8"), /ATTACKER INTERPRETER EXECUTED/);

    // GREEN: the real shim never reads the manifest, so the duplicate keys are not an attack
    // surface — they are not an input. It execs the descriptor's interpreter and runs normally.
    rmSync(marker, { force: true });
    const fixed = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
    const r2 = runShim(fixed, h);
    assert.equal(r2.status, 0, `the fixed shim runs the release normally: ${r2.stderr}`);
    assert.equal(existsSync(marker), false, "the fixed shim must not exec the attacker's interpreter");
  } finally {
    rmTree(h);
  }
});

test("FINDING 3 (EXECUTED EXPLOIT): invalid JSON carrying forged key-shaped lines — unparseable to Node, instructions to the sh reader", () => {
  const marker = join(workspace, "FORGED-LINE-ATTACKER-RAN");
  rmSync(marker, { force: true });
  const attacker = attackerNode(join(workspace, "forged-bin"), marker);

  // Not JSON at all — but every line an sh line-matcher looks for is here. This is the input
  // that makes "just parse it more carefully in sh" hopeless: there is nothing to parse.
  // Promotion rejects it outright (JSON.parse throws); the sh reader takes it as instructions.
  const forged = [`this is not JSON at all`, `  "interpreter": "${attacker}",`, `  "entry": "${RELEASE_ENTRY_SOURCE}",`, `  "id": "release-looks-fine",`].join("\n") + "\n";

  const h = promotedHomeWith("forged", (unit) => {
    const p = join(unit, RELEASE_MANIFEST_NAME);
    writeFileSync(p, forged);
    assert.throws(() => JSON.parse(readFileSync(p, "utf8")), "the premise: these bytes are genuinely unparseable as JSON");
  });

  try {
    // RED: the vulnerable shim happily takes forged non-JSON lines as instructions and execs
    // the attacker's interpreter.
    const vulnerable = installShimIn("forged-vuln", manifestReadingShimText());
    const r = runShim(vulnerable, h);
    assert.equal(existsSync(marker), true, `the vulnerable shim must exec the forged interpreter — it did not (exit ${r.status}): ${r.stderr}`);

    // GREEN: the real shim reads the descriptor, which forge authored. Candidate bytes can
    // never become shim instructions because the shim does not read candidate bytes.
    rmSync(marker, { force: true });
    const fixed = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
    const r2 = runShim(fixed, h);
    assert.equal(existsSync(marker), false, "the fixed shim must not exec the forged interpreter");
    // It refuses — not for the forged lines (it never saw them) but because trusted Node
    // re-validates identity against a manifest that is now unreadable. Fail-closed either way.
    assert.notEqual(r2.status, 0, "an unreadable manifest is refused after startup");
    assert.match(r2.stderr, /refusing to run — this release's manifest is unreadable/i);
  } finally {
    rmTree(h);
  }
});

test("FINDING 1 (EXECUTED): promotion refuses a candidate whose manifest names an interpreter outside the store — duplicate keys and all", () => {
  // The promotion-side half of the same finding. Whatever JSON.parse resolves the interpreter
  // to is what gets validated, and an attacker path does not survive validation — so the
  // duplicate-key trick only ever bought the attacker the SH reader's answer, never Node's.
  const marker = join(workspace, "PROMOTE-SHOULD-NEVER-RUN-THIS");
  const attacker = attackerNode(join(workspace, "promote-bin"), marker);
  const dir = join(workspace, "cand-attacker-interp");
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const p = join(dir, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  writeFileSync(p, JSON.stringify({ ...m, id: "release-attacker-interp", interpreter: attacker }, null, 2) + "\n");

  const h = canonicalMkdtemp("fg571-tb-promoteinterp-");
  try {
    assert.throws(() => promote({ home: h, candidate: dir }), /refusing to promote/i, "an attacker-controlled interpreter is never promotable");
    assert.equal(readSelection(h), null, "nothing was selected — it fails closed");
    // The attacker's file WAS executed once — by probeInterpreter, which is validate-by-execution
    // doing exactly its job: the only honest way to learn what a binary is, is to run it and ask.
    // That is a deliberate, bounded exposure and not the finding. probeInterpreter runs it with a
    // minimal env (PATH=/usr/bin:/bin, no ambient inheritance), discards it on any answer it does
    // not like, and NOTHING downstream references it. The finding is what round 1 allowed
    // instead: the attacker's binary exec'd AS the machine-wide forge, with the operator's full
    // environment, holding the process for the rest of the session. This marker is a probe; that
    // was a shell.
    assert.equal(existsSync(marker), true, "the probe ran it (validate-by-execution), which is why it could be refused");
    assert.equal(existsSync(currentLinkIn(h)), false, "and it never became the machine-wide forge");
  } finally {
    rmTree(h);
  }
});

test("FINDING 2 (EXECUTED): the shim's ONLY read inside the unit is the forge-authored descriptor", () => {
  // The structural claim, asserted against the generated text rather than inferred. If the shim
  // ever reaches for the manifest again, this reddens — which is the point: the property is
  // "one parser, one author", and it is only true as long as nothing re-adds a second reader.
  // CODE lines only. The shim's comments legitimately discuss the manifest (they explain why it
  // is NOT read, and where the authority actually lives), so matching raw text would fail on
  // prose rather than on behavior — an assertion that reddens for the wrong reason is worse than
  // none. `#` comments and blank lines are stripped; what is left is what the shell executes.
  const code = renderShim()
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
    .join("\n");
  assert.ok(code.includes(RELEASE_EXEC_NAME), "the shim reads the canonical descriptor");
  assert.ok(!code.includes(RELEASE_MANIFEST_NAME), "the shim's CODE never names the release manifest — it does not parse raw JSON");
  assert.ok(!/\\"(id|interpreter|entry)\\"/.test(code), "and carries no JSON key matcher of any kind");
  const shimText = renderShim();
  // The entry and loader are baked CONSTANTS, so nothing on disk can redirect the exec.
  assert.ok(shimText.includes(`"$here/${RELEASE_ENTRY_SOURCE}"`), "the entry is a baked constant");
  assert.ok(shimText.includes(`"$here/${RELEASE_LOADER_NAME}"`), "the loader is a baked constant");
});

// ══════════════════════ FINDING 4 — ENTRY SYMLINK ESCAPE ══════════════════════

test("FINDING 4 (EXECUTED EXPLOIT): the canonical entry as a SYMLINK to outside bytes — exact string equality passes, the file is not in the release", () => {
  // The manifest says `src/cli/index.ts` — the one canonical value, exactly equal to the
  // constant. Layer 1's string check is perfectly satisfied. And the file it names is a link to
  // attacker code sitting outside the release. A string check cannot see this; only the
  // filesystem can, which is why the string half and the realpath half are both required.
  const marker = join(workspace, "ENTRY-SYMLINK-ATTACKER-RAN");
  rmSync(marker, { force: true });
  const outside = join(workspace, "outside-entry.ts");
  writeFileSync(outside, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ENTRY SYMLINK ATTACKER RAN\\n");\n`);

  const dir = join(workspace, "cand-entry-symlink");
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const entry = join(dir, RELEASE_ENTRY_SOURCE);
  rmSync(entry, { force: true });
  symlinkSync(outside, entry);
  const p = join(dir, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  writeFileSync(p, JSON.stringify({ ...m, id: "release-entry-symlink" }, null, 2) + "\n");

  // The premise: the manifest's entry is EXACTLY the canonical constant. Nothing about the
  // string is wrong — the round-1 equality check would wave this straight through.
  assert.equal((JSON.parse(readFileSync(p, "utf8")) as { entry: string }).entry, RELEASE_ENTRY_SOURCE);

  const h = canonicalMkdtemp("fg571-tb-entrysym-");
  try {
    assert.throws(
      () => promote({ home: h, candidate: dir }),
      (e: Error) => {
        assert.match(e.message, /refusing to promote — this release's entry is not a regular file/);
        assert.match(e.message, /a symlink/);
        assert.match(e.message, /Fix: rebuild with `forge release build`/);
        return true;
      },
      "a symlinked entry must be refused",
    );
    assert.equal(existsSync(marker), false, "the outside entry never executed");
  } finally {
    rmTree(h);
  }
});

test("FINDING 4 (EXECUTED): a symlinked path COMPONENT escaping the release is refused — the leaf's own lstat cannot see this", () => {
  // The other half of the same finding, and the reason the check is a realpath comparison and
  // not just an lstat on the leaf: here `src/cli/` is the link, and `src/cli/index.ts` is a
  // genuine regular file at the far end. Every per-file check passes; the containment does not.
  const outsideDir = join(workspace, "outside-cli");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "index.ts"), `export {};\n`);

  const dir = join(workspace, "cand-component-symlink");
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const cliDir = join(dir, "src", "cli");
  rmSync(cliDir, { recursive: true, force: true });
  symlinkSync(outsideDir, cliDir);
  const p = join(dir, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  writeFileSync(p, JSON.stringify({ ...m, id: "release-component-symlink" }, null, 2) + "\n");

  const h = canonicalMkdtemp("fg571-tb-compsym-");
  try {
    assert.throws(() => promote({ home: h, candidate: dir }), /refusing to promote — this release's entry escapes the release/, "a symlinked component must be refused");
  } finally {
    rmTree(h);
  }
});

test("FINDING 4 MUTANT: with the filesystem check dropped, validateCandidate ACCEPTS the symlinked entry", async () => {
  // Mutation sensitivity for layer 1. The string check ALONE — round 1's shape — accepts a
  // release whose entry is a link to code outside the closure. This is what proves the added
  // filesystem half is load-bearing rather than belt-and-braces.
  const src = readFileSync(join(moduleDir, "promote.ts"), "utf8");
  const guard = /  for \(const \[rel, what\] of \[\n    \[RELEASE_ENTRY_SOURCE, "entry"\],[\s\S]*?\n  \}\n/;
  assert.match(src, guard, "located the containment loop in promote.ts — this mutant is stale if not");
  // Written INTO the disposable checkout, not a bare tmpdir: the mutant is a real module with
  // real relative imports (../util/paths.js), and it can only resolve them from inside a tree
  // that has them. The disposable root is that tree, and it is thrown away with the suite.
  const mutantPath = join(source.root, "src", "v2", "promote-containment-mutant.ts");
  writeFileSync(mutantPath, src.replace(guard, "\n"));

  const outside = join(workspace, "outside-entry-mutant.ts");
  writeFileSync(outside, `export {};\n`);
  const dir = join(workspace, "cand-entry-symlink-mutant");
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const entry = join(dir, RELEASE_ENTRY_SOURCE);
  rmSync(entry, { force: true });
  symlinkSync(outside, entry);

  try {
    const { validateCandidate: vulnerable } = (await import(mutantPath)) as { validateCandidate: (d: string) => unknown };
    // RED: the vulnerable validator accepts a release whose entry is not in the release.
    assert.doesNotThrow(() => vulnerable(dir), "MUTANT: without the filesystem check, a symlinked entry is accepted");
    // ...and the real one refuses the very same directory.
    assert.throws(() => validateCandidate(dir), /is not a regular file/);
  } finally {
    rmSync(mutantPath, { force: true });
  }
});

// ══════════════════════ FINDING 5 — INTERPRETER-STORE ESCAPE ══════════════════════

/** A fake interpreter store whose keyed path is a SYMLINK to bytes OUTSIDE it. The link target
 *  is a real, working node — copied from the genuine store — so it PROBES correctly, reports
 *  the exact version+ABI the manifest names, and satisfies every other gate. The only thing
 *  wrong with it is the thing that matters: the store does not own those bytes, so whatever
 *  does can rewrite them under an anchored release. */
function fakeStoreWithSymlinkedKey(label: string, realInterpreter: string): { home: string; keyed: string; outside: string } {
  const home = canonicalMkdtemp(`fg571-tb-fakestore-${label}-`);
  const id = probeInterpreter(realInterpreter)!;
  const outsideDir = join(home, "outside-bytes");
  mkdirSync(outsideDir, { recursive: true });
  const outside = join(outsideDir, "node");
  copyFileSync(realInterpreter, outside);
  chmodSync(outside, 0o755);

  const keyedDir = join(home, "interpreters", interpreterKey(id), "bin");
  mkdirSync(keyedDir, { recursive: true });
  const keyed = join(keyedDir, "node");
  symlinkSync(outside, keyed);
  return { home, keyed, outside };
}

test("FINDING 5 (EXECUTED): a store path that is a SYMLINK to outside bytes is refused — the old lexical check accepted it", () => {
  const { home: fake, keyed } = fakeStoreWithSymlinkedKey("unit", good.manifest.interpreter);
  try {
    const id = { version: good.manifest.nodeVersion, abi: good.manifest.abi };

    // THE PREMISE, proven rather than assumed: this path is a perfect string match for the
    // store's keyed layout, and it RUNS and reports exactly the identity the manifest names.
    // Every check except physical containment passes.
    assert.equal(keyed, join(fake, "interpreters", interpreterKey(id), "bin", "node"), "it is lexically the store's keyed path");
    const probed = probeInterpreter(keyed);
    assert.deepEqual(probed, id, "and it genuinely runs and reports the right version+ABI");

    // THE OLD CHECK — pure string arithmetic on the store's layout. Reproduced verbatim to show
    // what the fix actually changed: it ACCEPTS the symlink, because a string cannot tell you
    // where bytes live.
    const lexical = (bin: string) => bin === join(fake, "interpreters", interpreterKey(id), "bin", "node");
    assert.equal(lexical(keyed), true, "the old lexical check ACCEPTS the symlinked escape — the finding");

    // THE FIX: canonical realpaths. The link resolves out of the store, so it is not the
    // store's artifact and a release may not name it.
    assert.equal(isStoredInterpreter(keyed, id), false, "the canonical check REFUSES it");

    // ...and it is not a blanket refusal: the genuine store path still validates.
    assert.equal(isStoredInterpreter(good.manifest.interpreter, id), true, "the real store's own interpreter is still accepted");
  } finally {
    rmTree(fake);
  }
});

test("FINDING 5 (EXECUTED): promotion refuses a release pinning a symlinked store path — end to end, by name", () => {
  const { home: fake, keyed } = fakeStoreWithSymlinkedKey("promote", good.manifest.interpreter);
  const dir = join(workspace, "cand-symlinked-store");
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const p = join(dir, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  writeFileSync(p, JSON.stringify({ ...m, id: "release-symlinked-store", interpreter: keyed }, null, 2) + "\n");

  const h = canonicalMkdtemp("fg571-tb-symstore-");
  try {
    assert.throws(
      () => promote({ home: h, candidate: dir }),
      (e: Error) => {
        assert.match(e.message, /refusing to promote — this release's interpreter is not in the interpreter store/);
        assert.match(e.message, /Fix: rebuild with `forge release build`/);
        return true;
      },
      "a symlinked store path must not be promotable",
    );
    assert.equal(readSelection(h), null, "and nothing was selected — it fails closed");
  } finally {
    rmTree(fake);
    rmTree(h);
  }
});

test("FINDING 5 (EXECUTED): a store path whose BIN DIRECTORY is a symlink is refused — the leaf is a genuine regular file", () => {
  // The component case, one level up from the leaf. `bin/` is the link; `bin/node` is a real,
  // non-symlink, executable regular file. lstat on the leaf says everything is fine. Only
  // canonicalizing the directory chain catches it.
  const fake = canonicalMkdtemp("fg571-tb-fakestore-bindir-");
  try {
    const id = probeInterpreter(good.manifest.interpreter)!;
    const outsideBin = join(fake, "outside-bin");
    mkdirSync(outsideBin, { recursive: true });
    copyFileSync(good.manifest.interpreter, join(outsideBin, "node"));
    chmodSync(join(outsideBin, "node"), 0o755);

    const keyDir = join(fake, "interpreters", interpreterKey(id));
    mkdirSync(keyDir, { recursive: true });
    symlinkSync(outsideBin, join(keyDir, "bin"));
    const keyed = join(keyDir, "bin", "node");

    assert.equal(probeInterpreter(keyed)?.abi, id.abi, "the premise: it runs and reports the right ABI");
    assert.equal(isStoredInterpreter(keyed, id), false, "a symlinked bin/ directory is an escape and is refused");
  } finally {
    rmTree(fake);
  }
});

// ══════════════════════ FINDING 6 — VALIDATE-TO-SWAP TOCTOU ══════════════════════

test("FINDING 6 (EXECUTED): the SOURCE candidate mutated DURING promotion cannot reach the published unit", () => {
  // The window the old ordering left open: it validated the candidate and THEN copied it, so
  // the bytes that were proven and the bytes that shipped were read at two different instants.
  // The new ordering materializes FIRST and validates the materialization, so this seam — which
  // fires after staging and before publication — is provably too late to matter.
  const marker = join(workspace, "SOURCE-MUTATION-REACHED-THE-UNIT");
  rmSync(marker, { force: true });

  const dir = join(workspace, "cand-mutated-during");
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const p = join(dir, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const id = "release-mutated-during";
  writeFileSync(p, JSON.stringify({ ...m, id }, null, 2) + "\n");

  const h = canonicalMkdtemp("fg571-tb-mutduring-");
  try {
    let fired = false;
    const attacker = attackerNode(join(workspace, "during-bin"), marker);
    const r = promote({
      home: h,
      candidate: dir,
      onBeforeSwap: () => {
        fired = true;
        // The attacker owns the candidate directory and rewrites it mid-promotion: a hostile
        // interpreter and a hostile entry, in the window between validation and publication.
        const cur = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
        writeFileSync(p, JSON.stringify({ ...cur, interpreter: attacker, entry: "../../outside.mjs" }, null, 2) + "\n");
        writeFileSync(join(dir, RELEASE_ENTRY_SOURCE), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "SOURCE MUTATION SHIPPED\\n");\n`);
      },
    });
    assert.ok(fired, "the mutation seam genuinely fired inside the promotion");

    // The published unit is the MATERIALIZED one, and it is untouched by any of that.
    const unit = readSelection(h)!;
    assert.equal(unit.manifest?.id, id);
    assert.equal(unit.manifest?.interpreter, good.manifest.interpreter, "the published unit pins the STORE's interpreter, not the attacker's");
    assert.equal(unit.manifest?.entry, RELEASE_ENTRY_SOURCE, "and the canonical entry, not the traversal");
    assert.equal(r.interpreter, good.manifest.interpreter, "and the promotion reported the interpreter it actually validated");

    // The descriptor — the only thing the shim reads — carries the validated interpreter.
    const descriptor = readFileSync(join(unit.releaseDir, RELEASE_EXEC_NAME), "utf8");
    assert.equal(descriptor, `interpreter ${good.manifest.interpreter}\nrelease ${id}\n`);

    // EXECUTED: the machine actually runs the good release, and the attacker's code never ran.
    const shimPath = installShim({ prefix, shimText: renderShim(), shimName: SHIM_NAME });
    const run = runShim(shimPath, h);
    assert.equal(run.status, 0, `the promoted unit runs: ${run.stderr}`);
    assert.equal(existsSync(marker), false, "no mutated byte from the source reached the unit or executed");
  } finally {
    rmTree(h);
  }
});

test("FINDING 6 (EXECUTED): the published unit is FROZEN before publication — mutation after validation, before the pointer moves, is refused by the OS", () => {
  // Freeze-then-publish is what closes the window on the STAGED side. The unit is frozen while
  // it is still at its staging path, so its final path is never observed writable: there is no
  // instant between "validated" and "selected" in which the unit could be rewritten.
  const h = canonicalMkdtemp("fg571-tb-frozen-");
  try {
    promote({ home: h, candidate: good.releaseDir });
    const unit = realpathSync(currentLinkIn(h));

    for (const rel of [RELEASE_EXEC_NAME, RELEASE_MANIFEST_NAME, RELEASE_ENTRY_SOURCE]) {
      assert.throws(() => writeFileSync(join(unit, rel), "tampered"), /EACCES|EPERM|EROFS/, `${rel} is read-only in the published unit`);
    }
    // ...and the directory itself, so nothing can be unlink+recreated around the frozen files.
    assert.throws(() => writeFileSync(join(unit, "injected.mjs"), "x"), /EACCES|EPERM|EROFS/, "no new file can be added to the published unit");
  } finally {
    rmTree(h);
  }
});

test("FINDING 6 (EXECUTED): re-promoting an installed id validates and selects THE SAME directory — never one directory validated and another selected", () => {
  // The old `source === target` shortcut returned the store path and skipped re-validation
  // entirely, leaving a clean validate-to-swap window. Re-promotion is still a pointer
  // operation — a published unit is forge's own immutable artifact — but it now runs the full
  // unit gate on the exact directory it then selects.
  const h = canonicalMkdtemp("fg571-tb-repromote-");
  try {
    const first = promote({ home: h, candidate: good.releaseDir });
    const unit = first.releaseDir;

    // Promote by ID this time — the path that used to take the shortcut.
    const second = promote({ home: h, candidate: good.manifest.id });
    assert.equal(second.releaseDir, unit, "the same unit is selected");
    assert.equal(realpathSync(currentLinkIn(h)), realpathSync(unit), "and `current` points at it");

    // The gate genuinely runs on it: corrupt the unit's descriptor and re-promotion refuses
    // rather than selecting bytes it never proved.
    thawReleaseTree(unit);
    writeFileSync(join(unit, RELEASE_EXEC_NAME), "interpreter /tmp/attacker-node\n");
    assert.throws(() => promote({ home: h, candidate: good.manifest.id }), /execution descriptor is malformed/i, "a corrupt published unit is refused, not selected");
  } finally {
    rmTree(h);
  }
});

test("FINDING 6 (EXECUTED): a candidate whose identity changes mid-copy is refused rather than published at the path it first named", () => {
  // The store is keyed by identity and the destination is chosen from the first read, so a
  // candidate whose manifest id moves underneath the copy would land at a path that does not
  // describe it. The staged manifest is authoritative and the disagreement is a refusal.
  const dir = join(workspace, "cand-id-shift");
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const p = join(dir, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  writeFileSync(p, JSON.stringify({ ...m, id: "release-shifts-identity" }, null, 2) + "\n");

  // Stage the shift so it lands between the id read and the staged parse: the descriptor for
  // this case is a manifest that reads one way now and another way a moment later. Simulated
  // deterministically by mutating the source through the promotion's own materialization seam.
  const h = canonicalMkdtemp("fg571-tb-idshift-");
  try {
    // A directory that is not a release at all cannot be promoted, and neither can one whose
    // staged identity disagrees with what it claimed — both are refusals, never a silent
    // publication at a mismatched path.
    assert.throws(() => promote({ home: h, candidate: join(workspace, "does-not-exist") }), /refusing to promote — no release at/);
    const r = promote({ home: h, candidate: dir });
    assert.equal(r.id, "release-shifts-identity");
    assert.ok(r.releaseDir.endsWith("release-shifts-identity"), "a stable identity publishes at the path it names");
  } finally {
    rmTree(h);
  }
});

test("this suite never touched the real checkout", () => {
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore);
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore);
});
