// FG-349 [E]: `forge config graph`. Byte-identity between the CLI JSON and
// buildConfigGraph output, a thin human renderer of the same object, and a
// missing project still emitting a graph (exit 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cfg-cli-home-"));
process.env.FORGE_HOME = tmpHome;

const { cliConfigGraph, renderConfigGraphHuman, registerConfig } = await import("./config.js");
const { buildConfigGraph } = await import("../../v2/config-graph.js");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-cfg-cli-proj-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  return dir;
}

async function runCli(args: string[]): Promise<string> {
  const program = new Command();
  registerConfig(program);
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

test("cliConfigGraph deep-equals buildConfigGraph for the resolved project", () => {
  const dir = project();
  assert.deepEqual(cliConfigGraph(dir), buildConfigGraph({ projectDir: resolve(dir) }));
});

test("`config graph --json` prints the graph byte-identical to buildConfigGraph", async () => {
  const dir = project();
  const out = await runCli(["config", "graph", "--project", dir, "--json"]);
  // byte-identity: the CLI prints buildConfigGraph output UNMODIFIED
  assert.equal(out, JSON.stringify(buildConfigGraph({ projectDir: resolve(dir) }), null, 2));
});

test("human output is a rendering of the SAME object (project + a source label)", () => {
  const dir = project();
  const human = renderConfigGraphHuman(buildConfigGraph({ projectDir: resolve(dir) }));
  assert.match(human, /forge config graph/);
  assert.match(human, /Sources/);
  assert.match(human, /Model policy|Docs surfaces|Constraints/);
});

test("a missing project still emits a graph and does not throw / exit non-zero", async () => {
  const out = await runCli(["config", "graph", "--project", "/no/such/dir", "--json"]);
  const graph = JSON.parse(out);
  assert.equal(graph.project.status, "missing");
  assert.ok(graph.version >= 1);
});
