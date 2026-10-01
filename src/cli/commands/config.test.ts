// FG-349 [E]: `forge config graph`. Byte-identity between the CLI JSON and
// buildConfigGraph output, a thin human renderer of the same object, and a
// missing project still emitting a graph (exit 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-cfg-cli-home-"));
process.env.FORGE_HOME = tmpHome;
delete process.env.FORGE_AI_ATTRIBUTION_CARRIED;

const { cliConfigGraph, renderConfigGraphHuman, registerConfig } = await import("./config.js");
const { buildConfigGraph } = await import("../../v2/config-graph.js");
const { makeInMemoryDb, setDbForTest } = await import("../../store/db.js");

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

// FG-845: the file write is the mutation and the event its record. When the record
// cannot be inserted the change is still applied: exit 0, the applied line, a warning
// naming the audit gap, and in --json an auditError field — never a bare failure.
test("an injected config.ai_attribution_changed insert failure still reports the applied mode and names the audit gap", async () => {
  const db = makeInMemoryDb();
  db.exec("DROP TABLE events");
  const prev = setDbForTest(db);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    const dir = project();
    const file = join(dir, ".forge", "config.yml");
    writeFileSync(file, "project_key: pk\n");

    const human = await runCli(["config", "set", "ai-attribution", "allow", "--project", dir, "--actor", "t"]);
    assert.equal(human, `set ai-attribution = allow (${file})`);
    assert.equal(readFileSync(file, "utf8"), "project_key: pk\nai_attribution: allow\n");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^warning: applied, but the config\.ai_attribution_changed audit event was not recorded: .*events/);

    const json = JSON.parse(await runCli(["config", "set", "ai-attribution", "suppress", "--project", dir, "--actor", "t", "--json"]));
    assert.equal(json.mode, "suppress");
    assert.equal(json.level, "project");
    assert.equal(json.file, file);
    assert.match(json.auditError, /config\.ai_attribution_changed audit event was not recorded/);
    assert.match(readFileSync(file, "utf8"), /ai_attribution: suppress/);

    const host = JSON.parse(await runCli(["config", "set", "ai-attribution", "allow", "--host", "--actor", "t", "--json"]));
    assert.deepEqual({ mode: host.mode, level: host.level, file: host.file }, { mode: "allow", level: "host", file: join(tmpHome, "config.yml") });
    assert.match(host.auditError, /audit event was not recorded/);

    const unset = JSON.parse(await runCli(["config", "unset", "ai-attribution", "--project", dir, "--actor", "t", "--json"]));
    assert.equal(unset.removed, true);
    assert.equal(unset.resolved.source, "host");
    assert.match(unset.auditError, /audit event was not recorded/);
    assert.equal(readFileSync(file, "utf8"), "project_key: pk\n");
    assert.equal(errors.length, 4, "one warning per applied change");
  } finally {
    console.error = origError;
    if (prev) setDbForTest(prev);
  }
});

test("a recorded change carries no auditError and prints no warning", async () => {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    const dir = project();
    const json = JSON.parse(await runCli(["config", "set", "ai-attribution", "allow", "--project", dir, "--actor", "t", "--json"]));
    assert.equal(json.mode, "allow");
    assert.equal("auditError" in json, false);
    assert.deepEqual(errors, []);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'config.ai_attribution_changed'").get() as { n: number }).n, 1);
  } finally {
    console.error = origError;
    if (prev) setDbForTest(prev);
  }
});
