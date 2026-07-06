// FG-431: integration coverage for the reconcile-evidence polish, exercised
// through the REAL `forge campaign reconcile` shape (reconcileCampaign against
// a real sqlite store, a real git repo, a real ticket store) — not the
// evaluator called directly with hand-built input (that's reconcile-evidence.
// test.ts / host-verifications.test.ts, at the unit level).
//
// Covers two changes:
//   1. host-verifications.ts now path.resolve()-canonicalizes projectDir on
//      BOTH the insert side (insertHostVerification, the public recorder used
//      by the CLI) and the lookup side (queryHostVerificationRowsForGate, used
//      by reconcile-collect.ts). A row recorded under a non-canonical-but-
//      equivalent projectDir must still be discovered by reconcileCampaign's
//      real lookup at the canonical projectDir — and a genuinely different
//      project must still never match.
//   2. reconcile-evidence.ts now distinguishes an inconclusive latest
//      authoritative verdict (needs_human / unrecognized) from a genuine fail:
//      the missing reason code must be the NEW
//      latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance
//      code, never the fail-oriented label — with the refusal itself (and
//      zero mutation) preserved either way.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { logEvent } from "../store/events.js";
import { approveCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { reconcileCampaign } from "./reconcile.js";

// Same wrapper as reconcile.integration.test.ts: forces executionMode:'invoke'
// for list-type campaigns so the planner doesn't need a real dispatch target.
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
  projectDir = mkdtempSync(join(tmpdir(), "fg431-reconcile-integ-"));
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

// Same shape as reconcile.integration.test.ts's setupBlockedCampaign: a
// single-item paused campaign whose item is scope-blocked.
function setupBlockedCampaign(ticketId: string): { campaignId: string; itemId: string; runId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const items = listCampaignItems(campaign.id);
  const itemId = items[0]!.id;
  const runId = `run-${itemId}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ?, reason = 'stale red fail', requested_human_action = 'inspect and resolve' WHERE id = ?"
  ).run(runId, itemId);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
  return { campaignId: campaign.id, itemId, runId };
}

// ── FG-431 (1): projectDir canonicalization, exercised through the real
// reconcileCampaign lookup path ──────────────────────────────────────────────

test("FG-431 integ: a host-verification row recorded via insertHostVerification (the public recorder path) with a non-canonical projectDir ('..' segment) is discovered by reconcileCampaign's real lookup at the canonical projectDir — item ships", () => {
  const ticketId = "FG-901";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit(`impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);

  // Built via raw string concatenation (NOT path.join, which normalizes away
  // ".." segments itself) so the fixture actually hands insertHostVerification
  // an unresolved, non-canonical path string.
  const nonCanonicalProjectDir = `${projectDir}/../${basename(projectDir)}`;
  assert.notEqual(nonCanonicalProjectDir, projectDir, "fixture must actually exercise a non-canonical path string, not a no-op");
  assert.equal(resolve(nonCanonicalProjectDir), projectDir, "fixture must resolve back to the exact canonical projectDir the campaign uses");

  insertHostVerification({
    ticketId,
    projectDir: nonCanonicalProjectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  // reconcileCampaign runs against the campaign's stored (canonical) projectDir —
  // the real path reconcile-collect.ts -> queryHostVerificationRowsForGate ->
  // host-verifications.ts must canonicalize consistently on both sides to find
  // the row recorded above.
  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped", "a row recorded under a non-canonical-but-equivalent projectDir must still be discovered by the canonical lookup");
  assert.equal(result.items[0]!.missing, undefined);

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-431 integ: a host-verification row recorded with a trailing-slash non-canonical projectDir is discovered by reconcileCampaign's real lookup — item ships", () => {
  const ticketId = "FG-902";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit(`impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);

  const nonCanonicalProjectDir = `${projectDir}/`;
  assert.notEqual(nonCanonicalProjectDir, projectDir);
  assert.equal(resolve(nonCanonicalProjectDir), projectDir);

  insertHostVerification({
    ticketId,
    projectDir: nonCanonicalProjectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-431 integ: negative guard — a host-verification row recorded for a genuinely DIFFERENT project directory does not satisfy reconcileCampaign's real lookup, canonicalized or not — item stays refused, zero mutation", () => {
  const ticketId = "FG-903";
  const { campaignId, itemId, runId } = setupBlockedCampaign(ticketId);

  const commit = makeCommit(`impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);

  const otherProjectDir = mkdtempSync(join(tmpdir(), "fg431-reconcile-integ-other-"));
  try {
    insertHostVerification({
      ticketId,
      projectDir: otherProjectDir,
      commitSha: commit,
      gateName: "npm run test:all",
      command: "npm run test:all",
      exitCode: 0,
      recordedAt: "2026-01-01T00:00:00Z",
    });
    logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
    logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "pass", authority: "authoritative" } });

    const beforeItem = getCampaignItem(itemId)!;
    const beforeEvents = countEvents();

    const result = reconcileCampaign(campaignId);
    assert.equal(result.items[0]!.status, "refused", "a row recorded for a genuinely different project must never satisfy the gate");
    assert.deepEqual(result.items[0]!.missing, ["host_verification_not_recorded"]);

    assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "campaign_items row must be byte-identical after a refusal");
    assert.equal(countEvents(), beforeEvents, "no event row written on refusal");
  } finally {
    rmSync(otherProjectDir, { recursive: true, force: true });
  }
});

// ── FG-431 (2): inconclusive-supersession refusal label, exercised through
// the real reconcileCampaign evidence path ─────────────────────────────────

test("FG-431 integ: latest authoritative verdict is inconclusive with no later pass or qualifying force-advance -> refused with the NEW inconclusive missing code (not the fail label) — fail-safe preserved, zero mutation", () => {
  const ticketId = "FG-910";
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
  // Only authoritative verdict on record is inconclusive (needs_human /
  // unrecognized) — never resolved by a later pass or qualifying force-advance.
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "inconclusive", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "refused", "inconclusive must never qualify as shipped evidence");
  assert.deepEqual(
    result.items[0]!.missing,
    ["latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance"],
    "must carry the NEW inconclusive-specific code"
  );
  assert.ok(
    !result.items[0]!.missing!.includes("latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"),
    "must never also (or instead) carry the fail-oriented label"
  );

  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "fail-safe: item must remain byte-identical, not shipped");
  assert.equal(countEvents(), beforeEvents, "no audit event logged for a refusal");
});

test("FG-431 integ: a later qualifying force-advance after an inconclusive verdict resolves the item eligible (regression: inconclusive is still recoverable the same way a fail is)", () => {
  const ticketId = "FG-911";
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
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "inconclusive", authority: "authoritative" } });
  logEvent("gate.decided", { runId, payload: { decision: "advance", rationale: "operator override: verified out of band", force: true } });

  const result = reconcileCampaign(campaignId);
  assert.equal(result.items[0]!.status, "shipped", "a qualifying force-advance after an inconclusive verdict must still resolve the item eligible");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
});

test("FG-431 integ: a genuine fail on one reviewing task and an inconclusive-only resolution on another both refuse — the real fail label wins over the run's own inconclusive event, through the real per-task event translation", () => {
  const ticketId = "FG-912";
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
  logEvent("verdict.received", { runId, taskId: "task-a", payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });
  logEvent("verdict.received", { runId, taskId: "task-b", payload: { redRole: "r", verdict: "inconclusive", authority: "authoritative" } });

  const beforeItem = getCampaignItem(itemId)!;
  const result = reconcileCampaign(campaignId);

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(
    result.items[0]!.missing,
    ["latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"],
    "a real fail on any task must win the label, never softened to inconclusive"
  );
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
});
