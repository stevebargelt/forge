// Regression tests for GET /api/backlog canonical ticket-source resolution —
// the two contract clauses the main-only suite leaves uncovered:
//
//   1. The canonical checkout may be on `master`, not only `main`. The server
//      accepts EITHER as the primary branch; a fix that hard-codes "main" would
//      silently drop every master-repo's backlog. This proves master is honored
//      for BOTH a canonical projectKey request and an exact projectDir request
//      that lands on a feature checkout of a master repo.
//
//   2. "No main/master checkout means no ticket truth." A canonical repository
//      whose only existing checkout is a feature branch (nothing on main/master)
//      must return ZERO tickets — for both request shapes — while still keeping
//      its session-handoff NOTES (operational context is orthogonal to ticket
//      truth). A regression that fell back to reading a feature checkout's
//      branch-local ticket files would fail here.
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

// ── Repo B: canonical repository with NO main/master checkout at all ────────
const B_REMOTE = "git@github.com:stevebargelt/repo-branch-only.git";
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

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertTask = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  [masterDir, masterFeatureDir, branchOnlyDir].forEach((projectDir, index) => {
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

// Resolve the canonical project key for the repo that owns `dir`, without
// assuming a single-project registry (this file registers two repos).
async function keyForCheckout(dir: string): Promise<string> {
  const res = await fetch(`${BASE}/api/projects`);
  const projects = (await res.json()) as Array<{ key: string; projectDirs: string[] }>;
  const owner = projects.find((p) => p.projectDirs.includes(dir));
  assert.ok(owner, `no canonical project resolved for ${dir}`);
  return owner!.key;
}

// ── master is honored as a primary branch ───────────────────────────────────

test("canonical projectKey: tickets come from the master checkout when there is no main", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await keyForCheckout(masterDir))}`);
  const ids = body.tickets.map((t) => t["id"]).sort();
  assert.deepEqual(ids, ["MA-100", "MA-101"], "ticket ids must be exactly the master inventory");
  for (const t of body.tickets) {
    assert.equal(t["checkoutDir"], masterDir, "every ticket must originate from the master checkout");
    assert.equal(t["checkoutBranch"], "master", "every ticket must be tagged with the master branch");
  }
  assert.ok(!body.tickets.some((t) => t["id"] === "MA-200"), "feature-only MA-200 must be excluded");
});

test("exact projectDir on a feature checkout of a master repo still sources tickets from master", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(masterFeatureDir)}`);
  const ids = body.tickets.map((t) => t["id"]).sort();
  assert.deepEqual(
    ids,
    ["MA-100", "MA-101"],
    "an exact feature-checkout request must resolve to the canonical master inventory",
  );
  for (const t of body.tickets) {
    assert.equal(t["checkoutDir"], masterDir, "tickets must originate from the master checkout, not the feature dir");
    assert.equal(t["checkoutBranch"], "master");
  }
  assert.ok(!body.tickets.some((t) => t["id"] === "MA-200"), "feature-only MA-200 must stay excluded");
});

// ── no main/master checkout means no ticket truth ───────────────────────────

test("canonical projectKey with no main/master checkout: zero tickets, notes retained", async () => {
  const body = await getBacklog(`?projectKey=${encodeURIComponent(await keyForCheckout(branchOnlyDir))}`);
  assert.deepEqual(body.tickets, [], "a repo with no main/master checkout has no backlog truth");
  assert.match(body.notes, /no main checkout exists/, "session-handoff notes remain even with no ticket truth");
});

test("exact projectDir on a branch-only repo: zero tickets, its own notes retained", async () => {
  const body = await getBacklog(`?projectDir=${encodeURIComponent(branchOnlyDir)}`);
  assert.deepEqual(
    body.tickets,
    [],
    "selecting the sole feature checkout must NOT fall back to its branch-local ticket files",
  );
  assert.ok(!body.tickets.some((t) => t["id"] === "BO-100"), "branch-local BO-100 must never surface as truth");
  assert.match(body.notes, /no main checkout exists/, "exact-checkout handoff notes stay session-specific");
});
