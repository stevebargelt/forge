// FG-777 (FG-767 T4): the host authored seeds are FLIPPED from operator-authored to
// forge-owned and ALWAYS upgraded — GATED on FG-776's one-time host-edit backup.
//
// This is the highest-consequence change in the set: it is the point where
// `install-seeds.sh` begins OVERWRITING agents/constraints/forge-raci.md. The gate
// is the load-bearing safety: the FORCE overwrite of those three MUST NOT fire until
// the FG-776 migration has written its completion latch (so a genuine operator edit
// is always backed up first). This file drives the REAL installer directly and pins
// both directions of the gate, plus the invariant the ACs single out — the overwrite
// CANNOT fire without the latch.
//
// WHY DRIVE THE INSTALLER DIRECTLY: FORCE is a published operator-facing contract
// invoked directly from four documented entry points, so the gate lives in the
// WRITER (install-seeds.sh consults the latch), not in the `forge upgrade` caller. A
// caller-side test cannot see a bash overwrite that fires unlatched on the other
// three paths; this one runs `bash scripts/install-seeds.sh` itself.
//
// SAFETY: every root is a disposable mkdtemp, torn down in `finally`. FORGE_HOME and
// CLAUDE_SKILLS_DEST are passed per-exec via env — never the real ~/.forge or
// ~/.claude, never process.env. The REAL installer is copied byte-for-byte (it
// resolves its own $HERE), so the test drives the write path rather than a
// re-implementation of it. Nothing promotes, npm-links, or mutates the checkout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assetRoot } from "./asset-root.js";
import { hostEditMigrationLatchPath } from "./host-edit-migration.js";

const SEED = {
  "agents/engineer/CLAUDE.md": "SEED agent prose\n",
  "constraints/house-style.md": "SEED constraint prose\n",
  "forge-raci.md": "SEED raci\n",
  "runtimes/pi-apikey.yml": "# SEED\nprovider: SEED\n",
} as const;

const OPERATOR = {
  "agents/engineer/CLAUDE.md": "OPERATOR agent prose\n",
  "constraints/house-style.md": "OPERATOR constraint prose\n",
  "forge-raci.md": "OPERATOR raci\n",
  "runtimes/pi-apikey.yml": "# OPERATOR\nprovider: mine\n",
} as const;

/** A release tree carrying the seeds above and the REAL installer byte-for-byte. */
function releaseTree(): string {
  const base = mkdtempSync(join(tmpdir(), "fg777-rel-"));
  mkdirSync(join(base, "scripts"), { recursive: true });
  for (const [rel, body] of Object.entries(SEED)) {
    const abs = join(base, "seeds", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  cpSync(join(assetRoot(), "scripts", "install-seeds.sh"), join(base, "scripts", "install-seeds.sh"));
  return base;
}

function install(release: string, home: string, opts: { force?: boolean } = {}): string {
  return execFileSync("bash", [join(release, "scripts", "install-seeds.sh")], {
    env: {
      ...process.env,
      FORGE_HOME: home,
      CLAUDE_SKILLS_DEST: join(home, "skills-sink"),
      ...(opts.force ? { FORCE: "1" } : {}),
    },
    encoding: "utf8",
  });
}

/** Write the FG-776 completion latch into `home` — the state the gate keys on. */
function writeLatch(home: string): void {
  const latch = hostEditMigrationLatchPath(home);
  mkdirSync(dirname(latch), { recursive: true });
  writeFileSync(latch, JSON.stringify({ version: 1, migration: "FG-776 host-edit-backup" }) + "\n");
}

function withRoots(fn: (release: string, home: string) => void): void {
  const release = releaseTree();
  const home = mkdtempSync(join(tmpdir(), "fg777-home-"));
  try {
    fn(release, home);
  } finally {
    for (const d of [release, home]) rmSync(d, { recursive: true, force: true });
  }
}

const read = (home: string, rel: string): string => readFileSync(join(home, rel), "utf8");

/** Seed the host, then have the operator diverge every category. */
function seededHostWithOperatorEdits(release: string, home: string): void {
  install(release, home); // first install: creates from the seed
  for (const [rel, body] of Object.entries(OPERATOR)) writeFileSync(join(home, rel), body);
}

// ───────────────────────── AC2: latch ABSENT → retain ─────────────────────────

test("FG-777 AC2: WITHOUT the migration latch, FORCE=1 does NOT overwrite the flipped host authored seeds — the overwrite cannot fire without the latch", () => {
  withRoots((release, home) => {
    seededHostWithOperatorEdits(release, home);

    const out = install(release, home, { force: true });

    // The three flipped categories are RETAINED — the gate withholds the always-upgrade.
    assert.equal(read(home, "agents/engineer/CLAUDE.md"), OPERATOR["agents/engineer/CLAUDE.md"], "agent seed retained — no latch");
    assert.equal(read(home, "constraints/house-style.md"), OPERATOR["constraints/house-style.md"], "constraint retained — no latch");
    assert.equal(read(home, "forge-raci.md"), OPERATOR["forge-raci.md"], "raci retained — no latch");

    // …and the operator is TOLD, per file, that the migration must run first.
    assert.match(out, /^Retained: agents\/engineer\/CLAUDE\.md /m);
    assert.match(out, /^Retained: constraints\/house-style\.md /m);
    assert.match(out, /^Retained: forge-raci\.md /m);
    assert.match(out, /GATED/, "the report says the flip is gated");
    assert.match(out, /migration|pre-upgrade backup|forge upgrade/i, "…and that the migration must run first");
  });
});

test("FG-777 (guard): the gate is scoped to the three — a forge-owned RUNTIME still refreshes with no latch", () => {
  // Over-fix guard, the mirror of FG-578's: exempting/withholding everything would
  // reintroduce the #265 stale-runtime failure. runtimes are not latch-gated.
  withRoots((release, home) => {
    seededHostWithOperatorEdits(release, home);

    install(release, home, { force: true });

    assert.equal(read(home, "runtimes/pi-apikey.yml"), SEED["runtimes/pi-apikey.yml"], "a runtime is forge-owned and NOT gated — FORCE refreshes it, latch or no latch");
  });
});

// ───────────────────────── AC1: latch PRESENT → overwrite ─────────────────────────

test("FG-777 AC1: WITH the migration latch, FORCE=1 overwrites the flipped host authored seeds, exactly like any forge-owned file", () => {
  withRoots((release, home) => {
    seededHostWithOperatorEdits(release, home);
    writeLatch(home); // FG-776 has run

    const out = install(release, home, { force: true });

    assert.equal(read(home, "agents/engineer/CLAUDE.md"), SEED["agents/engineer/CLAUDE.md"], "agent seed force-refreshed — latch present");
    assert.equal(read(home, "constraints/house-style.md"), SEED["constraints/house-style.md"], "constraint force-refreshed — latch present");
    assert.equal(read(home, "forge-raci.md"), SEED["forge-raci.md"], "raci force-refreshed — latch present");

    // Refreshed, not retained: they are announced as installs and there is no
    // retention/gate report at all.
    assert.match(out, /Installing agents into/);
    assert.match(out, /Installing forge-raci\.md into/);
    assert.ok(!/^Retained:/m.test(out), "nothing is retained once the latch is present");
    assert.ok(!/GATED/.test(out), "no gate withhold message once the migration has run");
  });
});

test("FG-777: with the latch present, a flipped category behaves byte-for-byte like a runtime — absent→create, existing→FORCE-only", () => {
  // The task's claim, pinned as parity: once the migration has run, agents/
  // constraints/raci are forge-owned "exactly like runtimes/workflows/codex". So an
  // ABSENT flipped seed is created by a bare install (like a runtime), and an
  // EXISTING one is left by a bare install but overwritten by FORCE (like a runtime).
  withRoots((release, home) => {
    writeLatch(home);

    // absent → create, on a bare install (no FORCE) — same as a runtime.
    install(release, home);
    assert.equal(read(home, "agents/engineer/CLAUDE.md"), SEED["agents/engineer/CLAUDE.md"], "an absent flipped seed is created by a bare install, like a runtime");
    assert.equal(read(home, "runtimes/pi-apikey.yml"), SEED["runtimes/pi-apikey.yml"], "…and so is the runtime, by the same tier");

    // existing + edited → a bare install leaves it; FORCE overwrites. Parity again.
    writeFileSync(join(home, "agents/engineer/CLAUDE.md"), OPERATOR["agents/engineer/CLAUDE.md"]);
    writeFileSync(join(home, "runtimes/pi-apikey.yml"), OPERATOR["runtimes/pi-apikey.yml"]);
    install(release, home); // bare
    assert.equal(read(home, "agents/engineer/CLAUDE.md"), OPERATOR["agents/engineer/CLAUDE.md"], "bare install leaves an existing flipped seed, like a runtime");
    assert.equal(read(home, "runtimes/pi-apikey.yml"), OPERATOR["runtimes/pi-apikey.yml"], "…and leaves the existing runtime too");
    install(release, home, { force: true }); // FORCE
    assert.equal(read(home, "agents/engineer/CLAUDE.md"), SEED["agents/engineer/CLAUDE.md"], "FORCE overwrites the flipped seed, like a runtime");
    assert.equal(read(home, "runtimes/pi-apikey.yml"), SEED["runtimes/pi-apikey.yml"], "…and the runtime, by the same tier");
  });
});
