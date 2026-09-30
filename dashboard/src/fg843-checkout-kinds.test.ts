// FG-843: the checkout-kind derivation (dashboard/src/queries.ts — the ONE rule) and the
// header chooser's rule (client/checkout-label.js): a chooser only with two or more LIVE
// operator checkouts, the plain label with one, a run checkout named by the hash honoured
// and marked `run checkout`.
//
// Run alone: cd dashboard && npx tsx --test src/fg843-checkout-kinds.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provenPhysical } from "../../src/util/path-identity.js";
import type { ProjectCheckout, ProjectRecord } from "../../src/util/projects.js";
import { checkoutKind, withCheckoutKinds } from "./queries.js";
import { RUN_CHECKOUT_LABEL, checkoutChooser, checkoutKindForDir, checkoutForDir, defaultCheckout, displayPath, knownCheckout } from "../client/checkout-label.js";
import { runRow } from "../client/runs-index-render.js";
import { noteGroups, noteRows } from "../client/notes-render.js";

function co(projectDir: string, extra: Partial<ProjectCheckout> = {}): ProjectCheckout {
  return { projectDir, projectDirs: [projectDir], exists: true, runCount: 1, inFlightCount: 0, liveSessions: 0, branch: "main", ...extra };
}

function record(checkouts: ProjectCheckout[], primary = checkouts[0]!.projectDir): ProjectRecord {
  return {
    key: "forge",
    projectDir: primary,
    primaryCheckout: primary,
    projectDirs: checkouts.flatMap((c) => c.projectDirs),
    checkouts,
    label: "Forge",
    color: "#fff",
    runCount: checkouts.length,
    inFlightCount: 0,
    liveSessions: 0,
  };
}

const PRIMARY = "/Users/op/code/forge";
const STABLE = "/Users/op/code/forge-stable";
const CLONE = "/Users/op/code/forge-fg801";
const WORKTREE = "/Users/op/.forge/worktrees/run-9/forge";
const GONE = "/Users/op/code/forge-fg700";

test("FG-843: the primary, a registered (purpose operator) checkout and a live-session checkout are operator; run-only directories are run", () => {
  const r = record([
    co(PRIMARY),
    co(STABLE, { purpose: "operator" }),
    co("/Users/op/code/forge-session", { liveSessions: 1 }),
    co(CLONE),
    co(WORKTREE, { purpose: "worktree" }),
    co(GONE, { exists: false }),
    co("/Users/op/code/forge-unclassified", { purpose: "unclassified" }),
  ]);
  assert.deepEqual(
    r.checkouts.map((c) => checkoutKind(r, c)),
    ["operator", "operator", "operator", "run", "run", "run", "run"],
  );
});

test("FG-843: withCheckoutKinds states the kind per checkout and the counts, and keeps every checkout", () => {
  const r = withCheckoutKinds(record([co(PRIMARY), co(STABLE, { purpose: "operator" }), co("/Users/op/code/old", { purpose: "operator", exists: false }), co(CLONE), co(GONE, { exists: false })]));
  assert.equal(r.checkouts.length, 5, "run checkouts stay on the record for their runs");
  assert.deepEqual(r.checkouts.map((c) => c.kind), ["operator", "operator", "operator", "run", "run"]);
  assert.deepEqual(r.checkoutCounts, { operator: 3, liveOperator: 2, run: 2 });
});

test("FG-843: a missing primary is still the operator primary", () => {
  const r = withCheckoutKinds(record([co(CLONE), co(PRIMARY, { exists: false })], PRIMARY));
  assert.deepEqual(r.checkouts.map((c) => [c.projectDir, c.kind]), [[CLONE, "run"], [PRIMARY, "operator"]]);
});

test("FG-843: chooser — two live operator checkouts make a menu, primary first and marked, run checkouts only counted", () => {
  const project = withCheckoutKinds(record([co(PRIMARY), co(CLONE), co(STABLE, { purpose: "operator" }), co(GONE, { exists: false })]));
  const model = checkoutChooser(project, null);
  assert.equal(model.mode, "menu");
  assert.deepEqual(model.options.map((o) => [o.label, o.primary, o.path, o.selected]), [
    ["forge · main", true, "~/code/forge", true],
    ["forge-stable · main", false, "~/code/forge-stable", false],
  ]);
  assert.deepEqual(model.current, { projectDir: PRIMARY, label: "forge · main", primary: true, run: false });
  assert.equal(model.footer, "2 operator checkouts · 2 run checkouts are listed on their runs, not here");
  assert.equal(checkoutChooser(project, STABLE).options.find((o) => o.selected)?.projectDir, STABLE);
});

test("FG-843: chooser — one live operator checkout is the plain label; a missing operator checkout is never offered", () => {
  const one = withCheckoutKinds(record([co(PRIMARY), co(CLONE), co(WORKTREE)]));
  const model = checkoutChooser(one, null);
  assert.equal(model.mode, "label");
  assert.equal(model.current?.label, "code/forge · main");
  const goneSecond = withCheckoutKinds(record([co(PRIMARY), co(STABLE, { purpose: "operator", exists: false })]));
  assert.equal(checkoutChooser(goneSecond, null).mode, "label", "only LIVE operator checkouts count toward two");
  assert.equal(checkoutChooser(null, null).mode, "none");
});

test("FG-843: a run checkout named by the hash is honoured, reads run checkout, and the menu offers the operator checkouts", () => {
  const one = withCheckoutKinds(record([co(PRIMARY), co(CLONE)]));
  const model = checkoutChooser(one, CLONE);
  assert.equal(model.mode, "menu", "even with one operator checkout the way back to the primary is offered");
  assert.equal(model.current?.run, true);
  assert.equal(model.current?.projectDir, CLONE);
  assert.deepEqual(model.options.map((o) => [o.projectDir, o.selected]), [[PRIMARY, false]]);
  assert.equal(RUN_CHECKOUT_LABEL, "run checkout");
  assert.equal(model.footer, "1 operator checkout · 1 run checkout is listed on its run, not here");
});

test("FG-843: checkoutKindForDir, defaultCheckout and displayPath", () => {
  const project = withCheckoutKinds(record([co(PRIMARY, { projectDirs: [PRIMARY, `${PRIMARY}/dashboard`] }), co(CLONE)]));
  assert.equal(checkoutKindForDir(`${PRIMARY}/dashboard`, project), "operator");
  assert.equal(checkoutKindForDir(`${CLONE}/`, project), "run");
  assert.equal(checkoutKindForDir("/elsewhere", project), null);
  assert.equal(defaultCheckout(project), PRIMARY);
  assert.equal(defaultCheckout(null), null);
  assert.equal(displayPath("/home/op/code/x"), "~/code/x");
  assert.equal(displayPath("/tmp/x"), "/tmp/x");
});

test("FG-843: Notes rows carry the kind and split operator checkouts from run checkouts", () => {
  const project = withCheckoutKinds(record([co(PRIMARY), co(CLONE)]));
  const data = { notesByCheckout: [{ checkoutDir: PRIMARY, notes: "Main." }, { checkoutDir: CLONE, notes: "Clone." }] };
  const groups = noteGroups(noteRows(data, { project: "forge", checkout: null }, [project]));
  assert.deepEqual(groups.operator.map((r) => r.checkoutDir), [PRIMARY]);
  assert.deepEqual(groups.run.map((r) => r.checkoutDir), [CLONE]);
});

test("FG-843: a run recorded through a symlinked parent is labelled with the primary checkout it resolves to", () => {
  const home = provenPhysical(mkdtempSync(join(tmpdir(), "fg843-alias-")))!;
  const primary = join(home, "code", "forge");
  mkdirSync(primary, { recursive: true });
  symlinkSync(join(home, "code"), join(home, "code-alias"), "dir");
  const alias = join(home, "code-alias", "forge");
  assert.equal(provenPhysical(alias), primary, "path-identity resolves the alias to the primary");

  // GET /api/projects groups the recorded spelling under the checkout its identity names.
  const project = withCheckoutKinds(record([co(primary, { projectDirs: [alias, primary] }), co(join(home, "code", "forge-fg801"))]));
  const row = runRow({ runId: "r", status: "complete", workflow: "feature", title: "t", projectDir: alias, createdAt: "2026-09-28T10:00:00Z", completedAt: null }, [project], 0);
  assert.equal(row.checkout, "forge · main");
  assert.equal(row.project.label, "Forge");
  assert.equal(checkoutForDir(alias, [project])?.checkout.projectDir, primary);
  assert.equal(checkoutForDir(join(home, "elsewhere"), [project]), null);
});

test("FG-843: an unknown checkout in the hash is unknown, not a run checkout — the chooser falls back to the primary", () => {
  const project = withCheckoutKinds(record([co(PRIMARY), co(CLONE), co(STABLE, { purpose: "operator" })]));
  assert.equal(knownCheckout("/Users/op/not-a-checkout", project), null);
  assert.equal(knownCheckout(CLONE, project), CLONE);
  assert.equal(knownCheckout(STABLE, project), STABLE);
  const model = checkoutChooser(project, "/Users/op/not-a-checkout");
  assert.deepEqual(model.current, { projectDir: PRIMARY, label: "forge · main", primary: true, run: false });
  assert.deepEqual(model.options.map((o) => [o.projectDir, o.selected]), [[PRIMARY, true], [STABLE, false]]);
  assert.equal(checkoutChooser(project, CLONE).current?.run, true, "a known run checkout is still honoured");
});
