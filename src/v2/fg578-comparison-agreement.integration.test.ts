// FG-578 (criterion 7, second seam): the INSTALLER and the DETECTOR cannot
// disagree about whether an installed copy DIFFERS from this release's seed.
//
// fg578-ownership-agreement.test.ts pins the other half — that the two sides name
// the same CATEGORIES (agents/constraints/raci) as operator-authored. But naming
// the same categories is not enough: for an authored file the installer still has
// to decide, byte for byte, whether the operator's copy has diverged, and so does
// the detector. They decide it with DIFFERENT mechanisms:
//
//   installer  — scripts/install-seeds.sh:88, `cmp -s "$src" "$dstfile"` in shell,
//                at WRITE time. Its answer drives RETAIN (differs) vs install-over
//                / no-op (same).
//   detector   — seed-drift.ts sameContent(), `readFileSync(a) === readFileSync(b)`
//                in TypeScript, LATER. Its answer drives drifted vs current.
//
// They cannot be merged — opposite sides of a language and a lifecycle boundary,
// and the retention decision genuinely must be made by the writer, in shell. But
// if the two ever disagree on some input, THIS ticket's invariant breaks one layer
// down: the installer could overwrite a file the detector calls operator-edited
// (clobber), or retain one the detector calls current (false refresh). So the
// agreement is a GATE, not a coincidence.
//
// This drives the REAL code paths against each other over the SAME (seed,
// installed) byte pair — it runs the actual install-seeds.sh and reads its RETAIN
// decision (which :88's cmp -s produces), then runs detectSeedDrift() over the
// same pair and reads sameContent()'s decision. Neither side is reimplemented;
// reimplementing cmp -s here would just add a THIRD mechanism to disagree with.
//
// SAFETY: every root is a disposable mkdtemp, torn down in `finally`. FORGE_HOME is
// passed to the installer per-exec via env and to the detector as a parameter —
// never the real ~/.forge, never process.env. CLAUDE_SKILLS_DEST is a temp sink so
// ~/.claude is never written. Nothing promotes, npm-links, or mutates the checkout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetRoot } from "./asset-root.js";
import { detectSeedDrift } from "./seed-drift.js";

const REL = "constraints/house-style.md"; // an AUTHORED_EXEMPT category → :88 runs

function runInstaller(release: string, home: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", [join(release, "scripts", "install-seeds.sh")], {
    env: { ...process.env, FORGE_HOME: home, CLAUDE_SKILLS_DEST: join(home, "skills-sink"), ...env },
    encoding: "utf8",
  });
}

type Notion = { installerRetains: boolean; detectorDrifts: boolean };

/** Seed `seedBody`, install it, optionally have the operator overwrite the
 *  installed copy with `editBody` (null = leave it byte-identical), then read BOTH
 *  mechanisms' verdict on the resulting (seed, installed) pair:
 *
 *    installerRetains — did install-seeds.sh's :88 `cmp -s` call it "differs" and
 *                       therefore RETAIN it? (read off the real "Retained:" line)
 *    detectorDrifts   — did seed-drift.ts's sameContent() call it "drifted"?
 *
 *  The property under test is installerRetains === detectorDrifts. */
function bothVerdicts(seedBody: string, editBody: string | null): Notion {
  const home = mkdtempSync(join(tmpdir(), "fg578-cmp-home-"));
  const release = mkdtempSync(join(tmpdir(), "fg578-cmp-rel-"));
  try {
    // install-seeds.sh installs agents AND constraints unconditionally and aborts
    // under `set -e` if either seed dir is missing; the rest are `[[ -d ]]`-guarded.
    mkdirSync(join(release, "seeds", "agents"), { recursive: true });
    mkdirSync(join(release, "seeds", "constraints"), { recursive: true });
    mkdirSync(join(release, "scripts"), { recursive: true });
    writeFileSync(join(release, "seeds", "constraints", "house-style.md"), seedBody);
    // The REAL installer byte-for-byte — it resolves its own $HERE, so this
    // release-bundled copy installs THIS release's seed and runs THIS release's
    // :88 comparison. Copying (never editing) it is what makes the test drive the
    // actual write path rather than a re-implementation of it.
    cpSync(join(assetRoot(), "scripts", "install-seeds.sh"), join(release, "scripts", "install-seeds.sh"));

    runInstaller(release, home); // first install: the seed lands in $FORGE_HOME
    if (editBody !== null) writeFileSync(join(home, REL), editBody); // the operator's edit

    const out = runInstaller(release, home, { FORCE: "1" }); // FORCE=1 → :88 decides retain
    const installerRetains = new RegExp(`^Retained: constraints/house-style\\.md `, "m").test(out);

    const entry = detectSeedDrift(join(release, "seeds"), home).entries.find((e) => e.path === REL);
    assert.ok(entry, "detector must produce an entry for the pair under test");
    const detectorDrifts = entry!.status === "drifted";

    return { installerRetains, detectorDrifts };
  } finally {
    for (const d of [home, release]) rmSync(d, { recursive: true, force: true });
  }
}

test("FG-578: identical bytes — installer does NOT retain AND detector reports current", () => {
  // Multibyte UTF-8 with a trailing newline: the exact shape where a raw-byte
  // `cmp -s` and a UTF-8 `readFileSync(...,'utf8') ===` could in principle part
  // ways. They must not.
  const v = bothVerdicts("house style — café 🌱\n", null);
  assert.equal(v.installerRetains, false, "identical bytes: the installer keeps the current copy, it does not RETAIN as divergent");
  assert.equal(v.detectorDrifts, false, "identical bytes: the detector reports current");
  assert.equal(v.installerRetains, v.detectorDrifts, "cmp -s and sameContent() must agree that identical bytes are the SAME file");
});

test("FG-578: differing content — installer RETAINS the authored file AND detector reports drift", () => {
  const v = bothVerdicts("seed prose\n", "operator prose — my own words\n");
  assert.equal(v.installerRetains, true, "differing bytes: the installer retains the operator's authored copy");
  assert.equal(v.detectorDrifts, true, "differing bytes: the detector reports drift");
  assert.equal(v.installerRetains, v.detectorDrifts, "cmp -s and sameContent() must agree that differing bytes DIFFER");
});

test("FG-578: differing only by a trailing newline — the two mechanisms still agree", () => {
  // The encoding/whitespace edge the finding calls out by name. `cmp -s` is a
  // raw-byte compare and sees the missing final \n; sameContent() compares decoded
  // strings and sees it too. If they ever parted on trailing-newline handling, one
  // would clobber (or falsely refresh) a file the other calls unchanged.
  const v = bothVerdicts("seed prose\n", "seed prose");
  assert.equal(v.installerRetains, true, "a dropped trailing newline is a real byte difference → retain");
  assert.equal(v.detectorDrifts, true, "…and sameContent() agrees it is a difference");
  assert.equal(v.installerRetains, v.detectorDrifts, "trailing-newline handling must agree across the shell/TS boundary");
});

test("FG-578: differing by a single multibyte codepoint — the two mechanisms still agree", () => {
  const v = bothVerdicts("café\n", "cafe\n");
  assert.equal(v.installerRetains, true);
  assert.equal(v.detectorDrifts, true);
  assert.equal(v.installerRetains, v.detectorDrifts, "a one-codepoint UTF-8 difference must read the same to cmp -s and to sameContent()");
});
