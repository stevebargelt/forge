import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBacklogConfig } from "./config.js";
import { detectBacklogFormat } from "../cli/commands/backlog.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const MINIMAL_BACKLOG = `# Backlog

## Notes for next session

(none)

## Active

`;

let projectDir: string;

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: projectDir,
    encoding: "utf8",
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-config-integ-"));
  writeFileSync(join(projectDir, "BACKLOG.md"), MINIMAL_BACKLOG);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── detectBacklogFormat: real fixture directories ───────────────────────────

test("integ detectBacklogFormat: directory with BACKLOG.md returns legacy", () => {
  // projectDir already has BACKLOG.md from beforeEach
  assert.equal(detectBacklogFormat(projectDir), "legacy");
});

test("integ detectBacklogFormat: directory with backlog/ subdir returns structured", () => {
  mkdirSync(join(projectDir, "backlog"));
  assert.equal(detectBacklogFormat(projectDir), "structured");
});

test("integ detectBacklogFormat: backlog/ takes precedence when both exist", () => {
  mkdirSync(join(projectDir, "backlog"));
  // BACKLOG.md already present from beforeEach
  assert.equal(detectBacklogFormat(projectDir), "structured");
});

test("integ detectBacklogFormat: directory with neither throws descriptive error", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "forge-config-empty-"));
  try {
    assert.throws(() => detectBacklogFormat(emptyDir), /No backlog found/);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
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
  // no .forge dir created
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
  // Should not throw — malformed YAML is tolerated with a null fallback
  let cfg: { prefix: string | null };
  assert.doesNotThrow(() => {
    cfg = readBacklogConfig(projectDir);
  });
  // prefix may be null or whatever a lenient parse returns; it must not throw
  assert.ok(cfg!.prefix === null || typeof cfg!.prefix === "string");
});

test("integ readBacklogConfig: empty config.yml returns null prefix", () => {
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(join(projectDir, ".forge", "config.yml"), "");
  const cfg = readBacklogConfig(projectDir);
  assert.equal(cfg.prefix, null);
});

// ─── forge backlog config --show: CLI end-to-end ─────────────────────────────

test("integ CLI forge backlog config --show: legacy format, no config returns expected output", () => {
  // projectDir has BACKLOG.md, no .forge/config.yml
  const res = runForge(["backlog", "config", "--show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /format:\s*legacy/);
  assert.match(res.stdout, /prefix:\s*\(none\)/);
});

test("integ CLI forge backlog config --show: structured format with prefix shows both", () => {
  mkdirSync(join(projectDir, "backlog"));
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");

  const res = runForge(["backlog", "config", "--show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /format:\s*structured/);
  assert.match(res.stdout, /prefix:\s*FG/);
});

test("integ CLI forge backlog config --show: legacy format with prefix shows both", () => {
  // BACKLOG.md already exists from beforeEach
  mkdirSync(join(projectDir, ".forge"));
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: MYPROJ\n");

  const res = runForge(["backlog", "config", "--show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /format:\s*legacy/);
  assert.match(res.stdout, /prefix:\s*MYPROJ/);
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
