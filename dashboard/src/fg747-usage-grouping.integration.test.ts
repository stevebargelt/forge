// FG-747 (integration companion to fg747-usage-grouping.test.ts) — the two claims that
// need REAL checkouts on disk, so they live in the integration tier (git is forbidden in
// unit-tier files by src/test-tiers.test.ts):
//
//   AC1  a remote literally named `forge` resolves to the human label "Forge", and the
//        primary + a clone + a worktree of it roll up to that ONE "Forge" bucket in the
//        dashboard rollup, model-mix, and the CLI aggregate — via one shared contract.
//   AC5  scoping by the Forge project includes exactly the Forge usage and no other's,
//        through the durable identity arm, agreeing with the grouping (one contract).
//
// WRITES go through forge's OWN writer (insertRun captures the declared pk-forge for
// every Forge checkout via registry precedence; insertUsageRows records model_calls).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fg747-usage-int-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { getDb } = await import("../../src/store/db.js");
const { insertRun } = await import("../../src/store/runs.js");
const { insertTask } = await import("../../src/store/tasks.js");
const { insertUsageRows } = await import("../../src/store/model-calls.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const { aggregate: cliAggregate } = await import("../../src/cli/commands/usage.js");
const { usageRollup, usageModelMix } = await import("./queries.js");

const trees = join(root, "trees");
mkdirSync(trees, { recursive: true });

function checkout(name: string, remote: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

// A remote literally named `forge` -> repository label "Forge". Three checkouts of it.
const FORGE_REMOTE = "git@github.com:stevebargelt/forge.git";
const OTHER_REMOTE = "git@github.com:stevebargelt/other-tool.git";
const forgePrimary = checkout("forge", FORGE_REMOTE);
const forgeClone = checkout("forge-clones-fg356", FORGE_REMOTE);
const forgeWorktree = checkout("forge-worktrees-fg591", FORGE_REMOTE);
const otherProject = checkout("other-tool", OTHER_REMOTE);

const REPO_FORGE = repositoryCheckoutIdentity(forgePrimary).key;
assert.equal(repositoryCheckoutIdentity(forgeClone).key, REPO_FORGE, "fixture: clone shares Forge's identity");
assert.equal(repositoryCheckoutIdentity(forgeWorktree).key, REPO_FORGE, "fixture: worktree shares Forge's identity");
assert.notEqual(REPO_FORGE, repositoryCheckoutIdentity(otherProject).key, "fixture: distinct repositories");

const AT = "2026-08-11T10:00:00Z";
const store = getDb();
const PK_FORGE = "pk-forge-747";
store
  .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?, ?, 'remote', ?)`)
  .run(PK_FORGE, REPO_FORGE, AT);

let seq = 0;
function seedRun(projectDir: string, requests: number): void {
  const n = seq++;
  const runId = `run-${n}`;
  const taskId = `task-${n}`;
  insertRun({ id: runId, workflow: "feature", title: runId, status: "complete", createdAt: AT, completedAt: AT, projectDir });
  insertTask({
    id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: AT,
  });
  insertUsageRows(
    Array.from({ length: requests }, (_, i) => ({
      taskId, requestId: `${taskId}-r${i}`, model: "claude-sonnet", alias: "prod",
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2,
      createdAt: AT,
    })),
  );
}

seedRun(forgePrimary, 3);
seedRun(forgeClone, 4);
seedRun(forgeWorktree, 5);
seedRun(otherProject, 2);

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// Fixture check: the writer captured pk-forge for the Forge checkouts (registry precedence).
assert.equal(
  (store.prepare(`SELECT project_identity FROM runs WHERE id = 'run-0'`).get() as { project_identity: string }).project_identity,
  PK_FORGE,
  "fixture: insertRun captured the declared pk-forge",
);

function byBucket(rows: Array<{ bucket: string; requests: number }>) {
  return new Map(rows.map((r) => [r.bucket, r]));
}

test("AC1: three Forge checkouts roll up to one 'Forge' bucket in rollup, model-mix, and CLI", () => {
  const dash = byBucket(usageRollup("project", "all"));
  assert.equal(dash.get("Forge")?.requests, 12, "dashboard rollup: one Forge bucket, 3+4+5");
  assert.ok(dash.get("Other-tool"), "the independent project is its own bucket");

  const mix = usageModelMix("project", "all").filter((b) => b.bucket === "Forge");
  assert.equal(mix.length, 1, "one Forge model-mix bucket");
  assert.equal(mix[0]!.models.reduce((s, m) => s + m.requests, 0), 12);

  const cli = byBucket(cliAggregate({ by: "project", sinceClause: "", projectFilter: undefined, limit: 50 }));
  assert.equal(cli.get("Forge")?.requests, 12, "CLI agrees: one Forge bucket");
});

test("AC5: scoping by the Forge project includes exactly the Forge usage and no other's", () => {
  const rows = byBucket(usageRollup("project", "all", [forgePrimary, forgeClone, forgeWorktree]));
  assert.deepEqual([...rows.keys()], ["Forge"], "only the Forge bucket is in scope");
  assert.equal(rows.get("Forge")!.requests, 12, "all Forge usage, and only it");
});
