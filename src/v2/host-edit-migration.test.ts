import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectHostEdits,
  hostEditMigrationComplete,
  hostEditMigrationLatchPath,
  hostEditMigrationRootDir,
  renderReinstateReport,
  runHostEditMigration,
} from "./host-edit-migration.js";

// A (seeds, forgeHome) pair under a throwaway temp root. NEVER touches the real
// ~/.forge — every path is a parameter to the pure detect/run functions.
function fixture(): { seeds: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "host-edit-migration-"));
  const seeds = join(root, "seeds");
  const home = join(root, "forge-home");
  mkdirSync(join(seeds, "agents", "engineer"), { recursive: true });
  mkdirSync(join(seeds, "constraints"), { recursive: true });
  mkdirSync(join(home, "agents", "engineer"), { recursive: true });
  mkdirSync(join(home, "constraints"), { recursive: true });
  // Shipped seeds.
  writeFileSync(join(seeds, "agents", "engineer", "CLAUDE.md"), "engineer base\n");
  writeFileSync(join(seeds, "constraints", "no-ai-attribution.md"), "no attribution\n");
  writeFileSync(join(seeds, "forge-raci.md"), "raci v1\n");
  return { seeds, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A deterministic clock for a run's backup-dir timestamp.
function at(iso: string): Date {
  return new Date(iso);
}

test("AC1: a divergent host file is backed up BEFORE any overwrite", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    // Operator EDITED the shipped constraint.
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "no attribution — MY EDIT\n");
    // ...and left an identical copy of the raci (must NOT be backed up).
    writeFileSync(join(home, "forge-raci.md"), "raci v1\n");

    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });

    assert.equal(r.outcome, "backed-up");
    assert.ok(r.backupDir);
    // The edited constraint is in the backup, byte-for-byte, at its relative path.
    const backed = join(r.backupDir!, "constraints", "no-ai-attribution.md");
    assert.ok(existsSync(backed), "edited constraint must be backed up");
    assert.equal(readFileSync(backed, "utf8"), "no attribution — MY EDIT\n");
    assert.deepEqual(r.backedUp, ["constraints/no-ai-attribution.md"]);
  } finally {
    cleanup();
  }
});

test("an IDENTICAL host file is NOT backed up", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    writeFileSync(join(home, "forge-raci.md"), "raci v1\n"); // identical to seed
    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    assert.equal(r.outcome, "nothing-to-back-up");
    assert.equal(r.backupDir, null);
    assert.deepEqual(r.backedUp, []);
    // But the latch is still written — the step ran and had its chance.
    assert.ok(r.latchWritten);
    assert.ok(hostEditMigrationComplete(home));
  } finally {
    cleanup();
  }
});

test("an operator-ADDED file (no seed) is backed up and classified `added`", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    writeFileSync(join(home, "constraints", "my-custom.md"), "my custom rule\n");
    const d = detectHostEdits(seeds, home);
    const added = d.files.find((f) => f.rel === "constraints/my-custom.md");
    assert.ok(added, "added file detected");
    assert.equal(added!.kind, "added");
    assert.equal(added!.seedPath, null);

    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    assert.ok(existsSync(join(r.backupDir!, "constraints", "my-custom.md")));
  } finally {
    cleanup();
  }
});

test("AC3: an orphan pre-rename agent dir is INCLUDED in the backup and classified `orphan`", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    // `architect` is a pre-rename dir — unreferenced, no seed, may hold edits.
    mkdirSync(join(home, "agents", "architect"), { recursive: true });
    writeFileSync(join(home, "agents", "architect", "CLAUDE.md"), "old architect prose\n");

    const d = detectHostEdits(seeds, home);
    const orphan = d.files.find((f) => f.rel === "agents/architect/CLAUDE.md");
    assert.ok(orphan, "orphan file detected");
    assert.equal(orphan!.kind, "orphan");
    assert.deepEqual(d.orphanDirs, ["architect"]);

    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    assert.ok(existsSync(join(r.backupDir!, "agents", "architect", "CLAUDE.md")), "orphan dir backed up");
    assert.equal(readFileSync(join(r.backupDir!, "agents", "architect", "CLAUDE.md"), "utf8"), "old architect prose\n");
  } finally {
    cleanup();
  }
});

test("AC4: the latch is written and is the gate hostEditMigrationComplete reads", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    assert.equal(hostEditMigrationComplete(home), false, "not complete before the run");
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "edited\n");
    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    assert.ok(r.latchWritten);
    assert.equal(r.latchPath, hostEditMigrationLatchPath(home));
    assert.ok(existsSync(r.latchPath));
    assert.equal(hostEditMigrationComplete(home), true, "complete after the run");
    const latch = JSON.parse(readFileSync(r.latchPath, "utf8"));
    assert.equal(latch.version, 1);
    assert.ok(latch.firstRanAt);
  } finally {
    cleanup();
  }
});

test("AC2: a second run makes a NEW timestamp dir and never overwrites the prior backup", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "edit one\n");
    const first = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    // The operator has NOT reinstated — retention leaves the host file diverging,
    // so a second run re-detects the same divergence.
    const second = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T13:00:00Z") });

    assert.equal(first.outcome, "backed-up");
    assert.equal(second.outcome, "backed-up");
    assert.notEqual(first.backupDir, second.backupDir, "each run gets its own timestamp dir");
    // The prior backup is intact and untouched.
    assert.ok(existsSync(join(first.backupDir!, "constraints", "no-ai-attribution.md")));
    assert.equal(readFileSync(join(first.backupDir!, "constraints", "no-ai-attribution.md"), "utf8"), "edit one\n");

    // Two distinct timestamped dirs under the backup root (plus the dotfile latch,
    // which readdir over dirs must not have swept up as a backup).
    const dirs = readdirSync(hostEditMigrationRootDir(home), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    assert.equal(dirs.length, 2);
  } finally {
    cleanup();
  }
});

test("AC2: even identical `now` never overwrites — the dir is made unique", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "edit\n");
    const when = at("2026-08-27T12:00:00Z");
    const a = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: when });
    const b = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: when });
    assert.notEqual(a.backupDir, b.backupDir);
    assert.ok(existsSync(a.backupDir!));
    assert.ok(existsSync(b.backupDir!));
  } finally {
    cleanup();
  }
});

test("the report carries BOTH reinstate cases — added AS-IS, edited as a DELTA", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "engineer base + MY EDIT\n"); // edited agent
    writeFileSync(join(home, "constraints", "my-custom.md"), "new rule\n"); // added constraint
    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    const text = r.report.join("\n");

    // Case 1: ADDED — reinstate as-is via a copy into the project.
    assert.match(text, /ADDED/);
    assert.match(text, /AS-IS/);
    assert.match(text, /constraints\/my-custom\.md/);
    // Case 2: EDITED agent base — a small ADDENDUM, explicitly NOT the whole file.
    assert.match(text, /EDITED/);
    assert.match(text, /ADDENDUM/);
    assert.match(text, /do NOT\s*\n?\s*paste the whole/);
    // The `<backup>` placeholder is substituted with the real dir on a real run.
    assert.ok(!text.includes("<backup>"));
    assert.ok(r.backupDir && text.includes(r.backupDir));
  } finally {
    cleanup();
  }
});

test("renderReinstateReport is empty when nothing diverges (nothing loud to say)", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    assert.deepEqual(renderReinstateReport(detectHostEdits(seeds, home), home), []);
  } finally {
    cleanup();
  }
});

test("AC5: a backup failure is non-blocking — reported `failed`, never thrown", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "edited\n");
    // Wedge the backup root: a regular FILE where the root dir must be makes
    // mkdirSync throw. The run must CATCH and report, not propagate.
    writeFileSync(hostEditMigrationRootDir(home), "not a directory\n");
    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    assert.equal(r.outcome, "failed");
    assert.ok(r.error);
    assert.equal(r.latchWritten, false);
    // A failed backup must NOT claim the migration is complete.
    assert.equal(hostEditMigrationComplete(home), false);
  } finally {
    cleanup();
  }
});

test("dry-run forecasts the backup and writes NOTHING", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "edited\n");
    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, dryRun: true, now: at("2026-08-27T12:00:00Z") });
    assert.equal(r.outcome, "would-back-up");
    assert.equal(r.backupDir, null);
    assert.equal(r.latchWritten, false);
    assert.equal(existsSync(hostEditMigrationRootDir(home)), false, "dry-run touches no disk state");
    assert.equal(hostEditMigrationComplete(home), false);
  } finally {
    cleanup();
  }
});

test("no release seeds to compare against → not-run, no latch fabricated", () => {
  const { seeds, home, cleanup } = fixture();
  try {
    rmSync(seeds, { recursive: true, force: true });
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "edited\n");
    const r = runHostEditMigration({ seedsDir: seeds, forgeHome: home, now: at("2026-08-27T12:00:00Z") });
    assert.equal(r.outcome, "not-run");
    assert.equal(r.latchWritten, false);
    assert.equal(hostEditMigrationComplete(home), false);
  } finally {
    cleanup();
  }
});
