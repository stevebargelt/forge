// FG-846 — an action's outcome at the point of action (client/action-outcome.js), the
// queue's outcome entries and pills (client/queue-board-state.js), and FG-847's Refine
// decisions (client/refine-state.js) and edit-mode hash (client/view-routing.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActionOutcome,
  dismissOutcome,
  emptyOutcomes,
  outcomeElementProps,
  outcomeFor,
  outcomeKeyDown,
  outcomeRole,
  pillFor,
  placeOutcome,
  recordOutcome,
  recordOutcomeInScope,
  returnFocusToControl,
  shouldTakeFocus,
  updateOutcome,
} from "../client/action-outcome.js";
import { offersRefine, outcomePill, queueOutcomeEntry } from "../client/queue-board-state.js";
import {
  REFINE_SECTIONS,
  isQueueable,
  refineChecklist,
  saveRefusal,
  savedOutcome,
  sectionsForGaps,
  seedBody,
} from "../client/refine-state.js";
import { hashFor, parseHash } from "../client/view-routing.js";
import { badgeClass, statusToken } from "../client/status-tokens.js";
import { evaluateReadiness } from "../../src/readiness/readiness.js";

const REFUSAL =
  "forge: backlog enqueue refuses — FG-9 evaluates 'needs_refinement' at its CURRENT revision, not ready: Missing Problem section; Missing Goal section (or Expected behavior).";
const NOT_READY = {
  outcome: "needs_refinement",
  gaps: ["Missing Problem section", "Missing Goal section (or Expected behavior)"],
  refinementProposal: "Add a ## Problem section describing the issue or context. Add a ## Goal section (or ## Expected behavior) describing what success looks like.",
  revision: 4,
  body: "Intro line.\n\n## Rules\n- one\n\n## Acceptance Criteria\n- it works\n",
};

// ─── placement and roles ─────────────────────────────────────────────────────

test("placeOutcome: the outcome is the control's NEXT sibling; no outcome, the control alone", () => {
  const control = { type: "button", props: {} };
  assert.deepEqual(placeOutcome(control, null, () => "x"), [control]);
  const ledger = recordOutcome(emptyOutcomes(), "card:FG-9", { ok: false, kind: "refused", message: REFUSAL, ticketId: "FG-9" });
  const outcome = outcomeFor(ledger, "card:FG-9")!;
  const placed = placeOutcome(control, outcome, (o: { message: string }) => o.message) as Array<{ type: unknown; key: string; props: Record<string, unknown> }>;
  assert.equal(placed.length, 2);
  assert.equal(placed[0], control, "the control comes first");
  assert.equal(placed[1]!.type, ActionOutcome, "its next sibling is the outcome element");
  assert.equal(placed[1]!.props["outcome"], outcome);
  assert.equal(placed[1]!.props["children"], REFUSAL, "the CLI's refusal text, verbatim");
  assert.equal(placed[1]!.key, `outcome-${outcome.id}`, "a replacement remounts — and so re-announces");
});

test("roles: refused → alert, applied → status; the element is a programmatic focus stop keyed to its control", () => {
  assert.equal(outcomeRole({ ok: false }), "alert");
  assert.equal(outcomeRole({ ok: true }), "status");
  assert.equal(outcomeRole(null), "alert");
  const refused = outcomeElementProps({ ok: false, key: "controls" });
  assert.equal(refused.role, "alert");
  assert.equal(refused.tabIndex, -1);
  assert.equal(refused["data-outcome-key"], "controls");
  assert.match(refused.class, /^action-outcome action-outcome-refused$/);
  const applied = outcomeElementProps({ ok: true, key: "card:FG-1" }, null, "x");
  assert.equal(applied.role, "status");
  assert.equal(applied.class, "action-outcome action-outcome-applied x");
});

// ─── focus and Escape ────────────────────────────────────────────────────────

function fakeEl(name: string, focused: string[], extra: Record<string, unknown> = {}) {
  return { name, tagName: "DIV", focus: () => focused.push(name), contains: () => false, ...extra };
}

test("focus: taken on arrival; on a remount only when focus was lost to the page; never stolen from a field inside it", () => {
  const body = { tagName: "BODY" };
  const elsewhere = { tagName: "BUTTON" };
  assert.equal(shouldTakeFocus(9001, elsewhere), true, "first arrival takes focus");
  assert.equal(shouldTakeFocus(9001, elsewhere), false, "a remount does not steal focus from another control");
  assert.equal(shouldTakeFocus(9001, body), true, "a remount reclaims focus lost to <body> (the card moved lanes)");
  assert.equal(shouldTakeFocus(9001, null), true);
  const textarea = { tagName: "TEXTAREA" };
  const panelHost = { contains: (n: unknown) => n === textarea };
  assert.equal(shouldTakeFocus(9002, textarea, panelHost), false, "a panel's focused field keeps focus");
});

test("Escape returns focus to the control — the previous sibling — or to the caller's returnFocus", () => {
  const focused: string[] = [];
  const control = fakeEl("enqueue button", focused);
  const outcomeEl = fakeEl("outcome", focused, { previousElementSibling: control });
  let prevented = false;
  const handled = outcomeKeyDown({ key: "Escape", defaultPrevented: false, preventDefault: () => { prevented = true; }, currentTarget: outcomeEl });
  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.deepEqual(focused, ["enqueue button"]);

  // A panel inside the outcome that handled Escape itself (preventDefault) keeps the key.
  assert.equal(outcomeKeyDown({ key: "Escape", defaultPrevented: true, preventDefault() {}, currentTarget: outcomeEl }), false);
  assert.equal(outcomeKeyDown({ key: "Enter", defaultPrevented: false, preventDefault() {}, currentTarget: outcomeEl }), false);
  assert.deepEqual(focused, ["enqueue button"]);

  // A reorder's control is its card.
  const card = fakeEl("card", focused);
  assert.equal(returnFocusToControl(outcomeEl, () => card), card);
  assert.deepEqual(focused, ["enqueue button", "card"]);
  assert.equal(returnFocusToControl(fakeEl("orphan", focused, { previousElementSibling: null })), null);
});

// ─── persistence and replacement ─────────────────────────────────────────────

test("ledger: an outcome persists per key until replaced; a later success on the same card replaces the refusal and clears its pill", () => {
  let ledger = emptyOutcomes();
  ledger = recordOutcome(ledger, "card:FG-9", { ok: false, kind: "refused", message: REFUSAL, ticketId: "FG-9", verdict: "needs_refinement" });
  ledger = recordOutcome(ledger, "card:FG-1", { ok: true, kind: "applied", message: "Queued FG-1 at position 1", ticketId: "FG-1" });
  const refused = outcomeFor(ledger, "card:FG-9")!;
  assert.equal(refused.ok, false);
  assert.equal(outcomeFor(ledger, "card:FG-1")!.ok, true, "another card's success does not touch it");
  assert.equal(outcomeFor(ledger, "card:FG-9"), refused, "it persists across unrelated outcomes");
  assert.deepEqual(pillFor(ledger, "FG-9")!.verdict, "needs_refinement");

  // Opening the panel patches it without a new identity (no re-announcement).
  const opened = updateOutcome(ledger, "card:FG-9", { refineOpen: true });
  assert.equal(outcomeFor(opened, "card:FG-9")!.id, refused.id);
  assert.equal(outcomeFor(opened, "card:FG-9")!.refineOpen, true);
  assert.equal(updateOutcome(opened, "card:nope", { refineOpen: true }), opened);

  // Dismiss hides the outcome; the pill stays until a reload or a later success.
  const dismissed = dismissOutcome(opened, "card:FG-9");
  assert.equal(outcomeFor(dismissed, "card:FG-9"), null);
  assert.ok(pillFor(dismissed, "FG-9"));

  const success = recordOutcome(dismissed, "card:FG-9", { ok: true, kind: "applied", message: "Queued FG-9 at position 2", ticketId: "FG-9" });
  assert.equal(outcomeFor(success, "card:FG-9")!.message, "Queued FG-9 at position 2", "the success replaces the refusal");
  assert.notEqual(outcomeFor(success, "card:FG-9")!.id, refused.id);
  assert.equal(pillFor(success, "FG-9"), null, "a subsequent success clears the pill");

  // A success for the ticket from another control retires its refusal on the card.
  const cardRefused = recordOutcome(emptyOutcomes(), "card:FG-5", { ok: false, kind: "refused", message: REFUSAL, ticketId: "FG-5", verdict: "needs_refinement" });
  const savedElsewhere = recordOutcome(cardRefused, "controls", { ok: true, kind: "saved", message: "Saved; FG-5 evaluates ready at r2.", ticketId: "FG-5" });
  assert.equal(outcomeFor(savedElsewhere, "card:FG-5"), null);
  assert.equal(pillFor(savedElsewhere, "FG-5"), null);
  assert.equal(outcomeFor(savedElsewhere, "controls")!.ok, true);

  // A refusal from the controls block pills the card too; a reload is a fresh ledger.
  const fromControls = recordOutcome(success, "controls", { ok: false, kind: "refused", message: REFUSAL, ticketId: "FG-1", verdict: "needs_refinement" });
  assert.ok(pillFor(fromControls, "FG-1"));
  assert.equal(outcomeFor(emptyOutcomes(), "controls"), null);
  assert.equal(pillFor(emptyOutcomes(), "FG-1"), null);
});

test("ledger scope: a refused enqueue whose readiness arrives after a project/checkout change is discarded, never recorded into the new board", () => {
  const scopeA = JSON.stringify(["repo-a", null]);
  const scopeB = JSON.stringify(["repo-b", null]);
  // The request is made on board A; the operator switches to board B (the ledger resets to
  // B's scope) while the enqueue + readiness reads are outstanding; then the late response lands.
  const atCall = scopeA;
  let ledger = emptyOutcomes(scopeA);
  ledger = emptyOutcomes(scopeB);
  const late = queueOutcomeEntry({ verb: "enqueue", ticketId: "FG-9", response: { status: 409, payload: { ok: false, error: REFUSAL } }, readiness: NOT_READY });
  const after = recordOutcomeInScope(ledger, atCall, "card:FG-9", late);
  assert.equal(after, ledger, "the late response is discarded whole");
  assert.equal(outcomeFor(after, "card:FG-9"), null, "no outcome on a same-id card in the new board");
  assert.equal(pillFor(after, "FG-9"), null, "and no pill");

  // In the scope it was made in, the same response records; recording keeps the scope.
  const same = recordOutcomeInScope(emptyOutcomes(scopeA), atCall, "card:FG-9", late);
  assert.equal(outcomeFor(same, "card:FG-9")!.ok, false);
  assert.equal(same.scope, scopeA);
  assert.equal(recordOutcome(same, "controls", { ok: true, kind: "applied", message: "ok" }).scope, scopeA);
});

// ─── the queue's entries and pills ───────────────────────────────────────────

test("queueOutcomeEntry: the CLI's refusal text verbatim with the readiness verdict; the applied result is the CLI's message", () => {
  const refused = queueOutcomeEntry({ verb: "enqueue", ticketId: "FG-9", response: { status: 409, payload: { ok: false, verb: "enqueue", error: REFUSAL } }, readiness: NOT_READY });
  assert.equal(refused.ok, false);
  assert.equal(refused.message, REFUSAL);
  assert.equal(refused.verdict, "needs_refinement");
  assert.equal(refused.readiness, NOT_READY);
  assert.equal(offersRefine(refused), true);
  assert.deepEqual(outcomePill(refused), { vocab: "readiness", value: "needs_refinement", text: "refused · needs refinement" });
  assert.equal(badgeClass(outcomePill(refused).vocab, outcomePill(refused).value), "badge status-failed");

  // A refusal that is not readiness (a done ticket) carries no verdict and no Refine.
  const notActive = queueOutcomeEntry({ verb: "enqueue", ticketId: "FG-2", response: { status: 409, payload: { error: "FG-2 is 'done'" } }, readiness: { ...NOT_READY, outcome: "ready", gaps: [] } });
  assert.equal(notActive.verdict, null);
  assert.equal(offersRefine(notActive), false);
  assert.deepEqual(outcomePill(notActive), { vocab: "outcome", value: "refused", text: "refused" });

  const applied = queueOutcomeEntry({ verb: "enqueue", ticketId: "FG-9", response: { status: 200, payload: { ok: true, verb: "enqueue", result: { message: "Queued FG-9 at position 6 (readiness: ready)" } } } });
  assert.equal(applied.ok, true);
  assert.equal(applied.message, "Queued FG-9 at position 6 (readiness: ready)");
  assert.equal(applied.readiness, null);
  assert.deepEqual(outcomePill(applied), { vocab: "outcome", value: "applied", text: "enqueued" });
  assert.equal(outcomePill({ ok: true, kind: "applied", verb: "dequeue" }).text, "dequeued");
  assert.equal(outcomePill({ ok: true, kind: "applied", verb: "rank" }).text, "moved");
  assert.equal(outcomePill({ ok: false, kind: "stale_version" }).text, "refused · queue moved");
});

test("status tokens: the readiness verdicts and the outcome states render through the FG-824 map", () => {
  assert.equal(statusToken("readiness", "needs_refinement").label, "needs refinement");
  assert.equal(statusToken("readiness", "ready").tone, "ok");
  assert.equal(statusToken("outcome", "refused").class, "status-failed");
  assert.equal(statusToken("outcome", "applied").class, "status-complete");
});

// ─── FG-847: Refine ──────────────────────────────────────────────────────────

test("refine: the gaps name the sections; the seed inserts the missing ones above the first heading", () => {
  const sections = sectionsForGaps(NOT_READY.gaps);
  assert.deepEqual(sections.map((s: { key: string }) => s.key), ["problem", "goal"]);
  const seeded = seedBody(NOT_READY.body, sections);
  assert.equal(
    seeded,
    "Intro line.\n\n## Problem\n\n<what breaks today, and where it was seen>\n\n## Goal\n\n<state the observable end state>\n\n## Rules\n- one\n\n## Acceptance Criteria\n- it works\n",
  );
  // A body with no heading keeps its free text out of any section.
  assert.equal(seedBody("just text", sections.slice(0, 1)), "just text\n\n## Problem\n\n<what breaks today, and where it was seen>\n");
  // A present section is not inserted twice.
  assert.equal(seedBody("## Problem\n\nreal\n", sections).match(/## Problem/g)!.length, 1);
  assert.deepEqual(sectionsForGaps(["Acceptance Criteria section has no bullet points"]).map((s: { key: string }) => s.key), ["acceptance"]);
  assert.equal(REFINE_SECTIONS.length, 3);
});

test("refine: the checklist ticks a section once written (the placeholder does not count); Save is refused naming what is missing", () => {
  const sections = sectionsForGaps(NOT_READY.gaps);
  const seeded = seedBody(NOT_READY.body, sections);
  assert.deepEqual(refineChecklist(seeded, sections).map((r: { done: boolean }) => r.done), [false, false]);
  const refusal = saveRefusal(seeded, sections)!;
  assert.match(refusal, /## Problem/);
  assert.match(refusal, /## Goal \(or ## Expected behavior\)/);

  const problemOnly = seeded.replace("<what breaks today, and where it was seen>", "The click did nothing visible.");
  assert.deepEqual(refineChecklist(problemOnly, sections).map((r: { done: boolean }) => r.done), [true, false]);
  const still = saveRefusal(problemOnly, sections)!;
  assert.doesNotMatch(still, /## Problem/);
  assert.match(still, /## Goal/);

  const both = problemOnly.replace("<state the observable end state>", "The refusal is visible where the operator acted.");
  assert.equal(saveRefusal(both, sections), null);
  // The client's check agrees with the server's evaluator on the result.
  assert.equal(evaluateReadiness({ id: "FG-9", type: "story", status: "active", title: "t", body: both }).outcome, "ready");
  // Expected behavior satisfies Goal, as evaluateReadiness accepts it.
  assert.equal(saveRefusal("## Problem\nx\n## Expected behavior\ny\n", sections), null);
});

test("refine: a Save's outcome flips to `ready · r<N>` with Enqueue now, or stays a refusal naming the gaps", () => {
  const ready = savedOutcome("FG-9", { ok: true, revision: 5, readiness: { outcome: "ready", gaps: [], revision: 5 } });
  assert.equal(ready.ok, true);
  assert.equal(ready.message, "Saved; FG-9 evaluates ready at r5.");
  assert.deepEqual(outcomePill(ready), { vocab: "readiness", value: "ready", text: "ready · r5" });
  const still = savedOutcome("FG-9", { ok: true, revision: 6, readiness: { outcome: "needs_refinement", gaps: ["Missing Acceptance Criteria section"], revision: 6 } });
  assert.equal(still.ok, false);
  assert.match(still.message, /still evaluates needs_refinement: Missing Acceptance Criteria section/);
  assert.equal(isQueueable("exploratory"), true);
  assert.equal(isQueueable("blocked"), false);
});

test("routing: #backlog/<id>?mode=edit restores the ticket page's edit mode; the list's params stay off an object page", () => {
  const parsed = parseHash("#backlog/FG-9?project=pk-1&mode=edit");
  assert.equal(parsed.view, "backlog");
  assert.equal(parsed.id, "FG-9");
  assert.deepEqual(parsed.params, { mode: "edit" });
  assert.equal(parsed.canonical, "#backlog/FG-9?project=pk-1&mode=edit");
  assert.equal(parsed.rewrite, false);
  assert.deepEqual(parseHash("#backlog/FG-9?project=pk-1&mode=delete").params, {}, "an unknown mode is dropped");
  assert.deepEqual(parseHash("#backlog/FG-9?project=pk-1&status=done").params, {}, "a list param is not an object param");
  assert.deepEqual(parseHash("#backlog?mode=edit").params, {}, "mode is an object-page param only");
  assert.equal(hashFor({ view: "backlog", id: "FG-9", scope: { project: "pk-1" }, params: { mode: "edit" } }), "#backlog/FG-9?project=pk-1&mode=edit");
  assert.equal(hashFor({ view: "backlog", scope: { project: "pk-1" }, params: { status: "done" } }), "#backlog?project=pk-1&status=done");
});
