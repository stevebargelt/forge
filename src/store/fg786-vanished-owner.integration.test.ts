// FG-786 AC3 (ownership rule): launchIdsWithVanishedOwner classifies a launch's
// recorded owning checkout as PROVABLY vanished — the positive, RF-5-inverted scope
// that lets a host-global sweep converge the launches of a since-deleted disposable
// clone under the DEFAULT retention policy.
//
// The load-bearing property is the FAIL-CLOSED direction. Adding a launch to this set
// widens deletion, so every indeterminacy (unmounted volume, moved-but-live checkout,
// a still-registered identity, or a store/query throw) must resolve to NOT vanished.
// Over-inclusion is an RF-5 violation (purging a LIVE project's launches);
// under-inclusion merely defers convergence to the next pass. So these tests assert
// the exclusions as hard as the one inclusion.
//
// Real store against an in-memory SQLite DB + REAL temporary directories for the
// parent/leaf presence checks; the git-identity + registry probes are injected where
// a deterministic verdict is needed so a moved/registered owner can be posed without
// standing up a git repo per case.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { recordLaunchObservation, launchIdsWithVanishedOwner } from "./launch-observations.js";
import type { RepositoryCheckoutIdentity } from "../util/repository-identity.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let base: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  base = mkdtempSync(join(tmpdir(), "fg786-vanished-"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(base, { recursive: true, force: true });
});

/** Seed a terminal launch owned by `projectDir`. recordLaunchObservation computes
 *  project_dir_canonical = provenPhysical(projectDir) at write time, exactly as a
 *  real launch would — so a leaf present at write and deleted afterward reproduces the
 *  vanished-clone shape faithfully. */
function seedLaunch(launchId: string, projectDir: string): void {
  recordLaunchObservation({
    launchId,
    command: ["forge", "launch", "run"],
    cwd: projectDir,
    projectDir,
    startedAt: "2026-09-01T00:00:00.000Z",
    observedAt: "2026-09-01T00:00:00.000Z",
    status: { state: "exited_ok", code: 0 },
  });
}

/** A resolved (exists:true) identity — a live git checkout root was found. */
function liveIdentity(checkoutRoot: string): RepositoryCheckoutIdentity {
  return { key: `repo-live-${checkoutRoot}`, source: "path", checkoutRoot, exists: true };
}

/** An unresolved (exists:false) identity — no live git root resolved from the path. */
function goneIdentity(key: string, checkoutRoot: string): RepositoryCheckoutIdentity {
  return { key, source: "path", checkoutRoot, exists: false };
}

describe("FG-786 launchIdsWithVanishedOwner — the vanished-owner classifier", () => {
  test("(a) present parent, deleted leaf, unresolved-and-unregistered -> IN the set (real deps)", () => {
    // A present parent dir with a checkout leaf under it, deleted after the launch was
    // recorded. Empty registry + a gone path => repositoryCheckoutIdentity.exists is
    // false and no registry row => PROVEN vanished, via the REAL default probes.
    const parent = join(base, "present-parent");
    const leaf = join(parent, "gone-clone");
    mkdirSync(leaf, { recursive: true });
    seedLaunch("la_gone1", leaf);
    seedLaunch("la_gone2", leaf); // same owner -> both converge off one classification
    rmSync(leaf, { recursive: true, force: true });

    const vanished = launchIdsWithVanishedOwner();
    assert.ok(vanished.has("la_gone1"), "deleted-leaf owner must be classified vanished");
    assert.ok(vanished.has("la_gone2"), "every launch of a vanished owner converges");
    assert.equal(vanished.size, 2);
  });

  test("(b) absent parent/volume (simulated unmount) -> NOT in the set (real deps)", () => {
    // The whole parent is gone — an external/network volume unmounted. A remount would
    // bring the live checkout back, so this is INDETERMINATE, never vanished. The path
    // never existed at write time, so canonical is null and the spelling is used.
    const leaf = join(base, "ghost-volume", "some-clone");
    seedLaunch("la_unmounted", leaf);

    const vanished = launchIdsWithVanishedOwner();
    assert.ok(!vanished.has("la_unmounted"), "an unmounted-volume owner must stay excluded");
    assert.equal(vanished.size, 0);
  });

  test("(c) moved-but-live: git identity still resolves -> NOT in the set", () => {
    // The recorded leaf is gone, parent present — but repositoryCheckoutIdentity
    // resolves a LIVE repo root (a moved/relocated checkout whose repository is still
    // on disk). exists:true short-circuits to not-vanished.
    const parent = join(base, "moved-parent");
    const leaf = join(parent, "moved-clone");
    mkdirSync(leaf, { recursive: true });
    seedLaunch("la_moved", leaf);
    rmSync(leaf, { recursive: true, force: true });

    const vanished = launchIdsWithVanishedOwner({
      checkoutIdentity: () => liveIdentity(join(base, "elsewhere", "moved-clone")),
    });
    assert.ok(!vanished.has("la_moved"), "a moved-but-live checkout must never be vanished");
    assert.equal(vanished.size, 0);
  });

  test("(c') gone path but registry still knows the identity -> NOT in the set", () => {
    // exists:false (no live root up-tree), yet the project registry still resolves the
    // identity's evidence key. That is another live-project signal, so exclude.
    const parent = join(base, "registered-parent");
    const leaf = join(parent, "registered-clone");
    mkdirSync(leaf, { recursive: true });
    seedLaunch("la_registered", leaf);
    rmSync(leaf, { recursive: true, force: true });

    const vanished = launchIdsWithVanishedOwner({
      checkoutIdentity: () => goneIdentity("repo-still-known", leaf),
      lookupRegistry: (key) => (key === "repo-still-known" ? { projectKey: "pk-live" } : undefined),
    });
    assert.ok(!vanished.has("la_registered"), "a still-registered identity must stay excluded");
    assert.equal(vanished.size, 0);
  });

  test("leaf still present (checkout on disk) -> NOT in the set", () => {
    // The directory is right there — nothing vanished, regardless of git identity.
    const parent = join(base, "live-parent");
    const leaf = join(parent, "live-clone");
    mkdirSync(leaf, { recursive: true });
    seedLaunch("la_live", leaf);

    // Inject a gone-and-unregistered identity to prove the present LEAF alone excludes.
    const vanished = launchIdsWithVanishedOwner({
      checkoutIdentity: () => goneIdentity("repo-irrelevant", leaf),
      lookupRegistry: () => undefined,
    });
    assert.ok(!vanished.has("la_live"), "a present checkout leaf must never be vanished");
    assert.equal(vanished.size, 0);
  });

  test("vanished and live owners in one store -> only the vanished one is returned", () => {
    const vanishedParent = join(base, "dead-parent");
    const vanishedLeaf = join(vanishedParent, "dead-clone");
    mkdirSync(vanishedLeaf, { recursive: true });
    seedLaunch("la_dead", vanishedLeaf);
    rmSync(vanishedLeaf, { recursive: true, force: true });

    const liveLeaf = join(base, "alive-parent", "alive-clone");
    mkdirSync(liveLeaf, { recursive: true });
    seedLaunch("la_alive", liveLeaf);

    // Default real deps: empty registry, gone path for the dead leaf, present live leaf.
    const vanished = launchIdsWithVanishedOwner();
    assert.deepEqual([...vanished], ["la_dead"]);
  });

  test("null / empty project_dir owners are never classified (unowned / host-global)", () => {
    // A launch with no recorded project home is host-global, not vanished-owned; it is
    // never in scope for this classifier (the WHERE clause excludes it).
    recordLaunchObservation({
      launchId: "la_hostglobal",
      command: ["forge", "launch", "run"],
      cwd: base,
      projectDir: null,
      startedAt: "2026-09-01T00:00:00.000Z",
      observedAt: "2026-09-01T00:00:00.000Z",
      status: { state: "exited_ok", code: 0 },
    });
    const vanished = launchIdsWithVanishedOwner();
    assert.equal(vanished.size, 0);
  });

  test("a store/query throw yields an EMPTY set, never a partial over-broad one", () => {
    // Fail-closed: reading ownership must never fail into scope. Close the handle so
    // the SELECT throws, and assert the classifier swallows it to empty.
    const parent = join(base, "throw-parent");
    const leaf = join(parent, "throw-clone");
    mkdirSync(leaf, { recursive: true });
    seedLaunch("la_throw", leaf);
    rmSync(leaf, { recursive: true, force: true });

    db.close(); // subsequent getDb().prepare(...) throws
    const vanished = launchIdsWithVanishedOwner();
    assert.equal(vanished.size, 0, "a query failure must yield the empty set, not the seeded row");

    // Restore a live handle so afterEach's close() does not double-fault.
    db = makeInMemoryDb();
    setDbForTest(db);
  });

  test("a per-owner classification throw is treated as NOT vanished (fail closed)", () => {
    const parent = join(base, "boom-parent");
    const leaf = join(parent, "boom-clone");
    mkdirSync(leaf, { recursive: true });
    seedLaunch("la_boom", leaf);
    rmSync(leaf, { recursive: true, force: true });

    const vanished = launchIdsWithVanishedOwner({
      checkoutIdentity: () => {
        throw new Error("git identity probe blew up");
      },
    });
    assert.ok(!vanished.has("la_boom"), "an owner whose classification throws stays excluded");
    assert.equal(vanished.size, 0);
  });
});
