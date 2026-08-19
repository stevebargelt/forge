// FG-731 (Step 2b): the registered CI waits surfaced in the shared Current Activity
// derivation. This step is READ-ONLY over the persisted `ci_waits` record — the writer
// paths (register / observe / advance) are Steps 1 / 2a and tested there. What is pinned
// here is the LOAD-BEARING classification, and the ticket's #1 risk in particular:
//
//   THE #1 RISK — a NON-TERMINAL wait forces WAITING/never-IDLE by its MERE PRESENCE,
//   INDEPENDENT of how stale its last observation is. The launch / requiredCi
//   freshness-DROP rule (render a stale row as "unobserved since" and remove it from the
//   live set) is exactly the bug FG-731 fixes: a dead-waiter wait would age out and the
//   workspace would read idle again while a real CI run ground on off-surface. Existence
//   is DECOUPLED from liveness — freshness governs only the LABEL, never membership.
//
//   DISTINCT STATES, never faked — running (+ m/n) / no_runs / unavailable /
//   completed_awaiting_advance. `no_runs` and `unavailable` never collapse into each
//   other, into a fake success, or into idle.
//
//   WAITING/WORKING-never-IDLE classification over both branches — a registered wait is
//   not idle; nothing registered is.
//
// And the FG-704 regression fixture: a workflow_dispatch Actions run NOT bound to a
// tracked candidate sha appears as an activity row with kind / url / start / state.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb } from "../store/db.js";
import {
  CI_WAIT_AWAITING_ADVANCE_LABEL,
  CI_WAIT_NO_RUNS_LABEL,
  CI_WAIT_OBSERVATION_FRESH_MS,
  CI_WAIT_RUNNING_LABEL,
  CI_WAIT_UNAVAILABLE_LABEL,
  deriveCurrentActivity,
  renderCurrentActivityLines,
} from "./current-activity.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const PROJECT = "/repos/forge";
const OTHER_PROJECT = "/repos/other";
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

let db: DatabaseInstance;

beforeEach(() => {
  db = makeInMemoryDb();
});

afterEach(() => {
  db.close();
});

type CiWaitSeed = {
  id: string;
  kind?: string;
  lifecycleState?: string;
  terminal?: number;
  terminalDisposition?: string | null;
  observedState?: string | null;
  observedReason?: string | null;
  observedM?: number | null;
  observedN?: number | null;
  observedAt?: string | null;
  url?: string | null;
  startedAt?: string;
  runId?: string | null;
  ticketId?: string | null;
  projectDir?: string | null;
  projectDirCanonical?: string | null;
};

/** Insert a persisted `ci_waits` row directly — the equivalent of what registerCiWait +
 *  observeCiWait leave behind, so the derivation is exercised in isolation exactly as
 *  the FG-679/FG-694 derivation tests seed runs / reviews / events by raw SQL. */
function addCiWait(seed: CiWaitSeed): void {
  db.prepare(`
    INSERT INTO ci_waits (
      id, kind, url, started_at, lifecycle_state, terminal, terminal_disposition,
      observed_state, observed_reason, observed_m, observed_n, observed_at,
      run_id, ticket_id, project_dir, project_dir_canonical
    ) VALUES (
      @id, @kind, @url, @startedAt, @lifecycleState, @terminal, @terminalDisposition,
      @observedState, @observedReason, @observedM, @observedN, @observedAt,
      @runId, @ticketId, @projectDir, @projectDirCanonical
    )
  `).run({
    id: seed.id,
    kind: seed.kind ?? "workflow_dispatch",
    url: seed.url ?? null,
    startedAt: seed.startedAt ?? ago(60_000),
    lifecycleState: seed.lifecycleState ?? "running",
    terminal: seed.terminal ?? 0,
    terminalDisposition: seed.terminalDisposition ?? null,
    observedState: seed.observedState ?? null,
    observedReason: seed.observedReason ?? null,
    observedM: seed.observedM ?? null,
    observedN: seed.observedN ?? null,
    observedAt: seed.observedAt ?? null,
    runId: seed.runId ?? null,
    ticketId: seed.ticketId ?? null,
    projectDir: seed.projectDir ?? null,
    projectDirCanonical: seed.projectDirCanonical ?? null,
  });
}

const derive = (scope?: { runId?: string; projectDirs?: readonly string[] }) =>
  deriveCurrentActivity(db, { now: NOW, scope });

// ───────────────────────── THE #1 RISK — existence ≠ liveness ─────────────────────

describe("FG-731 #1 risk — a non-terminal wait forces never-IDLE INDEPENDENT of freshness", () => {
  test("a wait stale PAST both freshness cutoffs is STILL emitted, never dropped, and its label degrades to unavailable — never a fabricated running", () => {
    // Observed `running`, but the observation is older than the cutoff and no newer one
    // has landed — the dead-waiter case. The launch/requiredCi rule would DROP this from
    // the live set; FG-731 must not.
    const staleBy = CI_WAIT_OBSERVATION_FRESH_MS + 5 * 60_000;
    addCiWait({
      id: "wait-dead",
      kind: "workflow_dispatch",
      observedState: "running",
      observedM: 3,
      observedN: 7,
      observedAt: ago(staleBy),
      url: "https://gh.invalid/run/1",
    });

    const activity = derive();
    assert.equal(activity.ciWaits.length, 1, "the wait is STILL present — freshness never removes it");
    const w = activity.ciWaits[0]!;
    assert.equal(w.observation, "unobserved", "the observation is correctly recognized as stale");
    assert.equal(w.displayState, "unavailable", "…so the LABEL degrades");
    assert.match(w.statusLabel, new RegExp(CI_WAIT_UNAVAILABLE_LABEL));
    assert.doesNotMatch(w.statusLabel, /running|3\/7/i, "NEVER a fabricated running, never the stale m/n");

    // The workspace is NOT idle: the section renders a row, not the empty absence.
    const lines = renderCurrentActivityLines(activity);
    const ciWaitIdx = lines.indexOf("  CI waits");
    assert.notEqual(ciWaitIdx, -1);
    assert.notEqual(lines[ciWaitIdx + 1], "    (no CI wait registered)", "never 'Nothing running' while a wait lives");
    assert.ok(lines.some((l) => l.includes("wait-dead")), "the wait renders in `forge status`");
  });

  test("a wait registered but NEVER observed is present and unavailable — not idle, not fake-running", () => {
    addCiWait({ id: "wait-fresh-reg", lifecycleState: "registered", observedState: null, observedAt: null });
    const activity = derive();
    assert.equal(activity.ciWaits.length, 1);
    assert.equal(activity.ciWaits[0]!.displayState, "unavailable");
    assert.match(activity.ciWaits[0]!.statusLabel, /not yet observed/);
  });

  test("a fresh `running` observation DOES render the live m/n — the degradation is stale-only", () => {
    addCiWait({ id: "wait-live", observedState: "running", observedM: 5, observedN: 9, observedAt: ago(3_000) });
    const w = derive().ciWaits[0]!;
    assert.equal(w.observation, "fresh");
    assert.equal(w.displayState, "running");
    assert.equal(w.statusLabel, `${CI_WAIT_RUNNING_LABEL} 5/9`);
  });
});

// ───────────────────────── FG-704 regression fixture ──────────────────────────────

describe("FG-731 AC1 — the FG-704 workflow_dispatch scenario appears as an activity row", () => {
  test("a workflow_dispatch run not bound to any tracked candidate sha surfaces with kind/url/start/state", () => {
    addCiWait({
      id: "wait-fg704",
      kind: "workflow_dispatch",
      url: "https://github.com/o/r/actions/runs/999",
      startedAt: ago(120_000),
      observedState: "running",
      observedM: 1,
      observedN: 4,
      observedAt: ago(4_000),
    });

    // No candidate sha, no requiredCi observation — the exact blind spot FG-704 hit.
    const activity = derive();
    assert.equal(activity.requiredCi.observations.length, 0, "there is no tracked-candidate CI here");
    assert.equal(activity.ciWaits.length, 1, "…yet the awaited run is on the surface");
    const w = activity.ciWaits[0]!;
    assert.equal(w.kind, "workflow_dispatch");
    assert.equal(w.url, "https://github.com/o/r/actions/runs/999");
    assert.equal(w.startedAt, ago(120_000));
    assert.equal(w.displayState, "running");

    // …and via the render both `forge status` and the API agree on (BD-9).
    const text = renderCurrentActivityLines(activity).join("\n");
    assert.match(text, /workflow_dispatch/);
    assert.match(text, /actions\/runs\/999/);
  });
});

// ───────────────────────── distinct states, never faked ───────────────────────────

describe("FG-731 AC7 — no_runs vs unavailable are distinct; completed_awaiting_advance is neither", () => {
  test("a fresh `no_runs` observation renders `no CI is running` — never `unavailable`, never a fake success", () => {
    addCiWait({ id: "wait-none", observedState: "no_runs", observedAt: ago(2_000) });
    const w = derive().ciWaits[0]!;
    assert.equal(w.displayState, "no_runs");
    assert.equal(w.statusLabel, CI_WAIT_NO_RUNS_LABEL);
    assert.doesNotMatch(w.statusLabel, new RegExp(CI_WAIT_UNAVAILABLE_LABEL));
  });

  test("a fresh `unavailable` observation renders `CI state unavailable` + reason — never `no_runs`, never idle", () => {
    addCiWait({ id: "wait-unavail", observedState: "unavailable", observedReason: "gh rate limited", observedAt: ago(2_000) });
    const w = derive().ciWaits[0]!;
    assert.equal(w.displayState, "unavailable");
    assert.match(w.statusLabel, /gh rate limited/);
    assert.doesNotMatch(w.statusLabel, new RegExp(CI_WAIT_NO_RUNS_LABEL));
  });

  test("no_runs and unavailable are TWO different rows, side by side, that do not collapse", () => {
    addCiWait({ id: "wait-a", observedState: "no_runs", observedAt: ago(2_000) });
    addCiWait({ id: "wait-b", observedState: "unavailable", observedReason: "network", observedAt: ago(2_000) });
    const states = new Map(derive().ciWaits.map((w) => [w.waitId, w.displayState]));
    assert.equal(states.get("wait-a"), "no_runs");
    assert.equal(states.get("wait-b"), "unavailable");
  });

  test("completed_awaiting_advance renders as itself — not dropped, not `running`, even when stale", () => {
    addCiWait({
      id: "wait-done",
      lifecycleState: "completed_awaiting_advance",
      observedState: "completed",
      // deliberately stale: the awaiting-advance fact is a lifecycle fact, not an
      // observation about now, so freshness must not degrade it to `unavailable`.
      observedAt: ago(CI_WAIT_OBSERVATION_FRESH_MS + 60_000),
    });
    const w = derive().ciWaits[0]!;
    assert.equal(w.displayState, "completed_awaiting_advance");
    assert.equal(w.statusLabel, CI_WAIT_AWAITING_ADVANCE_LABEL);
    assert.doesNotMatch(w.statusLabel, /running|unavailable/i);
  });
});

// ───────────────────────── WAITING / WORKING — never IDLE ──────────────────────────

describe("FG-731 AC2 — classification over both branches", () => {
  test("a registered non-terminal wait is NOT idle — the CI-waits section is non-empty on `forge status`", () => {
    addCiWait({ id: "wait-live", observedState: "running", observedM: 1, observedN: 2, observedAt: ago(1_000) });
    const lines = renderCurrentActivityLines(derive());
    const idx = lines.indexOf("  CI waits");
    assert.notEqual(lines[idx + 1], "    (no CI wait registered)");
  });

  test("nothing registered → IDLE — the section renders the explicit empty absence", () => {
    const activity = derive();
    assert.deepEqual(activity.ciWaits, []);
    const lines = renderCurrentActivityLines(activity);
    const idx = lines.indexOf("  CI waits");
    assert.equal(lines[idx + 1], "    (no CI wait registered)");
  });

  test("a TERMINAL wait leaves the live surface deterministically — advanced/cancelled/abandoned are gone", () => {
    for (const [disp] of [["advanced"], ["cancelled"], ["abandoned"]] as const) {
      addCiWait({ id: `wait-${disp}`, lifecycleState: disp, terminal: 1, terminalDisposition: disp });
    }
    assert.deepEqual(derive().ciWaits, [], "terminal waits are not live — the workspace can read idle again");
  });

  test("a row whose `terminal` byte lies (0) but whose state is terminal is still excluded — the canonical state wins", () => {
    addCiWait({ id: "wait-corrupt", lifecycleState: "advanced", terminal: 0, terminalDisposition: "advanced" });
    assert.deepEqual(derive().ciWaits, [], "isCiWaitLive decides terminality from the state, not the byte");
  });
});

// ───────────────────────── placement / scoping (parallels launches) ────────────────

describe("FG-731 — placement/scope uses the association ids exactly as launches do", () => {
  test("run scope shows only the wait declaring that run", () => {
    addCiWait({ id: "wait-r1", runId: "run-1" });
    addCiWait({ id: "wait-r2", runId: "run-2" });
    const ids = derive({ runId: "run-1" }).ciWaits.map((w) => w.waitId);
    assert.deepEqual(ids, ["wait-r1"]);
  });

  test("project scope shows only the wait declaring that project home", () => {
    addCiWait({ id: "wait-p1", projectDir: PROJECT });
    addCiWait({ id: "wait-p2", projectDir: OTHER_PROJECT });
    const ids = derive({ projectDirs: [PROJECT] }).ciWaits.map((w) => w.waitId);
    assert.deepEqual(ids, ["wait-p1"]);
  });

  test("host-wide shows an UNASSOCIATED wait too — the FG-704 run had no run/project id and still may not read idle", () => {
    addCiWait({ id: "wait-orphan", runId: null, projectDir: null });
    const w = derive().ciWaits;
    assert.equal(w.length, 1);
    assert.equal(w[0]!.placement, "host");
  });
});
