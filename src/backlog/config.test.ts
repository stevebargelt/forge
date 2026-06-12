import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBacklogConfig } from "./config.js";
import { detectBacklogFormat } from "../cli/commands/backlog.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-backlog-config-test-"));
}

test("readBacklogConfig: missing .forge/config.yml returns null prefix", () => {
  const dir = tmp();
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, null);
});

test("readBacklogConfig: present prefix is returned", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, "FG");
});

test("readBacklogConfig: absent backlog section returns null prefix", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "other:\n  key: value\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, null);
});

test("readBacklogConfig: backlog section without prefix returns null", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  other: something\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, null);
});

test("detectBacklogFormat: backlog/ directory returns structured", () => {
  const dir = tmp();
  mkdirSync(join(dir, "backlog"));
  assert.equal(detectBacklogFormat(dir), "structured");
});

test("detectBacklogFormat: BACKLOG.md returns legacy", () => {
  const dir = tmp();
  writeFileSync(join(dir, "BACKLOG.md"), "# backlog\n");
  assert.equal(detectBacklogFormat(dir), "legacy");
});

test("detectBacklogFormat: backlog/ takes precedence over BACKLOG.md", () => {
  const dir = tmp();
  mkdirSync(join(dir, "backlog"));
  writeFileSync(join(dir, "BACKLOG.md"), "# backlog\n");
  assert.equal(detectBacklogFormat(dir), "structured");
});

test("detectBacklogFormat: neither throws", () => {
  const dir = tmp();
  assert.throws(() => detectBacklogFormat(dir), /No backlog found/);
});
