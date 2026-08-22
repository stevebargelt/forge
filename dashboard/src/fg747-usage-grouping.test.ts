// FG-747 — usage grouped by "project" is keyed on DURABLE operator-project identity,
// not on checkout path, and the dashboard and CLI agree on it through ONE shared
// contract. This UNIT-tier file drives both the dashboard read seams (usageRollup,
// usageModelMix) AND the CLI aggregate against ONE on-disk store, with identities
// captured through forge's own writer (insertRun's pre-resolved arm) — no git, so it
// stays unit-pure. The literal "Forge" label and the identity-scope arm (AC5) need
// real checkouts and live in the companion .integration.test.ts. Covers here:
//
//   AC1  three checkouts carrying ONE identity -> ONE bucket in rollup, model-mix, CLI.
//   AC2  different project_dir paths never split that bucket.
//   AC3  a genuinely independent identity stays its own bucket.
//   AC4  dashboard and CLI agree on bucket identity, label, requests, every token total.
//   AC6  NULL-identity legacy rows land in ONE "Unattributed legacy usage" bucket.
//   pk-  a pk- identity normalizes to its repo- evidence key and merges.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fg747-usage-unit-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { getDb } = await import("../../src/store/db.js");
const { insertRun } = await import("../../src/store/runs.js");
const { insertTask } = await import("../../src/store/tasks.js");
const { insertUsageRows } = await import("../../src/store/model-calls.js");
const { UNATTRIBUTED_LEGACY_LABEL } = await import("../../src/store/usage-grouping.js");
const { aggregate: cliAggregate } = await import("../../src/cli/commands/usage.js");
const { usageRollup, usageModelMix } = await import("./queries.js");

const AT = "2026-08-11T10:00:00Z";
const store = getDb();
// Register pk-forge -> repo-forge so a run that captured the declared pk- normalizes to
// the same evidence bucket as its repo- siblings.
store
  .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?, ?, 'remote', ?)`)
  .run("pk-forge", "repo-forge", AT);

let seq = 0;
function seedRun(projectDir: string, identity: string | null, requests: number): void {
  const n = seq++;
  const runId = `run-${n}`;
  const taskId = `task-${n}`;
  insertRun(
    { id: runId, workflow: "feature", title: runId, status: "complete", createdAt: AT, completedAt: AT, projectDir },
    { value: identity },
  );
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

// Forge: primary (repo-), a clone (repo-), a worktree carrying the declared pk- — one
// identity, three paths, 3 + 4 + 5 = 12 requests.
seedRun("/forge", "repo-forge", 3);
seedRun("/forge-clones/fg356", "repo-forge", 4);
seedRun("/forge-worktrees/fg591", "pk-forge", 5); // pk- normalizes to repo-forge
// An independent project — 2 requests.
seedRun("/independent-tool", "repo-other", 2);
// Two NULL-identity legacy checkouts — 6 + 7 = 13, one unattributed bucket.
seedRun("/gone/legacy-a", null, 6);
seedRun("/gone/legacy-b", null, 7);

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function byBucket(rows: Array<{ bucket: string; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>) {
  return new Map(rows.map((r) => [r.bucket, r]));
}

test("AC1/AC2/pk-: three checkouts (repo- + repo- + pk-) with one identity -> ONE bucket", () => {
  const rows = byBucket(usageRollup("project", "all"));
  const forge = rows.get("repo-forge");
  assert.ok(forge, "one Forge bucket (no live checkout -> label is the raw evidence key)");
  assert.equal(forge!.requests, 12, "3+4+5 requests, pk- merged, never split by path");
  assert.equal(forge!.inputTokens, 1200);
});

test("AC3: the independent identity stays its own bucket", () => {
  const rows = byBucket(usageRollup("project", "all"));
  assert.equal(rows.get("repo-other")?.requests, 2);
  assert.notEqual(rows.get("repo-other"), rows.get("repo-forge"));
});

test("AC6: NULL-identity legacy rows are ONE 'Unattributed legacy usage' bucket", () => {
  const rows = byBucket(usageRollup("project", "all"));
  const legacy = rows.get(UNATTRIBUTED_LEGACY_LABEL);
  assert.ok(legacy, "one unattributed bucket");
  assert.equal(legacy!.requests, 13, "6+7, both legacy checkouts together — never a path/name-derived project");
});

test("AC1: usageModelMix groups the three Forge checkouts under one bucket", () => {
  const forge = usageModelMix("project", "all").filter((b) => b.bucket === "repo-forge");
  assert.equal(forge.length, 1, "exactly one Forge model-mix bucket");
  assert.equal(forge[0]!.models.reduce((s, m) => s + m.requests, 0), 12);
});

test("AC4: CLI aggregate and dashboard usageRollup agree on bucket, label, requests, and every token total", () => {
  const cli = byBucket(cliAggregate({ by: "project", sinceClause: "", projectFilter: undefined, limit: 50 }));
  const dash = byBucket(usageRollup("project", "all"));
  assert.deepEqual([...cli.keys()].sort(), [...dash.keys()].sort(), "same bucket labels");
  for (const [bucket, c] of cli) {
    const d = dash.get(bucket)!;
    assert.equal(c.requests, d.requests, `requests agree for ${bucket}`);
    assert.equal(c.inputTokens, d.inputTokens, `input agree for ${bucket}`);
    assert.equal(c.outputTokens, d.outputTokens, `output agree for ${bucket}`);
    assert.equal(c.cacheReadTokens, d.cacheReadTokens, `cache-read agree for ${bucket}`);
    assert.equal(c.cacheCreationTokens, d.cacheCreationTokens, `cache-create agree for ${bucket}`);
  }
});
