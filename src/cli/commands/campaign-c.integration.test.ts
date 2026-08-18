// FG-728 step 3 — campaign segment C: FG-473 out-of-band + FG-440 real-`npm run test:all` host-verification (network/slow).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { writeTicket, closeTicket } from "../../backlog/structured.js";
import {
  setup,
  teardown,
  runForge,
  insertFixtureHostVerification,
  gitExec,
  makeCommitIn,
  commitFileIn,
  commitGateScriptIn,
  commitPendingChangesIn,
  setupOutOfBandCliCampaign,
  forgeHome,
  projectDir,
} from "./campaign.support.js";

beforeEach(setup);
afterEach(teardown);


// ── FG-473: invoke-lane out-of-band items (runId, zero authoritative verdicts) ──
//
// Real CLI-subprocess coverage for the FG-473 fix: `no_authoritative_verdict_
// or_force_advance_event` was removed from AUTHORITATIVE_OUTCOME_MISSING_CODES,
// so an out-of-band item WITH a runId (the FG-441/FG-458 manually-driven
// awaiting_gate shape — see setupOutOfBandCliCampaignMultiWithRunId below)
// whose run produced ZERO authoritative verdicts (the invoke-lane shape:
// engineer + test-engineer only, no red-team step) now SHIPS on lane evidence
// alone, while a run that DID produce an unresolved authoritative fail or
// inconclusive verdict must still refuse (FG-458 preserved). This proves the
// enforcement half through the real operator entrypoint, not just the happy
// path, and that show/report's outOfBandEligible flag never diverges from what
// a real `campaign reconcile` does (FG-444 no-divergence) for this new case.

// Multi-ticket variant of setupOutOfBandCliCampaign that ALSO stamps a runId
// on every item (the FG-441 manually-driven shape) so callers can attach
// authoritative-verdict events per ticket via runIdFor.
function setupOutOfBandCliCampaignMultiWithRunId(ticketIds: string[]): { campaignId: string; runIdFor: Map<string, string> } {
  for (const ticketId of ticketIds) {
    writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Out of band", body: "" });
  }

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketIds.join(","),
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  const runIdFor = new Map<string, string>();
  for (const item of items) {
    const runId = `run-${item.id}`;
    runIdFor.set(item.ticket_id, runId);
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, run_id = ?, requested_human_action = 'Human gate required at step review' WHERE id = ?"
    ).run(runId, item.id);
  }
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, runIdFor };
}

test("FG-473 integ: invoke-lane out-of-band items (runId, manually-driven awaiting_gate shape) — zero-verdict SHIPS, unresolved FAIL and INCONCLUSIVE still REFUSE; show/report outOfBandEligible agrees with a real `campaign reconcile` for all three", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId, runIdFor } = setupOutOfBandCliCampaignMultiWithRunId(["FG-700", "FG-701", "FG-702"]);
  makeCommitIn(projectDir, "base-FG-700-701-702");

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);

  // FG-700: invoke-lane shape — closed, code-touching commit, passing
  // host-verification, and ZERO events on its run. Must SHIP.
  const commit700 = commitFileIn(projectDir, "src/FG-700.ts", "export const x700 = 1;\n", "feat: FG-700");
  closeTicket(projectDir, "FG-700", commit700);
  insertFixtureHostVerification(db, "FG-700", commit700);

  // FG-701: SAME lane evidence, but the run carries an unresolved authoritative
  // FAIL. Must still REFUSE (FG-458 preserved).
  const commit701 = commitFileIn(projectDir, "src/FG-701.ts", "export const x701 = 1;\n", "feat: FG-701");
  closeTicket(projectDir, "FG-701", commit701);
  insertFixtureHostVerification(db, "FG-701", commit701);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(
    runIdFor.get("FG-701"),
    "verdict.received",
    JSON.stringify({ redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" }),
    "2026-01-01T00:00:00Z"
  );

  // FG-702: SAME lane evidence, but the latest authoritative verdict is
  // INCONCLUSIVE. Must still REFUSE.
  const commit702 = commitFileIn(projectDir, "src/FG-702.ts", "export const x702 = 1;\n", "feat: FG-702");
  closeTicket(projectDir, "FG-702", commit702);
  insertFixtureHostVerification(db, "FG-702", commit702);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(
    runIdFor.get("FG-702"),
    "verdict.received",
    JSON.stringify({ redRole: "shipping-reviewer", verdict: "inconclusive", authority: "authoritative" }),
    "2026-01-01T00:00:00Z"
  );
  db.close();

  // ── show: JSON ──
  const showJson = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(showJson.status, 0, `show --json failed\nstdout: ${showJson.stdout}\nstderr: ${showJson.stderr}`);
  const showOutput = JSON.parse(showJson.stdout) as {
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const showEligibility = new Map(showOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));
  assert.equal(showEligibility.get("FG-700"), true, "FG-700 (zero authoritative verdicts) must be eligible");
  assert.equal(showEligibility.get("FG-701"), false, "FG-701 (unresolved authoritative FAIL) must NOT be eligible");
  assert.equal(showEligibility.get("FG-702"), false, "FG-702 (unresolved authoritative INCONCLUSIVE) must NOT be eligible");

  // ── report: JSON ──
  const reportJson = runForge(["campaign", "report", campaignId, "--json"]);
  assert.equal(reportJson.status, 0, `report --json failed\nstdout: ${reportJson.stdout}\nstderr: ${reportJson.stderr}`);
  const reportOutput = JSON.parse(reportJson.stdout) as {
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const reportEligibility = new Map(reportOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));

  // report and show must agree EXACTLY, per item — no divergence between the surfaces.
  for (const ticketId of ["FG-700", "FG-701", "FG-702"]) {
    assert.equal(
      reportEligibility.get(ticketId),
      showEligibility.get(ticketId),
      `report/show must agree on outOfBandEligible for ${ticketId}`
    );
  }

  // ── no-divergence: a real `campaign reconcile` must ship/refuse in lockstep
  // with the displayed flag, for all three items. ──
  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(reconcileOutput.ok, true);
  const reconcileStatus = new Map(reconcileOutput.items.map((i) => [i.ticketId, i]));
  assert.equal(
    reconcileStatus.get("FG-700")!.status,
    "shipped",
    "reconcile must ship the zero-verdict invoke-lane item the display marked eligible"
  );
  assert.equal(
    reconcileStatus.get("FG-701")!.status,
    "refused",
    "reconcile must refuse the unresolved-FAIL item the display marked ineligible"
  );
  assert.ok(
    reconcileStatus.get("FG-701")!.missing?.includes(
      "run_evidence:latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance"
    ),
    `expected the run_evidence: fail code, got: ${reconcileStatus.get("FG-701")!.missing?.join(", ")}`
  );
  assert.equal(
    reconcileStatus.get("FG-702")!.status,
    "refused",
    "reconcile must refuse the unresolved-INCONCLUSIVE item the display marked ineligible"
  );
  assert.ok(
    reconcileStatus.get("FG-702")!.missing?.includes(
      "run_evidence:latest_authoritative_verdict_is_inconclusive_with_no_later_pass_or_force_advance"
    ),
    `expected the run_evidence: inconclusive code, got: ${reconcileStatus.get("FG-702")!.missing?.join(", ")}`
  );

  // Zero mutation / no state written for the two refused items.
  const dbAfter = new Database(dbPath, { readonly: true });
  const item701 = dbAfter
    .prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-701'")
    .get(campaignId) as { lifecycle_status: string; outcome: string | null };
  assert.equal(item701.lifecycle_status, "awaiting_gate", "FG-701 must not be shipped — stays parked");
  assert.notEqual(item701.outcome, "shipped");
  const item702 = dbAfter
    .prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-702'")
    .get(campaignId) as { lifecycle_status: string; outcome: string | null };
  assert.equal(item702.lifecycle_status, "awaiting_gate", "FG-702 must not be shipped — stays parked");
  assert.notEqual(item702.outcome, "shipped");
  dbAfter.close();
});

// Plans + approves a single-item paused campaign whose item is scope-blocked with
// the fact-5 supersession events present (fail then authoritative pass) but
// DELIBERATELY no host_verifications row — the precondition for FG-440's
// automatic capture to fire on the next `campaign reconcile` invocation.
function setupHostGateCaptureCliCampaign(ticketId: string): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Capture", body: "" });

  const planResult = runForge(["campaign", "plan", "--tickets", ticketId, "--project", projectDir, "--json"]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string };
  const runId = `run-${item.id}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(runId, item.id);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "fail", authority: "authoritative" }), "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "pass", authority: "authoritative" }), "2026-01-01T00:00:01Z");
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, itemId: item.id };
}

test("integ campaign reconcile --json (FG-440): a real `npm run test:all` PASS is captured automatically — writes a real host_verifications row and ships the item, all within one CLI invocation", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupHostGateCaptureCliCampaign("FG-620");
  const closedCommit = commitGateScriptIn(projectDir, "impl-FG-620", "exit 0");
  closeTicket(projectDir, "FG-620", closedCommit);
  const testedHead = commitPendingChangesIn(projectDir, "close FG-620");

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = (
    dbBefore.prepare("SELECT COUNT(*) as n FROM host_verifications WHERE ticket_id = ?").get("FG-620") as { n: number }
  ).n;
  dbBefore.close();
  assert.equal(before, 0, "precondition: no host_verifications row exists before reconcile runs");

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0, `reconcile failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(output.ok, true);
  assert.equal(output.items[0]?.status, "shipped", "the real gate ran and passed within this same reconcile call");

  const db2 = new Database(dbPath, { readonly: true });
  const rows = db2
    .prepare("SELECT exit_code, gate_name, command, commit_sha FROM host_verifications WHERE ticket_id = ?")
    .all("FG-620") as { exit_code: number; gate_name: string; command: string; commit_sha: string }[];
  db2.close();
  assert.equal(rows.length, 1, "exactly one real row written by the actual `npm run test:all` invocation");
  assert.equal(rows[0]!.exit_code, 0);
  assert.equal(rows[0]!.gate_name, "npm run test:all", "gate_name is the configured requiredHostGate string, never the executed argv");
  assert.equal(rows[0]!.command, "npm run test:all");
  assert.equal(rows[0]!.commit_sha, testedHead, "recorded commit_sha is the real tested HEAD, not closedCommit");
});

test("integ campaign reconcile --json (FG-440): a real `npm run test:all` FAILURE is captured with its actual exit code — item stays refused with the distinct 'recorded_but_failed' code, never conflated with 'not_recorded'", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupHostGateCaptureCliCampaign("FG-621");
  const closedCommit = commitGateScriptIn(projectDir, "impl-FG-621", "exit 4");
  closeTicket(projectDir, "FG-621", closedCommit);
  const testedHead = commitPendingChangesIn(projectDir, "close FG-621");

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0, `reconcile failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { items: { ticketId: string; status: string; missing?: string[] }[] };
  assert.equal(output.items[0]?.status, "refused");
  assert.deepEqual(
    output.items[0]?.missing,
    ["host_verification_recorded_but_failed"],
    "raw JSON must carry the un-rewritten reason code, distinct from host_verification_not_recorded"
  );

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT exit_code, commit_sha FROM host_verifications WHERE ticket_id = ?")
    .all("FG-621") as { exit_code: number; commit_sha: string }[];
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exit_code, 4, "the actual non-zero exit code must be recorded, never fabricated as 0 or 1");
  assert.equal(rows[0]!.commit_sha, testedHead);
});

test("integ campaign reconcile (human, FG-440): renders distinct operator-facing text for not_recorded vs recorded_but_failed — never describes a real failure as pending automatic capture", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  // FG-622: no package.json at all in projectDir yet → the gate is unrunnable →
  // skip → not_recorded.
  const { campaignId: notRecordedCampaignId } = setupHostGateCaptureCliCampaign("FG-622");
  const closedCommitA = makeCommitIn(projectDir, "impl-FG-622");
  closeTicket(projectDir, "FG-622", closedCommitA);
  commitPendingChangesIn(projectDir, "close FG-622");

  const notRecordedResult = runForge(["campaign", "reconcile", notRecordedCampaignId]);
  assert.equal(notRecordedResult.status, 0, `stdout: ${notRecordedResult.stdout}\nstderr: ${notRecordedResult.stderr}`);
  assert.ok(
    notRecordedResult.stdout.includes("host_verification_not_recorded") &&
      notRecordedResult.stdout.includes("will be captured automatically"),
    `not_recorded hint must point at automatic capture on the next reconcile/drive run\nstdout: ${notRecordedResult.stdout}`
  );
  assert.ok(
    !notRecordedResult.stdout.includes("genuine failure"),
    `a not-yet-run gate must never be described as a genuine failure\nstdout: ${notRecordedResult.stdout}`
  );

  // FG-623: same projectDir now has the FG-620/FG-621 package.json from earlier
  // in this suite's git history — force it to a real, real failure for THIS commit.
  const { campaignId: failedCampaignId } = setupHostGateCaptureCliCampaign("FG-623");
  const closedCommitB = commitGateScriptIn(projectDir, "impl-FG-623", "exit 9");
  closeTicket(projectDir, "FG-623", closedCommitB);
  commitPendingChangesIn(projectDir, "close FG-623");

  const failedResult = runForge(["campaign", "reconcile", failedCampaignId]);
  assert.equal(failedResult.status, 0, `stdout: ${failedResult.stdout}\nstderr: ${failedResult.stderr}`);
  assert.ok(
    failedResult.stdout.includes("host_verification_recorded_but_failed") &&
      failedResult.stdout.includes("genuine failure"),
    `recorded_but_failed hint must state the gate ran for real and failed\nstdout: ${failedResult.stdout}`
  );
  assert.ok(
    !failedResult.stdout.includes("will be captured automatically"),
    `a genuine gate failure must never be rendered as something pending automatic capture\nstdout: ${failedResult.stdout}`
  );
});

test("integ campaign show (human, FG-440): prints a host-verification-status line for a scope-blocked item awaiting automatic capture", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupHostGateCaptureCliCampaign("FG-624");
  const closedCommit = makeCommitIn(projectDir, "impl-FG-624"); // no package.json → stays not_recorded
  closeTicket(projectDir, "FG-624", closedCommit);
  commitPendingChangesIn(projectDir, "close FG-624");

  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `stdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);
  assert.ok(
    showResult.stdout.includes("host-verification-status:") && showResult.stdout.includes("host_verification_not_recorded"),
    `campaign show must surface the host-verification hint for a scope-blocked item\nstdout: ${showResult.stdout}`
  );

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { items: { ticketId: string; hostVerificationReconcileHint: string | null }[] };
  const item = jsonOutput.items.find((i) => i.ticketId === "FG-624")!;
  assert.ok(item.hostVerificationReconcileHint?.includes("host_verification_not_recorded"));
});

// FG-452 AC5 parity: the FG-440 test above proves the human `forge campaign show`
// surface for the scope-blocked lane. This is its out-of-band code-touching
// counterpart — reconcile.integration.test.ts:1313 only asserted the JSON-shaped
// hostVerificationReconcileHint field and renderCampaignReportHuman directly; it
// never spawned a real `forge campaign show` subprocess and read its stdout.
test("integ campaign show (human, FG-452): prints a host-verification-status line for an out-of-band code-touching item awaiting automatic capture", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-625");
  makeCommitIn(projectDir, "base-FG-625");
  const commit = commitFileIn(projectDir, "src/FG-625.ts", "export const x = 1;\n", "feat: FG-625");
  closeTicket(projectDir, "FG-625", commit);
  // Deliberately no host_verifications row inserted for this commit — the item
  // stays awaiting_gate, which is the precondition for the hint to appear.

  const showResult = runForge(["campaign", "show", campaignId]);
  assert.equal(showResult.status, 0, `stdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);
  assert.ok(
    showResult.stdout.includes("host-verification-status:") && showResult.stdout.includes("forge campaign reconcile"),
    `campaign show must surface the host-verification hint for an out-of-band code-touching item\nstdout: ${showResult.stdout}`
  );

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { items: { ticketId: string; hostVerificationReconcileHint: string | null }[] };
  const item = jsonOutput.items.find((i) => i.ticketId === "FG-625")!;
  assert.match(item.hostVerificationReconcileHint ?? "", /forge campaign reconcile/);
});
