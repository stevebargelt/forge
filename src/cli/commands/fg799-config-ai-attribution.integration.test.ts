// FG-799 (AC1): `forge config set/show ai-attribution` and the `forge doctor`
// line, exercised through the real CLI (tsx entry) against a temp project.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let projectDir: string;

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], { cwd: projectDir, encoding: "utf8" });
}

function configPath(): string {
  return join(projectDir, ".forge", "config.yml");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg799-cfg-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("FG-799 (AC1): config show reports the suppress default when no config exists", () => {
  const res = runForge(["config", "show", "--project", projectDir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ai attribution: suppress \(default\)/);
});

test("FG-799 (AC1): config set ai-attribution allow writes the key and show/report reflect it", () => {
  const set = runForge(["config", "set", "ai-attribution", "allow", "--project", projectDir]);
  assert.equal(set.status, 0, set.stderr);

  const parsed = parseYaml(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  assert.equal(parsed["ai_attribution"], "allow", "snake_case key in YAML");

  const show = runForge(["config", "show", "--project", projectDir]);
  assert.match(show.stdout, /ai attribution: allow \(\.forge\/config\.yml\)/);
});

test("FG-799 (AC1): config set PRESERVES other keys (read-modify-write, not template-overwrite)", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(configPath(), "project_key: pk-xyz\nbacklog:\n  prefix: FG\n");

  const set = runForge(["config", "set", "ai-attribution", "suppress", "--project", projectDir]);
  assert.equal(set.status, 0, set.stderr);

  const parsed = parseYaml(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  assert.equal(parsed["project_key"], "pk-xyz");
  assert.deepEqual(parsed["backlog"], { prefix: "FG" });
  assert.equal(parsed["ai_attribution"], "suppress");
});

test("FG-799 (AC1): an invalid value is refused, naming the two valid ones", () => {
  const res = runForge(["config", "set", "ai-attribution", "sometimes", "--project", projectDir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /suppress/);
  assert.match(res.stderr + res.stdout, /allow/);
});

test("FG-799 (AC1): an unknown key is refused", () => {
  const res = runForge(["config", "set", "nonsense", "allow", "--project", projectDir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /unknown config key/);
});

test("FG-799 (AC1): forge doctor prints the effective ai attribution line", () => {
  runForge(["config", "set", "ai-attribution", "allow", "--project", projectDir]);
  // doctor runs against cwd; --json is a stable surface that never needs docker.
  const res = spawnSync(tsx, [entry, "doctor", "--json"], { cwd: projectDir, encoding: "utf8" });
  // doctor may exit 1 on readiness, but the JSON payload must carry the mode.
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.aiAttribution, { mode: "allow", source: "project-config" });
});
