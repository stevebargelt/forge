// FG-734 (dashboard): a `waiting_on_operator` entry renders as a compact **Waiting on
// operator** status and keeps the workspace non-idle — the same shared derivation FG-731
// used for CI waits, on the same two surfaces (Home's In-flight fold-in and the Activity
// view's Current-activity panel). What is pinned here:
//
//   AC2  a live operator wait renders as a compact status, NOT IDLE, with no log needed.
//   AC7  it stays visible ALONGSIDE running work and does not flatten Home to idle —
//        `homeInFlightActivity` folds it in exactly as a CI wait, so `anyWaits` is true.
//   AC4  an ABSENT operatorWaits (an older server) still validates; a present-but-
//        malformed one is a FAILED read, never silently erased to idle.
//   the server-rendered label is read, never composed — an entry with no statusLabel
//   reads the explicit fallback, never a fabricated one.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";
import {
  activityFromBody,
  activityPhase,
  homeActivityView,
  homeInFlightActivity,
  isCurrentActivityPayload,
  operatorWaitCompactSummary,
  OPERATOR_WAIT_LABEL,
} from "../client/current-activity-render.js";
import { InFlightActivityWaits } from "../client/current-activity-view.js";
import type { CurrentActivityPayload } from "../client/current-activity-render.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

type Vnode = { type: unknown; props: Record<string, unknown> } | string | number | null | undefined | boolean | Vnode[];

function textOf(node: Vnode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  const { type, props } = node;
  if (typeof type === "function") return textOf((type as (p: unknown) => Vnode)(props));
  return textOf(props.children as Vnode);
}

function payload(over: Partial<CurrentActivityPayload> = {}): CurrentActivityPayload {
  return {
    generatedAt: "2026-08-19T12:00:00.000Z",
    scope: { runId: null, projectDirs: null },
    agents: [],
    hostVerification: [],
    launches: [],
    requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] },
    unassociated: [],
    ...over,
  } as CurrentActivityPayload;
}

const humanGate = {
  kind: "waiting_on_operator" as const,
  source: "human_gate" as const,
  waitKey: "task-gate-1",
  placement: "run" as const,
  runId: "run-1",
  taskId: "task-gate-1",
  ticketId: "FG-100",
  campaignId: null,
  itemId: null,
  projectDir: null,
  projectLabel: "forge",
  startedAt: "2026-08-19T11:50:00.000Z",
  reason: "human gate at step plan (architect) in workflow feature",
  requestedAction: "advance or reject the gate",
  blockerKind: "human_gate",
  statusLabel: OPERATOR_WAIT_LABEL,
};

const campaignStop = {
  ...humanGate,
  source: "campaign_hard_stop" as const,
  waitKey: "item-1",
  taskId: null,
  itemId: "item-1",
  campaignId: "camp-1",
  ticketId: "FG-200",
  reason: "authoritative reviewer blocked the build",
  requestedAction: "resolve the reviewer block then resume",
  blockerKind: "human_decision",
};

const ready = (over: Partial<CurrentActivityPayload> = {}) => ({ phase: "ready" as const, activity: payload(over) });

describe("FG-734 AC2 — a live operator wait renders as a compact Waiting-on-operator status", () => {
  test("the In-flight fold-in renders the label, reason, and requested action", () => {
    const load = ready({ operatorWaits: [humanGate] } as never);
    const text = textOf(h(InFlightActivityWaits as never, { load, now: NOW, onRetry: () => {} }) as unknown as Vnode);
    assert.match(text, new RegExp(OPERATOR_WAIT_LABEL));
    assert.match(text, /human gate at step plan/);
    assert.match(text, /advance or reject the gate/);
    assert.match(text, /FG-100/);
  });

  test("homeActivityView pushes a `Waiting on operator` section", () => {
    const view = homeActivityView(ready({ operatorWaits: [campaignStop] } as never));
    const section = view.sections.find((s) => s.kind === "operatorWaits");
    assert.ok(section, "a Waiting on operator section is present");
    assert.equal(section!.heading, "Waiting on operator");
    assert.equal(section!.entries.length, 1);
    assert.equal(view.empty, false);
  });

  test("a stale/absent statusLabel reads the explicit fallback, never a fabricated one", () => {
    const summary = operatorWaitCompactSummary({ ...humanGate, statusLabel: "" } as never);
    assert.equal(summary.label, OPERATOR_WAIT_LABEL);
    assert.equal(summary.source, "human_gate");
    assert.equal(summary.class, "operator-wait-human-gate");
  });
});

describe("FG-734 AC7 — an operator wait keeps Home non-idle, alongside other work", () => {
  test("homeInFlightActivity folds EVERY operator wait in", () => {
    const load = ready({ operatorWaits: [humanGate, campaignStop] } as never);
    const inFlight = homeInFlightActivity(load);
    assert.equal(inFlight.operatorWaits.length, 2);
    // `anyWaits` in main.js is derived from exactly these lists — a non-empty
    // operatorWaits makes the workspace non-idle even with no host/CI wait.
    assert.ok(inFlight.operatorWaits.length > 0, "a pending decision is live work");
  });

  test("it coexists with a running host-verification wait rather than replacing it", () => {
    const view = homeActivityView(ready({
      operatorWaits: [humanGate],
      hostVerification: [{
        launchId: "launch-1", name: "worktree", command: ["npm", "test"], commandLine: "npm test",
        projectDir: null, projectLabel: "forge", associationKind: "explicit", purpose: "host_verification",
        unassociated: false, placement: "run", runId: "run-2", taskId: null, ticketId: "FG-999",
        campaignId: null, itemId: null, startedAt: "2026-08-19T11:50:00.000Z", observedAt: "2026-08-19T11:59:00.000Z",
        status: { state: "running" }, recordedStatus: { state: "running" }, statusLabel: "running", observation: "fresh",
      }],
    } as never));
    const kinds = view.sections.map((s) => s.kind);
    assert.ok(kinds.includes("operatorWaits"), "operator wait section present");
    assert.ok(kinds.includes("hostVerification"), "host verification section present alongside it");
  });
});

describe("FG-734 AC4 — absent-tolerant, malformed-rejecting", () => {
  test("an ABSENT operatorWaits (older server) still validates", () => {
    assert.equal(isCurrentActivityPayload(payload({})), true);
  });

  test("a present-but-malformed operatorWaits (an object) is a FAILED read, never idle", () => {
    const body = payload({ operatorWaits: {} } as never);
    assert.equal(isCurrentActivityPayload(body), false);
    const load = activityFromBody(body);
    assert.equal(activityPhase(load), "unavailable");
    assert.equal((load as { reason: string }).reason, "malformed");
  });

  test("an array with a malformed entry (missing waitKey) is rejected", () => {
    const body = payload({ operatorWaits: [{ ...humanGate, waitKey: "" }] } as never);
    assert.equal(isCurrentActivityPayload(body), false);
  });
});
