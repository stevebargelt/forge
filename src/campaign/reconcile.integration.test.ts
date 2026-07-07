// FG-428/FG-443: integration coverage for reconcileCampaign against a real store
// DB. Covers: each of the 5 scope-blocked missing-evidence facts refuses with
// zero mutation, the all-evidence-present positive case (both starting
// lifecycle shapes), the spoofing guard, the not-paused guard, an end-to-end
// unhold+resume proving the existing executor blockedItems rebuild picks up
// reconciled state for free — plus (FG-443) the parallel out-of-band eligibility
// branch for awaiting_gate/non-pipeline items: its own negative paths, its
// positive path reaching 'complete' via the unmodified driveRemainingItems
// transition, coexistence with a scope-blocked item in the same call, and its
// own paused-guard race.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { insertHostVerification, queryHostVerificationRowsForGate } from "../store/host-verifications.js";
import { logEvent } from "../store/events.js";
import {
  approveCampaign,
  getCampaign,
  getCampaignItem,
  listCampaignItems,
} from "../store/campaigns.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { resumeCampaign } from "./executor.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { reconcileCampaign } from "./reconcile.js";
import { collectReconcileEvidence, runAndRecordHostVerification } from "./reconcile-collect.js";
import { evaluateReconcileEvidence } from "./reconcile-evidence.js";
import { collectOutOfBandEvidence } from "./reconcile-outofband-collect.js";
import { assembleCampaignReport, assembleCampaignShow, renderCampaignReportHuman } from "./report.js";

// Same wrapper as executor.test.ts: forces executionMode:'invoke' for list-type
// campaigns so resumeCampaign's dispatch path is trivially mockable.
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

function makeCommit(label: string): string {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "reconcile-integ-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function countEvents(): number {
  return (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
}

// Builds a single-item paused campaign whose item is scope-blocked (lifecycleStatus
// defaults to 'failed'). Returns the campaign id, item id and run id so tests can
// layer evidence (or deliberately withhold one fact) on top.
function setupBlockedCampaign(
  ticketId: string,
  opts: { lifecycleStatus?: "failed" | "blocked_by_red" } = {}
): { campaignId: string; itemId: string; runId: string } {
  // Stub ticket so the planner can resolve it — tests overwrite it with real
  // evidence (or deliberately withhold a fact) afterward.
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  const itemId = items[0]!.id;
  const runId = `run-${itemId}`;
  const lifecycleStatus = opts.lifecycleStatus ?? "failed";
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = ?, outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail', requested_human_action = 'inspect and resolve' WHERE id = ?"
  ).run(lifecycleStatus, runId, itemId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  return { campaignId: campaign.id, itemId, runId };
}

function seedAllEvidence(ticketId: string, runId: string): string {
  const commit = makeCommit(`impl-${ticketId}`);
  // closeTicket moves the file stories/ -> done/ atomically — writeTicket a second
  // time with status:'done' would leave the original stub behind as a duplicate.
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  return commit;
}

// ── FG-443: out-of-band (awaiting_gate/non-pipeline) helpers ───────────────────

// Builds a single-item paused campaign whose item is parked at the ONLY shape
// executor.ts:451-460's gate:human path produces: lifecycleStatus='awaiting_gate',
// no blockerKind. Distinct from setupBlockedCampaign, which always sets
// blocker_kind='scope' — that field's absence is exactly what routes an item to
// the out-of-band branch instead of the scope-blocked one.
function setupAwaitingGateCampaign(ticketId: string): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  const itemId = items[0]!.id;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required at step review' WHERE id = ?"
  ).run(itemId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  return { campaignId: campaign.id, itemId };
}

// FG-441: builds the OTHER shape that can leave an item 'awaiting_gate' with no
// blockerKind — one that was manually driven outside the resume loop after the
// campaign already attached its feature run: lifecycleStatus='awaiting_gate',
// no blockerKind, but WITH a runId (unlike setupAwaitingGateCampaign, which
// leaves run_id null). This is the shape `forge campaign resume` must reconcile
// from the run's own authoritative events instead of re-parking forever.
function setupAwaitingGateManualRunCampaign(ticketId: string): { campaignId: string; itemId: string; runId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  const itemId = items[0]!.id;
  const runId = `run-${itemId}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, run_id = ?, requested_human_action = 'Human gate required at step review' WHERE id = ?"
  ).run(runId, itemId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  return { campaignId: campaign.id, itemId, runId };
}

function makeBaseCommit(label: string): void {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
}

function commitDocsFile(relPath: string, content: string, message: string): string {
  const full = join(projectDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", message], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

// Delivers a ticket entirely via a docs-only commit (the non_code_diff lane) —
// requires a preceding base commit so the delivering commit has exactly one
// parent (a root commit is ambiguous and safe-denies in commitTouchesOnlyNonCodePaths).
function seedOutOfBandDocsEvidence(ticketId: string): string {
  makeBaseCommit(`base-${ticketId}`);
  const commit = commitDocsFile(`docs/${ticketId}.md`, `docs for ${ticketId}`, `docs: ${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  return commit;
}

// Delivers a ticket via a commit that touches code — requires the host-verification
// fallback lane to be satisfied.
function seedOutOfBandCodeEvidence(ticketId: string, opts: { recordVerification?: boolean } = {}): string {
  makeBaseCommit(`base-${ticketId}`);
  const srcPath = join(projectDir, "src", `${ticketId}.ts`);
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(srcPath, `export const ${ticketId.replace(/-/g, "_")} = 1;\n`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `feat: ${ticketId}`], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  closeTicket(projectDir, ticketId, commit);
  if (opts.recordVerification !== false) {
    insertHostVerification({
      ticketId,
      projectDir,
      commitSha: commit,
      gateName: "npm run test:all",
      command: "npm run test:all",
      exitCode: 0,
      recordedAt: "2026-01-01T00:00:00Z",
    });
  }
  return commit;
}

// ── campaign-level guard ────────────────────────────────────────────────────────

test("refuses a running (non-paused) campaign with zero items processed and zero mutation", () => {
  writeTicket(projectDir, { id: "FG-201", type: "story", status: "active", title: "t", body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-201"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id);

  const before = countEvents();
  const result = reconcileCampaign(campaign.id);

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not paused/);
  assert.deepEqual(result.items, []);
  assert.equal(countEvents(), before, "no event rows written");
});

test("concurrent flip: campaign leaves 'paused' between the up-front check and the atomic write — item is NOT mutated", () => {
  // reconcileCampaign checks campaign.status !== 'paused' once, up front. Real
  // concurrency (a second `forge` process running `campaign resume`) can flip that
  // status any time after. collectReconcileEvidence is a real per-item seam called
  // strictly after the up-front check and strictly before the guarded write, so
  // mutating the DB from inside it deterministically lands "another process's"
  // write in that exact gap — the same technique executor.test.ts's TOCTOU tests
  // use with `dispatch`.
  const ticketId = "FG-260";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);
  seedAllEvidence(ticketId, runId);

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const collectEvidence: typeof collectReconcileEvidence = (dir, item) => {
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
    return collectReconcileEvidence(dir, item);
  };

  const result = reconcileCampaign(campaignId, { collectEvidence });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /left 'paused'/);
  assert.deepEqual(result.items, [], "the item that lost the race must not be reported as shipped");
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical — zero mutation");
  assert.equal(countEvents(), beforeEvents, "no audit event logged for a write that never landed");
});

test("refuses an unknown campaign id", () => {
  const result = reconcileCampaign("campaign-does-not-exist");
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not found/);
  assert.deepEqual(result.items, []);
});

// ── 5 negative-evidence cases, each in isolation ────────────────────────────────

test("refuses when ticket.status !== 'done' — no state mutated", () => {
  const ticketId = "FG-210";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit("impl-210");
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", closedCommit: commit, title: ticketId, body: "" });
  insertHostVerification({ ticketId, projectDir, commitSha: commit, gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z" });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["ticket_status_not_done"]);

  const afterItem = getCampaignItem(itemId)!;
  assert.deepEqual(afterItem, beforeItem, "campaign_items row must be byte-identical after a refusal");
  assert.equal(countEvents(), beforeEvents, "no new event row written on refusal");
});

test("refuses when ticket.closedCommit is missing — no state mutated", () => {
  const ticketId = "FG-211";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  closeTicket(projectDir, ticketId);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.ok(result.items[0]!.missing!.includes("ticket_closed_commit_missing"));

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("refuses when closedCommit is not reachable on the base branch — no state mutated", () => {
  const ticketId = "FG-212";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  makeCommit("main-base-212");
  gitExec(["checkout", "-b", "feature/off-main-212"], projectDir);
  const offMainCommit = makeCommit("off-main-212");
  gitExec(["checkout", "main"], projectDir);

  closeTicket(projectDir, ticketId, offMainCommit);
  insertHostVerification({ ticketId, projectDir, commitSha: offMainCommit, gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z" });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  // FG-440 FIX1: closedCommit unreachable on base makes host-verification coverage
  // unreachable too — any row keyed to the same off-branch commit can never have a
  // testedSha that is itself on the base branch, so both facts fail together here.
  assert.deepEqual(result.items[0]!.missing, ["closed_commit_not_reachable_on_base_branch", "host_verification_not_recorded"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("refuses when host-verification is missing — no state mutated", () => {
  const ticketId = "FG-213";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit("impl-213");
  closeTicket(projectDir, ticketId, commit);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["host_verification_not_recorded"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("refuses when there is no superseding pass or qualifying force-advance — no state mutated", () => {
  const ticketId = "FG-214";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit("impl-214");
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({ ticketId, projectDir, commitSha: commit, gateName: "npm run test:all", command: "npm run test:all", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z" });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  // No later pass or qualifying force-advance.

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

// ── spoofing guard ───────────────────────────────────────────────────────────────

test("spoofing guard: a host_verifications row for the WRONG commit sha does not satisfy evidence", () => {
  const ticketId = "FG-215";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const realCommit = makeCommit("impl-215-real");
  closeTicket(projectDir, ticketId, realCommit);
  // Operator attempts to plant fake evidence under a sha that is NOT the ticket's actual closedCommit.
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "refused", "the query is keyed on the ticket's actual closedCommit, not any planted row");
  assert.deepEqual(result.items[0]!.missing, ["host_verification_not_recorded"]);
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
});

// ── positive case: both starting lifecycle shapes ────────────────────────────────

for (const lifecycleStatus of ["failed", "blocked_by_red"] as const) {
  test(`all-evidence-present ships + logs exactly one event, from the '${lifecycleStatus}' starting shape`, () => {
    const ticketId = `FG-22${lifecycleStatus === "failed" ? "0" : "1"}`;
    const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId, { lifecycleStatus });
    seedAllEvidence(ticketId, runId);

    const beforeEvents = countEvents();
    const result = reconcileCampaign(campaignId, { decidedBy: "steve" });

    assert.equal(result.ok, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.status, "shipped");
    assert.equal(result.items[0]!.missing, undefined);

    const item = getCampaignItem(itemId)!;
    assert.equal(item.lifecycleStatus, "complete");
    assert.equal(item.outcome, "shipped");
    assert.equal(item.blockerKind, undefined);
    assert.equal(item.reason, undefined);
    assert.equal(item.requestedHumanAction, undefined);

    assert.equal(countEvents(), beforeEvents + 1, "exactly one new event row");
    const evRow = db
      .prepare("SELECT event_type, payload FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as { event_type: string; payload: string };
    assert.equal(evRow.event_type, "campaign_item.evidence_reconciled");
    const payload = JSON.parse(evRow.payload) as { ticketId: string; decidedBy: string; evidence: unknown };
    assert.equal(payload.ticketId, ticketId);
    assert.equal(payload.decidedBy, "steve");
    assert.ok(payload.evidence, "evidence must be embedded in the audit payload");
  });
}

// ── not_applicable items are reported and untouched ───────────────────────────────

test("items not blockerKind='scope' are reported not_applicable and untouched", () => {
  writeTicket(projectDir, { id: "FG-230", type: "story", status: "active", title: "t", body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-230"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  db.prepare("UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'infrastructure' WHERE id = ?").run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  const beforeItem = getCampaignItem(items[0]!.id)!;
  const result = reconcileCampaign(campaign.id);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "not_applicable");
  assert.deepEqual(getCampaignItem(items[0]!.id)!, beforeItem);
});

// ── end-to-end: reconcile unblocks a downstream held item, resume proceeds ────────

test("end-to-end: reconciling a scope-blocked item unholds a downstream item and resumeCampaign proceeds to complete", async () => {
  const readyBody = "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n";
  writeTicket(projectDir, { id: "FG-240", type: "story", status: "active", title: "t1", body: readyBody });
  writeTicket(projectDir, { id: "FG-241", type: "story", status: "active", title: "t2", body: readyBody });
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-240", "FG-241"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved" });

  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string; ticket_id: string }[];
  const item1 = items.find((i) => i.ticket_id === "FG-240")!;
  const item2 = items.find((i) => i.ticket_id === "FG-241")!;
  const runId = `run-${item1.id}`;

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail' WHERE id = ?"
  ).run(runId, item1.id);
  // FG-241 held solely because of FG-240's failure (dependency-held, not readiness).
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = NULL, reason = 'held because dependency relation is unknown in sequential mode' WHERE id = ?"
  ).run(item2.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  seedAllEvidence("FG-240", runId);

  const reconcileResult = reconcileCampaign(campaign.id);
  assert.equal(reconcileResult.items.find((i) => i.ticketId === "FG-240")?.status, "shipped");

  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    // FG-483: a fabricated closedCommit no longer ships — give FG-241 real,
    // reachable, docs-only evidence (non_code_diff lane) via commitDocsFile.
    if (args.runTitle) {
      const commit = commitDocsFile(`docs/${args.runTitle}.md`, "docs", `docs: ${args.runTitle}`);
      closeTicket(projectDir, args.runTitle, commit);
    }
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch });

  assert.equal(resumeResult.stopReason, "complete", "campaign proceeds to complete once the blocker is reconciled");
  assert.deepEqual(dispatchLog, ["FG-241"], "FG-241 is dispatched — no longer held");

  const finalItem2 = getCampaignItem(item2.id)!;
  assert.notEqual(finalItem2.outcome, "held", "downstream item must no longer be held");
});

// ── FG-443: out-of-band (awaiting_gate/non-pipeline) eligibility branch ────────

// ── negative paths, each in isolation, zero mutation ────────────────────────────

test("out-of-band: refuses when ticket.status !== 'done' — no state mutated", () => {
  const ticketId = "FG-500";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);

  makeBaseCommit(`base-${ticketId}`);
  const commit = commitDocsFile(`docs/${ticketId}.md`, "docs", `docs: ${ticketId}`);
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", closedCommit: commit, title: ticketId, body: "" });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "refused");
  assert.ok(result.items[0]!.missing!.includes("ticket_status_not_done"));

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refusal");
  assert.equal(countEvents(), beforeEvents, "no event row written on refusal");
});

test("out-of-band: refuses when closedCommit is not reachable on the base branch — no state mutated", () => {
  const ticketId = "FG-501";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);

  makeBaseCommit(`base-${ticketId}`);
  gitExec(["checkout", "-b", "feature/off-main-oob-501"], projectDir);
  const offMainCommit = commitDocsFile(`docs/${ticketId}.md`, "docs off main", "docs change off main");
  gitExec(["checkout", "main"], projectDir);
  closeTicket(projectDir, ticketId, offMainCommit);

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["closed_commit_not_reachable_on_base_branch"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("out-of-band: refuses (lane evidence missing) — docs-only content still safe-denies on an ambiguous root commit", () => {
  const ticketId = "FG-502";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);

  // No base commit first — the closing commit is the repo's very first (root)
  // commit: zero parents is ambiguous for commitTouchesOnlyNonCodePaths, which
  // safe-denies regardless of the content being plain docs/*.md.
  const rootCommit = commitDocsFile(`docs/${ticketId}.md`, "docs", "root docs commit");
  closeTicket(projectDir, ticketId, rootCommit);

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

test("out-of-band: refuses (lane evidence missing) — commit touches code and no host verification is recorded", () => {
  const ticketId = "FG-503";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId, { recordVerification: false });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
  assert.equal(countEvents(), beforeEvents);
});

// ── positive path: docs lane, reaches 'complete' via unmodified driveRemainingItems ──

test("out-of-band: all-evidence-present (docs lane) ships via reconcileCampaign and the campaign reaches complete via the existing driveRemainingItems transition", async () => {
  const ticketId = "FG-510";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);
  seedOutOfBandDocsEvidence(ticketId);

  const beforeEvents = countEvents();
  const reconcileResult = reconcileCampaign(campaignId, { decidedBy: "steve" });

  assert.equal(reconcileResult.ok, true);
  assert.equal(reconcileResult.items.length, 1);
  assert.equal(reconcileResult.items[0]!.status, "shipped");
  assert.equal(reconcileResult.items[0]!.missing, undefined);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
  assert.equal(item.blockerKind, undefined);
  assert.equal(item.requestedHumanAction, undefined);

  assert.equal(countEvents(), beforeEvents + 1, "exactly one new event row");
  const evRow = db
    .prepare("SELECT event_type, payload FROM events ORDER BY id DESC LIMIT 1")
    .get() as { event_type: string; payload: string };
  assert.equal(evRow.event_type, "campaign_item.out_of_band_reconciled");
  const payload = JSON.parse(evRow.payload) as { ticketId: string; decidedBy: string; evidence: unknown };
  assert.equal(payload.ticketId, ticketId);
  assert.equal(payload.decidedBy, "steve");
  assert.ok(payload.evidence, "evidence must be embedded in the audit payload");

  // Campaign-level completion happens exclusively via the SAME unmodified
  // driveRemainingItems bottom-of-loop transition the scope-blocked end-to-end
  // test above exercises — reconcileCampaign's out-of-band branch never calls
  // tryTransitionCampaign itself.
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-fake",
    taskId: "task-fake",
    status: "complete",
  });
  const resumeResult = await resumeCampaign(campaignId, { dispatch });
  assert.equal(resumeResult.stopReason, "complete");
  assert.equal(getCampaign(campaignId)!.status, "complete", "campaign reaches complete once its only item is terminal");
});

test("out-of-band: all-evidence-present (host-verification lane) ships via reconcileCampaign", () => {
  const ticketId = "FG-511";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId);

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

// ── coexistence: an out-of-band item and a scope-blocked item in the same call ──

test("out-of-band: coexists with a scope-blocked item in the same reconcileCampaign call, each routed to its own evaluator", () => {
  writeTicket(projectDir, { id: "FG-520", type: "story", status: "active", title: "t1", body: "" });
  writeTicket(projectDir, { id: "FG-521", type: "story", status: "active", title: "t2", body: "" });
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-520", "FG-521"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved" });

  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string; ticket_id: string }[];
  const scopeItem = items.find((i) => i.ticket_id === "FG-520")!;
  const oobItem = items.find((i) => i.ticket_id === "FG-521")!;
  const scopeRunId = `run-${scopeItem.id}`;

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail' WHERE id = ?"
  ).run(scopeRunId, scopeItem.id);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required' WHERE id = ?"
  ).run(oobItem.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  seedAllEvidence("FG-520", scopeRunId);
  seedOutOfBandDocsEvidence("FG-521");

  const result = reconcileCampaign(campaign.id);
  assert.equal(result.items.length, 2);

  const scopeResult = result.items.find((i) => i.ticketId === "FG-520")!;
  const oobResult = result.items.find((i) => i.ticketId === "FG-521")!;
  assert.equal(scopeResult.status, "shipped");
  assert.equal(oobResult.status, "shipped");

  const scopeEvent = db
    .prepare("SELECT event_type FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(scopeRunId) as { event_type: string };
  assert.equal(scopeEvent.event_type, "campaign_item.evidence_reconciled", "scope-blocked item routes through the unchanged evidence-reconciled path");

  const oobEvent = db
    .prepare("SELECT event_type FROM events WHERE run_id IS NULL ORDER BY id DESC LIMIT 1")
    .get() as { event_type: string };
  assert.equal(oobEvent.event_type, "campaign_item.out_of_band_reconciled", "out-of-band item routes through the distinct out-of-band-reconciled path");
});

// ── paused-guard race, for the out-of-band branch specifically ─────────────────

test("out-of-band: concurrent flip — campaign leaves 'paused' between the up-front check and the atomic write — item is NOT mutated", () => {
  const ticketId = "FG-530";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);
  seedOutOfBandDocsEvidence(ticketId);

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const collectOutOfBand: typeof collectOutOfBandEvidence = (dir, item) => {
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
    return collectOutOfBandEvidence(dir, item);
  };

  const result = reconcileCampaign(campaignId, { collectOutOfBandEvidence: collectOutOfBand });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /left 'paused'/);
  assert.deepEqual(result.items, [], "the item that lost the race must not be reported as shipped");
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical — zero mutation");
  assert.equal(countEvents(), beforeEvents, "no audit event logged for a write that never landed");
});

// ── not_applicable: awaiting_gate items WITH a blockerKind are not out-of-band candidates ──

test("out-of-band: an awaiting_gate item that DOES carry a blockerKind is reported not_applicable (not out-of-band-eligible)", () => {
  writeTicket(projectDir, { id: "FG-540", type: "story", status: "active", title: "t", body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-540"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', blocker_kind = 'campaign_system', requested_human_action = 'inspect' WHERE id = ?"
  ).run(items[0]!.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  const beforeItem = getCampaignItem(items[0]!.id)!;
  const result = reconcileCampaign(campaign.id);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "not_applicable");
  assert.deepEqual(getCampaignItem(items[0]!.id)!, beforeItem);
});

// ── FG-440: reconcile-time host-verification capture ───────────────────────────
//
// A forge-observed merge (campaign-driven, or force-advanced then merged through
// forge) leaves closedCommit reachable on base but no PASSING host_verifications
// row that covers it. reconcileCampaign must run the required gate in projectDir
// at its current, CLEAN HEAD, itself reachable on the base branch — never a
// checkout of closedCommit, which would have no node_modules and false-fail every
// npm-based gate — and record + re-evaluate in the SAME call. The recorded
// commitSha is whatever HEAD actually was (often one commit later than
// closedCommit, e.g. the commit that closed the ticket itself); ancestry PLUS
// base-branch-reachability of that commitSha, not equality to closedCommit, is
// what makes it count as covering evidence. This is a passing-row model: a
// covering row that failed does not block a later re-run, and coexists
// alongside a later covering row that passes — existence of a pass is what
// ships, not unanimity across every row ever recorded.

function commitGateScript(label: string, scriptBody: string): string {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.0.0", scripts: { "test:all": scriptBody } }, null, 2)
  );
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

// closeTicket only writes/moves the ticket file — it never commits. In real
// usage a ticket's close lands in the same commit history as the code it
// closed; these fixtures mirror that by committing the pending ticket-file
// change so projectDir's working tree is CLEAN before reconcileCampaign
// triggers a real gate capture (the capture refuses to run against a dirty tree).
function commitPendingChanges(message: string): string {
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", message], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

test("FG-440: item merged-but-unverified (closedCommit reachable, no covering row) gets captured for real in projectDir at HEAD and ships within one reconcileCampaign call", () => {
  const ticketId = "FG-610";
  const { campaignId, runId } = setupBlockedCampaign(ticketId);

  const commit = commitGateScript(`impl-${ticketId}`, "exit 0");
  closeTicket(projectDir, ticketId, commit);
  const testedHead = commitPendingChanges(`close ${ticketId}`);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  assert.equal(
    queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all").length,
    0,
    "precondition: no row exists yet"
  );

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped", "the captured gate passed for real, in the same reconcileCampaign call");

  const rows = queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all");
  assert.equal(rows.length, 1, "exactly one real row written from the actual gate run");
  assert.equal(rows[0]!.exitCode, 0);
  assert.equal(rows[0]!.gateName, "npm run test:all", "gateName is the configured requiredHostGate string, never the executed argv");
  assert.equal(rows[0]!.commitSha, testedHead, "recorded commitSha is the REAL tested HEAD");
  assert.notEqual(rows[0]!.commitSha, commit, "the tested HEAD advanced one commit past closedCommit (the ticket-close commit) — never record closedCommit itself as though it were tested");
});

test("FG-440: capture SKIP (no requiredHostGate script in projectDir) writes no row — item stays refused with host_verification_not_recorded", () => {
  const ticketId = "FG-611";
  const { campaignId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit(`impl-${ticketId}`); // no package.json at all
  closeTicket(projectDir, ticketId, commit);
  commitPendingChanges(`close ${ticketId}`); // tree clean — the skip is due to the missing script, not a dirty tree
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["host_verification_not_recorded"]);
  assert.equal(
    queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all").length,
    0,
    "a skip must never write a synthetic pass row"
  );
});

test("FG-440: capture runs the gate for real and it FAILS — records the failing row at the real tested HEAD; item stays refused with host_verification_recorded_but_failed (distinct from not_recorded)", () => {
  const ticketId = "FG-612";
  const { campaignId, runId } = setupBlockedCampaign(ticketId);

  const commit = commitGateScript(`impl-${ticketId}`, "exit 3");
  closeTicket(projectDir, ticketId, commit);
  const testedHead = commitPendingChanges(`close ${ticketId}`);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["host_verification_recorded_but_failed"]);

  const rows = queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 3, "the actual non-zero exit code must be recorded, never a fabricated pass");
  assert.equal(rows[0]!.commitSha, testedHead);
});

test("FG-440: a force-advance gate.decided event does not cause a host-verification row to be written or a skip to be treated as a pass", () => {
  const ticketId = "FG-613";
  const { campaignId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit(`impl-${ticketId}`); // no package.json → skip
  closeTicket(projectDir, ticketId, commit);
  commitPendingChanges(`close ${ticketId}`);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("gate.decided", { runId, payload: { decision: "advance", rationale: "operator override: verified out of band", force: true } });

  const result = reconcileCampaign(campaignId);
  // Force-advance satisfies fact 5 (supersession) but host-verification is an
  // INDEPENDENT fact — the item must still refuse on the host-verification gap.
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["host_verification_not_recorded"]);
  assert.equal(queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all").length, 0);
});

test("FG-440: a row that already covers closedCommit (pass or fail) is never re-run — the injected writer is not invoked", () => {
  const ticketId = "FG-614";
  const { campaignId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit(`impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  let invoked = false;
  const spyRunGate: typeof runAndRecordHostVerification = (dir, ticket, opts) => {
    invoked = true;
    return runAndRecordHostVerification(dir, ticket, opts);
  };

  const result = reconcileCampaign(campaignId, { runAndRecordHostVerification: spyRunGate });
  assert.equal(result.items[0]!.status, "shipped");
  assert.equal(invoked, false, "an already-covering row (real pass) must never trigger a re-run of the gate");
});

test("FG-440 FIX2: a failing covering row does not permanently wedge the item — a subsequent reconcileCampaign call re-runs the gate, and a later real green ships it (a passing row coexisting with an older failing row still ships)", () => {
  const ticketId = "FG-650";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const failingCommit = commitGateScript(`impl-${ticketId}`, "exit 5");
  closeTicket(projectDir, ticketId, failingCommit);
  const failingTestedHead = commitPendingChanges(`close ${ticketId}`);
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const firstResult = reconcileCampaign(campaignId);
  assert.equal(firstResult.items[0]!.status, "refused", "the gate ran for real and failed");
  assert.deepEqual(firstResult.items[0]!.missing, ["host_verification_recorded_but_failed"]);

  let rows = queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 5);
  assert.equal(rows[0]!.commitSha, failingTestedHead);

  // Operator fixes the gate and advances HEAD further — no new evidence needed,
  // reconcile re-derives everything.
  const passingTestedHead = commitGateScript(`fix-${ticketId}`, "exit 0");

  const secondResult = reconcileCampaign(campaignId);
  assert.equal(
    secondResult.items[0]!.status,
    "shipped",
    "the earlier failing row must not permanently wedge the item — a later real green must ship it"
  );

  rows = queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all");
  assert.equal(rows.length, 2, "the old failing row is never overwritten — it coexists alongside the new passing row");
  const failing = rows.find((r) => r.exitCode === 5)!;
  const passing = rows.find((r) => r.exitCode === 0)!;
  assert.equal(failing.commitSha, failingTestedHead);
  assert.equal(passing.commitSha, passingTestedHead);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-440: an infra error thrown by the gate invocation does not crash reconcileCampaign — that item degrades to not_recorded and OTHER items in the same call still process", () => {
  writeTicket(projectDir, { id: "FG-615", type: "story", status: "active", title: "t1", body: "" });
  writeTicket(projectDir, { id: "FG-616", type: "story", status: "active", title: "t2", body: "" });
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-615", "FG-616"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved" });

  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string; ticket_id: string }[];
  const item1 = items.find((i) => i.ticket_id === "FG-615")!;
  const item2 = items.find((i) => i.ticket_id === "FG-616")!;
  const run1 = `run-${item1.id}`;
  const run2 = `run-${item2.id}`;

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail' WHERE id = ?"
  ).run(run1, item1.id);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail' WHERE id = ?"
  ).run(run2, item2.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  // FG-615: closedCommit reachable, no covering row — capture will be attempted
  // and the injected stub throws for exactly this ticket.
  const commit1 = makeCommit("impl-FG-615");
  closeTicket(projectDir, "FG-615", commit1);
  commitPendingChanges("close FG-615");
  logEvent("verdict.received", { runId: run1, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId: run1, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  // FG-616: all evidence already seeded directly — capture is never attempted
  // for it, so the throwing stub is never invoked on its behalf either.
  seedAllEvidence("FG-616", run2);

  const throwingRunGate: typeof runAndRecordHostVerification = (dir, ticketId, opts) => {
    if (ticketId === "FG-615") throw new Error("simulated infra failure (e.g. git unreachable)");
    return runAndRecordHostVerification(dir, ticketId, opts);
  };

  const result = reconcileCampaign(campaign.id, { runAndRecordHostVerification: throwingRunGate });
  assert.equal(result.ok, true, "reconcileCampaign must not crash on an infra error thrown by the gate invocation");
  assert.equal(result.items.length, 2, "both items are still processed — the throw degrades only FG-615, never the loop");

  const r1 = result.items.find((i) => i.ticketId === "FG-615")!;
  const r2 = result.items.find((i) => i.ticketId === "FG-616")!;
  assert.equal(r1.status, "refused", "FG-615's capture threw — it degrades to its normal not_recorded refusal, never a crash");
  assert.deepEqual(r1.missing, ["host_verification_not_recorded"]);
  assert.equal(r2.status, "shipped", "FG-616 never needed capture and ships normally, proving the loop reached it after FG-615's error");
});

// ── FG-427: per-task supersession proven through the REAL reconcileCampaign
// command (not the unit-level evaluateReconcileEvidence/evaluateAuthoritativeOutcome
// tests in reconcile-evidence.test.ts) — real logEvent-written events, real taskId
// threading through collectReconcileEvidence -> collectAuthoritativeEvents, so the
// wiring the ticket calls out ("via the drive path AND via the reconcile command")
// is exercised end to end on this path too, not just at the drive path
// (executor.workflow.test.ts) and in isolation.

// Same shape as seedAllEvidence but withholds the verdict/gate events — callers
// seed those themselves so they can attach taskId and exercise supersession.
function seedEvidenceExceptSupersession(ticketId: string): string {
  const commit = makeCommit(`impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  return commit;
}

test("FG-427: fail/authoritative then later pass/authoritative on the SAME task ships via the real reconcileCampaign command", () => {
  const ticketId = "FG-901";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);
  seedEvidenceExceptSupersession(ticketId);
  logEvent("verdict.received", { runId, taskId: "task-fg427-901", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, taskId: "task-fg427-901", payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });

  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "shipped");
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-427: fail/authoritative then later qualifying force-advance on the SAME task ships via the real reconcileCampaign command", () => {
  const ticketId = "FG-902";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);
  seedEvidenceExceptSupersession(ticketId);
  logEvent("verdict.received", { runId, taskId: "task-fg427-902", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("gate.decided", { runId, taskId: "task-fg427-902", payload: { decision: "advance", rationale: "operator override: verified out of band", force: true } });

  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "shipped");
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-427: masking regression via the real reconcileCampaign command — task A's later pass never masks task B's unresolved fail in the same run", () => {
  const ticketId = "FG-903";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);
  seedEvidenceExceptSupersession(ticketId);
  logEvent("verdict.received", { runId, taskId: "task-fg427-903-a", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, taskId: "task-fg427-903-a", payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  logEvent("verdict.received", { runId, taskId: "task-fg427-903-b", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "task A's pass must not launder task B's unresolved fail — zero mutation");
});

test("FG-427: a force-advance without rationale on a task with a prior authoritative fail does not supersede it via the real reconcileCampaign command", () => {
  const ticketId = "FG-904";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);
  seedEvidenceExceptSupersession(ticketId);
  logEvent("verdict.received", { runId, taskId: "task-fg427-904", payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("gate.decided", { runId, taskId: "task-fg427-904", payload: { decision: "advance", rationale: "", force: true } });

  const beforeItem = getCampaignItem(itemId)!;
  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
});

test("FG-440: report.ts AND campaign show render distinct host-verification hints for not_recorded vs recorded_but_failed scope-blocked items", () => {
  const notRecordedTicket = "FG-620";
  const { campaignId: campaignIdA, runId: runIdA } = setupBlockedCampaign(notRecordedTicket);
  const commitA = makeCommit(`impl-${notRecordedTicket}`); // no package.json → skip → not_recorded
  closeTicket(projectDir, notRecordedTicket, commitA);
  commitPendingChanges(`close ${notRecordedTicket}`);
  logEvent("verdict.received", { runId: runIdA, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId: runIdA, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });
  reconcileCampaign(campaignIdA);

  const reportA = assembleCampaignReport(campaignIdA)!;
  const rowA = reportA.items.find((i) => i.ticketId === notRecordedTicket)!;
  assert.match(
    rowA.hostVerificationReconcileHint ?? "",
    /forge campaign reconcile/,
    "not_recorded hint must point at the automatic capture on the next reconcile/drive run"
  );

  const showA = assembleCampaignShow(campaignIdA)!;
  const showRowA = showA.items.find((i) => i.ticketId === notRecordedTicket)!;
  assert.equal(
    showRowA.hostVerificationReconcileHint,
    rowA.hostVerificationReconcileHint,
    "campaign show must render the SAME operator-facing text as campaign report for not_recorded"
  );

  const failedTicket = "FG-621";
  const { campaignId: campaignIdB, runId: runIdB } = setupBlockedCampaign(failedTicket);
  const commitB = commitGateScript(`impl-${failedTicket}`, "exit 9");
  closeTicket(projectDir, failedTicket, commitB);
  commitPendingChanges(`close ${failedTicket}`);
  logEvent("verdict.received", { runId: runIdB, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId: runIdB, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });
  reconcileCampaign(campaignIdB);

  const reportB = assembleCampaignReport(campaignIdB)!;
  const rowB = reportB.items.find((i) => i.ticketId === failedTicket)!;
  assert.ok(rowB.hostVerificationReconcileHint, "recorded_but_failed hint must be present");
  assert.notEqual(
    rowB.hostVerificationReconcileHint,
    rowA.hostVerificationReconcileHint,
    "the two reason codes must render distinct operator-facing text"
  );
  assert.doesNotMatch(
    rowB.hostVerificationReconcileHint!,
    /will be captured/i,
    "a genuine gate failure must never be rendered as something pending automatic capture"
  );

  const showB = assembleCampaignShow(campaignIdB)!;
  const showRowB = showB.items.find((i) => i.ticketId === failedTicket)!;
  assert.equal(
    showRowB.hostVerificationReconcileHint,
    rowB.hostVerificationReconcileHint,
    "campaign show must render the SAME operator-facing text as campaign report for recorded_but_failed"
  );
  assert.notEqual(
    showRowB.hostVerificationReconcileHint,
    showRowA.hostVerificationReconcileHint,
    "campaign show itself must distinguish the two reason codes, not just report"
  );
});

// ── FG-452: out-of-band CODE-TOUCHING lane brought to parity with the
// scope-blocked lane — reconcile-time host-verification capture (AC1), ancestry
// + base-reachability matching in place of exact-sha (AC2, negative in AC3),
// non_code_diff untouched (AC4), operator-surface hint (AC5), and the FG-422
// live-repro shape (AC6): out-of-band, code-touching, closedCommit reachable on
// base, no prior passing row — exactly what wedged campaign-922c83b7c577.

test("FG-452 AC1/AC6 (FG-422 live-repro shape): out-of-band code-touching item with no covering row gets captured for real in projectDir at HEAD and ships within one reconcileCampaign call", async () => {
  const ticketId = "FG-700";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);

  const commit = commitGateScript(`impl-${ticketId}`, "exit 0");
  closeTicket(projectDir, ticketId, commit);
  // Mirrors FG-422: the ticket-close commit lands one commit behind projectDir's
  // actual current HEAD by the time reconcile runs.
  const testedHead = commitPendingChanges(`close ${ticketId}`);

  assert.equal(
    queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all").length,
    0,
    "precondition: no row exists yet — exactly FG-422's wedge shape (merged and closed, but no host-verification row)"
  );

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped", "the captured gate passed for real, in the same reconcileCampaign call");

  const rows = queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all");
  assert.equal(rows.length, 1, "exactly one real row written from the actual gate run");
  assert.equal(rows[0]!.exitCode, 0);
  assert.equal(rows[0]!.commitSha, testedHead, "recorded commitSha is the REAL tested HEAD");
  assert.notEqual(
    rows[0]!.commitSha,
    commit,
    "the tested HEAD advanced one commit past closedCommit — an exact-sha match against closedCommit could never have found this row (the FG-452 bug)"
  );

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");

  // Drive the campaign itself to 'complete' (same mechanism as the out-of-band
  // end-to-end test above — reconcileCampaign never transitions the campaign
  // itself; only resumeCampaign's bottom-of-loop check does) and prove the
  // done-audit surface built on the SAME captured row agrees the item's host
  // verification is satisfied. src/done-audit/collect.ts's host-verification
  // lookup used to match rows by EXACT commit_sha === closedCommit — the row
  // above is recorded at testedHead, one commit past closedCommit, so an
  // exact-sha lookup would find nothing and report host_verification as
  // "unknown" even though it shipped on a real passing gate. (pushed/
  // container_verification are independently "unknown" in this fixture — no
  // remote, no container run — that's unrelated to this check and expected.)
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-fake",
    taskId: "task-fake",
    status: "complete",
  });
  const resumeResult = await resumeCampaign(campaignId, { dispatch });
  assert.equal(resumeResult.stopReason, "complete");
  assert.equal(getCampaign(campaignId)!.status, "complete");

  const report = assembleCampaignReport(campaignId)!;
  const reportItem = report.items.find((i) => i.ticketId === ticketId)!;
  const hostCheck = reportItem.doneAuditState?.checks.find((c) => c.name === "host_verification");
  assert.equal(
    hostCheck?.status,
    "pass",
    `the captured host-verification row must be found via ancestry, not exact-sha: ${JSON.stringify(reportItem.doneAuditState)}`
  );
  assert.match(
    hostCheck?.detail ?? "",
    /exit_code: 0/,
    `host_verification detail must reflect the real captured row: ${hostCheck?.detail}`
  );
});

test("FG-452 AC1: capture SKIP (no requiredHostGate script in projectDir) writes no row — out-of-band item stays refused with lane_evidence_missing", () => {
  const ticketId = "FG-701";
  const { campaignId } = setupAwaitingGateCampaign(ticketId);

  const commit = makeCommit(`impl-${ticketId}`); // no package.json at all
  closeTicket(projectDir, ticketId, commit);
  commitPendingChanges(`close ${ticketId}`); // tree clean — the skip is due to the missing script, not a dirty tree

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(
    queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all").length,
    0,
    "a skip must never write a synthetic pass row"
  );
});

test("FG-452 AC1: an already-covering PASSING row is never re-run — the injected gate writer is not invoked", () => {
  const ticketId = "FG-702";
  const { campaignId } = setupAwaitingGateCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId); // records verification at the exact closedCommit — trivially self-covering

  let invoked = false;
  const spyRunGate: typeof runAndRecordHostVerification = (dir, ticket, opts) => {
    invoked = true;
    return runAndRecordHostVerification(dir, ticket, opts);
  };

  const result = reconcileCampaign(campaignId, { runAndRecordHostVerification: spyRunGate });
  assert.equal(result.items[0]!.status, "shipped");
  assert.equal(invoked, false, "an already-covering row (real pass) must never trigger a re-run of the gate");
});

test("FG-452 AC1: an infra error thrown by the gate invocation in the OUT-OF-BAND branch does not crash reconcileCampaign — that item degrades to its normal refusal and OTHER items in the same call still process", () => {
  writeTicket(projectDir, { id: "FG-703", type: "story", status: "active", title: "t1", body: "" });
  writeTicket(projectDir, { id: "FG-704", type: "story", status: "active", title: "t2", body: "" });
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-703", "FG-704"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved" });

  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string; ticket_id: string }[];
  const item1 = items.find((i) => i.ticket_id === "FG-703")!;
  const item2 = items.find((i) => i.ticket_id === "FG-704")!;

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required' WHERE id = ?"
  ).run(item1.id);
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required' WHERE id = ?"
  ).run(item2.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  // FG-703: code-touching, no covering row — capture will be attempted, and the
  // injected stub throws for exactly this ticket.
  seedOutOfBandCodeEvidence("FG-703", { recordVerification: false });
  // FG-704: docs lane already satisfied — capture is never attempted for it (AC4),
  // so the throwing stub is never invoked on its behalf either.
  seedOutOfBandDocsEvidence("FG-704");

  const throwingRunGate: typeof runAndRecordHostVerification = (dir, ticketId, opts) => {
    if (ticketId === "FG-703") throw new Error("simulated infra failure (e.g. git unreachable)");
    return runAndRecordHostVerification(dir, ticketId, opts);
  };

  const result = reconcileCampaign(campaign.id, { runAndRecordHostVerification: throwingRunGate });
  assert.equal(result.ok, true, "reconcileCampaign must not crash on an infra error thrown by the out-of-band gate invocation");
  assert.equal(result.items.length, 2, "both items are still processed — the throw degrades only FG-703, never the loop");

  const r1 = result.items.find((i) => i.ticketId === "FG-703")!;
  const r2 = result.items.find((i) => i.ticketId === "FG-704")!;
  assert.equal(r1.status, "refused", "FG-703's capture threw — it degrades to its normal lane_evidence_missing refusal, never a crash");
  assert.deepEqual(r1.missing, ["lane_evidence_missing"]);
  assert.equal(r2.status, "shipped", "FG-704 never needed capture and ships normally, proving the loop reached it after FG-703's error");
});

test("FG-452 FIX2 parity: a failing covering row does not permanently wedge an out-of-band code-touching item — a subsequent reconcileCampaign call re-runs the gate, and a later real green ships it", () => {
  const ticketId = "FG-705";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);

  const failingCommit = commitGateScript(`impl-${ticketId}`, "exit 5");
  closeTicket(projectDir, ticketId, failingCommit);
  const failingTestedHead = commitPendingChanges(`close ${ticketId}`);

  const firstResult = reconcileCampaign(campaignId);
  assert.equal(firstResult.items[0]!.status, "refused", "the gate ran for real and failed");
  assert.deepEqual(firstResult.items[0]!.missing, ["lane_evidence_missing"]);

  let rows = queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 5);
  assert.equal(rows[0]!.commitSha, failingTestedHead);

  // Operator fixes the gate and advances HEAD further — no new evidence needed,
  // reconcile re-derives everything.
  const passingTestedHead = commitGateScript(`fix-${ticketId}`, "exit 0");

  const secondResult = reconcileCampaign(campaignId);
  assert.equal(
    secondResult.items[0]!.status,
    "shipped",
    "the earlier failing row must not permanently wedge the out-of-band item — a later real green must ship it"
  );

  rows = queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all");
  assert.equal(rows.length, 2, "the old failing row is never overwritten — it coexists alongside the new passing row");
  const failing = rows.find((r) => r.exitCode === 5)!;
  const passing = rows.find((r) => r.exitCode === 0)!;
  assert.equal(failing.commitSha, failingTestedHead);
  assert.equal(passing.commitSha, passingTestedHead);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-452 AC4: out-of-band non_code_diff sub-lane never triggers capture — the injected gate writer is not invoked, and it still completes on lane evidence alone", () => {
  const ticketId = "FG-706";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);
  seedOutOfBandDocsEvidence(ticketId);

  let invoked = false;
  const spyRunGate: typeof runAndRecordHostVerification = (dir, ticket, opts) => {
    invoked = true;
    return runAndRecordHostVerification(dir, ticket, opts);
  };

  const result = reconcileCampaign(campaignId, { runAndRecordHostVerification: spyRunGate });
  assert.equal(result.items[0]!.status, "shipped");
  assert.equal(invoked, false, "the non_code_diff lane needs no host verification — capture must never be attempted for it");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-452 AC5: forge campaign show / report surface a host-verification-specific hint (not generic architect-gate text) for an out-of-band code-touching item not yet verified", () => {
  const ticketId = "FG-707";
  const { campaignId } = setupAwaitingGateCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId, { recordVerification: false });

  const show = assembleCampaignShow(campaignId)!;
  const showRow = show.items.find((i) => i.ticketId === ticketId)!;
  assert.match(
    showRow.hostVerificationReconcileHint ?? "",
    /forge campaign reconcile/,
    "campaign show must point the operator at reconcile for host-verification capture, not the generic architect-gate text"
  );
  assert.equal(showRow.requestedHumanAction, "Human gate required at step review", "the generic gate text is still present alongside the new hint, not replaced by it");
  assert.match(
    show.nextAction,
    /forge campaign reconcile/,
    "the top-level campaign show next-action must also point at reconcile, not the generic gate text"
  );

  const report = assembleCampaignReport(campaignId)!;
  const reportRow = report.items.find((i) => i.ticketId === ticketId)!;
  assert.equal(
    reportRow.hostVerificationReconcileHint,
    showRow.hostVerificationReconcileHint,
    "campaign report must render the SAME operator-facing text as campaign show"
  );
  assert.match(
    report.nextOperatorAction,
    /forge campaign reconcile/,
    "the top-level campaign report next-operator-action must also point at reconcile, not the generic gate text"
  );
  assert.equal(
    report.nextOperatorAction,
    show.nextAction,
    "the two top-level next-action surfaces must agree word-for-word"
  );

  const humanLines = renderCampaignReportHuman(report);
  const hintLine = humanLines.find((l) => l.includes("host-verification-status:"));
  assert.ok(hintLine, "the human-rendered report must include a host-verification-status line for this item");
  assert.match(hintLine!, /forge campaign reconcile/);
});

test("FG-452 AC5: the hint disappears once the item ships via reconcile — it must not linger and mislead after the gap it names is closed", () => {
  const ticketId = "FG-708";
  const { campaignId } = setupAwaitingGateCampaign(ticketId);

  const commit = commitGateScript(`impl-${ticketId}`, "exit 0");
  closeTicket(projectDir, ticketId, commit);
  commitPendingChanges(`close ${ticketId}`);

  const beforeShow = assembleCampaignShow(campaignId)!;
  assert.match(
    beforeShow.items.find((i) => i.ticketId === ticketId)!.hostVerificationReconcileHint ?? "",
    /forge campaign reconcile/
  );

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped");

  const afterShow = assembleCampaignShow(campaignId)!;
  const afterRow = afterShow.items.find((i) => i.ticketId === ticketId)!;
  assert.equal(afterRow.lifecycleStatus, "complete");
  assert.equal(
    afterRow.hostVerificationReconcileHint,
    null,
    "once shipped the item is no longer awaiting_gate — the hint's guard clause returns null"
  );
});

// ── FG-441: campaign resume reconciles a manually-driven awaiting_gate item ──────
//
// A campaign item can be driven manually OUTSIDE the resume loop after the
// campaign already attached its feature run: stored awaiting_gate/no blockerKind
// with a runId, but the run was later driven manually through
// gates/fixers/red/host-verification/PR-merge/backlog-close. `forge campaign
// resume` must re-derive shipped-ness from the SAME durable evidence
// `collectReconcileEvidence`/`evaluateReconcileEvidence` (FG-428) uses — the run's
// own authoritative verdict/gate events — instead of re-parking it forever via
// driveWorkflowItem's gate:human branch.

test("FG-441: resume ships a manually-driven awaiting_gate item with complete evidence and unholds a downstream dependent", async () => {
  const readyBody = "## Problem\nNeeds implementation.\n\n## Goal\nComplete it.\n\n## Acceptance Criteria\n- Done\n";
  writeTicket(projectDir, { id: "FG-600", type: "story", status: "active", title: "t1", body: readyBody });
  writeTicket(projectDir, { id: "FG-601", type: "story", status: "active", title: "t2", body: readyBody });
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-600", "FG-601"] },
    { projectDir, mode: "sequential" }
  );
  approveCampaign(campaign.id, { rationale: "approved" });

  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string; ticket_id: string }[];
  const item1 = items.find((i) => i.ticket_id === "FG-600")!;
  const item2 = items.find((i) => i.ticket_id === "FG-601")!;
  const runId = `run-${item1.id}`;

  // item1: manually-driven awaiting_gate — no blockerKind, but a real runId.
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, run_id = ?, requested_human_action = 'Human gate required at step review' WHERE id = ?"
  ).run(runId, item1.id);
  // item2: held solely because item1 hadn't reached a terminal state (dependency-held).
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'pending', outcome = 'held', blocker_kind = NULL, reason = 'held because dependency relation is unknown in sequential mode' WHERE id = ?"
  ).run(item2.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);

  seedAllEvidence("FG-600", runId);

  const beforeEvents = countEvents();
  const dispatchLog: string[] = [];
  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchLog.push(args.runTitle ?? "");
    // FG-483: a fabricated closedCommit no longer ships — give FG-601 real,
    // reachable, docs-only evidence (non_code_diff lane) via commitDocsFile.
    if (args.runTitle) {
      const commit = commitDocsFile(`docs/${args.runTitle}.md`, "docs", `docs: ${args.runTitle}`);
      closeTicket(projectDir, args.runTitle, commit);
    }
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaign.id, { dispatch });

  assert.equal(
    resumeResult.stopReason,
    "complete",
    "campaign proceeds to complete once the manually-driven item is reconciled from evidence"
  );

  const finalItem1 = getCampaignItem(item1.id)!;
  assert.equal(finalItem1.lifecycleStatus, "complete", "item is shipped, not re-parked at awaiting_gate");
  assert.equal(finalItem1.outcome, "shipped");
  assert.equal(finalItem1.blockerKind, undefined);

  assert.deepEqual(dispatchLog, ["FG-601"], "downstream dependent is released and dispatched — no hand-rolled release needed");
  const finalItem2 = getCampaignItem(item2.id)!;
  assert.notEqual(finalItem2.outcome, "held", "downstream item must no longer be held");

  // FG-483: FG-601 now ships via the SAME evidence-gated invoke-lane finalize
  // (decidedBy: 'campaign_drive') instead of the old frontmatter-only check, so
  // it logs its own campaign_item.evidence_reconciled event alongside FG-600's
  // reattach-path one (decidedBy: 'campaign_resume') — two new events, not one.
  assert.equal(
    countEvents(),
    beforeEvents + 2,
    "one audit event for the manually-driven FG-600 reattach-reconcile, one for FG-601's invoke-lane ship"
  );
  const evRow = db
    .prepare("SELECT event_type, payload FROM events WHERE event_type = 'campaign_item.evidence_reconciled' AND payload LIKE '%\"decidedBy\":\"campaign_resume\"%' ORDER BY id DESC LIMIT 1")
    .get() as { event_type: string; payload: string } | undefined;
  assert.ok(evRow, "campaign_item.evidence_reconciled event logged for the resume-path reconcile");
  const payload = JSON.parse(evRow!.payload) as { ticketId: string; campaignId: string; decidedBy: string };
  assert.equal(payload.ticketId, "FG-600");
  assert.equal(payload.campaignId, campaign.id);
});

test("FG-460: resume SHIPS a docs-only (non_code_diff) awaiting_gate item with a clean authoritative outcome and NO host-verification row — matching reconcile", async () => {
  // makeCommit writes a .txt (non_code_diff lane). Before FG-460, resume used
  // evaluateReconcileEvidence — lane-blind, always demanding a host-verification
  // row — so it wrongly REFUSED this docs-only item that `forge campaign reconcile`
  // already ships (a docs-only commit needs no host gate; FG-452). FG-460 unifies
  // resume onto the same out-of-band composition, so it now ships it too.
  const ticketId = "FG-610";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);

  seedOutOfBandDocsEvidence(ticketId); // base + docs-only commit (non_code_diff lane), ticket closed
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  // NO host-verification row — the whole point: a docs-only item must not need one.

  const beforeEvents = countEvents();
  let dispatched = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatched++;
    return { runId: "r", taskId: "t", status: "complete" };
  };

  await resumeCampaign(campaignId, { dispatch });

  const afterItem = getCampaignItem(itemId)!;
  assert.equal(afterItem.lifecycleStatus, "complete", "docs-only item with a clean authoritative outcome must ship on resume");
  assert.equal(afterItem.outcome, "shipped");

  assert.equal(countEvents(), beforeEvents + 1, "exactly one durable event logged");
  const evRow = db
    .prepare("SELECT event_type, payload FROM events ORDER BY id DESC LIMIT 1")
    .get() as { event_type: string; payload: string } | undefined;
  assert.ok(evRow, "an event was logged");
  assert.equal(evRow!.event_type, "campaign_item.evidence_reconciled", "ships via the evidence-reconciled path, not a refusal");
  const payload = JSON.parse(evRow!.payload) as { ticketId: string; campaignId: string; decidedBy: string };
  assert.equal(payload.ticketId, ticketId);
  assert.equal(payload.decidedBy, "campaign_resume");
});

test("FG-460: resume REFUSES a CODE-touching awaiting_gate item that lacks a passing host-verification row — the widening is scoped to the non_code_diff lane, resume never ships un-verified code", async () => {
  // A .ts commit is code-touching → the out-of-band lane needs a passing
  // host-verification row (which resume never captures). Clean authoritative
  // outcome, but no covering host-verification → lane_evidence_missing → refuse.
  const ticketId = "FG-612";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);

  // Code-touching commit, ticket closed, but NO host-verification row recorded.
  seedOutOfBandCodeEvidence(ticketId, { recordVerification: false });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  let dispatched = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatched++;
    return { runId: "r", taskId: "t", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaignId, { dispatch });

  assert.notEqual(resumeResult.stopReason, "complete", "must not complete on un-verified code");
  assert.equal(dispatched, 0);
  const afterItem = getCampaignItem(itemId)!;
  assert.equal(afterItem.lifecycleStatus, beforeItem.lifecycleStatus, "code-touching item without host-verification must remain parked");
  assert.notEqual(afterItem.outcome, "shipped");

  const evRow = db
    .prepare("SELECT event_type, payload FROM events WHERE event_type = 'campaign_item.evidence_reconcile_refused' ORDER BY id DESC LIMIT 1")
    .get() as { event_type: string; payload: string } | undefined;
  assert.ok(evRow, "a refusal event logged");
  const payload = JSON.parse(evRow!.payload) as { missing: string[] };
  assert.ok(
    payload.missing.includes("lane_evidence_missing"),
    `expected lane_evidence_missing (code-touching, no passing host-verification), got: ${payload.missing.join(", ")}`
  );
});

test("FG-460: resume SHIPS a code-touching awaiting_gate item that HAS a passing host-verification row and a clean authoritative outcome — the host-verification lane is honored, unchanged from before", async () => {
  const ticketId = "FG-613";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);

  // Code-touching commit WITH a passing host-verification row → the out-of-band
  // host_verification lane is satisfied. Clean authoritative outcome → ships.
  seedOutOfBandCodeEvidence(ticketId); // recordVerification defaults to true
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });

  await resumeCampaign(campaignId, { dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }) });

  const afterItem = getCampaignItem(itemId)!;
  assert.equal(afterItem.lifecycleStatus, "complete", "code-touching + passing host-verification + clean authoritative → ships");
  assert.equal(afterItem.outcome, "shipped");
});

test("FG-460 parity: resume and reconcile reach the SAME verdict against identical out-of-band evidence — both SHIP a docs-only item, both REFUSE a code-touching item lacking host-verification", async () => {
  // Ships: identical docs-only evidence, one campaign driven through
  // reconcileCampaign and an independent twin campaign through resumeCampaign —
  // proving the "both ship" claim empirically, not just structurally (same
  // shared composeOutOfBandEligibility call underneath both call sites).
  const shipReconcile = setupAwaitingGateManualRunCampaign("FG-622");
  seedOutOfBandDocsEvidence("FG-622");
  logEvent("verdict.received", { runId: shipReconcile.runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  const reconcileShipResult = reconcileCampaign(shipReconcile.campaignId);
  assert.equal(reconcileShipResult.items[0]!.status, "shipped");

  const shipResume = setupAwaitingGateManualRunCampaign("FG-623");
  seedOutOfBandDocsEvidence("FG-623");
  logEvent("verdict.received", { runId: shipResume.runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  await resumeCampaign(shipResume.campaignId, { dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }) });
  assert.equal(getCampaignItem(shipResume.itemId)!.outcome, "shipped", "resume ships the identical docs-only evidence reconcile just shipped above");

  // Refuses: identical code-touching evidence with NO passing host-verification
  // row fed to both paths — neither ships un-verified code.
  const refuseReconcile = setupAwaitingGateManualRunCampaign("FG-624");
  seedOutOfBandCodeEvidence("FG-624", { recordVerification: false });
  logEvent("verdict.received", { runId: refuseReconcile.runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  const reconcileRefuseResult = reconcileCampaign(refuseReconcile.campaignId);
  assert.equal(reconcileRefuseResult.items[0]!.status, "refused");

  const refuseResume = setupAwaitingGateManualRunCampaign("FG-625");
  seedOutOfBandCodeEvidence("FG-625", { recordVerification: false });
  logEvent("verdict.received", { runId: refuseResume.runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  const resumeRefuseResult = await resumeCampaign(refuseResume.campaignId, { dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }) });
  assert.notEqual(resumeRefuseResult.stopReason, "complete");
  assert.notEqual(getCampaignItem(refuseResume.itemId)!.outcome, "shipped", "resume refuses the identical code-touching evidence reconcile just refused above");
});

test("FG-460 scope gap: a no-runId awaiting_gate item diverges between resume and reconcile — reconcile ships it directly (see the FG-458 non-goal-guard test above) but resume's item.runId guard (executor.ts:688) never lets it reach the shared eligibility path, so it re-parks with recovery_needed instead; this asymmetry predates FG-460 and is unchanged by it", async () => {
  const { campaignId: reconcileCampaignId, itemId: reconcileItemId } = setupAwaitingGateCampaign("FG-626");
  seedOutOfBandDocsEvidence("FG-626");
  const reconcileResult = reconcileCampaign(reconcileCampaignId);
  assert.equal(reconcileResult.items[0]!.status, "shipped", "reconcile ships a no-runId out-of-band item directly");
  assert.equal(getCampaignItem(reconcileItemId)!.outcome, "shipped");

  const { campaignId: resumeCampaignId, itemId: resumeItemId } = setupAwaitingGateCampaign("FG-627");
  seedOutOfBandDocsEvidence("FG-627");
  const resumeResult = await resumeCampaign(resumeCampaignId, {
    dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }),
  });

  assert.equal(resumeResult.stopReason, "recovery_needed", "no-runId awaiting_gate items never reach composeOutOfBandEligibility via resume — they fall through to the '!item.runId' branch and pause");
  const afterResumeItem = getCampaignItem(resumeItemId)!;
  assert.equal(afterResumeItem.lifecycleStatus, "awaiting_gate", "still parked — resume did not ship it despite reconcile shipping the identical evidence shape above");
  assert.notEqual(afterResumeItem.outcome, "shipped");
});

test("FG-460 matrix: a DOCS-ONLY item with an UNRESOLVED AUTHORITATIVE FAIL refuses on BOTH resume and reconcile — the authoritative axis blocks even a non_code_diff lane (guards the lane-bypasses-authoritative short-circuit)", async () => {
  // The one AC matrix cell not otherwise covered: docs-only (non_code_diff lane,
  // which is eligible on its own) combined with an unresolved authoritative fail.
  // composeOutOfBandEligibility ANDs outOfBand.eligible with authoritative.missing
  // === [] regardless of lane, so the authoritative fail must refuse even though
  // the lane is fine — and the refusal reason must be the run_evidence: code, NOT
  // lane_evidence_missing (the lane is satisfied). Asserted on BOTH paths.
  const rec = setupAwaitingGateManualRunCampaign("FG-628");
  seedOutOfBandDocsEvidence("FG-628"); // non_code_diff lane, ticket closed
  logEvent("verdict.received", { runId: rec.runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  const recResult = reconcileCampaign(rec.campaignId);
  assert.equal(recResult.items[0]!.status, "refused", "reconcile refuses a docs-only item on an unresolved authoritative fail");
  assert.ok(
    recResult.items[0]!.missing!.includes("run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"),
    `reconcile: expected the run_evidence: authoritative code, got: ${recResult.items[0]!.missing!.join(", ")}`
  );
  assert.ok(!recResult.items[0]!.missing!.includes("lane_evidence_missing"), "the docs-only lane is eligible — only the authoritative axis fails");

  const res = setupAwaitingGateManualRunCampaign("FG-629");
  seedOutOfBandDocsEvidence("FG-629");
  logEvent("verdict.received", { runId: res.runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  await resumeCampaign(res.campaignId, { dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }) });
  assert.notEqual(getCampaignItem(res.itemId)!.outcome, "shipped", "resume refuses the identical docs-only + authoritative-fail evidence reconcile just refused");
  const evRow = db
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.evidence_reconcile_refused' ORDER BY id DESC LIMIT 1")
    .get() as { payload: string } | undefined;
  assert.ok(evRow, "resume logs a refusal event");
  const payload = JSON.parse(evRow!.payload) as { missing: string[] };
  assert.ok(
    payload.missing.includes("run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"),
    `resume: expected the run_evidence: authoritative code, got: ${payload.missing.join(", ")}`
  );
  assert.ok(!payload.missing.includes("lane_evidence_missing"), "resume: the docs-only lane is eligible — only the authoritative axis fails");
});

test("FG-431/FG-460 matrix: a DOCS-ONLY item with an UNRESOLVED AUTHORITATIVE INCONCLUSIVE verdict refuses on BOTH resume and reconcile — the run_evidence: code is the NEW inconclusive-specific label, never the fail label (fail-safe preserved)", async () => {
  // Same shape as the fail-matrix test above, but the run's only authoritative
  // verdict is `inconclusive` (needs_human/unrecognized), never resolved by a
  // later pass or qualifying force-advance. authoritativeOutcomeContribution
  // folds AUTHORITATIVE_OUTCOME_MISSING_CODES straight through with a
  // `run_evidence:` prefix, so the composed out-of-band result must surface the
  // inconclusive-specific code (not the fail-oriented one) and stay ineligible —
  // on both the reconcile and resume call sites, since both feed the same
  // composeOutOfBandEligibility.
  const rec = setupAwaitingGateManualRunCampaign("FG-930");
  seedOutOfBandDocsEvidence("FG-930"); // non_code_diff lane, ticket closed
  logEvent("verdict.received", { runId: rec.runId, payload: { redRole: "shipping-reviewer", verdict: "inconclusive", authority: "authoritative" } });
  const recResult = reconcileCampaign(rec.campaignId);
  assert.equal(recResult.items[0]!.status, "refused", "reconcile refuses a docs-only item on an unresolved authoritative inconclusive verdict");
  assert.ok(
    recResult.items[0]!.missing!.includes("run_evidence:latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance"),
    `reconcile: expected the run_evidence: inconclusive code, got: ${recResult.items[0]!.missing!.join(", ")}`
  );
  assert.ok(
    !recResult.items[0]!.missing!.includes("run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"),
    "reconcile: must never carry the fail-oriented label for an inconclusive verdict"
  );
  assert.ok(!recResult.items[0]!.missing!.includes("lane_evidence_missing"), "the docs-only lane is eligible — only the authoritative axis fails");

  const res = setupAwaitingGateManualRunCampaign("FG-931");
  seedOutOfBandDocsEvidence("FG-931");
  logEvent("verdict.received", { runId: res.runId, payload: { redRole: "shipping-reviewer", verdict: "inconclusive", authority: "authoritative" } });
  await resumeCampaign(res.campaignId, { dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }) });
  assert.notEqual(getCampaignItem(res.itemId)!.outcome, "shipped", "resume refuses the identical docs-only + authoritative-inconclusive evidence reconcile just refused");
  const evRow = db
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.evidence_reconcile_refused' ORDER BY id DESC LIMIT 1")
    .get() as { payload: string } | undefined;
  assert.ok(evRow, "resume logs a refusal event");
  const payload = JSON.parse(evRow!.payload) as { missing: string[] };
  assert.ok(
    payload.missing.includes("run_evidence:latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance"),
    `resume: expected the run_evidence: inconclusive code, got: ${payload.missing.join(", ")}`
  );
  assert.ok(
    !payload.missing.includes("run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"),
    "resume: must never carry the fail-oriented label for an inconclusive verdict"
  );
  assert.ok(!payload.missing.includes("lane_evidence_missing"), "resume: the docs-only lane is eligible — only the authoritative axis fails");
});

test("FG-441: resume refuses to ship a manually-driven awaiting_gate item when the run's own authoritative outcome is a fail with no later pass or qualifying force-advance — logs the refusal with the authoritative-outcome clause", async () => {
  const ticketId = "FG-611";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);

  // Seed everything EXCEPT a superseding pass/force-advance on the run's own
  // authoritative verdict — the inverse of seedAllEvidence's fail-then-pass
  // sequence. This exercises the OTHER AND-gate clause than the host-verification
  // test above, proving the resume branch enforces both, not just one.
  const commit = makeCommit(`impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  // No later pass or qualifying force-advance.

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  let dispatched = 0;
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => {
    dispatched++;
    return { runId: "r", taskId: "t", status: "complete" };
  };

  const resumeResult = await resumeCampaign(campaignId, { dispatch });

  assert.notEqual(resumeResult.stopReason, "complete", "campaign must not report complete on an unresolved authoritative fail");
  assert.equal(dispatched, 0, "must not dispatch anything else while the parked item is unresolved");

  const afterItem = getCampaignItem(itemId)!;
  assert.equal(afterItem.lifecycleStatus, beforeItem.lifecycleStatus, "item must remain parked — not shipped");
  assert.notEqual(afterItem.lifecycleStatus, "complete");
  assert.equal(afterItem.outcome, beforeItem.outcome, "outcome must not become 'shipped'");

  assert.equal(countEvents(), beforeEvents + 1, "exactly one durable refusal event logged");
  const evRow = db
    .prepare("SELECT event_type, payload FROM events WHERE event_type = 'campaign_item.evidence_reconcile_refused' ORDER BY id DESC LIMIT 1")
    .get() as { event_type: string; payload: string } | undefined;
  assert.ok(evRow, "campaign_item.evidence_reconcile_refused event logged for the refused reconcile");
  const payload = JSON.parse(evRow!.payload) as { ticketId: string; campaignId: string; missing: string[]; decidedBy: string };
  assert.equal(payload.ticketId, ticketId);
  assert.equal(payload.campaignId, campaignId);
  assert.ok(
    // FG-460: resume now composes the authoritative-outcome fact through the
    // shared out-of-band helper, which labels it `run_evidence:` (same as
    // reconcile's out-of-band branch) so the operator can tell "the run's own
    // review is unresolved" apart from a lane-evidence gap.
    payload.missing.includes("run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"),
    `expected the run_evidence:-prefixed authoritative-outcome clause in missing, got: ${payload.missing.join(", ")}`
  );
});

test("FG-441 regression: a blocked_by_red item with blockerKind='scope' is NOT intercepted by the new resume-reconcile branch, even with full evidence present", async () => {
  const ticketId = "FG-620";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId, { lifecycleStatus: "blocked_by_red" });
  seedAllEvidence(ticketId, runId);

  const beforeEvents = countEvents();
  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => ({ runId: "r", taskId: "t", status: "complete" });

  const resumeResult = await resumeCampaign(campaignId, { dispatch });

  // The FG-441 branch only fires for lifecycleStatus='awaiting_gate' items with no
  // blockerKind. A blocked_by_red/scope item — FG-428's lane, not FG-441's — must
  // reach the pre-existing behavior unchanged (recovery_needed, since the fabricated
  // runId has no real `runs` row for driveWorkflowItem to reattach to), never the
  // new evidence-reconcile shortcut.
  assert.equal(resumeResult.stopReason, "recovery_needed");
  const afterItem = getCampaignItem(itemId)!;
  assert.equal(afterItem.lifecycleStatus, "blocked_by_red", "must remain blocked_by_red — not shipped by the new branch");
  assert.equal(afterItem.blockerKind, "scope");
  assert.equal(
    countEvents(),
    beforeEvents,
    "no campaign_item.evidence_reconciled event for a blockerKind='scope' item via resume"
  );
});

// ── FG-458: reconcile and resume must reach the SAME verdict for an
// awaiting_gate item WITH a runId — see executor.ts's FG-441 reattach branch
// (the resume side of this consistency property, exercised by the FG-441
// tests directly above) and reconcile.ts's out-of-band branch (the reconcile
// side, fixed here).

test("FG-458: out-of-band item WITH a runId that has an UNRESOLVED AUTHORITATIVE FAIL on the run REFUSES via reconcile — agrees with what resume/evaluateReconcileEvidence would report for the same run", () => {
  const ticketId = "FG-700";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  // Ticket done + closedCommit reachable + host-verification passing — the
  // out-of-band evaluator ALONE would ship this.
  seedOutOfBandCodeEvidence(ticketId);
  // The run's own authoritative review is an unresolved fail — no later pass
  // or qualifying force-advance.
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items.length, 1);
  assert.equal(
    result.items[0]!.status,
    "refused",
    "reconcile must refuse — resume would refuse this same run for an unresolved authoritative fail"
  );
  assert.ok(
    result.items[0]!.missing!.includes(
      "run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"
    ),
    `expected the run-evidence authoritative-outcome clause in missing, got: ${result.items[0]!.missing?.join(", ")}`
  );

  // Cross-check: the SAME shared evaluator, called directly on this item's own
  // evidence, reports the identical (unlabeled) reason — reconcile's refusal is
  // the raw reason resume reports, merely labeled for the operator.
  const directlyEvaluated = evaluateReconcileEvidence(collectReconcileEvidence(projectDir, getCampaignItem(itemId)!));
  assert.equal(directlyEvaluated.eligible, false);
  assert.deepEqual(directlyEvaluated.missing, ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refusal");
  assert.equal(countEvents(), beforeEvents, "no event row written on refusal");
});

test("FG-458: out-of-band item WITH a runId whose authoritative fail IS superseded by a qualifying force-advance REFUSES only when unresolved, SHIPS once resolved", () => {
  const ticketId = "FG-701";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId);
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });

  const firstResult = reconcileCampaign(campaignId);
  assert.equal(firstResult.items[0]!.status, "refused", "unresolved fail must refuse");

  logEvent("gate.decided", { runId, payload: { decision: "advance", rationale: "operator override: verified out of band", force: true } });

  const secondResult = reconcileCampaign(campaignId);
  assert.equal(secondResult.items[0]!.status, "shipped", "a qualifying force-advance resolves the run's authoritative outcome — both facts now agree to ship");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-458: out-of-band item WITH a runId whose run events are clean (authoritative pass) AND out-of-band eligible → still SHIPS (both agree)", () => {
  const ticketId = "FG-702";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId);
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped");
  assert.equal(result.items[0]!.missing, undefined);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-458 non-goal guard: out-of-band item with NO runId, out-of-band eligible, ships UNCHANGED — the legitimate out-of-band delivery case is not weakened", () => {
  const ticketId = "FG-703";
  const { campaignId, itemId } = setupAwaitingGateCampaign(ticketId);
  assert.equal(getCampaignItem(itemId)!.runId, undefined, "precondition: this item was never attached to a run");
  seedOutOfBandDocsEvidence(ticketId);

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped");
  assert.equal(result.items[0]!.missing, undefined);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-458: an unresolved authoritative fail refuses WITHOUT running the host-verification capture gate — the gate run is skipped, not wasted", () => {
  const ticketId = "FG-704";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  // Code-touching delivery with NO covering host-verification row yet, closedCommit
  // reachable on a CLEAN tree — exactly the shape that would normally make the
  // out-of-band branch's needsCapture fire and run a real (passing) gate.
  const commit = commitGateScript(`impl-${ticketId}`, "exit 0");
  closeTicket(projectDir, ticketId, commit);
  commitPendingChanges(`close ${ticketId}`);
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  // No later pass or qualifying force-advance.

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  // Lane evidence itself is ALSO still missing (the capture below never ran),
  // alongside the run-evidence reason — the short-circuit skips the gate run,
  // it doesn't fabricate lane eligibility.
  assert.deepEqual(result.items[0]!.missing, [
    "lane_evidence_missing",
    "run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance",
  ]);
  assert.equal(
    queryHostVerificationRowsForGate(ticketId, projectDir, "npm run test:all").length,
    0,
    "the events-aware refusal must short-circuit before the lane-evidence capture gate ever runs"
  );
});

// ── FG-473: an invoke-lane run (engineer + test-engineer, no red step) produces
// ZERO authoritative verdicts — that absence is the NORMAL shape for a
// quick_implementation item, not an objection. Before this fix, evaluateReconcileEvidence's
// no_authoritative_verdict_or_force_advance_event code was folded into the
// out-of-band composition just like a real fail/inconclusive objection would be,
// permanently wedging every invoke-lane item that ever reached awaiting_gate. The
// fix narrows AUTHORITATIVE_OUTCOME_MISSING_CODES to only the fail/inconclusive
// codes — a run with no authoritative reviewer at all now contributes nothing.

test("FG-473: reconcile SHIPS an invoke-lane out-of-band item (runId, ZERO authoritative verdicts) with full lane evidence (code-touching + passing host-verification)", () => {
  const ticketId = "FG-800";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  // Full lane evidence: closed ticket + reachable commit + passing host-verification.
  seedOutOfBandCodeEvidence(ticketId);
  // No verdict.received / gate.decided events at all on this run — the invoke lane
  // (engineer + test-engineer only) never produces one.
  const eventCount = db.prepare("SELECT COUNT(*) as n FROM events WHERE run_id = ?").get(runId) as { n: number };
  assert.equal(eventCount.n, 0, "precondition: the invoke-lane run has zero events");

  const result = reconcileCampaign(campaignId);
  assert.equal(
    result.items[0]!.status,
    "shipped",
    `expected shipped, got: ${result.items[0]!.status} missing=${result.items[0]!.missing?.join(", ")}`
  );

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-473: reconcile SHIPS an invoke-lane out-of-band item (runId, ZERO authoritative verdicts) with full lane evidence (docs-only, non_code_diff)", () => {
  const ticketId = "FG-801";
  const { campaignId, itemId } = setupAwaitingGateManualRunCampaign(ticketId);
  seedOutOfBandDocsEvidence(ticketId);

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped");
  assert.equal(result.items[0]!.missing, undefined);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-473: resume SHIPS an invoke-lane manually-driven awaiting_gate item (runId, ZERO authoritative verdicts) with full lane evidence — matching reconcile", async () => {
  const ticketId = "FG-802";
  const { campaignId, itemId } = setupAwaitingGateManualRunCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId);
  // No authoritative verdict/gate events at all on this run.

  const dispatch = async (_args: InvokeArgs): Promise<InvokeResult> => ({ runId: "r", taskId: "t", status: "complete" });
  const resumeResult = await resumeCampaign(campaignId, { dispatch });

  assert.equal(resumeResult.stopReason, "complete", "campaign completes — the invoke-lane item ships on lane evidence alone");
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-473 parity: resume and reconcile reach the SAME 'ship' verdict for an invoke-lane item with zero authoritative verdicts", async () => {
  const shipReconcile = setupAwaitingGateManualRunCampaign("FG-803");
  seedOutOfBandCodeEvidence("FG-803");
  const reconcileResult = reconcileCampaign(shipReconcile.campaignId);
  assert.equal(reconcileResult.items[0]!.status, "shipped");

  const shipResume = setupAwaitingGateManualRunCampaign("FG-804");
  seedOutOfBandCodeEvidence("FG-804");
  await resumeCampaign(shipResume.campaignId, { dispatch: async () => ({ runId: "r", taskId: "t", status: "complete" }) });
  assert.equal(getCampaignItem(shipResume.itemId)!.outcome, "shipped", "resume ships the identical zero-verdict evidence reconcile just shipped above");
});

test("FG-473 regression (FG-458 preserved): an invoke-lane-shaped item whose run's latest authoritative verdict IS an unresolved FAIL still REFUSES — zero-verdict is not a loophole for a real objection — item NOT shipped, no state written", () => {
  const ticketId = "FG-805";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId);
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.ok(
    result.items[0]!.missing!.includes("run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"),
    `expected the run_evidence: fail code, got: ${result.items[0]!.missing!.join(", ")}`
  );

  const afterItem = getCampaignItem(itemId)!;
  assert.deepEqual(afterItem, beforeItem, "campaign_items row must be byte-identical after a refusal — item NOT shipped");
  assert.notEqual(afterItem.outcome, "shipped");
  assert.notEqual(afterItem.lifecycleStatus, "complete");
  assert.equal(countEvents(), beforeEvents, "no event row written on refusal — no state written");
});

test("FG-473 regression: an invoke-lane-shaped item whose run's latest authoritative verdict IS inconclusive still REFUSES — item NOT shipped, no state written", () => {
  const ticketId = "FG-806";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  seedOutOfBandCodeEvidence(ticketId);
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "inconclusive", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.ok(
    result.items[0]!.missing!.includes(
      "run_evidence:latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance"
    ),
    `expected the run_evidence: inconclusive code, got: ${result.items[0]!.missing!.join(", ")}`
  );

  const afterItem = getCampaignItem(itemId)!;
  assert.deepEqual(afterItem, beforeItem, "campaign_items row must be byte-identical after a refusal — item NOT shipped");
  assert.notEqual(afterItem.outcome, "shipped");
  assert.notEqual(afterItem.lifecycleStatus, "complete");
  assert.equal(countEvents(), beforeEvents, "no event row written on refusal — no state written");
});

test("FG-473: lane-evidence gate is still enforced — an invoke-lane item (runId, ZERO authoritative verdicts) with a code-touching commit and NO passing host-verification recorded still REFUSES with lane_evidence_missing — the fix narrows the authoritative-outcome axis, never the lane-evidence axis", () => {
  const ticketId = "FG-808";
  const { campaignId, itemId, runId } = setupAwaitingGateManualRunCampaign(ticketId);
  // Code-touching commit, closed ticket — deliberately no host-verification row.
  seedOutOfBandCodeEvidence(ticketId, { recordVerification: false });
  const eventCount = db.prepare("SELECT COUNT(*) as n FROM events WHERE run_id = ?").get(runId) as { n: number };
  assert.equal(eventCount.n, 0, "precondition: zero events on this run — must not accidentally satisfy anything");

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);

  const afterItem = getCampaignItem(itemId)!;
  assert.deepEqual(afterItem, beforeItem, "campaign_items row must be byte-identical after a refusal");
  assert.equal(countEvents(), beforeEvents, "no event row written on refusal");
});

test("FG-473: shape-1 (scope-blocked feature-pipeline reconcile) is UNAFFECTED — a run with zero authoritative verdicts STILL refuses with no_authoritative_verdict_or_force_advance_event", () => {
  const ticketId = "FG-807";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);
  const commit = makeCommit(`impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  // No authoritative verdict/gate events at all — shape-1 must still refuse.

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused", "the normal feature-pipeline reconcile path never widened — only the out-of-band composition did");
  assert.deepEqual(result.items[0]!.missing, ["no_authoritative_verdict_or_force_advance_event"]);
  assert.equal(getCampaignItem(itemId)!.lifecycleStatus, "failed");
});
