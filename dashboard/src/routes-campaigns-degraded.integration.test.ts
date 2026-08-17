// FG-395 / RF-1: a campaign store read that THROWS (an unavailable or malformed store)
// must be reported as HTTP 503 — never a 200 that a consumer checking only status reads
// as a successful, empty list/report. legit-empty stays 200 (covered by the smoke test),
// unknown id stays 404, and only a thrown read is 503. The {error} body shape is
// preserved so the client's degraded-state rendering still works.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { applyMigrations, setDbForTest } from "../../src/store/db.js";

const TEST_PORT = 18797;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tmpHome = mkdtempSync(join(tmpdir(), "forge-campaigns-degraded-"));

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  // Make every campaign read raise the way an unavailable/malformed store would: the
  // tables the assembler reads are gone, so listCampaigns()/getCampaign() throw
  // "no such table" rather than returning zero rows.
  db.exec("DROP TABLE campaign_items");
  db.exec("DROP TABLE campaigns");
  setDbForTest(db);
}

process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // A 503 still resolves the fetch — we only need the socket to be up.
    try {
      await fetch(`${BASE}/api/campaigns`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error("degraded campaigns test server did not start");
}

await waitForServer();

test("GET /api/campaigns reports a thrown store read as 503, not a successful 200", async () => {
  const res = await fetch(`${BASE}/api/campaigns`);
  assert.equal(res.status, 503, "an unavailable/malformed store is a failure, not an empty read");
  const body = await res.json() as { projectKey: null; campaigns: unknown[]; error: string };
  assert.equal(body.projectKey, null);
  assert.deepEqual(body.campaigns, [], "the degraded body shape is preserved for the client");
  assert.match(body.error, /no such table/i);
});

test("GET /api/campaign/:id reports a thrown store read as 503, distinct from a 404 unknown id", async () => {
  const res = await fetch(`${BASE}/api/campaign/camp-anything`);
  assert.equal(res.status, 503, "a store that cannot be read is 503, not the 404 'unknown id' answer");
  const body = await res.json() as { error: string };
  assert.match(body.error, /no such table/i);
});
