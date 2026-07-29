// FG-608 (reopen) — the ticket_events constraint-shape rebuild against a REAL
// on-disk store, the REAL open path (getDb), the REAL import orchestrator, and
// REAL separate processes.
//
// WHAT THIS ADDS OVER fg608-ticket-events-shape.test.ts. That file proves the
// rebuild in isolation: one in-memory connection, applyMigrations called by hand,
// one upsertTicketEvent through the accessor. Three things it cannot see, and all
// three are what actually broke on the dogfood host:
//
//   1. THE WRITE PATH THAT CRASHED IS NOT ONE UPSERT. `forge backlog migrate` dies
//      inside importBacklog, which writes tickets, relations, blocker evidence,
//      source membership, id sequences and events inside ONE writeTransaction. A
//      rebuild that converged the shape but left the store unusable for the
//      orchestrator would still pass the isolated test.
//   2. AN OPEN IS A PROCESS, NOT A FUNCTION CALL. getDb() opens a FILE, sets
//      journal_mode=WAL and foreign_keys=ON, and runs the forward version gate
//      before SCHEMA_SQL — the rebuild flips PRAGMA foreign_keys underneath all of
//      that. Same-process idempotency over one in-memory handle cannot express "the
//      next forge process must not rebuild again"; only a second process reading
//      the same file can, and sqlite_master.rootpage is the proof (it changes when
//      and only when a table is physically rebuilt).
//   3. THE ROWS ON THE HOST ARE NOT THE ROWS IN THE FIXTURE. Duplicate
//      (project_key, ticket_id) pairs under different event_keys, NULL payloads,
//      payloads carrying quotes/newlines/unicode, several project_keys, and events
//      whose ticket has no parent row. The copy must carry all of them.
//
// Never touches a real host store: FORGE_DB_PATH points at a per-test temp file,
// FORGE_HOME at a per-test temp dir, and the fixture projects are mkdtemp dirs.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { closeDb, getDb, ticketEventsShapeDivergence } from "./db.js";
import { importBacklog } from "./backlog-import.js";
import { deleteTicketRow, eventsForTicket, ticketsForProject, upsertTicketEvent } from "./tickets.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";

// The observed host DDL, LITERAL — never derived from SCHEMA_SQL, for the reason
// stated in fg608-ticket-events-shape.test.ts: a fixture synthesized from today's
// schema carries today's constraints by construction and can never express this
// divergence.
const HOST_TICKET_EVENTS_DDL = `
  CREATE TABLE ticket_events (
    event_key   TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    ticket_id   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    payload     TEXT,
    created_at  TEXT NOT NULL
  )
`;

// The host's shape one step further back: FG-606's work-in-progress table before
// `payload` existed at all. applyMigrations must ADD the column and only then
// rebuild, or the copy carries a column the source table does not have.
const HOST_TICKET_EVENTS_DDL_NO_PAYLOAD = `
  CREATE TABLE ticket_events (
    event_key   TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    ticket_id   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )
`;

// upsertTicketEvent's statement, conflict target included. This is the text that
// could not PREPARE on the host; asserting THAT is what makes each fixture below a
// reproduction rather than a decoration.
const UPSERT_SQL = `INSERT INTO ticket_events (event_key, project_key, ticket_id, event_type, payload, created_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(project_key, ticket_id, event_key) DO UPDATE SET
     event_type = excluded.event_type,
     payload = excluded.payload,
     created_at = excluded.created_at`;

const NOW = "2026-07-29T00:00:00Z";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";
// FG-644/FG-645: a spawned CLI resolves ticket authority from the compiled-in
// container mount. This suite may itself be running INSIDE an agent container
// (which carries a real /forge-backlog marker and exports
// FORGE_BACKLOG_SNAPSHOT_DIR), and a child that inherits either one refuses every
// mutating backlog verb — so the child would "pass" by never running the import at
// all. The testkit preload repoints the compiled-in probe at an empty directory
// this test owns, and the env pointer is explicitly cleared. On a host, where
// neither exists, this recipe changes nothing: the child behaves identically
// everywhere, which is the point.
const authorityTestkit = pathToFileURL(resolve(here, "..", "backlog", "container-authority.testkit.ts")).href;

type EventRow = {
  event_key: string;
  project_key: string;
  ticket_id: string;
  event_type: string;
  payload: string | null;
  created_at: string;
};

type SchemaObject = { name: string; type: string; sql: string | null; rootpage: number };

let root: string;
let dbPath: string;
let home: string;
let emptyAuthorityMount: string;
let savedDbPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg608-rebuild-"));
  dbPath = join(root, "forge.db");
  home = join(root, "home");
  emptyAuthorityMount = join(root, "no-authority");
  mkdirSync(home, { recursive: true });
  mkdirSync(emptyAuthorityMount, { recursive: true });
  savedDbPath = process.env["FORGE_DB_PATH"];
  process.env["FORGE_DB_PATH"] = dbPath;
  clearBacklogStoreCache();
});

afterEach(() => {
  closeDb();
  if (savedDbPath === undefined) delete process.env["FORGE_DB_PATH"];
  else process.env["FORGE_DB_PATH"] = savedDbPath;
  clearBacklogStoreCache();
  rmSync(root, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

// A store written by the binary whose ticket_events carried the divergent shape:
// the host DDL FIRST, so SCHEMA_SQL's CREATE TABLE IF NOT EXISTS hits the same
// no-op path production did, then the rest of the schema, then rows.
function seedHostShapedStore(opts: {
  ddl?: string;
  columns?: readonly string[];
  tickets?: readonly [string, string][];
  events?: readonly (readonly unknown[])[];
}): void {
  const db = new Database(dbPath);
  db.exec(opts.ddl ?? HOST_TICKET_EVENTS_DDL);
  db.exec(SCHEMA_SQL);

  const insertTicket = db.prepare(
    `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at)
     VALUES (?, ?, 'story', 'active', 'legacy title', 'legacy body', '2026-07-01T00:00:00Z')`,
  );
  for (const [projectKey, ticketId] of opts.tickets ?? []) insertTicket.run(projectKey, ticketId);

  const columns = opts.columns ?? ["event_key", "project_key", "ticket_id", "event_type", "payload", "created_at"];
  const insertEvent = db.prepare(
    `INSERT INTO ticket_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of opts.events ?? []) insertEvent.run(...(row as unknown[]));

  db.close();
}

function withRawDb<T>(fn: (db: DatabaseInstance) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function primaryKeyOf(db: DatabaseInstance, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

function eventRows(db: DatabaseInstance): EventRow[] {
  return db
    .prepare(
      `SELECT event_key, project_key, ticket_id, event_type, payload, created_at FROM ticket_events
        ORDER BY project_key, ticket_id, event_key`,
    )
    .all() as EventRow[];
}

// Table IDENTITY, not just text: rootpage is the b-tree root page of the table and
// changes when and only when the table is physically recreated. The rebuild CREATEs
// the replacement while the original still exists, so a rebuilt table can never
// land on the old page — an unchanged rootpage is proof no rebuild ran.
function ticketEventsSchema(db: DatabaseInstance): SchemaObject[] {
  return db
    .prepare(
      `SELECT name, type, sql, rootpage FROM sqlite_master WHERE name LIKE 'ticket_events%' ORDER BY type, name`,
    )
    .all() as SchemaObject[];
}

function rootpageOfTicketEvents(db: DatabaseInstance): number {
  const row = db.prepare(`SELECT rootpage FROM sqlite_master WHERE type='table' AND name='ticket_events'`).get() as
    | { rootpage: number }
    | undefined;
  assert.ok(row, "ticket_events must exist");
  return row!.rootpage;
}

type FixtureTicket = { id: string; type?: string; status?: string; title?: string; body?: string; related?: string[] };

function writeProject(name: string, tickets: readonly FixtureTicket[]): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "backlog"), { recursive: true });
  for (const t of tickets) {
    const status = t.status ?? "active";
    const subdir = status === "done" ? "done" : "stories";
    mkdirSync(join(dir, "backlog", subdir), { recursive: true });
    const frontmatter = [
      `id: ${t.id}`,
      `type: ${t.type ?? "story"}`,
      `status: ${status}`,
      `title: ${t.title ?? `ticket ${t.id}`}`,
      ...(t.related ? [`related:`, ...t.related.map((r) => `  - ${r}`)] : []),
    ].join("\n");
    writeFileSync(
      join(dir, "backlog", subdir, `${t.id}-slug.md`),
      `---\n${frontmatter}\n---\n\n${t.body ?? `body of ${t.id}`}\n`,
    );
  }
  return dir;
}

function forge(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(tsx, ["--import", authorityTestkit, entry, ...args], {
    cwd: root,
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_DB_PATH: dbPath,
      NO_NOTIFY: "true",
      FORGE_BACKLOG_SNAPSHOT_DIR: "",
      FORGE_TEST_AUTHORITY_MOUNT: emptyAuthorityMount,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// A separate process that does nothing but OPEN the store through the production
// path and report what it found. This is the "next forge invocation" — a real
// second process, not a second call on a live handle.
function openStoreInFreshProcess(): { rebuilt: boolean; divergence: string | null; rootpage: number; events: number } {
  const driver = join(root, "open-only.ts");
  writeFileSync(
    driver,
    `import { getDb, rebuildTicketEventsIfDivergent, ticketEventsShapeDivergence } from ${JSON.stringify(
      join(here, "db.ts"),
    )};\n` +
      `const db = getDb();\n` +
      `const rootpage = (db.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='ticket_events'").get() as { rootpage: number }).rootpage;\n` +
      `const events = (db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get() as { n: number }).n;\n` +
      `console.log(JSON.stringify({ rebuilt: rebuildTicketEventsIfDivergent(db), divergence: ticketEventsShapeDivergence(db), rootpage, events }));\n`,
  );
  const res = spawnSync(tsx, [driver], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: dbPath, NO_NOTIFY: "true" },
  });
  assert.equal(res.status, 0, `open-only driver failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim()) as { rebuilt: boolean; divergence: string | null; rootpage: number; events: number };
}

// ─── 1. the real crash path, end to end ──────────────────────────────────────

test("integ FG-608: a host-shaped store survives a real open and the WHOLE importBacklog write path", () => {
  seedHostShapedStore({
    tickets: [
      ["pk-old", "FG-0"],
      ["pk-other", "FG-0"],
    ],
    events: [
      ["evt-a", "pk-old", "FG-0", "imported", '{"fileStatus":"active"}', "2026-07-01T00:00:00Z"],
      ["evt-b", "pk-other", "FG-0", "imported", null, "2026-07-02T00:00:00Z"],
      // No tickets row for (pk-gone, FG-9): legal under the old shape, and the
      // rebuild must carry it rather than drop audit history.
      ["evt-orphan", "pk-gone", "FG-9", "closed", '{"orphan":true}', "2026-07-03T00:00:00Z"],
    ],
  });

  // The reproduction, pinned: on THIS store the production statement cannot even
  // be prepared. Without this assertion the rest of the test proves nothing.
  const legacyRows = withRawDb((db) => {
    assert.deepEqual(primaryKeyOf(db, "ticket_events"), ["event_key"], "precondition: the divergent PK");
    assert.match(
      ticketEventsShapeDivergence(db) ?? "",
      /PRIMARY KEY is \(event_key\)/,
      "precondition: the divergence must be detected",
    );
    assert.throws(
      () => db.prepare(UPSERT_SQL),
      /ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint/,
      "precondition: this fixture must reproduce the host's PREPARE-time failure",
    );
    return eventRows(db);
  });

  const db = getDb(); // the production open: version gate, SCHEMA_SQL, applyMigrations
  assert.equal(ticketEventsShapeDivergence(db), null, "the real open must converge the shape");
  assert.deepEqual(primaryKeyOf(db, "ticket_events"), ["project_key", "ticket_id", "event_key"]);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1, "the rebuild must restore foreign_keys = ON");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "the rebuild never bumps user_version");
  assert.deepEqual(eventRows(db), legacyRows, "every pre-existing row must survive the open");

  // THE WRITE PATH THAT CRASHED: the full import orchestrator, one transaction,
  // tickets + relations + blocker evidence + membership + events.
  const project = writeProject("crash-path", [
    { id: "FG-1", related: ["FG-2"] },
    { id: "FG-2", status: "blocked" },
    { id: "FG-3", status: "done" },
    { id: "FG-4", type: "epic", title: "an epic" },
  ]);
  const imported = importBacklog(project, { now: NOW, sourceId: "src-a" });
  assert.equal(imported.ticketCount, 4);
  assert.deepEqual(
    ticketsForProject(imported.projectKey).map((t) => t.ticketId),
    ["FG-1", "FG-2", "FG-3", "FG-4"],
  );
  for (const id of ["FG-1", "FG-2", "FG-3", "FG-4"]) {
    assert.deepEqual(
      eventsForTicket(imported.projectKey, id).map((e) => `${e.eventKey}:${e.eventType}`),
      [`import:${imported.projectKey}:${id}:imported`],
      `${id}: the import event must land through the rebuilt ON CONFLICT path`,
    );
  }
  assert.deepEqual(
    withRawDb((raw) => raw.prepare(`SELECT COUNT(*) AS n FROM ticket_relations`).get()),
    { n: 1 },
    "the relation written in the same transaction must be committed too",
  );
  assert.deepEqual(
    withRawDb((raw) => raw.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get()),
    { n: 1 },
    "the blocked ticket's evidence must be committed too",
  );

  // Re-import: the ON CONFLICT DO UPDATE path, not a duplicate insert.
  importBacklog(project, { now: NOW, sourceId: "src-a" });
  assert.equal(
    withRawDb((raw) => (raw.prepare(`SELECT COUNT(*) AS n FROM ticket_events`).get() as { n: number }).n),
    3 + 4,
    "a re-import must update the same event rows, never duplicate them",
  );
  const legacyOwners = new Set(legacyRows.map((r) => r.project_key));
  assert.deepEqual(
    withRawDb((raw) => eventRows(raw).filter((r) => legacyOwners.has(r.project_key))),
    legacyRows,
    "the legacy rows must be untouched by the import that follows the rebuild",
  );

  // The canonical FK the rebuild installed applies to NEW writes — this is the
  // half the copy deliberately does NOT enforce.
  assert.throws(
    () =>
      upsertTicketEvent({
        eventKey: "evt-new-orphan",
        projectKey: imported.projectKey,
        ticketId: "FG-404",
        eventType: "imported",
        payload: null,
        createdAt: NOW,
      }),
    /FOREIGN KEY constraint failed/,
    "a NEW event for a nonexistent ticket must be refused by the rebuilt FK",
  );

  // ...and ON DELETE CASCADE, which the removal path relies on, survives it.
  deleteTicketRow(imported.projectKey, "FG-1");
  assert.deepEqual(eventsForTicket(imported.projectKey, "FG-1"), [], "the cascade must prune the deleted ticket's events");
  assert.equal(eventsForTicket(imported.projectKey, "FG-2").length, 1, "a sibling ticket's events must not cascade away");
});

// ─── 2. real processes: one rebuild, then none ───────────────────────────────

test("integ FG-608: `forge backlog import` converges a host-shaped store, and the NEXT process rebuilds nothing", () => {
  seedHostShapedStore({
    tickets: [["pk-old", "FG-0"]],
    events: [
      ["evt-a", "pk-old", "FG-0", "imported", '{"fileStatus":"active"}', "2026-07-01T00:00:00Z"],
      ["evt-orphan", "pk-gone", "FG-9", "closed", null, "2026-07-03T00:00:00Z"],
    ],
  });
  const before = withRawDb((db) => ({ rootpage: rootpageOfTicketEvents(db), rows: eventRows(db) }));

  const project = writeProject("cli", [{ id: "FG-1" }, { id: "FG-2" }]);
  const first = forge(["backlog", "import", "--project", project, "--json"]);
  assert.equal(first.status, 0, `import failed: ${first.stderr}`);
  const result = JSON.parse(first.stdout) as { projectKey: string; ticketCount: number };
  assert.equal(result.ticketCount, 2);

  const afterFirst = withRawDb((db) => {
    assert.deepEqual(
      primaryKeyOf(db, "ticket_events"),
      ["project_key", "ticket_id", "event_key"],
      "the spawned process must have converged the shape",
    );
    assert.notEqual(
      rootpageOfTicketEvents(db),
      before.rootpage,
      "a changed rootpage is the proof the table was physically rebuilt",
    );
    const rows = eventRows(db);
    assert.deepEqual(
      rows.filter((r) => r.project_key === "pk-old" || r.project_key === "pk-gone"),
      before.rows,
      "the rebuild in a real process preserved the pre-existing rows, orphan included",
    );
    assert.deepEqual(
      rows.filter((r) => r.project_key === result.projectKey).map((r) => r.event_key),
      [`import:${result.projectKey}:FG-1`, `import:${result.projectKey}:FG-2`],
      "the import's own events landed",
    );
    assert.equal(db.pragma("user_version", { simple: true }), 0);
    return { schema: ticketEventsSchema(db), rows };
  });

  // A SECOND process opening the same file. Nothing but the open.
  const reopen = openStoreInFreshProcess();
  assert.equal(reopen.rebuilt, false, "the second process must not rebuild an already-canonical table");
  assert.equal(reopen.divergence, null);
  assert.equal(reopen.rootpage, afterFirst.schema.find((o) => o.type === "table")!.rootpage, "no second rebuild");
  assert.equal(reopen.events, afterFirst.rows.length);
  withRawDb((db) => {
    assert.deepEqual(ticketEventsSchema(db), afterFirst.schema, "a plain open must leave sqlite_master identical");
    assert.deepEqual(eventRows(db), afterFirst.rows, "a plain open must leave every row untouched");
  });

  // A THIRD process, this time writing again through the same CLI verb: still no
  // rebuild, still no duplicate rows. (created_at on the import events is restamped
  // by the CLI's own clock — the identity that must not move is the row SET.)
  const second = forge(["backlog", "import", "--project", project, "--json"]);
  assert.equal(second.status, 0, `re-import failed: ${second.stderr}`);
  withRawDb((db) => {
    assert.deepEqual(
      ticketEventsSchema(db).map((o) => `${o.type}:${o.name}:${o.rootpage}`),
      afterFirst.schema.map((o) => `${o.type}:${o.name}:${o.rootpage}`),
      "a re-import must not rebuild the table again",
    );
    assert.deepEqual(
      eventRows(db).map((r) => `${r.project_key}/${r.ticket_id}/${r.event_key}`),
      afterFirst.rows.map((r) => `${r.project_key}/${r.ticket_id}/${r.event_key}`),
      "a re-import must upsert the same rows, never add any",
    );
  });
});

// ─── 3. the copy under data adversity ────────────────────────────────────────

test("integ FG-608: the rebuild carries adversarial rows — duplicates, NULLs, orphans, many projects", () => {
  const events: unknown[][] = [];
  // Several project_keys; several tickets per project; several events per ticket
  // under DIFFERENT event_keys — the (project_key, ticket_id) duplication the
  // canonical composite PK must accept and the old single-column PK never saw.
  for (const pk of ["pk-a", "pk-b", "pk-c"]) {
    for (const ticket of ["FG-1", "FG-2"]) {
      for (let i = 0; i < 4; i++) {
        events.push([
          `${pk}-${ticket}-evt-${i}`,
          pk,
          ticket,
          i % 2 === 0 ? "imported" : "closed",
          i === 0 ? null : JSON.stringify({ i, note: `it's "quoted",\nmulti-line, ünicode ☃`, pk }),
          `2026-07-0${(i % 9) + 1}T00:00:0${i}Z`,
        ]);
      }
    }
  }
  // Orphans: no tickets row at all, and one whose id exists only under ANOTHER
  // project_key — the cross-project case a naive per-project copy would lose.
  events.push(["orphan-1", "pk-ghost", "FG-1", "imported", null, "2026-06-01T00:00:00Z"]);
  events.push(["orphan-2", "pk-ghost", "FG-404", "closed", '{"orphan":true}', "2026-06-02T00:00:00Z"]);
  events.push(["orphan-3", "pk-a", "FG-NOT-A-TICKET", "imported", null, "2026-06-03T00:00:00Z"]);

  seedHostShapedStore({
    // Only pk-a's tickets exist; every event under pk-b/pk-c/pk-ghost is an orphan.
    tickets: [
      ["pk-a", "FG-1"],
      ["pk-a", "FG-2"],
    ],
    events,
  });
  const before = withRawDb((db) => eventRows(db));
  assert.equal(before.length, 27, "precondition: the fixture must carry the adversarial row set");

  const db = getDb();

  assert.equal(ticketEventsShapeDivergence(db), null);
  assert.deepEqual(eventRows(db), before, "every row must survive the copy byte for byte — NULLs and unicode included");
  assert.equal(
    eventRows(db).filter((r) => r.project_key === "pk-ghost" || r.ticket_id === "FG-NOT-A-TICKET").length,
    3,
    "orphans must survive: FK enforcement applies to NEW writes, not to the copy",
  );
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1, "foreign_keys must be restored after the copy");

  // The composite PK is genuinely in force: same event_key under a different owner
  // is a distinct row (the old single-column PK could not hold this at all), and
  // the same key under the same owner updates in place.
  upsertTicketEvent({
    eventKey: "shared-key",
    projectKey: "pk-a",
    ticketId: "FG-1",
    eventType: "imported",
    payload: { which: "first" },
    createdAt: NOW,
  });
  upsertTicketEvent({
    eventKey: "shared-key",
    projectKey: "pk-a",
    ticketId: "FG-2",
    eventType: "imported",
    payload: { which: "second" },
    createdAt: NOW,
  });
  upsertTicketEvent({
    eventKey: "shared-key",
    projectKey: "pk-a",
    ticketId: "FG-1",
    eventType: "closed",
    payload: { which: "updated" },
    createdAt: NOW,
  });
  const shared = eventRows(db).filter((r) => r.event_key === "shared-key");
  assert.deepEqual(
    shared.map((r) => `${r.ticket_id}:${r.event_type}`),
    ["FG-1:closed", "FG-2:imported"],
    "one row per owner, updated in place — never duplicated, never rejected",
  );
  assert.equal(eventRows(db).length, before.length + 2);
});

test("integ FG-608: a legacy table with no `payload` column gains it BEFORE the copy runs", () => {
  // The ordering the rebuild's placement in applyMigrations encodes: the additive
  // ALTER loop first, the constraint rebuild second. Reversed, the copy would name
  // a column the source table does not have and the open would die.
  seedHostShapedStore({
    ddl: HOST_TICKET_EVENTS_DDL_NO_PAYLOAD,
    columns: ["event_key", "project_key", "ticket_id", "event_type", "created_at"],
    tickets: [["pk-a", "FG-1"]],
    events: [
      ["evt-1", "pk-a", "FG-1", "imported", "2026-07-01T00:00:00Z"],
      ["evt-2", "pk-a", "FG-1", "closed", "2026-07-02T00:00:00Z"],
    ],
  });
  withRawDb((db) => {
    const cols = (db.prepare(`PRAGMA table_info(ticket_events)`).all() as { name: string }[]).map((c) => c.name);
    assert.equal(cols.includes("payload"), false, "precondition: the legacy table must lack payload");
  });

  const db = getDb();

  assert.equal(ticketEventsShapeDivergence(db), null, "the open must both ADD the column and converge the shape");
  assert.deepEqual(
    eventRows(db).map((r) => `${r.event_key}:${r.payload}`),
    ["evt-1:null", "evt-2:null"],
    "the pre-payload rows survive, reading back NULL for the column they never had",
  );
  upsertTicketEvent({
    eventKey: "evt-1",
    projectKey: "pk-a",
    ticketId: "FG-1",
    eventType: "reimported",
    payload: { fileStatus: "done" },
    createdAt: NOW,
  });
  assert.deepEqual(
    eventRows(db).map((r) => `${r.event_key}:${r.event_type}`),
    ["evt-1:reimported", "evt-2:closed"],
    "and the upsert that could not prepare on this shape now updates in place",
  );
});

// ─── 4. reopen and a concurrent peer connection ──────────────────────────────

test("integ FG-608: repeated opens of the same file rebuild exactly once, and a concurrent peer sees nothing to do", () => {
  seedHostShapedStore({
    tickets: [["pk-a", "FG-1"]],
    events: [
      ["evt-1", "pk-a", "FG-1", "imported", '{"n":1}', "2026-07-01T00:00:00Z"],
      ["evt-2", "pk-ghost", "FG-9", "closed", null, "2026-07-02T00:00:00Z"],
    ],
  });
  const seededRootpage = withRawDb((db) => rootpageOfTicketEvents(db));

  getDb();
  closeDb();
  const afterRebuild = withRawDb((db) => ({ schema: ticketEventsSchema(db), rows: eventRows(db) }));
  const rebuiltRootpage = afterRebuild.schema.find((o) => o.type === "table")!.rootpage;
  assert.notEqual(rebuiltRootpage, seededRootpage, "the first open rebuilt the table");

  // Opens two and three, each on a genuinely new connection to the same file.
  for (const pass of [2, 3]) {
    const db = getDb();
    assert.equal(ticketEventsShapeDivergence(db), null, `open ${pass}: still canonical`);
    closeDb();
    withRawDb((raw) => {
      assert.deepEqual(ticketEventsSchema(raw), afterRebuild.schema, `open ${pass} must not rebuild again`);
      assert.deepEqual(eventRows(raw), afterRebuild.rows, `open ${pass} must not touch a row`);
    });
  }

  // A peer connection open AT THE SAME TIME as forge's own — the shape of two
  // concurrent forge invocations sharing ~/.forge/forge.db. The second must find
  // nothing to converge and must not disturb the first.
  const mine = getDb();
  const peer = new Database(dbPath);
  try {
    peer.pragma("foreign_keys = ON");
    peer.exec(SCHEMA_SQL);
    assert.equal(ticketEventsShapeDivergence(peer), null, "the peer must see a canonical table");
    assert.deepEqual(ticketEventsSchema(peer), afterRebuild.schema, "the peer must not rebuild");
    assert.deepEqual(eventRows(peer), afterRebuild.rows);
    assert.deepEqual(eventRows(mine), afterRebuild.rows, "and the first connection still reads the same rows");
  } finally {
    peer.close();
  }

  // The whole point of converging: after all of this, the write path works.
  upsertTicketEvent({
    eventKey: "evt-1",
    projectKey: "pk-a",
    ticketId: "FG-1",
    eventType: "reimported",
    payload: { n: 2 },
    createdAt: NOW,
  });
  assert.deepEqual(
    eventsForTicket("pk-a", "FG-1").map((e) => e.eventType),
    ["reimported"],
  );
});
