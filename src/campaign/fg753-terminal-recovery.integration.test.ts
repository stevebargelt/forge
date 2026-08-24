// FG-753: terminal-campaign recovery via authenticated CI-evidence ingestion.
//
// `forge campaign reconcile --terminal-recovery <id>` closes a residual item on a
// COMPLETE (terminal) campaign using the SAME evidence bar the paused-only reconcile
// already composes — the only additions are the surface flag, the complete-status +
// residual-shape CAS writer, and threading an injectable checkStatusProvider into the
// existing runAndRecordHostVerification capture so a genuinely all-green required CI
// workflow mints the one source='ci' row that short-circuits the derived gate list.
//
// The enforcement half (FG-419/FG-367 lesson): every refusal below asserts NO NEW
// host_verifications row (count before == after) AND the item row byte-identical, so a
// guard is proven by the WRONG case being rejected with ZERO side effects. The single
// positive control proves the path is not inert: a real all-jobs-green provider response
// for the item's candidate mints exactly one source='ci' row and re-derives the item to
// complete/shipped — the FG-692 shape — WITHOUT touching run_id/branch/worktree/pr_url.
//
// The provider is ALWAYS injected (never the gh-backed default), so no test hits GitHub.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { insertHostVerification } from "../store/host-verifications.js";
import type { CiCheckStatus } from "../store/host-verifications.js";
import {
  approveCampaign,
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  updateCampaignItemIfCampaignCompleteAndShape,
} from "../store/campaigns.js";
import { planCampaign as _planCampaign } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import { reconcileCampaign } from "./reconcile.js";
import { collectReconcileEvidence } from "./reconcile-collect.js";
import { collectOutOfBandEvidence } from "./reconcile-outofband-collect.js";
import { registerRecordHostVerification } from "../cli/commands/record-host-verification.js";

// Forces executionMode:'invoke' for list campaigns so the planner resolves trivially —
// same wrapper reconcile.integration.test.ts uses. Reconcile never dispatches.
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

function gitExec(args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir,
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

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg753-terminal-"));
  gitExec(["init", "-b", "main"]);
  gitExec(["config", "user.email", "t@t.com"]);
  gitExec(["config", "user.name", "Test"]);
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function countHostVerifications(): number {
  return (db.prepare("SELECT COUNT(*) as n FROM host_verifications").get() as { n: number }).n;
}
function countHostVerificationsBySource(source: "host" | "ci"): number {
  return (db.prepare("SELECT COUNT(*) as n FROM host_verifications WHERE source = ?").get(source) as { n: number }).n;
}
function countEvents(): number {
  return (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
}
function headSha(): string {
  return gitExec(["rev-parse", "HEAD"]).trim();
}
function commitAll(message: string): string {
  gitExec(["add", "."]);
  gitExec(["commit", "-m", message]);
  return headSha();
}

type Shape = "out_of_band" | "campaign_system" | "shipped";

// Sets the residual lifecycle shape FG-753 recovers: out-of-band (awaiting_gate, no
// blockerKind) or campaign_system (failed, blocker_kind='campaign_system'); OR the
// FG-692 AC4 "shipped" shape — an ALREADY-complete/shipped item that is no residual at
// all, whose done-audit can still be gapped. Both residual shapes are non-terminal-enough
// to leave a wedged residual on an otherwise-complete campaign.
function applyShape(itemId: string, shape: Shape, runId: string | null): void {
  if (shape === "out_of_band") {
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, run_id = ?, requested_human_action = 'Human gate required at step review' WHERE id = ?"
    ).run(runId, itemId);
  } else if (shape === "campaign_system") {
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'failed', outcome = 'blocked', blocker_kind = 'campaign_system', run_id = ?, requested_human_action = 'workflow completed but no authoritative reviewer verdicts found' WHERE id = ?"
    ).run(runId, itemId);
  } else {
    db.prepare(
      "UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped', blocker_kind = NULL, run_id = ?, requested_human_action = NULL WHERE id = ?"
    ).run(runId, itemId);
  }
}

// A single-item campaign forced to 'complete' (terminal) with `ticketId`'s item parked
// in the given residual shape. The active ticket stub is written so the planner resolves
// it; callers layer git/ticket/CI evidence on top afterward.
function makeCompleteCampaign(
  ticketId: string,
  opts: { shape?: Shape; runId?: string | null } = {}
): { campaignId: string; itemId: string; runId: string | null } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: ticketId, body: "" });
  const { campaign } = planCampaign({ kind: "list", ticketIds: [ticketId] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "approved" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  const runId = opts.runId ?? null;
  applyShape(itemId, opts.shape ?? "out_of_band", runId);
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(campaign.id);
  return { campaignId: campaign.id, itemId, runId };
}

function writePackageJson(scripts: Record<string, string>): void {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.0.0", scripts }, null, 2)
  );
}

function writeCiWorkflow(jobs: { id: string; command: string }[]): void {
  mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
  const jobsYaml = jobs.map((j) => `  ${j.id}:\n    steps:\n      - run: ${j.command}`).join("\n");
  writeFileSync(join(projectDir, ".github", "workflows", "ci.yml"), `name: CI\njobs:\n${jobsYaml}\n`);
}

// Seeds a CODE-touching candidate for `ticketId` and leaves the working tree PRISTINE
// with HEAD on main — the pre-conditions runAndRecordHostVerification's capture requires.
// The ticket's closedCommit is the code candidate; HEAD is a later ticket-close commit
// that the candidate is an ancestor of (so ancestry+base-reachability coverage holds).
// Returns the candidate sha (closedCommit) and the tested HEAD sha the provider is keyed on.
function seedCleanCodeCandidate(
  ticketId: string,
  opts: { pkgScripts?: Record<string, string>; ciJobs?: { id: string; command: string }[] | null } = {}
): { candidate: string; headSha: string } {
  writeFileSync(join(projectDir, "README.md"), "base");
  commitAll(`base-${ticketId}`);

  writePackageJson(opts.pkgScripts ?? {});
  if (opts.ciJobs) writeCiWorkflow(opts.ciJobs);
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", `${ticketId}.ts`), `export const x_${ticketId.replace(/-/g, "_")} = 1;\n`);
  const candidate = commitAll(`feat: ${ticketId}`);

  closeTicket(projectDir, ticketId, candidate);
  const head = commitAll(`close ${ticketId}`);
  return { candidate, headSha: head };
}

// A provider that returns `state` (success by default) for every context whose sha equals
// `sha`, and tracks how many times it was consulted (INV-10 asserts zero consults).
function provider(sha: string, perContext: Record<string, CiCheckStatus["state"]> = {}, defaultState: CiCheckStatus["state"] = "success") {
  const calls: string[] = [];
  const fn = (opts: { projectDir: string; sha: string; checkContext: string }): CiCheckStatus | null => {
    calls.push(opts.checkContext);
    const state = perContext[opts.checkContext] ?? defaultState;
    return { sha, state, detailsUrl: "https://github.com/acme/forge/actions/runs/753" };
  };
  return { fn, calls };
}

// ── 1. flagless complete campaign refuses with the existing not-paused message ──

test("flagless: a complete campaign still refuses with the existing not-paused message (default path unchanged)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-1");
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  const result = reconcileCampaign(campaignId, { decidedBy: "steve" });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /is not paused/);
  assert.deepEqual(result.items, []);
  assert.deepEqual(getCampaignItem(itemId)!, before, "item row byte-identical — zero mutation");
  assert.equal(countHostVerifications(), beforeRows);
});

// ── 2. paused campaign under --terminal-recovery refuses (modes never overlap) ──

test("--terminal-recovery: a paused campaign refuses (the two modes never overlap)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-2");
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  const result = reconcileCampaign(campaignId, { terminalRecovery: true });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /is not complete/);
  assert.deepEqual(result.items, []);
  assert.deepEqual(getCampaignItem(itemId)!, before);
  assert.equal(countHostVerifications(), beforeRows);
});

// ── 3. --repo mismatching the stored projectDir refuses, no row ────────────────

test("--terminal-recovery --repo: a mismatching repo refuses mutation-free (INV-6 confused deputy)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-3");
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  const result = reconcileCampaign(campaignId, { terminalRecovery: true, repo: join(tmpdir(), "some-other-tree") });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /does not match/);
  assert.deepEqual(result.items, [], "no item processed — refusal is before the loop");
  assert.deepEqual(getCampaignItem(itemId)!, before);
  assert.equal(countHostVerifications(), beforeRows);
});

// ── 4. CI not whole-workflow green (green test + RED sibling on the same sha) ───

test("--terminal-recovery: one required job green but a sibling job RED on the same sha => refusal naming the gap, no source=ci row", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-4");
  const { headSha: head } = seedCleanCodeCandidate("FG-753-4", {
    pkgScripts: {}, // no test:all script — host fallback SKIPS, writing no row
    ciJobs: [
      { id: "test", command: "npm run test:all" },
      { id: "test-extended", command: "npm run test:extended" },
    ],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  // whole-workflow green is required: the paired job is green but its sibling is red.
  const p = provider(head, { "CI / test": "success", "CI / test-extended": "failure" });
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.ok, true);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(countHostVerifications(), beforeRows, "no source=ci row minted for a partially-red workflow");
  assert.deepEqual(getCampaignItem(itemId)!, before);
});

// ── 5. anti-replay: a foreign/stale run identity (sha mismatch) => no ship, no row (INV-5) ──

test("--terminal-recovery: a provider response reporting a DIFFERENT sha than requested is not accepted => no ship, no row (INV-5 anti-replay)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-5");
  seedCleanCodeCandidate("FG-753-5", {
    pkgScripts: {},
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  // The response is "success" but head_sha is a STALE/foreign commit — it must never be
  // credited to the requested candidate. Provider is keyed on a sha that is not HEAD.
  const p = provider("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.ok(p.calls.length > 0, "the provider WAS consulted — the refusal is the sha-binding rejecting its response, not a skipped call");
  assert.equal(countHostVerifications(), beforeRows, "a foreign-sha green response mints no row");
  assert.deepEqual(getCampaignItem(itemId)!, before);
});

// ── 6. a NULL-canonical pre-existing row DECLINES rather than matching (INV-9/FG-693) ──

test("--terminal-recovery: a NULL-canonical pre-existing host_verifications row DECLINES (never matches) — item refuses (INV-9/FG-693)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-6");
  const { candidate } = seedCleanCodeCandidate("FG-753-6", {
    pkgScripts: {}, // no test:all — host fallback skips
    ciJobs: null, // no CI pairing — the provider is never consulted
  });

  // A would-be covering row (right ticket/gate/sha, exit 0) but written with an
  // unresolvable project_dir and a NULL canonical: FG-693 declines it fail-closed, so it
  // must NOT satisfy the gate. Direct SQL leaves project_dir_canonical NULL.
  db.prepare(
    `INSERT INTO host_verifications
       (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url, project_dir_canonical)
     VALUES (?, ?, ?, 'npm run test:all', 'npm run test:all', 0, NULL, '2026-01-01T00:00:00Z', 'host', NULL, NULL)`
  ).run("FG-753-6", "/nonexistent/ghost/checkout", candidate);

  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  const p = provider(headSha());
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"], "the NULL-canonical row declined — it never counted as covering evidence");
  assert.equal(countHostVerifications(), beforeRows, "no new row; the ghost row remains, still declined");
  assert.deepEqual(getCampaignItem(itemId)!, before);
});

// ── 7. a candidate sha failing the SHA guard is rejected pre-call; no provider call, no row (INV-10) ──

test("--terminal-recovery: a malformed candidate (closedCommit) sha is rejected before any provider/gh call, no row (INV-10 argv-injection guard)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-7");
  writeFileSync(join(projectDir, "README.md"), "base");
  commitAll("base-FG-753-7");
  // Move the ticket to done, then overwrite its closedCommit with an argv-injection value
  // that can never be a real sha — the existing SHA guard must reject it before git/gh.
  closeTicket(projectDir, "FG-753-7", headSha());
  writeTicket(projectDir, {
    id: "FG-753-7",
    type: "story",
    status: "done",
    closedCommit: "--upload-pack=evil",
    title: "FG-753-7",
    body: "",
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  const p = provider(headSha());
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.items[0]!.status, "refused");
  assert.ok(result.items[0]!.missing!.includes("closed_commit_not_reachable_on_base_branch"));
  assert.equal(p.calls.length, 0, "the malformed candidate sha never reached the provider (nor gh)");
  assert.equal(countHostVerifications(), beforeRows);
  assert.deepEqual(getCampaignItem(itemId)!, before);
});

// ── 8. the terminal-writer CAS is a no-op when status != complete OR the shape moved ──

test("terminal writer CAS: mutates nothing when the campaign is not 'complete' or the observed residual shape no longer matches", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-8", { shape: "out_of_band" });
  const observed = { lifecycleStatus: "awaiting_gate" as const, blockerKind: null };
  const shipTo = { lifecycleStatus: "complete" as const, outcome: "shipped" as const, blockerKind: undefined, reason: undefined, requestedHumanAction: undefined };

  // (a) campaign not complete → false, no mutation.
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
  let before = getCampaignItem(itemId)!;
  assert.equal(updateCampaignItemIfCampaignCompleteAndShape(itemId, campaignId, observed, shipTo), false);
  assert.deepEqual(getCampaignItem(itemId)!, before);

  // (b) complete but the observed shape no longer matches (item already re-derived) → false.
  db.prepare("UPDATE campaigns SET status = 'complete' WHERE id = ?").run(campaignId);
  before = getCampaignItem(itemId)!;
  const staleShape = { lifecycleStatus: "failed" as const, blockerKind: "campaign_system" as const };
  assert.equal(updateCampaignItemIfCampaignCompleteAndShape(itemId, campaignId, staleShape, shipTo), false);
  assert.deepEqual(getCampaignItem(itemId)!, before);

  // (c) complete AND the shape matches → true, and exactly the five ship columns move.
  assert.equal(updateCampaignItemIfCampaignCompleteAndShape(itemId, campaignId, observed, shipTo), true);
  const after = getCampaignItem(itemId)!;
  assert.equal(after.lifecycleStatus, "complete");
  assert.equal(after.outcome, "shipped");
  assert.equal(after.blockerKind, undefined);
});

test("--terminal-recovery: a concurrent flip out of 'complete' mid-reconcile leaves the item unmutated", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-8b");
  seedCleanCodeCandidate("FG-753-8b", {
    pkgScripts: { "test:all": "exit 0" },
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });
  const before = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  // Flip the campaign out of 'complete' inside the collect seam — strictly after the
  // up-front check and strictly before the guarded write, the exact race the CAS closes.
  const collectOutOfBand: typeof collectOutOfBandEvidence = (dir, item) => {
    db.prepare("UPDATE campaigns SET status = 'abandoned' WHERE id = ?").run(campaignId);
    return collectOutOfBandEvidence(dir, item);
  };
  const p = provider(headSha());
  const result = reconcileCampaign(campaignId, {
    terminalRecovery: true,
    checkStatusProvider: p.fn,
    collectOutOfBandEvidence: collectOutOfBand,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /residual shape changed|left 'complete'/);
  assert.deepEqual(getCampaignItem(itemId)!, before, "item byte-identical — the CAS refused the stale write");
  assert.equal(countEvents(), beforeEvents, "no audit event for a write that never landed");
});

// ── 9. INV-2: no operator command can write source=ci with caller-set fields ──

test("INV-2: record-host-verification exposes no --source affordance (source=ci is provider-only)", () => {
  const program = new Command();
  registerRecordHostVerification(program);
  const cmd = program.commands.find((c) => c.name() === "record-host-verification")!;
  assert.ok(cmd, "record-host-verification command is registered");
  const longFlags = cmd.options.map((o) => o.long);
  assert.ok(!longFlags.includes("--source"), "no --source option — an operator cannot mint source=ci");
  assert.ok(!longFlags.includes("--conclusion") && !longFlags.includes("--url"), "no caller-set conclusion/url either");
  assert.ok(longFlags.includes("--command"), "a real command is still required as proof of a real result");
});

// ── 10. provider unreachable/unauthenticated/rate-limited => refusal, no row ──

test("--terminal-recovery: an unreachable/unauthenticated provider (null response) => refusal, no row", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-10");
  seedCleanCodeCandidate("FG-753-10", {
    pkgScripts: {},
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  // null models gh missing / unauthenticated / rate-limited — findCoveringGateEvidence
  // fails closed rather than assuming coverage.
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: () => null });

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(countHostVerifications(), beforeRows);
  assert.deepEqual(getCampaignItem(itemId)!, before);
});

// ── 11. POSITIVE control: genuine all-jobs-green => one source=ci row + item ships (the FG-692 shape) ──

test("--terminal-recovery: a genuine all-jobs-green provider response for the candidate mints exactly one source=ci row and re-derives the item to complete/shipped (FG-692 shape), no dispatch / run-graph mutation", () => {
  const runId = "run-fg753-11";
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-11", { shape: "out_of_band", runId });
  const { headSha: head } = seedCleanCodeCandidate("FG-753-11", {
    pkgScripts: { "test:all": "exit 0" },
    ciJobs: [
      { id: "test", command: "npm run test:all" },
      { id: "test-extended", command: "npm run test:extended" },
    ],
  });
  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();

  // Green on BOTH required CI checks at the exact candidate HEAD — the FG-692 shape.
  const p = provider(head, { "CI / test": "success", "CI / test-extended": "success" });
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, decidedBy: "steve", checkStatusProvider: p.fn });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "shipped");
  assert.equal(result.items[0]!.missing, undefined);

  // Exactly ONE source=ci row: exitCode 0, the provider's sha + url, gate = the required gate.
  const rows = db
    .prepare("SELECT * FROM host_verifications WHERE ticket_id = ?")
    .all("FG-753-11") as { source: string; exit_code: number; commit_sha: string; ci_url: string | null; command: string }[];
  assert.equal(rows.length, 1, "exactly one row minted");
  assert.equal(rows[0]!.source, "ci");
  assert.equal(rows[0]!.exit_code, 0);
  assert.equal(rows[0]!.commit_sha, head, "recorded sha is the provider response head_sha for projectDir HEAD");
  assert.equal(rows[0]!.command, "npm run test:all");
  assert.ok(rows[0]!.ci_url, "the identifying provider URL is persisted for audit (INV-5)");

  // Item re-derives to complete/shipped, the five ship columns exactly.
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
  assert.equal(item.blockerKind, undefined);
  assert.equal(item.reason, undefined);
  assert.equal(item.requestedHumanAction, undefined);

  // INV-8: no dispatch, no run-graph rewrite — run_id preserved, branch/worktree/pr_url untouched.
  assert.equal(item.runId, runId, "run_id preserved — the recovery never touched the run graph");
  assert.equal(item.branch, beforeItem.branch);
  assert.equal(item.worktreePath, beforeItem.worktreePath);
  assert.equal(item.prUrl, beforeItem.prUrl);

  // Exactly one audit event, of the out-of-band kind.
  assert.equal(countEvents(), beforeEvents + 1, "exactly one new event row");
  const ev = db
    .prepare("SELECT event_type, payload FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { event_type: string; payload: string };
  assert.equal(ev.event_type, "campaign_item.out_of_band_reconciled");
  const payload = JSON.parse(ev.payload) as { ticketId: string; decidedBy: string; evidence: unknown };
  assert.equal(payload.ticketId, "FG-753-11");
  assert.equal(payload.decidedBy, "steve");
  assert.ok(payload.evidence, "evidence embedded in the audit payload");
});

// ── campaign_system residual shape recovers too (parity with out-of-band) ──

test("--terminal-recovery: a campaign_system residual on a complete campaign recovers via the same evidence bar, distinct audit kind", () => {
  const runId = "run-fg753-12";
  const { campaignId, itemId } = makeCompleteCampaign("FG-753-12", { shape: "campaign_system", runId });
  const { headSha: head } = seedCleanCodeCandidate("FG-753-12", {
    pkgScripts: { "test:all": "exit 0" },
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });

  const p = provider(head);
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.items[0]!.status, "shipped");
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "complete");
  assert.equal(item.outcome, "shipped");
  assert.equal(item.blockerKind, undefined);

  const ev = db
    .prepare("SELECT event_type FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { event_type: string };
  assert.equal(ev.event_type, "campaign_item.campaign_system_reconciled");
});

// ── FG-692 AC4: done-audit evidence backfill for an ALREADY-shipped, gapped item ──

// POSITIVE control (the FG-692 shape): a complete campaign with a complete/shipped item
// whose ticket is done at a green candidate but whose done-audit is GAPPED (no source=ci
// row) => --terminal-recovery records EXACTLY ONE source=ci row at the provider's
// candidate; the item's lifecycle is UNCHANGED (never mutated); a DISTINCT backfill audit
// event is emitted; NO dispatch, NO run-graph mutation; and the derived-gate-list coverage
// now passes (the verdict would derive to complete).
test("--terminal-recovery: an already-shipped item with a GAPPED done-audit (no source=ci row) backfills exactly one source=ci row, lifecycle unchanged, distinct audit event, no run-graph mutation (FG-692 AC4)", () => {
  const runId = "run-fg753-backfill";
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-1", { shape: "shipped", runId });
  const { headSha: head } = seedCleanCodeCandidate("FG-692-1", {
    // test:extended present => the derived gate list is [test:all, test:extended]; a
    // host row covering only the primary gate leaves the extended member uncovered.
    pkgScripts: { "test:all": "exit 0", "test:extended": "exit 0" },
    ciJobs: [
      { id: "test", command: "npm run test:all" },
      { id: "test-extended", command: "npm run test:extended" },
    ],
  });
  // The item ships with ONLY source=host rows and NO source=ci row — test:extended can't
  // green on macOS, so the gate list stays uncovered. Seed a covering-but-non-ci host row
  // for the primary gate to reproduce the real FG-692 shape (host evidence present,
  // whole-workflow ci evidence absent → done-audit gapped).
  insertHostVerification({
    ticketId: "FG-692-1",
    projectDir,
    commitSha: head,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    runId,
    recordedAt: "2026-01-01T00:00:00Z",
    source: "host",
  });
  // Precondition: the gate-list coverage is gapped (no ci row => extended-tier member
  // uncovered), so the campaign verdict would be complete_with_issues.
  const gapCheck = collectReconcileEvidence(projectDir, getCampaignItem(itemId)!);
  assert.equal(gapCheck.hostVerification?.passed, false, "precondition: gate-list coverage is gapped before backfill");

  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();
  const beforeRows = countHostVerifications();

  const p = provider(head, { "CI / test": "success", "CI / test-extended": "success" });
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, decidedBy: "steve", checkStatusProvider: p.fn });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "evidence_recorded");
  assert.equal(result.items[0]!.missing, undefined);

  // Exactly ONE new row, and it is the source=ci mint at the candidate.
  assert.equal(countHostVerifications(), beforeRows + 1, "exactly one new row minted");
  const ciRows = db
    .prepare("SELECT * FROM host_verifications WHERE ticket_id = ? AND source = 'ci'")
    .all("FG-692-1") as { source: string; exit_code: number; commit_sha: string; ci_url: string | null; command: string }[];
  assert.equal(ciRows.length, 1, "exactly one source=ci row");
  assert.equal(ciRows[0]!.exit_code, 0);
  assert.equal(ciRows[0]!.commit_sha, head);
  assert.equal(ciRows[0]!.command, "npm run test:all");
  assert.ok(ciRows[0]!.ci_url, "the identifying provider URL is persisted for audit");

  // The item's lifecycle is UNCHANGED — nothing re-derived, item row byte-identical.
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem, "already-shipped item never mutated by the backfill");
  // INV-8: no dispatch / no run-graph rewrite.
  const after = getCampaignItem(itemId)!;
  assert.equal(after.runId, runId);
  assert.equal(after.branch, beforeItem.branch);
  assert.equal(after.worktreePath, beforeItem.worktreePath);
  assert.equal(after.prUrl, beforeItem.prUrl);

  // The gate-list coverage now passes — the verdict would derive to complete.
  const covered = collectReconcileEvidence(projectDir, getCampaignItem(itemId)!);
  assert.equal(covered.hostVerification?.passed, true, "derived gate-list coverage now passes after the ci-row backfill");

  // Exactly one new audit event, of the DISTINCT backfill kind.
  assert.equal(countEvents(), beforeEvents + 1, "exactly one new event row");
  const ev = db
    .prepare("SELECT event_type, payload FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { event_type: string; payload: string };
  assert.equal(ev.event_type, "campaign_item.ci_evidence_backfilled");
  const payload = JSON.parse(ev.payload) as { ticketId: string; decidedBy: string; evidence: unknown };
  assert.equal(payload.ticketId, "FG-692-1");
  assert.equal(payload.decidedBy, "steve");
  assert.ok(payload.evidence, "evidence embedded in the audit payload");
});

// IDEMPOTENT / no-op: an already-shipped item that ALREADY has a covering source=ci row is
// not gapped — no runGate call, no duplicate row, no event, reported not_applicable.
test("--terminal-recovery: an already-shipped item already covered by a source=ci row is a no-op — no duplicate row, no event, not_applicable", () => {
  const runId = "run-fg753-idem";
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-2", { shape: "shipped", runId });
  const { headSha: head } = seedCleanCodeCandidate("FG-692-2", {
    pkgScripts: { "test:all": "exit 0" },
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });
  // Already covered: a source=ci row for the exact candidate + gate.
  insertHostVerification({
    ticketId: "FG-692-2",
    projectDir,
    commitSha: head,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    runId,
    recordedAt: "2026-01-01T00:00:00Z",
    source: "ci",
    ciUrl: "https://github.com/acme/forge/actions/runs/1",
  });
  const beforeItem = getCampaignItem(itemId)!;
  const beforeEvents = countEvents();
  const beforeRows = countHostVerifications();

  const p = provider(head);
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.ok, true);
  assert.equal(result.items[0]!.status, "not_applicable");
  assert.equal(countHostVerifications(), beforeRows, "no duplicate row written");
  assert.equal(countEvents(), beforeEvents, "no audit event for a no-op");
  assert.equal(p.calls.length, 0, "runGate never called — the gap gate short-circuited before any provider consult");
  assert.deepEqual(getCampaignItem(itemId)!, beforeItem);
});

// NEGATIVE (INV-7, mutation-free): a shipped, gapped item whose ticket is NOT done => no
// runGate call, no row, item unchanged, named refusal.
test("--terminal-recovery: a shipped gapped item whose ticket is NOT done refuses mutation-free (INV-7), no row, no provider call", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-3", { shape: "shipped" });
  // A code candidate exists but the ticket is left ACTIVE (not done) — collectReconcile
  // reads status from frontmatter; leave it active with no closedCommit recorded.
  writeFileSync(join(projectDir, "README.md"), "base");
  commitAll("base-FG-692-3");
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  const p = provider(headSha());
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.ok, true);
  assert.equal(result.items[0]!.status, "refused");
  assert.ok(result.items[0]!.missing!.includes("ticket_status_not_done"));
  assert.equal(p.calls.length, 0, "no provider call for a not-done ticket");
  assert.equal(countHostVerifications(), beforeRows, "no row written");
  assert.deepEqual(getCampaignItem(itemId)!, before);
});

// NEGATIVE (RF-2, INV-1/INV-4): a shipped, gapped item at a done, reachable candidate
// with a RUNNABLE, locally-PASSING host gate but NO authenticated CI evidence (provider
// unavailable) => the backfill records NO source=ci row, emits NO event, item unchanged.
// This is the case FG-692-4 could not exercise: it removed test:all so the host fallback
// skipped — here test:all is present and would pass locally (exit 0). Under the old check
// (`hostVerification.passed`, satisfied by ANY passing row) a local source=host exec would
// have falsely closed the done-audit gap with non-CI evidence; the CI-evidence-only capture
// + viaCi coverage gate now refuses it.
test("--terminal-recovery: a shipped gapped item with a locally-passing host gate but no CI evidence records NO backfill and emits no event (RF-2, INV-1/INV-4)", () => {
  const runId = "run-fg692-5";
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-5", { shape: "shipped", runId });
  seedCleanCodeCandidate("FG-692-5", {
    // test:all IS runnable and would pass locally — the exact "fast gate passes locally"
    // shape. A source=host exec must NOT be accepted as CI-authenticated coverage.
    pkgScripts: { "test:all": "exit 0" },
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();
  const beforeEvents = countEvents();

  // Provider unavailable/unauthenticated (null) — no authenticated CI evidence exists.
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: () => null });

  assert.equal(result.ok, true);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(countHostVerifications(), beforeRows, "no row minted — the local host-gate fallback was suppressed, not recorded as CI evidence");
  assert.equal(countHostVerificationsBySource("host"), 0, "explicitly: the backfill minted NO source=host row — it never ran the local gate list");
  assert.equal(countHostVerificationsBySource("ci"), 0, "and no source=ci row either — the provider authenticated nothing");
  assert.equal(countEvents(), beforeEvents, "no ci_evidence_backfilled event for a host-only would-be pass");
  assert.deepEqual(getCampaignItem(itemId)!, before, "item byte-identical — mutation-free refusal");
});

// NEGATIVE (RF-2, INV-5 anti-replay): a shipped, gapped item whose provider reports
// "success" but for a DIFFERENT sha than the candidate HEAD => findCoveringGateEvidence's
// sha-binding rejects it, so the backfill mints NO row of ANY source, emits no event, and
// leaves the item byte-identical. A foreign-sha green response must never be credited to
// this candidate (the same anti-replay guard the residual matrix asserts, here on the
// backfill path).
test("--terminal-recovery: a shipped gapped item whose provider reports green for a FOREIGN sha mints no backfill row (RF-2, INV-5 anti-replay)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-7", { shape: "shipped" });
  seedCleanCodeCandidate("FG-692-7", {
    pkgScripts: { "test:all": "exit 0" },
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();
  const beforeEvents = countEvents();

  // Provider answers "success" but keyed on a stale/foreign sha that is not HEAD — the
  // sha-binding in findCoveringGateEvidence rejects it as covering the candidate.
  const p = provider("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.ok(p.calls.length > 0, "the provider WAS consulted — the refusal is the sha-binding rejecting its foreign-sha response");
  assert.equal(countHostVerifications(), beforeRows, "no row minted for a foreign-sha green response");
  assert.equal(countHostVerificationsBySource("host"), 0, "explicitly: no source=host row minted by the backfill");
  assert.equal(countHostVerificationsBySource("ci"), 0, "and no source=ci row credited to the wrong sha");
  assert.equal(countEvents(), beforeEvents, "no ci_evidence_backfilled event");
  assert.deepEqual(getCampaignItem(itemId)!, before, "item byte-identical — mutation-free refusal");
});

// NEGATIVE (RF-1, audit atomicity): the source=ci mint and its ci_evidence_backfilled
// audit event commit in ONE transaction. Fault-inject a failing event insert (drop the
// events table) after the provider authenticates green; the row runGate minted must roll
// back with the event, leaving NO durable source=ci row without its covering audit event.
test("--terminal-recovery: a failed audit-event insert rolls back the source=ci row too — no backfill row without its event (RF-1 atomicity)", () => {
  // No runId: collectReconcileEvidence then skips the run-events read, so the ONLY events
  // access in this path is the backfill's own logEvent — which we force to throw below.
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-6", { shape: "shipped", runId: null });
  const { headSha: head } = seedCleanCodeCandidate("FG-692-6", {
    pkgScripts: { "test:all": "exit 0" },
    ciJobs: [{ id: "test", command: "npm run test:all" }],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  // Provider IS all-green — absent the atomicity fix, runGate mints a source=ci row and the
  // event insert is what fails. Drop the events table so logEvent throws inside the write
  // transaction, forcing the rollback path.
  db.exec("DROP TABLE events");
  const p = provider(head, { "CI / test": "success" });
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, decidedBy: "steve", checkStatusProvider: p.fn });

  assert.equal(result.ok, true);
  assert.equal(result.items[0]!.status, "refused", "the failed atomic write degrades to a named refusal, not a partial success");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(countHostVerifications(), beforeRows, "the source=ci row rolled back with the failed event — no durable row without its audit event");
  assert.deepEqual(getCampaignItem(itemId)!, before, "already-shipped item never mutated");
});

// NEGATIVE (RF-2, INV-7/INV-8): a shipped, gapped item whose candidate the provider
// reports whole-workflow green, BUT the campaign flips out of 'complete' AFTER the
// up-front check and BEFORE the guarded backfill write => the in-transaction
// campaign.status='complete' re-check makes the mint a zero-row no-op: NO source=ci row,
// NO ci_evidence_backfilled event, item byte-identical. This is the race the write-time
// status guard closes — the finding's exact negative test (no row, no event on a flip).
test("--terminal-recovery: a concurrent flip out of 'complete' between probe and backfill write mints no source=ci row and emits no event (RF-2)", () => {
  const runId = "run-fg692-rf2";
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-RF2", { shape: "shipped", runId });
  const { headSha: head } = seedCleanCodeCandidate("FG-692-RF2", {
    pkgScripts: { "test:all": "exit 0", "test:extended": "exit 0" },
    ciJobs: [
      { id: "test", command: "npm run test:all" },
      { id: "test-extended", command: "npm run test:extended" },
    ],
  });
  // A covering host row for the primary gate reproduces the real gap (host present,
  // whole-workflow ci absent) so the backfill path is reached and the provider authenticates.
  insertHostVerification({
    ticketId: "FG-692-RF2",
    projectDir,
    commitSha: head,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    runId,
    recordedAt: "2026-01-01T00:00:00Z",
    source: "host",
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();
  const beforeEvents = countEvents();

  // Flip the campaign out of 'complete' inside the backfill's collect seam — strictly
  // after the up-front complete check and strictly before the guarded write.
  const collectEvidence: typeof collectReconcileEvidence = (dir, item) => {
    db.prepare("UPDATE campaigns SET status = 'abandoned' WHERE id = ?").run(campaignId);
    return collectReconcileEvidence(dir, item);
  };
  const p = provider(head, { "CI / test": "success", "CI / test-extended": "success" });
  const result = reconcileCampaign(campaignId, {
    terminalRecovery: true,
    decidedBy: "steve",
    checkStatusProvider: p.fn,
    collectEvidence,
  });

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(countHostVerifications(), beforeRows, "no source=ci row minted after the campaign left 'complete'");
  assert.equal(countHostVerificationsBySource("ci"), 0, "explicitly: no source=ci row for a no-longer-complete campaign");
  assert.equal(countEvents(), beforeEvents, "no ci_evidence_backfilled event for a write that never landed");
  assert.deepEqual(getCampaignItem(itemId)!, before, "item byte-identical — mutation-free");
});

// NEGATIVE (RF-3, INV-5 anti-replay): a shipped, gapped item whose required CI checks are
// each green at the candidate but report DIFFERENT immutable run identities (a green
// scattered across two workflow runs of the same sha) => the probe refuses to anchor the
// mint to scattered run identities: NO source=ci row, NO event, item byte-identical.
test("--terminal-recovery: required CI checks green but on DIFFERENT run identities mints no source=ci row (RF-3, INV-5 anti-replay)", () => {
  const runId = "run-fg692-rf3";
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-RF3", { shape: "shipped", runId });
  const { headSha: head } = seedCleanCodeCandidate("FG-692-RF3", {
    pkgScripts: { "test:all": "exit 0", "test:extended": "exit 0" },
    ciJobs: [
      { id: "test", command: "npm run test:all" },
      { id: "test-extended", command: "npm run test:extended" },
    ],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();
  const beforeEvents = countEvents();

  // Both jobs green at the candidate sha, but each from a DIFFERENT workflow run — the
  // URLs carry run ids 100 and 200. No common run identity => uncovered, no mint.
  const perRun: Record<string, string> = {
    "CI / test": "https://github.com/acme/forge/actions/runs/100/job/1",
    "CI / test-extended": "https://github.com/acme/forge/actions/runs/200/job/2",
  };
  const scatteredProvider = (opts: { projectDir: string; sha: string; checkContext: string }): CiCheckStatus | null => ({
    sha: head,
    state: "success",
    detailsUrl: perRun[opts.checkContext] ?? "https://github.com/acme/forge/actions/runs/999",
  });
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: scatteredProvider });

  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(countHostVerifications(), beforeRows, "no source=ci row minted for scattered run identities");
  assert.equal(countHostVerificationsBySource("ci"), 0);
  assert.equal(countEvents(), beforeEvents, "no ci_evidence_backfilled event");
  assert.deepEqual(getCampaignItem(itemId)!, before, "item byte-identical — mutation-free");
});

// POSITIVE (RF-3, INV-5): a genuine whole-workflow-green backfill RETAINS the common
// immutable run identity in the ci_evidence_backfilled audit payload, alongside ciUrl —
// the mint is anchored to a verifiable run identity.
test("--terminal-recovery: the backfill audit event retains the common immutable run identity (RF-3, INV-5)", () => {
  const runId = "run-fg692-rf3-pos";
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-RF3P", { shape: "shipped", runId });
  const { headSha: head } = seedCleanCodeCandidate("FG-692-RF3P", {
    pkgScripts: { "test:all": "exit 0", "test:extended": "exit 0" },
    ciJobs: [
      { id: "test", command: "npm run test:all" },
      { id: "test-extended", command: "npm run test:extended" },
    ],
  });
  insertHostVerification({
    ticketId: "FG-692-RF3P",
    projectDir,
    commitSha: head,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    runId,
    recordedAt: "2026-01-01T00:00:00Z",
    source: "host",
  });

  // Both jobs green at the candidate, same workflow run (run id 753 in both URLs).
  const p = provider(head, { "CI / test": "success", "CI / test-extended": "success" });
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, decidedBy: "steve", checkStatusProvider: p.fn });

  assert.equal(result.items[0]!.status, "evidence_recorded");
  const ev = db
    .prepare("SELECT payload FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
    .get(runId) as { payload: string };
  const payload = JSON.parse(ev.payload) as { evidence: { runIdentity?: string; ciUrl?: string | null } };
  assert.equal(payload.evidence.runIdentity, "753", "the common immutable run identity is retained on the mint's audit event");
  assert.ok(payload.evidence.ciUrl, "the identifying provider URL is retained alongside the run identity");
});

// NEGATIVE (INV-4/INV-7): a shipped, gapped item at a done, reachable candidate that the
// provider does NOT report green (and no runnable host gate) => no row, item unchanged,
// named refusal. Same fail-closed shape as the residual negative matrix (rows 4/5/10).
test("--terminal-recovery: a shipped gapped item whose candidate the provider does NOT report green refuses, no row (INV-4 fail-closed)", () => {
  const { campaignId, itemId } = makeCompleteCampaign("FG-692-4", { shape: "shipped" });
  seedCleanCodeCandidate("FG-692-4", {
    pkgScripts: {}, // no test:all script — the host fallback SKIPS, writing no row
    ciJobs: [
      { id: "test", command: "npm run test:all" },
      { id: "test-extended", command: "npm run test:extended" },
    ],
  });
  const before = getCampaignItem(itemId)!;
  const beforeRows = countHostVerifications();

  // Green on the fast job but RED on its sibling — not whole-workflow green, so no ci mint.
  const p = provider(headSha(), { "CI / test": "success", "CI / test-extended": "failure" });
  const result = reconcileCampaign(campaignId, { terminalRecovery: true, checkStatusProvider: p.fn });

  assert.equal(result.ok, true);
  assert.equal(result.items[0]!.status, "refused");
  assert.deepEqual(result.items[0]!.missing, ["lane_evidence_missing"]);
  assert.equal(countHostVerifications(), beforeRows, "no row minted for a partially-red workflow");
  assert.deepEqual(getCampaignItem(itemId)!, before);
});
