// FG-349 [E]: `forge config graph`. Byte-identity between the CLI JSON and
// buildConfigGraph output, a thin human renderer of the same object, and a
// missing project still emitting a graph (exit 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// FG-845: one recorded event per applied change. When the record cannot be inserted
// the write is undone — the file byte-identical to before — and the change is refused
// naming the audit: exit non-zero, and in --json { ok: false, reason: "audit_unrecorded" }.
test("an injected config.ai_attribution_changed insert failure restores the file byte-identical and refuses naming the audit", async () => {
  const db = makeInMemoryDb();
  db.exec("DROP TABLE events");
  const prev = setDbForTest(db);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  const exitCodes: unknown[] = [];
  const takeExit = () => {
    exitCodes.push(process.exitCode);
    process.exitCode = undefined;
  };
  try {
    const dir = project();
    const file = join(dir, ".forge", "config.yml");
    const original = "# operator notes\nproject_key: pk   # keep\n\nai_attribution: allow\n";
    writeFileSync(file, original);

    const human = await runCli(["config", "set", "ai-attribution", "suppress", "--project", dir, "--actor", "t"]);
    takeExit();
    assert.equal(human, "");
    assert.equal(readFileSync(file, "utf8"), original, "byte-identical after the refused set");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^forge: refused — the config\.ai_attribution_changed audit event could not be recorded \(.*events.*\); .* is unchanged$/);

    const json = JSON.parse(await runCli(["config", "set", "ai-attribution", "suppress", "--project", dir, "--actor", "t", "--json"]));
    takeExit();
    assert.equal(json.ok, false);
    assert.equal(json.reason, "audit_unrecorded");
    assert.match(json.error, /audit event could not be recorded/);
    assert.equal(readFileSync(file, "utf8"), original);

    const unset = JSON.parse(await runCli(["config", "unset", "ai-attribution", "--project", dir, "--actor", "t", "--json"]));
    takeExit();
    assert.deepEqual({ ok: unset.ok, reason: unset.reason }, { ok: false, reason: "audit_unrecorded" });
    assert.equal(readFileSync(file, "utf8"), original, "byte-identical after the refused unset");

    const hostFile = join(tmpHome, "config.yml");
    assert.equal(existsSync(hostFile), false);
    const host = JSON.parse(await runCli(["config", "set", "ai-attribution", "allow", "--host", "--actor", "t", "--json"]));
    takeExit();
    assert.deepEqual({ ok: host.ok, reason: host.reason }, { ok: false, reason: "audit_unrecorded" });
    assert.equal(existsSync(hostFile), false, "a host file the refused set created is removed again");

    assert.deepEqual(exitCodes, [1, 1, 1, 1]);
    assert.equal(errors.length, 4, "one refusal per change");
  } finally {
    console.error = origError;
    process.exitCode = undefined;
    if (prev) setDbForTest(prev);
  }
});

test("a recorded change is reported applied with exactly one event and no refusal", async () => {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    const dir = project();
    const json = JSON.parse(await runCli(["config", "set", "ai-attribution", "allow", "--project", dir, "--actor", "t", "--json"]));
    assert.equal(json.mode, "allow");
    assert.equal("ok" in json, false);
    assert.equal(process.exitCode, undefined);
    assert.deepEqual(errors, []);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'config.ai_attribution_changed'").get() as { n: number }).n, 1);
  } finally {
    console.error = origError;
    if (prev) setDbForTest(prev);
  }
});
