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
import { h } from "preact";
import {
  ACTIVITY_LOADING,
  CI_FAILED_LABEL,
  CI_NOT_STARTED_LABEL,
  CI_PASSED_LABEL,
  CI_RUNNING_LABEL,
  CI_STATUS_UNAVAILABLE_LABEL,
  CURRENT_ACTIVITY_UNAVAILABLE_LABEL,
  NOTHING_RUNNING_LABEL,
  OBSERVATION_CLAIMS,
  activityFromBody,
  activityPhase,
  activityUnavailable,
  ciCompactSummary,
  homeActivityView,
  homeCiSummaries,
  isCurrentActivityPayload,
  readCurrentActivity,
} from "../client/current-activity-render.js";
import { CurrentActivitySection } from "../client/current-activity-view.js";
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

  // ── RF-3: a structurally malformed ENTRY is a failed read, not renderable data ──
  //
  // The container check alone said `ready` for a 200 whose `agents` array held a
  // `null`, and the render then threw building the row — showing the operator neither
  // the activity nor the unavailable state with its Retry. AC7 enumerates exactly this
  // case, so the validator has to reject the entries, not just their containers.
  describe("FG-694 AC7 (RF-3) — malformed entries resolve to `unavailable`, never to a thrown render", () => {
    /** The PRE-FIX rule, restated, so each fixture below is shown to be non-vacuous:
     *  every one of them is a body the shipped validator called `ready`. */
    const containerOnlyAccepted = (v: unknown): boolean => {
      const o = v as Record<string, unknown> | null;
      if (!o || typeof o !== "object" || Array.isArray(o)) return false;
      if (!Array.isArray(o.agents) || !Array.isArray(o.hostVerification)) return false;
      const ci = o.requiredCi as Record<string, unknown> | undefined;
      if (!ci || typeof ci !== "object" || Array.isArray(ci)) return false;
      if (typeof ci.state !== "string" || ci.state === "") return false;
      return Array.isArray(ci.observations);
    };

    const MALFORMED: Array<{ name: string; body: unknown }> = [
      { name: "agents: [null] — the reported case; the row build reads `a.taskId`", body: payload({ agents: [null] } as never) },
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
        body: payload({ requiredCi: { state: "observed", label: "1 observed", observations: [{ ...observation(), candidateSha: "" }] } } as never),
      },
    ];

    for (const { name, body } of MALFORMED) {
      test(`${name} → unavailable + retry, and none of the four claims`, async () => {
        assert.equal(containerOnlyAccepted(body), true, "NOT vacuous: the pre-fix container check accepted this body");
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
