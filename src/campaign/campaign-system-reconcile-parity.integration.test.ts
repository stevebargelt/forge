// FG-502 verify-phase regression: report.ts's campaign_system eligibility preview
// (isCampaignSystemRecoverable / campaignSystemCompletableHint / campaignSystemLaneEvidenceHint)
// intentionally MIRRORS rather than imports reconcile.ts's write-path routing predicate
// (isCampaignSystemRecoverable in reconcile.ts) — the plan required the two modules stay
// compile-independent (no step imports a sibling step's new exports). That independence
// is exactly what lets the mirror drift from the real write path without either module's
// own isolated test suite ever catching it.
//
// This file proves the two surfaces agree on the SAME fixture:
//  - a full-evidence failed/blockerKind='campaign_system' item that report.ts previews as
//    recoverable must actually reconcile successfully via reconcileCampaign, logging the
//    distinct campaign_item.campaign_system_reconciled event.
//  - a missing-evidence shape of the identical item shape must be refused by BOTH surfaces:
//    report shows no eligibility/hint, and reconcile refuses with zero mutation.
//
// FG-511 adds the disjoint third shape: a campaign_system item that never shipped, whose
// run's durable task evidence proves the failure was transient. Reconcile can never
// recover it (there is no ship evidence), so show/report must point the operator at
// `forge campaign retry` — and that pointer must agree with retryCampaignItem's own
// verdict on the identical fixture, in both directions.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { approveCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { failTask } from "../v2/failure-kind.js";
import type { FailureKind } from "../v2/failure-kind.js";
import { nowIso } from "../util/ids.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { reconcileCampaign } from "./reconcile.js";
import { retryCampaignItem } from "./executor.js";
import { assembleCampaignReport, assembleCampaignShow, renderCampaignReportHuman } from "./report.js";

// Same wrapper reconcile.integration.test.ts uses: forces executionMode:'invoke' for
// list-type campaigns so planning never tries to resolve a real dispatch.
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

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "campaign-system-parity-"));
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

// Builds a single-item paused campaign parked in the exact shape executor.ts's
// campaign_system producers leave behind: blockerKind='campaign_system', WITH a
// runId, at the given lifecycleStatus — 'failed' for the three
// reconcileTerminalOutcome producers (salvage/gap/fallback), 'blocked_by_red' for
// driveWorkflowItem's inconclusive-verdict park (FG-502's fourth producer). Same
// shape both reconcile.integration.test.ts and report.integration.test.ts
// exercise in isolation.
function setupCampaignSystemCampaign(
  ticketId: string,
  lifecycleStatus: "failed" | "blocked_by_red" = "failed"
): { campaignId: string; itemId: string; runId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  const itemId = items[0]!.id;
  const runId = `run-${itemId}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = ?, outcome = 'blocked', blocker_kind = 'campaign_system', run_id = ?, requested_human_action = 'workflow completed but no authoritative reviewer verdicts found — check workflow reds configuration' WHERE id = ?"
  ).run(lifecycleStatus, runId, itemId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  return { campaignId: campaign.id, itemId, runId };
}

function countEvents(): number {
  return (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
}

// FG-511: the durable run/task evidence retryCampaignItem's probe reads back —
// an abandoned run with one failed primary task per kind, each carrying a real
// task.failed event written by the production writer.
//
// FG-722: the probe now selects failed primaries via the evaluator's terminal
// classification (classifyRunTerminalState -> failedPhases), so it loads the run's
// workflow. A project override (`.forge/workflows/feature.yml`) makes "feature"
// loadable without publishing a seed generation; its single "implement" step matches
// the seeded task phase so the failed primary is classified as a workflow-phase failure.
function seedAbandonedRun(runId: string, failureKinds: FailureKind[]): void {
  const wfDir = join(projectDir, ".forge", "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, "feature.yml"),
    "name: feature\ndescription: fg722 parity fixture\ninputs: []\nsteps:\n  - id: implement\n    agent: engineer\n    gate: none\n    manual: false\n    depends_on: []\n    runtime: claude\n    reds: []\n",
  );
  insertRun({ id: runId, workflow: "feature", title: runId, status: "abandoned", createdAt: nowIso(), projectDir });
  failureKinds.forEach((kind, i) => {
    const taskId = `${runId}-task-${i}`;
    insertTask({
      id: taskId,
      runId,
      phase: "implement",
      agentRole: "engineer",
      status: "pending",
      taskPackage: { taskId, runId, phase: "implement", role: "engineer", inputs: {}, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    failTask(taskId, { runId, kind, error: `seeded ${kind}` });
  });
}

test("parity: full out-of-band (docs-lane) evidence that report.ts previews as campaignSystemEligible actually reconciles via reconcileCampaign", () => {
  const ticketId = "FG-590";
  const { campaignId, itemId, runId } = setupCampaignSystemCampaign(ticketId);

  // Full evidence via the docs-only lane: ticket done + closed-commit-reachable +
  // lane evidence (docs-only commit needs no host verification).
  makeBaseCommit(`base-${ticketId}`);
  const commit = commitDocsFile(`docs/${ticketId}.md`, `docs for ${ticketId}`, `docs: ${ticketId}`);
  closeTicket(projectDir, ticketId, commit);

  // 1. report.ts's read-only mirror previews this exact shape as recoverable.
  const show = assembleCampaignShow(campaignId)!;
  assert.equal(show.items[0]!.campaignSystemEligible, true, "report.ts must preview this evidence shape as campaign_system-recoverable");
  assert.ok(show.nextAction.includes("forge campaign reconcile"), `expected a reconcile pointer, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaignId)!;
  assert.equal(report.items[0]!.campaignSystemEligible, true);

  // 2. reconcile.ts's write path, given the SAME durable facts, must actually ship it.
  const beforeEvents = countEvents();
  const result = reconcileCampaign(campaignId, { decidedBy: "steve" });

  assert.equal(result.ok, true);
  assert.equal(result.items[0]!.status, "shipped", `report.ts previewed eligible=true but reconcile refused: ${JSON.stringify(result.items)}`);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
  assert.equal(item.blockerKind, undefined);

  assert.equal(countEvents(), beforeEvents + 1);
  const evRow = db
    .prepare("SELECT event_type FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { event_type: string };
  assert.equal(evRow.event_type, "campaign_item.campaign_system_reconciled");

  // 3. Post-ship, the item is no longer campaign_system-blocked — the preview must
  // agree with the new state too (no drift the other direction, on re-render).
  const showAfter = assembleCampaignShow(campaignId)!;
  assert.equal(showAfter.items[0]!.campaignSystemEligible, false, "a shipped item is no longer campaign_system-recoverable");
});

test("parity: missing-evidence campaign_system shape (lane evidence absent) is refused by BOTH report's preview and reconcileCampaign's write path", () => {
  const ticketId = "FG-591";
  const { campaignId, itemId } = setupCampaignSystemCampaign(ticketId);

  // Code-touching delivery with NO covering host-verification row — the out-of-band
  // evidence evaluator's own {missing: ["lane_evidence_missing"]} shape.
  makeBaseCommit(`base-${ticketId}`);
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", `${ticketId}.ts`), `export const x = 1;\n`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `feat: ${ticketId}`], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  closeTicket(projectDir, ticketId, commit);

  // 1. report.ts must show no eligibility hint for this shape.
  const show = assembleCampaignShow(campaignId)!;
  assert.equal(show.items[0]!.campaignSystemEligible, false, "report.ts must not preview a missing-lane-evidence shape as eligible");
  assert.ok(
    show.items[0]!.hostVerificationReconcileHint?.includes("lane_evidence_missing"),
    `expected a lane_evidence_missing hint, got: ${show.items[0]!.hostVerificationReconcileHint}`
  );

  const report = assembleCampaignReport(campaignId)!;
  assert.equal(report.items[0]!.campaignSystemEligible, false);

  // 2. reconcile.ts's write path, given the SAME durable facts, must refuse too — with
  // zero mutation — and cite the identical missing-evidence code.
  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "refused", `report.ts previewed no eligibility but reconcile shipped it anyway: ${JSON.stringify(result.items)}`);
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refusal");
  assert.equal(countEvents(), beforeEvents, "no audit event logged for a refused reconcile");
});

// ── FG-511: the non-shipped, transient campaign_system shape — retry, not reconcile ──

test("parity: transient, non-shipped campaign_system evidence previews as retry-eligible in show/report, reconcile refuses it, and retryCampaignItem accepts", () => {
  const ticketId = "FG-594";
  const { campaignId, itemId, runId } = setupCampaignSystemCampaign(ticketId);
  makeBaseCommit(`base-${ticketId}`);
  // The overnight blip: an abandoned run whose only failed primary classifies
  // infrastructure. The ticket is still active — nothing shipped, so reconcile
  // has no ship evidence it could ever act on.
  seedAbandonedRun(runId, ["idle_timeout"]);

  // 1. show/report must point at retry — NOT at reconcile, and not at the
  //    generic "resolve blocker … then resume" fall-through.
  const show = assembleCampaignShow(campaignId)!;
  assert.equal(show.items[0]!.campaignSystemRetryEligible, true, "transient run evidence must preview as retry-eligible");
  assert.equal(show.items[0]!.campaignSystemEligible, false, "a never-shipped item is not reconcile-recoverable");
  assert.ok(
    show.nextAction.includes(`forge campaign retry ${campaignId} ${ticketId}`),
    `next action must name the evidence-gated retry, got: ${show.nextAction}`
  );
  assert.ok(!show.nextAction.includes("resolve blocker"), `next action must not fall through to the generic blocker text, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaignId)!;
  assert.equal(report.items[0]!.campaignSystemRetryEligible, true);
  assert.ok(
    report.nextOperatorAction.includes(`forge campaign retry ${campaignId} ${ticketId}`),
    `report's next operator action must name retry, got: ${report.nextOperatorAction}`
  );
  assert.ok(
    renderCampaignReportHuman(report).some((l) => l.includes("campaign-system-retryable")),
    "the human report must render the per-item retry hint"
  );

  // 2. reconcile — the OTHER recovery verb — must refuse this shape with zero mutation.
  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();
  const reconciled = reconcileCampaign(campaignId);
  assert.equal(reconciled.items[0]!.status, "refused", "a never-shipped item must never be reconciled to shipped");
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refused reconcile");
  assert.equal(countEvents(), beforeEvents, "no audit event logged for a refused reconcile");

  // 3. retryCampaignItem, given the SAME durable facts show/report previewed from, accepts.
  const retried = retryCampaignItem(campaignId, ticketId);
  assert.equal(retried.ok, true, `show/report previewed retry-eligible but retry refused: ${!retried.ok ? retried.reason : ""}`);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "pending");
  assert.equal(item.blockerKind, undefined);
  assert.equal(item.runId, undefined);
  const evRow = db
    .prepare("SELECT event_type FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { event_type: string };
  assert.equal(evRow.event_type, "campaign_item.campaign_system_retried");

  // 4. No drift the other direction: a reset item is no longer retry-eligible.
  assert.equal(assembleCampaignShow(campaignId)!.items[0]!.campaignSystemRetryEligible, false, "a reset item is no longer retry-eligible");
});

// FG-511 round 2: the two evidence trails can coexist on ONE item — an abandoned
// run whose primary idled out (transient), and a ticket delivered out-of-band
// anyway (ship evidence). Ship evidence wins in BOTH directions: the verb refuses
// naming reconcile, and every surface points at reconcile rather than retry.
test("parity: transient run evidence PLUS ship evidence points every surface at reconcile, and retryCampaignItem refuses naming it", () => {
  const ticketId = "FG-596";
  const { campaignId, itemId, runId } = setupCampaignSystemCampaign(ticketId);
  makeBaseCommit(`base-${ticketId}`);
  const commit = commitDocsFile(`docs/${ticketId}.md`, `docs for ${ticketId}`, `docs: ${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  // Transient evidence that WOULD license a retry on its own (the positive fixture
  // above uses exactly this run shape).
  seedAbandonedRun(runId, ["idle_timeout"]);

  // 1. JSON surfaces: reconcile-recoverable, and NOT retry-eligible. The two
  //    recovery flags must never both be set on one item.
  const show = assembleCampaignShow(campaignId)!;
  assert.equal(show.items[0]!.campaignSystemEligible, true, "delivered work stays reconcile-recoverable");
  assert.equal(show.items[0]!.campaignSystemRetryEligible, false, "delivered work must never preview as retryable");
  assert.ok(show.nextAction.includes("forge campaign reconcile"), `next action must name reconcile, got: ${show.nextAction}`);
  assert.ok(!show.nextAction.includes("forge campaign retry"), `next action must not name retry for delivered work, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaignId)!;
  assert.equal(report.items[0]!.campaignSystemEligible, true);
  assert.equal(report.items[0]!.campaignSystemRetryEligible, false);
  assert.ok(report.nextOperatorAction.includes("forge campaign reconcile"), `report must name reconcile, got: ${report.nextOperatorAction}`);

  // 2. Human surface: the per-item hint says recoverable, never retryable.
  const human = renderCampaignReportHuman(report);
  assert.ok(human.some((l) => l.includes("campaign-system-recoverable")), "the human report must render the reconcile hint");
  assert.ok(
    !human.some((l) => l.includes("campaign-system-retryable")),
    `the human report must not render a retry hint for delivered work, got: ${human.filter((l) => l.includes("campaign-system")).join(" | ")}`
  );

  // 3. The verb agrees with the surfaces: refuse, name reconcile, mutate nothing.
  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();
  const retried = retryCampaignItem(campaignId, ticketId);
  assert.equal(retried.ok, false, "retry must never re-dispatch an item whose ticket is provably delivered");
  if (!retried.ok) {
    assert.match(retried.reason, /provably delivered/i);
    assert.match(retried.reason, new RegExp(`forge campaign reconcile ${campaignId}`));
  }
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refused retry");
  assert.equal(countEvents(), beforeEvents, "no campaign_system_retried event may be logged for a refused retry");

  // 4. And reconcile — the verb the surfaces named — actually ships it.
  assert.equal(reconcileCampaign(campaignId).items[0]!.status, "shipped", "the named verb must be the one that works");
});

test("parity: non-transient campaign_system evidence previews as NOT retry-eligible and retryCampaignItem refuses it", () => {
  const ticketId = "FG-595";
  const { campaignId, itemId, runId } = setupCampaignSystemCampaign(ticketId);
  makeBaseCommit(`base-${ticketId}`);
  seedAbandonedRun(runId, ["model_error"]);

  const show = assembleCampaignShow(campaignId)!;
  assert.equal(show.items[0]!.campaignSystemRetryEligible, false, "a scope-classified failure must never preview as retry-eligible");
  assert.ok(!show.nextAction.includes("forge campaign retry"), `next action must not name retry for non-transient evidence, got: ${show.nextAction}`);
  assert.ok(show.nextAction.includes("resolve blocker"), `next action must fall through to the generic blocker text, got: ${show.nextAction}`);
  assert.equal(assembleCampaignReport(campaignId)!.items[0]!.campaignSystemRetryEligible, false);

  const beforeItem = getCampaignItem(itemId)!;
  const result = retryCampaignItem(campaignId, ticketId);
  assert.equal(result.ok, false, "show/report previewed no retry eligibility but retry accepted it anyway");
  if (!result.ok) assert.match(result.reason, /model_error/);
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refused retry");
});

// FG-502 round-2: the fourth producer — driveWorkflowItem's inconclusive-verdict
// park — leaves lifecycleStatus='blocked_by_red' rather than 'failed'. Both
// surfaces must treat this status identically to the 'failed' shape above.
test("parity: blocked_by_red/campaign_system with full evidence previews eligible and reconciles with the campaign_system_reconciled event", () => {
  const ticketId = "FG-592";
  const { campaignId, itemId, runId } = setupCampaignSystemCampaign(ticketId, "blocked_by_red");

  makeBaseCommit(`base-${ticketId}`);
  const commit = commitDocsFile(`docs/${ticketId}.md`, `docs for ${ticketId}`, `docs: ${ticketId}`);
  closeTicket(projectDir, ticketId, commit);

  const show = assembleCampaignShow(campaignId)!;
  assert.equal(
    show.items[0]!.campaignSystemEligible,
    true,
    "report.ts must preview a blocked_by_red/campaign_system item with full evidence as recoverable"
  );
  assert.ok(show.nextAction.includes("forge campaign reconcile"), `expected a reconcile pointer, got: ${show.nextAction}`);

  const report = assembleCampaignReport(campaignId)!;
  assert.equal(report.items[0]!.campaignSystemEligible, true);

  const beforeEvents = countEvents();
  const result = reconcileCampaign(campaignId, { decidedBy: "steve" });

  assert.equal(result.ok, true);
  assert.equal(
    result.items[0]!.status,
    "shipped",
    `report.ts previewed eligible=true but reconcile refused: ${JSON.stringify(result.items)}`
  );

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
  assert.equal(item.blockerKind, undefined);

  assert.equal(countEvents(), beforeEvents + 1);
  const evRow = db
    .prepare("SELECT event_type FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { event_type: string };
  assert.equal(evRow.event_type, "campaign_item.campaign_system_reconciled");

  const showAfter = assembleCampaignShow(campaignId)!;
  assert.equal(showAfter.items[0]!.campaignSystemEligible, false, "a shipped item is no longer campaign_system-recoverable");
});

test("parity: blocked_by_red/campaign_system with missing lane evidence is refused by BOTH report's preview and reconcileCampaign's write path", () => {
  const ticketId = "FG-593";
  const { campaignId, itemId } = setupCampaignSystemCampaign(ticketId, "blocked_by_red");

  makeBaseCommit(`base-${ticketId}`);
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", `${ticketId}.ts`), `export const x = 1;\n`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `feat: ${ticketId}`], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  closeTicket(projectDir, ticketId, commit);

  const show = assembleCampaignShow(campaignId)!;
  assert.equal(
    show.items[0]!.campaignSystemEligible,
    false,
    "report.ts must not preview a missing-lane-evidence blocked_by_red shape as eligible"
  );
  assert.ok(
    show.items[0]!.hostVerificationReconcileHint?.includes("lane_evidence_missing"),
    `expected a lane_evidence_missing hint, got: ${show.items[0]!.hostVerificationReconcileHint}`
  );

  const report = assembleCampaignReport(campaignId)!;
  assert.equal(report.items[0]!.campaignSystemEligible, false);

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);

  assert.equal(
    result.items[0]!.status,
    "refused",
    `report.ts previewed no eligibility but reconcile shipped it anyway: ${JSON.stringify(result.items)}`
  );
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refusal");
  assert.equal(countEvents(), beforeEvents, "no audit event logged for a refused reconcile");
});
