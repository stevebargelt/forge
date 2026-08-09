// FG-694 (wave B): what HOME may render, and what it may render when it has read
// nothing. Two defects, one class of error pointed in opposite directions.
//
//   AC4/AC5  Home rendered the audit payload directly — every candidate, every
//            required check, every URL state and every observation timestamp. On
//            2026-08-08 that was ten stale tickets with ten check rows apiece.
//            Home now gets ONE compact line per current candidate; the per-context
//            evidence is MOVED behind a disclosure, never deleted.
//   AC6      three permanently-empty subsections were the noise. With nothing
//            current, Home says `Nothing currently running.` once — and the
//            headings themselves do not render.
//   AC7      a dashboard server started before FG-679 serves this client and 404s
//            /api/current-activity. The client ignored the non-OK response, left
//            `activity === null`, and rendered `loading…`, `No agent task in
//            flight`, `No host launch observed in flight` AND `CI not observed` at
//            once — while `forge status` showed an active orchestrator task. Missing
//            data presented as observed absence.
//
// WHY THIS SUITE RENDERS THE COMPONENT. AC7 is a claim about STRINGS AN OPERATOR
// SEES: four sentences that may not appear. Asserting that over a view model would
// only prove the model does not contain them — the renderer could compose them
// anyway, which is precisely what the shipped defect did (it composed three of them
// from a null). So the component is imported and rendered, and the assertions run
// over the rendered text.
//
// The renderer below walks the preact vnode tree instead of driving a DOM, and it
// honours ONE piece of browser semantics deliberately: a closed <details> shows only
// its <summary>. That is what makes "collapsed Home" and "opened detail" two
// different, separately-assertable texts here — the same distinction AC4 and AC5
// divide the evidence along.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { h } from "preact";
import {
  ACTIVITY_LOADING,
  RENDER_DEREFERENCE_CONTRACT,
  CI_FAILED_LABEL,
  CI_NOT_STARTED_LABEL,
  CI_PASSED_LABEL,
  CI_RUNNING_LABEL,
  CI_STATUS_UNAVAILABLE_LABEL,
  CURRENT_ACTIVITY_UNAVAILABLE_LABEL,
  IN_FLIGHT_WAITS_UNAVAILABLE_LABEL,
  NOTHING_RUNNING_LABEL,
  OBSERVATION_CLAIMS,
  activityFromBody,
  activityPhase,
  activityUnavailable,
  ciCompactSummary,
  createActivityReader,
  homeActivityView,
  homeCiSummaries,
  homeInFlightActivity,
  isCurrentActivityPayload,
  isRenderableEntry,
  readCurrentActivity,
} from "../client/current-activity-render.js";
import { CurrentActivitySection, InFlightActivityWaits } from "../client/current-activity-view.js";
import type { CurrentActivityPayload, RequiredCiObservationEntry } from "../client/current-activity-render.js";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const SHA = "c0ffee1234567890abcdef1234567890abcdef12";
const OBSERVED_AT = "2026-08-08T11:59:40.000Z";
const CHECK_URL = "https://example.invalid/checks/1";

// ───────────────────────── vnode → text, the way a browser would ─────────────────

type Vnode = { type: unknown; props: Record<string, unknown> } | string | number | null | undefined | boolean | Vnode[];

function children(props: Record<string, unknown>): Vnode {
  return props.children as Vnode;
}

/** The rendered text. `openDetails: false` renders a closed <details> as its
 *  <summary> alone — what the operator sees on Home before drilling down. */
function textOf(node: Vnode, openDetails: boolean): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  // Concatenated, not space-joined: htm keeps the template's literal whitespace as
  // its own text node, so joining would double every space the markup already has.
  if (Array.isArray(node)) return node.map((n) => textOf(n, openDetails)).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  const { type, props } = node;
  if (typeof type === "function") return textOf((type as (p: unknown) => Vnode)(props), openDetails);
  if (type === "details" && !openDetails) {
    const kids = Array.isArray(children(props)) ? (children(props) as Vnode[]) : [children(props)];
    const summary = kids.find((k) => k !== null && typeof k === "object" && !Array.isArray(k) && k.type === "summary");
    return summary ? textOf(summary, openDetails) : "";
  }
  return textOf(children(props), openDetails);
}

/** Every element vnode in the tree, with function components expanded. */
function elements(node: Vnode, out: Array<{ type: string; props: Record<string, unknown> }> = []): Array<{ type: string; props: Record<string, unknown> }> {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") return out;
  const { type, props } = node;
  if (typeof type === "function") return elements((type as (p: unknown) => Vnode)(props), out);
  if (typeof type === "string") out.push({ type, props });
  return elements(children(props), out);
}

function classOf(el: { props: Record<string, unknown> }): string {
  return typeof el.props.class === "string" ? el.props.class : "";
}

function withClass(node: Vnode, cls: string): Array<{ type: string; props: Record<string, unknown> }> {
  return elements(node).filter((el) => classOf(el).split(/\s+/).includes(cls));
}

const home = (load: unknown): Vnode =>
  h(CurrentActivitySection as never, { load, now: NOW, onTaskClick: () => {}, onRetry: () => {} }) as unknown as Vnode;

const collapsed = (load: unknown): string => textOf(home(load), false);
const opened = (load: unknown): string => textOf(home(load), true);

// ───────────────────────────────── fixtures ──────────────────────────────────────

function context(name: string, state: string): RequiredCiObservationEntry["contexts"][number] {
  return { context: name, state, url: `${CHECK_URL}#${name}`, observedAt: OBSERVED_AT };
}

function observation(over: Partial<RequiredCiObservationEntry> = {}): RequiredCiObservationEntry {
  return {
    runId: "run-fg694",
    projectDir: null,
    projectLabel: "forge",
    attemptId: "attempt-1",
    ticketId: "FG-253",
    candidateSha: SHA,
    observedAt: OBSERVED_AT,
    outcome: "pending",
    unavailableReason: null,
    contexts: [context("test", "pending")],
    state: "running",
    label: CI_RUNNING_LABEL,
    ...over,
  };
}

/** An `observed` requiredCi section around whatever observations a fixture wants —
 *  including deliberately malformed ones, which is why it takes `unknown[]`. */
function ciSection(observations: unknown[]): { state: string; label: string; observations: unknown[] } {
  return { state: "observed", label: `${observations.length} observed`, observations };
}

/** The ticket's own example: 10 required contexts, 7 of them settled. */
const sevenOfTen = observation({
  contexts: [
    ...Array.from({ length: 7 }, (_, i) => context(`check-${i}`, "success")),
    ...Array.from({ length: 3 }, (_, i) => context(`pending-${i}`, "in_progress")),
  ],
});

function payload(over: Partial<CurrentActivityPayload> = {}): CurrentActivityPayload {
  return {
    generatedAt: "2026-08-08T12:00:00.000Z",
    scope: { runId: null, projectDirs: null },
    agents: [],
    hostVerification: [],
    requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] },
    unassociated: [],
    ...over,
  } as CurrentActivityPayload;
}

const agent = {
  runId: "run-fg694",
  runTitle: "make Home compact and honest",
  workflow: "feature",
  projectDir: null,
  projectLabel: "forge",
  taskId: "task-build-aef6ae",
  agentRole: "frontend-specialist",
  agentModel: null,
  phase: "build",
  status: "running",
  startedAt: "2026-08-08T11:50:00.000Z",
};

const launch = {
  launchId: "launch-worktree-8pagjk",
  name: "worktree-tier",
  command: ["npm", "run", "test:worktree"],
  commandLine: "npm run test:worktree",
  projectDir: null,
  projectLabel: "forge",
  associationKind: "explicit" as const,
  unassociated: false,
  placement: "run" as const,
  runId: "run-fg694",
  taskId: null,
  ticketId: "FG-694",
  campaignId: null,
  itemId: null,
  startedAt: "2026-08-08T11:50:00.000Z",
  observedAt: "2026-08-08T11:59:00.000Z",
  status: { state: "running" as const },
  recordedStatus: { state: "running" as const },
  statusLabel: "running",
  observation: "fresh" as const,
};

const ready = (over: Partial<CurrentActivityPayload> = {}) => ({ phase: "ready" as const, activity: payload(over) });

// ─────────────────────────── AC4 — one compact line ──────────────────────────────

describe("FG-694 AC4 — Home renders at most ONE compact CI summary per current candidate", () => {
  test("the ticket's own example: `FG-253 · CI running · 7/10 complete`", () => {
    const summary = ciCompactSummary(sevenOfTen);
    assert.equal(summary.identity, "FG-253");
    assert.equal(summary.label, CI_RUNNING_LABEL);
    assert.equal(summary.detail, "7/10 complete");

    const text = collapsed({ phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [sevenOfTen] } }) });
    assert.match(text, /FG-253/);
    assert.match(text, /CI running/);
    assert.match(text, /7\/10 complete/);
  });

  test("the ticket's other example: `FG-253 · CI failed · test-extended`", () => {
    const failed = observation({
      outcome: "failure",
      state: "not_running",
      label: "CI not running",
      contexts: [context("test", "success"), context("test-extended", "failure")],
    });
    const summary = ciCompactSummary(failed);
    assert.equal(summary.label, CI_FAILED_LABEL);
    assert.equal(summary.detail, "test-extended", "the failing context is NAMED — that is the fact an operator acts on");

    const text = collapsed({ phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [failed] } }) });
    assert.match(text, /FG-253/);
    assert.match(text, /CI failed/);
    assert.match(text, /test-extended/);
  });

  test("collapsed Home carries NO per-context row, NO full sha, NO check URL and NO raw observation timestamp", () => {
    const load = { phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [sevenOfTen] } }) };
    const text = collapsed(load);

    assert.doesNotMatch(text, new RegExp(SHA), "the full candidate sha is drill-down detail, not summary");
    assert.doesNotMatch(text, /example\.invalid/, "check URLs are drill-down detail");
    assert.doesNotMatch(text, /2026-08-08T11:59:40/, "raw observation timestamps are drill-down detail");
    assert.equal(withClass(home(load), "ca-ci-context").length, 10, "the contexts EXIST in the tree…");
    // …and none of their text is in the collapsed rendering: they live under the
    // closed disclosure. `check-0` is the first of the ten context names.
    assert.doesNotMatch(text, /check-0/, "…but no per-context row renders until the operator opens details");
  });

  test("three current candidates render three summary lines — one each, not thirty check rows", () => {
    const three = ["FG-253", "FG-679", "FG-694"].map((ticketId) => observation({ ticketId, attemptId: `attempt-${ticketId}` }));
    const load = { phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "3 observed", observations: three } }) };
    assert.equal(withClass(home(load), "ca-ci-summary").length, 3);
    const text = collapsed(load);
    for (const ticketId of ["FG-253", "FG-679", "FG-694"]) assert.match(text, new RegExp(ticketId));
  });

  test("a candidate with no ticket id is named by its SHORT sha, never the full one", () => {
    const summary = ciCompactSummary(observation({ ticketId: null }));
    assert.equal(summary.identity, SHA.slice(0, 7));
    assert.notEqual(summary.identity, SHA);
  });

  test("the compact vocabulary distinguishes running / failed / passed / not started / unavailable", () => {
    const label = (over: Partial<RequiredCiObservationEntry>) => ciCompactSummary(observation(over)).label;
    assert.equal(label({}), CI_RUNNING_LABEL);
    assert.equal(label({ contexts: [context("test", "failure")], state: "not_running" }), CI_FAILED_LABEL);
    assert.equal(label({ contexts: [context("test", "success")], state: "not_running", outcome: "success" }), CI_PASSED_LABEL);
    assert.equal(label({ contexts: [], state: "not_running", outcome: "success" }), CI_NOT_STARTED_LABEL,
      "the observer looked and found no required check — different from not having looked");
    assert.equal(label({ state: "stale", label: "stale — CI last observed 2026-08-08T09:00:00.000Z" }), CI_STATUS_UNAVAILABLE_LABEL);
    assert.equal(label({ outcome: "unavailable", unavailableReason: "gh rate limited", state: "not_running" }), CI_STATUS_UNAVAILABLE_LABEL);
  });

  test("a stale observation's raw timestamp never reaches the compact line", () => {
    const stale = observation({ state: "stale", label: "stale — CI last observed 2026-08-08T09:00:00.000Z" });
    const text = collapsed({ phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [stale] } }) });
    assert.match(text, new RegExp(CI_STATUS_UNAVAILABLE_LABEL));
    assert.doesNotMatch(text, /2026-08-08T09:00:00/);
  });

  test("a failing check outranks pending ones — but the pending count survives in the detail", () => {
    const mixed = observation({ contexts: [context("test", "failure"), context("test-extended", "pending")] });
    assert.equal(ciCompactSummary(mixed).label, CI_FAILED_LABEL);
    assert.match(opened({ phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [mixed] } }) }), /test-extended[\s\S]*pending|pending[\s\S]*test-extended/);
  });
});

// ─────────────── AC5 — the detail is MOVED behind a disclosure, not deleted ──────

describe("FG-694 AC5 — opening the drill-down restores every piece of FG-679's evidence", () => {
  test("the opened detail carries the exact sha, every context with its state, its URL and its observation time", () => {
    const load = { phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [sevenOfTen] } }) };
    const text = opened(load);

    assert.match(text, new RegExp(SHA), "the EXACT candidate sha the observer declared (BD-5)");
    assert.match(text, /observed 2026-08-08T11:59:40\.000Z/, "the observation time");
    assert.equal(withClass(home(load), "ca-ci-context").length, 10, "EVERY required context — a summary verdict does not satisfy BD-5");
    for (let i = 0; i < 7; i++) assert.match(text, new RegExp(`check-${i}`));
    for (let i = 0; i < 3; i++) assert.match(text, new RegExp(`pending-${i}`));

    const urls = elements(home(load))
      .filter((el) => el.type === "a")
      .map((el) => String(el.props.href));
    assert.equal(urls.length, 10, "every context keeps its own check URL");
    for (const url of urls) assert.match(url, /^https:\/\//, "no host path is ever linked (BD-10)");
  });

  test("the unavailable reason survives the move to the drill-down", () => {
    const unavailable = observation({ outcome: "unavailable", unavailableReason: "gh rate limited", contexts: [] });
    const load = { phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [unavailable] } }) };
    assert.doesNotMatch(collapsed(load), /gh rate limited/, "diagnostics are not summary");
    assert.match(opened(load), /unavailable: gh rate limited/, "…and are not deleted either");
  });

  test("the disclosure is a native <details>/<summary> — keyboard-operable without a hand-rolled aria-expanded", () => {
    const load = { phase: "ready", activity: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [sevenOfTen] } }) };
    const els = elements(home(load));
    assert.equal(els.filter((el) => el.type === "details").length, 1);
    assert.equal(els.filter((el) => el.type === "summary").length, 1);
    assert.equal(els.filter((el) => "aria-expanded" in el.props).length, 0, "no hand-rolled expanded state to drift out of sync");
  });
});

// ────────────────────── AC6 — no empty sections, one calm line ───────────────────

describe("FG-694 AC6 — nothing current renders ONE statement and no empty subsections", () => {
  test("no agents, no host verification, no current candidate → `Nothing currently running.` and NO headings", () => {
    const load = ready();
    const text = collapsed(load);
    assert.match(text, new RegExp(NOTHING_RUNNING_LABEL.replace(".", "\\.")));
    assert.equal(withClass(home(load), "ca-heading").length, 0, "the headings themselves must not render when empty");
    for (const heading of ["Agents", "Host verification", "Required CI"]) {
      assert.doesNotMatch(text, new RegExp(`\\b${heading}\\b`), `${heading} is an empty subsection and must not render`);
    }
    assert.equal(homeActivityView(load).sections.length, 0);
  });

  test("`Nothing currently running.` is said ONCE, not once per section", () => {
    const text = collapsed(ready());
    assert.equal(text.split(NOTHING_RUNNING_LABEL).length - 1, 1);
  });

  test("an agent in flight renders the Agents heading and NOTHING for the two empty sections", () => {
    const load = ready({ agents: [agent] });
    const headings = withClass(home(load), "ca-heading").map((el) => textOf(children(el.props), false));
    assert.deepEqual(headings, ["Agents"]);
    const text = collapsed(load);
    assert.match(text, /frontend-specialist/);
    assert.doesNotMatch(text, new RegExp(NOTHING_RUNNING_LABEL.replace(".", "\\.")), "something IS running");
    for (const claim of OBSERVATION_CLAIMS) assert.doesNotMatch(text, new RegExp(claim));
  });

  test("sections render in a fixed order, and only the populated ones", () => {
    const load = ready({
      agents: [agent],
      hostVerification: [launch],
      requiredCi: { state: "observed", label: "1 observed", observations: [sevenOfTen] },
      unassociated: [{ ...launch, launchId: "launch-orphan-gggggg", unassociated: true, runId: null }],
    });
    assert.deepEqual(homeActivityView(load).sections.map((s) => s.heading),
      ["Agents", "Host verification", "Required CI", "Unassociated activity"]);
  });

  test("`no_current_candidate` omits the CI row entirely — it does NOT report CI as unobserved", () => {
    assert.equal(homeCiSummaries({ state: "no_current_candidate", label: "no current CI candidate", observations: [] }), null);
    const text = collapsed(ready({ agents: [agent] }));
    assert.doesNotMatch(text, /Required CI/);
    assert.doesNotMatch(text, /CI not observed/);
    assert.doesNotMatch(text, /CI/, "with no candidate, the surface says nothing about CI at all");
  });

  test("`not_observed` — a current candidate with no observation — reads `CI status unavailable`, never `CI not observed`", () => {
    const load = ready({ requiredCi: { state: "not_observed", label: "CI not observed", observations: [] } });
    const text = collapsed(load);
    assert.match(text, new RegExp(CI_STATUS_UNAVAILABLE_LABEL));
    assert.doesNotMatch(text, /CI not observed/, "host-wide, that string read as a claim about the checks");
    assert.doesNotMatch(text, new RegExp(NOTHING_RUNNING_LABEL.replace(".", "\\.")), "there IS current work — it is CI we cannot speak to");
  });
});

// ──────── the post-ship correction — Home has ONE activity surface, In flight ─────
//
// What the compact rewrite above did NOT fix. `Right now / Current activity` was still
// a second top-level panel on Home, above `In flight`; the live reproduction after
// d55a29aa measured it at 810.5px in an 862px viewport, with every agent rendered twice
// (once per panel) and eight historical CI candidates under it. Home now folds only the
// WAITS into the section it already had, and every one of the assertions below is about
// what may NOT appear there.

describe("FG-694 correction — Home's In flight folds in waits only, and never a second panel", () => {
  const wait = (over: Record<string, unknown> = {}) => homeInFlightActivity(ready(over as never));

  const waitsText = (load: unknown): string =>
    textOf(h(InFlightActivityWaits as never, { load, now: NOW, onRetry: () => {} }) as unknown as Vnode, false);

  test("agents are NEVER folded in — they already render from /api/in-flight", () => {
    const waits = wait({ agents: [agent] });
    assert.deepEqual(waits.hostVerification, []);
    assert.deepEqual(waits.ci, []);
    const text = waitsText(ready({ agents: [agent] }));
    assert.doesNotMatch(text, /frontend-specialist/, "an agent rendered here is the same agent rendered twice");
    assert.doesNotMatch(text, /task-build-aef6ae/);
    // The claim is structural, not incidental: the decision function does not read the
    // field at all, so duplication cannot come back through a rendering change.
    const source = readFileSync(new URL("../client/current-activity-render.js", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("function homeInFlightActivity("));
    assert.doesNotMatch(body.slice(0, body.indexOf("\n}")), /\.agents\b/,
      "homeInFlightActivity must not read `agents` — that is what makes the duplication unrepresentable");
  });

  test("a host launch is folded in only while it is OBSERVED and RUNNING", () => {
    assert.equal(wait({ hostVerification: [launch] }).hostVerification.length, 1);
    for (const over of [
      { observation: "unobserved" },
      { status: { state: "exited_ok" } },
      { status: { state: "owner_gone" } },
      { status: { state: "unknown" } },
    ]) {
      const waits = wait({ hostVerification: [{ ...launch, ...over }] });
      assert.deepEqual(waits.hostVerification, [], `${JSON.stringify(over)} is history or a disposition, not a wait`);
    }
  });

  test("an unassociated launch is still a wait, and keeps its label rather than being attributed", () => {
    const orphan = { ...launch, launchId: "launch-orphan-gggggg", unassociated: true, runId: null, ticketId: null, name: null };
    const waits = wait({ unassociated: [orphan] });
    assert.equal(waits.hostVerification.length, 1);
    const text = waitsText(ready({ unassociated: [orphan] }));
    assert.match(text, /launch-orphan-gggggg/, "with no ticket and no name, the id is the only honest identity");
    assert.match(text, /unassociated/);
  });

  test("a CI candidate is folded in only while its required checks are PENDING", () => {
    assert.equal(wait({ requiredCi: ciSection([sevenOfTen]) as never }).ci.length, 1);
    const notWaits: Array<[string, unknown]> = [
      ["passed", observation({ contexts: [context("test", "success")], state: "not_running", outcome: "success" })],
      ["failed", observation({ contexts: [context("test", "failure")], state: "not_running", outcome: "failure" })],
      ["stale", observation({ state: "stale" })],
      ["not started", observation({ contexts: [], state: "not_running", outcome: "success" })],
    ];
    for (const [name, o] of notWaits) {
      assert.deepEqual(wait({ requiredCi: ciSection([o]) as never }).ci, [], `${name} is an outcome to read on the detail, not a wait`);
    }
    // …and `not_observed`, which synthesizes a row with no observation behind it, is
    // not a wait either — a permanent `CI status unavailable` line under every active
    // run is the empty subsection this correction removes.
    assert.deepEqual(wait({ requiredCi: { state: "not_observed", label: "CI not observed", observations: [] } as never }).ci, []);
  });

  test("the CI wait is ONE line and carries no sha, no URL, no timestamp and no context dump", () => {
    const text = waitsText(ready({ requiredCi: ciSection([sevenOfTen]) as never }));
    assert.match(text, /FG-253/, "the candidate is named by its ticket");
    assert.match(text, new RegExp(CI_RUNNING_LABEL));
    assert.match(text, /7\/10 complete/);
    assert.doesNotMatch(text, new RegExp(SHA), "the full sha is detail, on the diagnostic surface");
    assert.doesNotMatch(text, /example\.invalid/, "check URLs are detail");
    assert.doesNotMatch(text, new RegExp(OBSERVED_AT.replace(/[.]/g, "\\.")), "raw observation timestamps are detail");
    assert.doesNotMatch(text, /check-0/, "the per-context enumeration is detail");
    assert.equal(withClass(h(InFlightActivityWaits as never,
      { load: ready({ requiredCi: ciSection([sevenOfTen]) as never }), now: NOW }) as unknown as Vnode, "ca-ci-item").length, 0,
      "no disclosure on Home — opening one would put the whole payload back");
  });

  test("the host wait is ONE line and carries no argv, no launch identity dump and no observation time", () => {
    const text = waitsText(ready({ hostVerification: [launch] }));
    assert.match(text, /FG-694/, "the wait is named by the ticket it declared");
    assert.doesNotMatch(text, /npm run test:worktree/, "the argv is context, and per-row context is what overflowed the viewport");
    assert.doesNotMatch(text, /run-fg694/, "the run/task identity line is diagnostic detail");
    assert.doesNotMatch(text, /2026-08-08T11:59:00/, "the observation time is diagnostic detail");
  });

  test("nothing to wait on renders NOTHING — not a heading, not an empty row", () => {
    assert.equal(waitsText(ready()), "");
    assert.equal(waitsText(ready({ agents: [agent] })), "", "an agent is not a wait, and does not summon an empty waits block");
  });

  test("a read that has not landed says nothing; a read that FAILED says so, and claims no absence", () => {
    assert.equal(waitsText(ACTIVITY_LOADING), "", "In flight already renders what /api/in-flight observed");

    const failed = activityUnavailable("http", 404);
    assert.equal(homeInFlightActivity(failed).message, IN_FLIGHT_WAITS_UNAVAILABLE_LABEL);
    const text = waitsText(failed);
    assert.match(text, new RegExp(IN_FLIGHT_WAITS_UNAVAILABLE_LABEL));
    assert.match(text, /predates the route/, "the detail is about the READ");
    for (const claim of OBSERVATION_CLAIMS) {
      assert.doesNotMatch(text, new RegExp(claim), `a failed read may not claim "${claim}"`);
    }
    assert.doesNotMatch(text, /No host launch/, "…and may not imply it looked at launches either");
  });

  test("Home's own surface carries no `Current activity` heading and no `Right now` kicker", () => {
    // The panel is gone from main.js's HomeView, and it is the ONE place the heading was
    // authored. Read the source: the assertion is about what Home renders, and HomeView
    // cannot be imported (main.js calls render() at module scope).
    const main = readFileSync(new URL("../client/main.js", import.meta.url), "utf8");
    const start = main.indexOf("function HomeView(");
    assert.notEqual(start, -1, "HomeView is gone — re-audit where Home's activity surfaces are composed");
    const homeView = main.slice(start, main.indexOf("\n}", start));
    assert.doesNotMatch(homeView, /CurrentActivitySection/,
      "Home renders ONE activity surface; the Current activity panel is the diagnostic rendering, on the Activity view");
    assert.match(homeView, /home-in-flight-heading/, "…and that one surface is still In flight");
    assert.equal((main.match(/In flight<\/h2>/g) ?? []).length, 2,
      "the two In flight headings are Home's and the Activity view's — a third means a second surface came back");
  });
});

// ───────────────────── AC7 — a failed read has observed nothing ──────────────────

describe("FG-694 AC7 — every failure mode renders the unavailable state and NONE of the four observation claims", () => {
  const stubResponse = (over: Partial<{ ok: boolean; status: number; json: () => Promise<unknown> }>) => ({
    ok: true,
    status: 200,
    json: async () => payload(),
    ...over,
  });

  /** The four failure modes, each produced through readCurrentActivity — the code
   *  that ships — rather than by hand-constructing the load a test wishes for. */
  const MODES: Array<{ name: string; fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>; reason: string; timeoutMs?: number }> = [
    {
      name: "404 — a dashboard server that predates the route (the reproduced case)",
      fetchImpl: async () => stubResponse({ ok: false, status: 404, json: async () => ({}) }),
      reason: "http",
    },
    {
      name: "500",
      fetchImpl: async () => stubResponse({ ok: false, status: 500, json: async () => ({}) }),
      reason: "http",
    },
    {
      name: "200 with a malformed body (an HTML error page, a truncated read)",
      fetchImpl: async () => stubResponse({ json: async () => { throw new SyntaxError("Unexpected token < in JSON"); } }),
      reason: "malformed",
    },
    {
      name: "200 with valid JSON that is not a current-activity payload",
      fetchImpl: async () => stubResponse({ json: async () => ({ ok: true }) }),
      reason: "malformed",
    },
    {
      name: "an initial load that never answers",
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
      reason: "timeout",
      timeoutMs: 20,
    },
    {
      name: "the request never left the machine",
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
      reason: "network",
    },
  ];

  for (const mode of MODES) {
    test(`${mode.name} → \`Current activity unavailable\` + retry, and none of the four claims`, async () => {
      const load = await readCurrentActivity("/api/current-activity", mode.fetchImpl as never, mode.timeoutMs);
      assert.equal(activityPhase(load), "unavailable", `${mode.name} must not read as a payload`);
      assert.equal((load as { reason: string }).reason, mode.reason);

      const text = collapsed(load);
      assert.match(text, new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));

      // THE ASSERTION THIS SUITE EXISTS FOR. Each of these is an OBSERVATION. A read
      // that failed observed nothing and may claim none of them.
      for (const claim of OBSERVATION_CLAIMS) {
        assert.doesNotMatch(text, new RegExp(claim), `a failed read may not claim "${claim}"`);
      }

      // …and a retry affordance, or the operator's only recovery is a page reload.
      const buttons = elements(home(load)).filter((el) => el.type === "button");
      assert.equal(buttons.length, 1, "exactly one control: retry");
      assert.equal(textOf(buttons[0]!.props.children as Vnode, false).trim(), "Retry");
      assert.equal(buttons[0]!.props.type, "button", "not a submit");
    });
  }

  test("the 404 detail names the version skew, because that is the operator's actual next step", () => {
    const text = collapsed(activityUnavailable("http", 404));
    assert.match(text, /predates the route/);
    assert.match(text, /restart it/);
  });

  test("the unavailable state is announced, not merely coloured", () => {
    const alerts = elements(home(activityUnavailable("http", 404))).filter((el) => el.props.role === "alert");
    assert.equal(alerts.length, 1);
  });

  test("loading is its OWN state — it does not render alongside empty sections, and claims nothing", () => {
    // The shipped defect rendered `loading…` AND `No agent task in flight` AND `No
    // host launch observed in flight` AND `CI not observed`, simultaneously.
    const text = collapsed(ACTIVITY_LOADING);
    assert.match(text, /Loading current activity/);
    for (const claim of OBSERVATION_CLAIMS) assert.doesNotMatch(text, new RegExp(claim));
    assert.equal(withClass(home(ACTIVITY_LOADING), "ca-heading").length, 0);
  });

  test("`null` — no load at all — is loading, and claims nothing either", () => {
    for (const nothing of [null, undefined, {}, { phase: "ready" }, { phase: "ready", activity: null }]) {
      const text = collapsed(nothing);
      for (const claim of OBSERVATION_CLAIMS) {
        assert.doesNotMatch(text, new RegExp(claim), `${JSON.stringify(nothing)} may not claim "${claim}"`);
      }
    }
  });

  test("NOT vacuous: a 200 carrying a real payload still reaches `ready` and renders the work", async () => {
    const activity = payload({ agents: [agent], requiredCi: { state: "observed", label: "1 observed", observations: [sevenOfTen] } });
    const load = await readCurrentActivity("/api/current-activity", (async () => stubResponse({ json: async () => activity })) as never);
    assert.equal(activityPhase(load), "ready");
    const text = collapsed(load);
    assert.match(text, /frontend-specialist/);
    assert.match(text, /CI running/);
    assert.doesNotMatch(text, new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));
  });

  test("NOT vacuous: `Nothing currently running.` IS reachable — from a successful read of an empty payload", async () => {
    const load = await readCurrentActivity("/api/current-activity", (async () => stubResponse({})) as never);
    assert.equal(activityPhase(load), "ready");
    assert.match(collapsed(load), new RegExp(NOTHING_RUNNING_LABEL.replace(".", "\\.")));
  });

  // ── RF-3 / RF-5: a structurally malformed ENTRY is a failed read, at ANY depth ──
  //
  // RF-3: the container check alone said `ready` for a 200 whose `agents` array held a
  // `null`, and the render then threw building the row — showing the operator neither
  // the activity nor the unavailable state with its Retry.
  //
  // RF-5: the SAME defect one level deeper, and the reason RF-3's first fix was not
  // enough. That fix validated the CI observation object but not its `contexts`
  // members, so `contexts: [null]` still read as `ready` and `ciContextRows` still
  // threw on `c.context`.
  //
  // AC7 enumerates exactly this case, so what is asserted below is the CLASS, not the
  // two reported shapes: every field named by RENDER_DEREFERENCE_CONTRACT, at every
  // depth in it, on every entry array that reaches a row.
  describe("FG-694 AC7 (RF-3/RF-5) — malformed entries resolve to `unavailable`, never to a thrown render", () => {
    /** The PRE-RF-3 rule, restated, so each fixture below is shown to be non-vacuous:
     *  every one of them is a body the originally shipped validator called `ready`. */
    const containerOnlyAccepted = (v: unknown): boolean => {
      const o = v as Record<string, unknown> | null;
      if (!o || typeof o !== "object" || Array.isArray(o)) return false;
      if (!Array.isArray(o.agents) || !Array.isArray(o.hostVerification)) return false;
      const ci = o.requiredCi as Record<string, unknown> | undefined;
      if (!ci || typeof ci !== "object" || Array.isArray(ci)) return false;
      if (typeof ci.state !== "string" || ci.state === "") return false;
      return Array.isArray(ci.observations);
    };

    /** The RF-3 fix, restated — entries validated, their MEMBERS not. A fixture this
     *  one accepts is a fixture that defeats the previous remediation cycle, which is
     *  what makes the RF-5 coverage below non-vacuous against it specifically. */
    const entryOnlyAccepted = (v: unknown): boolean => {
      if (!containerOnlyAccepted(v)) return false;
      const o = v as Record<string, unknown>;
      const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
      const str = (x: unknown): boolean => typeof x === "string" && x !== "";
      const launches = [...(o.hostVerification as unknown[]), ...(Array.isArray(o.unassociated) ? o.unassociated : [])];
      if (!(o.agents as unknown[]).every((a) => obj(a) && str(a.taskId) && str(a.status))) return false;
      if (!launches.every((l) => obj(l) && str(l.launchId))) return false;
      const ci = o.requiredCi as Record<string, unknown>;
      return (ci.observations as unknown[]).every((c) => obj(c) && str(c.candidateSha));
    };

    const MALFORMED: Array<{ name: string; body: unknown; defeatsEntryOnlyFix?: true }> = [
      { name: "agents: [null] — the reported RF-3 case, where the row build reads `a.taskId`", body: payload({ agents: [null] } as never) },
      { name: "an agent entry with no taskId", body: payload({ agents: [{ ...agent, taskId: undefined }] } as never) },
      { name: "an agent entry with no status — AgentRow calls `entry.status.replace`", body: payload({ agents: [{ ...agent, status: undefined }] } as never) },
      { name: "agents: [[]] — an array where an entry belongs", body: payload({ agents: [[]] } as never) },
      { name: "hostVerification: [null] — LaunchRow reads `entry.name || entry.launchId`", body: payload({ hostVerification: [null] } as never) },
      { name: "unassociated: [null] — the same rows, the host-level bucket", body: payload({ unassociated: [null] } as never) },
      {
        name: "a CI observation that is not an object",
        body: payload({ requiredCi: { state: "observed", label: "1 observed", observations: ["c0ffee"] } } as never),
      },
      {
        name: "a CI observation carrying no candidate sha",
        body: payload({ requiredCi: ciSection([{ ...observation(), candidateSha: "" }]) } as never),
      },
      // ── RF-5 — the same class one level deeper, inside an observation ──
      {
        name: "contexts: [null] — the reported RF-5 case, where ciContextRows reads `c.context`",
        body: payload({ requiredCi: ciSection([{ candidateSha: "a".repeat(40), contexts: [null] }]) } as never),
        defeatsEntryOnlyFix: true,
      },
      {
        name: "a null context alongside well-formed ones, in a fully populated observation",
        body: payload({ requiredCi: ciSection([observation({ contexts: [context("test", "pending"), null] as never })]) } as never),
        defeatsEntryOnlyFix: true,
      },
      {
        name: "a null context under the SECOND of two current candidates",
        body: payload({
          requiredCi: ciSection([
            observation({ ticketId: "FG-253" }),
            observation({ ticketId: "FG-679", attemptId: "attempt-2", contexts: [null] as never }),
          ]),
        } as never),
        defeatsEntryOnlyFix: true,
      },
      {
        name: "a context that is a string rather than an object",
        body: payload({ requiredCi: ciSection([observation({ contexts: ["test"] as never })]) } as never),
        defeatsEntryOnlyFix: true,
      },
      {
        name: "a context with no name — ciContextRows reads `c.context` and keys the row on it",
        body: payload({ requiredCi: ciSection([observation({ contexts: [{ state: "pending", url: null, observedAt: OBSERVED_AT }] as never })]) } as never),
        defeatsEntryOnlyFix: true,
      },
      {
        name: "a context with no state — the row renders it as its own text",
        body: payload({ requiredCi: ciSection([observation({ contexts: [{ context: "test", url: null, observedAt: OBSERVED_AT }] as never })]) } as never),
        defeatsEntryOnlyFix: true,
      },
      {
        name: "an observation with no contexts array at all — `CI not started` would be a claim about checks we never read",
        body: payload({ requiredCi: ciSection([{ ...observation(), contexts: undefined }]) } as never),
        defeatsEntryOnlyFix: true,
      },
      {
        name: "an observation whose contexts is an object rather than an array",
        body: payload({ requiredCi: ciSection([{ ...observation(), contexts: { test: "pending" } }]) } as never),
        defeatsEntryOnlyFix: true,
      },
    ];

    for (const { name, body, defeatsEntryOnlyFix } of MALFORMED) {
      test(`${name} → unavailable + retry, and none of the four claims`, async () => {
        assert.equal(containerOnlyAccepted(body), true, "NOT vacuous: the pre-fix container check accepted this body");
        if (defeatsEntryOnlyFix) {
          assert.equal(entryOnlyAccepted(body), true,
            "NOT vacuous against the PREVIOUS remediation either: entry-level validation accepted this body too");
        }
        assert.equal(isCurrentActivityPayload(body), false);

        // Through the shipping read path, not a hand-built load.
        const load = await readCurrentActivity(
          "/api/current-activity",
          (async () => stubResponse({ json: async () => body })) as never,
        );
        assert.equal(activityPhase(load), "unavailable");
        assert.equal((load as { reason: string }).reason, "malformed");

        const text = collapsed(load);
        assert.match(text, new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));
        for (const claim of OBSERVATION_CLAIMS) {
          assert.doesNotMatch(text, new RegExp(claim), `a malformed read may not claim "${claim}"`);
        }
        const buttons = elements(home(load)).filter((el) => el.type === "button");
        assert.equal(buttons.length, 1, "the operator can retry");
      });
    }

    test("a `ready` load holding a malformed payload renders the unavailable state rather than throwing", () => {
      // The other door into the renderer: a load object that claims `ready`. The phase
      // is re-derived from the payload, so the claim alone cannot get a bad entry into
      // a row — which is what makes this a rendered-output guarantee and not just a
      // property of the fetch path.
      const load = { phase: "ready", activity: payload({ agents: [null] } as never) };
      assert.equal(activityPhase(load), "unavailable");
      assert.doesNotThrow(() => collapsed(load));
      assert.match(collapsed(load), new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));
    });

    test("NOT vacuous: a payload whose entries are WELL formed still reaches `ready` and renders them", () => {
      const good = payload({
        agents: [agent],
        hostVerification: [launch],
        unassociated: [],
        requiredCi: { state: "observed", label: "1 observed", observations: [observation()] },
      });
      assert.equal(isCurrentActivityPayload(good), true);
      const text = collapsed({ phase: "ready", activity: good });
      assert.match(text, /frontend-specialist/);
      assert.match(text, /worktree-tier/);
      assert.match(text, /FG-253/);
    });

    test("an entry missing only COSMETIC fields is still a payload — the validator guards the crash surface, not a schema", () => {
      // `runTitle`, `phase`, `agentRole`, `projectLabel` render as nothing when absent.
      // Rejecting over those would turn tolerable drift from an older server into a
      // permanent error banner, which is the opposite of AC7's intent.
      const sparse = payload({ agents: [{ taskId: "task-1", status: "running" }] } as never);
      assert.equal(isCurrentActivityPayload(sparse), true);
      assert.doesNotThrow(() => collapsed({ phase: "ready", activity: sparse }));
    });

    test("a `ready` load holding the RF-5 shape renders the unavailable state rather than throwing in ciContextRows", () => {
      // The other door into the renderer, at the depth RF-5 found. `homeActivityView`
      // walked straight into `ciContextRows` and threw `Cannot read properties of null
      // (reading 'context')` before any of this rendered.
      const load = { phase: "ready", activity: payload({ requiredCi: ciSection([{ candidateSha: "a".repeat(40), contexts: [null] }]) } as never) };
      assert.equal(activityPhase(load), "unavailable");
      assert.doesNotThrow(() => homeActivityView(load));
      assert.doesNotThrow(() => collapsed(load));
      assert.match(collapsed(load), new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));
    });

    // ─────── the CLASS, generated from the contract rather than from bug reports ──────
    //
    // One test per entry kind the renderer walks into, driven by the SAME table the
    // validator is generated from. A field added to the contract is covered here the
    // moment it is added, which is the property RF-5 showed a hand-written case list
    // does not have.

    /** Where an entry of each kind sits in a payload. */
    const MOUNT: Record<string, (entry: unknown) => unknown> = {
      agent: (e) => payload({ agents: [e] } as never),
      launch: (e) => payload({ hostVerification: [e] } as never),
      ciObservation: (e) => payload({ requiredCi: ciSection([e]) } as never),
      ciContext: (e) => payload({ requiredCi: ciSection([observation({ contexts: [e] as never })]) } as never),
    };

    /** A well-formed entry of each kind, so every rejection below is shown to be caused
     *  by the one broken field and not by the fixture. */
    const WELL_FORMED: Record<string, () => Record<string, unknown>> = {
      agent: () => ({ ...agent }),
      launch: () => ({ ...launch }),
      ciObservation: () => ({ ...observation() }),
      ciContext: () => ({ ...context("test", "pending") }),
    };

    /** Values that break a field of each declared kind. */
    const BREAKS: Record<string, unknown[]> = {
      text: [undefined, null, "", 7, {}, []],
      string: [undefined, null, 7, {}, []],
      "ciContext[]": [undefined, null, 7, "test", {}, [null], ["test"], [{ state: "pending" }]],
    };

    /** The whole AC7 promise for one body, through the shipping read path. */
    const assertUnavailable = (body: unknown, because: string): void => {
      const load = activityFromBody(body);
      assert.equal(activityPhase(load), "unavailable", because);
      assert.equal((load as { reason: string }).reason, "malformed", because);
      const text = collapsed(load);
      assert.match(text, new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL), because);
      assert.equal(elements(home(load)).filter((el) => el.type === "button").length, 1, `${because} — and the operator can retry`);
      for (const claim of OBSERVATION_CLAIMS) assert.doesNotMatch(text, new RegExp(claim), `${because} — may not claim "${claim}"`);
      // The other door: a load that CLAIMS `ready` must not throw its way past the state.
      assert.doesNotThrow(() => collapsed({ phase: "ready", activity: body }), because);
    };

    for (const kind of Object.keys(RENDER_DEREFERENCE_CONTRACT)) {
      test(`RENDER_DEREFERENCE_CONTRACT.${kind} covers every field the renderer dereferences — breaking any one of them resolves to unavailable`, () => {
        const mount = MOUNT[kind]!;
        const wellFormed = WELL_FORMED[kind]!;

        // NOT vacuous, per kind: the same fixture, unbroken, is a payload that renders.
        assert.equal(isRenderableEntry(kind, wellFormed()), true, `the ${kind} fixture must itself be well formed`);
        assert.equal(isCurrentActivityPayload(mount(wellFormed())), true, `a well-formed ${kind} entry IS a payload`);
        assert.equal(activityPhase(activityFromBody(mount(wellFormed()))), "ready", `a well-formed ${kind} entry still reaches ready`);

        for (const notAnEntry of [null, undefined, 7, "entry", [], true]) {
          const body = mount(notAnEntry);
          assert.equal(isCurrentActivityPayload(body), false, `${kind}: ${String(notAnEntry)} is not an entry`);
          assertUnavailable(body, `${kind} entry ${String(notAnEntry)}`);
        }

        const fields = RENDER_DEREFERENCE_CONTRACT[kind as keyof typeof RENDER_DEREFERENCE_CONTRACT] as Record<string, string>;
        assert.ok(Object.keys(fields).length > 0, `${kind} declares no dereferenced field`);
        for (const [field, spec] of Object.entries(fields)) {
          const breaks = BREAKS[spec];
          assert.ok(breaks !== undefined, `no break values known for field kind "${spec}" — extend BREAKS alongside the contract`);
          for (const value of breaks!) {
            const body = mount({ ...wellFormed(), [field]: value });
            assert.equal(isCurrentActivityPayload(body), false, `${kind}.${field} = ${String(value)} must not validate`);
            assertUnavailable(body, `${kind}.${field} = ${String(value)}`);
          }
        }
      });
    }

    // ─────────────── the mechanism that is supposed to prevent the next RF-5 ───────────
    //
    // RF-5 was RF-3 one level deeper: the fix validated what the report named and the
    // renderer kept dereferencing one field further down. This test reads the render
    // source and requires every unguarded dereference to be accounted for — either the
    // contract validates it, or this table declares that it is read through a guard.
    // A new field read without validation fails HERE, at the commit that adds it.

    const SOURCE: Record<string, string> = {
      "current-activity-view.js": readFileSync(new URL("../client/current-activity-view.js", import.meta.url), "utf8"),
      "current-activity-render.js": readFileSync(new URL("../client/current-activity-render.js", import.meta.url), "utf8"),
    };

    function bodyOf(file: string, fn: string): string {
      const src = SOURCE[file]!;
      const start = src.indexOf(`function ${fn}(`);
      assert.notEqual(start, -1, `${file} no longer defines ${fn} — re-audit its dereferences against RENDER_DEREFERENCE_CONTRACT`);
      const end = src.indexOf("\n}", start);
      assert.notEqual(end, -1, `${file}: could not find the end of ${fn}`);
      return src.slice(start, end);
    }

    /** `isCurrentActivityPayload` validates these four at the payload level. */
    const PAYLOAD_VALIDATED = ["agents", "hostVerification", "requiredCi", "unassociated"];

    const validatedFields = (kind: string): string[] =>
      kind === "payload"
        ? PAYLOAD_VALIDATED
        : Object.keys(RENDER_DEREFERENCE_CONTRACT[kind as keyof typeof RENDER_DEREFERENCE_CONTRACT]);

    /** Every place the render path walks into payload data, and what it reads there.
     *  `guarded` is the explicit claim "this one cannot crash and may legitimately be
     *  absent" — a type check, a `||` fallback, or a plain text interpolation. */
    const AUDIT: Array<{ file: string; fn: string; receiver: string; kind: string; guarded: string[] }> = [
      { file: "current-activity-view.js", fn: "CurrentActivityBlock", receiver: "a", kind: "agent", guarded: [] },
      { file: "current-activity-view.js", fn: "CurrentActivityBlock", receiver: "l", kind: "launch", guarded: [] },
      { file: "current-activity-view.js", fn: "AgentRow", receiver: "entry", kind: "agent",
        guarded: ["agentRole", "runTitle", "phase", "projectLabel", "startedAt"] },
      { file: "current-activity-view.js", fn: "LaunchRow", receiver: "entry", kind: "launch",
        guarded: ["name", "commandLine", "observedAt", "startedAt"] },
      { file: "current-activity-view.js", fn: "ciRowKey", receiver: "o", kind: "ciObservation", guarded: ["attemptId"] },
      { file: "current-activity-view.js", fn: "RequiredCiRow", receiver: "observation", kind: "ciObservation",
        guarded: ["observedAt", "unavailableReason"] },
      { file: "current-activity-render.js", fn: "ciContextRows", receiver: "observation", kind: "ciObservation", guarded: [] },
      { file: "current-activity-render.js", fn: "ciContextRows", receiver: "c", kind: "ciContext",
        guarded: ["url", "observedAt"] },
      { file: "current-activity-render.js", fn: "ciCompactSummary", receiver: "o", kind: "ciObservation",
        guarded: ["state", "outcome", "unavailableReason", "label"] },
      { file: "current-activity-render.js", fn: "ciCandidateLabel", receiver: "observation", kind: "ciObservation",
        guarded: ["ticketId"] },
      { file: "current-activity-render.js", fn: "launchBadgeClass", receiver: "entry", kind: "launch",
        guarded: ["observation", "status"] },
      { file: "current-activity-render.js", fn: "launchBadgeText", receiver: "entry", kind: "launch", guarded: ["statusLabel"] },
      { file: "current-activity-render.js", fn: "launchAssociationLabel", receiver: "entry", kind: "launch", guarded: ["unassociated"] },
      { file: "current-activity-render.js", fn: "launchIdentityLine", receiver: "entry", kind: "launch",
        guarded: ["runId", "taskId", "ticketId", "campaignId", "projectLabel"] },
      { file: "current-activity-render.js", fn: "homeActivityView", receiver: "activity", kind: "payload", guarded: [] },
      { file: "current-activity-render.js", fn: "homeInFlightActivity", receiver: "activity", kind: "payload", guarded: [] },
      { file: "current-activity-render.js", fn: "launchIsCurrentWait", receiver: "entry", kind: "launch",
        guarded: ["observation", "status"] },
      { file: "current-activity-render.js", fn: "launchWaitIdentity", receiver: "e", kind: "launch",
        guarded: ["ticketId", "name"] },
      { file: "current-activity-view.js", fn: "HostWaitRow", receiver: "entry", kind: "launch", guarded: ["startedAt"] },
    ];

    test("every field the render path dereferences is either validated by the contract or declared guarded", () => {
      for (const row of AUDIT) {
        const body = bodyOf(row.file, row.fn);
        const read = new Set<string>();
        for (const match of body.matchAll(new RegExp(`\\b${row.receiver}\\.([A-Za-z_$][\\w$]*)`, "g"))) read.add(match[1]!);
        assert.ok(read.size > 0,
          `${row.file} ${row.fn}: no \`${row.receiver}.\` dereference found — this audit row is stale and is proving nothing`);

        const accounted = new Set([...validatedFields(row.kind), ...row.guarded]);
        const unaudited = [...read].filter((field) => !accounted.has(field));
        assert.deepEqual(unaudited, [],
          `${row.file} ${row.fn} reads ${row.receiver}.${unaudited[0]} off a ${row.kind} that no one validated. `
          + `A field dereferenced without validation is exactly how RF-5 appeared one level below RF-3: it renders `
          + `until a payload omits it, and then it throws instead of showing the unavailable state. Either add it to `
          + `RENDER_DEREFERENCE_CONTRACT.${row.kind}, or read it through a guard and list it as guarded here.`);
      }
    });

    test("the audit table itself is honest — a guarded field really is absent-tolerant", () => {
      // Otherwise the table would be a way to silence the audit rather than satisfy it.
      // Every field DECLARED guarded is stripped from a well-formed payload at once, and
      // the surface must still validate and still render.
      const strip = (entry: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
        const out = { ...entry };
        for (const field of fields) delete out[field];
        return out;
      };
      const guardedFor = (kind: string): string[] =>
        [...new Set(AUDIT.filter((row) => row.kind === kind).flatMap((row) => row.guarded))];

      const stripped = payload({
        agents: [strip({ ...agent }, guardedFor("agent"))],
        hostVerification: [strip({ ...launch }, guardedFor("launch"))],
        requiredCi: ciSection([
          strip({ ...observation({ contexts: [strip({ ...context("test", "pending") }, guardedFor("ciContext"))] as never }) },
            guardedFor("ciObservation")),
        ]),
      } as never);

      assert.equal(isCurrentActivityPayload(stripped), true, "a guarded field must be optional in fact, not only by declaration");
      const text = collapsed({ phase: "ready", activity: stripped });
      assert.doesNotMatch(text, new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));
      assert.match(text, /task-build-aef6ae/, "the agent row still renders");
      assert.match(text, /launch-worktree-8pagjk/, "the launch row still renders");
    });

    test("NOT vacuous at depth: a payload whose contexts are ALL well formed reaches ready and keeps its per-context evidence", () => {
      const good = payload({
        agents: [agent],
        hostVerification: [launch],
        requiredCi: ciSection([sevenOfTen]),
      } as never);
      assert.equal(isCurrentActivityPayload(good), true);
      assert.equal(activityPhase(activityFromBody(good)), "ready");
      const load = activityFromBody(good);
      assert.match(collapsed(load), /CI running/);
      assert.match(collapsed(load), /7\/10 complete/);
      assert.equal(withClass(home(load), "ca-ci-context").length, 10, "every context survives the tightened validation");
      assert.match(opened(load), /check-0/);
    });

    test("a context with an EMPTY state string is still a payload — the observer may report one", () => {
      // `parseContexts` in src/v2/current-activity.ts passes an empty `context` name
      // through, and defaults an unreadable state to a string. Neither can crash the row,
      // so neither may turn a readable dashboard into a permanent error banner.
      const empties = payload({
        requiredCi: ciSection([observation({ contexts: [{ context: "", state: "", url: null, observedAt: "" }] as never })]),
      } as never);
      assert.equal(isCurrentActivityPayload(empties), true);
      assert.equal(activityPhase(activityFromBody(empties)), "ready");
    });

    test("an observation with an EMPTY contexts array is still a payload — that is `CI not started`, an observed fact", () => {
      const none = payload({ requiredCi: ciSection([observation({ contexts: [], state: "not_running", outcome: "success" })]) } as never);
      assert.equal(isCurrentActivityPayload(none), true);
      assert.match(collapsed(activityFromBody(none)), new RegExp(CI_NOT_STARTED_LABEL));
    });
  });

  // ─── RF-2 / RF-4: the poll must let a read finish saying what happened to it ───
  //
  // One defect from two sides. RF-4: a HUNG request never reached the unavailable
  // timeout state, because the poll started a NEW sequenced read every 2s while the read
  // timeout is 8s, so every read was superseded before its own timeout could be applied.
  // RF-2 is the steady state of the same thing: ANY response slower than the poll
  // interval can never apply its result — success, timeout or unavailable — so Home stays
  // in `loading` forever. AC7 names an initial load that never answers as a case that MUST
  // render the explicit unavailable state with its Retry, and a permanent `loading`
  // renders neither that banner nor the activity.
  //
  // WHY THERE IS NO CLOCK HERE. The defect is about ORDER — a poll tick landing while a
  // read is in flight — not about durations, and the unit tier may not sleep on a real
  // clock. So each fetch returns a promise this suite settles BY HAND: the poll ticks are
  // the synchronous `poll()` calls, and "the request finally answered" is a `settle()`.
  // Everything from the response (or the AbortError the internal timer raises at
  // CURRENT_ACTIVITY_TIMEOUT_MS) to the load state is still the shipped
  // `readCurrentActivity` — only WHEN the answer arrives is the test's to choose. That
  // the internal timer exists, and fires, is what the `never answers` mode above pins.
  describe("FG-694 AC7 (RF-2/RF-4) — a read slower than the poll interval still lands", () => {
    const URL = "/api/current-activity";
    const ABORTED = Object.assign(new Error("aborted"), { name: "AbortError" });

    /** A fetch whose every call hangs until this suite answers it. `settle(i, …)` plays
     *  the answer the browser would eventually get — including the AbortError the read's
     *  own timeout raises on a request that never came back. */
    function hangingFetch() {
      const calls: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
      const fetchImpl = (): Promise<unknown> => new Promise((resolve, reject) => {
        calls.push({ resolve, reject });
      });
      return {
        calls,
        read: (url: string) => readCurrentActivity(url, fetchImpl as never),
        timeout: (i: number) => calls[i]!.reject(ABORTED),
        answer: (i: number, body: unknown) => calls[i]!.resolve({ ok: true, status: 200, json: async () => body }),
      };
    }

    test("NOT vacuous: the PRE-FIX loop — a new sequenced read every tick — drops the answer when it comes", async () => {
      // main.js:114 as it shipped: increment a sequence, start a read, accept the result
      // only while it owns the newest sequence. Four ticks pass while read #0 is still in
      // flight, so by the time its timeout lands it has been superseded three times over.
      const net = hangingFetch();
      const applied: unknown[] = [];
      let seq = 0;
      const reads: Array<Promise<void>> = [];
      for (let i = 0; i < 4; i++) {
        const mine = ++seq;
        reads.push(net.read(URL).then((load) => { if (mine === seq) applied.push(load); }));
      }
      assert.equal(net.calls.length, 4, "the pre-fix loop starts a read per tick");

      net.timeout(0);
      await reads[0];
      assert.deepEqual(applied, [], "the hung read's timeout is discarded — this IS the permanent `loading`");

      // …and `loading` shows the operator neither the activity nor the AC7 banner.
      const text = collapsed(ACTIVITY_LOADING);
      assert.doesNotMatch(text, new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));
      assert.equal(elements(home(ACTIVITY_LOADING)).filter((el) => el.type === "button").length, 0, "no Retry either");
    });

    test("RF-4: a HUNG request reaches `Current activity unavailable` with its Retry, and claims none of the four", async () => {
      const net = hangingFetch();
      const applied: unknown[] = [];
      const reader = createActivityReader((load) => applied.push(load), net.read);

      const inFlight = reader.poll(URL);
      for (let i = 0; i < 3; i++) {
        assert.equal(reader.poll(URL), null, "a tick over a read in flight must not supersede it");
      }
      net.timeout(0);
      await inFlight;

      assert.equal(applied.length, 1, "the hung read's own timeout lands, rather than being cancelled by its successor");
      const load = applied[0];
      assert.equal(activityPhase(load), "unavailable");
      assert.equal((load as { reason: string }).reason, "timeout");

      const text = collapsed(load);
      assert.match(text, new RegExp(CURRENT_ACTIVITY_UNAVAILABLE_LABEL));
      for (const claim of OBSERVATION_CLAIMS) {
        assert.doesNotMatch(text, new RegExp(claim), `a timed-out read may not claim "${claim}"`);
      }
      const buttons = elements(home(load)).filter((el) => el.type === "button");
      assert.equal(buttons.length, 1, "the operator's only recovery must not be a page reload");
    });

    test("RF-2: a SLOW but successful response applies its payload instead of being superseded forever", async () => {
      const net = hangingFetch();
      const applied: unknown[] = [];
      const reader = createActivityReader((load) => applied.push(load), net.read);

      const inFlight = reader.poll(URL);
      for (let i = 0; i < 5; i++) reader.poll(URL);
      net.answer(0, payload({ agents: [agent] }));
      await inFlight;

      assert.equal(applied.length, 1, "a response slower than the poll interval still reaches the surface");
      assert.equal(activityPhase(applied[0]), "ready");
      assert.match(collapsed(applied[0]), /frontend-specialist/);
    });

    test("one read per URL is in flight — six ticks over one slow read make ONE request, not six", async () => {
      const net = hangingFetch();
      const reader = createActivityReader(() => {}, net.read);
      const first = reader.poll(URL);
      for (let i = 0; i < 5; i++) reader.poll(URL);
      assert.equal(net.calls.length, 1);

      // …and once it has answered, the next tick reads again: this throttles the read, it
      // does not stop it. A surface that polled once and never again would be its own bug.
      net.answer(0, payload());
      await first;
      reader.poll(URL);
      assert.equal(net.calls.length, 2);
    });

    test("a SCOPE change is a different read and does supersede — the old scope's answer may not win", async () => {
      const net = hangingFetch();
      const applied: unknown[] = [];
      const reader = createActivityReader((load) => applied.push(load), net.read);

      const first = reader.poll(URL);
      const second = reader.poll(`${URL}?project=b`);
      assert.equal(net.calls.length, 2, "a new scope is not the read already in flight");

      // The superseded scope answers LAST, which is exactly the race the sequence token
      // exists for: its payload may not overwrite the scope the operator is now looking at.
      net.answer(1, payload());
      net.answer(0, payload({ agents: [agent] }));
      await Promise.all([first, second]);

      assert.equal(applied.length, 1, "the superseded scope's read is dropped, not applied over the new one");
      assert.match(collapsed(applied[0]), new RegExp(NOTHING_RUNNING_LABEL.replace(".", "\\.")));
      assert.doesNotMatch(collapsed(applied[0]), /frontend-specialist/, "the old scope's agents are not the new scope's");
    });

    test("Retry supersedes an in-flight read, and shows `loading` while the fresh one runs", async () => {
      const net = hangingFetch();
      const applied: unknown[] = [];
      const reader = createActivityReader((load) => applied.push(load), net.read);

      reader.poll(URL);
      const retried = reader.retry(URL);
      assert.equal(activityPhase(applied[0]), "loading", "the failure copy does not linger over a read already in flight");
      assert.equal(net.calls.length, 2, "Retry always starts a fresh read");

      net.timeout(1);
      await retried;
      assert.equal(activityPhase(applied[applied.length - 1]), "unavailable", "and the retried read still reaches a verdict");
    });
  });

  test("the payload validator accepts an OLDER server's payload and rejects a non-payload", () => {
    // A server that predates FG-694 has only two `requiredCi.state` values. Rejecting
    // it would turn a working dashboard into a permanent error banner.
    assert.equal(isCurrentActivityPayload(payload({ requiredCi: { state: "not_observed", label: "CI not observed", observations: [] } })), true);
    for (const notAPayload of [null, undefined, "", 0, [], {}, { agents: [] }, { agents: [], hostVerification: [] },
      { agents: [], hostVerification: [], requiredCi: {} },
      { agents: {}, hostVerification: [], requiredCi: { state: "observed", observations: [] } }]) {
      assert.equal(isCurrentActivityPayload(notAPayload), false, `${JSON.stringify(notAPayload)} is not a payload`);
    }
    assert.equal(activityPhase(activityFromBody("<html>502 Bad Gateway</html>")), "unavailable");
  });
});
