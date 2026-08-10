// FG-698 AC2 — the regression that proves release-fixture teardown survives a PARTIAL
// THAW FAILURE.
//
// The live defect this states: `release.integration.test.ts:187` (and
// `launch-r2.integration.test.ts:37`) called `thawReleaseTree(workspace)` and only then
// `rmSync(workspace)`. `thawReleaseTree` chmods/stats every entry with no error tolerance,
// so ONE unreadable corner threw out of the `after()` hook and the removal on the next line
// never ran — stranding a multi-GB workspace. `disposeReleaseWorkspace` is the tolerant
// seam that replaces that pair: make the tree removable, remove it, report what survived,
// never throw.
//
// Each case PROVES ITS INDUCTION TOOK EFFECT before asserting anything about the response.
// That matters because both inductions are DAC (discretionary access control) denials, and
// DAC does not bind euid 0: run as root, `chmod 0000` stops nothing, the thaw succeeds, and
// a test that skipped straight to "disposal removed the tree" would pass while proving
// nothing at all. So the preconditions are assertions, not setup — under root they go RED
// with a message naming `process.geteuid()`.
//
// Integration tier by suffix: this exercises real filesystem permission semantics on a real
// tree. It builds NO release — the fixtures are a handful of small files, so the whole file
// runs in milliseconds and the unit tier's subprocess/purity budget is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeReleaseWorkspace, freezeReleaseFiles, thawReleaseTree } from "./release.js";

const EUID = typeof process.geteuid === "function" ? process.geteuid() : -1;

/** Why an induction assertion is allowed to fail: it is the only thing standing between
 *  this file and a vacuous green. Named euid in the message so the reader is not left
 *  guessing why a permission denial did not deny. */
function inductionMsg(what: string): string {
  return (
    `${what}\n` +
    `  euid: ${EUID}\n` +
    `This regression induces a permission failure and then asserts teardown survives it. ` +
    `Permission bits do not bind euid 0, so under root the induction silently does nothing ` +
    `and every later assertion would pass while proving nothing. Run this file unprivileged.`
  );
}

/** A stand-in for a release closure, frozen exactly as `buildRelease` freezes one
 *  (post-order, root last, every write bit cleared). Small on purpose: this file is about
 *  permission semantics, not about building a release. */
function frozenTree(parent: string, name: string): { root: string; interior: string } {
  const root = join(parent, name);
  const interior = join(root, "node_modules", "pkg");
  mkdirSync(interior, { recursive: true });
  writeFileSync(join(root, "forge-release.json"), "{}\n");
  writeFileSync(join(root, "node_modules", "top.txt"), "top\n");
  writeFileSync(join(interior, "index.js"), "module.exports = {};\n");
  freezeReleaseFiles(root);
  return { root, interior };
}

/** Teardown for this file's OWN fixtures — deliberately NOT the function under test. A
 *  broken `disposeReleaseWorkspace` must not be able to make the regression that grades it
 *  strand a frozen tree in /tmp. Same "open the directories, then remove" shape, entirely
 *  best-effort. */
function forceRemove(path: string): void {
  const openUp = (d: string): void => {
    try {
      chmodSync(d, lstatSync(d).mode | 0o700);
    } catch {
      // best effort — the readdir below may still work
    }
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (!ent.isSymbolicLink() && ent.isDirectory()) openUp(join(d, ent.name));
    }
  };
  try {
    openUp(path);
  } catch {
    // best effort
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Run `fn` with both standard streams captured. AC2 requires residue to be REPORTED, and
 *  requires that report to land on stderr only: `fg644-dirty-tree-execution.integration.test.ts`
 *  parses an inner run's STDOUT as TAP to grade which tests executed, so a diagnostic there
 *  corrupts the grading. Restoring in `finally` matters — a throw here must not leave the
 *  test runner writing into a closure. */
function captureStreams<T>(fn: () => T): { value: T; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

// (A) THE STRANDING CASE — the exact shape that cost a whole workspace.
//
// A frozen tree with one interior directory that has lost read+search. `thawReleaseTree`
// restores only the WRITE bit (`| 0o200`), so it cannot read what it half-fixed: it throws,
// and in the old teardown the `rmSync` behind it never ran. Disposal chmods DIRECTORIES to
// `| 0o700` PRE-ORDER, so it reaches the same corner and removes the tree outright.
//
// Note what is NOT asserted here: residue. chmod on an inode you own always succeeds, so an
// r/x-stripped interior directory is fully recoverable BY DISPOSAL — the honest assertion is
// that removal was attempted AND completed. Residue has its own case below, with an
// induction disposal genuinely cannot undo.
test("FG-698 AC2 (A): a tree the strict thaw cannot prepare is still removed, completely", () => {
  const base = mkdtempSync(join(tmpdir(), "fg698-"));
  try {
    const { root, interior } = frozenTree(base, "rel");

    // INDUCTION: strip read + search from one interior directory.
    chmodSync(interior, 0o000);
    assert.throws(
      () => readdirSync(interior),
      (e: unknown) => errCode(e) === "EACCES",
      inductionMsg(`expected readdirSync(${interior}) to fail with EACCES after chmod 0o000`),
    );

    // ... and state the live stranding mechanism: the STRICT thaw throws on this tree, which
    // is precisely why the `rmSync` that used to follow it never executed.
    assert.throws(
      () => thawReleaseTree(root),
      (e: unknown) => errCode(e) === "EACCES",
      inductionMsg(`expected thawReleaseTree(${root}) to throw EACCES on the unreadable interior directory`),
    );

    // RESPONSE, on the half-thawed tree the failed thaw left behind.
    const { value: residue, stdout, stderr } = captureStreams(() =>
      disposeReleaseWorkspace(root, "FG-698 AC2 case A"),
    );

    assert.equal(
      existsSync(root),
      false,
      "disposal must still reach the removal after a thaw failure — the whole point of AC1",
    );
    assert.deepEqual(residue, [], "nothing survived, so nothing may be reported as residue");
    assert.equal(stderr, "", "a clean disposal reports nothing — residue reporting must not be noise");
    assert.equal(stdout, "", "teardown diagnostics must never touch stdout (fg644 parses it as TAP)");
  } finally {
    forceRemove(base);
  }
});

// (B) THE RESIDUE-REPORTING CASE — the other half of AC1: what cannot be removed is reported
// with the path and the reason rather than silently stranded.
//
// The induction has to be something the OWNER genuinely cannot fix from inside the tree,
// because chmod on your own inode always succeeds. That is a fixture root inside an
// unwritable PARENT: unlinking `root` needs write on `parent`, and disposal must NOT reach
// outside the path it was handed to chmod its way out. Residue is therefore a real outcome
// of a correct implementation, not a bug.
test("FG-698 AC2 (B): what disposal genuinely cannot remove is reported on stderr with path and reason", () => {
  const base = mkdtempSync(join(tmpdir(), "fg698-"));
  const parent = join(base, "parent");
  const label = "FG-698 AC2 case B";
  try {
    mkdirSync(parent);
    const { root } = frozenTree(parent, "rel");

    // INDUCTION: a probe beside the fixture root proves the parent really is unwritable
    // afterwards — otherwise a filesystem that ignores the mode would let this case assert
    // residue that never had to exist.
    const probe = join(parent, "probe");
    writeFileSync(probe, "probe\n");
    chmodSync(parent, 0o555);
    assert.throws(
      () => rmSync(probe),
      (e: unknown) => errCode(e) === "EACCES" || errCode(e) === "EPERM",
      inductionMsg(`expected rmSync(${probe}) to fail with EACCES/EPERM inside a 0o555 parent`),
    );

    // RESPONSE.
    const { value: residue, stdout, stderr } = captureStreams(() =>
      disposeReleaseWorkspace(root, label),
    );

    assert.equal(existsSync(root), true, "the induction says this root cannot be unlinked");
    // Removed everything it COULD: one unreachable corner must not cost the rest of the tree.
    // (Measured on node v24: recursive rmSync empties the directory and then fails on the
    // final rmdir, which is the parent-write denial.)
    assert.deepEqual(
      readdirSync(root),
      [],
      "disposal must remove what it can reach even when the root itself survives",
    );

    assert.equal(residue.length, 1, `expected exactly the root as residue, got ${JSON.stringify(residue)}`);
    assert.equal(residue[0]?.path, root, "residue names the path that survived");
    assert.match(
      residue[0]?.reason ?? "",
      /EACCES|EPERM/,
      "residue carries the OS reason it survived, not a generic message",
    );

    assert.ok(stderr.includes(label), `the report must name the caller's label; got:\n${stderr}`);
    assert.ok(stderr.includes(root), `the report must name the surviving path; got:\n${stderr}`);
    assert.match(stderr, /EACCES|EPERM/, `the report must carry the reason; got:\n${stderr}`);
    assert.equal(stdout, "", "teardown diagnostics must never touch stdout (fg644 parses it as TAP)");
  } finally {
    // Restores `parent`'s write bit on the way down, so this file strands nothing even
    // though the case is built out of a directory nothing could remove.
    forceRemove(base);
  }
});

// (C) HAPPY PATH — the ordinary teardown, which is what runs on every clean exit. A frozen
// tree with no induced fault is removed completely, reports nothing, and returns no residue.
test("FG-698 AC2 (C): a cleanly frozen tree is disposed of completely and reports nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "fg698-"));
  try {
    const { root } = frozenTree(base, "rel");

    // A frozen tree is genuinely unremovable as-is — that is what the freeze buys, and it is
    // why disposal has to do more than call rmSync.
    assert.throws(
      () => rmSync(root, { recursive: true, force: true }),
      (e: unknown) => errCode(e) === "EACCES" || errCode(e) === "EPERM",
      inductionMsg(`expected a frozen tree at ${root} to refuse a plain recursive rmSync`),
    );

    const { value: residue, stdout, stderr } = captureStreams(() =>
      disposeReleaseWorkspace(root, "FG-698 AC2 case C"),
    );

    assert.equal(existsSync(root), false, "a frozen tree with no fault must be fully removed");
    assert.deepEqual(residue, []);
    assert.equal(stderr, "");
    assert.equal(stdout, "");
  } finally {
    forceRemove(base);
  }
});

// The disposal contract's two remaining edges, both cheap to state and both load-bearing for
// the callers in steps 3/4/5 (an `afterEach` sweep calls this on paths that may already be
// gone, and fixture trees can hold links).
test("FG-698: disposal is idempotent on a missing path and never follows a symlink out of the tree", () => {
  const base = mkdtempSync(join(tmpdir(), "fg698-"));
  try {
    // Idempotent: a per-test sweep re-disposing an already-removed fixture is not an error.
    assert.deepEqual(disposeReleaseWorkspace(join(base, "never-existed"), "FG-698 absent"), []);

    // A link's target lives OUTSIDE the tree being disposed of. The link must be unlinked;
    // the target must be untouched, with its mode intact — disposal chmods nothing it was
    // not handed.
    const outsider = join(base, "outsider");
    mkdirSync(outsider);
    writeFileSync(join(outsider, "keep.txt"), "keep\n");
    chmodSync(outsider, 0o500);
    const modeBefore = lstatSync(outsider).mode;

    const root = join(base, "with-link");
    mkdirSync(root);
    writeFileSync(join(root, "file.txt"), "f\n");
    // Deliberately unfrozen: freezeReleaseFiles refuses a tree holding a link by name, and
    // the property under test here is link handling, not the freeze.
    symlinkSync(outsider, join(root, "link-out"));

    assert.deepEqual(disposeReleaseWorkspace(root, "FG-698 symlink"), []);
    assert.equal(existsSync(root), false, "the tree, including the link itself, is removed");
    assert.equal(existsSync(join(outsider, "keep.txt")), true, "the link's target must survive");
    assert.equal(
      lstatSync(outsider).mode,
      modeBefore,
      "disposal must not chmod through a link into a directory outside the tree it was handed",
    );
  } finally {
    forceRemove(base);
  }
});
