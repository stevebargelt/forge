// FG-799 (AC1): the per-project ai_attribution reader/writer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  readAiAttribution,
  writeAiAttribution,
  formatAiAttribution,
} from "./ai-attribution.js";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "forge-ai-attr-"));
}

function writeConfig(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), yaml);
}

test("readAiAttribution: absent config → suppress (default)", () => {
  const dir = tmpProject();
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "default" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: allow is read from project config", () => {
  const dir = tmpProject();
  writeConfig(dir, "ai_attribution: allow\n");
  assert.deepEqual(readAiAttribution(dir), { mode: "allow", source: "project-config" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: explicit suppress reads as project-config source", () => {
  const dir = tmpProject();
  writeConfig(dir, "ai_attribution: suppress\n");
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "project-config" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: unrecognized/malformed value fails closed to the suppress default", () => {
  const dir = tmpProject();
  writeConfig(dir, "ai_attribution: banana\n");
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "default" });
  writeConfig(dir, ":\n  not: yaml: at all\n"); // malformed
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "default" });
  rmSync(dir, { recursive: true, force: true });
});

test("writeAiAttribution: round-trips and PRESERVES other keys", () => {
  const dir = tmpProject();
  writeConfig(dir, "project_key: pk-abc\nbacklog:\n  prefix: FG\n");

  writeAiAttribution(dir, "allow");
  assert.equal(readAiAttribution(dir).mode, "allow");

  const parsed = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(parsed["project_key"], "pk-abc", "project_key preserved");
  assert.deepEqual(parsed["backlog"], { prefix: "FG" }, "backlog subtree preserved");
  assert.equal(parsed["ai_attribution"], "allow", "snake_case key written to YAML");

  // Flipping back is a clean read-modify-write, still preserving neighbors.
  writeAiAttribution(dir, "suppress");
  const parsed2 = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(parsed2["ai_attribution"], "suppress");
  assert.equal(parsed2["project_key"], "pk-abc");
  rmSync(dir, { recursive: true, force: true });
});

test("writeAiAttribution: creates .forge/config.yml when absent", () => {
  const dir = tmpProject();
  writeAiAttribution(dir, "allow");
  assert.equal(readAiAttribution(dir).mode, "allow");
  rmSync(dir, { recursive: true, force: true });
});

test("formatAiAttribution: the exact strings config-show / doctor print", () => {
  assert.equal(formatAiAttribution({ mode: "suppress", source: "default" }), "ai attribution: suppress (default)");
  assert.equal(
    formatAiAttribution({ mode: "allow", source: "project-config" }),
    "ai attribution: allow (.forge/config.yml)",
  );
});
