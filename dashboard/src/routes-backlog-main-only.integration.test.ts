// Regression tests for GET /api/backlog ticket truth across checkouts.
//
// FG-608 REPLACED the contract this file used to encode. It previously asserted
// that tickets come ONLY from the canonical repository's primary checkout on
// main — a branch-local rule, with feature branches, linked worktrees and clones
// excluded "until merged". Ticket truth is now HOST-WIDE, keyed by project_key:
// every checkout of one repository answers with the SAME store rows, and no
// checkout's `backlog/*.md` is read for tickets at all.
//
// What SURVIVES that flip, and is what this file now guards:
//   - one canonical project answers one ticket inventory; a ticket declared in
//     two checkouts is still counted once, and a ticket that exists only in a
//     feature checkout's files is still not truth (now because files are never
//     truth, not because that branch is unmerged);
//   - session-handoff NOTES remain per-selection — multi-checkout for a
//     canonical key, session-specific for an exact checkout. Operational context
//     (FG-380) stayed per-checkout when ticket truth stopped being.
// What INVERTED: an exact request on a feature checkout used to resolve to the
// main checkout's inventory; it now resolves to the same project_key, so the two
// request shapes agree by construction rather than by redirection.
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
import { repositoryCheckoutIdentity } from "../../src/util/repository-identity.js";

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
const PROJECT_KEY = "pk-main-only";

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

// The markdown checkouts are still built exactly as before — they are now the
// NEGATIVE fixture: whatever they contain, none of it may reach the response.
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
// adds FG-200 which exists ONLY off main (must never be ticket truth).
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

  // Both checkouts share one origin, so they share one evidence key and one
  // project_key — the mechanism that makes the two request shapes agree.
  database
    .prepare("INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)")
    .run(PROJECT_KEY, repositoryCheckoutIdentity(mainDir).key, "remote", "2026-07-20T10:00:00Z");
  database
    .prepare("INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)")
    .run(PROJECT_KEY, "db", "2026-07-20T10:00:00Z");

  const insertTicket = database.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,NULL)`,
  );
  const at = "2026-07-20T10:00:00Z";
  insertTicket.run(PROJECT_KEY, "FG-100", "epic", "active", "Main Epic", "Epic body.", at);
  insertTicket.run(PROJECT_KEY, "FG-101", "story", "active", "Main Story", "Story body.", at);
  insertTicket.run(PROJECT_KEY, "FG-102", "idea", "active", "Main Idea", "Idea body.", at);
  // Exists in NO checkout's files. Its presence proves the response is the
  // store's inventory and not any directory listing.
  insertTicket.run(PROJECT_KEY, "FG-300", "story", "active", "Store-only Story", "Filed after the freeze.", at);
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

test("canonical projectKey: tickets are the project's store inventory", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const ids = body.tickets.map((t) => t["id"]).sort();
  assert.deepEqual(ids, ["FG-100", "FG-101", "FG-102", "FG-300"], "ticket ids must be exactly the store inventory");
  assert.equal(body.ticketsProjectKey, PROJECT_KEY);
  assert.ok(
    body.tickets.some((t) => t["id"] === "FG-300"),
    "a ticket that exists in no checkout's files is still truth — the store answers, not the filesystem",
  );
});

test("canonical projectKey: feature-branch-only ticket files are not truth", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  assert.ok(
    !body.tickets.some((t) => t["id"] === "FG-200"),
    "FG-200 exists only as a feature checkout's markdown file and must not be backlog truth",
  );
});

test("canonical projectKey: Story count is not multiplied across checkouts", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const stories = body.tickets.filter((t) => t["type"] === "story");
  assert.deepEqual(
    stories.map((t) => t["id"]).sort(),
    ["FG-101", "FG-300"],
    "FG-101 is declared in two checkouts but is one store row",
  );
});

test("canonical projectKey: aggregate ticket count differs from the Epic-only count", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const epics = body.tickets.filter((t) => t["type"] === "epic");
  assert.equal(epics.length, 1, "one epic in the fixture");
  assert.equal(body.tickets.length, 4, "All/All aggregate spans every type");
  assert.notEqual(body.tickets.length, epics.length, "aggregate must not equal the Epic group count");
  const types = new Set(body.tickets.map((t) => t["type"]));
  assert.deepEqual([...types].sort(), ["epic", "idea", "story"], "all three types present");
});

test("canonical projectKey: session-handoff notes remain multi-checkout", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await projectKey())}`);
  const dirs = new Set(body.notesByCheckout.map((n) => n.checkoutDir));
  assert.ok(dirs.has(mainDir), "main notes present");
  assert.ok(dirs.has(featureDir), "feature notes preserved as operational context");
  assert.equal(dirs.size, 2, "notes span both checkouts — operational context stayed per-checkout");
});

test("exact projectDir on a feature checkout returns the same host-wide inventory", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(featureDir)}`);
  const ids = body.tickets.map((t) => t["id"]).sort();
  assert.deepEqual(
    ids,
    ["FG-100", "FG-101", "FG-102", "FG-300"],
    "selecting a feature checkout resolves to the project's key, not to its branch-local files",
  );
  assert.ok(
    !body.tickets.some((t) => t["id"] === "FG-200"),
    "the feature checkout's own markdown-only ticket stays excluded",
  );
  assert.equal(body.ticketsProjectKey, PROJECT_KEY, "both request shapes derive the same project_key");
});

test("exact projectDir on a feature checkout keeps that checkout's session-specific notes", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(featureDir)}`);
  assert.match(body.notes, /feature branch notes/, "exact-checkout handoff notes stay session-specific");
});
