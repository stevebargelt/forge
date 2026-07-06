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

// A sleepFn stand-in that never actually waits, so settle-path tests run fast
// and deterministically instead of burning the real ~250ms x 3 delay.
function fakeSleep(onSleep?: () => void) {
  return async () => { onSleep?.(); };
}

beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), "forge-persist-")); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

test("checkResultPersistence: complete + files_modified all missing → loss (the /workspace bug)", async () => {
  const result = { status: "complete", files_modified: ["package.json", "src/styles/tokens.css", "astro.config.mjs"] };
  const c = await checkResultPersistence(projectDir, result, { sleepFn: fakeSleep() });
  assert.equal(c.ok, false);
  if (!c.ok) assert.deepEqual(c.missing, result.files_modified);
});

test("checkResultPersistence: complete + every claimed file present → ok", async () => {
  touch("package.json"); touch("src/styles/tokens.css");
  const c = await checkResultPersistence(projectDir, { status: "complete", files_modified: ["package.json", "src/styles/tokens.css"] });
  assert.equal(c.ok, true);
});

test("checkResultPersistence: partial presence is NOT flagged (legit create+delete mix)", async () => {
  touch("kept.ts"); // one of two exists; "removed.ts" was deleted
  const c = await checkResultPersistence(projectDir, { status: "complete", files_modified: ["kept.ts", "removed.ts"] });
  assert.equal(c.ok, true, "only total absence is treated as loss");
});

test("checkResultPersistence: empty files_modified → ok (nothing claimed)", async () => {
  assert.equal((await checkResultPersistence(projectDir, { status: "complete", files_modified: [] })).ok, true);
});

test("checkResultPersistence: missing files_modified field → ok (e.g. a red verdict)", async () => {
  assert.equal((await checkResultPersistence(projectDir, { status: "complete", verdict: "pass" })).ok, true);
});

test("checkResultPersistence: status=failed is never asserted (don't double-fail)", async () => {
  const c = await checkResultPersistence(projectDir, { status: "failed", files_modified: ["never.ts"] });
  assert.equal(c.ok, true);
});

test("checkResultPersistence: non-object / null result → ok", async () => {
  assert.equal((await checkResultPersistence(projectDir, undefined)).ok, true);
  assert.equal((await checkResultPersistence(projectDir, "nope")).ok, true);
  assert.equal((await checkResultPersistence(projectDir, ["a"])).ok, true);
});

test("checkResultPersistence: absolute /project/... paths resolve under the host project dir", async () => {
  touch("src/index.ts");
  const present = await checkResultPersistence(projectDir, { status: "complete", files_modified: ["/project/src/index.ts"] });
  assert.equal(present.ok, true);
  const absent = await checkResultPersistence(projectDir, { status: "complete", files_modified: ["/project/src/gone.ts"] }, { sleepFn: fakeSleep() });
  assert.equal(absent.ok, false);
});

test("checkResultPersistence: an absolute path outside the project mount (/workspace/...) counts as missing", async () => {
  const c = await checkResultPersistence(projectDir, { status: "complete", files_modified: ["/workspace/package.json"] }, { sleepFn: fakeSleep() });
  assert.equal(c.ok, false, "a /workspace path has no host equivalent → loss");
});

test("checkResultPersistence: ignores non-string entries in files_modified", async () => {
  touch("real.ts");
  const c = await checkResultPersistence(projectDir, { status: "complete", files_modified: ["real.ts", 42, null] });
  assert.equal(c.ok, true);
});

test("persistenceErrorMessage: names the count and samples up to 5 files", () => {
  const msg = persistenceErrorMessage({ claimed: ["a", "b", "c", "d", "e", "f"], missing: ["a", "b", "c", "d", "e", "f"] });
  assert.match(msg, /6 modified file/);
  assert.match(msg, /\+1 more/);
  assert.match(msg, /\/workspace/);
});

// FG-377: DEC-019 shadow-volume / gRPC-FUSE sync lag can make a claimed file
// appear absent for a beat after the container reports complete. The
// checker must give the host mount a bounded chance to settle before it
// declares total loss.

test("FG-377: files absent on first stat but present within the settle window are NOT reported as loss", async () => {
  const rel = "src/late-sync.ts";
  let statCalls = 0;
  // Simulate the file landing on the host mid-retry: absent on the initial
  // check plus one retry, present from the second retry onward.
  const existsFn = (p: string) => {
    if (!p.endsWith(rel)) return false;
    statCalls++;
    return statCalls >= 3;
  };
  const c = await checkResultPersistence(
    projectDir,
    { status: "complete", files_modified: [rel] },
    { existsFn, sleepFn: fakeSleep() },
  );
  assert.equal(c.ok, true, "file appeared during the settle window, so this is not loss");
  assert.ok(statCalls >= 3, "expected multiple re-stat attempts across the settle window");
});

test("FG-377: files that stay absent through the entire settle window are still reported as loss", async () => {
  let sleeps = 0;
  const c = await checkResultPersistence(
    projectDir,
    { status: "complete", files_modified: ["never-lands.ts"] },
    { sleepFn: fakeSleep(() => { sleeps++; }) },
  );
  assert.equal(c.ok, false, "genuine total loss must still fail after settling");
  assert.ok(sleeps > 0, "expected the settle window to have run");
});

test("FG-377: the common already-synced case returns immediately without invoking the settle/sleep path", async () => {
  touch("package.json");
  let sleepCalls = 0;
  const c = await checkResultPersistence(
    projectDir,
    { status: "complete", files_modified: ["package.json"] },
    { sleepFn: fakeSleep(() => { sleepCalls++; }) },
  );
  assert.equal(c.ok, true);
  assert.equal(sleepCalls, 0, "files present on the first check must not trigger the settle/sleep path");
});
