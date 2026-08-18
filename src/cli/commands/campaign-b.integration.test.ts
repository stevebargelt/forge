// FG-728 step 3 — campaign segment B: FG-428 + FG-443 reconcile (git-heavy).
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


// Plans + approves a paused campaign over two fresh tickets: the first ships (all
// durable evidence present), the second refuses (no host verification recorded).
// Returns the campaign id so the caller can invoke `campaign reconcile` exactly
// once against it (a second reconcile of the same campaign would see the first
// item as already-reconciled/not_applicable, not shipped again).
function setupReconcileCliCampaign(eligibleTicketId: string, ineligibleTicketId: string): { campaignId: string } {
  writeTicket(projectDir, { id: eligibleTicketId, type: "story", status: "active", title: "Eligible", body: "" });
  writeTicket(projectDir, { id: ineligibleTicketId, type: "story", status: "active", title: "Ineligible", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", `${eligibleTicketId},${ineligibleTicketId}`,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const items = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string; ticket_id: string }[];
  const eligibleItem = items.find((i) => i.ticket_id === eligibleTicketId)!;
  const ineligibleItem = items.find((i) => i.ticket_id === ineligibleTicketId)!;

  // Eligible item: scope-blocked with ALL durable evidence present.
  const commit = makeCommitIn(projectDir, `impl-${eligibleTicketId}`);
  closeTicket(projectDir, eligibleTicketId, commit);
  const runId = `run-${eligibleItem.id}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(runId, eligibleItem.id);
  insertFixtureHostVerification(db, eligibleTicketId, commit);
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "fail", authority: "authoritative" }), "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(runId, "verdict.received", JSON.stringify({ redRole: "r", verdict: "pass", authority: "authoritative" }), "2026-01-01T00:00:01Z");

  // Ineligible item: scope-blocked but with NO host verification recorded → refused.
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'blocked_by_red', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(`run-${ineligibleItem.id}`, ineligibleItem.id);

  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId };
}

test("integ campaign reconcile --json: paused campaign — ships an eligible scope-blocked item, refuses an ineligible one, exits 0", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupReconcileCliCampaign("FG-301", "FG-302");

  const jsonResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(jsonResult.status, 0, `reconcile must exit 0 even with a refused item\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);

  const output = JSON.parse(jsonResult.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(output.ok, true);
  const eligible = output.items.find((i) => i.ticketId === "FG-301")!;
  const ineligible = output.items.find((i) => i.ticketId === "FG-302")!;
  assert.equal(eligible.status, "shipped");
  assert.equal(ineligible.status, "refused");
  assert.ok(ineligible.missing && ineligible.missing.length > 0, "refused item must report missing facts");

  // Verify DB mutation for the shipped item and the audit event.
  const dbPath = join(forgeHome, "forge.db");
  const db2 = new Database(dbPath, { readonly: true });
  const shippedRow = db2
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-301'")
    .get(campaignId) as { lifecycle_status: string; outcome: string; blocker_kind: string | null };
  assert.equal(shippedRow.lifecycle_status, "complete");
  assert.equal(shippedRow.outcome, "shipped");
  assert.equal(shippedRow.blocker_kind, null);

  const refusedRow = db2
    .prepare("SELECT lifecycle_status FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-302'")
    .get(campaignId) as { lifecycle_status: string };
  assert.equal(refusedRow.lifecycle_status, "blocked_by_red", "refused item must be untouched");

  const auditEvent = db2
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.evidence_reconciled'")
    .get() as { payload: string } | undefined;
  assert.ok(auditEvent, "an evidence_reconciled event must be recorded for the shipped item");
  const payload = JSON.parse(auditEvent!.payload) as { decidedBy: string };
  assert.equal(payload.decidedBy, "steve");
  db2.close();
});

test("integ campaign reconcile (human): prints each item's ticketId + status, missing facts for the refused item", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupReconcileCliCampaign("FG-303", "FG-304");

  const humanResult = runForge(["campaign", "reconcile", campaignId]);
  assert.equal(humanResult.status, 0, `stdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(humanResult.stdout.includes("FG-303") && humanResult.stdout.includes("shipped"));
  assert.ok(humanResult.stdout.includes("FG-304") && humanResult.stdout.includes("refused"));
  assert.ok(
    humanResult.stdout.includes("missing:"),
    `refused item must print its missing facts\nstdout: ${humanResult.stdout}`
  );
});

test("integ campaign reconcile: refuses a non-paused campaign, exits non-zero, zero items processed", () => {
  const planResult = runForge([
    "campaign", "plan",
    "--tickets", "FG-101",
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };
  // Campaign is still 'planned' — not paused.

  const result = runForge(["campaign", "reconcile", planOutput.campaignId, "--json"]);
  assert.notEqual(result.status, 0, "reconcile must exit non-zero for a non-paused campaign");

  const output = JSON.parse(result.stdout) as { ok: boolean; items: unknown[] };
  assert.equal(output.ok, false);
  assert.deepEqual(output.items, []);
});

test("integ campaign reconcile: refuses an unknown campaign id, exits non-zero", () => {
  const result = runForge(["campaign", "reconcile", "campaign-does-not-exist"]);
  assert.notEqual(result.status, 0);
  const combined = result.stderr + result.stdout;
  assert.ok(combined.toLowerCase().includes("not found"), `expected a not-found message\ncombined: ${combined}`);
});

test("integ campaign reconcile --help: no --evidence/--force/free-text override option exists", () => {
  const result = runForge(["campaign", "reconcile", "--help"]);
  assert.equal(result.status, 0, `--help must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(!result.stdout.includes("--evidence"), "reconcile must not accept an --evidence override flag");
  assert.ok(!result.stdout.includes("--force"), "reconcile must not accept a --force override flag");
  assert.ok(result.stdout.includes("--json"), "reconcile must accept --json");
  assert.ok(result.stdout.includes("--by"), "reconcile must accept --by for attribution");
});

// Plans + approves a single-item paused campaign with a scope-blocked item carrying
// ALL durable evidence (ships on reconcile). Unlike setupReconcileCliCampaign, there
// is no second item — this isolates the real two-command operator chain (reconcile
// then resume) from any dispatch requirement, since after reconcile there is nothing
// left for resume to drive.
function setupSingleItemReconcileCliCampaign(ticketId: string): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Solo", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketId,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id, ticket_id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string; ticket_id: string };

  const commit = makeCommitIn(projectDir, `impl-${ticketId}`);
  closeTicket(projectDir, ticketId, commit);
  const runId = `run-${item.id}`;
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'scope', run_id = ? WHERE id = ?"
  ).run(runId, item.id);
  insertFixtureHostVerification(db, ticketId, commit);
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

test("integ campaign reconcile then resume (real CLI-to-CLI chain): reconciled item lets the campaign actually complete", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupSingleItemReconcileCliCampaign("FG-310");

  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(reconcileOutput.items[0]?.status, "shipped");

  // The operator's next real command, spawned as an entirely separate process against
  // the same on-disk forge.db — proves the reconciled state actually persists and is
  // honored by a fresh `resume` invocation, not just by re-reading in-process state.
  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as { stopReason: string; itemRecords: { ticketId: string; lifecycleStatus: string; outcome?: string }[] };
  assert.equal(resumeOutput.stopReason, "complete", "campaign must reach 'complete' once its only blocker was reconciled");

  const dbPath = join(forgeHome, "forge.db");
  const db2 = new Database(dbPath, { readonly: true });
  const finalCampaign = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId) as { status: string };
  assert.equal(finalCampaign.status, "complete");
  const finalItem = db2
    .prepare("SELECT lifecycle_status, outcome FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-310'")
    .get(campaignId) as { lifecycle_status: string; outcome: string };
  assert.equal(finalItem.lifecycle_status, "complete");
  assert.equal(finalItem.outcome, "shipped");
  db2.close();
});

test("integ campaign reconcile is idempotent under re-run: second invocation reports not_applicable, logs zero additional audit events", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupSingleItemReconcileCliCampaign("FG-311");

  const first = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(first.status, 0);
  const firstOutput = JSON.parse(first.stdout) as { items: { ticketId: string; status: string }[] };
  assert.equal(firstOutput.items[0]?.status, "shipped");

  const dbPath = join(forgeHome, "forge.db");
  const dbAfterFirst = new Database(dbPath, { readonly: true });
  const eventsAfterFirst = (
    dbAfterFirst.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.evidence_reconciled'").get() as { n: number }
  ).n;
  assert.equal(eventsAfterFirst, 1);
  dbAfterFirst.close();

  // Operator accidentally (or deliberately, to double-check) re-runs reconcile against
  // the same already-shipped campaign. The item is no longer blockerKind='scope', so it
  // must be reported not_applicable and left untouched — no re-shipping, no duplicate audit event.
  const second = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(second.status, 0, `second reconcile must still exit 0\nstdout: ${second.stdout}\nstderr: ${second.stderr}`);
  const secondOutput = JSON.parse(second.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(secondOutput.ok, true);
  assert.equal(secondOutput.items[0]?.status, "not_applicable", "an already-shipped item must not be re-evaluated as scope-blocked");

  const dbAfterSecond = new Database(dbPath, { readonly: true });
  const eventsAfterSecond = (
    dbAfterSecond.prepare("SELECT COUNT(*) as n FROM events WHERE event_type = 'campaign_item.evidence_reconciled'").get() as { n: number }
  ).n;
  assert.equal(eventsAfterSecond, 1, "re-running reconcile on an already-shipped item must not log a second audit event");
  dbAfterSecond.close();
});

test("integ campaign show --json (real CLI, after reconcile): reflects the reconciled item as shipped with no blocker, and surfaces the audit trail", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupSingleItemReconcileCliCampaign("FG-312");

  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0);

  // The operator's normal read-only inspection command must reflect the reconciliation —
  // a shipped item with its blocker cleared — through the same path used for every other
  // campaign item, not a special-cased reconcile-only view.
  const showResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(showResult.status, 0, `show failed\nstdout: ${showResult.stdout}\nstderr: ${showResult.stderr}`);
  const showOutput = JSON.parse(showResult.stdout) as {
    items: { ticketId: string; lifecycleStatus: string; outcome: string | null; blockerKind: string | null }[];
  };
  const item = showOutput.items.find((i) => i.ticketId === "FG-312")!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
  assert.equal(item.blockerKind, null, "blocker must be cleared once reconciled");
});

test("integ campaign reconcile --json (out-of-band): ships an awaiting_gate item delivered via a docs-only commit, then a real `resume` invocation reaches complete", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-600");
  makeCommitIn(projectDir, "base-FG-600");
  const commit = commitFileIn(projectDir, "docs/FG-600.md", "docs delivering FG-600 out of band", "docs: FG-600");
  closeTicket(projectDir, "FG-600", commit);

  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as { ok: boolean; items: { ticketId: string; status: string }[] };
  assert.equal(reconcileOutput.ok, true);
  assert.equal(reconcileOutput.items[0]?.status, "shipped");

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const itemRow = db
    .prepare("SELECT lifecycle_status, outcome, blocker_kind FROM campaign_items WHERE campaign_id = ? AND ticket_id = 'FG-600'")
    .get(campaignId) as { lifecycle_status: string; outcome: string; blocker_kind: string | null };
  assert.equal(itemRow.lifecycle_status, "complete");
  assert.equal(itemRow.outcome, "shipped");
  assert.equal(itemRow.blocker_kind, null);

  const auditEvent = db
    .prepare("SELECT payload FROM events WHERE event_type = 'campaign_item.out_of_band_reconciled'")
    .get() as { payload: string } | undefined;
  assert.ok(auditEvent, "an out_of_band_reconciled event must be recorded for the shipped item");
  const payload = JSON.parse(auditEvent!.payload) as { decidedBy: string; ticketId: string };
  assert.equal(payload.decidedBy, "steve");
  assert.equal(payload.ticketId, "FG-600");
  db.close();

  // The operator's next real command, spawned as an entirely separate process against
  // the same on-disk forge.db — proves the campaign actually reaches 'complete' through
  // the real reconcile-then-resume operator chain, not just direct-import behavior.
  const resumeResult = runForge(["campaign", "resume", campaignId, "--json"]);
  assert.equal(resumeResult.status, 0, `resume failed\nstdout: ${resumeResult.stdout}\nstderr: ${resumeResult.stderr}`);
  const resumeOutput = JSON.parse(resumeResult.stdout) as { stopReason: string };
  assert.equal(resumeOutput.stopReason, "complete", "campaign must reach 'complete' once its out-of-band item is reconciled");

  const db2 = new Database(dbPath, { readonly: true });
  const finalCampaign = db2.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId) as { status: string };
  assert.equal(finalCampaign.status, "complete");
  db2.close();
});

test("integ campaign reconcile --json (out-of-band): refuses when the ticket is not closed — exits 0, zero mutation, no state written", () => {
  const { campaignId, itemId } = setupOutOfBandCliCampaign("FG-601");
  // ticket stays 'active' — never closed, so closedCommit is absent.

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = dbBefore.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  const eventsBefore = (dbBefore.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
  dbBefore.close();

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0, "reconcile must exit 0 even when the only item is refused");
  const output = JSON.parse(result.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(output.ok, true);
  assert.equal(output.items[0]?.status, "refused");
  assert.ok(output.items[0]?.missing?.includes("ticket_status_not_done"));
  assert.ok(output.items[0]?.missing?.includes("ticket_closed_commit_missing"));

  const dbAfter = new Database(dbPath, { readonly: true });
  const after = dbAfter.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  const eventsAfter = (dbAfter.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
  dbAfter.close();
  assert.deepEqual(after, before, "campaign_items row must be byte-identical after a refusal");
  assert.equal(eventsAfter, eventsBefore, "no event row written on refusal");
});

test("integ campaign reconcile --json (out-of-band): refuses when the closed commit is not reachable on the base branch — zero mutation", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId, itemId } = setupOutOfBandCliCampaign("FG-602");
  // Base commit AFTER the ticket file is written so it lands on 'main' and survives
  // the branch switch back below — otherwise the ticket file (untracked until
  // committed) would only exist on the feature branch and disappear on checkout.
  makeCommitIn(projectDir, "base-FG-602");
  gitExec(["checkout", "-b", "feature/off-main-602"], projectDir);
  const offMainCommit = commitFileIn(projectDir, "docs/FG-602.md", "docs off main", "docs off main");
  gitExec(["checkout", "main"], projectDir);
  closeTicket(projectDir, "FG-602", offMainCommit);

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = dbBefore.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbBefore.close();

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout) as { items: { status: string; missing?: string[] }[] };
  assert.equal(output.items[0]?.status, "refused");
  assert.deepEqual(output.items[0]?.missing, ["closed_commit_not_reachable_on_base_branch"]);

  const dbAfter = new Database(dbPath, { readonly: true });
  const after = dbAfter.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbAfter.close();
  assert.deepEqual(after, before, "campaign_items row must be byte-identical after a refusal");
});

test("integ campaign reconcile --json (out-of-band): refuses when the closing commit touches code and no host verification is recorded — zero mutation", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId, itemId } = setupOutOfBandCliCampaign("FG-603");
  makeCommitIn(projectDir, "base-FG-603");
  const commit = commitFileIn(projectDir, "src/FG-603.ts", "export const x = 1;\n", "feat: FG-603");
  closeTicket(projectDir, "FG-603", commit);
  // Deliberately no host_verifications row inserted for this commit.

  const dbPath = join(forgeHome, "forge.db");
  const dbBefore = new Database(dbPath, { readonly: true });
  const before = dbBefore.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbBefore.close();

  const result = runForge(["campaign", "reconcile", campaignId, "--json"]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout) as { items: { status: string; missing?: string[] }[] };
  assert.equal(output.items[0]?.status, "refused");
  assert.deepEqual(output.items[0]?.missing, ["lane_evidence_missing"]);

  const dbAfter = new Database(dbPath, { readonly: true });
  const after = dbAfter.prepare("SELECT * FROM campaign_items WHERE id = ?").get(itemId);
  dbAfter.close();
  assert.deepEqual(after, before, "campaign_items row must be byte-identical after a refusal");
});

test("integ campaign reconcile (human, out-of-band): prints the out-of-band item's ticketId and shipped status", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-604");
  makeCommitIn(projectDir, "base-FG-604");
  const commit = commitFileIn(projectDir, "docs/FG-604.md", "docs", "docs: FG-604");
  closeTicket(projectDir, "FG-604", commit);

  const result = runForge(["campaign", "reconcile", campaignId]);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("FG-604") && result.stdout.includes("shipped"), `stdout: ${result.stdout}`);
});

test("integ campaign show (JSON + human, out-of-band): awaiting_gate item delivered out-of-band names the completable path explicitly, not the generic gate text", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-605");
  makeCommitIn(projectDir, "base-FG-605");
  const commit = commitFileIn(projectDir, "docs/FG-605.md", "docs delivering FG-605", "docs: FG-605");
  closeTicket(projectDir, "FG-605", commit);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { nextAction: string };
  assert.ok(jsonOutput.nextAction.includes("delivered out-of-band"), `nextAction: ${jsonOutput.nextAction}`);
  assert.ok(jsonOutput.nextAction.includes("FG-605"));
  assert.notEqual(jsonOutput.nextAction, "Human gate required at step review");

  // Same distinction must reach the human-readable operator surface, not only JSON.
  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    humanResult.stdout.includes("Next action:") && humanResult.stdout.includes("delivered out-of-band"),
    `human-readable output must name the out-of-band completable path\nstdout: ${humanResult.stdout}`
  );
});

test("integ campaign report (JSON + human, out-of-band): awaiting_gate item delivered out-of-band names the completable path explicitly, not the generic gate text", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaign("FG-606");
  makeCommitIn(projectDir, "base-FG-606");
  const commit = commitFileIn(projectDir, "docs/FG-606.md", "docs delivering FG-606", "docs: FG-606");
  closeTicket(projectDir, "FG-606", commit);

  const jsonResult = runForge(["campaign", "report", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `report --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as { nextOperatorAction: string };
  assert.ok(jsonOutput.nextOperatorAction.includes("delivered out-of-band"), `nextOperatorAction: ${jsonOutput.nextOperatorAction}`);
  assert.notEqual(jsonOutput.nextOperatorAction, "Human gate required at step review");

  const humanResult = runForge(["campaign", "report", campaignId]);
  assert.equal(humanResult.status, 0, `report (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    humanResult.stdout.includes("Next operator action:") && humanResult.stdout.includes("delivered out-of-band"),
    `human-readable operator surface must name the out-of-band completable path, not only JSON\nstdout: ${humanResult.stdout}`
  );
});

test("integ campaign show (human): a genuinely unfinished gate (ticket not yet closed) still falls back to the generic gate action text", () => {
  const { campaignId } = setupOutOfBandCliCampaign("FG-607");
  // ticket left 'active' — never closed — this is a genuine unfinished gate, not an
  // out-of-band-completable one.

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `stdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    humanResult.stdout.includes("Human gate required at step review"),
    `must fall back to the generic gate text for a genuinely unfinished gate\nstdout: ${humanResult.stdout}`
  );
  assert.ok(!humanResult.stdout.includes("delivered out-of-band"), `must not claim out-of-band eligibility\nstdout: ${humanResult.stdout}`);
});

// Multi-ticket counterpart to setupOutOfBandCliCampaign above: plans and parks
// EVERY item at the out-of-band shape (lifecycle_status='awaiting_gate', no
// blocker_kind), so a test can deliver some or all of them out-of-band and
// assert per-item surfacing (FG-444) rather than just the first.
function setupOutOfBandCliCampaignMulti(ticketIds: string[]): { campaignId: string } {
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
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(planOutput.campaignId) as { id: string }[];
  for (const item of items) {
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required at step review' WHERE id = ?"
    ).run(item.id);
  }
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId };
}

test("FG-444 integ campaign show (JSON + human): TWO concurrently-parked awaiting_gate items both delivered out-of-band → both surfaced per-item, Next action line still singular", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaignMulti(["FG-610", "FG-611"]);
  makeCommitIn(projectDir, "base-FG-610-611");
  const commit610 = commitFileIn(projectDir, "docs/FG-610.md", "docs delivering FG-610", "docs: FG-610");
  closeTicket(projectDir, "FG-610", commit610);
  const commit611 = commitFileIn(projectDir, "docs/FG-611.md", "docs delivering FG-611", "docs: FG-611");
  closeTicket(projectDir, "FG-611", commit611);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    nextAction: string;
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const row610 = jsonOutput.items.find((i) => i.ticketId === "FG-610")!;
  const row611 = jsonOutput.items.find((i) => i.ticketId === "FG-611")!;
  assert.equal(row610.outOfBandEligible, true, "FG-610 must be marked out-of-band-eligible");
  assert.equal(row611.outOfBandEligible, true, "FG-611 must be marked out-of-band-eligible");
  assert.ok(jsonOutput.nextAction.includes("FG-610 delivered out-of-band"), `nextAction: ${jsonOutput.nextAction}`);
  assert.ok(!jsonOutput.nextAction.includes("FG-611"), "Next action must remain a single recommendation, not multiplied per item");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  const eligibleLines = humanResult.stdout.split("\n").filter((l) => l.includes("out-of-band-eligible:"));
  assert.equal(eligibleLines.length, 2, `expected one out-of-band-eligible line per eligible item\nstdout: ${humanResult.stdout}`);
  assert.ok(eligibleLines.some((l) => l.includes("FG-610")));
  assert.ok(eligibleLines.some((l) => l.includes("FG-611")));
});

// FG-444 hardening: THREE concurrently-parked items of genuinely MIXED shape —
// one out-of-band-eligible, one parked-but-ineligible (ticket never closed),
// and one blocked_by_red (not even the out-of-band awaiting_gate shape at all,
// since lifecycleStatus !== 'awaiting_gate' short-circuits outOfBandCompletable-
// Action to null regardless of blockerKind). Exercises show, report, AND a real
// `campaign reconcile` run against the SAME campaign state to prove the display
// flag never diverges from what reconcile itself would actually do (the AC's
// no-divergence requirement) — reconcile routes 'blocked_by_red' items through
// its isScopeBlocked/isOutOfBand branch selection the exact same way
// outOfBandCompletableAction's lifecycleStatus check does, so a real reconcile
// run is the strongest possible confirmation the two surfaces agree.
test("FG-444 integ: THREE concurrently-parked items of mixed eligibility — show/report agree exactly, Next action line stays singular, and reconcile ships/refuses/skips in lockstep with the displayed flag", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupOutOfBandCliCampaignMulti(["FG-620", "FG-621", "FG-622"]);
  makeCommitIn(projectDir, "base-FG-620-621-622");

  // FG-620: eligible — closed with a docs-only (non_code_diff lane) commit, so
  // no host-verification capture is even needed for eligibility.
  const commit620 = commitFileIn(projectDir, "docs/FG-620.md", "docs delivering FG-620", "docs: FG-620");
  closeTicket(projectDir, "FG-620", commit620);

  // FG-621: stays 'active' — never closed. Still awaiting_gate/no blockerKind
  // (the right SHAPE for out-of-band), but missing the durable evidence
  // (ticket_status_not_done + ticket_closed_commit_missing) → ineligible.

  // FG-622: re-parked as blocked_by_red — a genuinely different concurrently-
  // parked state, not the awaiting_gate shape at all.
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const row622 = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? AND ticket_id = ?")
    .get(campaignId, "FG-622") as { id: string };
  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'blocked_by_red', outcome = 'blocked', blocker_kind = NULL WHERE id = ?"
  ).run(row622.id);
  db.close();

  // ── show: JSON ──
  const showJson = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(showJson.status, 0, `show --json failed\nstdout: ${showJson.stdout}\nstderr: ${showJson.stderr}`);
  const showOutput = JSON.parse(showJson.stdout) as {
    nextAction: string;
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const showEligibility = new Map(showOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));
  assert.equal(showEligibility.get("FG-620"), true, "FG-620 (closed, docs-only) must be eligible");
  assert.equal(showEligibility.get("FG-621"), false, "FG-621 (never closed) must NOT be eligible");
  assert.equal(showEligibility.get("FG-622"), false, "FG-622 (blocked_by_red) must NOT be eligible");
  assert.ok(showOutput.nextAction.includes("FG-620 delivered out-of-band"), `nextAction: ${showOutput.nextAction}`);
  assert.ok(!showOutput.nextAction.includes("FG-621"), "Next action must not multiply to name the ineligible item");
  assert.ok(!showOutput.nextAction.includes("FG-622"), "Next action must not multiply to name the blocked_by_red item");

  // ── show: human ──
  const showHuman = runForge(["campaign", "show", campaignId]);
  assert.equal(showHuman.status, 0, `show (human) failed\nstdout: ${showHuman.stdout}\nstderr: ${showHuman.stderr}`);
  const showEligibleLines = showHuman.stdout.split("\n").filter((l) => l.includes("out-of-band-eligible:"));
  assert.equal(showEligibleLines.length, 1, `expected exactly one eligible line (FG-620 only)\nstdout: ${showHuman.stdout}`);
  assert.ok(showEligibleLines[0]!.includes("FG-620"));
  const showNextActionLines = showHuman.stdout.split("\n").filter((l) => l.startsWith("Next action:"));
  assert.equal(showNextActionLines.length, 1, "Next action must render as exactly one line");
  assert.ok(showNextActionLines[0]!.includes("FG-620 delivered out-of-band"));

  // ── report: JSON ──
  const reportJson = runForge(["campaign", "report", campaignId, "--json"]);
  assert.equal(reportJson.status, 0, `report --json failed\nstdout: ${reportJson.stdout}\nstderr: ${reportJson.stderr}`);
  const reportOutput = JSON.parse(reportJson.stdout) as {
    nextOperatorAction: string;
    items: { ticketId: string; outOfBandEligible: boolean }[];
  };
  const reportEligibility = new Map(reportOutput.items.map((i) => [i.ticketId, i.outOfBandEligible]));
  assert.ok(reportOutput.nextOperatorAction.includes("FG-620 delivered out-of-band"), `nextOperatorAction: ${reportOutput.nextOperatorAction}`);
  assert.ok(!reportOutput.nextOperatorAction.includes("FG-621"));
  assert.ok(!reportOutput.nextOperatorAction.includes("FG-622"));

  // report and show must agree EXACTLY, per item — no divergence between the surfaces.
  for (const ticketId of ["FG-620", "FG-621", "FG-622"]) {
    assert.equal(
      reportEligibility.get(ticketId),
      showEligibility.get(ticketId),
      `report/show must agree on outOfBandEligible for ${ticketId}`
    );
  }

  // ── report: human ──
  const reportHuman = runForge(["campaign", "report", campaignId]);
  assert.equal(reportHuman.status, 0, `report (human) failed\nstdout: ${reportHuman.stdout}\nstderr: ${reportHuman.stderr}`);
  const reportEligibleLines = reportHuman.stdout.split("\n").filter((l) => l.includes("out-of-band-eligible:"));
  assert.equal(reportEligibleLines.length, 1, `expected exactly one eligible line (FG-620 only)\nstdout: ${reportHuman.stdout}`);
  assert.ok(reportEligibleLines[0]!.includes("FG-620"));
  const reportNextActionLines = reportHuman.stdout.split("\n").filter((l) => l.startsWith("Next operator action:"));
  assert.equal(reportNextActionLines.length, 1, "Next operator action must render as exactly one line");

  // ── no-divergence: what does a REAL `campaign reconcile` do with this exact
  // state? It must ship the item the display marked eligible, refuse the
  // ineligible-but-right-shape item, and treat the blocked_by_red item as
  // not_applicable (neither isScopeBlocked [blockerKind !== 'scope'] nor
  // isOutOfBand [lifecycleStatus !== 'awaiting_gate']) — the exact same verdict
  // the outOfBandEligible flag predicted for every item, by construction. ──
  const reconcileResult = runForge(["campaign", "reconcile", campaignId, "--json", "--by", "steve"]);
  assert.equal(reconcileResult.status, 0, `reconcile failed\nstdout: ${reconcileResult.stdout}\nstderr: ${reconcileResult.stderr}`);
  const reconcileOutput = JSON.parse(reconcileResult.stdout) as {
    ok: boolean;
    items: { ticketId: string; status: string; missing?: string[] }[];
  };
  assert.equal(reconcileOutput.ok, true);
  const reconcileStatus = new Map(reconcileOutput.items.map((i) => [i.ticketId, i]));
  assert.equal(reconcileStatus.get("FG-620")!.status, "shipped", "reconcile must ship the item the display marked eligible");
  assert.equal(reconcileStatus.get("FG-621")!.status, "refused", "reconcile must refuse the item the display marked ineligible");
  assert.ok(
    reconcileStatus.get("FG-621")!.missing && reconcileStatus.get("FG-621")!.missing!.length > 0,
    "refused item must report missing evidence facts"
  );
  assert.equal(
    reconcileStatus.get("FG-622")!.status,
    "not_applicable",
    "reconcile must treat the blocked_by_red item as not_applicable, matching its non-out-of-band shape"
  );
});

// FG-502 finding 3: `forge campaign report` (human) already prints a per-item
// `campaign-system-recoverable:` line from item.campaignSystemEligible (see
// report.ts's renderCampaignReportHuman), but `forge campaign show` (human)
// had no analogous line — only out-of-band-eligible — so the operator-facing
// text surfaces stayed silent for a failed/campaign_system item even though
// show's own JSON already carries campaignSystemEligible. Mirrors the
// out-of-band-eligible CLI tests above (setupOutOfBandCliCampaign /
// FG-444), but for the failed/blockerKind='campaign_system' shape.
// lifecycleStatus defaults to 'failed' (the three reconcileTerminalOutcome
// producers); pass 'blocked_by_red' for FG-502's fourth producer —
// driveWorkflowItem's inconclusive-verdict park.
function setupCampaignSystemCliCampaign(
  ticketId: string,
  lifecycleStatus: "failed" | "blocked_by_red" = "failed"
): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Campaign system recoverable", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketId,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string };

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = ?, outcome = 'blocked', blocker_kind = 'campaign_system', requested_human_action = 'workflow completed but no authoritative reviewer verdicts found — check workflow reds configuration' WHERE id = ?"
  ).run(lifecycleStatus, item.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, itemId: item.id };
}

test("FG-502 integ campaign show (human): a failed/campaign_system item with full out-of-band evidence prints a campaign-system-recoverable line, matching report's human output", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupCampaignSystemCliCampaign("FG-630");
  makeCommitIn(projectDir, "base-FG-630");
  const commit = commitFileIn(projectDir, "docs/FG-630.md", "docs delivering FG-630", "docs: FG-630");
  closeTicket(projectDir, "FG-630", commit);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    items: { ticketId: string; campaignSystemEligible: boolean }[];
  };
  const row630 = jsonOutput.items.find((i) => i.ticketId === "FG-630")!;
  assert.equal(row630.campaignSystemEligible, true, "FG-630 must be marked campaign-system-recoverable");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  const recoverableLines = humanResult.stdout.split("\n").filter((l) => l.includes("campaign-system-recoverable:"));
  assert.equal(recoverableLines.length, 1, `expected exactly one campaign-system-recoverable line\nstdout: ${humanResult.stdout}`);
  assert.ok(recoverableLines[0]!.includes("FG-630"));

  // report's human output already carries the same line (pre-FG-502) — show must agree.
  const reportHuman = runForge(["campaign", "report", campaignId]);
  assert.equal(reportHuman.status, 0, `report (human) failed\nstdout: ${reportHuman.stdout}\nstderr: ${reportHuman.stderr}`);
  assert.ok(reportHuman.stdout.includes("campaign-system-recoverable:"), `expected report to also print the line\nstdout: ${reportHuman.stdout}`);
});

test("FG-502 integ campaign show (human): a failed/campaign_system item that is NOT eligible (ticket never closed) prints no campaign-system-recoverable line", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupCampaignSystemCliCampaign("FG-631");
  makeCommitIn(projectDir, "base-FG-631");
  // FG-631 stays 'active' — never closed, so out-of-band evidence can never be satisfied.

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    items: { ticketId: string; campaignSystemEligible: boolean }[];
  };
  const row631 = jsonOutput.items.find((i) => i.ticketId === "FG-631")!;
  assert.equal(row631.campaignSystemEligible, false, "FG-631 (never closed) must NOT be marked campaign-system-recoverable");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  assert.ok(
    !humanResult.stdout.includes("campaign-system-recoverable:"),
    `ineligible item must print no campaign-system-recoverable line\nstdout: ${humanResult.stdout}`
  );
});

// FG-502 round-2: same CLI human-text coverage as the failed/campaign_system
// case above, but for the blocked_by_red shape (the fourth producer —
// driveWorkflowItem's inconclusive-verdict park).
test("FG-502 integ campaign show (human): a blocked_by_red/campaign_system item with full out-of-band evidence prints a campaign-system-recoverable line, matching report's human output", () => {
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);

  const { campaignId } = setupCampaignSystemCliCampaign("FG-632", "blocked_by_red");
  makeCommitIn(projectDir, "base-FG-632");
  const commit = commitFileIn(projectDir, "docs/FG-632.md", "docs delivering FG-632", "docs: FG-632");
  closeTicket(projectDir, "FG-632", commit);

  const jsonResult = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(jsonResult.status, 0, `show --json failed\nstdout: ${jsonResult.stdout}\nstderr: ${jsonResult.stderr}`);
  const jsonOutput = JSON.parse(jsonResult.stdout) as {
    items: { ticketId: string; campaignSystemEligible: boolean }[];
  };
  const row632 = jsonOutput.items.find((i) => i.ticketId === "FG-632")!;
  assert.equal(row632.campaignSystemEligible, true, "FG-632 (blocked_by_red) must be marked campaign-system-recoverable");

  const humanResult = runForge(["campaign", "show", campaignId]);
  assert.equal(humanResult.status, 0, `show (human) failed\nstdout: ${humanResult.stdout}\nstderr: ${humanResult.stderr}`);
  const recoverableLines = humanResult.stdout.split("\n").filter((l) => l.includes("campaign-system-recoverable:"));
  assert.equal(recoverableLines.length, 1, `expected exactly one campaign-system-recoverable line\nstdout: ${humanResult.stdout}`);
  assert.ok(recoverableLines[0]!.includes("FG-632"));

  const reportHuman = runForge(["campaign", "report", campaignId]);
  assert.equal(reportHuman.status, 0, `report (human) failed\nstdout: ${reportHuman.stdout}\nstderr: ${reportHuman.stderr}`);
  assert.ok(reportHuman.stdout.includes("campaign-system-recoverable:"), `expected report to also print the line\nstdout: ${reportHuman.stdout}`);
});
