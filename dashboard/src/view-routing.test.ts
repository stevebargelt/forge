import assert from "node:assert/strict";
import test from "node:test";
import { GROUPS, NAV_GROUPS, ROUTES, carriesScope, groupOf, hashFor, navItemFor, parseHash } from "../client/view-routing.js";

test("FG-820: every route names one of the five groups, a path, a scope requirement and its aliases", () => {
  const groupIds = GROUPS.map((g) => g.id);
  assert.deepEqual(groupIds, ["now", "plan", "evidence", "setup", "health"]);
  for (const [view, route] of Object.entries(ROUTES)) {
    assert.ok(groupIds.includes(route.group), `${view} has a known group`);
    assert.ok(["none", "optional", "project", "checkout"].includes(route.scope), `${view} has a known scope requirement`);
    assert.ok(route.path.startsWith(`#${view}`), `${view}'s path pattern starts with its own name`);
    assert.ok(Array.isArray(route.aliases));
  }
});

test("FG-820: the nav column is the document's five groups in order, object pages excluded", () => {
  assert.deepEqual(
    NAV_GROUPS.map((g) => [g.label, g.items]),
    [
      ["Now", ["home", "activity"]],
      ["Plan", ["backlog", "notes", "queue", "campaigns"]],
      ["Evidence", ["runs", "reviews", "shipping"]],
      ["Setup", ["roles", "routing", "config", "projects"]],
      ["Health", ["usage", "ops"]],
    ],
  );
  assert.equal(navItemFor("run"), "runs", "a run page highlights Runs");
  assert.equal(navItemFor("task"), "runs", "a task page highlights Runs");
  assert.equal(navItemFor("queue"), "queue");
  assert.equal(groupOf("run"), "evidence");
});

test("home is the default for an empty hash, and needs no rewrite", () => {
  for (const hash of ["", "#", null, undefined]) {
    const p = parseHash(hash);
    assert.equal(p.view, "home");
    assert.equal(p.rewrite, false);
    assert.equal(p.notice, null);
  }
  assert.equal(parseHash("#home").rewrite, false);
  assert.equal(hashFor({ view: "home" }), "#home");
});

test("an unknown hash lands on Home with a one-line notice naming it, and is canonicalized", () => {
  const p = parseHash("#control-planes?project=forge");
  assert.equal(p.view, "home");
  assert.match(p.notice ?? "", /No view named “control-planes”/);
  assert.equal(p.canonical, "#home");
  assert.equal(p.rewrite, true);
  assert.equal(parseHash("#verification").view, "home", "the retired Verification tab stays retired");
});

test("list views carry scope as ?project=&checkout= and restore it from the hash", () => {
  const dir = "/Users/op/src/forge wt";
  const hash = hashFor({ view: "queue", scope: { project: "forge", checkout: dir } });
  assert.equal(hash, `#queue?project=forge&checkout=${encodeURIComponent(dir)}`);
  const p = parseHash(hash);
  assert.deepEqual([p.view, p.group, p.scope, p.rewrite], ["queue", "plan", { project: "forge", checkout: dir }, false]);
  assert.deepEqual(parseHash("#activity?project=forge").scope, { project: "forge", checkout: null });
});

test("a checkout without a project is not a scope", () => {
  const p = parseHash("#ops?checkout=%2Frepo");
  assert.deepEqual(p.scope, { project: null, checkout: null });
  assert.equal(p.canonical, "#ops");
  assert.equal(p.rewrite, true);
});

test("unknown parameter keys are dropped and the hash canonicalized", () => {
  const p = parseHash("#usage?since=7d&project=forge&utm=x");
  assert.deepEqual(p.scope, { project: "forge", checkout: null });
  assert.equal(p.canonical, "#usage?project=forge");
  assert.equal(p.rewrite, true);
});

test("the group is derived from the view: a group= param or a group-shaped leading segment is dropped", () => {
  const byParam = parseHash("#queue?group=health&project=forge");
  assert.deepEqual([byParam.view, byParam.group, byParam.canonical], ["queue", "plan", "#queue?project=forge"]);
  assert.equal(byParam.rewrite, true);

  const bySegment = parseHash("#setup/queue?project=forge");
  assert.deepEqual([bySegment.view, bySegment.group, bySegment.canonical], ["queue", "plan", "#queue?project=forge"]);
  assert.equal(bySegment.rewrite, true);

  const bareGroup = parseHash("#evidence");
  assert.deepEqual([bareGroup.view, bareGroup.canonical, bareGroup.notice], ["home", "#home", null]);
});

test("scope-less views drop a scope arriving on the hash", () => {
  const projects = parseHash("#projects?project=forge");
  assert.deepEqual(projects.scope, { project: null, checkout: null });
  assert.equal(projects.canonical, "#projects");
  assert.equal(carriesScope("projects"), false);
  assert.equal(carriesScope("routing"), true);
});

test("relabels: #governance → #routing and #control-plane → #config, keeping scope", () => {
  const g = parseHash("#governance?project=forge&checkout=%2Frepo");
  assert.deepEqual([g.view, g.group, g.canonical, g.rewrite], ["routing", "setup", "#routing?project=forge&checkout=%2Frepo", true]);
  const c = parseHash("#control-plane");
  assert.deepEqual([c.view, c.canonical, c.rewrite], ["config", "#config", true]);
  assert.equal(parseHash("#routing").rewrite, false);
  assert.equal(parseHash("#config").rewrite, false);
});

test("FG-821: the run page is #run/<id>; #run-map/<id> is its permanent alias; object hashes carry no scope", () => {
  const p = parseHash("#run/run-abc123");
  assert.deepEqual([p.view, p.id, p.tab, p.rewrite], ["run", "run-abc123", "map", false]);

  const alias = parseHash("#run-map/run-abc123");
  assert.deepEqual([alias.view, alias.id, alias.tab, alias.canonical, alias.rewrite], ["run", "run-abc123", "map", "#run/run-abc123", true]);

  const scoped = parseHash("#run/run-abc123?project=forge");
  assert.deepEqual(scoped.scope, { project: null, checkout: null });
  assert.equal(scoped.canonical, "#run/run-abc123");

  const weird = "run/with spaces&?#";
  assert.equal(parseHash(hashFor({ view: "run", id: weird })).id, weird);
});

test("FG-821: run tabs are map (default, omitted) and evidence; an unknown tab falls back to map", () => {
  const e = parseHash("#run/run-1/evidence");
  assert.deepEqual([e.tab, e.canonical, e.rewrite], ["evidence", "#run/run-1/evidence", false]);
  assert.equal(parseHash("#run/run-1/map").canonical, "#run/run-1");
  const p = parseHash("#run-map/run-1/nonsense");
  assert.deepEqual([p.view, p.tab, p.canonical, p.rewrite], ["run", "map", "#run/run-1", true]);
});

test("FG-821: the task page is #task/<id> and its Explain page #task/<id>/explain", () => {
  const t = parseHash("#task/task-1");
  assert.deepEqual([t.view, t.id, t.tab, t.rewrite], ["task", "task-1", "detail", false]);
  const x = parseHash("#task/task-1/explain?project=forge");
  assert.deepEqual([x.view, x.id, x.tab, x.canonical], ["task", "task-1", "explain", "#task/task-1/explain"]);
  assert.equal(hashFor({ view: "task", id: "task-1", tab: "explain" }), "#task/task-1/explain");
  assert.equal(parseHash("#task/task-1/log").canonical, "#task/task-1", "an unknown task tab falls back to the detail");
});

test("FG-821: a bare object hash (#run-map, #run, #task) lands on the run index with a prompt", () => {
  for (const [hash, noun] of [["#run-map", "run"], ["#run", "run"], ["#run-map?project=forge", "run"], ["#task", "task"]]) {
    const p = parseHash(hash);
    assert.equal(p.view, "runs");
    assert.equal(p.canonical, "#runs");
    assert.equal(p.rewrite, true);
    assert.match(p.notice ?? "", new RegExp(`Open a ${noun} from the run index`));
  }
});

test("FG-821: the run index carries scope and its own status= parameter; other keys are dropped", () => {
  const p = parseHash("#runs?status=failed&project=forge&utm=x");
  assert.deepEqual(p.params, { status: "failed" });
  assert.equal(p.canonical, "#runs?project=forge&status=failed");
  assert.equal(hashFor({ view: "runs", params: { status: "active" } }), "#runs?status=active");
  assert.deepEqual(parseHash("#queue?status=failed&project=forge").params, {}, "status= belongs to the run index alone");
  assert.equal(parseHash("#queue?status=failed&project=forge").canonical, "#queue?project=forge");
});

test("list views with an optional object id carry it; views without one drop extra segments", () => {
  const b = parseHash("#backlog/FG-12?project=forge");
  assert.deepEqual([b.view, b.id, b.canonical, b.rewrite], ["backlog", "FG-12", "#backlog/FG-12?project=forge", false]);
  const c = parseHash("#campaigns/camp-1");
  assert.deepEqual([c.view, c.id], ["campaigns", "camp-1"]);
  const q = parseHash("#queue/extra?project=forge");
  assert.deepEqual([q.view, q.id, q.canonical, q.rewrite], ["queue", null, "#queue?project=forge", true]);
});

test("every nav item round-trips through hashFor/parseHash unchanged", () => {
  for (const group of NAV_GROUPS) {
    for (const view of group.items) {
      const scope = carriesScope(view) ? { project: "forge", checkout: "/r/forge" } : null;
      const p = parseHash(hashFor({ view, scope }));
      assert.equal(p.view, view);
      assert.equal(p.rewrite, false, `${view} is canonical as emitted`);
    }
  }
});
