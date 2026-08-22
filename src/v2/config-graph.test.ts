// FG-349 [D]: the aggregator. A versioned panel-partitioned graph with both
// sections for a valid project; a missing projectDir is a missing graph, not a
// throw; no RECORDED task-manifest read; a planted credential is blanked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cg-agg-home-"));
process.env.FORGE_HOME = tmpHome;

const { buildConfigGraph, redactGraph } = await import("./config-graph.js");
const { CONFIG_GRAPH_VERSION } = await import("./config-graph-types.js");

test("buildConfigGraph returns a versioned, panel-partitioned graph with both sections", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cg-agg-proj-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  const g = buildConfigGraph({ projectDir: dir, forgeHome: tmpHome });
  assert.equal(g.version, CONFIG_GRAPH_VERSION);
  assert.equal(g.forgeHome, tmpHome);
  assert.equal(g.project.status, "active");
  assert.ok(g.sections.sources.rows.length > 0);
  assert.ok(Array.isArray(g.sections.capabilities.capabilities));
  assert.ok(Array.isArray(g.sections.capabilities.providers));
  assert.ok(Array.isArray(g.sections.capabilities.prerequisites));
});

test("a nonexistent/unreadable projectDir returns a missing graph without throwing", () => {
  let g!: ReturnType<typeof buildConfigGraph>;
  assert.doesNotThrow(() => {
    g = buildConfigGraph({ projectDir: "/no/such/dir/anywhere", forgeHome: tmpHome });
  });
  assert.equal(g.version, CONFIG_GRAPH_VERSION);
  assert.equal(g.project.status, "missing");
});

test("the aggregator reads NO recorded task manifest / dispatch dir", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config-graph.ts"), "utf8");
  assert.equal(src.includes("task-manifest"), false, "must not import task-manifest");
  assert.equal(src.includes("ControlPlaneReceipt"), false, "must not read the recorded receipt type");
  // and no subprocess seam on the read path
  for (const forbidden of ["child_process", "execSync", "spawnSync", "dockerode", "simple-git"]) {
    assert.equal(src.includes(forbidden), false, `aggregator must not reference ${forbidden}`);
  }
});

test("a planted credential ANYWHERE in the graph is blanked by the redaction sweep", () => {
  const planted = {
    version: 1,
    project: { dir: "/p", status: "active", native: { note: "NPM_TOKEN=supersecretvalue123" } },
    forgeHome: "/h",
    sections: {
      sources: {
        rows: [
          {
            key: "x",
            label: "X",
            truth: "EFFECTIVE",
            status: "active",
            sourcePaths: ["https://user:hunter2@example.com/repo.git"],
            overrideSemantics: "none",
            native: { deep: { note: "AWS_SECRET=zzzleak" } },
          },
        ],
      },
      capabilities: { providers: [], capabilities: [], prerequisites: [] },
    },
  } as unknown as Parameters<typeof redactGraph>[0];
  const out = JSON.stringify(redactGraph(planted));
  assert.equal(out.includes("supersecretvalue123"), false);
  assert.equal(out.includes("hunter2"), false);
  assert.equal(out.includes("zzzleak"), false);
});
