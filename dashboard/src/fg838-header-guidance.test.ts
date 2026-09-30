// FG-838: list views carry live facts only under their title; the static three-answer
// contract moves into the info tip beside it; object headers keep their live facts and
// drop static filler. The browser suite (browser-tests/fg838-info-tip.test.ts) renders it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { InfoTipAnswers } from "../client/info-tip.js";
import {
  LIST_HEADER_VIEWS, listHeader, listScreenLine, noteHeader, reviewHeader, runHeader, screenLineText, taskHeader, ticketHeader,
} from "../client/screen-header-render.js";
import { roleHeader } from "../client/role-page-render.js";
import { ROUTES } from "../client/view-routing.js";

type Vnode = { type: unknown; props: Record<string, unknown> } | string | number | null | undefined | boolean | Vnode[];

// CopyVerb holds state, so it is not called: it stands in as a marker naming its verb.
function textOf(node: Vnode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  const { type, props } = node;
  if (typeof type === "function") {
    if (type.name === "CopyVerb") return `[copy ${String(props.verb)}]`;
    return textOf((type as (p: unknown) => Vnode)(props));
  }
  return textOf(props.children as Vnode);
}

const THIRTEEN = ["home", "activity", "backlog", "queue", "campaigns", "reviews", "shipping", "roles", "routing", "config", "projects", "usage", "ops"];

test("FG-838: the thirteen list views, Notes and Runs each have a tip; every list route is covered", () => {
  for (const view of [...THIRTEEN, "notes", "runs"]) assert.ok(LIST_HEADER_VIEWS.includes(view), `${view} has a tip`);
  for (const [view, route] of Object.entries(ROUTES)) {
    if (route.object === "required") continue;
    assert.ok(listHeader(view), `${view} is a list view with a tip`);
  }
});

test("FG-838: no list view renders a static line under its title; Runs renders only its live count", () => {
  const ready = (activeCount: number) => ({ phase: "ready", body: { runs: [], activeCount } });
  for (const view of LIST_HEADER_VIEWS.filter((v) => v !== "runs")) {
    assert.equal(listScreenLine(view, ready(3)), null, `${view} has no line under its title`);
  }
  assert.equal(screenLineText(listScreenLine("runs", ready(3))), "3 runs are active");
  assert.equal(screenLineText(listScreenLine("runs", ready(0))), "No run is active");
  assert.equal(listScreenLine("runs", { phase: "unavailable", body: null }), null, "no count read, no line");
  assert.equal(listScreenLine("runs", null), null);
  const main = readFileSync(new URL("../client/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(main, /listHeader\(|runsIndexHeader\(/, "the shell renders list lines only through listScreenLine");
});

test("FG-838: the info tip renders every LIST_HEADERS entry's three answers and its verb with a Copy button", () => {
  for (const view of LIST_HEADER_VIEWS) {
    const header = listHeader(view)!;
    const text = textOf(InfoTipAnswers({ header }) as unknown as Vnode);
    for (const part of [header.happening, header.needs, header.todo]) assert.ok(text.includes(part), `${view}'s tip states "${part}"`);
    assert.ok(header.verb, `${view} names a verb`);
    assert.ok(text.includes(`${header.verb} [copy ${header.verb}]`), `${view}'s tip shows ${header.verb} as code with its Copy button`);
  }
  assert.ok(textOf(InfoTipAnswers({ header: listHeader("home")! }) as unknown as Vnode).includes("What needs you, then what is running"));
});

const detail = (status: string, extra: Record<string, unknown> = {}) => ({ task: { taskId: "task-1", agentRole: "engineer", status }, failureKind: null, ...extra });
const inbox = (items: unknown[]) => ({ phase: "ready", envelope: { items } });

test("FG-838: object headers keep status, failure kind, needs-you verdict and verb", () => {
  const item = { links: { runId: "run-1", taskId: "task-1" }, reason: "engineer failed: merge_conflict", requestedAction: "rebase, or retry" };
  assert.equal(
    screenLineText(taskHeader(detail("failed", { failureKind: "merge_conflict" }), inbox([item]))),
    "engineer is failed (merge_conflict) · Needs you: engineer failed: merge_conflict · rebase, or retry: forge show task-1",
  );
  assert.equal(screenLineText(taskHeader(detail("awaiting_gate"), null)), "engineer is awaiting a gate · Needs you: a gate decision · Decide the gate: forge gate task-1");
  assert.equal(screenLineText(runHeader({ run: { runId: "run-1", status: "failed" } }, inbox([]))), "Run failed · Nothing needs you · Open the failed task for its advice: forge runs query --status failed");
  assert.equal(screenLineText(reviewHeader({ id: "rv-1", state: "awaiting_disposition" }, "record dispositions")), "Review rv-1 is awaiting disposition · Needs you until it settles · record dispositions: forge review show rv-1");
  assert.equal(screenLineText(ticketHeader("FG-9", { status: "active" }, { runs: [] })), "FG-9 is active; no run has been dispatched for it · Nothing needs you · Queue it to run: forge queue enqueue FG-9");
});

test("FG-838: object headers drop sentences that read the same for every object", () => {
  assert.equal(screenLineText(ticketHeader("FG-9", { status: "done" }, { runs: [{}] })), "FG-9 is done · Nothing needs you: forge backlog show FG-9");
  assert.equal(screenLineText(noteHeader({ label: "code/forge · main" })), "The handoff code/forge · main left for the next session · Nothing needs you: forge backlog notes show");
  const role = screenLineText(roleHeader("engineer", { overview: { recentTasks: [{ status: "complete" }] } }));
  assert.equal(role, "engineer last ran (complete) · Nothing needs you: forge model resolve engineer");
  for (const line of [role, screenLineText(ticketHeader("FG-9", { status: "done" }, { runs: [{}] }))]) {
    assert.doesNotMatch(line, /listed below|A seed changes only|Read why it runs|Read it/);
  }
});
