// FG-677 (d) — FG-631 absorbed: publication-worktree reclamation. The full matrix
// (registered-published, registered-failed aged, registered-failed fresh, registered-parked,
// orphaned-terminal, in-flight, ownership-ambiguous) + a scale case reaching a 2nd-pass
// fixpoint without leaving terminal node_modules trees. PUBLICATIONS_DIR resolves into the
// per-process FORGE_HOME temp home (test-setup.ts), so the on-disk sweep is real.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { recordPublicationIntent, updatePublicationAttempt, type PublicationState } from "../store/publications.js";
import { PUBLICATIONS_DIR, publicationWorktreeDir } from "../util/paths.js";
import { sweepPublicationWorktrees } from "./integration-publisher.js";
import type { CwdHolderResult } from "./launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const NEVER_HELD = (): CwdHolderResult => ({ held: false });
const DAY_MS = 24 * 60 * 60 * 1000;

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "fg677-pub-proj-"));
  tmpDirs.push(d);
  return d;
}

/** Create a registered attempt in the given terminal/in-flight state, and its worktree
 *  dir on disk (with a node_modules subtree so reclamation is proven to remove it). */
function makeAttempt(id: string, state: PublicationState): string {
  recordPublicationIntent({ attemptId: id, projectKey: "proj", canonicalDir: tmpProject(), runId: "run-p", taskId: `task-${id}`, target: "local", leaseTtlMs: 60_000 });
  updatePublicationAttempt(id, { state, worktreePath: publicationWorktreeDir(id, 0), rebuildCount: 0 });
  const dir = publicationWorktreeDir(id, 0);
  mkdirSync(join(dir, "node_modules", "left-pack"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "left-pack", "index.js"), "module.exports = 1;");
  return dir;
}

/** An on-disk publication-shaped directory with NO attesting registry row. */
function makeOrphanDir(name: string): string {
  const dir = join(PUBLICATIONS_DIR, name);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  return dir;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  mkdirSync(PUBLICATIONS_DIR, { recursive: true });
});
afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  try { rmSync(PUBLICATIONS_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function dispositionFor(records: { path: string; action: string; reason?: string; dryRun?: boolean }[], dir: string) {
  return records.find((r) => r.path === dir);
}

test("FG-677 publication matrix: published RECLAIMED; fresh-failed/parked and in-flight RETAINED; aged-failed RECLAIMED; orphan RETAINED ambiguous", () => {
  const published = makeAttempt("pub-published", "published");
  const failedFresh = makeAttempt("pub-failed-fresh", "failed");
  const failedAged = makeAttempt("pub-failed-aged", "failed");
  const parkedFresh = makeAttempt("pub-parked-fresh", "parked");
  const inFlight = makeAttempt("pub-inflight", "publishing");
  const orphan = makeOrphanDir("orphan-attempt-r0");
  const nonShape = join(PUBLICATIONS_DIR, "not-a-worktree-name");
  mkdirSync(nonShape, { recursive: true });

  // Age only the two "aged" attempts by 8 days past updatedAt: pass a now 8 days ahead. The
  // failed-fresh row shares the same updatedAt, so to keep it FRESH we run two sweeps with
  // different clocks is impractical — instead age the store row for the aged one by
  // rewriting its updatedAt into the past via a second update after moving the clock.
  // Simpler: run the sweep with now=+8d and assert the FRESH ones are still retained by
  // making their updatedAt 8 days in the FUTURE relative to that now is not possible; so we
  // use now slightly ahead of the fresh rows and far ahead of the aged one by back-dating
  // the aged attempt's updatedAt directly.
  db.prepare("UPDATE publication_attempts SET updated_at = ? WHERE attempt_id IN ('pub-failed-aged')").run(new Date(Date.now() - 8 * DAY_MS).toISOString());

  const now = new Date(); // fresh rows are ~now → within window; aged row is 8d old → past window
  const { publicationWorktrees } = sweepPublicationWorktrees({ now, cwdGuard: NEVER_HELD });

  assert.ok(!existsSync(published), "published worktree reclaimed");
  assert.equal(dispositionFor(publicationWorktrees, published)!.action, "removed");

  assert.ok(!existsSync(failedAged), "aged failed worktree reclaimed (node_modules and all)");
  assert.equal(dispositionFor(publicationWorktrees, failedAged)!.action, "removed");

  assert.ok(existsSync(failedFresh), "fresh failed worktree retained as AD-1 evidence");
  assert.equal(dispositionFor(publicationWorktrees, failedFresh)!.reason, "within_retention_for_investigation");

  assert.ok(existsSync(parkedFresh), "fresh parked worktree retained");
  assert.equal(dispositionFor(publicationWorktrees, parkedFresh)!.reason, "within_retention_for_investigation");

  assert.ok(existsSync(inFlight), "in-flight attempt retained");
  assert.equal(dispositionFor(publicationWorktrees, inFlight)!.reason, "publication_in_flight");

  assert.ok(existsSync(orphan), "registry-less orphan retained");
  assert.equal(dispositionFor(publicationWorktrees, orphan)!.reason, "ownership_ambiguous");

  assert.ok(existsSync(nonShape), "non-worktree-shaped dir retained");
  assert.equal(dispositionFor(publicationWorktrees, nonShape)!.reason, "ownership_ambiguous");
});

test("FG-677 publication: a live process holding the worktree cwd RETAINS it as active_process_cwd", () => {
  const published = makeAttempt("pub-held", "published");
  const held = (): CwdHolderResult => ({ held: true, holders: [{ pid: 7, description: "tmux pane pid 7", cwd: published }] });
  const { publicationWorktrees } = sweepPublicationWorktrees({ cwdGuard: held });
  assert.ok(existsSync(published), "a held publication worktree is never deleted");
  assert.equal(dispositionFor(publicationWorktrees, published)!.reason, "active_process_cwd");
});

test("FG-677 publication: DRY-RUN removes nothing and proposes exactly what the real pass performs", () => {
  const published = makeAttempt("pub-dry", "published");
  const dry = sweepPublicationWorktrees({ dryRun: true, cwdGuard: NEVER_HELD });
  assert.ok(existsSync(published), "dry-run mutates nothing");
  assert.equal(dispositionFor(dry.publicationWorktrees, published)!.action, "removed");
  assert.equal(dispositionFor(dry.publicationWorktrees, published)!.dryRun, true);

  const real = sweepPublicationWorktrees({ cwdGuard: NEVER_HELD });
  assert.ok(!existsSync(published));
  assert.equal(dispositionFor(real.publicationWorktrees, published)!.action, "removed");
});

test("FG-677 publication scale: >=36 published attempts reclaim with a 2nd-pass fixpoint and no node_modules left", () => {
  const dirs: string[] = [];
  for (let i = 0; i < 40; i++) dirs.push(makeAttempt(`pub-scale-${i}`, "published"));

  const first = sweepPublicationWorktrees({ cwdGuard: NEVER_HELD });
  assert.equal(first.publicationWorktrees.filter((d) => d.action === "removed").length, 40);
  for (const d of dirs) assert.ok(!existsSync(d), `worktree ${d} reclaimed`);
  assert.ok(!existsSync(join(dirs[0]!, "node_modules")), "no terminal node_modules tree left behind");

  // Fixpoint: a second pass finds nothing (the dirs are gone on disk).
  const second = sweepPublicationWorktrees({ cwdGuard: NEVER_HELD });
  assert.equal(second.publicationWorktrees.length, 0, "second pass is a no-op fixpoint");
});
