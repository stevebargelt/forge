// FG-608 (FG-496 Slice C) — GET /api/backlog serves HOST-WIDE ticket truth.
//
// The contract this file owns:
//
//   1. Tickets come from the host store keyed by project_key. Every checkout of
//      one repository — canonical, feature branch, linked worktree, clone —
//      answers with the SAME rows. Branch-local `backlog/*.md` files are never
//      read for ticket truth, so the fixtures deliberately carry markdown ids
//      that must never appear in a response.
//   2. The project_key is DERIVED from the dashboard's own project resolution,
//      never taken from the request's `projectKey` parameter (accepted default
//      (f)). A request cannot name a project the dashboard did not resolve for
//      it — the board stays per-project (cross-project aggregation is FG-591).
//   3. "No ticket truth" has a defined answer: an unregistered repository (never
//      imported) reports ticketsProjectKey: null with an empty ticket list and
//      KEEPS its session-handoff notes. A registered project with an empty board
//      reports its key — the two are distinguishable, not both "empty".
//   4. A ticket-read failure isolates into `ticketsError` and still returns
//      notes with HTTP 200; the notes half of the payload never depends on the
//      ticket half succeeding.
//
// Harness follows routes-backlog-main-only.integration.test.ts: real git
// checkouts collapsed to canonical projects by shared origin, registered via DB
// run rows, exercised over the real HTTP server.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { repositoryCheckoutIdentity } from "../../src/util/repository-identity.js";

const TEST_PORT = 18773;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "fg608-db-truth-"));
const forgeHome = join(testHome, ".forge");
const brokenHome = join(testHome, ".forge-no-ticket-tables");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(brokenHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

/** Branch-local markdown that must NEVER surface as ticket truth. */
function markdownTicket(id: string, title: string): string {
  return `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\n---\n${title} body.\n`;
}

function makeCheckout(name: string, branch: string, remote: string, markdownIds: string[], notes: string): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir);
  git(dir, ["init", "-b", branch]);
  git(dir, ["remote", "add", "origin", remote]);
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  for (const id of markdownIds) {
    writeFileSync(join(dir, "backlog", "stories", `${id}.md`), markdownTicket(id, `Markdown ${id}`));
  }
  writeFileSync(join(dir, "backlog", "notes.md"), notes);
  return dir;
}

// ── alpha: canonical main + a feature checkout of the same repository ────────
const ALPHA_REMOTE = "git@github.com:stevebargelt/fg608-alpha.git";
const alphaMainDir = makeCheckout("alpha", "main", ALPHA_REMOTE, ["AL-900"], "# Alpha handoff\n\nmain notes.\n");
const alphaFeatureDir = makeCheckout(
  "alpha-feature",
  "feature-x",
  ALPHA_REMOTE,
  ["AL-901", "AL-902"],
  "# Alpha feature handoff\n\nfeature notes.\n",
);

// ── beta: a SECOND project, reachable only through its own resolution ────────
const BETA_REMOTE = "git@github.com:stevebargelt/fg608-beta.git";
const betaDir = makeCheckout("beta", "main", BETA_REMOTE, [], "# Beta handoff\n\nbeta notes.\n");

// ── gamma: registered project_key, ZERO ticket rows (empty board) ────────────
const GAMMA_REMOTE = "git@github.com:stevebargelt/fg608-gamma.git";
const gammaDir = makeCheckout("gamma", "main", GAMMA_REMOTE, ["GA-900"], "# Gamma handoff\n\ngamma notes.\n");

// ── delta: never imported — no project_identity row at all ───────────────────
const DELTA_REMOTE = "git@github.com:stevebargelt/fg608-delta.git";
const deltaDir = makeCheckout("delta", "main", DELTA_REMOTE, ["DE-900"], "# Delta handoff\n\ndelta notes.\n");

const ALPHA_KEY = "pk-fg608-alpha";
const BETA_KEY = "pk-fg608-beta";
const GAMMA_KEY = "pk-fg608-gamma";

const evidenceKey = (dir: string): string => repositoryCheckoutIdentity(dir).key;

function seedRuns(database: Database.Database): void {
  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertTask = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  [alphaMainDir, alphaFeatureDir, betaDir, gammaDir, deltaDir].forEach((projectDir, index) => {
    const runId = `run-${index}`;
    const createdAt = `2026-07-${15 + index}T10:00:00Z`;
    insertRun.run(runId, "feature", `Run ${index}`, "complete", createdAt, projectDir);
    insertTask.run(`done-${index}`, runId, "engineer", "engineer", "complete", createdAt, createdAt, createdAt);
  });
}

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  seedRuns(database);

  const insertIdentity = database.prepare(
    "INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)",
  );
  insertIdentity.run(ALPHA_KEY, evidenceKey(alphaMainDir), "remote", "2026-07-20T10:00:00Z");
  insertIdentity.run(BETA_KEY, evidenceKey(betaDir), "remote", "2026-07-20T10:00:00Z");
  insertIdentity.run(GAMMA_KEY, evidenceKey(gammaDir), "remote", "2026-07-20T10:00:00Z");
  // delta deliberately unregistered.

  // alpha has cut over; beta has an imported shadow but is still markdown-mode.
  database
    .prepare("INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)")
    .run(ALPHA_KEY, "db", "2026-07-20T10:00:00Z");

  const insertTicket = database.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,NULL)`,
  );
  const at = "2026-07-20T10:00:00Z";
  // AL-9 / AL-100 prove numeric id ordering (a lexical sort inverts them).
  insertTicket.run(ALPHA_KEY, "AL-100", "epic", "active", "Alpha Epic", "Epic body.", "2026-07-01", null, null, null, at);
  insertTicket.run(ALPHA_KEY, "AL-9", "story", "active", "Alpha Story", "Story body.", "2026-07-02", null, null, "AL-100", at);
  insertTicket.run(ALPHA_KEY, "AL-10", "story", "active", "Alpha Blocked", "Blocked body.", null, null, null, null, at);
  insertTicket.run(ALPHA_KEY, "AL-11", "idea", "done", "Alpha Idea", "Idea body.", null, "2026-07-10", "abc1234", null, at);
  insertTicket.run(BETA_KEY, "BE-1", "story", "active", "Beta Story", "Beta body.", null, null, null, null, at);

  database
    .prepare("INSERT INTO ticket_relations (project_key,ticket_id,related_id,rel_type) VALUES (?,?,?,?)")
    .run(ALPHA_KEY, "AL-9", "AL-10", "related");
  // Legacy blocked: stored active + evidence, reconstructed as blocked on read.
  database
    .prepare("INSERT INTO blocker_evidence (id,project_key,ticket_id,reason,source,created_at) VALUES (?,?,?,?,?,?)")
    .run("be-1", ALPHA_KEY, "AL-10", "waiting on AL-9", "import-legacy-blocked", at);

  database.close();
}

// A host store that PREDATES the FG-606 ticket tables: runs and tasks exist, the
// ticket tables do not. The dashboard opens it read-only and never migrates, so
// this is what a ticket read failing (rather than answering empty) looks like.
{
  const database = new Database(join(brokenHome, "forge.db"));
  database.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, project_dir TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL, agent_role TEXT NOT NULL,
      status TEXT NOT NULL, task_package TEXT, result TEXT, created_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT
    );
    CREATE TABLE project_identity (
      project_key TEXT PRIMARY KEY, repo_evidence_key TEXT NOT NULL UNIQUE,
      repo_evidence_source TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  seedRuns(database);
  database
    .prepare("INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)")
    .run(ALPHA_KEY, evidenceKey(alphaMainDir), "remote", "2026-07-20T10:00:00Z");
  database.close();
}

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

for (let attempt = 0; attempt < 75; attempt += 1) {
  try {
    await fetch(`${BASE}/`);
    break;
  } catch {
    if (attempt === 74) throw new Error("dashboard test server did not start");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

type BacklogBody = {
  notes: string;
  notesByCheckout: Array<{ checkoutDir: string; checkoutBranch: string | null; notes: string }>;
  tickets: Array<Record<string, unknown>>;
  ticketsProjectKey: string | null;
  ticketsStorageMode: string | null;
  ticketsError?: string;
};

async function getBacklog(params: string): Promise<BacklogBody> {
  const res = await fetch(`${BASE}/api/backlog${params}`);
  assert.equal(res.status, 200, `expected 200 for /api/backlog${params}`);
  return res.json() as Promise<BacklogBody>;
}

async function dashboardKeyFor(dir: string): Promise<string> {
  const res = await fetch(`${BASE}/api/projects`);
  const projects = (await res.json()) as Array<{ key: string; projectDirs: string[] }>;
  const owner = projects.find((p) => p.projectDirs.includes(dir));
  assert.ok(owner, `no canonical project resolved for ${dir}`);
  return owner!.key;
}

const ids = (body: BacklogBody): string[] => body.tickets.map((t) => String(t["id"]));

// ── host-wide truth: same rows for every checkout ────────────────────────────

test("canonical projectKey: tickets are the project's DB rows, not any checkout's markdown", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await dashboardKeyFor(alphaMainDir))}`);
  assert.deepEqual(ids(body), ["AL-9", "AL-10", "AL-11", "AL-100"], "DB inventory in ticket-id order");
  assert.equal(body.ticketsProjectKey, ALPHA_KEY);
  assert.equal(body.ticketsStorageMode, "db");
});

test("exact projectDir on a FEATURE checkout returns the identical ticket set", async () => {
  const canonical = await getBacklog(`?projectKey=${encodeURIComponent(await dashboardKeyFor(alphaMainDir))}`);
  const feature = await getBacklog(`?projectDir=${encodeURIComponent(alphaFeatureDir)}`);
  assert.deepEqual(
    ids(feature),
    ids(canonical),
    "a feature checkout and the canonical repo must see the same host-wide truth",
  );
  assert.equal(feature.ticketsProjectKey, ALPHA_KEY);
});

test("branch-local markdown ticket files never surface for either request shape", async () => {
  const byKey = await getBacklog(`?projectKey=${encodeURIComponent(await dashboardKeyFor(alphaMainDir))}`);
  const byDir = await getBacklog(`?projectDir=${encodeURIComponent(alphaFeatureDir)}`);
  for (const body of [byKey, byDir]) {
    for (const markdownId of ["AL-900", "AL-901", "AL-902"]) {
      assert.ok(!ids(body).includes(markdownId), `${markdownId} lives only in backlog/*.md and must not be truth`);
    }
  }
});

test("tickets are attributed to the project, not to a checkout", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(alphaFeatureDir)}`);
  for (const ticket of body.tickets) {
    assert.equal(ticket["checkoutDir"], undefined, "host-wide truth has no owning checkout");
    assert.equal(ticket["checkoutBranch"], undefined, "host-wide truth has no owning branch");
  }
});

test("ticket fields round-trip: epic, related, closed/closedCommit, legacy blocked", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(alphaMainDir)}`);
  const byId = new Map(body.tickets.map((t) => [String(t["id"]), t]));
  assert.equal(byId.get("AL-9")!["epic"], "AL-100");
  assert.deepEqual(byId.get("AL-9")!["related"], ["AL-10"]);
  assert.equal(byId.get("AL-11")!["closed"], "2026-07-10");
  assert.equal(byId.get("AL-11")!["closedCommit"], "abc1234");
  assert.equal(byId.get("AL-11")!["status"], "done");
  assert.equal(
    byId.get("AL-10")!["status"],
    "blocked",
    "an active row carrying legacy blocker evidence reads as blocked, exactly as the CLI seam reconstructs it",
  );
  assert.equal(byId.get("AL-100")!["related"], undefined, "no relations means no related key");
});

// ── the derived key wins over the request parameter (default (f)) ────────────

test("a projectKey parameter cannot redirect ticket truth to another project", async () => {
  const betaKey = await dashboardKeyFor(betaDir);
  const beta = await getBacklog(`?projectKey=${encodeURIComponent(betaKey)}`);
  assert.deepEqual(ids(beta), ["BE-1"], "sanity: beta's tickets ARE reachable through beta's own resolution");

  const spoofed = await getBacklog(
    `?projectDir=${encodeURIComponent(alphaFeatureDir)}&projectKey=${encodeURIComponent(betaKey)}`,
  );
  assert.equal(spoofed.ticketsProjectKey, ALPHA_KEY, "the key derived from the resolved project wins");
  assert.ok(!ids(spoofed).includes("BE-1"), "another project's tickets must not leak through the parameter");
});

test("a raw store project_key supplied as projectKey resolves to nothing", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(BETA_KEY)}`);
  assert.deepEqual(body.tickets, [], "a store key the dashboard's registry does not know is not a selection");
  assert.equal(body.ticketsProjectKey, null);
});

test("beta reports its imported shadow as NOT authoritative", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await dashboardKeyFor(betaDir))}`);
  assert.equal(body.ticketsStorageMode, "markdown", "no mode row means the project has not cut over yet");
  assert.equal(body.ticketsProjectKey, BETA_KEY);
});

// ── the two shapes of "no tickets" stay distinguishable ──────────────────────

test("registered project with an empty board: no tickets, but a project_key and its notes", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await dashboardKeyFor(gammaDir))}`);
  assert.deepEqual(body.tickets, []);
  assert.equal(body.ticketsProjectKey, GAMMA_KEY, "an empty board still knows which project it is");
  assert.match(body.notes, /gamma notes/, "notes are operational context and survive an empty board");
  assert.ok(!ids(body).includes("GA-900"), "an empty board never falls back to branch-local markdown");
});

test("unregistered repository has NO ticket truth — null key, empty list, notes retained", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(deltaDir)}`);
  assert.deepEqual(body.tickets, [], "a repository that was never imported has no ticket truth");
  assert.equal(body.ticketsProjectKey, null, "and says so, rather than looking like an empty board");
  assert.equal(body.ticketsStorageMode, null);
  assert.match(body.notes, /delta notes/, "session-handoff notes remain even with no ticket truth");
  assert.equal(body.ticketsError, undefined, "no ticket truth is an answer, not a failure");
});

test("a directory that resolves to no project at all: empty payload, still 200", async () => {
  const unregistered = mkdtempSync(join(tmpdir(), "fg608-unregistered-"));
  const body = await getBacklog(`?projectDir=${encodeURIComponent(unregistered)}`);
  assert.deepEqual(body.tickets, []);
  assert.equal(body.ticketsProjectKey, null);
});

test("notes stay per-selection: multi-checkout for a key, session-specific for a checkout", async () => {
  const byKey = await getBacklog(`?projectKey=${encodeURIComponent(await dashboardKeyFor(alphaMainDir))}`);
  const dirs = new Set(byKey.notesByCheckout.map((n) => n.checkoutDir));
  assert.ok(dirs.has(alphaMainDir) && dirs.has(alphaFeatureDir), "both checkouts' handoffs are operational context");
  const byDir = await getBacklog(`?projectDir=${encodeURIComponent(alphaFeatureDir)}`);
  assert.match(byDir.notes, /feature notes/, "an exact checkout keeps its own session notes");
});

// ── failure isolation: tickets fail, notes still answer ─────────────────────
//
// LAST test in the file: it repoints FORGE_HOME at a store whose ticket tables
// do not exist. The project registry is refreshed immediately before the swap so
// the resolution half of the request is served from the (30s) project cache and
// the ONLY thing the swap changes is which store the ticket read opens.

test("a ticket-read failure populates ticketsError and still returns notes with 200", async () => {
  await fetch(`${BASE}/api/projects`);
  process.env.FORGE_HOME = brokenHome;
  try {
    const body = await getBacklog(`?projectDir=${encodeURIComponent(alphaMainDir)}`);
    assert.ok(
      body.ticketsError && /no such table/.test(body.ticketsError),
      `expected the store failure to be named in ticketsError, got: ${JSON.stringify(body.ticketsError)}`,
    );
    assert.deepEqual(body.tickets, [], "a failed read yields no tickets rather than a wrong list");
    assert.equal(body.ticketsProjectKey, null, "a failed read never claims a project_key it did not read");
    assert.match(body.notes, /main notes/, "the notes half of the payload is independent of the ticket half");
  } finally {
    process.env.FORGE_HOME = forgeHome;
  }
});
