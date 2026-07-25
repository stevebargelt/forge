// FG-607 regression — GET /api/backlog and listTickets() must agree when the
// backlog seam is imported BEFORE the process settles on its FORGE_HOME.
//
// FG-607 made src/backlog/structured.ts (`@forge/backlog`) import src/store/db.ts
// for the db-mode seam, which transitively evaluates src/util/paths.ts. ESM
// evaluates static imports before the importing module's own body, so paths.ts
// snapshotted the REAL ~/.forge before the line below assigned FORGE_HOME — and
// every store read in the request path then went to the wrong host's forge.db.
// Observed two ways: the endpoint answered 0 tickets while listTickets() on the
// same directory answered 3 (the operator's populated store resolved no fixture
// project), or the handler 500'd outright (a stale ~/.forge/forge.db that
// SCHEMA_SQL could not be re-applied to). Both are the same defect.
//
// The static import of `@forge/backlog` below is the reproduction, not an
// accident of style: move it under the env assignment and this test stops
// testing anything.

import { listTickets } from "@forge/backlog";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18779;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "fg607-store-path-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg607-store-path-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const fixtureDir = mkdtempSync(join(tmpdir(), "fg607-store-path-fx-"));
execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg607-store-path.git"], {
  cwd: fixtureDir,
  stdio: "ignore",
});
mkdirSync(join(fixtureDir, "backlog", "stories"), { recursive: true });
writeFileSync(join(fixtureDir, "backlog", "notes.md"), "# Session handoff\n\nFG-607 fixture.\n");
for (const [id, title] of [
  ["FG-901", "First"],
  ["FG-902", "Second"],
  ["FG-903", "Third"],
] as const) {
  writeFileSync(
    join(fixtureDir, "backlog", "stories", `${id}-${title.toLowerCase()}.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\n---\n${title} body.\n`,
  );
}

// A second canonical checkout that commits a project_key the registry says belongs
// to ANOTHER repository — one of the two identity refusals FG-607 added to the read
// seam, and the throwing path the bare catch used to render as "no tickets".
const conflictDir = mkdtempSync(join(tmpdir(), "fg607-store-path-conflict-"));
execFileSync("git", ["init", "-b", "main"], { cwd: conflictDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg607-conflict.git"], {
  cwd: conflictDir,
  stdio: "ignore",
});
mkdirSync(join(conflictDir, ".forge"), { recursive: true });
writeFileSync(join(conflictDir, ".forge", "config.yml"), "project_key: borrowed-key\n");
mkdirSync(join(conflictDir, "backlog", "stories"), { recursive: true });
writeFileSync(
  join(conflictDir, "backlog", "stories", "FG-911-borrowed.md"),
  "---\nid: FG-911\ntype: story\nstatus: active\ntitle: Borrowed\n---\nBorrowed body.\n",
);

{
  const database = new Database(join(tmpHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const run = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  run.run("run-fg607-store-path", "feature", "FG-607 fixture", "complete", "2026-07-24T10:00:00Z", fixtureDir);
  run.run("run-fg607-conflict", "feature", "FG-607 conflict", "complete", "2026-07-24T10:00:00Z", conflictDir);
  database
    .prepare(
      "INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)",
    )
    .run("borrowed-key", "origin:git@github.com:stevebargelt/some-other-repo.git", "remote", "2026-07-24T10:00:00Z");
  database.close();
}

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

{
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`Server on port ${TEST_PORT} did not start`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

test("GET /api/backlog agrees with listTickets() when @forge/backlog was imported before FORGE_HOME was set", async () => {
  const res = await fetch(`${BASE}/api/backlog?projectDir=${encodeURIComponent(fixtureDir)}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as {
    tickets: Array<Record<string, unknown>>;
    ticketsError?: string;
  };

  const direct = listTickets(fixtureDir);
  assert.equal(direct.length, 3, "fixture sanity: listTickets() must see the three markdown stories");
  assert.equal(
    body.ticketsError,
    undefined,
    `the endpoint swallowed a ticket-read error instead of reading tickets: ${body.ticketsError}`,
  );
  assert.equal(
    body.tickets.length,
    direct.length,
    `HTTP returned ${body.tickets.length} tickets; listTickets() returned ${direct.length}`,
  );
  assert.deepEqual(
    body.tickets.map((t) => t["id"]).sort(),
    direct.map((t) => t.id).sort(),
    "the endpoint and the seam must name the same tickets",
  );
});

test("GET /api/backlog surfaces an identity refusal instead of rendering it as an empty backlog", async () => {
  const res = await fetch(`${BASE}/api/backlog?projectDir=${encodeURIComponent(conflictDir)}`);
  assert.equal(res.status, 200, "a failed ticket read must not take the panel down");
  const body = (await res.json()) as { tickets: unknown[]; ticketsError?: string };

  assert.equal(body.tickets.length, 0, "a refused read yields no tickets");
  assert.ok(
    body.ticketsError && /project_key/.test(body.ticketsError),
    `expected the refusal to be named in ticketsError, got: ${JSON.stringify(body.ticketsError)}`,
  );
});

test("the store resolves against the FORGE_HOME the process actually has, not an import-time snapshot", async () => {
  const { resolveDbPath } = await import("../../src/util/paths.js");
  assert.equal(
    resolveDbPath(),
    join(tmpHome, "forge.db"),
    "resolveDbPath() must follow process.env.FORGE_HOME set after paths.ts was evaluated",
  );
});
