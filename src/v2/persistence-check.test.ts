import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkResultPersistence, persistenceErrorMessage } from "./persistence-check.js";

let projectDir: string;

function touch(rel: string) {
  const p = join(projectDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "x");
}

beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), "forge-persist-")); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

test("checkResultPersistence: complete + files_modified all missing → loss (the /workspace bug)", () => {
  const result = { status: "complete", files_modified: ["package.json", "src/styles/tokens.css", "astro.config.mjs"] };
  const c = checkResultPersistence(projectDir, result);
  assert.equal(c.ok, false);
  if (!c.ok) assert.deepEqual(c.missing, result.files_modified);
});

test("checkResultPersistence: complete + every claimed file present → ok", () => {
  touch("package.json"); touch("src/styles/tokens.css");
  const c = checkResultPersistence(projectDir, { status: "complete", files_modified: ["package.json", "src/styles/tokens.css"] });
  assert.equal(c.ok, true);
});

test("checkResultPersistence: partial presence is NOT flagged (legit create+delete mix)", () => {
  touch("kept.ts"); // one of two exists; "removed.ts" was deleted
  const c = checkResultPersistence(projectDir, { status: "complete", files_modified: ["kept.ts", "removed.ts"] });
  assert.equal(c.ok, true, "only total absence is treated as loss");
});

test("checkResultPersistence: empty files_modified → ok (nothing claimed)", () => {
  assert.equal(checkResultPersistence(projectDir, { status: "complete", files_modified: [] }).ok, true);
});

test("checkResultPersistence: missing files_modified field → ok (e.g. a red verdict)", () => {
  assert.equal(checkResultPersistence(projectDir, { status: "complete", verdict: "pass" }).ok, true);
});

test("checkResultPersistence: status=failed is never asserted (don't double-fail)", () => {
  const c = checkResultPersistence(projectDir, { status: "failed", files_modified: ["never.ts"] });
  assert.equal(c.ok, true);
});

test("checkResultPersistence: non-object / null result → ok", () => {
  assert.equal(checkResultPersistence(projectDir, undefined).ok, true);
  assert.equal(checkResultPersistence(projectDir, "nope").ok, true);
  assert.equal(checkResultPersistence(projectDir, ["a"]).ok, true);
});

test("checkResultPersistence: absolute /project/... paths resolve under the host project dir", () => {
  touch("src/index.ts");
  const present = checkResultPersistence(projectDir, { status: "complete", files_modified: ["/project/src/index.ts"] });
  assert.equal(present.ok, true);
  const absent = checkResultPersistence(projectDir, { status: "complete", files_modified: ["/project/src/gone.ts"] });
  assert.equal(absent.ok, false);
});

test("checkResultPersistence: an absolute path outside the project mount (/workspace/...) counts as missing", () => {
  const c = checkResultPersistence(projectDir, { status: "complete", files_modified: ["/workspace/package.json"] });
  assert.equal(c.ok, false, "a /workspace path has no host equivalent → loss");
});

test("checkResultPersistence: ignores non-string entries in files_modified", () => {
  touch("real.ts");
  const c = checkResultPersistence(projectDir, { status: "complete", files_modified: ["real.ts", 42, null] });
  assert.equal(c.ok, true);
});

test("persistenceErrorMessage: names the count and samples up to 5 files", () => {
  const msg = persistenceErrorMessage({ claimed: ["a", "b", "c", "d", "e", "f"], missing: ["a", "b", "c", "d", "e", "f"] });
  assert.match(msg, /6 modified file/);
  assert.match(msg, /\+1 more/);
  assert.match(msg, /\/workspace/);
});
