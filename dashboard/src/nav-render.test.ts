import assert from "node:assert/strict";
import test from "node:test";
import { BOTTOM_BAR_ITEMS, homeBadge, navModel, scopeSummary, scopedHref } from "../client/nav-render.js";

const envelope = (over: Record<string, unknown> = {}) => ({
  phase: "ready",
  envelope: {
    items: [{ id: "a", kind: "waiting_gate", reason: "r", requestedAction: "act", source: "s" }],
    empty: false,
    degraded: [],
    counts: { open: 5, high: 0 },
    ...over,
  },
});

test("FG-820: the Home badge is the server's counts.open, never the item list's length", () => {
  assert.deepEqual(homeBadge(envelope()), { text: "5", tone: "neutral", partial: false, label: "5 open" });
});

test("FG-820: high severity tones the badge; degraded marks it partial; 99+ caps it", () => {
  assert.equal(homeBadge(envelope({ counts: { open: 2, high: 1 } }))?.tone, "danger");
  assert.equal(homeBadge(envelope({ counts: { open: 2, high: 1 } }))?.label, "2 open, 1 high");
  const partial = homeBadge(envelope({ degraded: ["waits"], counts: { open: 3, high: 0 } }));
  assert.deepEqual([partial?.partial, partial?.label], [true, "3 open, some sources unreadable"]);
  assert.equal(homeBadge(envelope({ counts: { open: 100, high: 0 } }))?.text, "99+");
  assert.equal(homeBadge(envelope({ counts: { open: 99, high: 0 } }))?.text, "99");
});

test("FG-820: an unavailable read, or an envelope with no valid counts, shows ? — never 0", () => {
  assert.equal(homeBadge({ phase: "unavailable", reason: "http", status: 500 })?.text, "?");
  assert.equal(homeBadge(envelope({ counts: undefined }))?.text, "?");
  assert.equal(homeBadge(envelope({ counts: { open: -1, high: 0 } }))?.text, "?");
  assert.equal(homeBadge(envelope({ counts: { open: "3", high: 0 } }))?.text, "?");
  assert.equal(homeBadge({ phase: "ready", envelope: { error: "boom" } })?.text, "?", "a malformed ready is unavailable");
});

test("FG-820: only empty: true removes the badge; loading shows none yet", () => {
  assert.equal(homeBadge(envelope({ items: [], empty: true, counts: { open: 0, high: 0 } })), null);
  assert.equal(homeBadge({ phase: "loading" }), null);
  const zeroDegraded = homeBadge(envelope({ items: [], empty: false, degraded: ["waits"], counts: { open: 0, high: 0 } }));
  assert.deepEqual([zeroDegraded?.text, zeroDegraded?.partial], ["0", true]);
});

test("FG-820: nav hrefs carry scope on list views only, and the current item follows the parent rule", () => {
  const scope = { project: "forge", checkout: "/r/forge" };
  const items = navModel("run", scope).flatMap((g) => g.items);
  assert.deepEqual(items.filter((i) => i.current).map((i) => i.view), ["runs"]);
  assert.equal(items.find((i) => i.view === "queue")?.href, "#queue?project=forge", "FG-843: the checkout rides only on Routing, Config and Notes");
  assert.equal(items.find((i) => i.view === "routing")?.href, "#routing?project=forge&checkout=%2Fr%2Fforge");
  assert.equal(items.find((i) => i.view === "projects")?.href, "#projects");
  assert.equal(items.find((i) => i.view === "roles")?.href, "#roles");
  assert.deepEqual([...BOTTOM_BAR_ITEMS], ["home", "runs", "queue", "backlog"]);
});

test("FG-820: an in-app link keeps the current scope unless it names its own", () => {
  const scope = { project: "forge", checkout: null };
  assert.equal(scopedHref("#backlog/FG-9", scope), "#backlog/FG-9?project=forge");
  assert.equal(scopedHref("#backlog?project=other", scope), "#backlog?project=other");
  assert.equal(scopedHref("#run/run-1", scope), "#run/run-1", "object pages carry no scope");
  assert.equal(scopedHref("#runs?status=failed", scope), "#runs?project=forge&status=failed", "the run index keeps its status filter");
  assert.equal(scopedHref("#config", { project: null, checkout: null }), "#config");
});

test("FG-820: the scope control reads All projects, a project, or project › checkout", () => {
  const project = { label: "Forge", checkouts: [{ projectDir: "/r/forge", branch: "main" }] };
  assert.equal(scopeSummary({ project: null, checkout: null }, null), "All projects");
  assert.equal(scopeSummary({ project: "forge", checkout: null }, project), "Forge");
  assert.equal(scopeSummary({ project: "forge", checkout: "/r/forge" }, project), "Forge › forge · main");
  assert.equal(scopeSummary({ project: "forge", checkout: "/x/wt" }, null), "forge › wt", "an unloaded project reads by key");
});
