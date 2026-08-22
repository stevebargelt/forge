// FG-747: the ONE usage `project`-dimension grouping contract, proved against the
// real store SQL it emits. Covers: identity grouping (many checkouts of one identity
// -> one bucket), pk- normalization to the repo- evidence key, a pk- with no registry
// row falling through unchanged, NULL-identity + orphan model_calls landing in the
// single unattributed sentinel, the degrade-to-legacy path on a store lacking the
// identity column, the row-in-hand normalizer mirroring the SQL, and label resolution.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { insertRun } from "./runs.js";
import { insertTask } from "./tasks.js";
import { insertUsageRows } from "./model-calls.js";
import {
  projectGroupingSql,
  projectBucketKeyForRow,
  resolveUsageProjectLabel,
  hasRunsProjectIdentity,
  UNATTRIBUTED_LEGACY_KEY,
  UNATTRIBUTED_LEGACY_LABEL,
  LEGACY_PROJECT_BUCKET_UNKNOWN,
} from "./usage-grouping.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

let seq = 0;
/** Seed one run + task + N identical model_call rows, with an explicit durable
 *  identity (bypassing git resolution via the pre-resolved arm of insertRun). */
function seedUsage(opts: { projectDir: string | null; identity: string | null; requests: number }): string {
  const n = seq++;
  const runId = `run-${n}`;
  const taskId = `task-${n}`;
  insertRun(
    { id: runId, workflow: "invoke", title: runId, status: "complete", createdAt: "2026-08-01T00:00:00Z", projectDir: opts.projectDir ?? undefined },
    { value: opts.identity },
  );
  insertTask({
    id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-08-01T00:00:00Z",
  });
  const rows = Array.from({ length: opts.requests }, (_, i) => ({
    taskId, requestId: `${taskId}-req-${i}`, model: "claude-sonnet", alias: "prod",
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2,
    createdAt: "2026-08-01T00:00:00Z",
  }));
  insertUsageRows(rows);
  return taskId;
}

/** Run the contract's own bucket SQL end-to-end and return bucket -> request count. */
function bucketCounts(handle: DatabaseInstance): Map<string, number> {
  const g = projectGroupingSql(handle, "r");
  const sql = `
    SELECT ${g.bucketExpr} AS bucket, COUNT(*) AS n
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    ${g.join}
    GROUP BY bucket`;
  const rows = handle.prepare(sql).all() as Array<{ bucket: string; n: number }>;
  return new Map(rows.map((r) => [r.bucket, r.n]));
}

test("AC1/AC2: three checkouts carrying ONE identity collapse to one bucket; branches/paths never split it", () => {
  // Forge primary, a clone, a worktree — different project_dir, ONE identity.
  seedUsage({ projectDir: "/forge", identity: "repo-forge", requests: 3 });
  seedUsage({ projectDir: "/forge-clones/fg356", identity: "repo-forge", requests: 4 });
  seedUsage({ projectDir: "/forge-worktrees/fg591", identity: "repo-forge", requests: 5 });
  const counts = bucketCounts(getDb());
  assert.equal(counts.size, 1, "one Forge bucket");
  assert.equal(counts.get("repo-forge"), 12, "every request counted, none dropped or duplicated");
});

test("AC3: two independent identities with look-alike paths stay separate", () => {
  seedUsage({ projectDir: "/work/forge", identity: "repo-forge", requests: 2 });
  seedUsage({ projectDir: "/work/forge-ish", identity: "repo-other", requests: 3 });
  const counts = bucketCounts(getDb());
  assert.equal(counts.size, 2);
  assert.equal(counts.get("repo-forge"), 2);
  assert.equal(counts.get("repo-other"), 3);
});

test("pk- normalization: a pk- identity groups with the repo- evidence key it maps to", () => {
  getDb()
    .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?, ?, ?, ?)`)
    .run("pk-forge", "repo-forge", "remote", "2026-08-01T00:00:00Z");
  seedUsage({ projectDir: "/forge", identity: "repo-forge", requests: 2 });
  seedUsage({ projectDir: "/forge-clone", identity: "pk-forge", requests: 3 });
  const counts = bucketCounts(getDb());
  assert.equal(counts.size, 1, "pk-forge normalized to repo-forge -> one bucket");
  assert.equal(counts.get("repo-forge"), 5);
});

test("a pk- with NO registry row falls through unchanged, without throwing", () => {
  seedUsage({ projectDir: "/x", identity: "pk-unregistered", requests: 2 });
  const counts = bucketCounts(getDb());
  assert.equal(counts.get("pk-unregistered"), 2, "stable if ungrouped, never a throw");
});

test("AC6: NULL-identity legacy rows AND orphan model_calls land in ONE unattributed sentinel", () => {
  seedUsage({ projectDir: "/legacy-a", identity: null, requests: 2 });
  seedUsage({ projectDir: "/legacy-b", identity: null, requests: 3 });
  // An orphan model_call: NULL task_id (backfill left no clean owner) -> the LEFT
  // JOINs leave identity NULL, so it must land in the sentinel, never its own bucket.
  insertUsageRows([{ taskId: null, requestId: "orphan-1", model: "m", alias: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, createdAt: "2026-08-01T00:00:00Z" }]);
  const counts = bucketCounts(getDb());
  assert.equal(counts.size, 1, "one unattributed bucket, never a path/name-derived project");
  assert.equal(counts.get(UNATTRIBUTED_LEGACY_KEY), 6, "both legacy checkouts + the orphan roll up together");
});

test("degrade: a store lacking runs.project_identity buckets by project_dir without throwing", () => {
  const legacy = new Database(":memory:");
  legacy.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, project_dir TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT);
    CREATE TABLE model_calls (request_id TEXT, task_id TEXT);
    INSERT INTO runs VALUES ('r1','/proj/alpha');
    INSERT INTO tasks VALUES ('t1','r1');
    INSERT INTO model_calls VALUES ('q1','t1');
  `);
  assert.equal(hasRunsProjectIdentity(legacy), false);
  const g = projectGroupingSql(legacy, "r");
  assert.equal(g.join, "", "no registry join on the degraded path");
  const counts = bucketCounts(legacy);
  assert.equal(counts.get("/proj/alpha"), 1, "legacy path bucket");
  // The sentinel and unknown-project labels stay well-defined constants.
  assert.equal(LEGACY_PROJECT_BUCKET_UNKNOWN, "(unknown project)");
  legacy.close();
});

test("projectBucketKeyForRow mirrors the SQL exactly", () => {
  getDb()
    .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?, ?, ?, ?)`)
    .run("pk-forge", "repo-forge", "remote", "2026-08-01T00:00:00Z");
  assert.equal(projectBucketKeyForRow(getDb(), null), UNATTRIBUTED_LEGACY_KEY);
  assert.equal(projectBucketKeyForRow(getDb(), ""), UNATTRIBUTED_LEGACY_KEY);
  assert.equal(projectBucketKeyForRow(getDb(), "repo-forge"), "repo-forge");
  assert.equal(projectBucketKeyForRow(getDb(), "pk-forge"), "repo-forge");
  assert.equal(projectBucketKeyForRow(getDb(), "pk-unregistered"), "pk-unregistered");
});

test("resolveUsageProjectLabel: sentinel -> label, key -> registry label, unknown -> key", () => {
  const registry = [{ key: "repo-forge", label: "Forge" }];
  assert.equal(resolveUsageProjectLabel(UNATTRIBUTED_LEGACY_KEY, registry), UNATTRIBUTED_LEGACY_LABEL);
  assert.equal(resolveUsageProjectLabel("repo-forge", registry), "Forge");
  assert.equal(resolveUsageProjectLabel("repo-unknown", registry), "repo-unknown");
});
