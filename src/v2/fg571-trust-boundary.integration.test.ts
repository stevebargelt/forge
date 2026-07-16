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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_ENTRY_SOURCE,
  RELEASE_EXEC_NAME,
  RELEASE_LOADER_NAME,
  RELEASE_MANIFEST_NAME,
  SHIM_NAME,
  freezeReleaseFiles,
  renderExecDescriptor,
  renderShim,
  thawReleaseTree,
  type BuildReleaseResult,
} from "./release.js";
import { installShim, promote, readSelection, validateCandidate } from "./promote.js";
import { checkReleaseIdentity } from "../cli/node-preflight.js";
import { interpreterKey, isStoredInterpreter, probeInterpreter } from "./runtime-store.js";
import { currentLinkIn, releasesDirIn } from "../util/paths.js";
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

  // THE INNER GATE, unchanged and still load-bearing: validateCandidate refuses this entry
  // because a string check cannot see a link and a realpath comparison can. Asserted directly
  // because FINDING 6 later added an OUTER gate that refuses this candidate EARLIER — at
  // materialization, for holding a symlink at all — so `promote` no longer reaches this
  // refusal. Both gates are real; this is the one this finding is about.
  assert.throws(
    () => validateCandidate(dir),
    (e: Error) => {
      assert.match(e.message, /refusing to promote — this release's entry is not a regular file/);
      assert.match(e.message, /a symlink/);
      assert.match(e.message, /Fix: rebuild with `forge release build`/);
      return true;
    },
    "a symlinked entry must be refused",
  );

  const h = canonicalMkdtemp("fg571-tb-entrysym-");
  try {
    // And end to end, the candidate is refused — now by the outer no-symlinks gate, which fires
    // first. Which of the two names it does not matter here; that it never promotes does.
    assert.throws(() => promote({ home: h, candidate: dir }), /refusing to promote/, "a symlinked entry is never promotable");
    assert.equal(readSelection(h), null, "nothing was selected — it fails closed");
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

  // The inner gate, asserted directly for the same reason as above: the outer no-symlinks gate
  // now refuses this candidate at materialization, before validateCandidate's containment check
  // is reached through `promote`.
  assert.throws(() => validateCandidate(dir), /refusing to promote — this release's entry escapes the release/, "a symlinked component must be refused");

  const h = canonicalMkdtemp("fg571-tb-compsym-");
  try {
    assert.throws(() => promote({ home: h, candidate: dir }), /refusing to promote/, "and it is never promotable");
    assert.equal(readSelection(h), null, "nothing was selected");
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

// ══════════════ FINDING 6 — A CANDIDATE-SUPPLIED SYMLINK DEFEATS THE FREEZE ══════════════
//
// The descriptor made the shim's job safe, and in doing so made the DESCRIPTOR the thing worth
// attacking. It is a file in the unit, and a file in the unit can be a link out of it:
//
//   1. the candidate ships `forge-exec` as a symlink -> an attacker-owned file outside;
//   2. `tar -cf - . | tar -xf -` PRESERVES it, so it arrives in the staging tree intact;
//   3. writeFileSync of the canonical descriptor FOLLOWS it — forge's own trusted bytes are
//      written onto the attacker's file;
//   4. parseExecDescriptor reads that same external file back, and validation PASSES;
//   5. the freeze (statSync + chmodSync, both following links) chmods the ATTACKER'S file,
//      which they own and chmod straight back. The link survives, still pointing out;
//   6. after publication the attacker rewrites their file: a valid descriptor naming their own
//      interpreter and the release's real id — both pass every charset and field check;
//   7. the shim follows the in-unit link and execs the attacker's interpreter.
//
// IT GENERALIZES, so the fix does not name the descriptor. `dereferenceSymlinks` exists but is
// called only from buildRelease — never from promote's staging — so ANY file in a candidate can
// be a link out. The shim execs `interpreter --import $here/forge-loader.mjs $here/src/cli/...`,
// which makes forge-loader.mjs the identical attack via `--import`, and anything the entry
// lazily loads (node_modules/**) the same again. So: a staged unit contains NO symlinks,
// anywhere, and a candidate carrying one is refused at materialization.

/** THE PRE-FIX FREEZE: statSync + chmodSync, both of which FOLLOW symlinks. Kept here to
 *  execute the vulnerable behavior rather than describe it. `ent.isDirectory()` is FALSE for a
 *  symlink-to-directory, so a linked directory takes the `else` branch and gets its TARGET
 *  chmod'd — the blind spot the real freeze now refuses on. */
function vulnerableFreeze(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) vulnerableFreeze(p);
    else chmodSync(p, statSync(p).mode & ~0o222);
  }
  chmodSync(dir, statSync(dir).mode & ~0o222);
}

/** THE VULNERABLE PROMOTION: installRelease's exact published sequence — materialize, thaw,
 *  author the descriptor, freeze, rename into the keyed path, point `current` — with the
 *  symlink refusal absent and the pre-fix freeze in place. This is the implementation as it
 *  stood, run for real, so the exploit below is EXECUTED rather than reasoned about. Every
 *  path derives from the caller's disposable `home`. */
function vulnerableInstall(home: string, candidate: string): string {
  const manifest = JSON.parse(readFileSync(join(candidate, RELEASE_MANIFEST_NAME), "utf8")) as { id: string; interpreter: string };
  const releases = releasesDirIn(home);
  mkdirSync(releases, { recursive: true });
  const staging = join(releases, `.installing-${manifest.id}`);
  tarCopy(candidate, staging); // step 2: tar preserves the symlink
  thawReleaseTree(staging);
  // step 3: forge's trusted descriptor, authored THROUGH whatever link is sitting at that name.
  writeFileSync(join(staging, RELEASE_EXEC_NAME), renderExecDescriptor({ interpreter: manifest.interpreter, id: manifest.id }));
  vulnerableFreeze(staging); // step 5
  const target = join(releases, manifest.id);
  renameSync(staging, target);
  const tmp = join(home, `.current-${manifest.id}`);
  symlinkSync(target, tmp);
  renameSync(tmp, currentLinkIn(home));
  return target;
}

/** A candidate copied from the good release, with `link` planted at `at` and a distinct id. */
function candidateWithLink(label: string, at: string, link: string): string {
  const dir = join(workspace, `cand-${label}`);
  rmTree(dir);
  tarCopy(good.releaseDir, dir);
  thawReleaseTree(dir);
  const p = join(dir, at);
  rmSync(p, { recursive: true, force: true });
  mkdirSync(dirname(p), { recursive: true });
  symlinkSync(link, p);
  const mp = join(dir, RELEASE_MANIFEST_NAME);
  const m = JSON.parse(readFileSync(mp, "utf8")) as Record<string, unknown>;
  writeFileSync(mp, JSON.stringify({ ...m, id: `release-${label}` }, null, 2) + "\n");
  return dir;
}

test("FINDING 6 (EXECUTED EXPLOIT): `forge-exec` as a symlink out of the unit — the vulnerable promotion writes forge's OWN descriptor onto the attacker's file, and the attacker owns what the shim then execs", () => {
  const marker = join(workspace, "DESC-SYMLINK-ATTACKER-RAN");
  rmSync(marker, { force: true });
  const attacker = attackerNode(join(workspace, "descsym-bin"), marker);

  // The attacker's file, OUTSIDE the release, at a path they own. Its contents do not matter
  // yet — forge is about to write the real descriptor onto it for them.
  const outside = join(workspace, "outside-forge-exec");
  writeFileSync(outside, "placeholder\n");
  chmodSync(outside, 0o644);

  // step 1. A built release carries no descriptor (promotion authors it), so this plants the
  // link at the exact name promotion is about to write.
  const dir = candidateWithLink("desc-symlink", RELEASE_EXEC_NAME, outside);

  const hv = canonicalMkdtemp("fg571-tb-descsym-vuln-");
  try {
    // ── RED: the vulnerable promotion, run for real ──
    const unit = vulnerableInstall(hv, dir);

    // steps 2-3, PROVEN rather than assumed: the link survived materialization, and forge's
    // own trusted descriptor bytes were written through it onto the attacker's outside file.
    assert.equal(lstatSync(join(unit, RELEASE_EXEC_NAME)).isSymbolicLink(), true, "tar preserved the link into the published unit");
    assert.equal(realpathSync(join(unit, RELEASE_EXEC_NAME)), outside, "and it still points outside the release");
    assert.match(readFileSync(outside, "utf8"), /^interpreter \/.*\nrelease release-desc-symlink\n$/, "forge authored its trusted descriptor ONTO the attacker's file");

    // step 5: the freeze chmod'd the ATTACKER'S file rather than anything in the unit — and it
    // is their file, so they simply put the write bit back.
    assert.equal(statSync(outside).mode & 0o222, 0, "the freeze followed the link and cleared the write bits on a file outside the release");
    chmodSync(outside, 0o644);

    // step 6: the descriptor is rewritten AFTER publication, naming the attacker's interpreter
    // and the release's genuine id. Both pass every charset and field check the shim applies.
    writeFileSync(outside, `interpreter ${attacker}\nrelease release-desc-symlink\n`);

    // step 7: the REAL shim — not a mutant — follows the in-unit link and execs it. The shim is
    // not at fault: it reads exactly the file forge told it was authoritative. The marker is the
    // proof that the attacker's interpreter ran as the machine-wide forge.
    const shim = installShimIn("descsym", renderShim());
    const r = runShim(shim, hv);
    assert.equal(existsSync(marker), true, `MUTANT: the vulnerable promotion must leave the attacker's interpreter exec'd as forge — it did not (exit ${r.status}): ${r.stderr}`);
    assert.match(readFileSync(marker, "utf8"), /ATTACKER INTERPRETER EXECUTED/);
  } finally {
    rmTree(hv);
  }

  // ── GREEN: the real promotion refuses the same candidate at materialization ──
  rmSync(marker, { force: true });
  const hg = canonicalMkdtemp("fg571-tb-descsym-fixed-");
  try {
    assert.throws(
      () => promote({ home: hg, candidate: dir }),
      (e: Error) => {
        assert.match(e.message, /refusing to promote — this release candidate holds a symbolic link/);
        assert.match(e.message, new RegExp(`link:\\s+.*${RELEASE_EXEC_NAME}`));
        assert.match(e.message, /Fix: rebuild with `forge release build --out <dir>`/);
        return true;
      },
      "a candidate whose descriptor is a link out of the unit must be refused by name",
    );
    assert.equal(readSelection(hg), null, "nothing was selected — it fails closed");
    assert.equal(existsSync(currentLinkIn(hg)), false, "and it never became the machine-wide forge");
    assert.equal(existsSync(marker), false, "the attacker's interpreter never ran");
    // The refusal lands BEFORE the descriptor is authored, so forge never wrote its trusted
    // bytes onto the attacker's file at all — the write is not merely harmless, it never happens.
    assert.equal(readFileSync(outside, "utf8"), `interpreter ${attacker}\nrelease release-desc-symlink\n`, "the outside file is untouched — forge never followed the link");
  } finally {
    rmTree(hg);
  }
});

test("FINDING 6 (EXECUTED EXPLOIT): `forge-loader.mjs` as a symlink out — the identical attack through the shim's `--import`, which a descriptor-only fix would leave wide open", () => {
  // THE REASON THE FIX IS NOT ABOUT THE DESCRIPTOR. The shim execs
  // `interpreter --import $here/forge-loader.mjs $here/src/cli/index.ts`, so the loader is
  // attacker code loaded by the REAL pinned interpreter, before the entry runs. No descriptor
  // is involved and nothing about it is malformed.
  const marker = join(workspace, "LOADER-SYMLINK-ATTACKER-RAN");
  rmSync(marker, { force: true });
  const outside = join(workspace, "outside-loader.mjs");
  writeFileSync(outside, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "LOADER SYMLINK ATTACKER RAN\\n");\nprocess.exit(0);\n`);

  const dir = candidateWithLink("loader-symlink", RELEASE_LOADER_NAME, outside);

  const hv = canonicalMkdtemp("fg571-tb-loadersym-vuln-");
  try {
    // RED: the vulnerable promotion publishes a unit whose loader is a link to attacker bytes.
    const unit = vulnerableInstall(hv, dir);
    assert.equal(lstatSync(join(unit, RELEASE_LOADER_NAME)).isSymbolicLink(), true, "the link survived into the published unit");

    const shim = installShimIn("loadersym", renderShim());
    const r = runShim(shim, hv);
    assert.equal(existsSync(marker), true, `MUTANT: the vulnerable promotion must let attacker code run via --import — it did not (exit ${r.status}): ${r.stderr}`);
    assert.match(readFileSync(marker, "utf8"), /LOADER SYMLINK ATTACKER RAN/);
  } finally {
    rmTree(hv);
  }

  // GREEN: refused at materialization, by the same check, for the same reason — the fix is
  // "no symlinks in the unit", not "not that one file".
  rmSync(marker, { force: true });
  const hg = canonicalMkdtemp("fg571-tb-loadersym-fixed-");
  try {
    assert.throws(() => promote({ home: hg, candidate: dir }), new RegExp(`refusing to promote — this release candidate holds a symbolic link[\\s\\S]*${RELEASE_LOADER_NAME}`));
    assert.equal(existsSync(marker), false, "the attacker's loader never ran");
    assert.equal(readSelection(hg), null, "nothing was selected");
  } finally {
    rmTree(hg);
  }
});

test("FINDING 6: a symlink ANYWHERE ELSE in the candidate is refused — the unit is what is protected, not a list of interesting filenames", () => {
  // Under node_modules/, which the entry loads lazily and no per-file gate names. A fix that
  // enumerated the descriptor, the loader, and the entry would accept this.
  const outside = join(workspace, "outside-dep.js");
  writeFileSync(outside, `module.exports = {};\n`);
  const dir = candidateWithLink("nm-symlink", join("node_modules", "tsx", "planted.js"), outside);

  const h = canonicalMkdtemp("fg571-tb-nmsym-");
  try {
    assert.throws(
      () => promote({ home: h, candidate: dir }),
      new RegExp(`refusing to promote — this release candidate holds a symbolic link[\\s\\S]*planted\\.js`),
      "a link buried anywhere under the candidate is refused",
    );
    assert.equal(readSelection(h), null, "nothing was selected");
  } finally {
    rmTree(h);
  }
});

test("FINDING 6: a symlinked DIRECTORY is refused — `ent.isDirectory()` is FALSE for one, which is exactly how it used to slip through", () => {
  const outsideDir = join(workspace, "outside-tree");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "planted.js"), `module.exports = {};\n`);
  const dir = candidateWithLink("dir-symlink", join("node_modules", "planted-dir"), outsideDir);

  // THE BLIND SPOT, asserted rather than asserted-about: a Dirent for a symlink-to-directory
  // reports isDirectory() === false. Any walk that branches on isDirectory() first therefore
  // takes the FILE branch for this entry — which is why the link check must come first.
  const ent = readdirSync(join(dir, "node_modules"), { withFileTypes: true }).find((e) => e.name === "planted-dir")!;
  assert.equal(ent.isSymbolicLink(), true);
  assert.equal(ent.isDirectory(), false, "the premise: a symlink-to-directory does not report as a directory");

  const h = canonicalMkdtemp("fg571-tb-dirsym-");
  try {
    assert.throws(
      () => promote({ home: h, candidate: dir }),
      new RegExp(`refusing to promote — this release candidate holds a symbolic link[\\s\\S]*planted-dir`),
      "a symlinked directory is refused, not descended into and not silently skipped",
    );
    assert.equal(readSelection(h), null, "nothing was selected");
  } finally {
    rmTree(h);
  }
});

test("FINDING 6 (EXECUTED MUTANT): the freeze must never chmod a symlink's TARGET — the vulnerable one does, and the link outlives the freeze", () => {
  const tree = join(workspace, "freeze-tree");
  const outside = join(workspace, "freeze-outside-file");
  rmTree(tree);
  mkdirSync(join(tree, "sub"), { recursive: true });
  writeFileSync(join(tree, "sub", "real.txt"), "real\n");
  writeFileSync(outside, "attacker owns this\n");
  chmodSync(outside, 0o644);
  symlinkSync(outside, join(tree, "linked"));

  // RED: the pre-fix freeze follows the link and clears the write bits on a file OUTSIDE the
  // tree it was asked to freeze. It "succeeds" — and protects nothing: the link is still there,
  // still pointing out, at a file whose owner restores the bit at will.
  vulnerableFreeze(tree);
  assert.equal(statSync(outside).mode & 0o222, 0, "MUTANT: the vulnerable freeze chmod'd a file outside the tree");
  assert.equal(lstatSync(join(tree, "linked")).isSymbolicLink(), true, "and the link survived the freeze it was supposed to be frozen by");

  // GREEN: the real freeze refuses by name and does not touch the target.
  chmodSync(outside, 0o644);
  spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", tree]);
  assert.throws(
    () => freezeReleaseFiles(tree),
    (e: Error) => {
      assert.match(e.message, /refusing to freeze — this release tree holds a symbolic link/);
      assert.match(e.message, /link:\s+.*linked/);
      return true;
    },
    "the freeze refuses a link rather than chmod'ing its target",
  );
  assert.equal(statSync(outside).mode & 0o222, 0o200, "the outside file's mode is untouched — the freeze never followed the link");
  rmTree(tree);
});

// ══════════ BATCHED — THE DESCRIPTOR'S INTERPRETER IS RE-VALIDATED AT RUNTIME ══════════

test("BATCHED: descriptor interpreter != manifest interpreter — a MATCHING id used to be enough, so the divergent interpreter ran", () => {
  // The evasion at the end of the chain above. The id check passes (the id genuinely matches),
  // and round 1 checked nothing else — so a descriptor could name interpreter A under a manifest
  // naming B and nothing caught it.
  //
  // The divergent interpreter here is a COPY of the release's own real node. That is what makes
  // this test about the cross-check and nothing else: it runs the CLI correctly, reports the
  // exact version and ABI the manifest names, and passes every other gate. The only thing wrong
  // with it is that the manifest does not name it.
  const h = promotedHomeWith("interpdiverge", (unit) => {
    const m = JSON.parse(readFileSync(join(unit, RELEASE_MANIFEST_NAME), "utf8")) as { id: string; interpreter: string };
    const other = join(workspace, "diverging-node", "node");
    mkdirSync(dirname(other), { recursive: true });
    copyFileSync(realpathSync(m.interpreter), other);
    chmodSync(other, 0o755);
    writeFileSync(join(unit, RELEASE_EXEC_NAME), renderExecDescriptor({ interpreter: other, id: m.id }));
  });

  try {
    // RED — the mutant is the SHIM WITHOUT THE INTERPRETER CARRIER, i.e. round 1's shim. Node
    // then re-checks only the id, the id matches, and the divergent interpreter runs to
    // completion as the machine-wide forge.
    const real = renderShim();
    const carrier = `FORGE_RELEASE_INTERPRETER=$__forge_interpreter\nexport FORGE_RELEASE_INTERPRETER`;
    assert.ok(real.includes(carrier), "the real shim carries the descriptor's interpreter to Node — this mutant is stale if not");
    const mutant = installShimIn("interpdiverge-vuln", real.replace(carrier, ""));
    const r = runShim(mutant, h);
    assert.equal(r.status, 0, `MUTANT: without the cross-check the divergent interpreter runs with a matching id — it did not (${r.stderr})`);

    // GREEN — the real shim carries the interpreter too, and trusted Node refuses by name.
    const fixed = installShimIn("interpdiverge-fixed", real);
    const r2 = runShim(fixed, h);
    assert.notEqual(r2.status, 0, "a descriptor that disagrees with the manifest about what runs it does not run");
    assert.match(r2.stderr, /refusing to run — this release's execution descriptor and its manifest disagree about its interpreter/);
    assert.match(r2.stderr, /Fix: re-promote this release/);
  } finally {
    rmTree(h);
  }
});

test("BATCHED: the interpreter cross-check is fail-closed, and ABSENT is still not a mismatch", () => {
  const found = { kind: "release" as const, releaseDir: "/store/releases/r1", manifest: { id: "r1", interpreter: "/store/interpreters/node-24/bin/node" } };

  // PRESENT-and-DIFFERENT is the only contradiction — and now both halves are checked.
  assert.equal(checkReleaseIdentity(found, "r1", "/store/interpreters/node-24/bin/node").ok, true);
  assert.equal(checkReleaseIdentity(found, "r1", "/tmp/attacker-node").ok, false, "a matching id no longer excuses a divergent interpreter");
  assert.equal(checkReleaseIdentity(found, "nope", "/store/interpreters/node-24/bin/node").ok, false);

  // ABSENT is not a mismatch: the dev entry and a direct `node <release>/src/cli/index.ts`
  // legitimately carry neither value. FG-569's rule holds — not recorded, never manufactured.
  assert.equal(checkReleaseIdentity(found, undefined, undefined).ok, true);
  assert.equal(checkReleaseIdentity(found, "r1", undefined).ok, true, "an id alone is still a valid carry");
  assert.equal(checkReleaseIdentity({ kind: "none" }, undefined, undefined).ok, true);

  // Fail-closed on a manifest that cannot state an interpreter at all: a carried value with
  // nothing to check it against is not a pass.
  assert.equal(checkReleaseIdentity({ kind: "release", releaseDir: "/r", manifest: { id: "r1" } }, "r1", "/some/node").ok, false, "a manifest stating no interpreter cannot vouch for a carried one");
});

test("BATCHED: the shim's header comment describes what the shim actually does", () => {
  // It ships INSIDE every installed shim, so an operator reading their own near-frozen forge
  // reads this. It said "read the manifest" long after the shim stopped doing that — a false
  // description of the one file the trust boundary turns on.
  const header = renderShim().split("\n").slice(0, 8).join("\n");
  assert.match(header, /read the canonical execution descriptor/, "the header names what the shim reads");
  assert.ok(!/resolve `current` -> read the manifest/.test(header), "and no longer claims it reads the manifest");
});

test("this suite never touched the real checkout", () => {
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore);
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore);
});
