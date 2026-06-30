import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
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
  // Verifies that executor.ts does not push or create PRs as part of dispatch.
  // Conservative v1 policy: git evidence (branch/worktreePath) is local-only;
  // prUrl must remain unset (no auto-PR).
  //
  // REGRESSION GUARD: A process-level spy is installed on child_process.execFileSync
  // via the CJS module cache. Node.js's ESM namespace for built-in modules reads
  // from module.exports dynamically, so any future addition of execFileSync("git",
  // ["push", ...]) anywhere in the campaign dispatch path will be intercepted and
  // cause this test to throw immediately — making it impossible to accidentally ship
  // a git-push in the executor without breaking this test.
  const campaign = planAndApproveCampaign();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
  const execFileSyncCalls: Array<[string, string[]]> = [];
  const origExecFileSync = cp["execFileSync"] as (...args: unknown[]) => unknown;
  cp["execFileSync"] = (file: unknown, args: unknown = [], opts?: unknown): unknown => {
    const fileStr = String(file);
    const argsArr = Array.isArray(args) ? (args as string[]) : [];
    execFileSyncCalls.push([fileStr, argsArr]);
    if (fileStr === "git" && argsArr[0] === "push") {
      throw new Error(`test-spy: git push must not be called during campaign dispatch (args: ${argsArr.join(" ")})`);
    }
    if (fileStr === "gh") {
      throw new Error(`test-spy: gh command must not be called during campaign dispatch (args: ${argsArr.join(" ")})`);
    }
    return origExecFileSync(file, args, opts);
  };

  try {
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

    // prUrl must not be set — no auto-PR in v1
    assert.equal(item.prUrl, undefined, "prUrl must not be set: no auto-PR in v1");

    // branch, if set, must be a local forge/<runId>/<taskId> name — not a remote ref
    if (item.branch !== undefined) {
      assert.ok(
        item.branch.startsWith("forge/"),
        `branch must be a local forge/ branch name, not a push indicator, got: ${item.branch}`
      );
    }

    // Explicit call-log assertions: these fire even if the spy somehow didn't throw,
    // providing a second layer of enforcement.
    const gitPushCalls = execFileSyncCalls.filter(([cmd, args]) => cmd === "git" && args[0] === "push");
    const prCreateCalls = execFileSyncCalls.filter(
      ([cmd, args]) => cmd === "gh" || (cmd === "git" && args[0] === "pull-request")
    );
    assert.equal(
      gitPushCalls.length,
      0,
      `git push must not be called during campaign dispatch; recorded calls: ${JSON.stringify(execFileSyncCalls)}`
    );
    assert.equal(
      prCreateCalls.length,
      0,
      `gh / git pull-request must not be called during campaign dispatch; recorded calls: ${JSON.stringify(execFileSyncCalls)}`
    );
  } finally {
    cp["execFileSync"] = origExecFileSync;
  }
});
