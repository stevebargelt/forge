// Regression tests for GET /api/backlog ticket-source resolution — the anchor
// for the contract FG-608 replaced.
//
// This file used to encode the branch-local rule in TWO clauses:
//
//   1. "The canonical checkout may be on `master`, not only `main`" — a
//      primary-branch parity clause, guarding a fix that hard-coded "main".
//   2. "No main/master checkout means no ticket truth" — a canonical repository
//      whose only checkout is a feature branch returned ZERO tickets, with no
//      fallback to that checkout's branch-local ticket files.
//
// Under host-wide DB truth BOTH clauses are re-decided, deliberately:
//
//   1. becomes VACUOUS AS WRITTEN and is replaced by its stronger form: the
//      primary-branch concept is gone entirely. `master`, `main` and a feature
//      branch are indistinguishable to ticket resolution, because no branch (and
//      no checkout) participates in it. A regression that reintroduced ANY
//      branch preference would fail here — the branch-only repository below
//      would lose its tickets.
//   2. keeps its NAME and changes its BASIS. "This project has no ticket truth"
//      still needs a defined answer, and it is now "no project_key is registered
//      for this repository's evidence" — never imported. That answer is an empty
//      ticket list with ticketsProjectKey: null, session-handoff notes retained,
//      and STILL no fallback to branch-local ticket files. The surviving half of
//      the old clause is exactly that no-fallback guarantee.
//
// Harness mirrors routes-backlog-main-only.integration.test.ts: real git
// checkouts, collapsed to canonical projects by shared origin, registered via DB
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

const TEST_PORT = 18772;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-backlog-canon-src-"));
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
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function ticket(type: string, id: string, title: string, status = "active"): string {
  return `---\nid: ${id}\ntype: ${type}\nstatus: ${status}\ntitle: ${title}\n---\n${title} body.\n`;
}

function makeCheckout(
  name: string,
  branch: string,
  remote: string,
  tickets: Array<{ dir: string; file: string; content: string }>,
  notes: string,
): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir);
  git(dir, ["init", "-b", branch]);
  git(dir, ["remote", "add", "origin", remote]);
  mkdirSync(join(dir, "backlog", "epics"), { recursive: true });
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  mkdirSync(join(dir, "backlog", "ideas"), { recursive: true });
  for (const t of tickets) writeFileSync(join(dir, "backlog", t.dir, t.file), t.content);
  writeFileSync(join(dir, "backlog", "notes.md"), notes);
  return dir;
}

// ── Repo A: canonical primary checkout is on `master` (not `main`) ──────────
const A_REMOTE = "git@github.com:stevebargelt/repo-master.git";
const A_KEY = "pk-repo-master";
const masterDir = makeCheckout(
  "repo-master",
  "master",
  A_REMOTE,
  [
    { dir: "epics", file: "MA-100-epic.md", content: ticket("epic", "MA-100", "Master Epic") },
    { dir: "stories", file: "MA-101-story.md", content: ticket("story", "MA-101", "Master Story") },
  ],
  "# Master handoff\n\nmaster branch notes.\n",
);
const masterFeatureDir = makeCheckout(
  "repo-master-feature",
  "feature-a",
  A_REMOTE,
  [
    { dir: "stories", file: "MA-101-story.md", content: ticket("story", "MA-101", "Feature copy") },
    { dir: "stories", file: "MA-200-story.md", content: ticket("story", "MA-200", "Feature-only story") },
  ],
  "# Master-repo feature handoff\n\nfeature-a notes.\n",
);

// ── Repo B: registered project with NO main/master checkout at all ──────────
// The old clause 2 returned nothing for this repository. Under host-wide truth
// it has a full inventory: the branch it happens to be sitting on is irrelevant.
const B_REMOTE = "git@github.com:stevebargelt/repo-branch-only.git";
const B_KEY = "pk-repo-branch-only";
const branchOnlyDir = makeCheckout(
  "repo-branch-only",
  "feature-b",
  B_REMOTE,
  [
    { dir: "stories", file: "BO-100-story.md", content: ticket("story", "BO-100", "Branch-only story") },
    { dir: "epics", file: "BO-101-epic.md", content: ticket("epic", "BO-101", "Branch-only epic") },
  ],
  "# Branch-only handoff\n\nno main checkout exists for this repo.\n",
);

// ── Repo C: never imported — the new basis for "no ticket truth" ────────────
const C_REMOTE = "git@github.com:stevebargelt/repo-unimported.git";
const unimportedDir = makeCheckout(
  "repo-unimported",
  "main",
  C_REMOTE,
  [
    { dir: "stories", file: "UN-100-story.md", content: ticket("story", "UN-100", "Unimported story") },
  ],
  "# Unimported handoff\n\nthis repo has never been imported.\n",
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
  [masterDir, masterFeatureDir, branchOnlyDir, unimportedDir].forEach((projectDir, index) => {
    const runId = `run-${index}`;
    const createdAt = `2026-07-${15 + index}T10:00:00Z`;
    insertRun.run(runId, "feature", `Run ${index}`, "complete", createdAt, projectDir);
    insertTask.run(`done-${index}`, runId, "engineer", "engineer", "complete", createdAt, createdAt, createdAt);
  });

  const insertIdentity = database.prepare(
    "INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)",
  );
  insertIdentity.run(A_KEY, repositoryCheckoutIdentity(masterDir).key, "remote", "2026-07-20T10:00:00Z");
  insertIdentity.run(B_KEY, repositoryCheckoutIdentity(branchOnlyDir).key, "remote", "2026-07-20T10:00:00Z");
  // repo C deliberately absent from the registry.

  const insertMode = database.prepare(
    "INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)",
  );
  insertMode.run(A_KEY, "db", "2026-07-20T10:00:00Z");
  insertMode.run(B_KEY, "db", "2026-07-20T10:00:00Z");

  const insertTicket = database.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,NULL)`,
  );
  const at = "2026-07-20T10:00:00Z";
  insertTicket.run(A_KEY, "MA-100", "epic", "active", "Master Epic", "Epic body.", at);
  insertTicket.run(A_KEY, "MA-101", "story", "active", "Master Story", "Story body.", at);
  // Store ids deliberately DISJOINT from repo B's markdown ids, so a response
  // naming BO-100/BO-101 could only have come from branch-local files.
  insertTicket.run(B_KEY, "BO-500", "story", "active", "Branch-only store story", "Story body.", at);
  insertTicket.run(B_KEY, "BO-501", "epic", "active", "Branch-only store epic", "Epic body.", at);
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

// Resolve the canonical project key for the repo that owns `dir`, without
// assuming a single-project registry (this file registers three repos).
async function keyForCheckout(dir: string): Promise<string> {
  const res = await fetch(`${BASE}/api/projects`);
  const projects = (await res.json()) as Array<{ key: string; projectDirs: string[] }>;
  const owner = projects.find((p) => p.projectDirs.includes(dir));
  assert.ok(owner, `no canonical project resolved for ${dir}`);
  return owner!.key;
}

// ── clause 1, in its stronger form: no branch participates in resolution ────

test("canonical projectKey: a master-primary repo answers from the store", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await keyForCheckout(masterDir))}`);
  const ids = body.tickets.map((t) => t["id"]).sort();
  assert.deepEqual(ids, ["MA-100", "MA-101"], "ticket ids must be exactly the store inventory");
  assert.equal(body.ticketsProjectKey, A_KEY);
  assert.ok(!body.tickets.some((t) => t["id"] === "MA-200"), "the feature checkout's markdown-only id must be excluded");
});

test("exact projectDir on a feature checkout of a master repo returns the identical set", async () => {
  const canonical = await getBacklog(`?projectKey=${encodeURIComponent(await keyForCheckout(masterDir))}`);
  const feature = await getBacklog(`?projectDir=${encodeURIComponent(masterFeatureDir)}`);
  assert.deepEqual(
    feature.tickets.map((t) => t["id"]).sort(),
    canonical.tickets.map((t) => t["id"]).sort(),
    "an exact feature-checkout request resolves to the same project_key, not to a redirected checkout",
  );
  assert.equal(feature.ticketsProjectKey, A_KEY);
});

test("a repository with NO main/master checkout still has full ticket truth", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await keyForCheckout(branchOnlyDir))}`);
  assert.deepEqual(
    body.tickets.map((t) => t["id"]).sort(),
    ["BO-500", "BO-501"],
    "the primary-branch concept is gone — a branch-only repo is a registered project like any other",
  );
  assert.equal(body.ticketsProjectKey, B_KEY);
});

test("a branch-only repository never falls back to its branch-local ticket files", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(branchOnlyDir)}`);
  const ids = body.tickets.map((t) => t["id"]);
  assert.ok(!ids.includes("BO-100"), "branch-local BO-100 must never surface as truth");
  assert.ok(!ids.includes("BO-101"), "branch-local BO-101 must never surface as truth");
  assert.deepEqual(ids.sort(), ["BO-500", "BO-501"], "only the store's rows are truth");
});

// ── clause 2, re-based: no registered project_key means no ticket truth ─────

test("never-imported repository: zero tickets, null project key, notes retained", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await keyForCheckout(unimportedDir))}`);
  assert.deepEqual(body.tickets, [], "a repository with no registered project_key has no backlog truth");
  assert.equal(body.ticketsProjectKey, null, "and names that state rather than looking like an empty board");
  assert.equal(body.ticketsStorageMode, null);
  assert.match(body.notes, /never been imported/, "session-handoff notes remain even with no ticket truth");
});

test("exact projectDir on a never-imported repo: still no fallback to its files", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(unimportedDir)}`);
  assert.deepEqual(
    body.tickets,
    [],
    "selecting the checkout directly must NOT fall back to its branch-local ticket files",
  );
  assert.ok(!body.tickets.some((t) => t["id"] === "UN-100"), "UN-100 exists only as markdown and is never truth");
  assert.match(body.notes, /never been imported/, "exact-checkout handoff notes stay session-specific");
});
