// FG-693 AC1 + AC2 for the contract itself.
//
// PORTABLE BY CONSTRUCTION. Every alias in this file is one the test CREATES —
// a symlinked parent, a trailing separator, a relative spelling, a `.`/`..`
// spelling — so the whole class is exercised on a Linux CI runner with no
// dependence on any operating system's built-in aliases. That is deliberate:
// the defect FG-693 fixes was CI-green and host-red for three tickets because
// the only coverage that existed relied on aliases one platform happened to
// provide. The native alias cases are exercised on the host, by the consumer
// suites; this file must behave IDENTICALLY on both.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asIdentity,
  compareIdentity,
  describeIdentity,
  identify,
  lexicalResolutionOf,
  matchesOrIndeterminate,
  provenPhysical,
  provenSameOnly,
} from "./path-identity.js";
import * as pathIdentity from "./path-identity.js";

let base: string;
/** The physical spelling of the one fixture tree every alias below must equal. */
let canonical: string;

beforeEach(() => {
  // realpath the fixture root itself: the temp root may sit under a symlinked
  // parent on some hosts, and `canonical` must be the physical spelling so the
  // negative controls compare physical against physical.
  base = realpathSync(mkdtempSync(join(tmpdir(), "forge-path-identity-")));
  mkdirSync(join(base, "real", "checkout"), { recursive: true });
  symlinkSync(join(base, "real"), join(base, "link"), "dir");
  mkdirSync(join(base, "proj"), { recursive: true });
  mkdirSync(join(base, "proj-two"), { recursive: true });
  canonical = join(base, "real", "checkout");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// ── the resolved case ──────────────────────────────────────────────────────

test("identify: a resolved identity carries the physical path AND the spelling verbatim", () => {
  const spelled = canonical + sep;
  const id = identify(spelled);
  assert.equal(id.kind, "resolved");
  assert.equal(provenPhysical(id), canonical);
  // The operator's spelling is preserved byte-for-byte — never normalized,
  // never converged, never rewritten.
  assert.equal(id.asWritten, spelled);
});

test("compareIdentity: a TRAILING-SEPARATOR spelling is the same identity", () => {
  assert.equal(compareIdentity(canonical + sep, canonical), "same");
});

test("compareIdentity: a `.`/`..`-bearing spelling is the same identity", () => {
  const dotted = [base, "real", "..", "real", ".", "checkout"].join(sep);
  assert.equal(compareIdentity(dotted, canonical), "same");
});

test("compareIdentity: a SYMLINKED PARENT is the same identity", () => {
  // base/link -> base/real, so base/link/checkout and base/real/checkout are
  // one tree under two spellings. No prefix is enumerated to see it.
  assert.equal(compareIdentity(join(base, "link", "checkout"), canonical), "same");
});

test("compareIdentity: a RELATIVE spelling is the same identity", () => {
  const cwd = process.cwd();
  try {
    process.chdir(base);
    assert.equal(compareIdentity(join("real", "checkout"), canonical), "same");
    assert.equal(compareIdentity(join(".", "link", "checkout"), canonical), "same");
  } finally {
    process.chdir(cwd);
  }
});

// ── the negative control (AC7 at the primitive) ────────────────────────────

test("compareIdentity: distinct physical dirs sharing a lexical PREFIX are different", () => {
  // "proj" is a strict string prefix of "proj-two". Raw prefix reasoning about
  // paths says these overlap; they are two directories.
  assert.equal(compareIdentity(join(base, "proj"), join(base, "proj-two")), "different");
  assert.equal(compareIdentity(join(base, "proj") + sep, join(base, "proj-two") + sep), "different");
  // And an alias of one still does not reach the other.
  assert.equal(compareIdentity(join(base, "link", "checkout"), join(base, "proj")), "different");
});

// ── the unresolved case ────────────────────────────────────────────────────

test("identify: a deleted path is UNRESOLVED and exposes NO physical path", () => {
  const gone = join(base, "gone-a");
  mkdirSync(gone);
  rmSync(gone, { recursive: true, force: true });

  const id = identify(gone);
  assert.equal(id.kind, "unresolved");
  // The defect this shape prevents: no lexically-resolved path is handed back
  // in the resolved case's shape, so nothing downstream can read a guess as a
  // proven identity.
  assert.equal(provenPhysical(id), null);
  assert.equal((id as { physical?: string }).physical, undefined);
  assert.equal(id.asWritten, gone);
  assert.equal(id.reason, "ENOENT");
});

test("compareIdentity: two DIFFERENT unresolved spellings are indeterminate, never same", () => {
  const a = join(base, "gone-a");
  const b = join(base, "gone-b");
  assert.equal(compareIdentity(a, b), "indeterminate");
});

test("compareIdentity: the SAME unresolved spelling twice is STILL indeterminate", () => {
  // Byte equality of an unproven spelling proves nothing — an absolute spelling
  // that no longer resolves cannot say what it used to name. "Looks the same"
  // is exactly the reasoning this contract deletes.
  const gone = join(base, "gone-a");
  assert.equal(compareIdentity(gone, gone), "indeterminate");
});

test("compareIdentity: resolved against unresolved is indeterminate, in both orders", () => {
  const gone = join(base, "gone-a");
  assert.equal(compareIdentity(canonical, gone), "indeterminate");
  assert.equal(compareIdentity(gone, canonical), "indeterminate");
});

test("identify: an untraversable path is unresolved, not a throw", () => {
  // A non-directory in the middle of the chain: resolution fails for a reason
  // that is not ENOENT, and it is still a VALUE. Nothing on the publication or
  // cleanup path may take an exception here — that is what pushed the earlier
  // helpers into faking a resolution.
  const file = join(base, "real", "a-file");
  writeFileSync(file, "");
  const id = identify(join(file, "deeper"));
  assert.equal(id.kind, "unresolved");
  assert.equal(provenPhysical(id), null);
  assert.equal(id.kind === "unresolved" && id.reason, "ENOTDIR");
});

// ── the two projections: the direction each one fails in ───────────────────

test("matchesOrIndeterminate: the GUARD fires on same AND on indeterminate", () => {
  const gone = join(base, "gone-a");
  assert.equal(matchesOrIndeterminate(join(base, "link", "checkout"), canonical), true);
  assert.equal(matchesOrIndeterminate(canonical + sep, canonical), true);
  // The load-bearing arm: an unprovable comparison must NOT let a guard go
  // inert. A guard that cannot prove the trees are distinct assumes they are not.
  assert.equal(matchesOrIndeterminate(gone, canonical), true);
  assert.equal(matchesOrIndeterminate(gone, join(base, "gone-b")), true);
  assert.equal(matchesOrIndeterminate(join(base, "proj"), join(base, "proj-two")), false);
});

test("provenSameOnly: the ACTOR refuses on indeterminate and acts only on proof", () => {
  const gone = join(base, "gone-a");
  assert.equal(provenSameOnly(join(base, "link", "checkout"), canonical), true);
  assert.equal(provenSameOnly(canonical + sep, canonical), true);
  // The load-bearing arm: an unproven identity never authorizes an act.
  assert.equal(provenSameOnly(gone, canonical), false);
  assert.equal(provenSameOnly(gone, gone), false);
  assert.equal(provenSameOnly(join(base, "proj"), join(base, "proj-two")), false);
});

test("the two projections disagree exactly on indeterminate, and only there", () => {
  const gone = join(base, "gone-a");
  const pairs: Array<[string, string]> = [
    [canonical, canonical],
    [join(base, "link", "checkout"), canonical],
    [join(base, "proj"), join(base, "proj-two")],
    [gone, canonical],
    [gone, join(base, "gone-b")],
  ];
  for (const [a, b] of pairs) {
    const verdict = compareIdentity(a, b);
    assert.equal(
      matchesOrIndeterminate(a, b) !== provenSameOnly(a, b),
      verdict === "indeterminate",
      `projections must differ iff the comparison is indeterminate (${a} vs ${b} → ${verdict})`
    );
  }
});

// ── the durable-column and display projections ─────────────────────────────

test("provenPhysical: a proven path or null — never a lexical fallback", () => {
  assert.equal(provenPhysical(join(base, "link", "checkout")), canonical);
  assert.equal(provenPhysical(join(base, "gone-a")), null);
});

test("describeIdentity: an unresolved spelling may be SHOWN, but is labelled", () => {
  assert.equal(describeIdentity(join(base, "link", "checkout")), canonical);
  const shown = describeIdentity(join(base, "gone-a"));
  assert.match(shown, /UNRESOLVED/);
  assert.ok(shown.includes(join(base, "gone-a")), "the operator's spelling stays visible for display");
});

test("asIdentity: an already-computed identity passes through untouched", () => {
  const id = identify(canonical);
  assert.equal(asIdentity(id), id);
  assert.equal(compareIdentity(id, canonical + sep), "same");
});

test("lexicalResolutionOf: lexical only — it asks the filesystem nothing", () => {
  // Sanctioned use is FG-693's retarget-proof predicate and nothing else.
  const gone = join(base, "gone-a");
  assert.equal(lexicalResolutionOf(gone), gone);
  // Through the symlink the LEXICAL answer keeps the link spelling; the PROVEN
  // one does not. That gap is the whole signal the predicate reads.
  const viaLink = join(base, "link", "checkout");
  assert.equal(lexicalResolutionOf(viaLink), viaLink);
  assert.notEqual(lexicalResolutionOf(viaLink), provenPhysical(viaLink));
  assert.equal(lexicalResolutionOf(canonical), provenPhysical(canonical));
  assert.equal(lexicalResolutionOf(identify(canonical + sep)), canonical);
});

// ── AC1 enforced mechanically against this module's own source ─────────────

test("the implementation enumerates no aliases and branches on no platform", () => {
  const source = readFileSync(fileURLToPath(new URL("./path-identity.ts", import.meta.url)), "utf8");
  for (const banned of ["/private", "/tmp", "/var", "process.platform"]) {
    assert.ok(
      !source.includes(banned),
      `path-identity.ts must not contain ${banned}: the contract covers filesystem aliases ` +
        `generically via realpath, never by naming today's prefixes or by branching on the host`
    );
  }
});

test("the export surface is the contract — and only the two named projections are boolean", () => {
  assert.deepEqual(Object.keys(pathIdentity).sort(), [
    "asIdentity",
    "compareIdentity",
    "describeIdentity",
    "identify",
    "lexicalResolutionOf",
    "matchesOrIndeterminate",
    "provenPhysical",
    "provenSameOnly",
  ]);

  // Compile-time proof (this is a typecheck gate, not a runtime one): if anyone
  // adds a third boolean-returning export — a plain `isSameProject()` — this
  // assignment stops compiling. The only sanctioned way to collapse the three
  // values to two is a projection that states the direction it fails in.
  type Exports = typeof pathIdentity;
  type BooleanReturningExports = {
    [K in keyof Exports]: Exports[K] extends (...args: never[]) => boolean ? K : never;
  }[keyof Exports];
  const onlyTheTwoProjections: BooleanReturningExports extends "matchesOrIndeterminate" | "provenSameOnly"
    ? true
    : false = true;
  assert.equal(onlyTheTwoProjections, true);
});
