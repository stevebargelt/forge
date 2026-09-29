// FG-824: the freshness signal on in-flight launch rows and the task page's recovery card,
// as render decisions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";
import { ORPHAN_EVIDENCE_KINDS } from "../../src/v2/failure-kind.js";
import { RE_DRIVABLE_FAILURE_KINDS } from "@forge/retry-policy";
import { previewTaskActions } from "./action-mutation.js";
import {
  FRESHNESS_CRITICAL_MIN, FRESHNESS_SUSPICIOUS_MIN, activityFromBody, homeActivityView, homeInFlightActivity, launchFreshness,
} from "../client/current-activity-render.js";
import { InFlightActivityWaits } from "../client/current-activity-view.js";
import {
  ORPHAN_FAILURE_KINDS, defaultRecoveryVerb, lastRecoverOutcome, needsRecoveryCard, recoveryCard, recoveryNext,
} from "../client/recovery-card-render.js";
import { actionsFromResponse } from "../client/task-actions-render.js";

const GENERATED = "2026-09-29T12:00:00.000Z";
const minutesBefore = (m: number) => new Date(Date.parse(GENERATED) - m * 60_000).toISOString();

function launch(over: Record<string, unknown> = {}) {
  return {
    launchId: "L-1", name: "verify", command: ["npm", "test"], commandLine: "npm test", projectDir: null, projectLabel: null,
    associationKind: "explicit", purpose: "host_verification", unassociated: false, placement: "run",
    runId: "run-1", taskId: "task-1", ticketId: "FG-824", campaignId: null, itemId: null,
    startedAt: minutesBefore(90), observedAt: minutesBefore(0),
    status: { state: "running" }, recordedStatus: { state: "running" }, statusLabel: "running", observation: "fresh",
    ...over,
  };
}

function activity(hostVerification: unknown[], launches: unknown[] = []) {
  return {
    generatedAt: GENERATED, scope: { runId: null, projectDirs: null }, agents: [], hostVerification, launches,
    requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] }, ciWaits: [], operatorWaits: [], unassociated: [],
  };
}

type Vnode = { type: unknown; props: Record<string, unknown> } | string | number | null | undefined | boolean | Vnode[];
function textOf(node: Vnode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const { type, props } = node;
  if (typeof type === "function") return textOf((type as (p: unknown) => Vnode)(props));
  return textOf(props.children as Vnode);
}

describe("FG-824: the freshness signal", () => {
  test("says nothing under the suspicious threshold", () => {
    assert.equal(launchFreshness(launch({ observedAt: minutesBefore(FRESHNESS_SUSPICIOUS_MIN - 1) }), GENERATED), null);
  });

  test("is suspicious from 15 minutes and critical from 60", () => {
    const at15 = launchFreshness(launch({ observedAt: minutesBefore(15) }), GENERATED);
    assert.equal(at15?.text, "unobserved for 15 min");
    assert.equal(at15?.level, "suspicious");
    assert.equal(at15?.class, "freshness freshness-suspicious");
    assert.equal(launchFreshness(launch({ observedAt: minutesBefore(59) }), GENERATED)?.level, "suspicious");
    const at60 = launchFreshness(launch({ observedAt: minutesBefore(FRESHNESS_CRITICAL_MIN) }), GENERATED);
    assert.equal(at60?.level, "critical");
    assert.equal(at60?.text, "unobserved for 60 min");
  });

  test("reads the recorded status, so a stale row the server already marked unknown still carries it", () => {
    const stale = launch({ observedAt: minutesBefore(95), status: { state: "unknown" }, observation: "unobserved" });
    assert.equal(launchFreshness(stale, GENERATED)?.text, "unobserved for 95 min");
  });

  test("never decays a terminal outcome, and needs both server clocks", () => {
    const done = launch({ observedAt: minutesBefore(120), status: { state: "exited_ok", code: 0 }, recordedStatus: { state: "exited_ok", code: 0 } });
    assert.equal(launchFreshness(done, GENERATED), null);
    assert.equal(launchFreshness(launch({ observedAt: minutesBefore(30) }), null), null);
    assert.equal(launchFreshness(launch({ observedAt: "never" }), GENERATED), null);
    assert.equal(launchFreshness(null, GENERATED), null);
  });

  test("measures the payload's generatedAt, never the browser clock", () => {
    const load = activityFromBody(activity([launch({ observedAt: minutesBefore(20) })]));
    const waits = homeInFlightActivity(load);
    assert.equal(waits.generatedAt, GENERATED);
    const text = textOf(h(InFlightActivityWaits as never, { load, now: Date.parse(GENERATED) + 10 * 3_600_000, onRetry: () => {} }) as unknown as Vnode);
    assert.match(text, /unobserved for 20 min/);
    assert.equal(homeActivityView(load).generatedAt, GENERATED);
  });

  test("is informational only: the row stays a wait with its status untouched", () => {
    const row = launch({ observedAt: minutesBefore(25) });
    const waits = homeInFlightActivity(activityFromBody(activity([row])));
    assert.equal(waits.hostVerification.length, 1);
    assert.deepEqual(waits.hostVerification[0]!.status, { state: "running" });
  });
});

const failed = (failureKind: string | null, status = "failed", events: unknown[] = []) => ({
  task: { taskId: "task-9", runId: "run-9", status, agentRole: "engineer" },
  failureKind,
  events,
});
const preview = (status: string, failureKind: string | null, available = true) =>
  actionsFromResponse(200, {
    ...previewTaskActions({ taskId: "task-9", status, failureKind, dispatchSource: "workflow" }),
    mutations: available ? { available: true, reason: null } : { available: false, reason: "bound to 0.0.0.0, not loopback." },
  });

describe("FG-824: the recovery card", () => {
  test("its orphan kinds cover core's orphan evidence kinds and every orphan-named failure kind", () => {
    for (const kind of ORPHAN_EVIDENCE_KINDS) assert.ok(ORPHAN_FAILURE_KINDS.includes(kind), `${kind} is missing`);
    for (const kind of Object.keys(RE_DRIVABLE_FAILURE_KINDS).filter((k) => /orphan/.test(k))) {
      assert.ok(ORPHAN_FAILURE_KINDS.includes(kind), `${kind} is missing`);
    }
    for (const kind of ORPHAN_FAILURE_KINDS) assert.ok(kind in RE_DRIVABLE_FAILURE_KINDS, `${kind} is not a failure kind`);
  });

  test("appears for awaiting_recovery and orphan kinds only", () => {
    assert.equal(needsRecoveryCard(failed(null, "awaiting_recovery")), true);
    assert.equal(needsRecoveryCard(failed("container_crash")), true);
    assert.equal(needsRecoveryCard(failed("fanout_wave_orphaned")), true);
    assert.equal(needsRecoveryCard(failed("auth_expired")), false);
    assert.equal(needsRecoveryCard(failed(null, "running")), false);
    assert.equal(recoveryCard(failed("gate_rejected"), null), null);
  });

  test("an eligible re-drive is a button carrying the FG-822 preview entry", () => {
    const card = recoveryCard(failed("fanout_wave_orphaned"), preview("failed", "fanout_wave_orphaned"));
    assert.equal(card?.kind, "fanout_wave_orphaned");
    assert.equal(card?.next.mode, "button");
    assert.equal(card?.next.verb, "forge recover task-9 --re-drive");
    assert.equal((card?.next as { entry: { route: string } }).entry.route, "/api/task/task-9/recover-re-drive");
  });

  test("an eligible action on a bind that refuses mutations is advice, not a button", () => {
    const next = recoveryNext(failed("fanout_wave_orphaned"), preview("failed", "fanout_wave_orphaned", false));
    assert.equal(next.mode, "advice");
    assert.match(next.advice ?? "", /not loopback/);
  });

  test("an ineligible recovery names the verb and the retry policy's advice", () => {
    const card = recoveryCard(failed("orphaned_work_may_persist"), preview("failed", "orphaned_work_may_persist"));
    assert.equal(card?.next.mode, "advice");
    assert.equal(card?.next.verb, "forge recover task-9");
    assert.ok(card?.next.advice && card.next.advice.length > 0, "the advice is shown");
  });

  test("awaiting_recovery names forge next for the run, never a hand reset", () => {
    const card = recoveryCard(failed(null, "awaiting_recovery"), preview("awaiting_recovery", null));
    assert.equal(card?.kind, "awaiting_recovery");
    assert.equal(card?.status.class, "status-awaiting_recovery");
    assert.equal(card?.next.mode, "advice");
    assert.equal(card?.next.verb, "forge next run-9");
    assert.match(card?.kindDetail ?? "", /never hand-reset/);
  });

  test("a loading or unavailable preview still names the verb", () => {
    assert.deepEqual(recoveryNext(failed("container_crash"), null), { mode: "loading", verb: "forge recover task-9" });
    const down = recoveryNext(failed("container_crash"), { phase: "unavailable", detail: "HTTP 500" });
    assert.equal(down.mode, "advice");
    assert.match(down.advice ?? "", /HTTP 500/);
  });

  test("never names a --force verb for any failure kind, whatever the preview says", () => {
    const kinds: Array<[string | null, string]> = [
      ...Object.keys(RE_DRIVABLE_FAILURE_KINDS).map((k): [string, string] => [k, "failed"]),
      [null, "awaiting_recovery"],
    ];
    for (const [kind, status] of kinds) {
      assert.doesNotMatch(defaultRecoveryVerb(failed(kind, status)), /--force/, `${kind ?? status}`);
      for (const load of [null, { phase: "unavailable", detail: "HTTP 500" }, preview(status, kind), preview(status, kind, false)]) {
        assert.doesNotMatch(recoveryNext(failed(kind, status), load).verb, /--force/, `${kind ?? status}`);
      }
    }
  });

  test("orphaned_needs_finalize names the inspect-first verb and keeps the policy's advice beneath", () => {
    assert.equal(defaultRecoveryVerb(failed("orphaned_needs_finalize")), "forge show task-9, then forge recover task-9");
    const next = recoveryNext(failed("orphaned_needs_finalize"), preview("failed", "orphaned_needs_finalize"));
    assert.equal(next.mode, "advice");
    assert.equal(next.verb, "forge show task-9, then forge recover task-9");
    assert.match(next.advice ?? "", /forge show task-9/);
  });

  test("the last forge recover outcome is read from the task's own timeline", () => {
    assert.equal(lastRecoverOutcome([]), null);
    const events = [
      { eventType: "task.failed", createdAt: "2026-09-29T10:00:00Z", payload: { failure_kind: "fanout_wave_orphaned" } },
      { eventType: "task.reconciled", createdAt: "2026-09-29T10:05:00Z", payload: { from: "failed", to: "redriven", reason: "fanout_wave_redriven", via: "forge recover --re-drive" } },
      { eventType: "task.reconciled", createdAt: "2026-09-29T10:06:00Z", payload: { from: "running", to: "failed", via: "reconcile" } },
    ];
    assert.deepEqual(lastRecoverOutcome(events), {
      via: "forge recover --re-drive",
      at: "2026-09-29T10:05:00Z",
      text: "forge recover --re-drive: failed → redriven (fanout_wave_redriven)",
    });
    assert.equal(recoveryCard(failed("fanout_wave_orphaned", "failed", events), null)?.lastRecover?.via, "forge recover --re-drive");
  });
});
