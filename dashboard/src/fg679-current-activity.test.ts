// FG-679: the dashboard's Current-activity read model and its RENDER layer.
//
// Two halves, both of which have to hold for the surface to be honest:
//
//   queries.currentActivity / queries.launchDetail — the read model, exercised
//     against a hand-shaped forge.db (same temp-FORGE_HOME harness as
//     queries-verification.test.ts).
//
//   client/current-activity-render.js — the pure render decisions, imported
//     directly with the node test runner, the same pattern as
//     verification-render.test.ts. The FG-487 review found badge/label logic living
//     only inline in main.js with zero coverage — exactly where a producer/renderer
//     field mismatch hides behind a green suite. The load-bearing assertion here is
//     BD-4: FOUR launch statuses produce FOUR distinct badges and NONE of them is a
//     generic `failed`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activityCounts,
  activityIsEmpty,
  ciBadgeClass,
  ciBadgeText,
  ciContextClass,
  ciContextRows,
  ciSectionLabel,
  launchAssociationLabel,
  launchBadge,
  launchBadgeClass,
  launchBadgeText,
  launchIdentityLine,
} from "../client/current-activity-render.js";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-fg679-ca-"));
process.env.FORGE_HOME = tmpHome;

const { currentActivity, launchDetail } = await import("./queries.js");
const { statusLine } = await import("@forge/current-activity");

const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT, task_package TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE launch_observations (
    launch_id TEXT PRIMARY KEY, name TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, project_dir TEXT,
    association_kind TEXT NOT NULL, run_id TEXT, task_id TEXT, ticket_id TEXT, campaign_id TEXT, item_id TEXT,
    started_at TEXT NOT NULL, observed_at TEXT NOT NULL, state TEXT NOT NULL, exit_code INTEGER, signal TEXT,
    terminal INTEGER NOT NULL
  );
`);

const NOW = new Date("2026-08-05T12:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const PROJECT = "/repos/forge";
const SHA = "a".repeat(40);

db.prepare(`INSERT INTO runs VALUES ('run-1','surface activity','feature', ?, 'active', ?)`).run(PROJECT, ago(3_600_000));
db.prepare(`INSERT INTO runs VALUES ('run-2','another','feature','/repos/other','active', ?)`).run(ago(3_600_000));

function insertLaunch(row: {
  id: string; kind: string; runId?: string | null; projectDir?: string | null;
  observedAt?: string; state?: string; terminal?: number; exitCode?: number | null; signal?: string | null;
}): void {
  db.prepare(`
    INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, started_at, observed_at, state, exit_code, signal, terminal)
    VALUES (?, ?, ?, '/repos/forge', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.id, JSON.stringify(["npm", "run", "test:worktree"]),
    row.projectDir === undefined ? PROJECT : row.projectDir,
    row.kind, row.runId ?? null, ago(600_000), row.observedAt ?? ago(60_000),
    row.state ?? "running", row.exitCode ?? null, row.signal ?? null, row.terminal ?? 0,
  );
}

insertLaunch({ id: "launch-explicit-aaaaaa", kind: "explicit", runId: "run-1" });
insertLaunch({ id: "launch-cwd-bbbbbb", kind: "cwd" });
insertLaunch({ id: "launch-orphan-cccccc", kind: "none", projectDir: null });
insertLaunch({ id: "launch-stale-dddddd", kind: "explicit", runId: "run-2", projectDir: "/repos/other", observedAt: ago(3 * 3_600_000) });
insertLaunch({ id: "launch-done-eeeeee", kind: "explicit", runId: "run-1", state: "exited_ok", exitCode: 0, terminal: 1 });

db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES ('run-1', NULL, 'review_loop.ci_observed', ?, ?)`)
  .run(JSON.stringify({
    attemptId: "attempt-1", ticketId: "FG-679", projectDir: PROJECT, candidateSha: SHA,
    observedAt: ago(30_000), outcome: "pending", unavailableReason: null,
    contexts: [
      { context: "test", state: "pending", url: "https://example.invalid/1", observedAt: ago(30_000) },
      { context: "test-extended", state: "queued", url: null, observedAt: ago(30_000) },
    ],
  }), ago(30_000));

describe("FG-679 queries.currentActivity — the read model", () => {
  test("run scope shows ONLY the explicitly associated, non-terminal launch", () => {
    const activity = currentActivity(undefined, "run-1", NOW);
    assert.deepEqual(activity.hostVerification.map((l) => l.launchId), ["launch-explicit-aaaaaa"]);
    assert.equal(activity.hostVerification[0]!.statusLabel, "running");
    assert.equal(activity.agents.length, 0, "no agent task is running — the launch is not one");
  });

  test("project scope shows the explicit AND the cwd-derived launch; the cwd one is labeled unassociated", () => {
    const activity = currentActivity(PROJECT, undefined, NOW);
    assert.deepEqual(activity.hostVerification.map((l) => l.launchId).sort(), ["launch-cwd-bbbbbb", "launch-explicit-aaaaaa"]);
    const cwdEntry = activity.hostVerification.find((l) => l.launchId === "launch-cwd-bbbbbb")!;
    assert.equal(cwdEntry.unassociated, true);
    assert.equal(launchAssociationLabel(cwdEntry), "unassociated");
  });

  test("the host-wide scope carries the Unassociated activity bucket", () => {
    const activity = currentActivity(undefined, undefined, NOW);
    assert.deepEqual(activity.unassociated.map((l) => l.launchId), ["launch-orphan-cccccc"]);
  });

  test("a terminal launch is absent from every scope", () => {
    for (const activity of [currentActivity(undefined, "run-1", NOW), currentActivity(PROJECT, undefined, NOW), currentActivity(undefined, undefined, NOW)]) {
      assert.equal(activity.hostVerification.some((l) => l.launchId === "launch-done-eeeeee"), false);
    }
  });

  test("a stale row renders `unobserved since <t>` and never `running`", () => {
    const entry = currentActivity(undefined, "run-2", NOW).hostVerification[0]!;
    assert.match(entry.statusLabel, /^unobserved since /);
    assert.notEqual(entry.statusLabel, "running");
    assert.equal(entry.observation, "unobserved");
  });

  test("required CI names the exact 40-char sha and enumerates every context", () => {
    const ci = currentActivity(undefined, "run-1", NOW).requiredCi;
    assert.equal(ci.state, "observed");
    assert.equal(ci.observations[0]!.candidateSha, SHA);
    assert.deepEqual(ci.observations[0]!.contexts.map((c) => c.context), ["test", "test-extended"]);
    assert.equal(ci.observations[0]!.state, "running");
  });

  test("a scope with no CI observation reports `CI not observed`, not `CI not running`", () => {
    const ci = currentActivity(undefined, "run-2", NOW).requiredCi;
    assert.equal(ci.state, "not_observed");
    assert.equal(ci.label, "CI not observed");
  });

  test("launchDetail carries no host filesystem path", () => {
    const detail = launchDetail("launch-explicit-aaaaaa", NOW)!;
    assert.ok(detail);
    assert.equal(JSON.stringify(detail).includes(PROJECT), false);
    assert.equal(detail.projectLabel, "forge");
    assert.equal(detail.statusLabel, "running");
  });

  test("launchDetail refuses an id outside the launch charset without touching the filesystem", () => {
    assert.equal(launchDetail("../../etc/passwd", NOW), null);
    assert.equal(launchDetail("/etc/passwd", NOW), null);
    assert.equal(launchDetail("with/slash", NOW), null);
  });

  test("a FUTURE-dated observation reads `unobserved since <t>` on launch detail too — the same range predicate, not a second one-sided copy", () => {
    insertLaunch({ id: "launch-future-ffffff", kind: "explicit", runId: "run-1", observedAt: new Date(NOW + 6 * 3_600_000).toISOString() });
    const detail = launchDetail("launch-future-ffffff", NOW)!;
    assert.equal(detail.observation, "unobserved");
    assert.equal(detail.state, "unknown");
    assert.notEqual(detail.statusLabel, "running");
    assert.match(detail.statusLabel, /^unobserved since /);
    // And the shared derivation agrees — one predicate, two surfaces.
    const entry = currentActivity(undefined, "run-1", NOW).hostVerification.find((l) => l.launchId === "launch-future-ffffff")!;
    assert.equal(entry.observation, "unobserved");
    // This row is this test's own fixture; the module-level set is what the later
    // count assertions read.
    db.prepare(`DELETE FROM launch_observations WHERE launch_id = 'launch-future-ffffff'`).run();
  });
});

describe("FG-679 BD-4 — the render layer keeps four facts four facts", () => {
  const four = [
    { state: "signaled", signal: "SIGTERM", sender: "unrecorded" as const },
    { state: "terminated_unattributed", code: 143 },
    { state: "owner_gone", cause: "unrecorded" as const, sender: "unrecorded" as const },
    { state: "unknown" },
  ];

  test("four launch statuses produce four DISTINCT badge classes, and none of them is a `failed` class", () => {
    const entries = four.map((status) => ({
      status: status as { state: "signaled" | "terminated_unattributed" | "owner_gone" | "unknown" },
      statusLabel: statusLine(status as never),
      observation: "fresh" as const,
    }));
    const classes = entries.map((e) => launchBadgeClass(e));
    assert.equal(new Set(classes).size, 4, `four distinct badge classes, got ${JSON.stringify(classes)}`);
    for (const c of classes) {
      assert.doesNotMatch(c, /failed/, `a launch badge class must never be a generic failure: ${c}`);
    }
  });

  test("the badge TEXT is statusLine's output byte-for-byte — the client composes nothing", () => {
    for (const status of four) {
      const label = statusLine(status as never);
      assert.equal(launchBadgeText({ statusLabel: label, observation: "fresh" }), label);
    }
    assert.equal(
      launchBadgeText({ statusLabel: "terminated by SIGTERM (signal sender not recorded — origin unknown)", observation: "fresh" }),
      "terminated by SIGTERM (signal sender not recorded — origin unknown)",
    );
  });

  test("a stale entry gets its OWN badge class and its `unobserved since` text — not running, not terminal", () => {
    const badge = launchBadge({ status: { state: "running" }, statusLabel: "unobserved since 2026-08-05T06:00:00.000Z", observation: "unobserved" });
    assert.equal(badge.class, "launch-state-unobserved");
    assert.equal(badge.text, "unobserved since 2026-08-05T06:00:00.000Z");
    assert.notEqual(badge.class, launchBadgeClass({ status: { state: "running" }, observation: "fresh" }));
  });

  test("an entry with no label at all reads as `not observed` — never a fabricated disposition", () => {
    assert.equal(launchBadgeText(null), "not observed");
    assert.equal(launchBadgeText({}), "not observed");
    assert.equal(launchBadgeClass(null), "launch-state-unknown");
  });

  test("the identity line carries identity only — no host path", () => {
    const line = launchIdentityLine({
      launchId: "launch-x-aaaaaa", runId: "run-1", taskId: "task-1", ticketId: "FG-679", projectLabel: "forge",
    });
    assert.equal(line, "launch-x-aaaaaa · run run-1 · task task-1 · FG-679 · forge");
    assert.equal(line.includes("/"), false);
  });
});

describe("FG-679 BD-8 — the render layer keeps not-observed, not-running and stale apart", () => {
  test("an unobserved section renders the `CI not observed` copy; an observed one renders none", () => {
    assert.equal(ciSectionLabel({ state: "not_observed", label: "CI not observed" }), "CI not observed");
    assert.equal(ciSectionLabel({ state: "observed", label: "1 observed" }), null);
    assert.equal(ciSectionLabel(null), "CI not observed");
  });

  test("the three observation states get three distinct badge classes", () => {
    const classes = [
      ciBadgeClass({ state: "running" }),
      ciBadgeClass({ state: "not_running" }),
      ciBadgeClass({ state: "stale" }),
    ];
    assert.equal(new Set(classes).size, 3);
    assert.equal(ciBadgeClass(null), "ci-state-not_observed");
    assert.equal(ciBadgeText({ label: "stale — CI last observed 2026-08-05T10:00:00.000Z" }), "stale — CI last observed 2026-08-05T10:00:00.000Z");
    assert.equal(ciBadgeText(null), "CI not observed");
  });

  test("every context row carries its state, URL and observation time — a summary verdict is not enough", () => {
    const rows = ciContextRows({
      contexts: [
        { context: "test", state: "pending", url: "https://example.invalid/1", observedAt: "2026-08-05T11:59:00.000Z" },
        { context: "test-extended", state: "success", url: null, observedAt: "2026-08-05T11:59:01.000Z" },
      ],
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { context: "test", state: "pending", url: "https://example.invalid/1", observedAt: "2026-08-05T11:59:00.000Z", class: "ci-ctx-pending" });
    assert.equal(rows[1]!.url, null);
    assert.equal(rows[1]!.class, "ci-ctx-success");
    assert.deepEqual(ciContextRows(null), []);
  });

  test("context state classes distinguish pending / success / failure / unknown", () => {
    assert.equal(ciContextClass("in_progress"), "ci-ctx-pending");
    assert.equal(ciContextClass("success"), "ci-ctx-success");
    assert.equal(ciContextClass("failure"), "ci-ctx-failure");
    assert.equal(ciContextClass("something_new"), "ci-ctx-unknown");
    assert.equal(ciContextClass(undefined), "ci-ctx-unknown");
  });
});

describe("FG-679 — the empty surface says nothing was observed, not that nothing is happening", () => {
  test("activityIsEmpty and activityCounts read a payload without inventing one", () => {
    assert.equal(activityIsEmpty(null), true);
    assert.equal(activityIsEmpty({ agents: [], hostVerification: [], unassociated: [], requiredCi: { state: "not_observed", label: "", observations: [] } }), true);
    const live = currentActivity(undefined, undefined, NOW);
    assert.equal(activityIsEmpty(live), false);
    const counts = activityCounts(live);
    assert.equal(counts.hostVerification, 3, "host-wide: both project-homed launches plus the stale one");
    assert.equal(counts.unassociated, 1);
    assert.equal(counts.requiredCi, 1);
  });
});
