// FG-694 (wave A): which CI observations are CURRENT.
//
// FG-679 established the shared derivation and its honesty vocabulary. It selected
// the newest `review_loop.ci_observed` per (run_id, project_dir) pair among the last
// 500 events and stopped there. "Newest for its pair" was never a claim of currency:
// a pair whose run finished months ago has a newest row FOREVER, so on 2026-08-08
// Home rendered stale CI blocks for FG-686, FG-576, MG-51, FG-591, FG-689, FG-584,
// FG-685, FG-610, FG-655 and FG-684 simultaneously, ten check rows apiece — historical
// verification evidence under the heading `Current activity`.
//
// What this suite pins:
//   AC1  many stale observations for terminal runs + ONE active run with pending CI
//        ⇒ the derivation (and therefore `forge status`) returns ONLY the active one
//   AC2  terminal runs/reviews are excluded EVEN WHEN newest for their pair — the
//        load-bearing one, since the newest-per-pair rule is what kept them alive
//   AC3  a candidate that advances leaves nothing behind: no carry-forward, and no
//        older row promoted into a rejected pair's slot
//   AC9  one derivation feeds both surfaces, so the rendered `forge status` text and
//        the API payload name the SAME candidates by construction
//   AC10 the serving path is read-only and makes NO outbound call — asserted, not
//        asserted-in-prose
//
// And the trap the ticket names explicitly: `no current candidate` and `we observed
// no CI` are two DIFFERENT absences. Collapsing them is the same class of error as
// the bug being fixed, pointed the other way — one invents currency, the other
// invents an observation.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import * as dc from "node:diagnostics_channel";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, makeInMemoryDb } from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { REVIEW_STATES, REVIEW_STATE_TERMINALITY, isTerminalReviewState } from "../store/reviews.js";
import {
  CI_NOT_OBSERVED_LABEL,
  CI_NO_CANDIDATE_LABEL,
  CI_OBSERVATION_FRESH_MS,
  CI_OBSERVED_EVENT_TYPE,
  CI_RUNNING_LABEL,
  deriveCurrentActivity,
  renderCurrentActivityLines,
} from "./current-activity.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const NOW = new Date("2026-08-08T12:00:00.000Z");
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

function addRun(id: string, status: string, projectDir: string | null = PROJECT): void {
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, ?, ?, ?)`)
    .run(id, `run ${id}`, status, ago(7 * 24 * 3_600_000), projectDir);
}

function addReview(opts: {
  id: string;
  state: string;
  runId?: string | null;
  ticketId?: string | null;
  workspaceDir?: string | null;
}): void {
  db.prepare(`
    INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(opts.id, opts.runId ?? null, opts.ticketId ?? null, opts.workspaceDir ?? null, opts.state, ago(3_600_000), ago(60_000));
}

/** Ten required contexts, the shape the 2026-08-08 report showed ten times over. */
function contexts(state: string, at: string): Array<Record<string, unknown>> {
  return Array.from({ length: 10 }, (_v, i) => ({
    context: `check-${i}`,
    state,
    url: `https://github.com/o/r/actions/runs/${i}`,
    observedAt: at,
  }));
}

function addCi(opts: {
  runId: string | null;
  ticketId: string | null;
  sha: string;
  observedAt: string;
  outcome?: string;
  contextState?: string;
  projectDir?: string | null;
}): void {
  const payload = {
    attemptId: `attempt-${opts.ticketId ?? "none"}`,
    ticketId: opts.ticketId,
    projectDir: opts.projectDir === undefined ? PROJECT : opts.projectDir,
    candidateSha: opts.sha,
    observedAt: opts.observedAt,
    outcome: opts.outcome ?? "pending",
    unavailableReason: null,
    contexts: contexts(opts.contextState ?? "pending", opts.observedAt),
  };
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`)
    .run(opts.runId, CI_OBSERVED_EVENT_TYPE, JSON.stringify(payload), opts.observedAt);
}

/** The PRE-FIX selection rule, restated verbatim so the fixtures below can be shown
 *  to be non-vacuous: they must produce a DIFFERENT answer under this than under the
 *  derivation. Without this, "only the active run's observation is returned" would
 *  pass just as happily against a fixture that never contained anything else. */
function legacyNewestPerPair(handle: DatabaseInstance): Array<{ runId: string | null; candidateSha: string }> {
  const rows = handle.prepare(`
    SELECT run_id, payload FROM events WHERE event_type = ? ORDER BY created_at DESC, id DESC LIMIT 500
  `).all(CI_OBSERVED_EVENT_TYPE) as Array<{ run_id: string | null; payload: string }>;
  const newest = new Map<string, { runId: string | null; candidateSha: string }>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { projectDir?: unknown; candidateSha?: unknown };
    const projectDir = typeof payload.projectDir === "string" ? payload.projectDir : null;
    const key = `${row.run_id ?? ""} ${projectDir ?? ""}`;
    if (newest.has(key)) continue;
    if (typeof payload.candidateSha !== "string" || payload.candidateSha === "") continue;
    newest.set(key, { runId: row.run_id, candidateSha: payload.candidateSha });
  }
  return [...newest.values()];
}

/** The reported defect, rebuilt: ten finished runs whose last CI observation is still
 *  the newest for its own pair, plus ONE active run genuinely waiting on checks. */
const HISTORICAL = ["FG-686", "FG-576", "MG-51", "FG-591", "FG-689", "FG-584", "FG-685", "FG-610", "FG-655", "FG-684"];
const TERMINAL_STATUSES = ["complete", "failed", "abandoned"];
const CURRENT_SHA = "c".repeat(40);
const historicalSha = (i: number): string => `${i}`.repeat(2).padEnd(40, "a");

function seedTheReportedShape(): void {
  HISTORICAL.forEach((ticket, i) => {
    const runId = `run-${ticket.toLowerCase()}`;
    addRun(runId, TERMINAL_STATUSES[i % TERMINAL_STATUSES.length]!);
    // A settled review, exactly as a finished round leaves behind.
    addReview({ id: `review-${ticket}`, state: "settled", runId, ticketId: ticket, workspaceDir: PROJECT });
    addCi({ runId, ticketId: ticket, sha: historicalSha(i), observedAt: ago(2 * 3_600_000 + i * 60_000) });
  });
  addRun("run-fg694", "active");
  addReview({ id: "review-FG-694", state: "verifying", runId: "run-fg694", ticketId: "FG-694", workspaceDir: PROJECT });
  addCi({ runId: "run-fg694", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });
}

describe("FG-694 AC1/AC2 — only work that is still open is current", () => {
  test("the fixture is NON-VACUOUS: the pre-fix newest-per-pair rule returns all eleven", () => {
    seedTheReportedShape();
    const legacy = legacyNewestPerPair(db);
    assert.equal(legacy.length, 11, "the pre-fix rule keeps every terminal run's newest row");
    for (const ticket of HISTORICAL) {
      assert.ok(legacy.some((o) => o.runId === `run-${ticket.toLowerCase()}`), `${ticket} survives the pre-fix rule`);
    }
  });

  test("AC1: with ten stale terminal observations and one active run with pending CI, ONLY the active run's observation is returned", () => {
    seedTheReportedShape();
    const activity = deriveCurrentActivity(db, { now: NOW });

    assert.equal(activity.requiredCi.observations.length, 1);
    const obs = activity.requiredCi.observations[0]!;
    assert.equal(obs.runId, "run-fg694");
    assert.equal(obs.candidateSha, CURRENT_SHA);
    assert.equal(obs.state, "running");
    assert.equal(obs.label, CI_RUNNING_LABEL);
    assert.equal(activity.requiredCi.state, "observed");
  });

  test("AC2: each terminal disposition is excluded even though its row is the newest for its pair", () => {
    for (const status of TERMINAL_STATUSES) {
      addRun(`run-${status}`, status);
      addCi({ runId: `run-${status}`, ticketId: `FG-${status}`, sha: status.padEnd(40, "0"), observedAt: ago(60_000) });
    }
    addRun("run-live", "active");
    addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(60_000) });

    // Every one of them is the newest row for its own pair — that is precisely why
    // the pre-fix rule kept them.
    assert.equal(legacyNewestPerPair(db).length, 4);
    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.map((o) => o.runId),
      ["run-live"],
    );
  });

  test("AC2: a FRESH observation on a terminal run is excluded too — currency is about the work, not the timestamp", () => {
    // The observer's last poll landed seconds before the run was marked complete, so
    // this row is inside the freshness cutoff. It is still history.
    addRun("run-just-finished", "complete");
    addCi({ runId: "run-just-finished", ticketId: "FG-686", sha: "a".repeat(40), observedAt: ago(5_000) });
    addRun("run-live", "active");
    addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(5_000) });

    const observations = deriveCurrentActivity(db, { now: NOW }).requiredCi.observations;
    assert.deepEqual(observations.map((o) => o.candidateSha), [CURRENT_SHA]);
  });

  test("AC2: an OPEN review keeps its observation current even after its run row is closed", () => {
    // The other half of the contract — "active run OR open review". A run that
    // completed while its review is still verifying has not finished being reviewed.
    addRun("run-closed", "complete");
    addReview({ id: "review-open", state: "rechecking", runId: "run-closed", ticketId: "FG-694", workspaceDir: PROJECT });
    addCi({ runId: "run-closed", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });

    const observations = deriveCurrentActivity(db, { now: NOW }).requiredCi.observations;
    assert.deepEqual(observations.map((o) => o.candidateSha), [CURRENT_SHA]);
  });

  test("a review in a TERMINAL state does not keep a closed run's observation alive", () => {
    addRun("run-closed", "complete");
    addReview({ id: "review-settled", state: "settled", runId: "run-closed", ticketId: "FG-686", workspaceDir: PROJECT });
    addRun("run-closed-2", "failed");
    addReview({ id: "review-failed", state: "failed", runId: "run-closed-2", ticketId: "FG-576", workspaceDir: PROJECT });
    addCi({ runId: "run-closed", ticketId: "FG-686", sha: "a".repeat(40), observedAt: ago(30_000) });
    addCi({ runId: "run-closed-2", ticketId: "FG-576", sha: "b".repeat(40), observedAt: ago(30_000) });

    assert.equal(legacyNewestPerPair(db).length, 2, "both are newest-for-pair");
    assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 0);
  });

  test("a stuck review (`blocked_environment`) is OPEN, not terminal — it is stuck, not over", () => {
    addRun("run-blocked", "complete");
    addReview({ id: "review-blocked", state: "blocked_environment", runId: "run-blocked", ticketId: "FG-694", workspaceDir: PROJECT });
    addCi({ runId: "run-blocked", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });
    assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 1);
  });

  test("a run-scoped read of a FINISHED run returns nothing rather than its last observation", () => {
    addRun("run-done", "complete");
    addCi({ runId: "run-done", ticketId: "FG-686", sha: "a".repeat(40), observedAt: ago(30_000) });
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-done" } });
    assert.equal(activity.requiredCi.observations.length, 0);
  });

  test("a project-scoped read excludes another project's active run AND its own finished ones", () => {
    addRun("run-here-old", "complete", PROJECT);
    addCi({ runId: "run-here-old", ticketId: "FG-686", sha: "a".repeat(40), observedAt: ago(30_000) });
    addRun("run-there", "active", OTHER_PROJECT);
    addCi({ runId: "run-there", ticketId: "FG-700", sha: "b".repeat(40), observedAt: ago(30_000), projectDir: OTHER_PROJECT });
    addRun("run-here-live", "active", PROJECT);
    addCi({ runId: "run-here-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });

    const here = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.deepEqual(here.requiredCi.observations.map((o) => o.candidateSha), [CURRENT_SHA]);
  });
});

describe("FG-694 AC2 — observations with no declared run are anchored by an OPEN review", () => {
  test("a standalone review-loop round (no run id) is current while its review is open", () => {
    addReview({ id: "review-standalone", state: "verifying", runId: null, ticketId: "FG-694", workspaceDir: PROJECT });
    addCi({ runId: null, ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });
    const observations = deriveCurrentActivity(db, { now: NOW }).requiredCi.observations;
    assert.deepEqual(observations.map((o) => o.candidateSha), [CURRENT_SHA]);
    assert.equal(observations[0]!.runId, null);
  });

  test("the same round is history once its review settles", () => {
    addReview({ id: "review-standalone", state: "settled", runId: null, ticketId: "FG-694", workspaceDir: PROJECT });
    addRun("run-other-live", "active", OTHER_PROJECT); // something is open, so this is not the empty case
    addCi({ runId: null, ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });
    assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 0);
  });

  test("an open review in a DIFFERENT workspace does not adopt this project's observation", () => {
    addReview({ id: "review-elsewhere", state: "verifying", runId: null, ticketId: "FG-694", workspaceDir: OTHER_PROJECT });
    addCi({ runId: null, ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000), projectDir: PROJECT });
    assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 0);
  });

  test("an observation naming no ticket and no run has no anchor at all, and is not current", () => {
    addRun("run-live", "active");
    addReview({ id: "review-open", state: "verifying", runId: "run-live", ticketId: "FG-694", workspaceDir: PROJECT });
    addCi({ runId: null, ticketId: null, sha: "a".repeat(40), observedAt: ago(30_000) });
    assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 0);
  });
});

describe("FG-694 AC3 — an advanced candidate leaves nothing behind", () => {
  test("only the current candidate appears; the superseded sha is absent from the API and from the rendered surface", () => {
    addRun("run-live", "active");
    addCi({ runId: "run-live", ticketId: "FG-694", sha: "a".repeat(40), observedAt: ago(20 * 60_000) });
    addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });

    const activity = deriveCurrentActivity(db, { now: NOW });
    assert.deepEqual(activity.requiredCi.observations.map((o) => o.candidateSha), [CURRENT_SHA]);
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.doesNotMatch(rendered, new RegExp("a".repeat(40)));
    assert.match(rendered, new RegExp(CURRENT_SHA));
  });

  test("the OLD candidate is not retained as a stale row once its own run finishes and a new run picks the ticket up", () => {
    // The 2026-08-08 shape at ticket granularity: the same ticket, re-run. The first
    // attempt's observation is past the freshness cutoff, which pre-fix is exactly
    // when it rendered as a `stale` row of its own alongside the live one.
    addRun("run-attempt-1", "failed");
    addCi({ runId: "run-attempt-1", ticketId: "FG-694", sha: "a".repeat(40), observedAt: ago(CI_OBSERVATION_FRESH_MS + 60_000) });
    addRun("run-attempt-2", "active");
    addCi({ runId: "run-attempt-2", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });

    assert.equal(legacyNewestPerPair(db).length, 2, "pre-fix, the failed attempt is retained as a second row");
    const observations = deriveCurrentActivity(db, { now: NOW }).requiredCi.observations;
    assert.deepEqual(observations.map((o) => o.candidateSha), [CURRENT_SHA]);
    assert.equal(observations.some((o) => o.state === "stale"), false);
  });

  test("a pair whose newest row is history contributes NOTHING — an older row is never promoted into its slot", () => {
    // Both rows share the (no run, project) pair. The newest belongs to a settled
    // review; the one behind it belongs to an open one. Promoting the older row would
    // carry a superseded candidate forward under a fresher label, which is the
    // carry-forward AC3 forbids — so the pair is decided by its newest row and closed.
    addReview({ id: "review-settled", state: "settled", runId: null, ticketId: "FG-686", workspaceDir: PROJECT });
    addReview({ id: "review-open", state: "verifying", runId: null, ticketId: "FG-694", workspaceDir: PROJECT });
    addCi({ runId: null, ticketId: "FG-694", sha: "a".repeat(40), observedAt: ago(20 * 60_000) });
    addCi({ runId: null, ticketId: "FG-686", sha: "b".repeat(40), observedAt: ago(30_000) });

    const activity = deriveCurrentActivity(db, { now: NOW });
    assert.equal(activity.requiredCi.observations.length, 0);
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.doesNotMatch(rendered, new RegExp("a".repeat(40)), "the older candidate is not promoted");
    assert.doesNotMatch(rendered, new RegExp("b".repeat(40)), "the settled candidate is not retained");
  });
});

describe("FG-694 — two absences, kept distinguishable", () => {
  test("NO current candidate: the section says so, and never that CI was not observed", () => {
    addRun("run-done", "complete");
    addCi({ runId: "run-done", ticketId: "FG-686", sha: "a".repeat(40), observedAt: ago(30_000) });

    const activity = deriveCurrentActivity(db, { now: NOW });
    assert.equal(activity.requiredCi.state, "no_current_candidate");
    assert.equal(activity.requiredCi.label, CI_NO_CANDIDATE_LABEL);
    assert.notEqual(CI_NO_CANDIDATE_LABEL, CI_NOT_OBSERVED_LABEL);
    const rendered = renderCurrentActivityLines(activity).join("\n");
    assert.doesNotMatch(rendered, /CI not observed/, "nothing was owed an observation, so none was missed");
    assert.match(rendered, /\(no current CI candidate\)/);
  });

  test("a current candidate with NO observation still reads `CI not observed` — the FG-679 fact, unchanged", () => {
    addRun("run-live", "active");
    const activity = deriveCurrentActivity(db, { now: NOW });
    assert.equal(activity.requiredCi.state, "not_observed");
    assert.equal(activity.requiredCi.label, CI_NOT_OBSERVED_LABEL);
    assert.match(renderCurrentActivityLines(activity).join("\n"), /CI not observed/);
  });

  test("an OPEN REVIEW alone is a current candidate — `not_observed`, not `no_current_candidate`", () => {
    addReview({ id: "review-open", state: "discovering", runId: null, ticketId: "FG-694", workspaceDir: PROJECT });
    assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.state, "not_observed");
  });

  test("the three states are three DISTINCT labels", () => {
    const labels = new Set([CI_NO_CANDIDATE_LABEL, CI_NOT_OBSERVED_LABEL, CI_RUNNING_LABEL]);
    assert.equal(labels.size, 3);
  });

  test("scope decides currency: an active run in ANOTHER project does not make this project's empty scope look occupied", () => {
    addRun("run-elsewhere", "active", OTHER_PROJECT);
    const here = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.equal(here.requiredCi.state, "no_current_candidate");
    const there = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [OTHER_PROJECT] } });
    assert.equal(there.requiredCi.state, "not_observed");
  });
});

describe("FG-694 AC9 — one derivation, so both surfaces select the same thing", () => {
  test("the shas `forge status` prints are exactly the shas the API payload carries", () => {
    seedTheReportedShape();
    const activity = deriveCurrentActivity(db, { now: NOW });
    const rendered = renderCurrentActivityLines(activity).join("\n");

    const printed = new Set([...rendered.matchAll(/\b[0-9a-f]{40}\b/g)].map((m) => m[0]!));
    const carried = new Set(activity.requiredCi.observations.map((o) => o.candidateSha));
    assert.deepEqual([...printed].sort(), [...carried].sort());
    assert.deepEqual([...carried], [CURRENT_SHA]);

    // …and not one of the ten historical tickets reaches the operator's screen.
    for (const ticket of HISTORICAL) {
      assert.doesNotMatch(rendered, new RegExp(ticket), `${ticket} is finished work, not current activity`);
    }
  });

  test("the surface stays three sections: narrowing CI removed no section and invented no agent task", () => {
    seedTheReportedShape();
    const rendered = renderCurrentActivityLines(deriveCurrentActivity(db, { now: NOW })).join("\n");
    assert.match(rendered, /^ {2}Agents$/m);
    assert.match(rendered, /^ {2}Host verification$/m);
    assert.match(rendered, /^ {2}Required CI$/m);
    assert.match(rendered, /\(no agent task in flight\)/);
  });
});

// ─────────────────── the review-disposition findings (RF-1, RF-4) ───────────────────

describe("FG-694 RF-1 — terminality is a property of the review vocabulary, not a local list", () => {
  test("EVERY review state is classified, so a state added later cannot silently read as open", () => {
    // The defect this replaces was a hand-written `["settled", "failed"]` in the
    // derivation: an allowlist of two names standing in for an open-ended terminal
    // set. Exhaustiveness over REVIEW_STATES is what makes that unrepeatable — the
    // twelfth state does not compile until someone decides what it means.
    assert.deepEqual([...REVIEW_STATES].sort(), Object.keys(REVIEW_STATE_TERMINALITY).sort());
  });

  test("each state decides currency exactly as its classification says — all eleven, not two", () => {
    // Each run is FINISHED, so the review is the only thing that can keep its
    // observation current. Whatever the classification says must be what the
    // derivation does, state by state.
    for (const state of REVIEW_STATES) {
      addRun(`run-${state}`, "complete");
      addReview({ id: `review-${state}`, state, runId: `run-${state}`, ticketId: `T-${state}`, workspaceDir: PROJECT });
      addCi({ runId: `run-${state}`, ticketId: `T-${state}`, sha: state.padEnd(40, "0"), observedAt: ago(30_000) });
    }

    const current = new Set(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.map((o) => o.runId));
    for (const state of REVIEW_STATES) {
      assert.equal(
        current.has(`run-${state}`),
        !isTerminalReviewState(state),
        `a review in state \`${state}\` is ${isTerminalReviewState(state) ? "terminal" : "open"}`,
      );
    }
    // Non-vacuous in both directions: the split is real, not "everything is open".
    assert.ok(current.size > 0 && current.size < REVIEW_STATES.length);
  });

  test("a state this binary's vocabulary does not contain is not terminal", () => {
    assert.equal(isTerminalReviewState("a_state_added_after_this_release"), false);
    assert.equal(isTerminalReviewState(""), false);
    assert.equal(isTerminalReviewState("toString"), false, "prototype keys are not review states");
  });
});

describe("FG-694 RF-4 — a terminal REVIEW retires its observation even while the run is active", () => {
  // AC2 names a terminal run OR a terminal review, and they are not the same fact: a
  // run stays `active` through the phases that follow its review, so "the run is
  // active" cannot answer "is the review of this work over".
  for (const state of ["settled", "failed"] as const) {
    test(`an active run whose review is \`${state}\` — the review recorded the run — is not current`, () => {
      addRun("run-live", "active");
      addReview({ id: "review-over", state, runId: "run-live", ticketId: "FG-694", workspaceDir: PROJECT });
      addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });

      assert.equal(legacyNewestPerPair(db).length, 1, "the row IS the newest for its pair");
      assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 0);
    });

    test(`…and when the \`${state}\` review recorded no run, anchored by ticket alone`, () => {
      addRun("run-live", "active");
      addReview({ id: "review-over", state, runId: null, ticketId: "FG-694", workspaceDir: PROJECT });
      addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });
      assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 0);
    });
  }

  test("an active run with NO review at all stays current — CI is observed before a review exists", () => {
    addRun("run-live", "active");
    addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });
    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.map((o) => o.candidateSha),
      [CURRENT_SHA],
    );
  });

  test("NOT over-broad: the previous attempt's settled review does not retire the LIVE attempt of a re-run ticket", () => {
    // The mirror harm, and the reason a review that recorded a run speaks for that run
    // alone: retiring the live attempt would be a current candidate vanishing, which
    // Home renders as observed absence.
    addRun("run-attempt-1", "failed");
    addReview({ id: "review-1", state: "settled", runId: "run-attempt-1", ticketId: "FG-694", workspaceDir: PROJECT });
    addCi({ runId: "run-attempt-1", ticketId: "FG-694", sha: "a".repeat(40), observedAt: ago(60_000) });
    addRun("run-attempt-2", "active");
    addCi({ runId: "run-attempt-2", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });

    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.map((o) => o.candidateSha),
      [CURRENT_SHA],
    );
  });

  test("an OPEN review outranks a terminal one naming the same work — a reopened review is open", () => {
    addRun("run-live", "active");
    addReview({ id: "review-old", state: "settled", runId: "run-live", ticketId: "FG-694", workspaceDir: PROJECT });
    addReview({ id: "review-new", state: "rechecking", runId: "run-live", ticketId: "FG-694", workspaceDir: PROJECT });
    addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(30_000) });
    assert.equal(deriveCurrentActivity(db, { now: NOW }).requiredCi.observations.length, 1);
  });
});

describe("FG-694 RF-2 — the 500-row window is narrowed BY the scope, never spent on it", () => {
  const FLOOD = 600;

  /** The pre-fix window: event type + eligible run ids, and nothing else, with the
   *  limit applied before any project or run narrowing. Restated so each fixture below
   *  is shown to reach a different answer than the shipped code did. */
  function windowMisses(sha: string, runIds: string[]): boolean {
    const clause = runIds.length === 0 ? "" : `AND (run_id IS NULL OR run_id IN (${runIds.map(() => "?").join(",")}))`;
    const rows = db.prepare(`
      SELECT payload FROM events WHERE event_type = ? ${clause} ORDER BY created_at DESC, id DESC LIMIT 500
    `).all(CI_OBSERVED_EVENT_TYPE, ...runIds) as Array<{ payload: string }>;
    return !rows.some((r) => r.payload.includes(sha));
  }

  test("a project-scoped read still returns its own current observation behind 600 newer rows from another active project", () => {
    addRun("run-here", "active", PROJECT);
    addCi({ runId: "run-here", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(10 * 60_000) });
    addRun("run-there", "active", OTHER_PROJECT);
    for (let i = 0; i < FLOOD; i++) {
      addCi({
        runId: "run-there",
        ticketId: "FG-700",
        sha: "b".repeat(40),
        observedAt: ago(9 * 60_000 - i * 500),
        projectDir: OTHER_PROJECT,
      });
    }

    assert.ok(windowMisses(CURRENT_SHA, ["run-here", "run-there"]), "NOT vacuous: the pre-fix window never reached this project's row");

    const here = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.equal(here.requiredCi.state, "observed", "work IS waiting on checks; reporting nothing would be observed absence");
    assert.deepEqual(here.requiredCi.observations.map((o) => o.candidateSha), [CURRENT_SHA]);
  });

  test("a run-scoped read is not evicted by 600 newer rows that declare no run", () => {
    addRun("run-here", "active", PROJECT);
    addCi({ runId: "run-here", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(10 * 60_000) });
    addReview({ id: "review-standalone", state: "verifying", runId: null, ticketId: "FG-700", workspaceDir: PROJECT });
    for (let i = 0; i < FLOOD; i++) {
      addCi({ runId: null, ticketId: "FG-700", sha: "b".repeat(40), observedAt: ago(9 * 60_000 - i * 500) });
    }

    assert.ok(windowMisses(CURRENT_SHA, ["run-here"]), "NOT vacuous: the no-run rows consumed the pre-fix window");

    const scoped = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-here" } });
    assert.deepEqual(scoped.requiredCi.observations.map((o) => o.candidateSha), [CURRENT_SHA]);
  });

  test("an unreadable payload is dropped by the narrowed query exactly as the JSON parse drops it — the query never throws", () => {
    addRun("run-live", "active", PROJECT);
    addCi({ runId: "run-live", ticketId: "FG-694", sha: CURRENT_SHA, observedAt: ago(60_000) });
    // Newer than the good row and sharing its pair: if this decided the pair, the
    // current candidate would disappear.
    db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`)
      .run("run-live", CI_OBSERVED_EVENT_TYPE, "{not json at all", ago(10_000));

    for (const scope of [{}, { projectDirs: [PROJECT] }, { runId: "run-live" }]) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope });
      assert.deepEqual(activity.requiredCi.observations.map((o) => o.candidateSha), [CURRENT_SHA], JSON.stringify(scope));
    }
  });
});

describe("FG-694 AC10 — the serving path is read-only and reaches nothing outside the store", () => {
  test("every statement the derivation prepares is a READ, and it never execs", () => {
    seedTheReportedShape();
    const prepared: string[] = [];
    const violations: string[] = [];
    const watched = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => { prepared.push(sql); return target.prepare(sql); };
        if (prop === "exec" || prop === "transaction" || prop === "pragma") {
          return (...args: unknown[]) => { violations.push(`${String(prop)}(${String(args[0])})`); throw new Error("unreachable"); };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as DatabaseInstance;

    for (const scope of [{}, { runId: "run-fg694" }, { projectDirs: [PROJECT] }]) {
      deriveCurrentActivity(watched, { now: NOW, scope });
    }

    assert.deepEqual(violations, []);
    assert.ok(prepared.length > 0, "the derivation did read the store");
    for (const sql of prepared) {
      assert.match(sql.trim(), /^(SELECT|PRAGMA)\b/i, `not a read: ${sql}`);
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|ATTACH|VACUUM)\b/i, `writer verb in: ${sql}`);
    }
  });

  test("a store opened READ-ONLY answers the whole derivation — any write would have thrown SQLITE_READONLY", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "fg694-ro-")));
    const file = join(home, "forge.db");
    try {
      const seed = new Database(file);
      seed.exec(SCHEMA_SQL);
      applyMigrations(seed);
      const previous = db;
      db = seed;
      seedTheReportedShape();
      db = previous;
      seed.close();

      const readonlyDb = new Database(file, { readonly: true });
      try {
        const activity = deriveCurrentActivity(readonlyDb, { now: NOW });
        assert.equal(activity.requiredCi.state, "observed");
        assert.deepEqual(activity.requiredCi.observations.map((o) => o.candidateSha), [CURRENT_SHA]);
      } finally {
        readonlyDb.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no outbound call: no fetch, no socket, no DNS lookup, no HTTP request", () => {
    seedTheReportedShape();
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
      fetched.push(String(input));
      return realFetch(input, init);
    }) as typeof realFetch;

    // Channels Node publishes for every outbound connection attempt, whichever client
    // library opens it. A shelled `gh`/`git` cannot reach the network without one.
    const channels = ["net.client.socket", "dns.lookup.start", "http.client.request.created", "http.client.request.start", "undici:request:create"];
    const hits: string[] = [];
    const subscriptions = channels.map((name) => {
      const handler = (): void => { hits.push(name); };
      dc.subscribe(name, handler);
      return { name, handler };
    });

    try {
      for (const scope of [{}, { runId: "run-fg694" }, { projectDirs: [PROJECT] }]) {
        deriveCurrentActivity(db, { now: NOW, scope });
      }
    } finally {
      for (const s of subscriptions) dc.unsubscribe(s.name, s.handler);
      globalThis.fetch = realFetch;
    }

    assert.deepEqual(fetched, []);
    assert.deepEqual(hits, []);
  });

  test("the module itself names no outbound channel — and the scan that says so is not vacuous", () => {
    const FORBIDDEN = [
      "node:child_process", "child_process", "node:net", "node:http", "node:https", "node:dgram",
      "execSync", "execFileSync", "spawnSync", "spawn(", "fetch(", "XMLHttpRequest", "tmux", "docker",
    ];
    /** Comment lines are stripped first: this module's header DISCUSSES tmux, gh and
     *  git precisely to say it never calls them, and a scan that could not tell prose
     *  from code would have to be deleted or watered down. */
    const scan = (source: string): string[] => {
      const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
      return FORBIDDEN.filter((token) => code.includes(token));
    };

    // The negative control: the scan can see a violation when one exists.
    assert.deepEqual(scan(`const out = execSync("gh pr checks");`), ["execSync"]);

    const source = readFileSync(join(HERE, "current-activity.ts"), "utf8");
    assert.deepEqual(scan(source), [], "current-activity.ts reaches outside the injected db handle");
  });
});
