import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectMount } from "./resolve-project-mount.js";

let dir: string;
let stderrLines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-rpmount-"));
  stderrLines = [];
  mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mock.restoreAll();
});

function makeGitRoot(root: string) {
  mkdirSync(join(root, ".git"), { recursive: true });
}

function makeSubdir(root: string, rel: string): string {
  const sub = join(root, rel);
  mkdirSync(sub, { recursive: true });
  return sub;
}

test("non-subdir passthrough: explicit git root mounts base unchanged", () => {
  makeGitRoot(dir);
  const result = resolveProjectMount(dir, { isTTY: false, json: false, allowSubproject: false });
  assert.equal(result.projectDir, dir);
  assert.equal(result.resolvedFromSubdir, false);
  assert.equal(result.explicitSubproject, false);
});

test("non-subdir passthrough: non-git standalone dir mounts base unchanged", () => {
  const result = resolveProjectMount(dir, { isTTY: false, json: false, allowSubproject: false });
  assert.equal(result.projectDir, dir);
  assert.equal(result.resolvedFromSubdir, false);
  assert.equal(result.explicitSubproject, false);
});

test("implicit subdir → root (confident: has package.json)", () => {
  makeGitRoot(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  const sub = makeSubdir(dir, "dashboard");
  // requestedDir=undefined means implicit; inject cwd=sub to simulate running from subdir
  const result = resolveProjectMount(undefined, { isTTY: false, json: false, allowSubproject: false }, sub);
  assert.equal(result.projectDir, dir);
  assert.equal(result.resolvedFromSubdir, true);
  assert.equal(result.explicitSubproject, false);
  assert.ok(stderrLines.some((l) => l.includes("resolved project root")));
});

test("implicit subdir → root (confident: has .forge)", () => {
  makeGitRoot(dir);
  mkdirSync(join(dir, ".forge"), { recursive: true });
  const sub = makeSubdir(dir, "apps/web");
  const result = resolveProjectMount(undefined, { isTTY: false, json: false, allowSubproject: false }, sub);
  assert.equal(result.projectDir, dir);
  assert.equal(result.resolvedFromSubdir, true);
});

test("implicit subdir → hard-fail when root has no confident markers", () => {
  makeGitRoot(dir);
  // Root has .git but no .forge or package.json
  const sub = makeSubdir(dir, "pkg/foo");
  assert.throws(
    () => resolveProjectMount(undefined, { isTTY: false, json: false, allowSubproject: false }, sub),
    /run from the project root/
  );
});

test("explicit subdir + automation (!isTTY) → hard-fail", () => {
  makeGitRoot(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  const sub = makeSubdir(dir, "dashboard");
  assert.throws(
    () => resolveProjectMount(sub, { isTTY: false, json: false, allowSubproject: false }),
    /is a subdirectory of/
  );
});

test("explicit subdir + json=true (automation) → hard-fail", () => {
  makeGitRoot(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  const sub = makeSubdir(dir, "dashboard");
  assert.throws(
    () => resolveProjectMount(sub, { isTTY: true, json: true, allowSubproject: false }),
    /is a subdirectory of/
  );
});

test("explicit subdir + --allow-subproject → honor, explicitSubproject=true", () => {
  makeGitRoot(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  const sub = makeSubdir(dir, "dashboard");
  const result = resolveProjectMount(sub, { isTTY: false, json: false, allowSubproject: true });
  assert.equal(result.projectDir, sub);
  assert.equal(result.explicitSubproject, true);
  assert.equal(result.resolvedFromSubdir, false);
});

test("explicit subdir + interactive (isTTY && !json) → warn and honor", () => {
  makeGitRoot(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  const sub = makeSubdir(dir, "dashboard");
  const result = resolveProjectMount(sub, { isTTY: true, json: false, allowSubproject: false });
  assert.equal(result.projectDir, sub);
  assert.equal(result.explicitSubproject, false);
  assert.ok(stderrLines.some((l) => l.includes("cross-workspace deps may be missing")));
});

test("invocationCwd is always recorded", () => {
  const result = resolveProjectMount(dir, { isTTY: false, json: false, allowSubproject: false });
  assert.equal(typeof result.invocationCwd, "string");
  assert.ok(result.invocationCwd.length > 0);
});
