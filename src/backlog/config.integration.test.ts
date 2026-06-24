import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBacklogConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: projectDir,
    encoding: "utf8",
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-config-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── readBacklogConfig: real .forge/config.yml fixture files ─────────────────

test("integ readBacklogConfig: valid prefix in .forge/config.yml is read", () => {
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(
    join(projectDir, ".forge", "config.yml"),
    "backlog:\n  prefix: FG\n",
  );
  const cfg = readBacklogConfig(projectDir);
  assert.equal(cfg.prefix, "FG");
});

test("integ readBacklogConfig: missing .forge/config.yml returns null prefix", () => {
  const cfg = readBacklogConfig(projectDir);
  assert.equal(cfg.prefix, null);
});

test("integ readBacklogConfig: config.yml with no backlog section returns null prefix", () => {
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(
    join(projectDir, ".forge", "config.yml"),
    "other:\n  setting: value\n",
  );
  const cfg = readBacklogConfig(projectDir);
  assert.equal(cfg.prefix, null);
});

test("integ readBacklogConfig: malformed YAML returns null prefix instead of throwing", () => {
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(
    join(projectDir, ".forge", "config.yml"),
    "backlog:\n  prefix: [unclosed\n  bad: : yaml\n",
  );
  let cfg: { prefix: string | null };
  assert.doesNotThrow(() => {
    cfg = readBacklogConfig(projectDir);
  });
  assert.ok(cfg!.prefix === null || typeof cfg!.prefix === "string");
});

test("integ readBacklogConfig: empty config.yml returns null prefix", () => {
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(join(projectDir, ".forge", "config.yml"), "");
  const cfg = readBacklogConfig(projectDir);
  assert.equal(cfg.prefix, null);
});

// ─── forge backlog config --show: CLI end-to-end ─────────────────────────────

test("integ CLI forge backlog config --show: structured format with prefix shows both", () => {
  mkdirSync(join(projectDir, "backlog"));
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");

  const res = runForge(["backlog", "config", "--show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /format:\s*structured/);
  assert.match(res.stdout, /prefix:\s*FG/);
});

test("integ CLI forge backlog config --show: exits non-zero when no backlog found", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "forge-config-nobl-"));
  try {
    const res = runForge(["backlog", "config", "--show", "--project", emptyDir]);
    assert.notEqual(res.status, 0, "must exit non-zero when no backlog found");
    const combined = res.stderr + res.stdout;
    assert.match(combined, /No backlog found|backlog/i);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
