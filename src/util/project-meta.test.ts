import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectMeta, _clearCacheForTesting } from "./project-meta.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-project-meta-test-"));
  _clearCacheForTesting();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _clearCacheForTesting();
});

function writeVscodeColor(projectDir: string, color: string | null): void {
  mkdirSync(join(projectDir, ".vscode"), { recursive: true });
  const body = color === null
    ? JSON.stringify({ "workbench.colorCustomizations": {} })
    : JSON.stringify({
      "workbench.colorCustomizations": { "titleBar.activeBackground": color },
    });
  writeFileSync(join(projectDir, ".vscode", "settings.json"), body);
}

function writeProjectJson(projectDir: string, body: Record<string, unknown>): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "project.json"), JSON.stringify(body));
}

test("resolveProjectMeta: returns null for null projectDir", () => {
  assert.equal(resolveProjectMeta(null), null);
});

test("resolveProjectMeta: reads color from .vscode/settings.json when present", () => {
  writeVscodeColor(dir, "#6633CC");
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.color, "#6633CC");
});

test("resolveProjectMeta: label is the basename of projectDir", () => {
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, join(dir).split("/").pop());
});

test("resolveProjectMeta: falls back to hash color when .vscode/settings.json is missing", () => {
  // Don't write the file.
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.match(meta.color, /^hsl\(\d+, 65%, 50%\)$/);
});

test("resolveProjectMeta: falls back to hash color when .vscode/settings.json is malformed JSON", () => {
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  writeFileSync(join(dir, ".vscode", "settings.json"), "{ not valid json ");
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.match(meta.color, /^hsl\(\d+, 65%, 50%\)$/);
});

test("resolveProjectMeta: falls back to hash color when colorCustomizations.titleBar.activeBackground is absent", () => {
  writeVscodeColor(dir, null);  // writes the object but no titleBar.activeBackground key
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.match(meta.color, /^hsl\(\d+, 65%, 50%\)$/);
});

test("resolveProjectMeta: caches results — second call after file change returns first value", () => {
  // First call: no file → hash fallback.
  const first = resolveProjectMeta(dir);
  assert.ok(first);
  const firstColor = first.color;
  // Now write a .vscode color. Without the cache, the second call would pick it up.
  writeVscodeColor(dir, "#FF0000");
  const second = resolveProjectMeta(dir);
  assert.ok(second);
  assert.equal(second.color, firstColor, "cache should return the same color as the first call");
});

// ----- #151: .forge/project.json overrides -----

test("resolveProjectMeta: uses name from .forge/project.json when present (overrides basename)", () => {
  writeProjectJson(dir, { name: "Pocket — typing tutor" });
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, "Pocket — typing tutor");
});

test("resolveProjectMeta: reads description from .forge/project.json when present", () => {
  writeProjectJson(dir, { name: "Pocket", description: "split-keyboard pen-down trainer" });
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, "Pocket");
  assert.equal(meta.description, "split-keyboard pen-down trainer");
});

test("resolveProjectMeta: name override + .vscode color compose correctly", () => {
  writeProjectJson(dir, { name: "Friendly Name" });
  writeVscodeColor(dir, "#6633CC");
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, "Friendly Name");
  assert.equal(meta.color, "#6633CC");
});

test("resolveProjectMeta: falls back to basename when project.json is missing", () => {
  // No project.json written — should use basename as today.
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, join(dir).split("/").pop());
  assert.equal(meta.description, undefined);
});

test("resolveProjectMeta: falls back to basename when project.json is malformed JSON", () => {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "project.json"), "{ not valid json ");
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, join(dir).split("/").pop());
  assert.equal(meta.description, undefined);
});

test("resolveProjectMeta: falls back to basename when project.json has no name field", () => {
  writeProjectJson(dir, { description: "just description, no name" });
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, join(dir).split("/").pop());
  assert.equal(meta.description, "just description, no name");
});

test("resolveProjectMeta: ignores empty string name (falls back to basename)", () => {
  writeProjectJson(dir, { name: "" });
  const meta = resolveProjectMeta(dir);
  assert.ok(meta);
  assert.equal(meta.label, join(dir).split("/").pop());
});

// ----- existing tests continue -----

test("resolveProjectMeta: hash fallback is deterministic across calls", () => {
  // Use distinct projectDirs to avoid cache hits.
  const dirA = mkdtempSync(join(tmpdir(), "forge-pm-determ-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "forge-pm-determ-b-"));
  try {
    const a1 = resolveProjectMeta(dirA);
    _clearCacheForTesting();
    const a2 = resolveProjectMeta(dirA);
    assert.equal(a1?.color, a2?.color);
    const b = resolveProjectMeta(dirB);
    // Different inputs almost certainly yield different colors.
    assert.notEqual(a1?.color, b?.color);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
