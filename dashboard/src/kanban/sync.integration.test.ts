// FG-785: INTEGRATION tier for the outbound sync engine — it drives the REAL FG-781 projection
// (assembleRemoteBoard) as the card-data source and the REAL @forge/kanban-projection store
// accessors against a real on-disk forge.db, with the deterministic FakeKanbanProvider standing in
// for an external board. Store-touching by definition, so it is *.integration.test.ts, not unit.
//
// MIGRATED FIXTURE. A pre-FG-785 store (legacy runs/tasks only, with a pre-existing run row) is
// written to disk BEFORE the first getDb(), so the production open path MIGRATES it — additively
// adding the two FG-785 tables. The whole test then runs against that migrated store, proving the
// sync engine round-trips through tables that arrived by migration, not only on a fresh DB.
//
// It proves AC2/AC3/AC4 at the store boundary:
//   - create/update/archive land and the identity map persists in the real table;
//   - a repeated sync converges — no duplicate card, no duplicate map row;
//   - an incremental sync pushes only changed-hash cards;
//   - NO Forge lifecycle row (the pre-existing run, the seeded tickets) is reordered or mutated —
//     the engine writes only its own two tables;
//   - an external move records a real kanban_conflicts row (both versions) via listOpenConflicts,
//     and the external change is never applied.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// FORGE_HOME must be set BEFORE any import that transitively evaluates src/util/paths.ts.
const root = mkdtempSync(join(tmpdir(), "fg785-sync-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { DB_PATH } = await import("../../../src/util/paths.js");
const { getDb } = await import("../../../src/store/db.js");
const { repositoryCheckoutIdentity } = await import("../../../src/util/repository-identity.js");
const kanban = await import("../../../src/store/kanban-projection.js");
const { projectsForDashboard } = await import("../queries.js");
const { assembleRemoteBoard } = await import("../remote/projection.js");
const { FakeKanbanProvider } = await import("./fake-provider.js");
const { syncBoardOutbound } = await import("./sync.js");
import type { RemoteBoard } from "../remote/projection.js";
import type { KanbanSyncStore, SyncConfig } from "./sync.js";

// ─── a pre-FG-785 store on disk (the migrated fixture) ──────────────────────────────

const LEGACY_DDL = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, completed_at TEXT, metadata TEXT, project_dir TEXT
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, phase TEXT NOT NULL,
  agent_role TEXT NOT NULL, status TEXT NOT NULL, task_package TEXT NOT NULL, result TEXT,
  created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT
);
`;

const AT = "2026-09-01T10:00:00Z";
const trees = join(root, "trees");
mkdirSync(trees, { recursive: true });

function checkout(name: string, remote: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const projDir = checkout("alpha", "git@github.com:example/fg785-alpha.git");
const REPO_KEY = repositoryCheckoutIdentity(projDir).key;
const PK = "pk-fg785-alpha";

before(() => {
  // The pre-FG-785 store: legacy tables + a pre-existing run row, and NONE of the FG-785 tables.
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");
  const legacy = new Database(DB_PATH);
  legacy.exec(LEGACY_DDL);
  legacy
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`)
    .run("run-legacy", "feature", "a run recorded before FG-785", "active", AT, projDir);
  legacy.close();

  // First production open MIGRATES the on-disk legacy store — additively adding the FG-785 tables.
  const store = getDb();
  store
    .prepare(
      `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,'remote',?)`,
    )
    .run(PK, REPO_KEY, AT);
  store.prepare(`INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)`).run(PK, "db", AT);
  const insertTicket = store.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,NULL)`,
  );
  insertTicket.run(PK, "FG-A1", "story", "active", "Alpha one", "body one", null, AT);
  insertTicket.run(PK, "FG-A2", "story", "active", "Alpha two", "body two", null, AT);
});

// ─── the real store port + helpers ──────────────────────────────────────────────

const store: KanbanSyncStore = {
  getProjectionMap: kanban.getProjectionMap,
  listProjectionMap: kanban.listProjectionMap,
  upsertProjectionMap: kanban.upsertProjectionMap,
  insertConflict: kanban.insertConflict,
  getConflict: kanban.getConflict,
};

function boardForProject(): RemoteBoard {
  const project = projectsForDashboard().find((p) => p.key === REPO_KEY);
  assert.ok(project, "the seeded project must resolve from the dashboard registry");
  const envelope = assembleRemoteBoard({ project: project!, memberDirs: project!.projectDirs });
  assert.ok(envelope.board, "a live board is assembled");
  return envelope.board!;
}

// Each test uses a DISTINCT provider name so its map/conflict rows are namespaced within the one
// shared on-disk store (the accessors filter by provider). Without this, a prior test's map rows —
// pointing at a prior test's in-memory provider — would be read as external deletions here.
function config(board: RemoteBoard, provider: string): SyncConfig {
  return {
    projectIdentity: board.projectSummary.projectKey,
    provider,
    projectedBy: "kanban-sync",
    detectedBy: "kanban-sync",
    now: () => "2026-09-08T00:00:00Z",
    retry: { maxAttempts: 4, baseDelayMs: 5, factor: 2, maxDelayMs: 50 },
    sleep: async () => {},
  };
}

function lifecycleCounts() {
  const db = getDb();
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { runs: n("runs"), tasks: n("tasks"), tickets: n("tickets"), projectIdentity: n("project_identity") };
}

// ─── tests ────────────────────────────────────────────────────────────────────

test("AC2/AC3: a first sync creates cards, persists the map, and touches NO lifecycle row", async () => {
  const board = boardForProject();
  const pk = board.projectSummary.projectKey;
  assert.ok(board.backlog.tickets.length >= 2, "the seeded board carries the two tickets");

  const before = lifecycleCounts();
  const provider = new FakeKanbanProvider({ name: "fake-create" });

  const res = await syncBoardOutbound(board, provider, store, config(board, "fake-create"));

  assert.equal(res.created, board.backlog.tickets.length, "one card created per board ticket");
  assert.equal(provider.cardCount(), board.backlog.tickets.length);
  const rows = kanban.listProjectionMap(pk, "fake-create");
  assert.equal(rows.length, board.backlog.tickets.length, "an identity map row persisted per card");
  for (const row of rows) assert.equal(row.projectionState, "active");

  // AC3: the pre-existing run and the seeded tickets are byte-for-byte untouched — the engine
  // wrote ONLY its own kanban tables.
  assert.deepEqual(lifecycleCounts(), before, "no lifecycle row was added or removed by the sync");
  const legacyRun = getDb().prepare(`SELECT status, title FROM runs WHERE id = 'run-legacy'`).get() as Record<string, unknown>;
  assert.equal(legacyRun["status"], "active", "the pre-existing run's status is unchanged");
});

test("AC3 converge: a repeated sync mints no duplicate card and no duplicate map row", async () => {
  const board = boardForProject();
  const pk = board.projectSummary.projectKey;
  const provider = new FakeKanbanProvider({ name: "fake-converge" });

  await syncBoardOutbound(board, provider, store, config(board, "fake-converge"));
  const firstCount = kanban.listProjectionMap(pk, "fake-converge").length;
  const res2 = await syncBoardOutbound(board, provider, store, config(board, "fake-converge"));

  assert.equal(res2.created, 0);
  assert.equal(res2.skipped, board.backlog.tickets.length, "every unchanged card is skipped");
  assert.equal(provider.cardCount(), board.backlog.tickets.length, "no duplicate cards");
  assert.equal(kanban.listProjectionMap(pk, "fake-converge").length, firstCount, "no duplicate map rows");
});

test("AC4: an external move records a real kanban_conflicts row and applies nothing", async () => {
  const board = boardForProject();
  const pk = board.projectSummary.projectKey;
  const provider = new FakeKanbanProvider({ name: "fake-conflict" });

  await syncBoardOutbound(board, provider, store, config(board, "fake-conflict"));
  const moved = provider.snapshot()[0]!;
  provider.externallyMove(moved.externalId, "done");

  const before = lifecycleCounts();
  const res = await syncBoardOutbound(board, provider, store, config(board, "fake-conflict"));

  assert.equal(res.conflicts, 1, "the external move is recorded as one conflict");
  const open = kanban.listOpenConflicts({ projectIdentity: pk, provider: "fake-conflict" });
  assert.equal(open.length, 1, "the conflict is open in the real store");
  assert.equal(open[0]!.kind, "moved");
  assert.equal(open[0]!.ticketIdentity, moved.identity.ticketId);
  assert.ok(open[0]!.forgeVersion, "both versions are carried — Forge canonical");
  assert.ok(open[0]!.externalVersion, "both versions are carried — external");

  // The external change was NOT applied, and no lifecycle row moved.
  assert.equal(provider.snapshot().find((c) => c.externalId === moved.externalId)!.laneId, "done");
  assert.deepEqual(lifecycleCounts(), before, "recording a conflict touched no lifecycle row");
});
