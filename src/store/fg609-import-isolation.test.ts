// FG-609 (FG-496 Slice D) — A19 / A20, plus the operator-queue-survives-import
// guard that makes invariant "the ticket writers never name priority_rank"
// mechanical rather than conventional.
//
// ─── WHY THE SCANS BELOW USE readFileSync AND NOT grep ───────────────────────
// src/store/tickets.ts contains a NUL BYTE (in membershipKey's separator). GNU
// grep treats a file containing a NUL as BINARY: `grep -n "import-legacy-blocked"
// src/store/tickets.ts` prints NOTHING and exits 1, while `grep -an` finds it.
// A scan that can silently miss the declaration it is asserting about is not
// evidence, so this file reads every source file directly in the runtime instead.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { getTicket, upsertTicket, upsertSeamTicket, type TicketRow } from "./tickets.js";
import { LEGACY_BLOCKED_SOURCE } from "./blocked-source.js";
import { enqueueTicket, executableQueue, rankTicket } from "./queue.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

const LEAF = "src/store/blocked-source.ts";

// ─── A20: the leaf has ZERO imports ─────────────────────────────────────────

test("FG-609 A20: the blocked-source leaf imports NOTHING", () => {
  const src = read(LEAF);
  const offenders = src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(
      ({ line }) =>
        /^import\b/.test(line) ||
        /^export\s+.*\bfrom\b/.test(line) ||
        /\brequire\s*\(/.test(line) ||
        /^\s*import\s*\(/.test(line),
    );
  assert.deepEqual(
    offenders,
    [],
    `${LEAF} must have ZERO imports — no store handle, no better-sqlite3, no node:crypto. ` +
      `src/store/tickets.ts imports getDb, so any import here could route the store handle into ` +
      `the dashboard's typecheck and bundle.`,
  );
});

test("FG-609 A20: the dashboard reaches the literal through its path alias, not through the store", () => {
  const tsconfig = JSON.parse(read("dashboard/tsconfig.json")) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  assert.deepEqual(
    tsconfig.compilerOptions.paths["@forge/blocked-source"],
    ["../src/store/blocked-source.ts"],
    "the dashboard alias must point at the leaf itself",
  );

  const queries = read("dashboard/src/queries.ts");
  assert.match(
    queries,
    /import\s*\{[^}]*\bLEGACY_BLOCKED_SOURCE\b[^}]*\}\s*from\s*"@forge\/blocked-source"/,
    "the dashboard must import the literal through the alias",
  );
  // ...and NOT by importing the store, which would drag getDb in.
  for (const forbidden of ["@forge/tickets", "../src/store/tickets", "@forge/store"]) {
    assert.equal(
      queries.includes(forbidden),
      false,
      `dashboard/src/queries.ts must not reach the literal via ${forbidden}`,
    );
  }
});

test("FG-609: the source files this slice adds carry NO NUL byte", () => {
  // The flip side of the A19 hazard. src/store/tickets.ts already contains one and
  // is invisible to plain grep because of it; every scan that asserts about it —
  // including this file's — has to work around that. New code must not add another
  // file with the same blind spot, so this is asserted rather than assumed.
  const added = [
    LEAF,
    "src/store/queue.ts",
    "src/store/fg609-queue.test.ts",
    "src/store/fg609-migration-aged-shape.test.ts",
    "src/store/fg609-import-isolation.test.ts",
    "src/backlog/fg609-blocked-predicate-parity.test.ts",
    "src/cli/commands/fg609-backlog-queue.integration.test.ts",
    "src/cli/commands/fg609-docs-parity.test.ts",
  ];
  const offenders = added.filter((f) => readFileSync(join(repoRoot, f)).includes(0));
  assert.deepEqual(offenders, [], "a NUL byte in source makes the file invisible to plain grep");
});

// ─── A19: EXACTLY ONE declaration, scanned by direct read ───────────────────

test("FG-609 A19: the legacy blocked source literal is DECLARED exactly once", () => {
  // Every TypeScript source in the repo (the .mjs is handled separately — it
  // structurally cannot import, and is pinned by the parity test instead).
  const files = [
    LEAF,
    "src/store/tickets.ts",
    "src/backlog/structured.ts",
    "src/backlog/snapshot.ts",
    "src/backlog/container-authority.ts",
    "src/store/backlog-import.ts",
    "dashboard/src/queries.ts",
    "src/cli/commands/backlog.ts",
  ];
  const declaration = /(?:const|let|var)\s+LEGACY_BLOCKED_SOURCE\s*(?::[^=]+)?=/;

  const declaring = files.filter((f) => declaration.test(read(f)));
  assert.deepEqual(
    declaring,
    [LEAF],
    "exactly one declaration, in the zero-import leaf — two copies of this string drift silently " +
      "and a blocked ticket round-trips as active",
  );

  // The leaf really does declare the value we all agree on.
  assert.match(read(LEAF), /export const LEGACY_BLOCKED_SOURCE = "import-legacy-blocked";/);
  assert.equal(LEGACY_BLOCKED_SOURCE, "import-legacy-blocked");
});

test("FG-609 A19: src/store/tickets.ts RE-EXPORTS the literal rather than redeclaring it", () => {
  const src = read("src/store/tickets.ts");
  // Proves the NUL-byte hazard is real rather than remembered: this file IS the one
  // plain grep goes blind on.
  assert.ok(
    readFileSync(join(repoRoot, "src/store/tickets.ts")).includes(0),
    "src/store/tickets.ts is expected to contain a NUL byte — that is why this scan reads the file",
  );
  assert.match(
    src,
    /export\s*\{[^}]*\bLEGACY_BLOCKED_SOURCE\b[^}]*\}\s*from\s*"\.\/blocked-source\.js"/,
    "every existing importer of tickets.ts must keep working unchanged, via a re-export",
  );
});

// ─── operator queue state survives re-import ────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const PK = "pk-isolation";
const NOW = "2026-08-01T00:00:00Z";
const READY_BODY = "## Problem\np\n\n## Goal\ng\n\n## Acceptance Criteria\n- a\n";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

function ticket(id: string, over: Partial<TicketRow> = {}): TicketRow {
  return {
    projectKey: PK,
    ticketId: id,
    type: "story",
    status: "active",
    title: `title ${id}`,
    body: READY_BODY,
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: NOW,
    importedFrom: "/some/checkout",
    ...over,
  };
}

test("FG-609: neither ticket writer names priority_rank, so a re-import cannot drop a rank", () => {
  const src = read("src/store/tickets.ts");
  // The two UPSERTs are column-explicit; neither the column list, the VALUES, nor
  // the DO UPDATE SET may mention the rank column.
  const statements = src.match(/INSERT INTO tickets[\s\S]*?body_hash = excluded\.body_hash/g) ?? [];
  assert.equal(statements.length, 2, "expected exactly the import writer and the seam writer");
  for (const stmt of statements) {
    assert.equal(
      /priority_rank/.test(stmt),
      false,
      "a ticket writer that names priority_rank would silently drop operator queue state on re-import",
    );
  }
  // And no delete-then-insert refresh: the ONLY `DELETE FROM tickets` in the
  // module is deleteTicketRow, the removal-reconciliation path. A second one would
  // be a refresh, and a refresh drops rank with no error and no queue event.
  assert.equal(
    (src.match(/DELETE FROM tickets\b/g) ?? []).length,
    1,
    "exactly one DELETE FROM tickets (deleteTicketRow); a second is a delete-then-insert refresh",
  );
});

test("FG-609: rank and membership survive a re-import and a seam edit", () => {
  writeTransaction(() => {
    upsertTicket(ticket("FG-1"));
    upsertTicket(ticket("FG-2"));
  });
  rankTicket(PK, "FG-1");
  rankTicket(PK, "FG-2");
  assert.equal(enqueueTicket(PK, "FG-1").ok, true);
  assert.equal(enqueueTicket(PK, "FG-2").ok, true);
  const before = executableQueue(PK).map((e) => e.ticketId);

  // A re-import of the same Markdown...
  writeTransaction(() => {
    upsertTicket(ticket("FG-1"));
    upsertTicket(ticket("FG-2"));
  });
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), before);
  assert.equal(getTicket(PK, "FG-1")!.priorityRank, 1);

  // ...and an import that CHANGES content, plus a seam edit.
  writeTransaction(() => upsertTicket(ticket("FG-1", { body: READY_BODY + "\n- more\n" })));
  writeTransaction(() => upsertSeamTicket(ticket("FG-2", { title: "renamed" })));
  assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), before);
  assert.equal(getTicket(PK, "FG-2")!.priorityRank, 2);
});
