// FG-349 [F]: effectiveConfigGraph — the in-process dashboard read model. It is
// the OTHER half of byte-identity: it returns buildConfigGraph output unreshaped,
// so the CLI JSON and the dashboard payload agree. A missing/disposed checkout
// returns a missing graph, never a throw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cp-q-home-"));
process.env.FORGE_HOME = tmpHome;

const { effectiveConfigGraph } = await import("./queries.js");
const { buildConfigGraph } = await import("../../src/v2/config-graph.js");

test("effectiveConfigGraph(dir) deep-equals buildConfigGraph({ projectDir: dir })", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cp-q-proj-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  assert.deepEqual(effectiveConfigGraph(dir), buildConfigGraph({ projectDir: dir }));
});

test("a relative projectDir is resolved to an absolute path before buildConfigGraph (byte-identity with the CLI)", () => {
  // RF-1 / FG-349: the dashboard passed the caller's projectDir through untouched
  // while the CLI resolve()'d it first, so the documented in-process query with a
  // relative dir (e.g. ".") retained "." in graph.project.dir and every source
  // path derived from it, diverging from `forge config graph --json`. Both paths
  // must now resolve() the same input to the same absolute path.
  const g = effectiveConfigGraph(".");
  assert.equal(g.project.dir, resolve("."));
  assert.notEqual(g.project.dir, ".");
  assert.deepEqual(g, buildConfigGraph({ projectDir: resolve(".") }));
});

test("a missing/unreadable projectDir returns a missing graph, not a throw", () => {
  let g!: ReturnType<typeof effectiveConfigGraph>;
  assert.doesNotThrow(() => {
    g = effectiveConfigGraph("/no/such/checkout/dir");
  });
  assert.equal(g.project.status, "missing");
  assert.ok(g.sections);
});
