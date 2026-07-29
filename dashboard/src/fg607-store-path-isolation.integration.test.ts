// FG-607 / FG-616 regression — the dashboard must read the store the PROCESS
// has, resolved per call, never a snapshot taken at module-evaluation time.
//
// FG-607: src/backlog/structured.ts (`@forge/backlog`) imports src/store/db.ts,
// which transitively evaluates src/util/paths.ts. ESM evaluates static imports
// before the importing module's own body, so paths.ts snapshotted the REAL
// ~/.forge before the line below assigned FORGE_HOME — and every store read in
// the request path then went to the wrong host's forge.db. The static import of
// `@forge/backlog` below is the reproduction, not an accident of style: move it
// under the env assignment and this test stops testing anything.
//
// FG-616 (folded into FG-608): dashboard/src/queries.ts held the SAME shape — a
// module-eval FORGE_HOME/DB_PATH snapshot, plus a connection cached with no
// regard for the path it was opened on. That is more than a path fix: the
// dashboard holds a SECOND, independent read-only handle that forge's
// dbGeneration()-keyed cache knows nothing about, so this is what decides
// whether a long-running dashboard ever observes a store (or storage-mode)
// change at all. The last test repoints FORGE_HOME after the server is running
// and requires the endpoint to answer from the new store.

import { listTickets } from "@forge/backlog";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { repositoryCheckoutIdentity } from "../../src/util/repository-identity.js";

const TEST_PORT = 18779;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "fg607-store-path-"));
const secondHome = mkdtempSync(join(tmpdir(), "fg616-second-home-"));
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

// A second canonical checkout that commits a project_key belonging to ANOTHER
// repository. Since FG-608 the dashboard derives the project_key from its own
// resolution (accepted default (f)) and never reads .forge/config.yml, so a
// borrowed key cannot point the board at the other project's tickets.
const conflictDir = mkdtempSync(join(tmpdir(), "fg607-store-path-conflict-"));
execFileSync("git", ["init", "-b", "main"], { cwd: conflictDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg607-conflict.git"], {
  cwd: conflictDir,
  stdio: "ignore",
});
mkdirSync(join(conflictDir, ".forge"), { recursive: true });
writeFileSync(join(conflictDir, ".forge", "config.yml"), "project_key: borrowed-key\n");
mkdirSync(join(conflictDir, "backlog", "stories"), { recursive: true });
writeFileSync(join(conflictDir, "backlog", "notes.md"), "# Session handoff\n\nborrowed-key fixture.\n");

const FIXTURE_KEY = "pk-fg607-fixture";
const at = "2026-07-24T10:00:00Z";

function seed(home: string, ticketIds: string[]): void {
  const database = new Database(join(home, "forge.db"));
  database.exec(SCHEMA_SQL);
  const run = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  run.run("run-fg607-store-path", "feature", "FG-607 fixture", "complete", at, fixtureDir);
  run.run("run-fg607-conflict", "feature", "FG-607 conflict", "complete", at, conflictDir);
  const identity = database.prepare(
    "INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)",
  );
  identity.run(FIXTURE_KEY, repositoryCheckoutIdentity(fixtureDir).key, "remote", at);
  // 'borrowed-key' is owned by an unrelated repository's evidence — exactly the
  // shape a copied .forge/config.yml produces.
  identity.run("borrowed-key", "origin:git@github.com:stevebargelt/some-other-repo.git", "remote", at);
  database
    .prepare("INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)")
    .run(FIXTURE_KEY, "db", at);
  const ticket = database.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,'story','active',?,?,NULL,NULL,NULL,NULL,NULL,?,NULL)`,
  );
  for (const id of ticketIds) ticket.run(FIXTURE_KEY, id, `Title ${id}`, `${id} body.`, at);
  // Tickets owned by the borrowed key's real project. A response naming these
  // could only have come from trusting the copied config.
  const borrowed = database.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES ('borrowed-key',?,'story','active',?,?,NULL,NULL,NULL,NULL,NULL,?,NULL)`,
  );
  borrowed.run("FG-911", "Borrowed", "Borrowed body.", at);
  database.close();
}

seed(tmpHome, ["FG-901", "FG-902", "FG-903"]);
// The SAME project, with a DIFFERENT inventory, in a DIFFERENT home.
seed(secondHome, ["FG-950"]);

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
  process.env.FORGE_HOME = tmpHome;
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

type BacklogBody = {
  notes: string;
  tickets: Array<Record<string, unknown>>;
  ticketsProjectKey: string | null;
  ticketsError?: string;
};

async function getBacklog(dir: string): Promise<BacklogBody> {
  const res = await fetch(`${BASE}/api/backlog?projectDir=${encodeURIComponent(dir)}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  return res.json() as Promise<BacklogBody>;
}

test("GET /api/backlog agrees with listTickets() when @forge/backlog was imported before FORGE_HOME was set", async () => {
  const body = await getBacklog(fixtureDir);
  const direct = listTickets(fixtureDir);
  assert.equal(direct.length, 3, "fixture sanity: the seam must see the three db-mode stories");
  assert.equal(
    body.ticketsError,
    undefined,
    `the endpoint swallowed a ticket-read error instead of reading tickets: ${body.ticketsError}`,
  );
  assert.deepEqual(
    body.tickets.map((t) => t["id"]).sort(),
    direct.map((t) => t.id).sort(),
    "the endpoint and the seam must name the same tickets — and the same store",
  );
});

test("a checkout committing a BORROWED project_key never surfaces that project's tickets", async () => {
  const body = await getBacklog(conflictDir);
  assert.ok(
    !body.tickets.some((t) => t["id"] === "FG-911"),
    "the dashboard derives the project_key from its own resolution; a copied config.yml cannot redirect it",
  );
  assert.notEqual(body.ticketsProjectKey, "borrowed-key", "the committed key is not a store key the board accepts");
  assert.deepEqual(body.tickets, [], "this repository's own evidence is unregistered — it has no ticket truth");
  assert.match(body.notes, /borrowed-key fixture/, "notes are per-checkout and unaffected by ticket resolution");
});

test("the store resolves against the FORGE_HOME the process actually has, not an import-time snapshot", async () => {
  const { resolveDbPath } = await import("../../src/util/paths.js");
  assert.equal(
    resolveDbPath(),
    join(tmpHome, "forge.db"),
    "resolveDbPath() must follow process.env.FORGE_HOME set after paths.ts was evaluated",
  );
});

// FG-616. LAST test: repoints FORGE_HOME at a second store while the server is
// running. A module-eval snapshot (or a connection cached without regard for its
// path) would keep answering FG-901..903 forever.
test("queries.ts resolves the store per call: a FORGE_HOME change after boot is observed", async () => {
  const before = await getBacklog(fixtureDir);
  assert.deepEqual(before.tickets.map((t) => t["id"]).sort(), ["FG-901", "FG-902", "FG-903"]);

  process.env.FORGE_HOME = secondHome;
  try {
    const after = await getBacklog(fixtureDir);
    assert.deepEqual(
      after.tickets.map((t) => t["id"]),
      ["FG-950"],
      "the dashboard must answer from the store the process has NOW, not the one it booted with",
    );
    assert.equal(after.ticketsProjectKey, FIXTURE_KEY);
  } finally {
    process.env.FORGE_HOME = tmpHome;
  }

  const restored = await getBacklog(fixtureDir);
  assert.deepEqual(
    restored.tickets.map((t) => t["id"]).sort(),
    ["FG-901", "FG-902", "FG-903"],
    "and back again — the handle follows the path, it is not pinned to the first one opened",
  );
});
