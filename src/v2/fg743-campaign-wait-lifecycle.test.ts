// FG-743: Current Activity must show only PRESENTLY ACTIONABLE campaign operator waits.
// FG-734 made a parked `campaign_items.requested_human_action` visible as a
// `waiting_on_operator` entry, but it treated the park alone as liveness — never checking
// the PARENT campaign lifecycle or reconciling the stored instruction against terminal
// ticket state. So 1000+-hour-old rows under abandoned campaigns, and a done ticket under
// an old paused campaign, reappeared under `Current activity` as live in-flight work.
//
// What is pinned here (the shared campaign/item/ticket lifecycle predicate):
//
//   TERMINAL-PARENT EXCLUSION (AC1/AC2). A parked item with a requested_human_action under
//   a campaign that is complete / failed / abandoned is HISTORY, not a live wait — absent
//   from Current Activity even though the item still carries the action.
//
//   ACTIONABLE-PARENT PRESERVATION (AC3). A paused/running campaign with a genuinely
//   unresolved, actionable stop stays visible with its identity + reason.
//
//   DONE-TICKET RECONCILIATION (AC4/AC5). A nonterminal campaign item whose ticket has
//   since become `done` does not retain a now-false "close the ticket" instruction — the
//   wait clears, because no operator action remains.
//
//   HISTORY PRESERVED (AC6). Filtering never deletes or rewrites a campaign row: the
//   excluded items remain in the store for `forge campaign show/report` to expose.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb } from "../store/db.js";
import { deriveCurrentActivity, type StepGateResolver } from "./current-activity.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const PROJECT = "/repos/forge";
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const HOURS = 3_600_000;

let db: DatabaseInstance;

beforeEach(() => {
  db = makeInMemoryDb();
});

afterEach(() => {
  db.close();
});

function addCampaign(seed: { id: string; status: string; projectDir?: string | null; projectDirCanonical?: string | null }): void {
  db.prepare(`
    INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir, project_dir_canonical)
    VALUES (@id, @status, 'list', '{}', 'sequential', @ts, @ts, @projectDir, @canonical)
  `).run({
    id: seed.id,
    status: seed.status,
    ts: ago(1000 * HOURS),
    projectDir: seed.projectDir === undefined ? PROJECT : seed.projectDir,
    canonical: seed.projectDirCanonical ?? null,
  });
}

function addCampaignItem(seed: {
  id: string;
  campaignId: string;
  ticketId: string;
  runId?: string | null;
  lifecycleStatus?: string;
  blockerKind?: string | null;
  reason?: string | null;
  requestedHumanAction?: string | null;
  updatedAt?: string;
}): void {
  db.prepare(`
    INSERT INTO campaign_items (
      id, campaign_id, item_order, ticket_id, run_id, lifecycle_status,
      blocker_kind, reason, requested_human_action, created_at, updated_at
    ) VALUES (
      @id, @campaignId, 1, @ticketId, @runId, @lifecycleStatus,
      @blockerKind, @reason, @requestedHumanAction, @createdAt, @updatedAt
    )
  `).run({
    id: seed.id,
    campaignId: seed.campaignId,
    ticketId: seed.ticketId,
    runId: seed.runId ?? null,
    lifecycleStatus: seed.lifecycleStatus ?? "awaiting_gate",
    blockerKind: seed.blockerKind ?? null,
    reason: seed.reason ?? null,
    requestedHumanAction: seed.requestedHumanAction ?? null,
    createdAt: ago(1000 * HOURS),
    updatedAt: seed.updatedAt ?? ago(1000 * HOURS),
  });
}

function addTicket(ticketId: string, status: string, projectKey = "pk-forge", importedFrom: string | null = null): void {
  db.prepare(`
    INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at, imported_from)
    VALUES (?, ?, 'story', ?, ?, '', ?, ?)
  `).run(projectKey, ticketId, status, `ticket ${ticketId}`, ago(1000 * HOURS), importedFrom);
}

// Campaign hard stops never consult the step-gate resolver (that is the human-gate path),
// so every test here resolves nothing.
const noGates: StepGateResolver = () => "auto";
const derive = () => deriveCurrentActivity(db, { now: NOW, resolveStepGate: noGates });

// ───────────────────── AC1 — terminal-parent exclusion, all three names ─────────────────

describe("FG-743 AC1 — a parked item under a TERMINAL campaign is not a live operator wait", () => {
  for (const status of ["complete", "failed", "abandoned"] as const) {
    test(`campaign status '${status}' → the parked item is absent from Current Activity`, () => {
      addCampaign({ id: `camp-${status}`, status });
      addCampaignItem({
        id: `item-${status}`,
        campaignId: `camp-${status}`,
        ticketId: "FG-900",
        lifecycleStatus: "blocked_by_red",
        requestedHumanAction: "resolve the reviewer block then resume",
      });
      assert.equal(derive().operatorWaits.length, 0);
    });
  }
});

// ──────────── AC2 — the three reproduced abandoned rows, history preserved ───────────────

describe("FG-743 AC2 — the reproduced abandoned-campaign rows no longer appear as live waits", () => {
  test("FG-366 / FG-425 / FG-422 under abandoned campaigns are all absent — and their rows are NOT deleted", () => {
    const reproduced = [
      { item: "item-366", campaign: "campaign-7a56519b2f3d", ticket: "FG-366" },
      { item: "item-425", campaign: "campaign-e89beee993ec", ticket: "FG-425" },
      { item: "item-422", campaign: "campaign-922c83b7c577", ticket: "FG-422" },
    ];
    for (const r of reproduced) {
      addCampaign({ id: r.campaign, status: "abandoned" });
      addCampaignItem({
        id: r.item,
        campaignId: r.campaign,
        ticketId: r.ticket,
        lifecycleStatus: "awaiting_recovery",
        reason: "aged historical hard stop",
        requestedHumanAction: "resolve then resume",
        updatedAt: ago(1200 * HOURS),
      });
    }

    assert.equal(derive().operatorWaits.length, 0, "none of the abandoned-campaign rows are live");

    // AC6: the derivation FILTERS, it does not delete. Every historical row still exists.
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM campaign_items`).get() as { n: number };
    assert.equal(remaining.n, reproduced.length, "campaign history is preserved for forge campaign show/report");
  });
});

// ─────────────── AC3 — an actionable paused/running campaign stays visible ───────────────

describe("FG-743 AC3 — a genuinely unresolved stop under a nonterminal campaign remains visible", () => {
  for (const status of ["paused", "running"] as const) {
    test(`a ${status} campaign with an unresolved actionable stop keeps its identity + reason`, () => {
      addCampaign({ id: `camp-${status}`, status });
      addCampaignItem({
        id: `item-${status}`,
        campaignId: `camp-${status}`,
        ticketId: "FG-950",
        runId: "run-950",
        lifecycleStatus: "blocked_by_red",
        blockerKind: "human_decision",
        reason: "authoritative reviewer blocked the build",
        requestedHumanAction: "resolve the reviewer block then resume",
      });

      const waits = derive().operatorWaits;
      assert.equal(waits.length, 1);
      const w = waits[0]!;
      assert.equal(w.source, "campaign_hard_stop");
      assert.equal(w.ticketId, "FG-950");
      assert.equal(w.campaignId, `camp-${status}`);
      assert.equal(w.reason, "authoritative reviewer blocked the build");
      assert.equal(w.requestedAction, "resolve the reviewer block then resume");
    });
  }
});

// ─────────────── AC4 — a done ticket clears the now-false "close the ticket" ─────────────

describe("FG-743 AC4 — a nonterminal item whose ticket became done retains no stale instruction", () => {
  test("done ticket under a paused campaign → the wait clears (no operator action remains)", () => {
    addCampaign({ id: "camp-recon", status: "paused" });
    addTicket("FG-960", "done");
    addCampaignItem({
      id: "item-recon",
      campaignId: "camp-recon",
      ticketId: "FG-960",
      lifecycleStatus: "awaiting_gate",
      requestedHumanAction: "close the ticket",
    });
    assert.equal(derive().operatorWaits.length, 0);
  });

  test("an ACTIVE ticket under the same shape stays visible — only closure reconciles it", () => {
    addCampaign({ id: "camp-active", status: "paused" });
    addTicket("FG-961", "active");
    addCampaignItem({
      id: "item-active",
      campaignId: "camp-active",
      ticketId: "FG-961",
      lifecycleStatus: "awaiting_gate",
      requestedHumanAction: "close the ticket",
    });
    assert.equal(derive().operatorWaits.length, 1);
  });

  // FG-743/RF-1: `tickets` is keyed by (project_key, ticket_id), so two projects can each
  // carry FG-970. A `done` FG-970 in project B must NOT clear a live hard-stop on project
  // A's still-active FG-970 — reconciliation is ALL-rows-done, never any-row-done.
  test("a done ticket in ANOTHER project does not suppress this project's live hard-stop", () => {
    addCampaign({ id: "camp-A", status: "paused" });
    addTicket("FG-970", "active", "pk-project-A");
    addTicket("FG-970", "done", "pk-project-B");
    addCampaignItem({
      id: "item-A",
      campaignId: "camp-A",
      ticketId: "FG-970",
      lifecycleStatus: "blocked_by_red",
      reason: "authoritative reviewer blocked the build",
      requestedHumanAction: "resolve the reviewer block then resume",
    });

    const waits = derive().operatorWaits;
    assert.equal(waits.length, 1, "the sibling project's done FG-970 must not drop A's live wait");
    assert.equal(waits[0]!.ticketId, "FG-970");
    assert.equal(waits[0]!.campaignId, "camp-A");
  });
});

// ──────── AC4/RF-1 — done-ticket reconciliation is scoped to the campaign's OWN project ────────
//
// `tickets` is keyed by (project_key, ticket_id): the same id lives in every project that
// carries it, and this module may not shell `git` to resolve a project_key from a path
// (BD-7/BD-18). Closure is therefore scoped by FILESYSTEM IDENTITY — the ticket's recorded
// source checkout (`imported_from`, a proven realpath) vs the campaign's proven
// `project_dir_canonical`. A `done` FG-X in ANOTHER project must not clear a live hard-stop on
// THIS project's FG-X — INCLUDING when this project never imported FG-X at all, the
// false-negative the earlier ALL-rows-done predicate left standing (its sole `done` row for an
// absent-here ticket "fully determined" a closure this campaign's project never made).

describe("FG-743/RF-1 — a done ticket in ANOTHER project cannot suppress this project's live wait", () => {
  const PROJ_A = "/repos/project-a";
  const PROJ_B = "/repos/project-b";

  // DISCRIMINATING: fails against `WHERE t.ticket_id = ci.ticket_id` (COUNT=1, all done →
  // suppressed), passes once the done row's foreign project excludes it.
  test("done FG-980 owned by project A does NOT drop project B's live wait when B never imported it", () => {
    addCampaign({ id: "camp-B", status: "paused", projectDir: PROJ_B, projectDirCanonical: PROJ_B });
    addTicket("FG-980", "done", "pk-project-a", PROJ_A); // owner is A; B has NO FG-980 row at all
    addCampaignItem({
      id: "item-B",
      campaignId: "camp-B",
      ticketId: "FG-980",
      lifecycleStatus: "blocked_by_red",
      reason: "authoritative reviewer blocked the build",
      requestedHumanAction: "resolve the reviewer block then resume",
    });

    const waits = derive().operatorWaits;
    assert.equal(waits.length, 1, "project A's done FG-980 must not drop B's live wait for a ticket absent in B");
    assert.equal(waits[0]!.campaignId, "camp-B");
    assert.equal(waits[0]!.ticketId, "FG-980");
  });

  // TRUE-POSITIVE guard: the campaign's OWN done ticket still reconciles, and a foreign done
  // row alongside it changes nothing.
  test("project B's OWN done FG-981 DOES suppress the wait, ignoring a foreign done row", () => {
    addCampaign({ id: "camp-B2", status: "paused", projectDir: PROJ_B, projectDirCanonical: PROJ_B });
    addTicket("FG-981", "done", "pk-project-a", PROJ_A); // foreign — must be ignored
    addTicket("FG-981", "done", "pk-project-b", PROJ_B); // the campaign's OWN project — reconciles
    addCampaignItem({
      id: "item-B2",
      campaignId: "camp-B2",
      ticketId: "FG-981",
      lifecycleStatus: "awaiting_gate",
      requestedHumanAction: "close the ticket",
    });

    assert.equal(derive().operatorWaits.length, 0, "the campaign's own done FG-981 clears the now-satisfied instruction");
  });
});

// ─────────────────── AC5 — the aged FG-472 shape (done ticket + old paused) ──────────────

describe("FG-743 AC5 — the FG-472 shape cannot be presented as current with obsolete prose", () => {
  test("a done FG-472 under a still-paused campaign is absent, and its history survives", () => {
    addCampaign({ id: "campaign-2753b15667d7", status: "paused", projectDir: PROJECT });
    addTicket("FG-472", "done");
    addCampaignItem({
      id: "item-472",
      campaignId: "campaign-2753b15667d7",
      ticketId: "FG-472",
      lifecycleStatus: "awaiting_gate",
      reason: "item done but campaign never resumed",
      requestedHumanAction: "close the ticket",
      updatedAt: ago(1000 * HOURS),
    });

    assert.equal(derive().operatorWaits.length, 0, "the obsolete close-the-ticket wait is cleared");

    const row = db.prepare(`SELECT requested_human_action FROM campaign_items WHERE id = 'item-472'`).get() as
      | { requested_human_action: string }
      | undefined;
    assert.equal(row?.requested_human_action, "close the ticket", "the historical requested-action evidence is untouched");
  });
});
