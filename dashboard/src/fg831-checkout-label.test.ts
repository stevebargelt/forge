// FG-831: the ONE checkout label rule (client/checkout-label.js) — uniqueness, primary
// first, canonical-path dedupe, and the missing-on-disk filter the scope bar applies.
// The browser suite (browser-tests/fg831-checkout-labels.test.ts) renders it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSING_LABEL,
  checkoutLabel,
  checkoutLabelForDir,
  checkoutOptions,
  checkoutPathLabel,
  dedupeCheckouts,
} from "../client/checkout-label.js";

const FORGE = [
  { projectDir: "/Users/s/code/forge", branch: "main", exists: true },
  { projectDir: "/Users/s/code/forge-fg827", branch: "feat/fg-827-roles-second-pass", exists: true },
  { projectDir: "/Users/s/code/forge/.forge/worktrees/task-a", branch: "main", exists: true },
  { projectDir: "/tmp/forge-clones/run-1/forge", branch: "main", exists: true },
  { projectDir: "/tmp/forge-clones/run-2/forge", branch: "main", exists: false },
];

test("FG-831: a label is the basename, plus parent segments only where the basename collides, then the branch", () => {
  assert.equal(checkoutLabel(FORGE[1]!, FORGE), "forge-fg827 · feat/fg-827-roles-second-pass");
  assert.equal(checkoutLabel(FORGE[2]!, FORGE), "task-a · main");
  // Three checkouts are named `forge`: each gets just enough parent context to differ.
  assert.equal(checkoutLabel(FORGE[0]!, FORGE), "code/forge · main");
  assert.equal(checkoutLabel(FORGE[3]!, FORGE), "run-1/forge · main");
  assert.equal(checkoutLabel(FORGE[4]!, FORGE), `run-2/forge · ${MISSING_LABEL}`);
});

test("FG-831: every label among one project's checkouts is distinct, even when every branch is main", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ projectDir: `/w/${i % 3}/c${Math.floor(i / 3)}/forge`, branch: "main", exists: true }));
  const labels = many.map((c) => checkoutLabel(c, many));
  assert.equal(new Set(labels).size, many.length, labels.join(", "));
  assert.ok(labels.every((l) => l.endsWith(" · main")));
});

test("FG-831: a path that is a suffix of another still gets a distinct label (falls back to the full path)", () => {
  const all = [{ projectDir: "/a/forge" }, { projectDir: "/b/a/forge" }];
  assert.equal(checkoutPathLabel(all[0]!, all), "/a/forge");
  assert.equal(checkoutPathLabel(all[1]!, all), "b/a/forge");
});

test("FG-831: a checkout with no reported branch reads by its path alone", () => {
  assert.equal(checkoutLabel({ projectDir: "/x/atlas", exists: true }, []), "atlas");
});

test("FG-831: dedupe is by canonical path — a trailing-separator spelling of the same root is one checkout", () => {
  const out = dedupeCheckouts([
    { projectDir: "/r/forge", branch: "main" },
    { projectDir: "/r/forge/", branch: "main" },
    { projectDir: "/r/other", branch: "x" },
  ]);
  assert.deepEqual(out.map((c) => c.projectDir), ["/r/forge", "/r/other"]);
  // …and a duplicate never forces extra parent context onto its twin's label.
  assert.equal(checkoutLabel({ projectDir: "/r/forge", branch: "main" }, [{ projectDir: "/r/forge" }, { projectDir: "/r/forge/" }]), "forge · main");
});

test("FG-831: options put the primary first and mark it, and withhold missing checkouts behind a count", () => {
  const project = { primaryCheckout: "/Users/s/code/forge", checkouts: [FORGE[1]!, FORGE[4]!, FORGE[0]!, FORGE[2]!] };
  const hidden = checkoutOptions(project);
  assert.equal(hidden.missingCount, 1);
  assert.deepEqual(hidden.options.map((o) => [o.label, o.primary, o.missing]), [
    ["code/forge · main", true, false],
    ["forge-fg827 · feat/fg-827-roles-second-pass", false, false],
    ["task-a · main", false, false],
  ]);
  const shown = checkoutOptions(project, { showMissing: true });
  assert.equal(shown.missingCount, 1);
  assert.deepEqual(shown.options.at(-1), { projectDir: "/tmp/forge-clones/run-2/forge", label: `run-2/forge · ${MISSING_LABEL}`, primary: false, missing: true });
});

test("FG-831: a missing checkout that is the current selection is still offered, so it reads as selected", () => {
  const project = { primaryCheckout: "/Users/s/code/forge", checkouts: FORGE };
  const { options } = checkoutOptions(project, { selected: "/tmp/forge-clones/run-2/forge" });
  assert.ok(options.some((o) => o.missing && o.projectDir === "/tmp/forge-clones/run-2/forge"));
});

test("FG-831: checkoutOptions tolerates an unloaded project", () => {
  assert.deepEqual(checkoutOptions(null), { options: [], missingCount: 0 });
});

test("FG-831: a bare directory — a root or an exact run subdirectory — resolves to the same label", () => {
  const projects = [{ checkouts: [...FORGE.slice(0, 3), { ...FORGE[3]!, projectDirs: ["/tmp/forge-clones/run-1/forge/dashboard"] }] }];
  assert.equal(checkoutLabelForDir("/Users/s/code/forge-fg827", projects), "forge-fg827 · feat/fg-827-roles-second-pass");
  assert.equal(checkoutLabelForDir("/tmp/forge-clones/run-1/forge/dashboard", projects), "run-1/forge · main");
  assert.equal(checkoutLabelForDir("/elsewhere/atlas", projects, "dev"), "atlas · dev", "unregistered: basename plus the branch the row carries");
  assert.equal(checkoutLabelForDir(null, projects), "");
});
