// FG-781 AC3 — a remote projection scoped to project A leaks NO identifier, count, title,
// path, activity, or payload from a sibling project B, and it pins STRICTLY to A's own member
// dirs — deliberately diverging from resolveProjectScope's FG-745 owner-convergence widening.
//
// THE SIBLING CASE (FG-745). B is a separately-identified artifact (a private, no-remote local
// clone) that is OWNED by A via workspace_purposes.project_identity. resolveProjectScope(A)
// therefore WIDENS to include B's member dir — correct for the local operator board, WRONG for
// the remote board. This test proves the divergence is real and load-bearing:
//   - the STRICT board (memberDirs = A's own dirs) shows ZERO B data;
//   - a WIDENED board (memberDirs = resolveProjectScope(A), which includes B's dir) DOES show
//     B's activity/campaign — so the seed is genuinely cross-scope and the strict pinning is
//     exactly what excludes it, never a vacuous "B was never there" pass.
//
// Integration tier: seeds a real on-disk forge.db under a temp FORGE_HOME and reads it back
// through the same handles the production assembler uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FORGE_HOME must be set BEFORE any import that transitively evaluates src/util/paths.ts.
const root = mkdtempSync(join(tmpdir(), "fg781-projection-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { getDb } = await import("../../../src/store/db.js");
const { insertRun } = await import("../../../src/store/runs.js");
const { createCampaign, addCampaignItem, updateCampaignItem, updateCampaignStatus } = await import(
  "../../../src/store/campaigns.js"
);
const { repositoryCheckoutIdentity } = await import("../../../src/util/repository-identity.js");
const { projectsForDashboard, resolveProjectScope } = await import("../queries.js");
const { assembleRemoteBoard } = await import("./projection.js");

// ─── fixtures ────────────────────────────────────────────────────────────────

const trees = join(root, "trees");
mkdirSync(trees, { recursive: true });

function checkout(name: string, remote?: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

// A = the granted project the operator selects (has a remote → a stable repo identity).
// B = a private no-remote clone, its OWN repo identity, recorded as OWNED by A.
const ownerDir = checkout("alpha", "git@github.com:stevebargelt/fg781-alpha.git");
const artifactDir = checkout("bravo"); // no remote

const REPO_OWNER = repositoryCheckoutIdentity(ownerDir).key;
const REPO_ARTIFACT = repositoryCheckoutIdentity(artifactDir).key;
const PK_OWNER = "pk-fg781-alpha";
const PK_ARTIFACT = "pk-fg781-bravo";

assert.notEqual(REPO_ARTIFACT, REPO_OWNER, "fixture: the sibling's repo identity must NOT converge with A's");

const AT = "2026-09-01T10:00:00Z";

// Distinctive B markers — if ANY appears in A's projection, that is a cross-scope leak.
const B_TICKET = "FG-BBB";
const B_TITLE = "Bravo-secret-ticket";
const B_RUN = "run-bravo-live";
const B_TASK = "task-bravo-live";
const B_RUN_TITLE = "BRAVO-artifact-run";
const B_GOAL = "GOALBRAVO-leak-me";

const store = getDb(); // read-write open bootstraps SCHEMA_SQL + migrations

// A's identity + ticket truth.
store
  .prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,'remote',?)`,
  )
  .run(PK_OWNER, REPO_OWNER, AT);
// B's OWN identity + ticket truth (so B has tickets under a distinct project_key).
store
  .prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,'remote',?)`,
  )
  .run(PK_ARTIFACT, REPO_ARTIFACT, AT);

const storageMode = store.prepare(`INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)`);
storageMode.run(PK_OWNER, "db", AT);
storageMode.run(PK_ARTIFACT, "db", AT);

// The owner-convergence link: artifactDir is a disposable clone OWNED by A. This is what makes
// resolveProjectScope(REPO_OWNER) widen to include artifactDir.
store
  .prepare(
    `INSERT INTO workspace_purposes (path, path_as_written, kind, project_identity, run_id, task_id, reason, source, created_at, updated_at)
     VALUES (?, ?, 'disposable_clone', ?, ?, NULL, NULL, 'creation', ?, ?)`,
  )
  .run(artifactDir, artifactDir, PK_OWNER, B_RUN, AT, AT);

const insertTicket = store.prepare(
  `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
   VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,NULL)`,
);
insertTicket.run(PK_OWNER, "FG-AAA", "epic", "active", "Alpha epic", "Alpha epic body.", null, AT);
insertTicket.run(PK_OWNER, "FG-AAB", "story", "active", "Alpha story", "Alpha story body.", "FG-AAA", AT);
insertTicket.run(PK_ARTIFACT, B_TICKET, "story", "active", B_TITLE, "Bravo body.", null, AT);

// Live work: A under ownerDir, B under artifactDir.
insertRun({ id: "run-alpha-live", workflow: "feature", title: "Alpha run", status: "active", createdAt: AT, projectDir: ownerDir });
insertRun({ id: B_RUN, workflow: "feature", title: B_RUN_TITLE, status: "active", createdAt: AT, projectDir: artifactDir });

const runningTask = store.prepare(
  `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at)
   VALUES (?, ?, 'build', 'engineer', 'running', '{}', ?, ?)`,
);
runningTask.run("task-alpha-live", "run-alpha-live", AT, AT);
runningTask.run(B_TASK, B_RUN, AT, AT);

// Campaigns: A against ownerDir, B against artifactDir (memberDir-scoped in the projection).
const alpha = createCampaign({
  sourceKind: "epic",
  sourceInput: { epicId: "FG-AAA" },
  mode: "serial",
  metadata: { goal: "GOALALPHA-ship-alpha" },
  projectDir: ownerDir,
});
updateCampaignStatus(alpha.id, "running");
const alphaItem = addCampaignItem({ campaignId: alpha.id, itemOrder: 0, ticketId: "FG-AAB" });
updateCampaignItem(alphaItem.id, { lifecycleStatus: "running", runId: "run-alpha-live" });

const bravo = createCampaign({
  sourceKind: "epic",
  sourceInput: { epicId: B_TICKET },
  mode: "serial",
  metadata: { goal: B_GOAL },
  projectDir: artifactDir,
});
updateCampaignStatus(bravo.id, "running");
addCampaignItem({ campaignId: bravo.id, itemOrder: 0, ticketId: B_TICKET });

// ─── the granted project ─────────────────────────────────────────────────────

function grantedProjectA() {
  const project = projectsForDashboard().find((p) => p.key === REPO_OWNER);
  assert.ok(project, "fixture: the granted project A must resolve from the dashboard registry");
  return project!;
}

const B_MARKERS = [B_TICKET, B_TITLE, B_RUN, B_TASK, B_RUN_TITLE, B_GOAL, artifactDir];

// ─── tests ────────────────────────────────────────────────────────────────────

test("fixture: A's OWN member dirs exclude the sibling, but resolveProjectScope widens to include it", () => {
  const project = grantedProjectA();
  assert.ok(project.projectDirs.includes(ownerDir), "A's member dirs contain its own checkout");
  assert.ok(
    !project.projectDirs.includes(artifactDir),
    "A's OWN member dirs must NOT contain the separately-identified sibling",
  );
  const widened = resolveProjectScope(REPO_OWNER);
  assert.ok(Array.isArray(widened), "an owner key resolves to a member-path array");
  assert.ok(
    (widened as string[]).includes(artifactDir),
    "FG-745: resolveProjectScope WIDENS the owner key to the owned sibling — this is what the remote board must NOT do",
  );
});

test("AC3: a projection scoped to A leaks no identifier, title, path, activity, or payload from B", () => {
  const project = grantedProjectA();
  const env = assembleRemoteBoard({ project, memberDirs: project.projectDirs }, { nowMs: Date.parse(AT) });

  assert.equal(env.state, "live", "a fresh authorized read is live");
  assert.equal(env.generation, Date.parse(AT), "the freshness stamp is the read clock");
  assert.ok(env.board, "a live envelope carries the board");

  const serialized = JSON.stringify(env);

  // Non-vacuous: A's own data IS present.
  for (const marker of ["FG-AAA", "FG-AAB", "Alpha", "GOALALPHA-ship-alpha", "run-alpha-live", "task-alpha-live"]) {
    assert.ok(serialized.includes(marker), `A's own data must be present — missing ${marker}`);
  }

  // The leak assertion: NOTHING from B, and no host path at all.
  for (const marker of B_MARKERS) {
    assert.ok(!serialized.includes(marker), `AC3 leak: a B marker crossed into A's projection — ${marker}`);
  }
  assert.ok(!serialized.includes(ownerDir), "no host filesystem path (not even A's own) is present in the projection");
});

test("AC3 non-vacuous: widening the scope to include B's dir DOES surface B — strict pinning is load-bearing", () => {
  const project = grantedProjectA();
  const widened = resolveProjectScope(REPO_OWNER) as string[];
  const env = assembleRemoteBoard({ project, memberDirs: widened }, { nowMs: Date.parse(AT) });
  const serialized = JSON.stringify(env);

  // With the widened scope, the memberDir-scoped sources (activity + campaigns) DO reach B.
  assert.ok(serialized.includes(B_RUN), "the sibling's live run is reachable once the scope widens (activity)");
  assert.ok(serialized.includes(B_GOAL), "the sibling's campaign is reachable once the scope widens (campaigns)");
});

test("AC5: the live envelope exposes the freshness stamp and a five-state discriminator", () => {
  const project = grantedProjectA();
  const env = assembleRemoteBoard({ project, memberDirs: project.projectDirs }, { nowMs: 1_725_000_000_000 });
  assert.equal(env.state, "live");
  assert.equal(env.generation, 1_725_000_000_000);
  assert.equal(env.generatedAt, new Date(1_725_000_000_000).toISOString());

  const stale = assembleRemoteBoard({ project, memberDirs: project.projectDirs }, { nowMs: 1_725_000_000_000, stale: true });
  assert.equal(stale.state, "stale", "a caller-declared stale read is never labeled live");
  assert.ok(stale.board, "stale still carries data — it is data that is merely behind, not absent");
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
