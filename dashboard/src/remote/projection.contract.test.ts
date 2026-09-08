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
  redactRemoteFreeText,
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

describe("FG-781 AC4 / RF-1: attention free text cannot carry a filesystem path or a credential", () => {
  // The one unbounded surface that crosses the boundary: AttentionItem.reason /
  // requestedAction. The allowlist keeps UNNAMED fields out; RF-1 seals the NAMED ones so a
  // path or secret cannot ride inside them. Seed both a real host path and a credential-like
  // token into an attention message and assert NEITHER reaches the mapped DTO.
  const SEEDED_PATH = "/home/steve/.forge/secrets/private.key";
  const SEEDED_TOKEN = "ghp_ABCDEF0123456789abcdef0123456789ABCD";
  const SEEDED_KV = "password=hunter2SuperS3cret";

  test("the redactor strips paths, prefixed tokens, high-entropy tokens, and key=value secrets", () => {
    assert.ok(!redactRemoteFreeText(`see ${SEEDED_PATH} now`).includes(SEEDED_PATH), "a POSIX path is redacted");
    assert.ok(!redactRemoteFreeText(`token ${SEEDED_TOKEN}`).includes(SEEDED_TOKEN), "a GitHub-style token is redacted");
    assert.ok(!redactRemoteFreeText(`use ${SEEDED_KV}`).includes("hunter2SuperS3cret"), "a key=value secret value is redacted");
    assert.ok(!redactRemoteFreeText("C:\\Users\\steve\\creds.txt").includes("creds.txt"), "a Windows path is redacted");
    // Non-vacuous: ordinary operator prose and short ticket refs survive untouched.
    assert.equal(redactRemoteFreeText("A run is awaiting a human gate — review FG-781"), "A run is awaiting a human gate — review FG-781");
  });

  test("the mapped inbox item carries neither the seeded path nor the seeded credential", () => {
    const out = toRemoteInboxItem(
      pollute({
        id: "att-leak",
        kind: "waiting_gate",
        severity: "high",
        startedAt: "2026-09-08T11:00:00.000Z",
        reason: `Investigate ${SEEDED_PATH} before advancing`,
        requestedAction: `Re-authenticate with ${SEEDED_TOKEN} (${SEEDED_KV})`,
        source: "gate",
        links: { runId: null, taskId: null, ticketId: "FG-781", campaignId: null, itemId: null },
      }),
    );
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes(SEEDED_PATH), "the host path must not reach the remote DTO");
    assert.ok(!serialized.includes(SEEDED_TOKEN), "the credential token must not reach the remote DTO");
    assert.ok(!serialized.includes("hunter2SuperS3cret"), "the key=value secret must not reach the remote DTO");
    // The bounded, safe context around the redactions still survives, so the row stays useful.
    assert.match(out.reason, /Investigate .* before advancing/);
    assert.equal(out.links.ticketId, "FG-781");
  });
});

describe("FG-781 AC4 / RF-5: a bare scheme://host URL (no path segment) is redacted", () => {
  // The path rule only catches URLs with two or more path segments; a bare scheme://host with
  // NO path (e.g. https://control.invalid) previously slipped, disclosing a remote-control URL.
  test("scheme://host URLs are redacted regardless of scheme or path depth", () => {
    for (const url of [
      "https://control.invalid",
      "http://control.invalid",
      "ws://control.invalid",
      "wss://control.invalid",
    ]) {
      assert.ok(!redactRemoteFreeText(`connect to ${url} now`).includes("control.invalid"), `${url} must be redacted`);
    }
    // scheme://host:port/path still redacts the whole URL, not just its trailing path.
    assert.ok(!redactRemoteFreeText("dial wss://relay.example:9443/x").includes("relay.example"), "scheme://host:port/path is redacted");
    // A bare host:port authority with no scheme is redacted too.
    assert.ok(!redactRemoteFreeText("reach control.invalid:8443 for the tunnel").includes("control.invalid"), "a bare host:port authority is redacted");
  });

  test("ordinary prose, ticket refs, and a lone slash still survive (non-vacuous)", () => {
    assert.equal(redactRemoteFreeText("review FG-781 and advance"), "review FG-781 and advance");
    assert.equal(redactRemoteFreeText("blocked 9/8, retry ratio 3/4"), "blocked 9/8, retry ratio 3/4");
  });
});

describe("FG-789 / RF-5: an Authorization/Bearer scheme word AND its credential token are redacted", () => {
  // The credential-pair rule previously consumed only the FIRST non-space token after the key,
  // so it redacted the scheme word (Bearer/Basic/…) and left the secret behind. Seed the standard
  // echoes and a bare header value and assert NO fragment of the secret survives.
  test("keyed Authorization: Bearer <short token> — the short secret does not survive", () => {
    const out = redactRemoteFreeText("Authorization: Bearer shortSecret1");
    assert.ok(!out.includes("shortSecret1"), `the short bearer token must be redacted, got: ${out}`);
    assert.ok(!/Secret/.test(out), "no fragment of the secret survives");
  });

  test("authorization=Basic <base64> — the base64 credential does not survive", () => {
    const out = redactRemoteFreeText("authorization=Basic dXNlcjpwdw==");
    assert.ok(!out.includes("dXNlcjpwdw"), `the Basic base64 credential must be redacted, got: ${out}`);
    assert.ok(!out.includes("dXNl"), "no fragment of the base64 credential survives");
  });

  test("Proxy-Authorization: Bearer <dotted token> — the token does not survive", () => {
    const out = redactRemoteFreeText("Proxy-Authorization: Bearer x.y.z");
    assert.ok(!out.includes("x.y.z"), `the proxy bearer token must be redacted, got: ${out}`);
    assert.ok(!/\bx\.y\b/.test(out), "no fragment of the token survives");
  });

  test("a bare Bearer <token> with no key — the token does not survive", () => {
    const out = redactRemoteFreeText("Bearer abc123def456");
    assert.ok(!out.includes("abc123def456"), `the bare bearer token must be redacted, got: ${out}`);
    assert.ok(!/abc123/.test(out), "no fragment of the bare token survives");
  });

  test("non-vacuous control: ordinary prose with none of these constructs survives untouched", () => {
    assert.equal(
      redactRemoteFreeText("A run is awaiting a human gate — review FG-781"),
      "A run is awaiting a human gate — review FG-781",
    );
  });
});

describe("FG-781 AC4 / RF-4: EVERY free-text field the DTO emits is routed through the redactor", () => {
  // Seed a host path, a credential token, and a remote-control URL into each free-text display
  // string the projection copies, and assert NONE reaches the mapped DTO.
  const SEED_PATH = "/home/steve/.forge/secrets/id_rsa";
  const SEED_TOKEN = "ghp_ABCDEF0123456789abcdef0123456789ABCD";
  const SEED_URL = "https://control.invalid";
  const SEEDS = [SEED_PATH, SEED_TOKEN, "control.invalid"];
  const seeded = (base: string): string => `${base} ${SEED_PATH} ${SEED_TOKEN} ${SEED_URL}`;
  function assertNoLeak(label: string, output: unknown): void {
    const s = JSON.stringify(output);
    for (const leak of SEEDS) assert.ok(!s.includes(leak), `${label}: "${leak}" crossed the remote boundary`);
  }

  test("project description", () => {
    const out = toRemoteProjectSummary(
      pollute({ key: "pk", label: "L", color: "#fff", description: seeded("desc"), lastRunAt: null, runCount: 0, inFlightCount: 0, liveSessions: 0 }),
    );
    assertNoLeak("projectSummary.description", out);
  });

  test("backlog ticket title", () => {
    const out = toRemoteBacklogTicket(pollute({ id: "FG-1", type: "story", status: "active", title: seeded("Ticket"), related: [] }));
    assertNoLeak("backlogTicket.title", out);
    assert.match(out.title, /Ticket/, "the bounded prefix survives so the row stays useful");
  });

  test("queue row title", () => {
    const out = toRemoteQueueRow(
      pollute({ ticketId: "FG-1", title: seeded("Row"), type: "story", status: "active", rank: null, queued: false, blocked: false, inProgress: false, executionState: "idle", view: "backlog", wait: null }),
    );
    assertNoLeak("queueRow.title", out);
  });

  test("campaign goal and current-item title", () => {
    const out = toRemoteCampaignSummary(
      pollute({
        campaignId: "c1",
        goal: seeded("Goal"),
        mode: "serial",
        status: "running",
        verdict: "not_complete",
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
        counts: { shipped: 0, blocked: 0, held: 0, skipped: 0, failed: 0, total: 0 },
        currentItem: { ticketId: "FG-1", title: seeded("Item") },
      }),
    );
    assertNoLeak("campaignSummary.goal+currentItem.title", out);
  });

  test("activity run title", () => {
    const out = toRemoteActivitySummary(
      pollute({
        generatedAt: "2026-09-01T00:00:00Z",
        agents: [
          pollute({ runId: "r", taskId: "t", runTitle: seeded("Run"), workflow: "feature", agentRole: "engineer", phase: "build", status: "running", startedAt: null }),
        ],
        hostVerification: [],
        launches: [],
        ciWaits: [],
        operatorWaits: [],
        requiredCi: { state: "idle", label: "", observations: [] },
        unassociated: [],
      }),
    );
    assertNoLeak("activity.agent.runTitle", out);
    assert.match(out.agents[0]!.runTitle, /Run/, "the bounded prefix survives");
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
