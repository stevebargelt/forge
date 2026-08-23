// FG-402: the Human Attention Inbox aggregator + /api/attention-inbox route, against a
// seeded store. Covers the four AC-named scenarios (gate wait, reviewer/red block,
// missing acceptance criteria, auth/setup), the dedup collapse of one run carrying two
// reasons, and the absence of items from resolved/superseded/closed sources.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PORT = 18402;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "forge-inbox-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { attentionInbox } = await import("./queries.js");

const AT = "2026-08-22T09:00:00Z";
const OLDER = "2026-08-20T09:00:00Z";
// FG-746: a fixed evaluation instant so the stale-verification source is deterministic
// regardless of the container clock. The gate start is placed 15m before it (past the
// 10m campaign-host-gate staleness cutoff, well within the 24h lookback).
const VERIF_NOW = Date.parse("2026-08-22T09:00:00Z");
const VERIF_START = new Date(VERIF_NOW - 15 * 60_000).toISOString();

// A project checkout that carries the `feature` workflow as a PROJECT OVERRIDE, so the
// human-gate resolver loads it (isProject → no seed-generation manifest check) and
// resolves step `architect` to gate: human — the durable signal a gate wait derives from.
const HERE = dirname(fileURLToPath(import.meta.url));
const featureSrc = join(HERE, "../../seeds/workflows/feature.yml");
const projectDir = mkdtempSync(join(tmpdir(), "forge-inbox-proj-"));
mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
copyFileSync(featureSrc, join(projectDir, ".forge", "workflows", "feature.yml"));

function seed(): void {
  writeTransaction(() => {
    const db = getDb();
    const run = db.prepare(
      `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, metadata) VALUES (?,?,?,?,?,?,?)`,
    );
    const task = db.prepare(
      `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?,?,?,?,?,?,?,?)`,
    );
    const failedEvent = db.prepare(
      `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)`,
    );
    const ticket = db.prepare(
      `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, body_hash, imported_at) VALUES (?,?,?,?,?,?,?,?)`,
    );
    const readiness = db.prepare(
      `INSERT INTO readiness_assessments (project_key, ticket_id, body_hash, outcome, gaps_json, evaluated_at) VALUES (?,?,?,?,?,?)`,
    );
    const review = db.prepare(
      `INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, state, review_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    );
    const finding = db.prepare(
      `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, disposition, resolution, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    );

    // (1) GATE WAIT — an awaiting_gate task at a human step on an active feature run.
    run.run("run-gate", "feature", "gate run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-500" }));
    task.run("task-gate", "run-gate", "architect", "architecture-advisor", "awaiting_gate", "{}", AT, OLDER);

    // (2) REVIEWER / RED BLOCK — a task in blocked_by_red on an active run.
    run.run("run-red", "feature", "red run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-501" }));
    task.run("task-red", "run-red", "build", "engineer", "blocked_by_red", "{}", AT, OLDER);

    // (4) AUTH / SETUP — a failed task whose newest task.failed names auth_missing.
    run.run("run-auth", "feature", "auth run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-502" }));
    task.run("task-auth", "run-auth", "build", "engineer", "failed", "{}", AT, OLDER);
    failedEvent.run("run-auth", "task-auth", "task.failed", JSON.stringify({ failure_kind: "auth_missing" }), AT);

    // A merge_conflict failure — another typed failure/park item.
    run.run("run-merge", "feature", "merge run", "active", AT, projectDir, null);
    task.run("task-merge", "run-merge", "build", "engineer", "failed", "{}", AT, OLDER);
    failedEvent.run("run-merge", "task-merge", "task.failed", JSON.stringify({ failure_kind: "merge_conflict" }), AT);

    // A transient, forge-auto-recoverable failure — must NOT surface (no inbox kind).
    run.run("run-crash", "feature", "crash run", "active", AT, projectDir, null);
    task.run("task-crash", "run-crash", "build", "engineer", "failed", "{}", AT, OLDER);
    failedEvent.run("run-crash", "task-crash", "task.failed", JSON.stringify({ failure_kind: "container_crash" }), AT);

    // (3) MISSING ACCEPTANCE CRITERIA — an active ticket whose current readiness is
    // needs_refinement (body_hash matches → not stale).
    ticket.run("pk-inbox", "FG-600", "story", "active", "needs refinement", "body", "h600", AT);
    readiness.run("pk-inbox", "FG-600", "h600", "needs_refinement", JSON.stringify(["acceptance criteria are vague"]), AT);

    // An OPEN review carrying an unresolved fix_now finding — another reviewer block, on a
    // DIFFERENT run so it does not collapse with the blocked_by_red task above.
    run.run("run-review", "feature", "review run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-603" }));
    review.run("rev-1", "run-review", "task-sub", "FG-603", "awaiting_disposition", "evidence_led", AT, AT);
    finding.run("rev-1/RF-1", "rev-1", 1, "RF-1", "a real bug", "fix_now", null, AT, AT);

    // ── Resolved / superseded / closed sources — must produce NO items ──
    // A completed run with a blocked_by_red task: the run is not active.
    run.run("run-done", "feature", "done run", "complete", AT, projectDir, null);
    task.run("task-done", "run-done", "build", "engineer", "blocked_by_red", "{}", AT, OLDER);
    // A settled review — closed, so its findings do not surface.
    run.run("run-settled", "feature", "settled run", "active", AT, projectDir, null);
    review.run("rev-2", "run-settled", "task-s2", "FG-700", "settled", "evidence_led", AT, AT);
    finding.run("rev-2/RF-1", "rev-2", 1, "RF-1", "already fixed", "fix_now", "resolved", AT, AT);
    // A DONE ticket with a needs_refinement readiness — not live, so no readiness item.
    ticket.run("pk-inbox", "FG-701", "story", "done", "closed ticket", "body", "h701", AT);
    readiness.run("pk-inbox", "FG-701", "h701", "needs_refinement", "[]", AT);

    // ── Dedup collapse — ONE run carrying TWO attention reasons ──
    // A blocked_by_red task AND an open review on the SAME run collapse to one row.
    run.run("run-dup", "feature", "dup run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-800" }));
    task.run("task-dup", "run-dup", "build", "engineer", "blocked_by_red", "{}", AT, OLDER);
    review.run("rev-dup", "run-dup", "task-dup", "FG-800", "awaiting_disposition", "evidence_led", AT, AT);
    finding.run("rev-dup/RF-1", "rev-dup", 1, "RF-1", "conflict finding", "fix_now", null, AT, AT);

    // ── FG-746: stale-verification source ──
    const campaign = db.prepare(
      `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir) VALUES (?,?,?,?,?,?,?,?)`,
    );
    const campItem = db.prepare(
      `INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, lifecycle_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    );
    const gateEvent = db.prepare(
      `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)`,
    );
    // A STALE unmatched host gate (started 15m before VERIF_NOW, past the 10m cutoff)
    // under an ACTIVE campaign + non-terminal item → an actionable stale_verification.
    campaign.run("camp-active", "running", "tickets", "[]", "sequential", VERIF_START, VERIF_START, projectDir);
    campItem.run("citem-active", "camp-active", 0, "FG-746", "running", VERIF_START, VERIF_START);
    gateEvent.run(
      null,
      null,
      "campaign_item.host_gate_started",
      JSON.stringify({ attemptId: "att-stale-verif", campaignId: "camp-active", itemId: "citem-active", ticketId: "FG-746", command: "npm run test:all", testedSha: "deadbeef012" }),
      VERIF_START,
    );
    // FG-667 negative: a terminal (complete) campaign + complete/shipped item — the
    // unmatched start must be dropped by terminal authority, producing NO attention item.
    campaign.run("camp-667", "complete", "tickets", "[]", "sequential", VERIF_START, VERIF_START, projectDir);
    campItem.run("citem-667", "camp-667", 0, "FG-667", "complete", VERIF_START, VERIF_START);
    gateEvent.run(
      null,
      null,
      "campaign_item.host_gate_started",
      JSON.stringify({ attemptId: "att-667", campaignId: "camp-667", itemId: "citem-667", ticketId: "FG-667", command: "npm run test:all", testedSha: "beefdead012" }),
      VERIF_START,
    );
  });
}

seed();

// The route serves the SAME persisted state the aggregator reads; start it up front (as
// the FG-679/FG-742 route tests do) so every test — including the HTTP one — is
// registered only after the server is listening.
const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/attention-inbox`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`server on ${BASE} did not start`);
}
await waitForServer();

const inbox = attentionInbox(undefined);
const byKind = (kind: string) => inbox.items.filter((i) => i.kind === kind);

test("gate wait produces exactly one waiting_gate item with run/task/ticket links", () => {
  const gates = byKind("waiting_gate").filter((i) => i.links.taskId === "task-gate");
  assert.equal(gates.length, 1);
  const item = gates[0]!;
  assert.equal(item.links.runId, "run-gate");
  assert.equal(item.links.ticketId, "FG-500");
  assert.equal(item.severity, "medium");
  assert.ok(item.reason.length > 0 && item.requestedAction.length > 0);
  assert.match(item.reason, /architect/);
});

test("reviewer/red block surfaces from a blocked_by_red task", () => {
  const reds = byKind("blocked_by_red_or_reviewer").filter((i) => i.links.taskId === "task-red");
  assert.equal(reds.length, 1);
  assert.equal(reds[0]!.links.runId, "run-red");
  assert.equal(reds[0]!.severity, "high");
});

test("an open review with an unresolved fix_now finding surfaces as a reviewer block", () => {
  const reviews = byKind("blocked_by_red_or_reviewer").filter((i) => i.id === "review:rev-1");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.links.ticketId, "FG-603");
  assert.match(reviews[0]!.reason, /fix-now/);
});

test("missing acceptance criteria surfaces for a live ticket, with the ticket link", () => {
  const gaps = byKind("missing_acceptance_or_readiness");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.links.ticketId, "FG-600");
  assert.match(gaps[0]!.reason, /acceptance criteria/i);
});

test("auth/setup surfaces from an auth_missing failure and carries no secret", () => {
  const auth = byKind("auth_setup");
  assert.equal(auth.length, 1);
  assert.equal(auth[0]!.links.taskId, "task-auth");
  assert.equal(auth[0]!.severity, "high");
  assert.doesNotMatch(`${auth[0]!.reason} ${auth[0]!.requestedAction}`, /TOKEN=|SECRET=|password/i);
});

test("a merge_conflict failure surfaces; a transient container_crash does NOT", () => {
  assert.equal(byKind("merge_conflict").length, 1);
  assert.equal(inbox.items.some((i) => i.links.taskId === "task-crash"), false, "auto-recoverable failure is not human-action");
});

test("resolved/superseded/closed sources produce no items", () => {
  assert.equal(inbox.items.some((i) => i.links.runId === "run-done"), false, "a completed run's blocked task is gone");
  assert.equal(inbox.items.some((i) => i.id === "review:rev-2"), false, "a settled review produces none");
  assert.equal(inbox.items.some((i) => i.links.ticketId === "FG-701"), false, "a closed ticket's readiness gap is gone");
});

test("one run carrying two reasons collapses to a single item", () => {
  const dup = inbox.items.filter((i) => i.links.runId === "run-dup");
  assert.equal(dup.length, 1, "the blocked_by_red task and the open review collapse to one row");
  assert.equal(dup[0]!.kind, "blocked_by_red_or_reviewer");
});

test("the envelope is well-formed, non-empty, and undegraded", () => {
  assert.equal(inbox.empty, false);
  assert.equal(inbox.items.length > 0, true);
  assert.deepEqual(inbox.degraded, []);
  assert.deepEqual(inbox.scope, { runId: null, projectDirs: null });
});

test("FG-746: a stale unmatched verification under an active campaign+item surfaces as a stale_verification item with command/candidate/age and a recovery action", () => {
  const verifInbox = attentionInbox(undefined, VERIF_NOW);
  const items = verifInbox.items.filter((i) => i.kind === "stale_verification");
  assert.equal(items.length, 1, "exactly the active-campaign stale gate surfaces; the FG-667 terminal one does not");
  const item = items[0]!;
  assert.equal(item.links.campaignId, "camp-active");
  assert.equal(item.links.itemId, "citem-active");
  assert.equal(item.links.ticketId, "FG-746");
  assert.equal(item.startedAt, VERIF_START, "carries the start time so a client can render the age");
  assert.match(item.reason, /npm run test:all/, "names the attempted command");
  assert.match(item.reason, /deadbeef01/, "names the candidate sha");
  assert.ok(item.requestedAction.length > 0, "carries a supported recovery action");
  assert.ok(verifInbox.degraded.every((d) => d !== "verification"), "the verification source read cleanly");
});

test("FG-746: the FG-667 terminal reconcile gate produces NO attention item", () => {
  const verifInbox = attentionInbox(undefined, VERIF_NOW);
  const found = verifInbox.items.filter((i) => i.links.ticketId === "FG-667");
  assert.deepEqual(found, [], "a terminal campaign+item attempt is neither live nor an attention item");
});

test("attentionInbox performs no mutation", () => {
  const rowsBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  attentionInbox(undefined);
  const rowsAfter = (getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  assert.equal(rowsAfter, rowsBefore);
});

// ── The route: 200 application/json carrying the composed envelope ──

test("GET /api/attention-inbox returns 200 application/json with the composed envelope", async () => {
  const res = await fetch(`${BASE}/api/attention-inbox`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { items: unknown[]; empty: boolean; error?: string };
  assert.equal(body.error, undefined);
  assert.equal(body.empty, false);
  assert.ok(Array.isArray(body.items) && body.items.length > 0);
});
