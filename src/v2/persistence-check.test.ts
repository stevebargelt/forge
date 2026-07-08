import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkResultPersistence, persistenceErrorMessage, normalizeClaim } from "./persistence-check.js";

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

// FG-491: agent seeds ask for `path:line-range — why` refs in files_modified
// (a PR-review-comment shape), not bare paths. resolveHostPath() used to join
// the WHOLE annotated string as a literal path, so every annotated entry
// resolved to a path that could never exist — an all-annotated (and often
// fully real) result tripped the all-claims-missing signature and had its
// result discarded. These fixtures are the real preserved evidence shapes.

test("FG-491: AC form `path:line-range` — file exists on host → ok", async () => {
  touch("src/v2/invoke.ts");
  const c = await checkResultPersistence(projectDir, {
    status: "complete",
    files_modified: ["src/v2/invoke.ts:153-162"],
  });
  assert.equal(c.ok, true);
});

test("FG-491: AC form `path:line-range — prose` — file exists on host → ok", async () => {
  touch("src/v2/invoke.ts");
  const c = await checkResultPersistence(projectDir, {
    status: "complete",
    files_modified: [
      "src/v2/invoke.ts:153-162 — workflow_additions no longer embeds args.task; now frames the task as arriving via the input message (task package), with a comment explaining the FG-497 argv-size root cause",
    ],
  });
  assert.equal(c.ok, true);
});

test("FG-491: AC form `path (prose)` — file exists on host → ok", async () => {
  touch("src/campaign/fg484-auto-gate-cancel-race.integration.test.ts");
  const c = await checkResultPersistence(projectDir, {
    status: "complete",
    files_modified: ["src/campaign/fg484-auto-gate-cancel-race.integration.test.ts (new)"],
  });
  assert.equal(c.ok, true);
});

test("FG-491: comma-separated line-spec `path:9,90-115` — file exists on host → ok", async () => {
  touch("src/v2/run-finalize.test.ts");
  const c = await checkResultPersistence(projectDir, {
    status: "complete",
    files_modified: ["src/v2/run-finalize.test.ts:9,90-115"],
  });
  assert.equal(c.ok, true);
});

test("FG-491: preserved evidence shapes all resolve and pass when the referenced file exists", async () => {
  const shapes = [
    {
      claim:
        "src/v2/invoke.ts:153-162 — workflow_additions no longer embeds args.task; now frames the task as arriving via the input message (task package), with a comment explaining the FG-497 argv-size root cause",
      expected: "src/v2/invoke.ts",
    },
    {
      claim:
        'scripts/pi-context-proof.sh:1-122 (rewritten: header updated for FG-497, task package now written to a host dir bind-mounted at /task, run_pi references "@/task/package.md" instead of a positional TASK string, new WRAP assertion added, docker run gains a second -v mount for /task)',
      expected: "scripts/pi-context-proof.sh",
    },
    {
      claim: "seeds/runtimes/pi-apikey.yml:24-25",
      expected: "seeds/runtimes/pi-apikey.yml",
    },
    {
      claim: "src/cli/commands/show.ts:457-471 (orphanRecoveryMessage doc comment + signature, new isInvokeRun param)",
      expected: "src/cli/commands/show.ts",
    },
    {
      claim: "src/store/runs.ts:140-197",
      expected: "src/store/runs.ts",
    },
    {
      claim: "src/v2/run-finalize.test.ts:9,90-115",
      expected: "src/v2/run-finalize.test.ts",
    },
    {
      claim: "src/campaign/fg484-auto-gate-cancel-race.integration.test.ts (new)",
      expected: "src/campaign/fg484-auto-gate-cancel-race.integration.test.ts",
    },
    {
      claim:
        'src/campaign/executor.ts (import at ~line 26; probe comment + gating condition at lines 798-827, liveRun && liveRun.status === "active" && taskHasPipelineFinalize(liveRun))',
      expected: "src/campaign/executor.ts",
    },
  ];
  for (const { claim, expected } of shapes) {
    assert.equal(normalizeClaim(claim), expected, `expected normalizeClaim to yield ${expected} for claim: ${claim}`);
    projectDir = mkdtempSync(join(tmpdir(), "forge-persist-"));
    touch(expected);
    const c = await checkResultPersistence(projectDir, { status: "complete", files_modified: [claim] });
    assert.equal(c.ok, true, `expected ok:true for claim: ${claim} (expected: ${expected})`);
    rmSync(projectDir, { recursive: true, force: true });
  }
  projectDir = mkdtempSync(join(tmpdir(), "forge-persist-"));
});

test("FG-491: genuine loss still caught — annotated claims where no referenced file exists → loss", async () => {
  const result = {
    status: "complete",
    files_modified: [
      "src/totally/gone.ts:10-20 — this never landed",
      "src/also/missing.ts:5 (deleted by mistake)",
    ],
  };
  const c = await checkResultPersistence(projectDir, result, { sleepFn: fakeSleep() });
  assert.equal(c.ok, false);
  if (!c.ok) {
    assert.deepEqual(c.missing, result.files_modified);
    assert.deepEqual(c.unparseable, []);
    assert.equal(c.normalized["src/totally/gone.ts:10-20 — this never landed"], "src/totally/gone.ts");
  }
});

test("FG-491: genuine loss still caught — raw (non-annotated) claims where no file exists → loss (unchanged)", async () => {
  const result = { status: "complete", files_modified: ["a.ts", "b.ts"] };
  const c = await checkResultPersistence(projectDir, result, { sleepFn: fakeSleep() });
  assert.equal(c.ok, false);
  if (!c.ok) assert.deepEqual(c.missing, result.files_modified);
});

test("FG-491: partial presence with a mix of annotated and raw claims → ok (one landed)", async () => {
  touch("src/present.ts");
  const c = await checkResultPersistence(projectDir, {
    status: "complete",
    files_modified: ["src/present.ts:1-5 — landed fine", "src/absent.ts:9-10 — never landed"],
  });
  assert.equal(c.ok, true, "one claim resolved and exists, so this is not total loss");
});

test("FG-491: /workspace absolute path with annotation still has no host equivalent → loss", async () => {
  const c = await checkResultPersistence(
    projectDir,
    { status: "complete", files_modified: ["/workspace/foo.ts:1-5 — bad mount"] },
    { sleepFn: fakeSleep() },
  );
  assert.equal(c.ok, false, "outside the project mount even after normalization → still missing");
  if (!c.ok) {
    assert.equal(c.normalized["/workspace/foo.ts:1-5 — bad mount"], "/workspace/foo.ts");
    assert.deepEqual(c.unparseable, []);
  }
});

test("FG-491: /project/-prefixed absolute path with annotation maps into projectDir correctly", async () => {
  touch("src/index.ts");
  const c = await checkResultPersistence(projectDir, {
    status: "complete",
    files_modified: ["/project/src/index.ts:1-5 — entrypoint tweak"],
  });
  assert.equal(c.ok, true);
});

test("FG-491: all-unparseable claims (no usable path token) still fail closed and are listed as unparseable", async () => {
  const result = {
    status: "complete",
    files_modified: ["   ", ":1-5", "()"],
  };
  const c = await checkResultPersistence(projectDir, result, { sleepFn: fakeSleep() });
  assert.equal(c.ok, false, "an unparseable claim must never count as proof of persistence");
  if (!c.ok) {
    assert.deepEqual(c.unparseable, result.files_modified);
    assert.deepEqual(c.missing, []);
  }
});

test("FG-491: normalization never turns an outside-project path into an inside-project one", async () => {
  // Even though the annotated suffix looks like it could be stripped down to
  // something under /project, the leading /workspace prefix must still resolve
  // to null (no host equivalent) — normalization only touches the path token,
  // it never rewrites the path's root.
  const c = await checkResultPersistence(
    projectDir,
    { status: "complete", files_modified: ["/workspace/project/src/sneaky.ts:1-2 — nope"] },
    { sleepFn: fakeSleep() },
  );
  assert.equal(c.ok, false);
});

test("FG-491: persistenceErrorMessage shows raw claims, normalized paths, missing, and unparseable", async () => {
  const result = {
    status: "complete",
    files_modified: ["src/gone.ts:1-2 — never landed", "   "],
  };
  const c = await checkResultPersistence(projectDir, result, { sleepFn: fakeSleep() });
  assert.equal(c.ok, false);
  if (c.ok) return;
  const msg = persistenceErrorMessage(c);
  assert.match(msg, /src\/gone\.ts:1-2 — never landed/);
  assert.match(msg, /src\/gone\.ts/);
  assert.match(msg, /Missing on host/);
  assert.match(msg, /unparseable|could not be parsed|no parseable path token/i);
});

test("FG-491: FG-377 settle window applies to normalized paths, not raw annotated claims", async () => {
  const rel = "src/late-sync.ts";
  let statCalls = 0;
  const existsFn = (p: string) => {
    if (!p.endsWith(rel)) return false;
    statCalls++;
    return statCalls >= 3;
  };
  const c = await checkResultPersistence(
    projectDir,
    { status: "complete", files_modified: [`${rel}:10-20 — landing late`] },
    { existsFn, sleepFn: fakeSleep() },
  );
  assert.equal(c.ok, true, "normalized path appeared during the settle window, so this is not loss");
  assert.ok(statCalls >= 3, "expected multiple re-stat attempts on the normalized path across the settle window");
});
