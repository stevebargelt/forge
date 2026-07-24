import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { readBacklogConfig, writeProjectKey, writeBacklogConfig } from "./config.js";

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

// ─── FG-606: top-level project_key ────────────────────────────────────────────

test("readBacklogConfig: top-level project_key is read (not stripped by the schema)", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "project_key: pk-abc123\nbacklog:\n  prefix: FG\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, "pk-abc123");
  assert.equal(cfg.prefix, "FG");
});

test("readBacklogConfig: absent project_key reads back null", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, null);
});

// AC (9): a config carrying backlog.prefix AND unrelated top-level YAML round-trips
// untouched with project_key added at the top level.
test("writeProjectKey: preserves backlog.prefix and unrelated top-level YAML, adds project_key at top level", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(
    join(dir, ".forge", "config.yml"),
    "unrelated:\n  keep: me\ntopLevelScalar: 7\nbacklog:\n  prefix: MG\n  format: structured\n",
  );

  writeProjectKey(dir, "pk-deadbeef");

  const raw = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(raw["project_key"], "pk-deadbeef");
  assert.deepEqual(raw["unrelated"], { keep: "me" });
  assert.equal(raw["topLevelScalar"], 7);
  assert.deepEqual(raw["backlog"], { prefix: "MG", format: "structured" });

  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, "pk-deadbeef");
  assert.equal(cfg.prefix, "MG");
});

// Must-fix #1 (security): the project_key write path must NEVER follow a
// repo-controlled symlink. A symlinked .forge/config.yml must cause a refusal and
// NO write through the link to its target.
test("writeProjectKey: refuses to write THROUGH a symlinked .forge/config.yml (no target clobber)", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  // A file OUTSIDE .forge that a hostile symlink points at.
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "original secret\n");
  symlinkSync(victim, join(dir, ".forge", "config.yml"));

  assert.throws(
    () => writeProjectKey(dir, "pk-evil"),
    (e: unknown) => e instanceof Error && /symlink/i.test((e as Error).message),
  );

  // The link target was NOT overwritten.
  assert.equal(readFileSync(victim, "utf8"), "original secret\n", "victim file untouched");
});

test("writeBacklogConfig: refuses to write THROUGH a symlinked .forge/config.yml", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  const victim = join(dir, "victim.yml");
  writeFileSync(victim, "keep: me\n");
  symlinkSync(victim, join(dir, ".forge", "config.yml"));

  assert.throws(
    () => writeBacklogConfig(dir, { prefix: "FG" }),
    (e: unknown) => e instanceof Error && /symlink/i.test((e as Error).message),
  );
  assert.equal(readFileSync(victim, "utf8"), "keep: me\n", "victim file untouched");
});

test("writeProjectKey: refuses when .forge itself is a symlink", () => {
  const dir = tmp();
  const outside = mkdtempSync(join(tmpdir(), "forge-outside-"));
  symlinkSync(outside, join(dir, ".forge"));

  assert.throws(
    () => writeProjectKey(dir, "pk-evil"),
    (e: unknown) => e instanceof Error && /symlink/i.test((e as Error).message),
  );
  assert.equal(existsSync(join(outside, "config.yml")), false, "no write into the symlinked dir target");
});

// Must-fix (security): the reported bypass — a symlink pre-planted at the
// PREDICTABLE sibling temp path (`config.yml.tmp-<pid>`) redirected the temp write
// outside the project before rename. The hardened atomic write uses an unpredictable
// temp name opened O_EXCL|O_NOFOLLOW, so a link at the old predictable path is inert:
// nothing is written through it and the real config still round-trips.
test("atomic write: a symlink at the OLD predictable temp path is NOT followed; write round-trips", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "unrelated:\n  keep: me\nbacklog:\n  prefix: FG\n");
  const victim = join(dir, "victim-temp-target.txt");
  writeFileSync(victim, "outside data\n");
  symlinkSync(victim, join(dir, ".forge", `config.yml.tmp-${process.pid}`));

  writeProjectKey(dir, "pk-safe");

  assert.equal(readFileSync(victim, "utf8"), "outside data\n", "planted temp symlink not followed");
  const raw = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(raw["project_key"], "pk-safe");
  assert.deepEqual(raw["unrelated"], { keep: "me" });
  assert.deepEqual(raw["backlog"], { prefix: "FG" });
});

// A successful atomic replacement must not leave a temp file behind in .forge.
test("atomic write: leaves no leftover temp file in .forge after a successful write", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeProjectKey(dir, "pk-clean");
  const entries = readdirSync(join(dir, ".forge"));
  assert.deepEqual(
    entries.filter((e) => e.includes(".tmp-")),
    [],
    "no leftover temp file",
  );
  assert.deepEqual(entries.sort(), ["config.yml"]);
});

test("writeBacklogConfig: setting prefix PRESERVES an already-committed project_key", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "project_key: pk-keepme\nbacklog:\n  prefix: FG\n");

  // A prefix-only write (e.g. `forge init`) must not clear the durable key.
  writeBacklogConfig(dir, { prefix: "ZZ" });

  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, "pk-keepme");
  assert.equal(cfg.prefix, "ZZ");
});
