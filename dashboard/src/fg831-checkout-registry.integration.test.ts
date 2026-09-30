// FG-831 — the scope bar's checkout list against a SCRATCH registry: a real forge store,
// real git checkouts, a symlinked spelling of one of them and a checkout whose directory
// is gone. The registry (listProjects → presentationRegistry, the chain GET /api/projects
// serves) and the shared client rule (client/checkout-label.js) together must:
//
//   - list the symlinked spelling and its target ONCE (canonical path, FG-693);
//   - carry the missing checkout through, exists:false, so the client can COUNT it and
//     withhold it behind "show N missing" — labeled `missing on disk` when shown;
//   - keep a missing checkout's runs reachable when it is selected;
//   - stop offering it once `forge projects prune --missing` recorded the prune.
//
// Run alone: cd dashboard && npx tsx --test src/fg831-checkout-registry.integration.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FORGE_HOME before anything evaluates src/util/paths.ts (FG-607/FG-616).
const root = mkdtempSync(join(tmpdir(), "fg831-registry-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
const scanRoot = join(root, "scan-roots");
mkdirSync(scanRoot, { recursive: true });
process.env.FORGE_PROJECT_SCAN_ROOTS = scanRoot;

const { insertRun } = await import("../../src/store/runs.js");
const { recordPrunedCheckouts } = await import("../../src/store/pruned-checkouts.js");
const { listProjects } = await import("../../src/util/projects.js");
const { presentationRegistry } = await import("./queries.js");
const { runIndex } = await import("./run-index.js");
const { checkoutOptions, checkoutLabel, MISSING_LABEL } = await import("../client/checkout-label.js");

after(() => rmSync(root, { recursive: true, force: true }));

const REMOTE = "git@github.com:acme/fg831-atlas.git";
function checkout(name: string, branch: string): string {
  const dir = join(root, "code", name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", REMOTE], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const atlas = checkout("atlas", "main");
const feature = checkout("atlas-feature", "feature");
mkdirSync(join(root, "links"));
const alias = join(root, "links", "atlas");
symlinkSync(atlas, alias);
// A deleted scratchpad of atlas: the registry recovers its repository from the encoded
// source segment, so it is a MISSING checkout of this project (not a project of its own).
const gone = join(root, "claude-1", atlas.replaceAll("/", "-"), "sess-a", "scratchpad", "wt-a");

let n = 0;
function run(projectDir: string, status = "complete"): string {
  const id = `run-fg831-${++n}`;
  insertRun({ id, workflow: "feature", title: `Run ${n}`, status, createdAt: `2026-09-2${n}T10:00:00.000Z`, projectDir } as never);
  return id;
}
run(atlas);
run(alias);
run(feature);
const goneRun = run(gone);

function atlasRecord() {
  const record = presentationRegistry(listProjects({ scanRoots: [scanRoot] })).find((p) => p.checkouts.some((c) => realpathSync(c.projectDir) === atlas || c.projectDir === gone));
  assert.ok(record, "the atlas project is registered");
  return record;
}

test("FG-831: the symlinked spelling and its target are ONE checkout; the missing one is carried through", () => {
  const record = atlasRecord();
  const dirs = record.checkouts.map((c) => c.projectDir);
  assert.equal(dirs.filter((d) => d === atlas).length, 1, `atlas appears once: ${dirs.join(", ")}`);
  assert.ok(!dirs.includes(alias), "the symlink spelling is never a checkout of its own");
  assert.ok(dirs.includes(feature));
  const missing = record.checkouts.find((c) => c.projectDir === gone);
  assert.ok(missing, "a missing checkout is passed through for the client to count");
  assert.equal(missing.exists, false);
  assert.equal(record.primaryCheckout, atlas);
});

test("FG-831: the scope bar withholds the missing checkout behind a count, and labels it when shown", () => {
  const record = atlasRecord();
  const hidden = checkoutOptions(record);
  assert.equal(hidden.missingCount, 1);
  assert.deepEqual(hidden.options.map((o) => o.projectDir), [atlas, feature], "primary first, missing withheld");
  assert.equal(hidden.options[0]!.primary, true);
  assert.deepEqual(hidden.options.map((o) => o.label), ["atlas · main", "atlas-feature · feature"]);

  const shown = checkoutOptions(record, { showMissing: true });
  const labels = shown.options.map((o) => o.label);
  assert.equal(new Set(labels).size, labels.length, `labels are distinct: ${labels.join(", ")}`);
  assert.equal(shown.options.at(-1)!.label, `wt-a · ${MISSING_LABEL}`);
  assert.equal(checkoutLabel(record.checkouts.find((c) => c.projectDir === gone)!, record.checkouts), `wt-a · ${MISSING_LABEL}`);
});

test("FG-831: selecting the missing checkout never errors and still returns its runs", () => {
  const index = runIndex({ scope: gone, limit: 50 });
  assert.deepEqual(index.runs.map((r) => r.runId), [goneRun]);
});

test("FG-831: once pruned, the registry stops offering the missing checkout and the count is zero", () => {
  recordPrunedCheckouts([gone], "fg831-test");
  const record = atlasRecord();
  assert.ok(!record.checkouts.some((c) => c.projectDir === gone));
  assert.equal(checkoutOptions(record, { showMissing: true }).missingCount, 0);
  assert.ok(record.projectDirs.includes(gone), "the project's history keeps the pruned checkout's runs in scope");
  assert.deepEqual(runIndex({ scope: gone, limit: 50 }).runs.map((r) => r.runId), [goneRun], "prune deletes no run");
});
