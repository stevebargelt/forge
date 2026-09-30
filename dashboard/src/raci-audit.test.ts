// FG-840: the one RACI audit reader — bounded tail, newest first, malformed lines
// counted rather than fatal, and the project-vs-host log choice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "fg840-audit-home-"));
process.env.FORGE_HOME = tmpHome;

const { AUDIT_TAIL_CHUNK_BYTES, AUDIT_TAIL_LINES, raciAuditTail, readAuditTail } = await import("./raci-audit.js");

const line = (n: number) => JSON.stringify({ timestamp: `2026-09-30T00:00:${String(n).padStart(2, "0")}Z`, action: "apply", n });

test("FG-840 readAuditTail: a missing log is an empty tail, not an error", () => {
  assert.deepEqual(readAuditTail(join(tmpHome, "absent.log")), { entries: [], skippedLines: 0 });
});

test("FG-840 readAuditTail: bounded to the last `limit` lines, newest first", () => {
  const path = join(tmpHome, "bounded.log");
  writeFileSync(path, Array.from({ length: AUDIT_TAIL_LINES + 5 }, (_, i) => line(i)).join("\n") + "\n");
  const tail = readAuditTail(path);
  assert.equal(tail.entries.length, AUDIT_TAIL_LINES);
  assert.equal(tail.entries[0]!["n"], AUDIT_TAIL_LINES + 4, "newest first");
  assert.equal(tail.entries[AUDIT_TAIL_LINES - 1]!["n"], 5, "older lines beyond the bound are not read");
  assert.deepEqual(readAuditTail(path, 3).entries.map((e) => e["n"]), [AUDIT_TAIL_LINES + 4, AUDIT_TAIL_LINES + 3, AUDIT_TAIL_LINES + 2]);
});

test("FG-840 readAuditTail: only the tail of a log larger than the read window is read", () => {
  const path = join(tmpHome, "huge.log");
  // A sparse head past V8's max string length: reading the whole file as UTF-8 throws ERR_STRING_TOO_LONG.
  writeFileSync(path, "");
  truncateSync(path, 600 * 1024 * 1024);
  appendFileSync(path, "\n" + Array.from({ length: AUDIT_TAIL_LINES + 5 }, (_, i) => line(i)).join("\n") + "\n");
  try {
    const tail = readAuditTail(path);
    assert.deepEqual(tail.entries.map((e) => e["n"]), Array.from({ length: AUDIT_TAIL_LINES }, (_, i) => AUDIT_TAIL_LINES + 4 - i));
    assert.equal(tail.skippedLines, 0);
  } finally {
    rmSync(path);
  }
});

test("FG-840 readAuditTail: lines longer than the read window, split mid-character, are reassembled whole", () => {
  const path = join(tmpHome, "long-lines.log");
  const long = (n: number) => JSON.stringify({ n, rationale: "é€".repeat(AUDIT_TAIL_CHUNK_BYTES / 3 + n) });
  writeFileSync(path, [long(1), "{not json", long(2), long(3)].join("\n") + "\n");
  const tail = readAuditTail(path, 3);
  assert.deepEqual(tail.entries.map((e) => e["n"]), [3, 2]);
  assert.equal(tail.skippedLines, 1);
  assert.deepEqual(tail.entries[0], JSON.parse(long(3)));
  assert.deepEqual(readAuditTail(path, 10).entries.map((e) => e["n"]), [3, 2, 1]);
});

test("FG-840 readAuditTail: malformed lines are skipped while complete FG-834 audit fields survive newest first", () => {
  const path = join(tmpHome, "malformed.log");
  const first = JSON.stringify({ n: 1, by: "terminal", rationale: "first", source: "terminal", candidate_sha256: "a".repeat(64) });
  const second = JSON.stringify({ n: 2, by: "dashboard", rationale: "second", source: "dashboard", candidate_sha256: "b".repeat(64) });
  writeFileSync(path, [first, "{not json", "", "[1,2]", "42", second, "   "].join("\n"));
  const tail = readAuditTail(path);
  assert.deepEqual(tail.entries.map((e) => e["n"]), [2, 1]);
  assert.equal(tail.skippedLines, 3);
  const { by: _secondBy, ...secondRest } = JSON.parse(second);
  const { by: _firstBy, ...firstRest } = JSON.parse(first);
  assert.deepEqual(tail.entries[0], { ...secondRest, actor: "dashboard" });
  assert.deepEqual(tail.entries[1], { ...firstRest, actor: "terminal" });
});

test("FG-840 readAuditTail: attribution is always `actor` — a `by` line is renamed, an `actor` line kept as written", () => {
  const path = join(tmpHome, "attribution.log");
  writeFileSync(path, [
    JSON.stringify({ n: 1, actor: "dashboard", source: "dashboard" }),
    JSON.stringify({ n: 2, by: "steve", rationale: "model policy" }),
    JSON.stringify({ n: 3, actor: "dashboard", by: "ignored" }),
  ].join("\n"));
  assert.deepEqual(readAuditTail(path).entries, [
    { n: 3, actor: "dashboard" },
    { n: 2, rationale: "model policy", actor: "steve" },
    { n: 1, actor: "dashboard", source: "dashboard" },
  ]);
});

test("FG-840 raciAuditTail: a scoped checkout reads its own .forge log; no scope reads the host log", () => {
  const checkout = mkdtempSync(join(tmpdir(), "fg840-audit-proj-"));
  mkdirSync(join(checkout, ".forge"));
  writeFileSync(join(checkout, ".forge", "raci-audit.log"), line(7) + "\n");
  writeFileSync(join(tmpHome, "raci-audit.log"), line(9) + "\n");

  const project = raciAuditTail(checkout);
  assert.equal(project.source, "project");
  assert.equal(project.path, join(checkout, ".forge", "raci-audit.log"));
  assert.deepEqual(project.entries.map((e) => e["n"]), [7]);

  const host = raciAuditTail();
  assert.equal(host.source, "host");
  assert.equal(host.path, join(tmpHome, "raci-audit.log"));
  assert.deepEqual(host.entries.map((e) => e["n"]), [9]);
});

test("FG-840 raciAuditTail: a scoped checkout with no audit log stays project-sourced and never falls back to host", () => {
  const checkout = mkdtempSync(join(tmpdir(), "fg840-audit-missing-proj-"));
  writeFileSync(join(tmpHome, "raci-audit.log"), line(99) + "\n");

  assert.deepEqual(raciAuditTail(checkout), {
    source: "project",
    path: join(checkout, ".forge", "raci-audit.log"),
    entries: [],
    skippedLines: 0,
  });
});

test("FG-840 raciAuditTail: a checkout reached through a symlinked parent reads the same project log", () => {
  const realParent = mkdtempSync(join(tmpdir(), "fg840-audit-real-parent-"));
  const checkout = join(realParent, "checkout");
  const aliasParent = join(tmpdir(), `fg840-audit-parent-alias-${Date.now()}`);
  mkdirSync(join(checkout, ".forge"), { recursive: true });
  writeFileSync(join(checkout, ".forge", "raci-audit.log"), line(42) + "\n");
  symlinkSync(realParent, aliasParent, "dir");

  const tail = raciAuditTail(join(aliasParent, "checkout"));
  assert.equal(tail.source, "project");
  assert.deepEqual(tail.entries.map((entry) => entry["n"]), [42]);
  assert.equal(realpathSync(tail.path), realpathSync(join(checkout, ".forge", "raci-audit.log")));
});

test("FG-840 raciAuditTail: a checkout whose .forge is a symlink outside the checkout is refused, not read", () => {
  const checkout = mkdtempSync(join(tmpdir(), "fg840-audit-forge-link-"));
  const outside = mkdtempSync(join(tmpdir(), "fg840-audit-outside-"));
  writeFileSync(join(outside, "raci-audit.log"), line(66) + "\n");
  symlinkSync(outside, join(checkout, ".forge"), "dir");

  assert.deepEqual(raciAuditTail(checkout), {
    source: "project",
    path: join(checkout, ".forge", "raci-audit.log"),
    entries: [],
    skippedLines: 0,
    refused: "outside_checkout_forge",
  });
});

test("FG-840 raciAuditTail: a raci-audit.log symlinked outside the checkout's .forge is refused, not read", () => {
  const checkout = mkdtempSync(join(tmpdir(), "fg840-audit-log-link-"));
  const outside = mkdtempSync(join(tmpdir(), "fg840-audit-outside-log-"));
  writeFileSync(join(outside, "secret.log"), line(77) + "\n");
  mkdirSync(join(checkout, ".forge"));
  symlinkSync(join(outside, "secret.log"), join(checkout, ".forge", "raci-audit.log"));

  const tail = raciAuditTail(checkout);
  assert.equal(tail.refused, "outside_checkout_forge");
  assert.deepEqual(tail.entries, []);
});
