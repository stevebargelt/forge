// FG-608 (FG-496 Slice C) — the WRITER/READER contract: GET /api/backlog serves
// rows that `forge backlog migrate` actually wrote.
//
// Why this exists next to fg608-backlog-db-truth.integration.test.ts: that file
// (and routes-backlog-canonical-source) seeds the store by hand — `SCHEMA_SQL`
// then `INSERT INTO project_identity / ticket_storage_mode / tickets /
// ticket_relations / blocker_evidence`. It proves the dashboard reads what the
// TEST wrote. It cannot prove the dashboard reads what the CUTOVER wrote, and
// the string `migrate` appears nowhere under dashboard/.
//
// That gap is not theoretical. The dashboard's reader hardcodes column names and
// one magic value — `LEGACY_BLOCKED_SOURCE = "import-legacy-blocked"`
// (dashboard/src/queries.ts:956), whose only other definition is
// src/store/tickets.ts:404, on the far side of a module boundary the dashboard
// deliberately does not import. Legacy `blocked` is stored as active + a
// blocker_evidence row and reconstructed on the way out, so if the importer ever
// writes a different source string the dashboard renders an unblocked-looking
// board that `forge backlog list` disagrees with — and BOTH existing suites stay
// green, because each writes the string it reads.
//
// So here nothing is hand-seeded: a real git repository with real `backlog/*.md`
// is cut over by the real `forge backlog migrate` child process, and the real
// HTTP server answers from whatever that produced. The only INSERTs are the run
// rows that make the checkouts visible to project resolution — the dashboard's
// own input, not ticket truth.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Server } from "node:http";
import {
  authorityTestkitEnv,
  withAuthorityTestkit,
} from "../../src/backlog/container-authority.testkit-spawn.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");
const LOCAL_TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSX = existsSync(LOCAL_TSX) ? LOCAL_TSX : "tsx";

const TEST_PORT = 18781;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "fg608-migrate-dash-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

/** The real CLI, in a real child process, against this test's private store. */
function forge(projectDir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(TSX, withAuthorityTestkit(CLI_ENTRY, args), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: forgeHome,
      FORGE_DB_PATH: join(forgeHome, "forge.db"),
      ...authorityTestkitEnv(),
    },
  });
  assert.equal(res.status, 0, `forge ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function ticketFile(fm: Record<string, string>, body: string): string {
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${front}\n---\n\n${body}\n`;
}

// One repository, two checkouts, shared origin — so project resolution collapses
// them into ONE project and both must answer with the same host-wide truth.
const REMOTE = "git@github.com:stevebargelt/fg608-migrated.git";

function makeCheckout(name: string, branch: string, notes: string): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir);
  git(dir, ["init", "-b", branch]);
  git(dir, ["remote", "add", "origin", REMOTE]);
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  writeFileSync(join(dir, "backlog", "notes.md"), notes);
  return dir;
}

const canonicalDir = makeCheckout("migrated-main", "main", "# Main handoff\n\nmain notes.\n");
const featureDir = makeCheckout("migrated-feature", "feature-x", "# Feature handoff\n\nfeature notes.\n");

// The Markdown that gets cut over. Every FG-608 ticket shape the dashboard
// reader reconstructs is represented: epic association, a `related` list, a
// legacy `blocked` status, and a closed ticket with its commit.
const STORIES: Array<[string, Record<string, string>, string]> = [
  ["FG-E", { id: "FG-E", type: "epic", status: "active", title: '"The epic"' }, "epic body"],
  ["FG-1", { id: "FG-1", type: "story", status: "active", title: '"Alpha"', epic: "FG-E" }, "alpha body"],
  [
    "FG-2",
    { id: "FG-2", type: "story", status: "blocked", title: '"Bravo blocked"', related: "[FG-1]" },
    "bravo body",
  ],
  [
    "FG-3",
    { id: "FG-3", type: "story", status: "done", title: '"Charlie done"', closed: "2026-07-02", closed_commit: "abc1234" },
    "charlie body",
  ],
];

// Present in the FEATURE checkout only, and never migrated. After the cutover
// this is a branch-local file that the dashboard must never render — the exact
// stale-truth failure the canonical-checkout resolution was deleted to prevent.
const BRANCH_LOCAL_ID = "FG-BRANCHLOCAL";

let migratedKey = "";
let server: Server | undefined;

before(async () => {
  for (const [id, fm, body] of STORIES) {
    writeFileSync(join(canonicalDir, "backlog", "stories", `${id}-slug.md`), ticketFile(fm, body));
  }
  writeFileSync(
    join(featureDir, "backlog", "stories", `${BRANCH_LOCAL_ID}-slug.md`),
    ticketFile(
      { id: BRANCH_LOCAL_ID, type: "story", status: "active", title: '"Branch local only"' },
      "branch-local body",
    ),
  );

  // THE CUTOVER — the real verb, not a fixture. It creates the store, mints the
  // project_key, imports, validates and flips.
  const migrated = JSON.parse(forge(canonicalDir, ["backlog", "migrate", "--json"]).stdout) as {
    projectKey: string;
    modeAfter: string;
    dbTicketCount: number;
  };
  assert.equal(migrated.modeAfter, "db", "the fixture depends on a completed cutover");
  assert.equal(migrated.dbTicketCount, STORIES.length);
  migratedKey = migrated.projectKey;

  // The dashboard learns which checkouts exist from run rows. This is the only
  // hand-written state in the file, and it is not ticket truth.
  const database = new Database(join(forgeHome, "forge.db"));
  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertTask = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  [canonicalDir, featureDir].forEach((projectDir, index) => {
    const at = `2026-07-${20 + index}T10:00:00Z`;
    insertRun.run(`run-${index}`, "feature", `Run ${index}`, "complete", at, projectDir);
    insertTask.run(`done-${index}`, `run-${index}`, "engineer", "engineer", "complete", at, at, at);
  });
  database.close();

  ({ server } = await import("./server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (attempt === 74) throw new Error("dashboard test server did not start");
      await new Promise((r) => setTimeout(r, 40));
    }
  }
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

type Ticket = {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  epic?: string;
  closed?: string;
  closedCommit?: string;
  related?: string[];
};
type BacklogBody = {
  tickets: Ticket[];
  ticketsProjectKey: string | null;
  ticketsStorageMode: string | null;
  ticketsError?: string;
  notes: string;
  notesByCheckout: Array<{ checkoutDir: string; notes: string }>;
};

async function backlogFor(query: string): Promise<BacklogBody> {
  const res = await fetch(`${BASE}/api/backlog?${query}`);
  assert.equal(res.status, 200);
  return (await res.json()) as BacklogBody;
}

const byId = (body: BacklogBody, id: string): Ticket | undefined => body.tickets.find((t) => t.id === id);

test("FG-608: the dashboard reports the project_key and db mode that migrate actually wrote", async () => {
  const body = await backlogFor(`projectDir=${encodeURIComponent(canonicalDir)}`);
  assert.equal(body.ticketsProjectKey, migratedKey, "the key the dashboard reports is the one migrate minted");
  assert.equal(body.ticketsStorageMode, "db", "the dashboard sees the flipped mode");
  assert.deepEqual(
    body.tickets.map((t) => t.id).sort(),
    ["FG-1", "FG-2", "FG-3", "FG-E"],
    "every migrated ticket is served",
  );
});

test("FG-608: every migrated ticket FIELD survives the writer/reader boundary", async () => {
  const body = await backlogFor(`projectDir=${encodeURIComponent(canonicalDir)}`);

  const alpha = byId(body, "FG-1");
  assert.ok(alpha, "FG-1 is served");
  assert.equal(alpha.title, "Alpha");
  assert.equal(alpha.body.trim(), "alpha body");
  assert.equal(alpha.type, "story");
  assert.equal(alpha.epic, "FG-E", "epic association survives the cutover");

  const done = byId(body, "FG-3");
  assert.ok(done);
  assert.equal(done.status, "done");
  assert.equal(done.closed, "2026-07-02", "the close date survives");
  assert.equal(done.closedCommit, "abc1234", "the close commit survives");
});

// The magic-string contract. `blocked` is not a DB status: the importer stores
// active + a blocker_evidence row tagged with a source string, and the dashboard
// reconstructs it by matching that string. Two independent copies of one
// literal, no shared import — so this assertion is the only thing standing
// between a drift in either copy and a silently unblocked board.
test("FG-608: a legacy `blocked` Markdown ticket is reconstructed as blocked from real import evidence", async () => {
  const body = await backlogFor(`projectDir=${encodeURIComponent(canonicalDir)}`);
  const blocked = byId(body, "FG-2");
  assert.ok(blocked, "FG-2 is served");
  assert.equal(
    blocked.status,
    "blocked",
    "the dashboard's LEGACY_BLOCKED_SOURCE must match the source the real importer writes",
  );
  assert.deepEqual(blocked.related, ["FG-1"], "the `related` list survives as ticket_relations");

  // And the store really does hold it as `active` — otherwise this test would
  // pass for the boring reason that nothing was reconstructed at all.
  const database = new Database(join(forgeHome, "forge.db"), { readonly: true });
  const row = database
    .prepare("SELECT status FROM tickets WHERE project_key = ? AND ticket_id = ?")
    .get(migratedKey, "FG-2") as { status: string };
  database.close();
  assert.equal(row.status, "active", "the DB stores it as active — `blocked` is reconstructed, not stored");
});

test("FG-608: a feature checkout of the migrated repository answers identically", async () => {
  const canonical = await backlogFor(`projectDir=${encodeURIComponent(canonicalDir)}`);
  const feature = await backlogFor(`projectDir=${encodeURIComponent(featureDir)}`);

  assert.equal(feature.ticketsProjectKey, migratedKey);
  assert.equal(feature.ticketsStorageMode, "db");
  assert.deepEqual(
    feature.tickets.map((t) => t.id).sort(),
    canonical.tickets.map((t) => t.id).sort(),
    "branch-local files no longer determine truth",
  );

  // The feature checkout's OWN ticket file is never rendered, even though it is
  // the only checkout that has it.
  assert.ok(existsSync(join(featureDir, "backlog", "stories", `${BRANCH_LOCAL_ID}-slug.md`)));
  assert.equal(byId(feature, BRANCH_LOCAL_ID), undefined, "a branch-local ticket file is not ticket truth");

  // Notes stay per-checkout (FG-380) — the half of the payload that is still
  // legitimately filesystem-sourced.
  assert.match(feature.notes, /feature notes/);
  assert.match(canonical.notes, /main notes/);
});

test("FG-608: after cutover the dashboard follows DB edits and ignores frozen Markdown edits", async () => {
  const path = join(canonicalDir, "backlog", "stories", "FG-1-slug.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("alpha body", "EDIT IN FROZEN MARKDOWN"));
  const afterMarkdownEdit = await backlogFor(`projectDir=${encodeURIComponent(canonicalDir)}`);
  assert.equal(
    byId(afterMarkdownEdit, "FG-1")?.body.trim(),
    "alpha body",
    "an edit to the frozen file never reaches the board",
  );

  // A real authoritative edit, through the real CLI, IS reflected — the board
  // follows the store on the next poll rather than a cached snapshot.
  forge(canonicalDir, ["backlog", "edit", "FG-1", "--body", "EDIT IN THE DB"]);
  const afterDbEdit = await backlogFor(`projectDir=${encodeURIComponent(canonicalDir)}`);
  assert.equal(byId(afterDbEdit, "FG-1")?.body.trim(), "EDIT IN THE DB");
});
