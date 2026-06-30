import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  listCampaignItems,
  approveCampaign,
} from "../store/campaigns.js";
import { insertTask, setTaskWorktreePath } from "../store/tasks.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign } from "./planner.js";
import { startCampaign } from "./executor.js";
import { assembleCampaignReport, setDoneAuditMapForTest, renderCampaignReportHuman } from "./report.js";
import { nowIso } from "../util/ids.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg367-branch-"));

  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "active",
    title: "Branch evidence story",
    created: "2024-01-01",
    body: "## Problem\nTest branch evidence.\n\n## Goal\nEvidence is captured.\n\n## Acceptance Criteria\n- Branch is recorded\n",
  });

  // Inject an empty done-audit map so report tests don't need a real git repo
  setDoneAuditMapForTest(new Map());
});

afterEach(() => {
  setDoneAuditMapForTest(null);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function planAndApproveCampaign() {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-200"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "test approval" });
  return campaign;
}

test("worktree run: executor writes branch and worktreePath to campaign item", async () => {
  const campaign = planAndApproveCampaign();

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const runId = args.runId!;
    const taskId = "task-build-wt001";
    insertTask({
      id: taskId,
      runId,
      phase: "build",
      agentRole: "engineer",
      status: "complete",
      taskPackage: { taskId, runId, phase: "build", role: "engineer", inputs: { task: "test" }, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    setTaskWorktreePath(taskId, "/tmp/fake-wt");
    return { status: "complete", runId, taskId };
  };

  await startCampaign(campaign.id, { dispatch });

  const items = listCampaignItems(campaign.id);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.ok(item.branch, "branch must be set after worktree dispatch");
  assert.ok(item.branch!.startsWith("forge/"), `branch must start with forge/, got: ${item.branch}`);
  assert.ok(item.branch!.includes("task-build-wt001"), `branch must include taskId, got: ${item.branch}`);
  assert.equal(item.worktreePath, "/tmp/fake-wt");
});

test("non-worktree run: executor leaves branch and worktreePath null", async () => {
  const campaign = planAndApproveCampaign();

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const runId = args.runId!;
    const taskId = "task-build-nowt001";
    insertTask({
      id: taskId,
      runId,
      phase: "build",
      agentRole: "engineer",
      status: "complete",
      taskPackage: { taskId, runId, phase: "build", role: "engineer", inputs: { task: "test" }, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    // No setTaskWorktreePath call — simulates a non-worktree run
    return { status: "complete", runId, taskId };
  };

  await startCampaign(campaign.id, { dispatch });

  const items = listCampaignItems(campaign.id);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.branch, undefined, "branch must be undefined for non-worktree run");
  assert.equal(item.worktreePath, undefined, "worktreePath must be undefined for non-worktree run");
});

test("assembleCampaignReport JSON includes populated branch and worktreePath", async () => {
  const campaign = planAndApproveCampaign();

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const runId = args.runId!;
    const taskId = "task-build-wt002";
    insertTask({
      id: taskId,
      runId,
      phase: "build",
      agentRole: "engineer",
      status: "complete",
      taskPackage: { taskId, runId, phase: "build", role: "engineer", inputs: { task: "test" }, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    setTaskWorktreePath(taskId, "/tmp/fake-wt-report");
    return { status: "complete", runId, taskId };
  };

  await startCampaign(campaign.id, { dispatch });

  const report = assembleCampaignReport(campaign.id)!;
  assert.ok(report, "report must not be null");
  assert.equal(report.items.length, 1);
  const item = report.items[0]!;
  assert.ok(item.branch, "report item branch must be set");
  assert.ok(item.branch!.startsWith("forge/"), `report item branch must start with forge/, got: ${item.branch}`);
  assert.ok(item.branch!.includes("task-build-wt002"), "branch must include taskId");
  assert.equal(item.worktreePath, "/tmp/fake-wt-report");
});

test("human render emits branch and worktreePath lines", async () => {
  const campaign = planAndApproveCampaign();

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const runId = args.runId!;
    const taskId = "task-build-wt003";
    insertTask({
      id: taskId,
      runId,
      phase: "build",
      agentRole: "engineer",
      status: "complete",
      taskPackage: { taskId, runId, phase: "build", role: "engineer", inputs: { task: "test" }, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    setTaskWorktreePath(taskId, "/tmp/fake-wt-render");
    return { status: "complete", runId, taskId };
  };

  await startCampaign(campaign.id, { dispatch });

  const report = assembleCampaignReport(campaign.id)!;
  assert.ok(report, "report must not be null");

  // Call the REAL renderCampaignReportHuman from report.ts — the same function the CLI action uses.
  // Asserts on returned lines, not a reimplemented copy of the rendering logic.
  const lines = renderCampaignReportHuman(report);

  assert.ok(
    lines.some((l) => l.includes("branch=forge/")),
    `human output must include branch=forge/, got:\n${lines.join("\n")}`
  );
  assert.ok(
    lines.some((l) => l.includes("worktree=")),
    `human output must include worktree=, got:\n${lines.join("\n")}`
  );
});

test("no git push or PR command invoked during campaign dispatch", async () => {
  // SOURCE GUARD (import-style-agnostic): reads raw source text of dispatch-path files
  // and asserts none contains a git push or gh command invocation. Unlike the previous
  // CJS namespace spy (which reassigned module.exports["execFileSync"] and did NOT
  // intercept ESM named-import bindings fixed at import time), this check catches
  // execFileSync("git", ["push"]) regardless of import style.
  //
  // RUNTIME GUARD: also confirms prUrl is never set during dispatch (no auto-PR in v1).
  const filesToCheck = [
    new URL("executor.ts", import.meta.url).pathname,
    new URL("report.ts", import.meta.url).pathname,
    new URL("../done-audit/collect.ts", import.meta.url).pathname,
    new URL("../v2/worktree-lifecycle.ts", import.meta.url).pathname,
    new URL("../v2/runNext.ts", import.meta.url).pathname,
    new URL("../cli/commands/campaign.ts", import.meta.url).pathname,
  ];

  // Detects execFileSync/execFile/spawn("git", ["push"...) and exec("git push ...")
  const gitPushPattern =
    /(execFile(?:Sync)?|spawn)\s*\(\s*["'`]git["'`]\s*,\s*\[["'`]push["'`]|exec\s*\(\s*["'`]git\s+push/;
  // Detects any execFileSync/execFile/spawn("gh", ...) invocation
  const ghCommandPattern = /(execFile(?:Sync)?|spawn)\s*\(\s*["'`]gh["'`]/;

  for (const filePath of filesToCheck) {
    const source = readFileSync(filePath, "utf8");
    assert.ok(!gitPushPattern.test(source), `git push must not appear in ${filePath}`);
    assert.ok(!ghCommandPattern.test(source), `gh command must not appear in ${filePath}`);
  }

  // Runtime: confirm prUrl is never set and branch stays local
  const campaign = planAndApproveCampaign();
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    const runId = args.runId!;
    const taskId = "task-build-nopush001";
    insertTask({
      id: taskId,
      runId,
      phase: "build",
      agentRole: "engineer",
      status: "complete",
      taskPackage: { taskId, runId, phase: "build", role: "engineer", inputs: { task: "test" }, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    return { status: "complete", runId, taskId };
  };

  const result = await startCampaign(campaign.id, { dispatch });
  assert.equal(result.stopReason, "complete", "campaign must complete normally");

  const items = listCampaignItems(campaign.id);
  assert.equal(items.length, 1);
  const item = items[0]!;

  assert.equal(item.prUrl, undefined, "prUrl must not be set: no auto-PR in v1");

  if (item.branch !== undefined) {
    assert.ok(
      item.branch.startsWith("forge/"),
      `branch must be a local forge/ branch name, not a push indicator, got: ${item.branch}`,
    );
  }
});
