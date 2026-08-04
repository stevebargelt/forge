// FG-609 (FG-496 Slice D) — A11: the blocked-derivation predicate, asserted
// SEPARATELY FOR EACH of the four surfaces that derive it.
//
// A single aggregate assertion over one surface would not do. Two of the four were
// UNFILTERED before this slice — container-authority.ts and
// docker/forge-backlog-reader.mjs both ran `SELECT 1 FROM blocker_evidence WHERE
// ticket_id = ? LIMIT 1` — and they agreed with the legacy-filtered host seam ONLY
// because legacy was the sole evidence kind that existed. Slice D adds dependency /
// campaign / run-derived kinds, so the FIRST such row would have flipped every
// container to reporting the ticket as status 'blocked' while the host still said
// 'active', shipped to every live container on the next publish, with no code
// change in the container path. Those two surfaces are the actual defect, so the
// test names them individually rather than aggregating.
//
// Each surface gets the SAME two questions:
//   (a) does a NON-status-bearing enriched row leave the ticket unblocked?
//   (b) does a legacy row still block it?

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import {
  setStorageMode,
  upsertTicket,
  upsertBlockerEvidence,
  LEGACY_BLOCKED_SOURCE,
  type TicketRow,
} from "../store/tickets.js";
import { dependencyBlockerSource } from "../store/blocked-source.js";
import { enqueueTicket, executableQueue } from "../store/queue.js";
import { listTickets } from "./structured.js";
import { clearBacklogStoreCache } from "./storage-mode.js";
import { publishSnapshotOnce, SNAPSHOT_DB_BASENAME } from "./snapshot.js";
import {
  containerReadTicket,
  closeContainerAuthorityForTest,
  setAuthorityMountForTest,
  writeAuthorityMarker,
} from "./container-authority.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PK = "pk-parity";
const NOW = "2026-08-01T00:00:00Z";

// A body evaluateReadiness (FG-382) calls READY, so the D7 test below can enqueue.
const READY_BODY = [
  "## Problem",
  "Something is wrong.",
  "",
  "## Goal",
  "Make it right.",
  "",
  "## Acceptance Criteria",
  "- it works",
].join("\n");

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let scratch: string;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
  scratch = mkdtempSync(join(tmpdir(), "fg609-parity-"));
  projectDir = join(scratch, "project");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${PK}\nbacklog:\n  prefix: FG\n`);
  setStorageMode(PK, "db", NOW);
});

afterEach(() => {
  closeContainerAuthorityForTest();
  setDbForTest(prev as DatabaseInstance);
  db.close();
  clearBacklogStoreCache();
  rmSync(scratch, { recursive: true, force: true });
});

function ticket(id: string, over: Partial<TicketRow> = {}): TicketRow {
  return {
    projectKey: PK,
    ticketId: id,
    type: "story",
    status: "active",
    title: `title ${id}`,
    body: "body",
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: NOW,
    importedFrom: null,
    ...over,
  };
}

/** FG-ENRICHED carries only a non-status-bearing dependency row.
 *  FG-LEGACY carries the legacy one. FG-PLAIN carries nothing. */
function seedThreeTickets(): void {
  writeTransaction(() => {
    upsertTicket(ticket("FG-PLAIN"));
    upsertTicket(ticket("FG-ENRICHED"));
    upsertTicket(ticket("FG-LEGACY"));
    upsertBlockerEvidence({
      projectKey: PK,
      ticketId: "FG-ENRICHED",
      reason: "waits on FG-99",
      source: dependencyBlockerSource("FG-99"),
      createdAt: NOW,
      kind: "dependency",
      detail: { dependency: "FG-99" },
      queueProjection: "blocked",
    });
    upsertBlockerEvidence({
      projectKey: PK,
      ticketId: "FG-LEGACY",
      reason: "legacy blocked",
      source: LEGACY_BLOCKED_SOURCE,
      createdAt: NOW,
    });
  });
}

// ─── surface (i): the HOST SEAM, src/backlog/structured.ts ──────────────────

test("A11 (i) host seam: an enriched row does not flip a ticket to blocked; a legacy one does", () => {
  seedThreeTickets();
  const byId = new Map(listTickets(projectDir).map((t) => [t.id, t.status]));
  assert.equal(byId.get("FG-PLAIN"), "active");
  assert.equal(
    byId.get("FG-ENRICHED"),
    "active",
    "surface (i): a dependency blocker must not flip the host seam to blocked",
  );
  assert.equal(byId.get("FG-LEGACY"), "blocked", "surface (i): a legacy row still blocks");
});

// ─── the snapshot the two container surfaces read ──────────────────────────
//
// Written by hand rather than published, deliberately: the point is to feed BOTH
// kinds of evidence to those READERS even though the publisher now filters the
// enriched kind out upstream. The predicate has to be right in the reader, not
// only in what happens to reach it — a container running an older-published
// artifact, or a future kind the publisher does carry, must still be safe.
const SNAPSHOT_SCHEMA = `
CREATE TABLE snapshot_meta (
  project_key TEXT NOT NULL, published_at TEXT NOT NULL,
  max_revision INTEGER NOT NULL, publication_ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE tickets (
  ticket_id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', created TEXT, closed TEXT, closed_commit TEXT, epic TEXT,
  revision INTEGER NOT NULL DEFAULT 1, body_hash TEXT
);
CREATE TABLE ticket_relations (
  ticket_id TEXT NOT NULL, related_id TEXT NOT NULL, rel_type TEXT NOT NULL,
  PRIMARY KEY (ticket_id, related_id, rel_type)
);
CREATE TABLE blocker_evidence (
  ticket_id TEXT NOT NULL, reason TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, source)
);
`;

function writeSnapshotWithBothKinds(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SNAPSHOT_DB_BASENAME);
  const out = new Database(path);
  out.pragma("journal_mode = DELETE");
  out.exec(SNAPSHOT_SCHEMA);
  const ins = out.prepare(
    `INSERT INTO tickets (ticket_id, type, status, title, body, revision)
     VALUES (?, 'story', 'active', ?, 'body', 1)`,
  );
  for (const id of ["FG-PLAIN", "FG-ENRICHED", "FG-LEGACY"]) ins.run(id, `title ${id}`);
  const insE = out.prepare(
    `INSERT INTO blocker_evidence (ticket_id, reason, source, created_at) VALUES (?, ?, ?, ?)`,
  );
  insE.run("FG-ENRICHED", "waits on FG-99", dependencyBlockerSource("FG-99"), NOW);
  insE.run("FG-LEGACY", "legacy blocked", LEGACY_BLOCKED_SOURCE, NOW);
  out
    .prepare(
      `INSERT INTO snapshot_meta (project_key, published_at, max_revision, publication_ordinal)
       VALUES (?, ?, 1, 1)`,
    )
    .run(PK, NOW);
  out.close();
  return path;
}

// ─── surface (ii): src/backlog/container-authority.ts ───────────────────────

test("A11 (ii) container-authority: an enriched row does not flip a ticket to blocked", () => {
  const mount = join(scratch, "mount");
  writeSnapshotWithBothKinds(mount);
  // Through the COMPILED-IN MOUNT PATH seam, not the env var: containerAuthority()
  // checks the fixed path first and ignores the environment when a marker is there,
  // which is the resolution order the security property depends on.
  writeAuthorityMarker(mount, { mode: "db", projectKey: PK, taskId: "task-parity" });
  setAuthorityMountForTest(mount);
  closeContainerAuthorityForTest();
  try {
    assert.equal(containerReadTicket("FG-PLAIN").status, "active");
    assert.equal(
      containerReadTicket("FG-ENRICHED").status,
      "active",
      "surface (ii) was UNFILTERED before FG-609 — this is one of the two actual defects",
    );
    assert.equal(containerReadTicket("FG-LEGACY").status, "blocked");
  } finally {
    setAuthorityMountForTest(null);
    closeContainerAuthorityForTest();
  }
});

// ─── surface (iii): dashboard/src/queries.ts ────────────────────────────────

test("A11 (iii) dashboard: it filters on the canonical literal, reached by import", () => {
  const src = readFileSync(join(repoRoot, "dashboard/src/queries.ts"), "utf8");
  assert.match(
    src,
    /SELECT ticket_id FROM blocker_evidence WHERE project_key = \? AND source = \?/,
    "the dashboard must filter blocked evidence by source",
  );
  assert.match(
    src,
    /\.all\(projectKey, LEGACY_BLOCKED_SOURCE\)/,
    "...bound to the canonical literal, not to a private copy",
  );
  assert.match(src, /from "@forge\/blocked-source"/);

  // And the behavior, run against a real DB through the dashboard's own SQL text.
  seedThreeTickets();
  const blocked = new Set(
    (
      db
        .prepare(`SELECT ticket_id FROM blocker_evidence WHERE project_key = ? AND source = ?`)
        .all(PK, LEGACY_BLOCKED_SOURCE) as { ticket_id: string }[]
    ).map((r) => r.ticket_id),
  );
  assert.equal(blocked.has("FG-ENRICHED"), false, "surface (iii): the enriched row must not block");
  assert.equal(blocked.has("FG-LEGACY"), true, "surface (iii): the legacy row still blocks");
});

// ─── surface (iv): docker/forge-backlog-reader.mjs — the PARITY PIN ─────────

test("A11 (iv) .mjs reader: its predicate is PINNED to the canonical value", () => {
  const src = readFileSync(join(repoRoot, "docker/forge-backlog-reader.mjs"), "utf8");

  // It runs in the container with no TypeScript build and structurally cannot
  // share the import, so the copy is pinned here rather than assumed to match.
  const decl = src.match(/const LEGACY_BLOCKED_SOURCE = "([^"]+)";/);
  assert.ok(decl, "the .mjs must declare the literal it filters on");
  assert.equal(
    decl![1],
    LEGACY_BLOCKED_SOURCE,
    "the container reader's copy has drifted from src/store/blocked-source.ts",
  );

  assert.match(
    src,
    /SELECT 1 FROM blocker_evidence WHERE ticket_id = \? AND source = \? LIMIT 1/,
    "surface (iv) was UNFILTERED before FG-609 — the query must now filter by source",
  );
  assert.match(src, /\.get\(row\.ticket_id, LEGACY_BLOCKED_SOURCE\)/);
  // The unfiltered form must be GONE, not merely joined by a filtered one.
  assert.equal(
    /SELECT 1 FROM blocker_evidence WHERE ticket_id = \? LIMIT 1/.test(src),
    false,
    "the unfiltered query must be REPLACED, not left alongside",
  );
});

test("A11 (iv) .mjs reader: the pinned predicate produces the same verdicts on a real snapshot", () => {
  // Executes the reader's derivation against a snapshot carrying BOTH kinds, using
  // the exact SQL text the .mjs runs, so the pin above is backed by behavior and
  // not only by a source match.
  const mount = join(scratch, "mjs-mount");
  const path = writeSnapshotWithBothKinds(mount);
  const snap = new Database(path, { readonly: true });
  try {
    const isBlocked = (id: string): boolean =>
      snap
        .prepare(`SELECT 1 FROM blocker_evidence WHERE ticket_id = ? AND source = ? LIMIT 1`)
        .get(id, LEGACY_BLOCKED_SOURCE) !== undefined;
    assert.equal(isBlocked("FG-PLAIN"), false);
    assert.equal(isBlocked("FG-ENRICHED"), false);
    assert.equal(isBlocked("FG-LEGACY"), true);
  } finally {
    snap.close();
  }
});

// ─── D7 whole: ONE ticket, both predicates, all four surfaces ──────────────

test("FG-609 D7: an enriched blocker blocks the QUEUE while all four legacy surfaces still read active", () => {
  // The ticket needs a READY body to be enqueueable; everything else about the
  // fixture is the same FG-ENRICHED the four surface tests above use.
  writeTransaction(() => {
    upsertTicket(ticket("FG-ENRICHED", { body: READY_BODY }));
    upsertBlockerEvidence({
      projectKey: PK,
      ticketId: "FG-ENRICHED",
      reason: "waits on FG-99",
      source: dependencyBlockerSource("FG-99"),
      createdAt: NOW,
      kind: "dependency",
      detail: { dependency: "FG-99" },
      queueProjection: "blocked",
    });
  });
  assert.equal(enqueueTicket(PK, "FG-ENRICHED").ok, true);

  // (a) the QUEUE projection reads the enriched evidence...
  const entry = executableQueue(PK).find((e) => e.ticketId === "FG-ENRICHED");
  assert.ok(entry, "blocked must not remove the entry from the executable queue");
  assert.equal(entry.blocked, true, "D7: enriched evidence MUST move the queue projection");

  // (b) ...and no legacy surface moves. (i) the host seam:
  const seam = listTickets(projectDir).find((t) => t.id === "FG-ENRICHED")!;
  assert.equal(seam.status, "active", "surface (i): StructuredTicket.status must stay active");

  const target = join(scratch, "d7-published");
  publishSnapshotOnce(PK, target);
  writeAuthorityMarker(target, { mode: "db", projectKey: PK, taskId: "task-d7" });
  setAuthorityMountForTest(target);
  closeContainerAuthorityForTest();
  try {
    // (ii) the container authority, over the artifact a live container would get:
    assert.equal(containerReadTicket("FG-ENRICHED").status, "active");
    // (iv) the .mjs reader's pinned predicate, over the same artifact:
    const snap = new Database(join(target, SNAPSHOT_DB_BASENAME), { readonly: true });
    try {
      assert.equal(
        snap
          .prepare(`SELECT 1 FROM blocker_evidence WHERE ticket_id = ? AND source = ? LIMIT 1`)
          .get("FG-ENRICHED", LEGACY_BLOCKED_SOURCE),
        undefined,
      );
    } finally {
      snap.close();
    }
  } finally {
    setAuthorityMountForTest(null);
    closeContainerAuthorityForTest();
  }

  // (iii) the dashboard's query text, against the host DB:
  assert.equal(
    db
      .prepare(`SELECT ticket_id FROM blocker_evidence WHERE project_key = ? AND source = ?`)
      .all(PK, LEGACY_BLOCKED_SOURCE).length,
    0,
    "surface (iii): the enriched row must not appear in the dashboard's blocked set",
  );
});

// ─── the publisher's evidence copy ─────────────────────────────────────────

test("FG-609: the published snapshot carries the legacy row and NOT the enriched one", () => {
  seedThreeTickets();
  const target = join(scratch, "published");
  publishSnapshotOnce(PK, target);
  const out = new Database(join(target, SNAPSHOT_DB_BASENAME), { readonly: true });
  try {
    const sources = (
      out.prepare(`SELECT ticket_id, source FROM blocker_evidence`).all() as {
        ticket_id: string;
        source: string;
      }[]
    ).map((r) => `${r.ticket_id}/${r.source}`);
    assert.deepEqual(
      sources,
      [`FG-LEGACY/${LEGACY_BLOCKED_SOURCE}`],
      "an enriched row copied into the published artifact is the same silent status " +
        "reinterpretation, one layer up",
    );
  } finally {
    out.close();
  }
});
