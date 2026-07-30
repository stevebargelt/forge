// FG-638: /api/reviews against a store that PREDATES the review ledger.
//
// The migration is machine-wide but not instantaneous: a dashboard can be pointed
// at a ~/.forge/forge.db whose last writable open was an older binary, and the
// read-only open never creates the missing tables (db.ts's policy — a read must not
// migrate a store it has no authority over). The route must name that and stay up,
// not 500 the panel or take the page down.
//
// Its own file because the server reads FORGE_HOME once, at module evaluation.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18780;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "forge-reviews-legacy-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

// A pre-FG-638 store: runs exist, the ledger tables do not.
const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  INSERT INTO runs VALUES ('run-legacy','legacy','feature','/proj/legacy','active','2026-01-01T00:00:00Z');
`);
db.close();

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

test("integ GET /api/reviews on a pre-ledger store answers 200 with an empty ledger and a named error", async () => {
  const res = await fetch(`${BASE}/api/reviews`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { reviews: unknown[]; error?: string };
  assert.deepEqual(body.reviews, []);
  assert.match(body.error ?? "", /no such table/i);
});
