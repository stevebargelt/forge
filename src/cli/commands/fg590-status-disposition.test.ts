// FG-590: `forge status` labels a terminal host launch with the SHARED retention
// disposition — retained-for-investigation vs expired/eligible vs leaked — via the same
// rule the automatic cleanup and the dashboard use. A running launch is never a cleanup
// candidate (null disposition). Exercised directly over the annotation, since the shared
// rule is what must be proven identical across surfaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetentionDisposition } from "./status.js";
import { renderCurrentActivityLines } from "../../v2/current-activity.js";
import type { CurrentActivity, HostLaunchActivity } from "../../v2/current-activity.js";
import type { LaunchStatus } from "../../v2/launch.js";
import type { RetentionPolicy } from "../../v2/retention-policy.js";

const POLICY: RetentionPolicy = { success: 60_000, failureAmbiguous: 24 * 60 * 60_000 };
const NOW = Date.parse("2026-08-21T12:00:00.000Z");

function mkLaunch(id: string, recordedStatus: LaunchStatus, startedAt: string): HostLaunchActivity {
  return {
    launchId: id,
    name: id,
    command: ["x"],
    commandLine: "x",
    projectDir: null,
    projectLabel: null,
    associationKind: "none",
    purpose: "generic",
    unassociated: true,
    placement: "host",
    runId: null,
    taskId: null,
    ticketId: null,
    campaignId: null,
    itemId: null,
    startedAt,
    observedAt: startedAt,
    status: recordedStatus,
    recordedStatus,
    statusLabel: "x",
    observation: "fresh",
  };
}

function emptyActivity(launches: HostLaunchActivity[]): CurrentActivity {
  return {
    generatedAt: "2026-08-21T12:00:00.000Z",
    scope: { runId: null, projectDirs: null },
    agents: [],
    hostVerification: [],
    launches,
    requiredCi: { state: "no_current_candidate", label: "", observations: [] },
    ciWaits: [],
    operatorWaits: [],
    unassociated: [],
  };
}

test("FG-590 status: a running launch has no retention disposition (it is live work, never a candidate)", () => {
  const activity = emptyActivity([mkLaunch("l-run", { state: "running" }, "2026-08-21T11:59:00.000Z")]);
  const annotated = withRetentionDisposition(activity, POLICY, NOW);
  assert.equal(annotated.launches[0]!.retentionDisposition, null);
  assert.deepEqual(annotated.retentionPolicy, POLICY);
});

test("FG-590 status: a terminal successful launch past its window reads 'leaked'; a fresh one reads 'expired_eligible'", () => {
  const activity = emptyActivity([
    mkLaunch("l-ok-old", { state: "exited_ok", code: 0 }, "2026-08-20T00:00:00.000Z"), // ~36h ago
    mkLaunch("l-ok-new", { state: "exited_ok", code: 0 }, "2026-08-21T11:59:30.000Z"), // 30s ago
  ]);
  const annotated = withRetentionDisposition(activity, POLICY, NOW);
  assert.equal(annotated.launches[0]!.retentionDisposition, "leaked");
  assert.equal(annotated.launches[1]!.retentionDisposition, "expired_eligible");
});

test("FG-590 status: a failed/owner-gone launch within its window is labeled retained-for-investigation, distinctly", () => {
  const activity = emptyActivity([
    mkLaunch("l-gone", { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" }, "2026-08-21T11:00:00.000Z"), // 1h ago
    mkLaunch("l-err", { state: "exited_error", code: 2 }, "2026-08-21T11:30:00.000Z"), // 30m ago
  ]);
  const annotated = withRetentionDisposition(activity, POLICY, NOW);
  assert.equal(annotated.launches[0]!.retentionDisposition, "within_retention_for_investigation");
  assert.equal(annotated.launches[1]!.retentionDisposition, "within_retention_for_investigation");
});

// RF-8: the HUMAN `forge status` surface (renderCurrentActivityLines), not just the JSON
// annotation, must carry the disposition — the JSON path annotated it while the human path
// rendered the raw activity, so the operator-facing text omitted it entirely.
test("FG-590 status RF-8: the human render surfaces each terminal launch's retention disposition; a running launch carries none", () => {
  const activity = emptyActivity([
    mkLaunch("l-run", { state: "running" }, "2026-08-21T11:59:00.000Z"),
    mkLaunch("l-ok-old", { state: "exited_ok", code: 0 }, "2026-08-20T00:00:00.000Z"), // leaked
    mkLaunch("l-err", { state: "exited_error", code: 2 }, "2026-08-21T11:30:00.000Z"), // retained for investigation
  ]);
  const lines = renderCurrentActivityLines(withRetentionDisposition(activity, POLICY, NOW));
  const text = lines.join("\n");
  // Each terminal launch's line names its disposition, on the SAME line as its id.
  const okLine = lines.find((l) => l.includes("l-ok-old"))!;
  const errLine = lines.find((l) => l.includes("l-err"))!;
  const runLine = lines.find((l) => l.includes("l-run"))!;
  assert.match(okLine, /retention: leaked — past retention/);
  assert.match(errLine, /retention: retained for investigation/);
  // The running launch is live work — never labeled a cleanup candidate.
  assert.doesNotMatch(runLine, /retention:/);
  // And the human surface as a whole now carries the disposition it previously omitted.
  assert.match(text, /retention: /);
});
