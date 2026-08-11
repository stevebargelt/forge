// FG-693 (fix batch) — WHAT THE SCOPE SEAM COSTS, AND WHAT IT MAY NOT DROP.
//
// Three mechanisms the adversarial reviews found in the shipped scope seam. None of
// them is a style point: two are correctness defects wearing performance clothes.
//
//   C1  `scopeIncludes` took the RAW scope and re-resolved every operator spelling
//       through the filesystem on each invocation — and it is called once per ROW
//       inside a loop. Combined with a synchronous realpath sweep over the recorded
//       spellings, that is tens of milliseconds of blocked event loop per request on
//       a single-threaded server. It also re-resolved the ALREADY-PROVEN target once
//       per candidate, which is roughly half the syscalls and provably redundant.
//
//   C2  the legacy-spelling scan was `LIMIT 2000` with NO `ORDER BY`. An unordered
//       limit is nondeterministic, so on a store with more distinct legacy spellings
//       than the cap an in-scope row could silently vanish from a scoped view — the
//       exact empty-board defect class FG-693 exists to remove, reintroduced as a
//       performance defence.
//
//   C5  `hasCanonicalColumn` cached a NEGATIVE answer for the life of the DB handle.
//       A peer forge migrating the store in place (every forge process runs
//       migrations on its next open) left a long-running dashboard permanently blind
//       to the canonical column, serving the legacy read path forever.
//
// Every assertion drives the dashboard's own query entry points against a real
// store, never the identity helper (AC5's seam rule). C1 is the one exception and it
// is stated as such: "the scope is resolved once, not once per row" is a property of
// the code's SHAPE, and Node freezes a builtin's ESM namespace, so a realpath spy
// would be bound at link time, observe nothing, and pass vacuously. It is therefore
// enforced by the compiler (`scopeIncludes` takes a RESOLVED scope, so a caller
// cannot hand it a raw one) and asserted here over the source.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tmpHome = mkdtempSync(join(tmpdir(), "fg693-scope-cost-"));
process.env.FORGE_HOME = tmpHome;

const { recentActivity } = await import("./queries.js");

// ── the fixture: one real checkout, reached under two spellings ─────────────

const trees = join(tmpHome, "trees");
mkdirSync(join(trees, "alpha"), { recursive: true });
symlinkSync(trees, join(tmpHome, "link"));
const ALIAS = join(tmpHome, "link", "alpha");
const PHYSICAL = realpathSync(ALIAS);
assert.notEqual(ALIAS, PHYSICAL, "fixture: the two spellings must differ, or nothing here discriminates");

const AT = "2026-08-11T10:00:00Z";
const db = new Database(join(tmpHome, "forge.db"));

// A store WITHOUT the canonical column on `runs` — the shape a peer forge has not
// migrated yet, which is what C5 is about. It gains the column mid-file.
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT, completed_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, completed_at TEXT, parent_id TEXT, result TEXT, error TEXT);
`);

function addRun(id: string, projectDir: string): void {
  db.prepare(`INSERT INTO runs (id, title, workflow, project_dir, status, created_at, completed_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, `run ${id}`, "feature", projectDir, "complete", AT, AT);
}

function addTask(id: string, runId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, created_at, started_at, completed_at, result)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, runId, "implementation", "engineer", "complete", AT, AT, AT, '{"ok":true}');
}

// THE LEGACY POPULATION, deliberately larger than the cap that used to bound it.
// 2400 distinct recorded spellings that no longer resolve — the ordinary aged shape
// (disposable clones, per-task worktrees) — and then, LAST, the one row that IS in
// scope. Under `LIMIT 2000` with no ORDER BY, that row is outside whatever slice
// SQLite happened to return, in rowid order and in value order alike.
const FILLER = 2400;
for (let i = 0; i < FILLER; i++) {
  addRun(`run-filler-${i}`, join(tmpHome, "_gone", `checkout-${String(i).padStart(5, "0")}`));
}
addRun("run-in-scope", ALIAS);
addTask("task-in-scope", "run-in-scope");

/** The PRE-FIX scan, restated verbatim, so the fixture is shown to be non-vacuous:
 *  it must reach a DIFFERENT answer than the fixed code does. Without this the test
 *  would pass just as happily against a store the cap never truncated. */
function cappedScanReaches(spelling: string): boolean {
  const rows = db
    .prepare(`SELECT DISTINCT project_dir FROM runs WHERE project_dir IS NOT NULL AND project_dir != '' LIMIT 2000`)
    .all() as Array<{ project_dir: string }>;
  return rows.some((r) => r.project_dir === spelling);
}

test("FG-693/C2: the legacy scan has no silent truncation — an in-scope row past the old cap is still found", () => {
  assert.equal(
    cappedScanReaches(ALIAS),
    false,
    "NOT vacuous: the pre-fix LIMIT 2000 never reached this row's recorded spelling",
  );

  const entries = recentActivity(100, undefined, PHYSICAL);
  assert.deepEqual(
    entries.map((e) => e.runId),
    ["run-in-scope"],
    "a scoped view that drops an in-scope row because a cap ran out is the empty board FG-693 removes",
  );
  assert.equal(entries[0]?.projectDir, ALIAS, "presentation still carries the recorded bytes");
});

test("FG-693/C2: the negative control still holds at that size — an out-of-scope spelling claims nothing", () => {
  const otherTree = join(trees, "beta");
  mkdirSync(otherTree, { recursive: true });
  assert.deepEqual(
    recentActivity(100, undefined, realpathSync(otherTree)),
    [],
    "removing the cap must not widen what identity claims",
  );
});

test("FG-693/C5: a negative canonical-column answer is RE-CHECKED, so a peer's migration is observed", () => {
  // The read above ran against a store with no canonical column, so the absent answer
  // is what the reader last saw. A peer forge now migrates the store IN PLACE — the
  // ordinary case, since every forge process runs migrations on its next open — and
  // writes a row the way today's writer does: bytes in project_dir, PROVEN identity
  // beside them.
  db.exec(`ALTER TABLE runs ADD COLUMN project_dir_canonical TEXT`);
  // The row is reachable ONLY through the canonical column, which is what makes this
  // non-vacuous: its recorded spelling is a per-task worktree that has since been
  // reaped, so the legacy arm — recorded bytes, resolved at read time — can prove
  // nothing about it. Its identity WAS proven when it was written, and that is the
  // whole point of the column.
  const reaped = join(tmpHome, "_reaped", "worktree-1");
  assert.equal(cappedScanReaches(reaped), false, "fixture: the reaped spelling is not in the store yet");
  db.prepare(
    `INSERT INTO runs (id, title, workflow, project_dir, status, created_at, completed_at, project_dir_canonical)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("run-migrated", "written after the migration", "feature", reaped, "complete", AT, AT, PHYSICAL);
  addTask("task-migrated", "run-migrated");

  const entries = recentActivity(100, undefined, PHYSICAL);
  assert.deepEqual(
    entries.map((e) => e.runId).sort(),
    ["run-in-scope", "run-migrated"],
    "a cached NEGATIVE would keep this reader on the legacy path for the life of its handle — and the " +
      "legacy path cannot reach a row whose recorded directory is gone",
  );
});

// ── C1: the shape the cost argument rests on ───────────────────────────────

test("FG-693/C1: the per-row predicate cannot re-resolve the scope — it takes a RESOLVED one", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "queries.ts"), "utf8");
  const start = source.indexOf("function scopeIncludes(");
  assert.ok(start > 0, "fixture: the predicate must be findable, or this asserts nothing");
  const body = source.slice(start, source.indexOf("\n}\n", start));

  assert.match(
    body,
    /function scopeIncludes\(\s*targets: ScopeTargets \| undefined/,
    "the signature is the enforcement: a caller cannot hand a raw scope to a per-row predicate",
  );
  assert.doesNotMatch(
    body,
    /resolveScopeTargets\(|resolveScope\(/,
    "resolving the operator's whole scope inside a per-row predicate is the defect — it is a filesystem " +
      "sweep per row on a single-threaded event loop",
  );
  assert.doesNotMatch(
    body,
    /provenSameOnly\(/,
    "and the targets are ALREADY the filesystem's answer, so re-resolving them per candidate is provably " +
      "wasted work the contract's own guidance says not to do",
  );
});
