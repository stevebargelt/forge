// Regression tests for GET /api/backlog canonical ticket source (dashboard
// main-only fix).
//
// Product contract: for BOTH a canonical projectKey request AND an exact
// projectDir request, backlog TICKETS come ONLY from the canonical repository
// primary checkout on main. Feature branches, linked worktrees, clones, and
// scratch checkouts are NOT backlog truth until merged to main — selecting one
// as an exact projectDir still resolves to the canonical main inventory. Ticket
// files are neither concatenated nor merely deduplicated across checkouts.
// Session-handoff NOTES remain per-selection: multi-checkout for a canonical
// key, session-specific for an exact checkout (operational context, distinct
// from ticket inventory).
//
// Harness mirrors routes-project-identity.integration.test.ts: real git
// checkouts sharing one origin (so they collapse to one canonical project),
// registered via DB run rows, exercised over the real HTTP server.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18771;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-backlog-main-only-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const REMOTE = "git@github.com:stevebargelt/forge.git";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function ticket(type: string, id: string, title: string, status = "active"): string {
  return `---\nid: ${id}\ntype: ${type}\nstatus: ${status}\ntitle: ${title}\n---\n${title} body.\n`;
}

function makeCheckout(
  name: string,
  branch: string,
  tickets: Array<{ dir: string; file: string; content: string }>,
  notes: string,
): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir);
  git(dir, ["init", "-b", branch]);
  git(dir, ["remote", "add", "origin", REMOTE]);
  mkdirSync(join(dir, "backlog", "epics"), { recursive: true });
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  mkdirSync(join(dir, "backlog", "ideas"), { recursive: true });
  for (const t of tickets) writeFileSync(join(dir, "backlog", t.dir, t.file), t.content);
  writeFileSync(join(dir, "backlog", "notes.md"), notes);
  return dir;
}

// main: three ticket TYPES, one of each — the canonical inventory.
const mainDir = makeCheckout(
  "forge",
  "main",
  [
    { dir: "epics", file: "FG-100-epic.md", content: ticket("epic", "FG-100", "Main Epic") },
    { dir: "stories", file: "FG-101-story.md", content: ticket("story", "FG-101", "Main Story") },
    { dir: "ideas", file: "FG-102-idea.md", content: ticket("idea", "FG-102", "Main Idea") },
  ],
  "# Main handoff\n\nmain branch notes.\n",
);

// feature worktree: re-declares FG-101 (must NOT multiply the Story count) and
// adds FG-200 which exists ONLY off main (must be excluded from ticket truth).
const featureDir = makeCheckout(
  "forge-feature",
  "feature-x",
  [
    { dir: "stories", file: "FG-101-story.md", content: ticket("story", "FG-101", "Feature copy of story") },
    { dir: "stories", file: "FG-200-story.md", content: ticket("story", "FG-200", "Feature-only story") },
  ],
  "# Feature handoff\n\nfeature branch notes.\n",
);

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertTask = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  [mainDir, featureDir].forEach((projectDir, index) => {
    const runId = `run-${index}`;
    const createdAt = `2026-07-${15 + index}T10:00:00Z`;
    insertRun.run(runId, "feature", `Run ${index}`, "complete", createdAt, projectDir);
    insertTask.run(`done-${index}`, runId, "engineer", "engineer", "complete", createdAt, createdAt, createdAt);
  });
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
};

async function getBacklog(params: string): Promise<BacklogBody> {
  const res = await fetch(`${BASE}/api/backlog${params}`);
  assert.equal(res.status, 200, `expected 200 for /api/backlog${params}`);
  return res.json() as Promise<BacklogBody>;
}

async function projectKey(): Promise<string> {
  const res = await fetch(`${BASE}/api/projects`);
  const projects = (await res.json()) as Array<{ key: string }>;
  assert.equal(projects.length, 1, "checkouts must collapse to one canonical project");
  return projects[0]!.key;
}

test("canonical projectKey: tickets come ONLY from the main checkout", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const ids = body.tickets.map((t) => t["id"]).sort();
  assert.deepEqual(ids, ["FG-100", "FG-101", "FG-102"], "ticket ids must be exactly the main inventory");
  for (const t of body.tickets) {
    assert.equal(t["checkoutDir"], mainDir, "every ticket must originate from the main checkout");
    assert.equal(t["checkoutBranch"], "main", "every ticket must be tagged with the main branch");
  }
});

test("canonical projectKey: feature-branch-only tickets are excluded", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  assert.ok(
    !body.tickets.some((t) => t["id"] === "FG-200"),
    "FG-200 exists only on a feature branch and must not be backlog truth",
  );
});

test("canonical projectKey: Story count is not multiplied across checkouts", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const stories = body.tickets.filter((t) => t["type"] === "story");
  assert.equal(stories.length, 1, "FG-101 appears in two checkouts but must be counted once");
  assert.equal(stories[0]!["id"], "FG-101");
});

test("canonical projectKey: aggregate ticket count differs from the Epic-only count", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const epics = body.tickets.filter((t) => t["type"] === "epic");
  assert.equal(epics.length, 1, "one epic in the fixture");
  assert.equal(body.tickets.length, 3, "All/All aggregate spans every type");
  assert.notEqual(body.tickets.length, epics.length, "aggregate must not equal the Epic group count");
  const types = new Set(body.tickets.map((t) => t["type"]));
  assert.deepEqual([...types].sort(), ["epic", "idea", "story"], "all three types present once");
});

test("canonical projectKey: session-handoff notes remain multi-checkout", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const dirs = new Set(body.notesByCheckout.map((n) => n.checkoutDir));
  assert.ok(dirs.has(mainDir), "main notes present");
  assert.ok(dirs.has(featureDir), "feature notes preserved as operational context");
  assert.equal(dirs.size, 2, "notes span both checkouts even though tickets do not");
});

test("exact projectDir on a feature checkout still sources tickets ONLY from main", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(featureDir)}`);
  const ids = body.tickets.map((t) => t["id"]).sort();
  assert.deepEqual(
    ids,
    ["FG-100", "FG-101", "FG-102"],
    "selecting a feature checkout must resolve to the canonical main inventory, not its branch-local files",
  );
  assert.ok(
    !body.tickets.some((t) => t["id"] === "FG-200"),
    "feature-branch-only FG-200 must stay excluded even for an exact feature-checkout request",
  );
  for (const t of body.tickets) {
    assert.equal(t["checkoutDir"], mainDir, "every ticket must originate from the main checkout");
    assert.equal(t["checkoutBranch"], "main", "every ticket must be tagged with the main branch");
  }
});

test("exact projectDir on a feature checkout keeps that checkout's session-specific notes", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(featureDir)}`);
  assert.match(body.notes, /feature branch notes/, "exact-checkout handoff notes stay session-specific");
});
