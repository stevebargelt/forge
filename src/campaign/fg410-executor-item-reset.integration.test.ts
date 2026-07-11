// FG-410 integration tests: the executor's reset-before-dispatch paths through a
// real resumeCampaign flow against a real store.
//
// The campaign executor clears hold state by passing explicit `undefined` for the
// fields it names (executor.ts:1292 readiness-hold, executor.ts:1312 dependency-hold).
// Since FG-410 the store writers build a column-targeted UPDATE from own-property
// key presence, so:
//
//   - a field the reset NAMES (explicit undefined) is written to NULL, and
//   - a field the reset does NOT name is left untouched — never rewritten.
//
// Run-linkage columns (runId / branch / worktreePath / prUrl) fall in the second
// group. Under the old read-merge-write writers they survived by accident of the
// merge restoring the row it had just read; now they survive by omission. These
// tests pin that contract at the executor seam rather than at the store API, so a
// future reset that silently starts clobbering (or a writer that goes back to
// full-row writes) fails here.
//
// Both tests snapshot the item row from INSIDE the dispatch spy — the dispatch is
// called immediately after the reset, which is the only moment the post-reset,
// pre-outcome row is observable in a real flow.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  approveCampaign,
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  updateCampaignItem,
  updateCampaignStatus,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import type { CampaignItem } from "../types/index.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { startCampaign, resumeCampaign } from "./executor.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";

// Same wrapper as readiness-gate.integration.test.ts / executor.integration.test.ts:
// pin list campaigns to the invoke lane so the hold/reset/dispatch logic runs
// without workflow YAML or container infrastructure. The invoke lane's dispatch
// writes only { runId, lifecycleStatus } — it never touches branch/worktreePath/prUrl,
// which is what makes it a clean observation point for the survival assertions.
function planCampaign(input: PlannerInput, opts: { projectDir: string; mode?: PlanMode }) {
  if (input.kind === "list" && !input.itemOverrides) {
    const overrides = Object.fromEntries(
      input.ticketIds.map((id) => [id, { executionMode: "invoke" as const, agentRole: "engineer" }])
    );
    return _planCampaign({ ...input, itemOverrides: overrides }, opts);
  }
  return _planCampaign(input, opts);
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

// Real, reachable, non-code commit — satisfies the out-of-band evidence lane so a
// dispatched item can actually reach 'complete'. These tests are about the reset
// contract, not the evidence gate.
function makeShipCommit(label: string): string {
  writeFileSync(join(projectDir, `${label.replace(/[^A-Za-z0-9_-]/g, "_")}-ship.md`), `${label} shipped`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `ship ${label}`], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg410-executor-reset-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  writeFileSync(join(projectDir, "base.txt"), "base");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

const READY_BODY = [
  "## Problem",
  "The feature needs to be implemented.",
  "",
  "## Goal",
  "Deliver the feature correctly.",
  "",
  "## Acceptance Criteria",
  "- The feature works end-to-end",
  "- Edge cases are handled",
].join("\n");

const UNREADY_BODY = "Some initial notes without required sections.";

// Dispatch spy that snapshots the item row at dispatch time — i.e. after the
// executor's reset ran and after the invoke lane stamped { runId, lifecycleStatus }.
function makeSnapshottingDispatch(itemId: string): {
  spy: (args: InvokeArgs) => Promise<InvokeResult>;
  calls: string[];
  snapshotAtDispatch: () => CampaignItem | undefined;
} {
  const calls: string[] = [];
  let snapshot: CampaignItem | undefined;
  return {
    calls,
    snapshotAtDispatch: () => snapshot,
    spy: async (args: InvokeArgs): Promise<InvokeResult> => {
      calls.push(args.runTitle ?? "");
      const row = getCampaignItem(itemId);
      // Capture only the dispatch of the item under test.
      if (row && args.runTitle === row.ticketId) snapshot = row;
      if (args.runTitle) closeTicket(projectDir, args.runTitle, makeShipCommit(args.runTitle));
      return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
    },
  };
}

// ── 1. Readiness-hold reset (executor.ts:1292) ───────────────────────────────
// The reset names outcome/blockerKind/continuePolicy/reason/requestedHumanAction.
// It does NOT name runId/branch/worktreePath/prUrl.

test("FG-410 readiness-hold reset: named fields go NULL, un-named run linkage survives", async () => {
  writeTicket(projectDir, {
    id: "FG-201",
    type: "story",
    status: "active",
    title: "Ready Story",
    created: "2024-01-01",
    body: READY_BODY,
  });
  writeTicket(projectDir, {
    id: "FG-202",
    type: "story",
    status: "active",
    title: "Unready Story",
    created: "2024-01-02",
    body: UNREADY_BODY,
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-201", "FG-202"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Phase 1 — start: FG-201 ships, FG-202 is readiness-held, campaign pauses.
  const startSpy = makeSnapshottingDispatch("unused");
  const startResult = await startCampaign(campaign.id, { dispatch: startSpy.spy });
  assert.equal(startResult.stopReason, "paused");

  const item202 = listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-202")!;
  const held = getCampaignItem(item202.id)!;
  assert.equal(held.outcome, "held", "precondition: FG-202 is held");
  assert.equal(held.blockerKind, "readiness", "precondition: held on readiness");
  assert.ok(held.requestedHumanAction, "precondition: hold context is populated");

  // The item carries run linkage from an earlier attempt. (Seeded directly: what
  // matters for the reset contract is that these columns are non-NULL when the
  // reset runs — how they got there is orthogonal.)
  updateCampaignItem(item202.id, {
    runId: "run-earlier-attempt",
    branch: "forge/run-earlier-attempt/citem-202",
    worktreePath: "/tmp/wt/citem-202",
    prUrl: "https://github.com/example/repo/pull/42",
  });

  // Operator refines FG-202 → readiness now passes → the reset at executor.ts:1292 fires.
  writeTicket(projectDir, {
    id: "FG-202",
    type: "story",
    status: "active",
    title: "Unready Story (now refined)",
    created: "2024-01-02",
    body: READY_BODY,
  });

  // Phase 2 — resume.
  const resumeSpy = makeSnapshottingDispatch(item202.id);
  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeSpy.spy });
  assert.equal(resumeResult.stopReason, "complete");
  assert.deepEqual(resumeSpy.calls, ["FG-202"], "only the un-held item dispatches on resume");

  const atDispatch = resumeSpy.snapshotAtDispatch();
  assert.ok(atDispatch, "must have observed FG-202's row at dispatch time");

  // Named by the reset (explicit undefined) → written to NULL.
  assert.equal(atDispatch.outcome, undefined, "outcome must be cleared to NULL by the reset");
  assert.equal(atDispatch.blockerKind, undefined, "blockerKind must be cleared to NULL by the reset");
  assert.equal(atDispatch.continuePolicy, undefined, "continuePolicy must be cleared to NULL by the reset");
  assert.equal(atDispatch.reason, undefined, "reason must be cleared to NULL by the reset");
  assert.equal(
    atDispatch.requestedHumanAction,
    undefined,
    "requestedHumanAction must be cleared to NULL by the reset"
  );

  // NOT named by the reset → untouched. The reset must not null these out just
  // because it rewrote the row's hold columns.
  assert.equal(
    atDispatch.branch,
    "forge/run-earlier-attempt/citem-202",
    "branch was not named by the reset — it must survive"
  );
  assert.equal(atDispatch.worktreePath, "/tmp/wt/citem-202", "worktreePath was not named by the reset — it must survive");
  assert.equal(
    atDispatch.prUrl,
    "https://github.com/example/repo/pull/42",
    "prUrl was not named by the reset — it must survive"
  );
  // runId is likewise un-named by the reset; the invoke lane then legitimately
  // re-stamps it with the fresh dispatch run. The contract the reset owes is that
  // it did not NULL it — a cleared runId would surface here as undefined.
  assert.ok(atDispatch.runId, "runId must not be nulled by the reset");
  assert.equal(atDispatch.lifecycleStatus, "running", "invoke lane stamped the item running for this dispatch");

  // Final state: the item shipped, and the un-named linkage columns are still there.
  const final = getCampaignItem(item202.id)!;
  assert.equal(final.lifecycleStatus, "complete");
  assert.equal(final.outcome, "shipped");
  assert.equal(final.blockerKind, undefined, "shipped item must carry no residual blockerKind");
  assert.equal(final.branch, "forge/run-earlier-attempt/citem-202");
  assert.equal(final.prUrl, "https://github.com/example/repo/pull/42");
  assert.equal(getCampaign(campaign.id)!.status, "complete");
});

// ── 2. Dependency-hold reset (executor.ts:1312) ──────────────────────────────
// This reset names outcome/continuePolicy/reason/requestedHumanAction — and,
// unlike the readiness reset, does NOT name blockerKind. Under a column-targeted
// write that means blocker_kind is left exactly as it was, which is the same
// thing the old read-merge-write did. Pinned here so the asymmetry between the
// two resets stays deliberate.

test("FG-410 dependency-hold reset: names outcome/policy/reason/action; leaves blockerKind and run linkage untouched", async () => {
  writeTicket(projectDir, {
    id: "FG-301",
    type: "story",
    status: "active",
    title: "Blocker Story",
    created: "2024-01-01",
    body: READY_BODY,
  });
  writeTicket(projectDir, {
    id: "FG-302",
    type: "story",
    status: "active",
    title: "Dependent Story",
    created: "2024-01-02",
    body: READY_BODY,
  });

  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-301", "FG-302"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "Approved" });

  // Seed the state a prior run left behind: FG-301 was blocked and has since been
  // resolved (shipped) by the operator, FG-302 is still dependency-held from when
  // FG-301 was blocking it, and carries run linkage from its own earlier attempt.
  // On resume, blockedItems rebuilds empty (no failed LOCAL blocker remains), so
  // evaluateForHold returns hold:false and the reset at executor.ts:1312 fires.
  assert.ok(tryTransitionCampaignToRunning(campaign.id));
  const items = listCampaignItems(campaign.id);
  const item301 = items.find((i) => i.ticketId === "FG-301")!;
  const item302 = items.find((i) => i.ticketId === "FG-302")!;

  updateCampaignItem(item301.id, { lifecycleStatus: "complete", outcome: "shipped", runId: "run-301" });
  closeTicket(projectDir, "FG-301", makeShipCommit("FG-301"));

  updateCampaignItem(item302.id, {
    outcome: "held",
    blockerKind: "dependency",
    continuePolicy: "hold_dependents",
    reason: "held because related to blocked item FG-301",
    requestedHumanAction: "held on dependency FG-301 — resolve/complete FG-301, then forge campaign resume",
    runId: "run-302-earlier",
    branch: "forge/run-302-earlier/citem-302",
    worktreePath: "/tmp/wt/citem-302",
    prUrl: "https://github.com/example/repo/pull/77",
  });
  updateCampaignStatus(campaign.id, "paused");

  const resumeSpy = makeSnapshottingDispatch(item302.id);
  const resumeResult = await resumeCampaign(campaign.id, { dispatch: resumeSpy.spy });
  assert.equal(resumeResult.stopReason, "complete");
  assert.deepEqual(resumeSpy.calls, ["FG-302"], "only the un-held dependent dispatches");

  const atDispatch = resumeSpy.snapshotAtDispatch();
  assert.ok(atDispatch, "must have observed FG-302's row at dispatch time");

  // Named by the reset → NULL.
  assert.equal(atDispatch.outcome, undefined, "outcome must be cleared to NULL");
  assert.equal(atDispatch.continuePolicy, undefined, "continuePolicy must be cleared to NULL");
  assert.equal(atDispatch.reason, undefined, "reason must be cleared to NULL");
  assert.equal(atDispatch.requestedHumanAction, undefined, "requestedHumanAction must be cleared to NULL");

  // NOT named by the dependency reset → untouched.
  assert.equal(
    atDispatch.blockerKind,
    "dependency",
    "the dependency reset does not name blockerKind — the column-targeted write must leave it in place"
  );
  assert.equal(atDispatch.branch, "forge/run-302-earlier/citem-302", "branch must survive the reset");
  assert.equal(atDispatch.worktreePath, "/tmp/wt/citem-302", "worktreePath must survive the reset");
  assert.equal(atDispatch.prUrl, "https://github.com/example/repo/pull/77", "prUrl must survive the reset");
  assert.ok(atDispatch.runId, "runId must not be nulled by the reset");

  const final = getCampaignItem(item302.id)!;
  assert.equal(final.lifecycleStatus, "complete");
  assert.equal(final.outcome, "shipped");
  assert.equal(final.branch, "forge/run-302-earlier/citem-302");
  assert.equal(final.prUrl, "https://github.com/example/repo/pull/77");
});
