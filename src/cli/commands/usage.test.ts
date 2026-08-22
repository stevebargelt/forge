// #262: forge usage backfill must select the parser from each task's manifest
// runtime.logFormat — a pi/codex historical log would otherwise backfill ZERO
// rows through the claude default. Tests the command path (performBackfill), not
// just the dispatcher, so dropping the manifestLogFormat() call is caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { insertUsageRows } from "../../store/model-calls.js";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { performBackfill, aggregate } from "./usage.js";
import { UNATTRIBUTED_LEGACY_LABEL } from "../../store/usage-grouping.js";

// A real pi --mode json shape: usage lives on agent_end's assistant messages.
// The claude parser (which keys off type:"assistant" events) finds nothing here.
const PI_STREAM =
  JSON.stringify({ type: "session", id: "sess-bf" }) + "\n" +
  JSON.stringify({ type: "agent_end", messages: [
    { role: "user", content: [] },
    { role: "assistant", model: "claude-sonnet-4-6", responseId: "r1", usage: { input: 500, output: 25, cacheRead: 0, cacheWrite: 0 } },
  ] }) + "\n";

function seedTask(taskId: string): void {
  insertRun({ id: `run-${taskId}`, workflow: "invoke", title: taskId, status: "active", createdAt: "2026-06-06T00:00:00Z" });
  insertTask({
    id: taskId, runId: `run-${taskId}`, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId, runId: `run-${taskId}`, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-06T00:00:00Z",
  });
}

function writeRunLog(runsDir: string, taskId: string, withManifest: boolean): void {
  const dir = join(runsDir, `run-${taskId}`, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "container.stdout.log"), PI_STREAM);
  if (withManifest) {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      runtime: { name: "pi-apikey", kind: "pi", logFormat: "pi-jsonl", promptStrategy: "message-arg", authStrategy: "env-provider-api-key" },
    }));
  }
}

function withDb(fn: (db: DatabaseInstance, runsDir: string) => void): void {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  const runsDir = mkdtempSync(join(tmpdir(), "forge-bf-runs-"));
  try { fn(db, runsDir); }
  finally { if (prev) setDbForTest(prev); rmSync(runsDir, { recursive: true, force: true }); }
}

test("#262 backfill: dry-run counts a pi log via the manifest log_format", () => {
  withDb((_db, runsDir) => {
    seedTask("task-bf-dry");
    writeRunLog(runsDir, "task-bf-dry", true);
    const s = performBackfill(runsDir, { dryRun: true });
    assert.equal(s.scanned, 1);
    assert.equal(s.withData, 1, "pi log parsed via the manifest's pi-jsonl, not the claude default");
    assert.equal(s.totalRows, 1);
  });
});

test("#262 backfill: non-dry-run inserts the pi usage row through the write path", () => {
  withDb((db, runsDir) => {
    seedTask("task-bf-write");
    writeRunLog(runsDir, "task-bf-write", true);
    const s = performBackfill(runsDir, {});
    assert.equal(s.totalRows, 1);
    const row = db.prepare("SELECT input_tokens, output_tokens FROM model_calls WHERE task_id = ?").get("task-bf-write") as Record<string, unknown>;
    assert.equal(row.input_tokens, 500);
    assert.equal(row.output_tokens, 25);
  });
});

test("#262 backfill: a pi log WITHOUT a manifest falls back to claude and records nothing (manifest is load-bearing)", () => {
  withDb((_db, runsDir) => {
    seedTask("task-bf-nomani");
    writeRunLog(runsDir, "task-bf-nomani", false); // no manifest → no logFormat → claude default
    const s = performBackfill(runsDir, { dryRun: true });
    assert.equal(s.scanned, 1);
    assert.equal(s.withData, 0, "claude parser finds no usage in a pi stream — proves the manifest is what enables it");
  });
});

// ─── FG-747: `--by project` groups on durable identity, not checkout path ──────

let usageSeq = 0;
function seedProjectUsage(projectDir: string, identity: string | null, requests: number): void {
  const n = usageSeq++;
  const runId = `run-p${n}`;
  const taskId = `task-p${n}`;
  insertRun(
    { id: runId, workflow: "invoke", title: runId, status: "complete", createdAt: "2026-07-01T00:00:00Z", projectDir },
    { value: identity },
  );
  insertTask({
    id: taskId, runId, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-01T00:00:00Z",
  });
  insertUsageRows(
    Array.from({ length: requests }, (_, i) => ({
      taskId, requestId: `${taskId}-r${i}`, model: "claude-sonnet", alias: "prod",
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2,
      createdAt: "2026-07-01T00:00:00Z",
    })),
  );
}

function projectAggregate() {
  return aggregate({ by: "project", sinceClause: "", projectFilter: undefined, limit: 50 });
}

test("FG-747 CLI `--by project`: many checkouts of one identity collapse to ONE bucket", () => {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    seedProjectUsage("/forge", "repo-forge", 3);
    seedProjectUsage("/forge-clones/fg356", "repo-forge", 4);
    seedProjectUsage("/forge-worktrees/fg591", "repo-forge", 5);
    seedProjectUsage("/other", "repo-other", 2);
    const rows = projectAggregate();
    const forge = rows.find((r) => r.bucket === "repo-forge");
    assert.ok(forge, "one Forge bucket (no live checkout on disk -> label is the raw evidence key)");
    assert.equal(forge!.requests, 12, "every request counted once");
    assert.equal(rows.find((r) => r.bucket === "repo-other")?.requests, 2, "independent project stays separate");
  } finally {
    if (prev) setDbForTest(prev);
    db.close();
  }
});

test("FG-747 CLI `--by project`: NULL-identity rows render as the 'Unattributed legacy usage' bucket", () => {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    seedProjectUsage("/legacy-a", null, 2);
    seedProjectUsage("/legacy-b", null, 3);
    const rows = projectAggregate();
    const legacy = rows.find((r) => r.bucket === UNATTRIBUTED_LEGACY_LABEL);
    assert.ok(legacy, "one unattributed-legacy bucket, never a path/name-derived project");
    assert.equal(legacy!.requests, 5);
    assert.equal(rows.length, 1, "both legacy checkouts roll up together");
  } finally {
    if (prev) setDbForTest(prev);
    db.close();
  }
});
