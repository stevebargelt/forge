// FG-607 (FG-496 Slice B): the storage-mode / project-identity resolver.
//
// The resolver is the single decision point for "which store owns this project's
// tickets". Two properties are load-bearing and are what these tests pin:
//   - it is a PURE READER — resolving never mints a project_identity row and never
//     writes the git-TRACKED .forge/config.yml (a `forge backlog list` must not
//     dirty git status);
//   - a worktree whose config carries NO key does NOT get answered 'markdown' on
//     that basis alone; the registry is consulted, so two linked worktrees can
//     never disagree about which store is authoritative.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { DB_PATH } from "../util/paths.js";
import { setStorageMode } from "../store/tickets.js";
import {
  computeRepositoryEvidence,
  resolveAndClaimProjectKey,
  ProjectIdentityConflictError,
} from "../store/project-registry.js";
import { clearBacklogStoreCache, describeBacklogStore, projectHasBacklog, resolveBacklogStore } from "./storage-mode.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  clearBacklogStoreCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-07-24T00:00:00Z";

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg607-mode-"));
  dirs.push(dir);
  return dir;
}

function seedCommittedKey(projectDir: string, projectKey: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
}

// Register this dir's REAL repository evidence to a key, exactly as an import
// would, without the resolver being involved.
function registerEvidence(projectDir: string, projectKey: string): void {
  const evidence = computeRepositoryEvidence(projectDir);
  writeTransaction(() =>
    resolveAndClaimProjectKey({
      evidenceKey: evidence.key,
      evidenceSource: evidence.source,
      configKey: projectKey,
      createdAt: NOW,
    }),
  );
}

function identityRowCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM project_identity`).get() as { n: number }).n;
}

function storageModeRowCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ticket_storage_mode`).get() as { n: number }).n;
}

test("rung 1: a committed project_key resolves the mode from the DB record", () => {
  const dir = newProject();
  seedCommittedKey(dir, "pk-one");
  setStorageMode("pk-one", "db", NOW);

  const store = resolveBacklogStore(dir);
  assert.equal(store.mode, "db");
  assert.equal(store.projectKey, "pk-one");
});

test("rung 1: a committed key with no mode record defaults to markdown (keys the project, not the store)", () => {
  const dir = newProject();
  seedCommittedKey(dir, "pk-two");

  const store = resolveBacklogStore(dir);
  assert.equal(store.mode, "markdown");
  assert.equal(store.projectKey, "pk-two");
});

// The headline cross-worktree property: .forge/config.yml is git-tracked and
// per-branch, so a worktree on a branch predating the project_key commit has NO
// key. Answering 'markdown' on that basis would make two linked worktrees
// disagree about authority — the split-truth bug FG-496 exists to kill.
test("rung 2: NO committed key but the registry knows this repository => db, not markdown", () => {
  const dir = newProject();
  registerEvidence(dir, "pk-three");
  setStorageMode("pk-three", "db", NOW);

  // Config genuinely has no key on this checkout.
  assert.equal(existsSync(join(dir, ".forge", "config.yml")), false);

  const store = resolveBacklogStore(dir);
  assert.equal(store.mode, "db", "a config-absent worktree must still find the authoritative store");
  assert.equal(store.projectKey, "pk-three");
});

// The trust boundary. .forge/config.yml is git-tracked and freely copyable, so a
// config key is only usable once the registry confirms THIS repository owns it —
// otherwise a copied config reads and WRITES another project's tickets.
test("rung 1 REFUSES a config project_key the registry says a DIFFERENT repository owns", () => {
  const victim = newProject();
  registerEvidence(victim, "pk-victim");
  setStorageMode("pk-victim", "db", NOW);

  const thief = newProject();
  seedCommittedKey(thief, "pk-victim");
  const configBefore = readFileSync(join(thief, ".forge", "config.yml"), "utf8");
  const identitiesBefore = identityRowCount();
  const modesBefore = storageModeRowCount();

  assert.throws(
    () => resolveBacklogStore(thief),
    (e: unknown) => {
      assert.ok(e instanceof ProjectIdentityConflictError, `wrong error type: ${String(e)}`);
      assert.match((e as Error).message, /pk-victim/);
      assert.match((e as Error).message, /DIFFERENT repository/);
      return true;
    },
  );

  // No silent fall-through to another rung, no silent downgrade to markdown, and
  // NOTHING written: no identity claimed, no mode row, no config heal.
  assert.equal(identityRowCount(), identitiesBefore, "must not claim an identity");
  assert.equal(storageModeRowCount(), modesBefore, "must not touch ticket_storage_mode");
  assert.equal(readFileSync(join(thief, ".forge", "config.yml"), "utf8"), configBefore);
  assert.throws(() => resolveBacklogStore(thief), ProjectIdentityConflictError, "refusal is not cached away");
});

// The other direction of the same disagreement: this repository IS registered, but
// under a different key than the one its config commits.
test("rung 1 REFUSES when the registry and the committed key disagree for THIS repository", () => {
  const dir = newProject();
  registerEvidence(dir, "pk-registered");
  seedCommittedKey(dir, "pk-other");
  setStorageMode("pk-other", "db", NOW);

  assert.throws(() => resolveBacklogStore(dir), /registered to project_key 'pk-registered'/);
  assert.equal(identityRowCount(), 1, "the refusal claimed nothing");
});

test("rung 1: a config key the registry confirms for THIS repository resolves normally", () => {
  const dir = newProject();
  registerEvidence(dir, "pk-agree");
  seedCommittedKey(dir, "pk-agree");
  setStorageMode("pk-agree", "db", NOW);

  const store = resolveBacklogStore(dir);
  assert.equal(store.mode, "db");
  assert.equal(store.projectKey, "pk-agree");
});

// FG-607 AC 1, in the form that survives AC 2: on a host with NO store at all,
// resolution is free — it must not CREATE forge.db just to discover there is no
// registry row. (A host that HAS a store pays one memoized lookup instead; that
// cost is the accepted price of AC 2, and the free path is pinned observably in
// fg607-seam-cost.integration.test.ts.)
test("with no forge.db on the host at all, a markdown project resolves without creating one", () => {
  const dir = newProject();
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });

  setDbForTest(null as unknown as DatabaseInstance);
  const store = resolveBacklogStore(dir);
  assert.equal(store.mode, "markdown");
  assert.equal(store.projectKey, null);
  assert.equal(projectHasBacklog(dir), true);
  assert.equal(existsSync(DB_PATH), false, "resolution created the shared DB");

  setDbForTest(db);
});

// The F8 invariant at unit level: a checkout with a stale local backlog/ and no
// committed key must NOT be answered markdown on that basis — the registry knows
// this repository owns a db-mode project, and a sibling worktree that said
// otherwise would be split truth.
test("a stale local backlog/ does not override the registry: no key + registered db => db", () => {
  const dir = newProject();
  registerEvidence(dir, "pk-stale-local");
  setStorageMode("pk-stale-local", "db", NOW);
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  assert.equal(existsSync(join(dir, ".forge", "config.yml")), false);

  const store = resolveBacklogStore(dir);
  assert.equal(store.mode, "db", "a local backlog/ must not short-circuit the registry");
  assert.equal(store.projectKey, "pk-stale-local");
  assert.equal(store.staleMarkdown, true, "the stale Markdown is flagged, not obeyed");
});

// The cache exists to collapse per-loop resolution storms, NOT to cache for the
// life of a process: the dashboard is long-running and must pick up a mode flip
// made by a separate CLI invocation without any invalidation plumbing.
test("a cached resolution goes stale after the TTL", (t) => {
  const dir = newProject();
  seedCommittedKey(dir, "pk-ttl");

  t.mock.timers.enable({ apis: ["Date"] });
  assert.equal(resolveBacklogStore(dir).mode, "markdown");

  setStorageMode("pk-ttl", "db", NOW);
  assert.equal(resolveBacklogStore(dir).mode, "markdown", "memoized within the TTL");

  t.mock.timers.tick(5_000);
  assert.equal(resolveBacklogStore(dir).mode, "db", "stale after the TTL — no clearBacklogStoreCache needed");
});

test("rung 3: neither config nor registry knows this repository => legacy markdown", () => {
  const dir = newProject();
  const store = resolveBacklogStore(dir);
  assert.equal(store.mode, "markdown");
  assert.equal(store.projectKey, null);
});

// The resolver runs on every seam call, including `forge backlog list`. If it
// healed config it would dirty a git-tracked file; if it claimed an identity it
// would mint a row for every throwaway directory forge is ever pointed at.
test("resolution is a PURE READ — no config heal, no project_identity row", () => {
  const dir = newProject();
  registerEvidence(dir, "pk-pure");
  const before = identityRowCount();

  const store = resolveBacklogStore(dir);
  assert.equal(store.projectKey, "pk-pure");

  assert.equal(existsSync(join(dir, ".forge", "config.yml")), false, "must not write .forge/config.yml");
  assert.equal(existsSync(join(dir, ".forge")), false, "must not create .forge at all");
  assert.equal(identityRowCount(), before, "must not insert a project_identity row");
});

test("resolution of an unknown directory mints nothing", () => {
  const dir = newProject();
  resolveBacklogStore(dir);
  assert.equal(identityRowCount(), 0);
  assert.equal(existsSync(join(dir, ".forge")), false);
});

test("resolution is memoized per project dir; clearBacklogStoreCache re-reads", () => {
  const dir = newProject();
  seedCommittedKey(dir, "pk-memo");
  assert.equal(resolveBacklogStore(dir).mode, "markdown");

  setStorageMode("pk-memo", "db", NOW);
  assert.equal(resolveBacklogStore(dir).mode, "markdown", "memoized for the life of the process");

  clearBacklogStoreCache();
  assert.equal(resolveBacklogStore(dir).mode, "db");
});

test("staleMarkdown flags a db-mode project that still has a backlog/ directory", () => {
  const dir = newProject();
  seedCommittedKey(dir, "pk-stale");
  setStorageMode("pk-stale", "db", NOW);

  assert.equal(resolveBacklogStore(dir).staleMarkdown, false);
  assert.match(describeBacklogStore(resolveBacklogStore(dir)), /^store: db \(project_key=pk-stale\)$/);

  mkdirSync(join(dir, "backlog"), { recursive: true });
  clearBacklogStoreCache();
  const store = resolveBacklogStore(dir);
  assert.equal(store.staleMarkdown, true);
  assert.match(describeBacklogStore(store), /backlog\/ present but NOT authoritative/);
});

test("describeBacklogStore names legacy markdown plainly", () => {
  const dir = newProject();
  assert.equal(describeBacklogStore(resolveBacklogStore(dir)), "store: legacy markdown");
});

test("projectHasBacklog: true in db mode with NO backlog/ dir; filesystem-probed in markdown mode", () => {
  const dbDir = newProject();
  seedCommittedKey(dbDir, "pk-has");
  setStorageMode("pk-has", "db", NOW);
  assert.equal(existsSync(join(dbDir, "backlog")), false);
  assert.equal(projectHasBacklog(dbDir), true, "db-mode tickets live in the host DB");

  const mdDir = newProject();
  assert.equal(projectHasBacklog(mdDir), false);
  mkdirSync(join(mdDir, "backlog"), { recursive: true });
  clearBacklogStoreCache();
  assert.equal(projectHasBacklog(mdDir), true);
});
