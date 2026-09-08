// FG-781 AC4 — the remote projection is a POSITIVE ALLOWLIST that cannot carry forbidden
// fields even as the internal query shapes evolve. Unit tier: no spawned process, no DB.
//
// This proves the allowlist TWO independent ways, in the drift-tracking spirit of
// attention-inbox-schema-contract.test.ts:
//
//   1. RUNTIME INJECTION. Each mapper is fed a source object polluted with every forbidden
//      field — host paths, launch argv, CI/remote-control URLs, dispatcher/lease control
//      plane, cross-project holder rows, ticket bodies, git SHAs, credentials — each set to a
//      recognizable "LEAK_" sentinel. The serialized output must contain NONE of them, and
//      its keys must be EXACTLY the allowlist. Because each mapper copies fields one named
//      property at a time, a planted field cannot ride along; the day someone refactors a
//      mapper to spread its source, a sentinel appears and this test fails.
//
//   2. SOURCE DRIFT SCRAPE. The projection source is read and asserted to (a) never spread a
//      source object inside a mapper, and (b) declare no forbidden identifier as a field on
//      any exported remote DTO type. A hardcoded allowlist would keep passing as the reused
//      shapes grow; scraping the actual source is what makes the guard track reality.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REMOTE_BOARD_STATES,
  toRemoteProjectSummary,
  toRemoteBacklog,
  toRemoteBacklogTicket,
  toRemoteQueue,
  toRemoteQueueRow,
  toRemoteCampaignSummary,
  toRemoteInbox,
  toRemoteInboxItem,
  toRemoteActivitySummary,
  unauthorizedRemoteBoard,
  hostUnavailableRemoteBoard,
  unsupportedRemoteBoard,
} from "./projection.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "projection.ts"), "utf8");

/** A recognizable sentinel every forbidden planted field carries. If any survives into a
 *  mapper's output, the allowlist has a hole. */
const LEAK = "LEAK_SENTINEL";

/** Assert a mapped DTO carries NONE of the planted sentinels and EXACTLY the allowed keys. */
function assertSealed(label: string, output: unknown, allowedKeys: string[]): void {
  const serialized = JSON.stringify(output);
  assert.ok(
    !serialized.includes(LEAK),
    `${label}: a forbidden field leaked into the remote DTO — output was ${serialized}`,
  );
  assert.deepEqual(
    Object.keys(output as object).sort(),
    [...allowedKeys].sort(),
    `${label}: the DTO's key set is not the exact allowlist`,
  );
}

// A grab-bag of forbidden fields planted on every source object. None of these field names
// is copied by any mapper, so none may appear in output.
const POLLUTION = {
  projectDir: `${LEAK}_/host/path`,
  primaryCheckout: `${LEAK}_/host/checkout`,
  projectDirs: [`${LEAK}_/host/dirs`],
  checkouts: [{ projectDir: `${LEAK}_/host/co` }],
  githubUrl: `https://${LEAK}.example/repo`,
  readmeFirstLine: `${LEAK}_readme`,
  owner: { projectIdentity: `${LEAK}_cross_project` },
  body: `${LEAK}_ticket_body`,
  closedCommit: `${LEAK}_gitsha`,
  frontmatter: `${LEAK}_frontmatter`,
  command: [`${LEAK}_argv`],
  commandLine: `${LEAK}_argv --secret`,
  worktreePath: `${LEAK}_/host/worktree`,
  reservation: { owner: `${LEAK}_claim_owner`, launchId: `${LEAK}_launch` },
  blockers: [{ detail: `${LEAK}_blocker_detail` }],
  readiness: { gaps: [`${LEAK}_gap`], refinementProposal: `${LEAK}_refine` },
  scanReason: `${LEAK}_scan`,
  scanDetail: `${LEAK}_scan_detail`,
  note: `${LEAK}_note`,
  enqueuedBy: `${LEAK}_enqueuer`,
  dispatcher: { lease: { owner: `${LEAK}_lease`, host: `${LEAK}_host`, pid: 1234 } },
  capacity: { holders: [{ projectKey: `${LEAK}_other_project`, ticketId: `${LEAK}_other_ticket` }] },
  url: `https://${LEAK}.example/ci`,
  agentModel: `${LEAK}_model`,
  token: `${LEAK}_token`,
  secret: `${LEAK}_secret`,
  env: { SECRET: `${LEAK}_env` },
} as const;

function pollute<T>(clean: Record<string, unknown>): T {
  return { ...POLLUTION, ...clean } as unknown as T;
}

describe("FG-781 AC4: runtime — forbidden fields cannot enter a remote DTO", () => {
  test("project summary allowlist", () => {
    const out = toRemoteProjectSummary(
      pollute({
        key: "pk-a",
        label: "Alpha",
        color: "#123456",
        description: "desc",
        lastRunAt: "2026-09-01T00:00:00Z",
        runCount: 3,
        inFlightCount: 1,
        liveSessions: 0,
      }),
    );
    assertSealed("projectSummary", out, [
      "projectKey",
      "label",
      "color",
      "description",
      "lastRunAt",
      "runCount",
      "inFlightCount",
      "liveSessions",
    ]);
    assert.equal(out.projectKey, "pk-a");
  });

  test("backlog ticket allowlist — body and closedCommit are dropped", () => {
    const out = toRemoteBacklogTicket(
      pollute({
        id: "FG-1",
        type: "story",
        status: "active",
        title: "Ticket title",
        epic: "FG-0",
        created: "2026-09-01T00:00:00Z",
        closed: null,
        related: ["FG-2"],
      }),
    );
    assertSealed("backlogTicket", out, ["id", "type", "status", "title", "epic", "created", "closed", "related"]);
    assert.deepEqual(out.related, ["FG-2"]);
  });

  test("backlog projection wraps allowlisted tickets", () => {
    const out = toRemoteBacklog(
      pollute({
        projectKey: "pk-a",
        storageMode: "db",
        tickets: [pollute({ id: "FG-1", type: "story", status: "active", title: "T", related: [] })],
      }),
    );
    assertSealed("backlogProjection", out, ["projectKey", "storageMode", "tickets"]);
    assert.equal(out.tickets.length, 1);
  });

  test("queue row allowlist — reservation/blockers/scan/note and free-text wait.reason dropped", () => {
    const out = toRemoteQueueRow(
      pollute({
        ticketId: "FG-1",
        title: "T",
        type: "story",
        status: "active",
        rank: 2,
        queued: true,
        blocked: false,
        inProgress: true,
        executionState: "running",
        view: "in_progress",
        wait: { kind: "blocker", reason: `${LEAK}_wait_reason`, source: "queue_state", observedAt: null },
      }),
    );
    assertSealed("queueRow", out, [
      "ticketId",
      "title",
      "type",
      "status",
      "rank",
      "queued",
      "blocked",
      "inProgress",
      "executionState",
      "view",
      "waitKind",
    ]);
    assert.equal(out.waitKind, "blocker", "the closed wait-KIND survives");
  });

  test("queue projection allowlist — dispatcher and capacity panels dropped", () => {
    const out = toRemoteQueue(
      pollute({
        projectKey: "pk-a",
        storageMode: "db",
        queueAvailable: true,
        unavailableReason: null,
        version: 7,
        rows: [
          pollute({
            ticketId: "FG-1",
            title: "T",
            type: "story",
            status: "active",
            rank: null,
            queued: false,
            blocked: false,
            inProgress: false,
            executionState: "idle",
            view: "backlog",
            wait: null,
          }),
        ],
        views: { backlog: ["FG-1"], queued: [], in_progress: [], blocked: [], done: [], executing_not_queued: [] },
        nowMs: 1,
      }),
    );
    assertSealed("queueProjection", out, [
      "projectKey",
      "storageMode",
      "queueAvailable",
      "unavailableReason",
      "version",
      "rows",
      "views",
    ]);
    assert.deepEqual(out.views.backlog, ["FG-1"]);
  });

  test("campaign summary allowlist — projectDir dropped", () => {
    const out = toRemoteCampaignSummary(
      pollute({
        campaignId: "camp-1",
        goal: "ship it",
        mode: "serial",
        status: "running",
        verdict: "not_complete",
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
        counts: { shipped: 1, blocked: 0, held: 0, skipped: 0, failed: 0, total: 1 },
        currentItem: { ticketId: "FG-1", title: "T" },
      }),
    );
    assertSealed("campaignSummary", out, [
      "campaignId",
      "goal",
      "mode",
      "status",
      "verdict",
      "createdAt",
      "updatedAt",
      "counts",
      "currentItem",
    ]);
    assert.equal(out.currentItem?.ticketId, "FG-1");
  });

  test("inbox item allowlist — links.projectDir/projectLabel dropped", () => {
    const out = toRemoteInboxItem(
      pollute({
        id: "item-1",
        kind: "waiting_gate",
        severity: "high",
        startedAt: "2026-09-01T00:00:00Z",
        reason: "needs a decision",
        requestedAction: "approve",
        source: "gate",
        links: {
          runId: "run-1",
          taskId: "task-1",
          ticketId: "FG-1",
          campaignId: null,
          itemId: null,
          projectDir: `${LEAK}_/host/path`,
          projectLabel: `${LEAK}_label`,
        },
      }),
    );
    assertSealed("inboxItem", out, [
      "id",
      "kind",
      "severity",
      "startedAt",
      "reason",
      "requestedAction",
      "source",
      "links",
    ]);
    assertSealed("inboxItem.links", out.links, ["runId", "taskId", "ticketId", "campaignId", "itemId"]);
  });

  test("inbox envelope allowlist — path-bearing scope dropped", () => {
    const out = toRemoteInbox(
      pollute({
        generatedAt: "2026-09-01T00:00:00Z",
        scope: { runId: null, projectDirs: [`${LEAK}_/host/path`] },
        items: [
          pollute({
            id: "item-1",
            kind: "waiting_gate",
            severity: null,
            startedAt: null,
            reason: "r",
            requestedAction: "a",
            source: "gate",
            links: { runId: null, taskId: null, ticketId: null, campaignId: null, itemId: null },
          }),
        ],
        empty: false,
        degraded: [],
      }),
    );
    assertSealed("inboxEnvelope", out, ["generatedAt", "items", "empty", "degraded"]);
  });

  test("activity summary allowlist — launch argv/paths/URLs reduced to counts; agents carry no path/argv", () => {
    const out = toRemoteActivitySummary(
      pollute({
        generatedAt: "2026-09-01T00:00:00Z",
        agents: [
          pollute({
            runId: "run-1",
            taskId: "task-1",
            runTitle: "Run one",
            workflow: "feature",
            agentRole: "engineer",
            phase: "build",
            status: "running",
            startedAt: "2026-09-01T00:00:00Z",
          }),
        ],
        hostVerification: [pollute({ launchId: "l1" })],
        launches: [pollute({ launchId: "l2" })],
        ciWaits: [pollute({ waitId: "w1" })],
        operatorWaits: [pollute({ waitKey: "o1" })],
        requiredCi: { state: "observed", label: "x", observations: [pollute({ attemptId: "a1" })] },
        unassociated: [],
      }),
    );
    assertSealed("activitySummary", out, ["generatedAt", "agents", "counts", "requiredCiState", "hasLiveWork"]);
    assertSealed("activitySummary.agent", out.agents[0], [
      "runId",
      "taskId",
      "runTitle",
      "workflow",
      "agentRole",
      "phase",
      "status",
      "startedAt",
    ]);
    assert.equal(out.counts.hostVerifications, 1);
    assert.equal(out.counts.launches, 1);
    assert.equal(out.counts.ciWaits, 1);
    assert.equal(out.counts.operatorWaits, 1);
    assert.equal(out.requiredCiState, "observed");
    assert.equal(out.hasLiveWork, true);
  });
});

describe("FG-781 AC4: source drift — the allowlist tracks the source, not a copy", () => {
  test("no mapper spreads a source object", () => {
    // A spread of any source variable would silently re-open the allowlist to every field the
    // internal shape carries now or gains later. The ONLY spreads permitted in this module are
    // of the local POLLUTION-free literals in the mappers (there are none) — so any `...ident`
    // where ident is a source parameter is a defect.
    // Only a WHOLE-object spread of a source variable re-opens the allowlist. A spread of a
    // source SUB-array (`[...board.views[view]]`, `[...ticket.related]`) is a deliberate copy,
    // so the lookahead excludes an identifier continued by `.` / `[` / more word chars.
    const forbiddenSpread = /\.\.\.(project|ticket|row|board|summary|item|envelope|activity|agent|truth|queue|campaign|inbox)(?![\w.[])/;
    assert.ok(
      !forbiddenSpread.test(source),
      "a mapper spreads a source object — every remote field must be copied by name",
    );
  });

  test("no exported remote DTO type declares a forbidden field", () => {
    // Scrape every `export type Remote... = { ... }` block and assert none names a forbidden
    // field. This fails if a future edit adds, say, `projectDir` to a DTO — the exact leak
    // class the allowlist exists to prevent.
    const forbiddenFields = [
      "projectDir",
      "primaryCheckout",
      "projectDirs",
      "checkouts",
      "githubUrl",
      "readmeFirstLine",
      "commandLine",
      "worktreePath",
      "closedCommit",
      "frontmatter",
      "reservation",
      "dispatcher",
      "capacity",
      "holders",
      "transcript",
      "secret",
      "credential",
      "password",
    ];
    const blocks = [...source.matchAll(/export type Remote[A-Za-z]* =\s*{([\s\S]*?)};/g)].map((m) => m[1]!);
    assert.ok(blocks.length >= 8, "expected the remote DTO type blocks to be scraped");
    const allDtoText = blocks.join("\n");
    for (const field of forbiddenFields) {
      assert.ok(
        !new RegExp(`(^|[^A-Za-z])${field}\\s*:`, "m").test(allDtoText),
        `a remote DTO type declares the forbidden field \`${field}\``,
      );
    }
  });

  test("the body of a mapper never carries the word body/command/path as an output key", () => {
    // Guards the two highest-value drops (ticket body, launch argv) at the assignment level:
    // the mappers must not assign an output key named body/command/commandLine/projectDir.
    const forbiddenOutputKeys = /(^|\s)(body|command|commandLine|projectDir|worktreePath):/m;
    // Allow their appearance only in comments and on the right-hand side (reads), never as an
    // output key. We check the mapper return objects specifically.
    const returnObjects = [...source.matchAll(/return\s*{([\s\S]*?)};/g)].map((m) => m[1]!).join("\n");
    assert.ok(
      !forbiddenOutputKeys.test(returnObjects),
      "a mapper assigns a forbidden output key (body/command/commandLine/projectDir/worktreePath)",
    );
  });
});

describe("FG-781 AC5: the envelope carries a five-state discriminator and a freshness stamp", () => {
  test("the state vocabulary is exactly the five states", () => {
    assert.deepEqual(
      [...REMOTE_BOARD_STATES].sort(),
      ["host-unavailable", "live", "stale", "unauthorized", "unsupported"],
    );
  });

  test("every refusal/degradation envelope carries NO project data and a generation stamp", () => {
    for (const [label, env] of [
      ["unauthorized", unauthorizedRemoteBoard(1000)],
      ["host-unavailable", hostUnavailableRemoteBoard(1000)],
      ["unsupported", unsupportedRemoteBoard(1000)],
    ] as const) {
      assert.equal(env.board, null, `${label}: a refusal must carry no board data`);
      assert.equal(env.generation, 1000, `${label}: the freshness stamp is present`);
      assert.equal(env.generatedAt, new Date(1000).toISOString());
      assert.ok(REMOTE_BOARD_STATES.includes(env.state));
    }
  });
});
