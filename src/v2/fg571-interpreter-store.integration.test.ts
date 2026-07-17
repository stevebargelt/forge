// FG-571 — THE INTERPRETER STORE'S IMMUTABILITY CONTRACT, executed and mutation-tested.
//
// THE BINDING INVARIANT, and the only thing this file is about:
//
//   Once a final interpreter-store path exists, its BYTES and its PATHNAME are immutable
//   FOREVER. It is never renamed, deleted, repaired, chmodded, thawed, or replaced in place.
//
// EVERY existing final path is treated as potentially pinned by a retained release. There is no
// registry of who pins what and there never will be one, so the store cannot ask "is anyone
// using this?" — it answers by never taking anything away. That is what the four findings this
// file closes have in common: each one is a way the old store could take something back.
//
//   F1  rename-aside + replace at a pinned pathname. `renameSync(target, target.invalid-*)`
//       then `renameSync(staging, target)`. The PATHNAME is the reference a retained release's
//       manifest holds, so moving the incumbent aside is not a repair — it is the fault. The
//       retained release gets ENOENT in the gap, or execs replacement bytes at its own
//       unchanged absolute path. The old code's comment claimed "never patched under a live
//       reference"; it did exactly that.
//   F2  two installers racing through that branch each rename-away and replace, so a release
//       pinning that pathname observes whichever one finished last.
//   F3  version+ABI is NOT an identity. A rebuilt, vendor-patched, or differently-configured
//       node honestly reports the same version and the same ABI as another build — so the key
//       could not tell two interpreters apart, and a release could not name the bytes it was
//       validated against.
//   F4  validation derived the store root from the CANDIDATE'S OWN resolved path, so any path
//       shaped like a store path vouched for itself.
//
// WHAT EACH TEST HERE OWES YOU (FG-551, and the operator's standing rule): a regression must be
// MUTATION-SENSITIVE or observed RED against the vulnerable implementation. "The fixed version
// refuses" is not evidence — a version that refuses everything also passes that. So the
// MANDATORY MUTANT below reconstructs the rename-aside/replace publication from the shipped
// module's own source and shows, by BYTE COMPARISON and a FILESYSTEM MARKER, that it serves
// different bytes at a pinned path and opens an ENOENT window there — on the same fixtures the
// fixed store keeps intact.
//
// SAFETY: every install, build and promotion here lands in a mkdtemp FORGE_HOME with an
// explicit --prefix, built from a DISPOSABLE source root (fg571-harness.ts). No `npm link`, no
// git command against the real checkout, and nothing reaches the operator's real
// ~/.forge/interpreters, ~/.forge/current, their real shim, or ~/.forge/runtimes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIM_NAME, renderShim } from "./release.js";
import { installShim, promote, validateCandidate } from "./promote.js";
import {
  installInterpreter,
  interpreterKey,
  interpreterPath,
  isStoredInterpreter,
  probeInterpreter,
  storedIdentityOf,
  validatedInterpreter,
  type InstallInterpreterOptions,
  type InstallInterpreterResult,
  type StoredInterpreterIdentity,
} from "./runtime-store.js";
import { interpretersDirIn } from "../util/paths.js";
import { findGitRoot } from "../util/git-root.js";
import { canonicalMkdtemp, fileDigestOf, makeDisposableSourceRoot, removeDisposableSourceRoot, variantInterpreter, type DisposableSource } from "./fg571-harness.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(moduleDir);

let source: DisposableSource;
let workspace: string;
let repoHeadBefore: string;
let repoStatusBefore: string;

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function rmTree(dir: string): void {
  spawnSync("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; exit 0', "sh", dir]);
  rmSync(dir, { recursive: true, force: true });
}

/** A fresh disposable forge home. Every test gets its own: the store never deletes anything, so
 *  a shared home would carry one test's published entries into the next test's premises. */
function freshHome(label: string): string {
  return canonicalMkdtemp(`fg571-store-${label}-`);
}

/** The PUBLISHED entries of a store — `.installing-*` excluded, because that is precisely the
 *  claim: a staging dir is not a key any release can name, so it is not an entry. */
function publishedEntries(home: string): string[] {
  const dir = interpretersDirIn(home);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !n.startsWith(".installing-"))
        .sort()
    : [];
}

function stagingEntries(home: string): string[] {
  const dir = interpretersDirIn(home);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".installing-")) : [];
}

/** The identity of the running node — what a release built here pins. */
function hostIdentity(): StoredInterpreterIdentity {
  const id = storedIdentityOf(realpathSync(process.execPath));
  assert.ok(id, "the running interpreter reports its identity and digests");
  return id;
}

/** CORRUPT a published entry's bytes in place. Not something forge ever does — it is the state
 *  the store must be able to FIND ITSELF IN and refuse: an entry whose key no longer describes
 *  what is there (bit rot, a botched restore, a tamper). The store's published bytes are frozen
 *  read-only, so this restores the write bit first — which is itself the point: only something
 *  OUTSIDE forge's contract could have done this. */
function corruptEntry(bin: string): void {
  chmodSync(bin, 0o755);
  writeFileSync(bin, "#!/bin/sh\necho 'this is not node'\nexit 3\n");
}

/** Write a child script into the workspace and run it against the REAL checkout, so tsx and the
 *  modules under test resolve. */
function childScript(name: string, body: string): string {
  const p = join(workspace, name);
  writeFileSync(p, body);
  return p;
}

function moduleUnderTest(name: string): string {
  return JSON.stringify(join(moduleDir, name));
}

/** Run a child that reaches an interruption seam, then SIGKILL it there. SIGKILL, not SIGTERM:
 *  an interrupted install must be safe because of what is ON DISK, not because it got a chance
 *  to tidy up. */
function killAtSeam(script: string, marker: string): void {
  const child = spawnSync(
    "/bin/sh",
    [
      "-c",
      `"$1" --import tsx "$2" & pid=$!; ` + `for i in $(seq 1 3000); do [ -f "$3" ] && break; sleep 0.02; done; ` + `kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null; exit 0`,
      "sh",
      process.execPath,
      script,
      marker,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(child.status, 0, "the interruption harness itself ran");
  assert.ok(existsSync(marker), `the child reached its interruption seam (marker ${marker}) — child stderr: ${child.stderr}`);
}

/** EXECUTE a shim and return the RUNNING process's own provenance report. This — not a symlink,
 *  and not a module's return value — is what "the release still runs on its original bytes"
 *  means. */
function runProvenance(shim: string, home: string): { status: number | null; stderr: string; prov: any } {
  const r = spawnSync(shim, ["release", "provenance", "--json"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", FORGE_HOME: home },
  });
  let prov: any;
  try {
    prov = JSON.parse(r.stdout);
  } catch {
    prov = undefined;
  }
  return { status: r.status, stderr: r.stderr, prov };
}

before(async () => {
  repoHeadBefore = gitIn(repoRoot, ["rev-parse", "HEAD"]).trim();
  repoStatusBefore = gitIn(repoRoot, ["status", "--porcelain"]);
  workspace = canonicalMkdtemp("fg571-store-ws-");
  source = await makeDisposableSourceRoot(repoRoot);
});

after(() => {
  if (existsSync(workspace)) rmTree(workspace);
  if (source) removeDisposableSourceRoot(source);
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the whole suite left the real checkout's HEAD unmoved");
  assert.equal(gitIn(repoRoot, ["status", "--porcelain"]), repoStatusBefore, "the whole suite left the real working tree exactly as it found it");
});

test("FG-571 SAFETY: this suite installs only into disposable homes and never runs git against the REAL checkout", () => {
  assert.notEqual(source.root, repoRoot, "releases are built from a disposable checkout");
  assert.ok(!source.root.startsWith(repoRoot), "and that checkout is not inside the real repository");
  assert.equal(gitIn(repoRoot, ["rev-parse", "HEAD"]).trim(), repoHeadBefore, "the real checkout's HEAD did not move");
});

// ══════════════ F3 — IDENTITY SUFFICIENCY: THE KEY MUST COMMIT TO THE BYTES ══════════════

test("FG-571 F3 (EXECUTED): two DIFFERENT interpreters reporting the SAME version+ABI get DISTINCT paths — they never collide or silently substitute", () => {
  // THE PREMISE, proven by execution rather than asserted: these are two genuinely different
  // binaries that both genuinely run and both honestly report identical version+ABI. This is
  // the ordinary case — a rebuilt node, a vendor's patched build, a distro build with different
  // configure flags — not a contrivance. Under the OLD version+ABI key all of them named ONE
  // path.
  const home = freshHome("identity");
  const a = variantInterpreter(workspace, "ident-a");
  const b = variantInterpreter(workspace, "ident-b");

  const idA = storedIdentityOf(a)!;
  const idB = storedIdentityOf(b)!;
  assert.equal(idA.version, idB.version, "the premise: both report the SAME version");
  assert.equal(idA.abi, idB.abi, "the premise: and the SAME ABI — version+ABI cannot tell them apart");
  assert.notEqual(fileDigestOf(a), fileDigestOf(b), "the premise: and they are genuinely different bytes");
  assert.deepEqual(probeInterpreter(a), { version: idA.version, abi: idA.abi }, "the premise: A genuinely runs");
  assert.deepEqual(probeInterpreter(b), { version: idB.version, abi: idB.abi }, "the premise: B genuinely runs");

  // THE OLD KEY, reproduced verbatim to show what the fix actually changed: it collapses them
  // onto one path, which is where every downstream fault came from.
  const oldKey = (id: { version: string; abi: string }) => `node-${id.version}-${id.abi}`;
  assert.equal(oldKey(idA), oldKey(idB), "the OLD version+ABI key gives both the SAME name — the finding");

  // THE FIX: the identity commits to the bytes, so they are different identities.
  assert.notEqual(interpreterKey(idA), interpreterKey(idB), "the content-addressed key tells them apart");

  const ra = installInterpreter({ home, source: a, expected: { version: idA.version, abi: idA.abi } });
  const rb = installInterpreter({ home, source: b, expected: { version: idB.version, abi: idB.abi } });
  assert.equal(ra.reused, false, "A was installed");
  assert.equal(rb.reused, false, "B was installed — it was NOT silently answered with A's bytes");
  assert.notEqual(ra.path, rb.path, "each identity got its own FRESH final path");

  // AND THE BYTES AT EACH PATH ARE THAT IDENTITY'S BYTES — the substitution the old key made
  // possible does not happen.
  assert.equal(fileDigestOf(ra.path), fileDigestOf(a), "A's path holds A's bytes");
  assert.equal(fileDigestOf(rb.path), fileDigestOf(b), "B's path holds B's bytes");
  assert.equal(validatedInterpreter(home, idA), ra.path, "A validates at its own key");
  assert.equal(validatedInterpreter(home, idB), rb.path, "B validates at its own key");
  assert.deepEqual(publishedEntries(home), [interpreterKey(idA), interpreterKey(idB)].sort(), "both entries coexist — installing B preserved A untouched");
  rmTree(home);
});

test("FG-571 F3: reuse means SAME IDENTITY == SAME BYTES — which is the only reason reuse is safe at all", () => {
  const home = freshHome("reuse");
  const v = variantInterpreter(workspace, "reuse");
  const id = storedIdentityOf(v)!;
  const expected = { version: id.version, abi: id.abi };

  const first = installInterpreter({ home, source: v, expected });
  assert.equal(first.reused, false);
  // A SECOND SOURCE FILE with identical bytes — a different path, same content. The store keys
  // on content, so this is the same identity and the same entry, and nothing is rewritten.
  const copy = join(workspace, "reuse-copy-node");
  writeFileSync(copy, readFileSync(v));
  chmodSync(copy, 0o755);
  const again = installInterpreter({ home, source: copy, expected });
  assert.equal(again.reused, true, "identical bytes are the same identity — a no-op, not a rewrite");
  assert.equal(again.path, first.path);
  assert.deepEqual(publishedEntries(home), [interpreterKey(id)], "and no second entry appeared");
  rmTree(home);
});

// ══════════ F1 — NEVER MOVED ASIDE, NEVER REPLACED: REFUSAL IS BY NAME ══════════

test("FG-571 F1 (same-path replacement): an existing final key is NEVER renamed or replaced — an invalid entry is refused BY NAME", () => {
  const home = freshHome("samepath");
  const v = variantInterpreter(workspace, "samepath");
  const id = storedIdentityOf(v)!;
  const expected = { version: id.version, abi: id.abi };

  const published = installInterpreter({ home, source: v, expected });
  const P = published.path;
  const entryDir = dirname(dirname(P));

  // The entry is now INVALID: its bytes no longer run and no longer digest to what its key
  // names. This is the exact state the old code answered with rename-aside + replace.
  corruptEntry(P);
  assert.equal(validatedInterpreter(home, id), null, "the premise: the published entry genuinely no longer validates");
  const corrupted = readFileSync(P);

  // THE FIX: refuse BY NAME. Not a repair, not a replacement, not a move.
  assert.throws(
    () => installInterpreter({ home, source: v, expected }),
    (e: Error) => {
      assert.match(e.message, /refusing to touch an existing interpreter entry that does not validate/i);
      assert.ok(e.message.includes(entryDir), "the refusal NAMES the entry — an operator can act on it");
      assert.match(e.message, /retained release's manifest pins this absolute path/i, "and says why: the pathname IS the reference");
      return true;
    },
    "a present-but-invalid entry is refused by name",
  );

  // THE PROPERTY, asserted on the filesystem rather than inferred from the message.
  assert.deepEqual(readFileSync(P), corrupted, "the pinned pathname still holds EXACTLY the bytes that were there — it was not replaced");
  assert.deepEqual(publishedEntries(home), [interpreterKey(id)], "no `.invalid-*` sibling was created — the incumbent was never moved aside");
  assert.deepEqual(stagingEntries(home), [], "and the refused install left no staging dir behind");
  rmTree(home);
});

test("FG-571 F1 (transient missing-path window): there is NO instant at which a pinned path is absent — publication is create-only into a name that does not exist", () => {
  const home = freshHome("nowindow");
  const v = variantInterpreter(workspace, "nowindow");
  const id = storedIdentityOf(v)!;
  const expected = { version: id.version, abi: id.abi };
  const P = installInterpreter({ home, source: v, expected }).path;
  const original = readFileSync(P);

  // A LATER INSTALL OF DIFFERENT BYTES cannot touch P: different bytes are a different
  // identity, so it publishes at its OWN fresh path and P is not even a candidate.
  const other = variantInterpreter(workspace, "nowindow-other");
  const otherId = storedIdentityOf(other)!;
  const q = installInterpreter({ home, source: other, expected: { version: otherId.version, abi: otherId.abi } });
  assert.notEqual(q.path, P, "a replacement is built at a NEW final path");
  assert.ok(existsSync(P), "P was never absent");
  assert.deepEqual(readFileSync(P), original, "and never rewritten");

  // AND AT THE PUBLICATION SEAM ITSELF — the instant the old code did its rename-aside in — P
  // is present and intact. There is no window because there is no rename of P at all: the only
  // rename is of a `.installing-*` dir INTO a name that does not exist.
  let observedAtSeam: Buffer | null = null;
  let existedAtSeam = false;
  const third = variantInterpreter(workspace, "nowindow-third");
  const thirdId = storedIdentityOf(third)!;
  installInterpreter({
    home,
    source: third,
    expected: { version: thirdId.version, abi: thirdId.abi },
    onPhase: (p) => {
      if (p !== "beforeCommit") return;
      existedAtSeam = existsSync(P);
      observedAtSeam = readFileSync(P);
    },
  });
  assert.equal(existedAtSeam, true, "at the publication seam, the pinned path is PRESENT — no ENOENT window");
  assert.deepEqual(observedAtSeam, original, "and holds its original bytes");
  assert.deepEqual(readFileSync(P), original, "still, afterwards");
  rmTree(home);
});

test("FG-571 F1 / rule 9: nothing is ever reclaimed — every published entry survives every later install", () => {
  const home = freshHome("nogc");
  const keys: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < 4; i++) {
    const v = variantInterpreter(workspace, `nogc-${i}`);
    const id = storedIdentityOf(v)!;
    const r = installInterpreter({ home, source: v, expected: { version: id.version, abi: id.abi } });
    keys.push(r.key);
    paths.push(r.path);
  }
  assert.equal(new Set(keys).size, 4, "four distinct identities got four distinct keys");
  assert.deepEqual(publishedEntries(home), [...keys].sort(), "and all four entries are still published — the store deleted nothing");
  for (const p of paths) assert.ok(existsSync(p), `${p} was retained`);
  rmTree(home);
});

// ══════════════════ RETAINED-RELEASE CONTINUITY, AND FAILING CLOSED BY NAME ══════════════════

test("FG-571 retained-release continuity (EXECUTED): a release pinning P keeps EXECUTING P's ORIGINAL bytes across any number of later installs", () => {
  const home = freshHome("continuity");
  const rel = source.build({ outDir: join(workspace, "rel-continuity"), rand: "cont01", home });
  promote({ home, candidate: rel.releaseDir });
  const shim = installShim({ prefix: mkdtempIn("continuity-prefix"), shimText: renderShim(), shimName: SHIM_NAME });

  const P = rel.manifest.interpreter;
  const originalBytes = readFileSync(P);
  const originalDigest = fileDigestOf(P);

  // The premise, from the RUNNING process: the release really does exec P.
  const before = runProvenance(shim, home);
  assert.equal(before.status, 0, `the release runs on its pinned interpreter: ${before.stderr}`);
  assert.equal(before.prov.execPath, P, "process.execPath IS the pinned store path");

  // NOW INSTALL, REPEATEDLY. Different interpreters, same version+ABI as P's — exactly the
  // collision the old key could not express, and exactly the input that used to end in P being
  // renamed aside and rebuilt.
  for (let i = 0; i < 3; i++) {
    const v = variantInterpreter(workspace, `cont-${i}`);
    const id = storedIdentityOf(v)!;
    assert.equal(id.version, before.prov.nodeVersion ?? id.version, "the installs report the same version as the pinned interpreter");
    const r = installInterpreter({ home, source: v, expected: { version: id.version, abi: id.abi } });
    assert.notEqual(r.path, P, "each new interpreter took a NEW final path — P is not a destination");
  }

  // THE ASSERTION, on the filesystem and then FROM THE RUNNING PROCESS.
  assert.ok(existsSync(P), "P still exists");
  assert.deepEqual(readFileSync(P), originalBytes, "P still holds byte-for-byte its ORIGINAL bytes");
  assert.equal(fileDigestOf(P), originalDigest, "the digest its pathname commits to is still the digest of what is there");

  const after = runProvenance(shim, home);
  assert.equal(after.status, 0, `the retained release still runs after all those installs: ${after.stderr}`);
  assert.equal(after.prov.execPath, P, "on the SAME interpreter path");
  assert.equal(after.prov.releaseId, rel.manifest.id, "and it is still the same release");
  assert.equal(after.prov.bindingLoads, true, "its native binding still loads under those original bytes");
  rmTree(home);
});

test("FG-571 invalid-target handling: a release pinning an entry found INVALID fails closed BY NAME — never silently redirected to replacement bytes", () => {
  const home = freshHome("failclosed");
  const rel = source.build({ outDir: join(workspace, "rel-failclosed"), rand: "fcls01", home });
  const P = rel.manifest.interpreter;

  // The pinned entry goes bad.
  corruptEntry(P);
  const corrupted = readFileSync(P);

  // A rebuild installs the SAME source the release was built from. Under the old store this hit
  // the rename-aside branch and the release silently acquired replacement bytes at its unchanged
  // manifest path. Now: refused by name, and the release refuses by name too.
  assert.throws(
    () => installInterpreter({ home, source: realpathSync(process.execPath), expected: { version: rel.manifest.nodeVersion, abi: rel.manifest.abi } }),
    /refusing to touch an existing interpreter entry that does not validate/i,
    "the store will not rebuild under the pinned name",
  );
  assert.deepEqual(readFileSync(P), corrupted, "the pinned path was NOT redirected to replacement bytes");

  // AND THE RELEASE FAILS CLOSED, BY NAME — it does not quietly run on something else.
  assert.throws(
    () => validateCandidate(rel.releaseDir, home),
    (e: Error) => {
      assert.match(e.message, /refusing to promote/i, "it is a refusal");
      assert.ok(e.message.includes(P), "and it NAMES the interpreter path that went bad");
      return true;
    },
    "the release pinning an invalid entry is refused by name",
  );
  rmTree(home);
});

// ══════════════════════ F2 — CONCURRENT INSTALLERS ══════════════════════

test("FG-571 F2 (concurrent installers): the loser of a race VALIDATES the winner's entry and reuses it — it never overwrites it, and no partial content is exposed", () => {
  // DETERMINISTIC, not timing-dependent: a competing installer publishes this identity from
  // INSIDE the outer install's own pre-publication seam, so the outer install's rename(2) is
  // guaranteed to land on a populated directory. That is the exact interleaving F2 describes,
  // forced rather than hoped for.
  const home = freshHome("race");
  const v = variantInterpreter(workspace, "race");
  const id = storedIdentityOf(v)!;
  const expected = { version: id.version, abi: id.abi };

  let winner: InstallInterpreterResult | undefined;
  const loser = installInterpreter({
    home,
    source: v,
    expected,
    onPhase: (p) => {
      if (p !== "beforeCommit" || winner) return;
      winner = installInterpreter({ home, source: v, expected });
    },
  });

  assert.ok(winner, "the competing installer genuinely published first");
  assert.equal(winner.reused, false, "the winner really did create the entry");
  assert.equal(loser.reused, true, "the loser REUSED the winner's published entry rather than overwriting it");
  assert.equal(loser.path, winner.path, "at the winner's path");

  // NO PARTIAL CONTENT, and no second inode: the entry validates by execution and by digest,
  // and the loser's staging dir was discarded rather than published anywhere.
  assert.equal(validatedInterpreter(home, id), winner.path, "the published entry validates — never a truncated or half-copied file");
  assert.equal(fileDigestOf(winner.path), fileDigestOf(v), "and holds exactly the intended bytes");
  assert.deepEqual(publishedEntries(home), [interpreterKey(id)], "exactly ONE entry — no `.invalid-*` sibling, so nothing was moved aside");
  assert.deepEqual(stagingEntries(home), [], "and the loser cleaned up its own staging dir");
  rmTree(home);
});

test("FG-571 F2 (concurrent installers, PROCESSES): N real processes racing the same identity publish exactly one valid entry", () => {
  const home = freshHome("raceproc");
  const v = variantInterpreter(workspace, "raceproc");
  const id = storedIdentityOf(v)!;

  // REAL processes, launched together and left to contend for the same key. The deterministic
  // interleaving is covered by the seam test above; this one is the honest end-to-end shape —
  // whatever order the kernel picks, the invariant must hold. The race is BENIGN BY
  // CONSTRUCTION — same identity means same bytes — so whoever wins is correct; what must never
  // happen is an overwrite, a partial read, or a second entry.
  const script = childScript(
    "raceproc.mts",
    `import { installInterpreter } from ${moduleUnderTest("runtime-store.js")};
installInterpreter({
  home: ${JSON.stringify(home)},
  source: ${JSON.stringify(v)},
  expected: ${JSON.stringify({ version: id.version, abi: id.abi })},
});
`,
  );
  const r = spawnSync("/bin/sh", ["-c", 'for i in 1 2 3 4 5 6; do "$1" --import tsx "$2" & done; wait', "sh", process.execPath, script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `every racing installer either published or reused — none crashed and none refused: ${r.stderr}`);

  assert.deepEqual(publishedEntries(home), [interpreterKey(id)], "exactly ONE published entry — no installer overwrote another, none created an `.invalid-*` sibling");
  assert.equal(validatedInterpreter(home, id), interpreterPath(home, id), "and it validates BY EXECUTION — no partial content was ever exposed");
  assert.equal(fileDigestOf(interpreterPath(home, id)), fileDigestOf(v), "holding exactly the intended bytes");
  assert.deepEqual(stagingEntries(home), [], "and every loser discarded its own staging dir");
  rmTree(home);
});

// ══════════════════════ INTERRUPTED PUBLICATION (F27b, per phase) ══════════════════════

for (const phase of ["copied", "validated", "frozen", "beforeCommit"] as const) {
  test(`FG-571 interrupted publication (EXECUTED, SIGKILL at "${phase}"): nothing partial is selectable and the incumbent entry is untouched`, () => {
    const home = freshHome(`kill-${phase}`);

    // An INCUMBENT published entry, so this also proves an interruption cannot damage what is
    // already there — the state a retained release would be pinning.
    const incumbent = variantInterpreter(workspace, `kill-inc-${phase}`);
    const incId = storedIdentityOf(incumbent)!;
    const incPath = installInterpreter({ home, source: incumbent, expected: { version: incId.version, abi: incId.abi } }).path;
    const incBytes = readFileSync(incPath);

    // ...and a genuinely NEW identity to interrupt. It must be valid, or it would fail
    // validation and never have had anything to publish.
    const v = variantInterpreter(workspace, `kill-${phase}`);
    const id = storedIdentityOf(v)!;
    assert.ok(!existsSync(interpreterPath(home, id)), "the premise: this identity is genuinely absent");

    const marker = join(workspace, `kill-${phase}.marker`);
    rmSync(marker, { force: true });
    const script = childScript(
      `kill-${phase}.mts`,
      `import { installInterpreter } from ${moduleUnderTest("runtime-store.js")};
import { writeFileSync } from "node:fs";
installInterpreter({
  home: ${JSON.stringify(home)},
  source: ${JSON.stringify(v)},
  expected: ${JSON.stringify({ version: id.version, abi: id.abi })},
  onPhase: (p) => {
    if (p !== ${JSON.stringify(phase)}) return;
    writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(phase)});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
  },
});
`,
    );
    killAtSeam(script, marker);

    // NOTHING PARTIAL IS SELECTABLE.
    assert.ok(!existsSync(interpreterPath(home, id)), "the interrupted identity has no final path");
    assert.equal(validatedInterpreter(home, id), null, "and nothing validates at it, so no manifest may reference it");
    assert.deepEqual(publishedEntries(home), [interpreterKey(incId)], "the store's published entries are exactly what they were");

    // A LEFTOVER `.installing-*` IS NOT AN ENTRY. It is not a key any release can name, and
    // isStoredInterpreter refuses anything inside it — which is what makes "no cleanup" safe.
    for (const s of stagingEntries(home)) {
      const orphan = join(interpretersDirIn(home), s, "bin", "node");
      assert.equal(isStoredInterpreter(orphan, { version: id.version, abi: id.abi }, home), false, `a leftover staging path (${s}) is never a store entry`);
    }

    // THE INCUMBENT IS UNTOUCHED — an interruption cannot damage a pinned path.
    assert.deepEqual(readFileSync(incPath), incBytes, "the incumbent entry's bytes are unchanged");
    assert.equal(validatedInterpreter(home, incId), incPath, "and it still validates");
    rmTree(home);
  });
}

// ══════════════════════ F4 — TRUSTED STORE ROOT / SYMLINK ESCAPES ══════════════════════

test("FG-571 F4 (EXECUTED): a FAKE store — a store-shaped path under a root forge does not own — is refused; the OLD check accepted it", () => {
  // THE FINDING, in its sharpest form. The old check derived the home by walking FOUR
  // components up from the candidate's own canonical path, so `/tmp/attacker/interpreters/
  // node-<key>/bin/node` implied the home `/tmp/attacker` and then matched the keyed path that
  // home implies — perfectly, every time. Any path shaped like a store path vouched for itself.
  const real = freshHome("f4-real");
  const v = variantInterpreter(workspace, "f4");
  const id = storedIdentityOf(v)!;
  const genuine = installInterpreter({ home: real, source: v, expected: { version: id.version, abi: id.abi } }).path;

  // The attacker's store: a REAL directory, real regular file, byte-identical to the genuine
  // one — so content-addressing alone does not refuse it, and neither does anything about how
  // it runs. The only thing wrong with it is that forge does not own the root.
  const fake = canonicalMkdtemp("fg571-store-f4-fake-");
  const fakeBinDir = join(fake, "interpreters", interpreterKey(id), "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeBin = join(fakeBinDir, "node");
  writeFileSync(fakeBin, readFileSync(v));
  chmodSync(fakeBin, 0o555);

  assert.deepEqual(probeInterpreter(fakeBin), { version: id.version, abi: id.abi }, "the premise: it genuinely runs and reports the right version+ABI");
  assert.equal(fileDigestOf(fakeBin), fileDigestOf(genuine), "the premise: byte-identical to the genuine entry, so the digest matches its key too");

  // THE OLD CHECK — home derived from the candidate's OWN resolved path. Reproduced verbatim.
  const oldCheck = (bin: string) => bin === join(realpathSync(join(bin, "..", "..", "..", "..")), "interpreters", interpreterKey(id), "bin", "node");
  assert.equal(oldCheck(fakeBin), true, "the OLD self-derived-home check ACCEPTS the fake store — the finding");

  // THE FIX: the trusted root comes from the CONFIGURED home. The fake store is not under it.
  assert.equal(isStoredInterpreter(fakeBin, id, real), false, "bound to the configured store root, the fake store is refused");
  assert.equal(isStoredInterpreter(genuine, id, real), true, "and it is not a blanket refusal — the genuine entry still passes");
  rmTree(fake);
  rmTree(real);
});

test("FG-571 F4: a PARENT PATH COMPONENT swapped after publication redirects nothing — the canonical path stops matching its own key", () => {
  // The TOCTOU half. A point-in-time canonical check is only worth something if a later
  // component swap cannot pass it: the attacker replaces the `node-<key>/` directory with a
  // link to bytes they own, which the leaf's own lstat cannot see.
  const home = freshHome("f4-component");
  const v = variantInterpreter(workspace, "f4-component");
  const id = storedIdentityOf(v)!;
  const P = installInterpreter({ home, source: v, expected: { version: id.version, abi: id.abi } }).path;
  assert.equal(isStoredInterpreter(P, id, home), true, "the premise: before the swap, the entry is accepted");

  // Attacker bytes that RUN and report the right version+ABI, with the same digest — so nothing
  // about the content gives them away.
  const outside = join(workspace, "f4-outside", "bin");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "node"), readFileSync(v));
  chmodSync(join(outside, "node"), 0o755);

  const entryDir = dirname(dirname(P));
  renameSync(entryDir, `${entryDir}.moved`);
  symlinkSync(dirname(outside), entryDir);

  assert.deepEqual(probeInterpreter(P), { version: id.version, abi: id.abi }, "the premise: the swapped-in bytes genuinely run and report the right identity");
  assert.equal(lstatSync(P).isFile(), true, "the premise: the LEAF is a real regular file — its own lstat sees nothing wrong");
  assert.equal(isStoredInterpreter(P, id, home), false, "the component swap is refused: the canonical path escapes the trusted root");
  rmTree(home);
});

test("FG-571 F4: a SYMLINKED STORE ROOT is refused — publication and validation both fail closed rather than following it", () => {
  const home = freshHome("f4-symroot");
  const elsewhere = join(workspace, "f4-elsewhere-store");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(home, "interpreters"));

  const v = variantInterpreter(workspace, "f4-symroot");
  const id = storedIdentityOf(v)!;

  assert.throws(
    () => installInterpreter({ home, source: v, expected: { version: id.version, abi: id.abi } }),
    /refusing to use the interpreter store — its root is not a real directory/i,
    "PUBLICATION refuses a redirected store root rather than writing through it",
  );
  assert.deepEqual(readdirSync(elsewhere), [], "and nothing was written through the link");

  // Validation fails closed on the same root, so a path reached through it can never be named.
  const planted = join(elsewhere, interpreterKey(id), "bin");
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, "node"), readFileSync(v));
  chmodSync(join(planted, "node"), 0o555);
  assert.equal(isStoredInterpreter(join(home, "interpreters", interpreterKey(id), "bin", "node"), id, home), false, "VALIDATION refuses anything reached through a symlinked store root");
  rmTree(home);
});

test("FG-571 F4: a final path that is a SYMLINK is refused BY NAME and never replaced — a link is exactly a thing whose bytes something else can move", () => {
  const home = freshHome("f4-symtarget");
  const v = variantInterpreter(workspace, "f4-symtarget");
  const id = storedIdentityOf(v)!;

  // Someone plants the entry as a link to bytes they own, at the exact key this install wants.
  const outside = join(workspace, "f4-symtarget-outside");
  mkdirSync(outside, { recursive: true });
  const outsideBin = join(outside, "node");
  writeFileSync(outsideBin, readFileSync(v));
  chmodSync(outsideBin, 0o755);

  const entryDir = join(interpretersDirIn(home), interpreterKey(id));
  mkdirSync(join(entryDir, "bin"), { recursive: true });
  symlinkSync(outsideBin, join(entryDir, "bin", "node"));

  // Refused BY NAME — and, crucially, NOT replaced: the store does not "fix" a path it finds
  // wrong, because it cannot know that path is not pinned.
  assert.throws(
    () => installInterpreter({ home, source: v, expected: { version: id.version, abi: id.abi } }),
    /refusing to touch an existing interpreter entry that does not validate/i,
    "a symlinked final path is refused by name",
  );
  assert.equal(lstatSync(join(entryDir, "bin", "node")).isSymbolicLink(), true, "the link is still there — it was not replaced with real bytes");
  assert.ok(existsSync(outsideBin), "and the link's target was not written through");
  assert.equal(validatedInterpreter(home, id), null, "nothing validates at that key, so no release may name it");
  rmTree(home);
});

// ══════════════════════ THE MANDATORY MUTANT ══════════════════════

/** THE VULNERABLE STORE, reconstructed FROM THE SHIPPED MODULE'S OWN SOURCE.
 *
 *  Not a hand-written imitation: the two edits below re-open exactly the two things the fix
 *  closed — the fail-closed refusal of an existing entry, and create-only publication — and
 *  leave every other line of the real module in place. Each replacement is asserted to have
 *  applied, so this mutant goes stale LOUDLY rather than silently degrading into a no-op if the
 *  module is restructured.
 *
 *  Written INTO the disposable checkout, which is load-bearing: the mutant is a real module with
 *  real relative imports (../util/paths.js) and can only resolve them from inside a tree that
 *  has them. The disposable root is that tree, and it is thrown away with the suite — the real
 *  checkout is never written to. */
function writeVulnerableStore(label: string): string {
  const src = readFileSync(join(moduleDir, "runtime-store.ts"), "utf8");

  const failClosed = `  if (existsSync(target)) {
    const already = validatedInterpreter(home, identity);
    if (already) return { path: already, key, identity, reused: true };
    throw refuseInvalidEntry(target, key);
  }`;
  assert.ok(src.includes(failClosed), "located the fail-closed existing-entry branch — this mutant is stale if not");

  const createOnly = `    try {
      renameSync(staging, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOTDIR") throw e;
      discardStaging(staging);
      const winner = validatedInterpreter(home, identity);
      if (winner) return { path: winner, key, identity, reused: true };
      throw refuseInvalidEntry(target, key);
    }`;
  assert.ok(src.includes(createOnly), "located the create-only publication — this mutant is stale if not");

  const seam = `    opts.onPhase?.("beforeCommit");\n`;
  assert.ok(src.includes(seam), "located the publication seam — this mutant is stale if not");

  const mutated = src
    // (1) an existing entry is no longer refused: fall through and rebuild it.
    .replace(
      failClosed,
      `  const already = validatedInterpreter(home, identity);
  if (already) return { path: already, key, identity, reused: true };`,
    )
    // (2) the seam MOVES into the gap the rename-aside opens, so an interruption test can park
    //     exactly where the pinned path is absent.
    .replace(seam, "")
    // (3) RENAME-ASIDE + REPLACE — the shipped code at HEAD, restored verbatim.
    .replace(
      createOnly,
      `    if (existsSync(target)) {
      renameSync(target, \`\${target}.invalid-\${Math.random().toString(36).slice(2, 8)}\`);
    }
    opts.onPhase?.("beforeCommit");
    renameSync(staging, target);`,
    );
  assert.notEqual(mutated, src, "the mutant genuinely differs from the shipped module");

  const p = join(source.root, "src", "v2", `runtime-store-renameaside-mutant-${label}.ts`);
  writeFileSync(p, mutated);
  return p;
}

test("FG-571 MANDATORY MUTANT (EXECUTED): restore rename-aside/replace -> the pinned path SERVES DIFFERENT BYTES; the fixed store leaves it intact", async () => {
  const { installInterpreter: vulnerableInstall } = (await import(writeVulnerableStore("bytes"))) as {
    installInterpreter: (o: InstallInterpreterOptions) => InstallInterpreterResult;
  };

  // ONE fixture, run through both implementations. Identical inputs; the only variable is the
  // publication rule.
  const fixture = (label: string) => {
    const home = freshHome(`mutant-${label}`);
    const v = variantInterpreter(workspace, `mutant-${label}`);
    const id = storedIdentityOf(v)!;
    const P = installInterpreter({ home, source: v, expected: { version: id.version, abi: id.abi } }).path;
    // The entry goes bad — the branch under test. A retained release still pins P.
    corruptEntry(P);
    const pinnedBytes = readFileSync(P);
    return { home, v, id, P, pinnedBytes };
  };

  // ─── RED: the vulnerable store REPLACES the bytes at the pinned pathname ───
  const bad = fixture("vuln");
  const r = vulnerableInstall({ home: bad.home, source: bad.v, expected: { version: bad.id.version, abi: bad.id.abi } });
  assert.equal(r.path, bad.P, "MUTANT: it published at the SAME pinned pathname");
  assert.notDeepEqual(
    readFileSync(bad.P),
    bad.pinnedBytes,
    "MUTANT: the pinned path now serves DIFFERENT BYTES than the retained release was validated against — the F1 defect, executed",
  );
  assert.equal(fileDigestOf(bad.P), fileDigestOf(bad.v), "MUTANT: specifically, it serves the REPLACEMENT bytes");
  // THE FILESYSTEM MARKER that the incumbent was moved aside: a `.invalid-*` sibling that only
  // rename-aside can create.
  const asideSiblings = publishedEntries(bad.home).filter((n) => n.includes(".invalid-"));
  assert.equal(asideSiblings.length, 1, "MUTANT: it moved the incumbent aside — the `.invalid-*` sibling is the evidence");

  // ─── GREEN: the fixed store, same fixture, refuses by name and changes nothing ───
  const good = fixture("fixed");
  assert.throws(
    () => installInterpreter({ home: good.home, source: good.v, expected: { version: good.id.version, abi: good.id.abi } }),
    /refusing to touch an existing interpreter entry that does not validate/i,
    "the fixed store refuses BY NAME",
  );
  assert.deepEqual(readFileSync(good.P), good.pinnedBytes, "and the pinned path still serves EXACTLY its original bytes");
  assert.deepEqual(
    publishedEntries(good.home).filter((n) => n.includes(".invalid-")),
    [],
    "with no `.invalid-*` sibling — nothing was moved aside",
  );

  rmTree(bad.home);
  rmTree(good.home);
});

test("FG-571 MANDATORY MUTANT (EXECUTED, SIGKILL): restore rename-aside/replace -> the pinned path is ABSENT mid-install — the ENOENT gap a retained release falls into", async () => {
  // The other half of F1: even before the bytes change, rename-aside makes the pinned pathname
  // VANISH for a window. A retained release exec'ing that absolute path in that window gets
  // ENOENT. Proven by parking a real process inside the gap and looking.
  const mutantPath = writeVulnerableStore("gap");

  const home = freshHome("mutant-gap");
  const v = variantInterpreter(workspace, "mutant-gap");
  const id = storedIdentityOf(v)!;
  const P = installInterpreter({ home, source: v, expected: { version: id.version, abi: id.abi } }).path;
  corruptEntry(P);
  assert.ok(existsSync(P), "the premise: the pinned path exists before the install starts");

  const marker = join(workspace, "mutant-gap.marker");
  rmSync(marker, { force: true });
  const script = childScript(
    "mutant-gap.mts",
    `import { installInterpreter } from ${JSON.stringify(mutantPath)};
import { writeFileSync } from "node:fs";
installInterpreter({
  home: ${JSON.stringify(home)},
  source: ${JSON.stringify(v)},
  expected: ${JSON.stringify({ version: id.version, abi: id.abi })},
  onPhase: (p) => {
    if (p !== "beforeCommit") return;
    writeFileSync(${JSON.stringify(marker)}, "in the gap");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
  },
});
`,
  );
  killAtSeam(script, marker);

  // RED, observed on the filesystem: the child died between the rename-aside and the
  // rename-in, and the pinned pathname is GONE.
  assert.equal(existsSync(P), false, "MUTANT: the pinned interpreter path is ABSENT — a retained release exec'ing it here gets ENOENT");
  const aside = publishedEntries(home).filter((n) => n.includes(".invalid-"));
  assert.equal(aside.length, 1, "MUTANT: the incumbent was renamed aside — and an interrupt left it there, permanently unreachable by name");

  // GREEN, same fixture shape, the fixed store: there is no gap to park in, because the fixed
  // store never renames the incumbent at all — it refuses before staging anything.
  const home2 = freshHome("mutant-gap-fixed");
  const P2 = installInterpreter({ home: home2, source: v, expected: { version: id.version, abi: id.abi } }).path;
  corruptEntry(P2);
  assert.throws(
    () => installInterpreter({ home: home2, source: v, expected: { version: id.version, abi: id.abi } }),
    /refusing to touch an existing interpreter entry that does not validate/i,
  );
  assert.equal(existsSync(P2), true, "the fixed store never opens the window: the pinned path is present throughout");
  assert.deepEqual(publishedEntries(home2).filter((n) => n.includes(".invalid-")), [], "and it never renames the incumbent aside");

  rmTree(home);
  rmTree(home2);
});

function mkdtempIn(label: string): string {
  const p = join(workspace, label);
  mkdirSync(p, { recursive: true });
  return p;
}
