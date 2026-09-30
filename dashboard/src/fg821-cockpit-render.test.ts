// FG-821: the cockpit's pure decisions — breadcrumb trails built from payloads, the
// Escape-to-parent chain, the screen-contract header copy, and the Runs badge / run
// index rows. The browser suite (browser-tests/fg821-cockpit-pages.test.ts) renders these.

import assert from "node:assert/strict";
import test from "node:test";
import { breadcrumbTrail, parentHash, projectCrumb, type CrumbPayload } from "../client/breadcrumbs-render.js";
import {
  listHeader, reviewHeader, runHeader, runsIndexHeader, screenLineText, taskHeader, ticketHeader,
} from "../client/screen-header-render.js";
import { runRow, runsBadge, runsUrl, statusFilters, readRuns } from "../client/runs-index-render.js";
import { ROUTES } from "../client/view-routing.js";

const PROJECTS = [{ key: "atlas", label: "Atlas", checkouts: [{ projectDir: "/r/atlas" }, { projectDir: "/r/atlas-feature" }] }];

const RUN_PAYLOAD: CrumbPayload = { projectDir: "/r/atlas-feature", ticketId: "FG-9", runId: "run-1", runTitle: "Build it", taskId: "task-1", taskLabel: "engineer · task-1" };

test("FG-821: the explain trail is Project › Ticket › Run › Task › Explain, every crumb but the last a link", () => {
  assert.deepEqual(breadcrumbTrail("explain", RUN_PAYLOAD, PROJECTS), [
    { kind: "project", label: "Atlas", href: "#runs?project=atlas" },
    { kind: "ticket", label: "FG-9", href: "#backlog/FG-9?project=atlas" },
    { kind: "run", label: "Build it", href: "#run/run-1" },
    { kind: "task", label: "engineer · task-1", href: "#task/task-1" },
    { kind: "explain", label: "Explain", href: null },
  ]);
});

test("FG-821: each object page's trail stops at itself; a run with no ticket has no ticket crumb", () => {
  const labels = (page: Parameters<typeof breadcrumbTrail>[0], payload: CrumbPayload = RUN_PAYLOAD) =>
    breadcrumbTrail(page, payload, PROJECTS).map((c) => [c.kind, c.href === null]);
  assert.deepEqual(labels("run"), [["project", false], ["ticket", false], ["run", true]]);
  assert.deepEqual(labels("task"), [["project", false], ["ticket", false], ["run", false], ["task", true]]);
  assert.deepEqual(labels("run", { ...RUN_PAYLOAD, ticketId: null }), [["project", false], ["run", true]]);
  assert.deepEqual(labels("ticket", { projectKey: "atlas", ticketId: "FG-9" }), [["project", false], ["ticket", true]]);
  assert.deepEqual(
    breadcrumbTrail("review", { projectDir: "/r/atlas", ticketId: null, runId: "run-1", reviewId: "rv-1" }, PROJECTS).map((c) => c.label),
    ["Atlas", "run-1", "rv-1"],
  );
});

test("FG-821: the trail is a function of the payload alone — the same payload always gives the same trail", () => {
  const a = breadcrumbTrail("task", { ...RUN_PAYLOAD }, PROJECTS);
  const b = breadcrumbTrail("task", JSON.parse(JSON.stringify(RUN_PAYLOAD)), PROJECTS);
  assert.deepEqual(a, b);
});

test("FG-821: the Project crumb resolves to the scoped run index, or names an unregistered directory", () => {
  assert.equal(projectCrumb("/r/atlas", PROJECTS).href, "#runs?project=atlas");
  assert.deepEqual(projectCrumb("/elsewhere/tool", PROJECTS), { kind: "project", label: "tool", href: "#runs" });
  assert.deepEqual(projectCrumb(null, PROJECTS), { kind: "project", label: "Unknown project", href: "#runs" });
  assert.equal(projectCrumb(null, PROJECTS, "atlas").label, "Atlas", "a payload's project key wins");
});

test("FG-821: Escape goes one level up: Explain → task → run → the run index; ticket and review → their lists", () => {
  assert.equal(parentHash("explain", RUN_PAYLOAD), "#task/task-1");
  assert.equal(parentHash("task", RUN_PAYLOAD), "#run/run-1");
  assert.equal(parentHash("run", RUN_PAYLOAD), "#runs");
  assert.equal(parentHash("ticket", RUN_PAYLOAD, { project: "atlas", checkout: null }), "#backlog?project=atlas");
  assert.equal(parentHash("review", RUN_PAYLOAD, null), "#reviews");
  assert.equal(parentHash("task", { taskId: "t" }), "#runs", "a task not yet read falls back to the index");
});

const detail = (status: string, extra: Record<string, unknown> = {}) => ({ task: { taskId: "task-1", agentRole: "engineer", status }, failureKind: null, ...extra });
const inbox = (items: unknown[]) => ({ phase: "ready", envelope: { items } });

test("FG-821: a task at awaiting_gate names forge gate <id>", () => {
  const h = taskHeader(detail("awaiting_gate"), null);
  assert.equal(h.verb, "forge gate task-1");
  assert.equal(h.needsYou, true);
  assert.equal(screenLineText(h), "engineer is awaiting a gate · Needs you: a gate decision · Decide the gate: forge gate task-1");
});

test("FG-821: a failed task names forge show <id> and the retry policy's advice read from the inbox item", () => {
  const item = { links: { runId: "run-1", taskId: "task-1" }, reason: "engineer failed: merge_conflict", requestedAction: "rebase, or retry" };
  const h = taskHeader(detail("failed", { failureKind: "merge_conflict" }), inbox([item]));
  assert.equal(screenLineText(h), "engineer is failed (merge_conflict) · Needs you: engineer failed: merge_conflict · rebase, or retry: forge show task-1");
  const bare = taskHeader(detail("failed"), { phase: "unavailable" });
  assert.equal(bare.verb, "forge show task-1");
  assert.equal(bare.todo, "Inspect the failure", "without the inbox's advice, no advice is invented");
  const other = taskHeader(detail("failed"), inbox([{ ...item, links: { runId: "run-1", taskId: "task-2" } }]));
  assert.equal(other.todo, "Inspect the failure", "another task's item is not this task's advice");
});

test("FG-821: running and complete tasks need nothing; Explain states why and names forge explain", () => {
  assert.equal(screenLineText(taskHeader(detail("running"), null)), "engineer is running · Nothing needs you · Wait for it to finish");
  assert.equal(taskHeader(detail("complete"), null).verb, null);
  const x = taskHeader(detail("complete"), null, { explain: true });
  assert.match(x.happening, /^Why engineer ran the way it did/);
  assert.equal(x.verb, "forge explain task-1");
  assert.equal(taskHeader(null, null).happening, "Loading the task");
});

test("FG-821: the run header reads the run's own attention item, and the runs index header the server's activeCount", () => {
  const graph = { run: { runId: "run-1", status: "active" } };
  const item = { links: { runId: "run-1", taskId: "task-1" }, reason: "waiting at a gate", requestedAction: "forge gate task-1" };
  assert.equal(screenLineText(runHeader(graph, inbox([item]))), "Run active · Needs you: waiting at a gate · Run: forge gate task-1");
  assert.equal(screenLineText(runHeader(graph, inbox([]))), "Run active · Nothing needs you · Wait, or open a task");
  const prose = { ...item, requestedAction: "inspect the failed task" };
  assert.equal(screenLineText(runHeader(graph, inbox([prose]))), "Run active · Needs you: waiting at a gate · inspect the failed task: forge show task-1");
  assert.equal(runsIndexHeader({ phase: "ready", body: { runs: [], activeCount: 3 } }).happening, "3 runs are active");
  assert.equal(runsIndexHeader({ phase: "ready", body: { runs: [], activeCount: 1 } }).happening, "1 run is active");
  assert.equal(runsIndexHeader({ phase: "unavailable", body: null }).happening, "", "no count read, no line (FG-838)");
  assert.equal(listHeader("runs")?.verb, "forge runs query", "the verb is in the info tip (FG-838)");
});

test("FG-821: ticket and review headers, and every list view's tip states the three answers in one line", () => {
  assert.equal(ticketHeader("FG-9", { status: "active" }, { runs: [] }).verb, "forge queue enqueue FG-9");
  assert.equal(ticketHeader("FG-9", { status: "active" }, { runs: [{}] }).verb, "forge backlog show FG-9");
  assert.equal(reviewHeader({ id: "rv-1", state: "settled" }, null).needsYou, false);
  assert.equal(reviewHeader({ id: "rv-1", state: "awaiting_disposition" }, "record dispositions").verb, "forge review show rv-1");
  for (const [view, route] of Object.entries(ROUTES)) {
    if (route.object === "required" || view === "runs") continue;
    const h = listHeader(view);
    assert.ok(h, `${view} has a header`);
    assert.ok(h.happening && h.needs && h.todo, `${view} states all three answers`);
    assert.doesNotMatch(screenLineText(h), /\n/, `${view}'s header is one line`);
  }
});

test("FG-821: the Runs badge is activeCount — never a row count, never danger, ? when unreadable, hidden at 0, capped 99+", () => {
  const ready = (activeCount: unknown, runs: unknown[] = [{}, {}]) => ({ phase: "ready" as const, body: { runs, activeCount } });
  assert.deepEqual(runsBadge(ready(7)), { text: "7", tone: "neutral", partial: false, label: "7 active runs" });
  assert.equal(runsBadge(ready(7, []))?.text, "7", "the rows on screen do not change the badge");
  assert.equal(runsBadge(ready(0)), null);
  assert.equal(runsBadge(ready(140))?.text, "99+");
  assert.equal(runsBadge(ready(1))?.label, "1 active run");
  assert.equal(runsBadge(ready(null))?.text, "?");
  assert.equal(runsBadge({ phase: "unavailable", body: null })?.text, "?");
  assert.equal(runsBadge({ phase: "loading", body: null }), null);
  for (const n of [1, 5, 500]) assert.notEqual(runsBadge(ready(n))?.tone, "danger");
});

test("FG-821: readRuns makes a failed or malformed read an unavailable load, never a throw", async () => {
  const res = (ok: boolean, status: number, body: unknown) => async () => ({ ok, status, json: async () => body });
  assert.equal((await readRuns("/api/runs", res(true, 200, { runs: [], activeCount: 2 }))).phase, "ready");
  assert.equal((await readRuns("/api/runs", res(false, 503, { runs: [], activeCount: null }))).phase, "unavailable");
  assert.equal((await readRuns("/api/runs", res(true, 200, { nope: 1 }))).phase, "unavailable");
  assert.equal((await readRuns("/api/runs", async () => { throw new Error("down"); })).phase, "unavailable");
});

test("FG-821: the index reads its scope, status and cursor; rows link run, project and ticket and show duration", () => {
  assert.equal(runsUrl({ scope: { project: "atlas", checkout: "/r/atlas" }, status: "failed", cursor: "c1", limit: 10 }),
    "/api/runs?projectKey=atlas&projectDir=%2Fr%2Fatlas&status=failed&cursor=c1&limit=10");
  assert.equal(runsUrl({ scope: { project: null, checkout: "/r/x" } }), "/api/runs?limit=50", "a checkout without a project is not a scope");
  assert.deepEqual(statusFilters({ project: "atlas", checkout: null }, "failed").map((f) => [f.label, f.href, f.current]), [
    ["all", "#runs?project=atlas", false],
    ["active", "#runs?project=atlas&status=active", false],
    ["complete", "#runs?project=atlas&status=complete", false],
    ["failed", "#runs?project=atlas&status=failed", true],
    ["abandoned", "#runs?project=atlas&status=abandoned", false],
  ]);
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  const done = runRow({ runId: "r1", status: "complete", workflow: "feature", title: "T", projectDir: "/r/atlas", createdAt: "2026-09-28T10:00:00.000Z", completedAt: "2026-09-28T11:30:00.000Z", ticketId: "FG-9" }, PROJECTS, now);
  assert.deepEqual([done.href, done.project.href, done.ticket?.href, done.duration], ["#run/r1", "#runs?project=atlas", "#backlog/FG-9?project=atlas", "1h 30m"]);
  const live = runRow({ runId: "r2", status: "active", workflow: "feature", title: "", projectDir: null, createdAt: "2026-09-28T11:59:00.000Z", completedAt: null }, PROJECTS, now);
  assert.deepEqual([live.title, live.ticket, live.duration, live.project.label], ["r2", null, "1m 0s so far", "Unknown project"]);
  const old = runRow({ runId: "r3", status: "failed", workflow: "feature", title: "x", projectDir: null, createdAt: "2026-09-28T11:00:00.000Z", completedAt: null }, PROJECTS, now);
  assert.equal(old.duration, "—", "a finished run with no completion time has no duration, not a running one");
});

test("FG-821: the Runs badge module never derives a count from a list's cardinality", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../client/runs-index-render.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\.length\b/, "runs-index-render.js must read activeCount, never count rows");
});
