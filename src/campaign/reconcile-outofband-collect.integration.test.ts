// FG-443: integration coverage for collectOutOfBandEvidence / commitTouchesOnlyNonCodePaths
// — real temp git repo (real commits, real merge-base ancestor/root/merge shapes) and
// a real in-memory store DB with inserted host-verification rows and events.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { logEvent } from "../store/events.js";
import { collectOutOfBandEvidence, commitTouchesOnlyNonCodePaths } from "./reconcile-outofband-collect.js";
import { evaluateOutOfBandEvidence } from "./reconcile-outofband-evidence.js";
import type { CampaignItem } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function commitFile(relPath: string, content: string, message: string): string {
  const full = join(projectDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", message], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function item(overrides: Partial<CampaignItem> = {}): CampaignItem {
  return {
    id: "citem-1",
    campaignId: "campaign-1",
    itemOrder: 0,
    ticketId: "FG-400",
    lifecycleStatus: "awaiting_gate",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "reconcile-oob-collect-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// ── commitTouchesOnlyNonCodePaths ──────────────────────────────────────────────

test("commitTouchesOnlyNonCodePaths: true when the commit touches only docs/", () => {
  commitFile("README.md", "root readme", "root");
  const commit = commitFile("docs/guide.md", "docs change", "docs: guide");
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), true);
});

test("commitTouchesOnlyNonCodePaths: true when the commit touches only a markdown file outside docs/", () => {
  commitFile("README.md", "root readme", "root");
  const commit = commitFile("CHANGELOG.md", "notes", "docs: changelog");
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), true);
});

test("commitTouchesOnlyNonCodePaths: false when the commit touches a code path outside the allowlist", () => {
  commitFile("README.md", "root readme", "root");
  const commit = commitFile("src/index.ts", "export const a = 1;\n", "feat: add index");
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: true when the commit touches only docs/*.mdx and docs/*.txt", () => {
  commitFile("README.md", "root readme", "root");
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "guide.mdx"), "mdx guide");
  writeFileSync(join(projectDir, "docs", "notes.txt"), "plain notes");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "docs: mdx and txt"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), true);
});

test("commitTouchesOnlyNonCodePaths: false when the commit touches docs/tool.ts (code under docs/)", () => {
  commitFile("README.md", "root readme", "root");
  const commit = commitFile("docs/tool.ts", "export const a = 1;\n", "feat: sneak code into docs");
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: false when the commit touches docs/deploy.sh (code under docs/)", () => {
  commitFile("README.md", "root readme", "root");
  const commit = commitFile("docs/deploy.sh", "#!/bin/sh\necho deploying\n", "feat: sneak script into docs");
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: false when the commit mixes docs/readme.md and docs/tool.ts", () => {
  commitFile("README.md", "root readme", "root");
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "readme.md"), "docs readme");
  writeFileSync(join(projectDir, "docs", "tool.ts"), "export const a = 1;\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "mixed docs and code under docs/"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: false when the commit mixes a docs path and a code path", () => {
  commitFile("README.md", "root readme", "root");
  writeFileSync(join(projectDir, "docs.md"), "docs");
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "index.ts"), "export const a = 1;\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "mixed"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: false (safe-deny) for a root commit — zero parents is ambiguous", () => {
  const commit = commitFile("docs/first.md", "first", "root docs commit");
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: false (safe-deny) for a merge commit — two parents is ambiguous", () => {
  commitFile("README.md", "root readme", "root");
  gitExec(["checkout", "-b", "side"], projectDir);
  commitFile("docs/side.md", "side docs", "side docs change");
  gitExec(["checkout", "main"], projectDir);
  commitFile("docs/main.md", "main docs", "main docs change");
  gitExec(["merge", "--no-ff", "-m", "merge side into main", "side"], projectDir);
  const mergeCommit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, mergeCommit), false);
});

test("commitTouchesOnlyNonCodePaths: false (safe-deny) for an empty commit — no changed paths", () => {
  commitFile("README.md", "root readme", "root");
  gitExec(["commit", "--allow-empty", "-m", "empty"], projectDir);
  const emptyCommit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, emptyCommit), false);
});

test("commitTouchesOnlyNonCodePaths: false for an unknown/malformed sha (git error)", () => {
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), false);
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, "--upload-pack=evil"), false);
});

// ── mode/object-type checks (executable, chmod-only, symlink) ─────────────────

test("commitTouchesOnlyNonCodePaths: false when a new docs/*.md is added with the executable bit set (shebang + chmod +x)", () => {
  commitFile("README.md", "root readme", "root");
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  const full = join(projectDir, "docs", "x.md");
  writeFileSync(full, "#!/bin/sh\necho hi\n");
  chmodSync(full, 0o755);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "docs: add executable disguised as md"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: false when a commit only flips an already-tracked docs/*.md to executable (blob unchanged)", () => {
  commitFile("README.md", "root readme", "root");
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  const full = join(projectDir, "docs", "x.md");
  writeFileSync(full, "plain docs content\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "docs: add x.md"], projectDir);

  chmodSync(full, 0o755);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "chmod +x docs/x.md"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: false when a commit replaces docs/*.md with a symlink to an executable", () => {
  commitFile("README.md", "root readme", "root");
  mkdirSync(join(projectDir, "bin"), { recursive: true });
  const targetFull = join(projectDir, "bin", "real-tool.sh");
  writeFileSync(targetFull, "#!/bin/sh\necho real\n");
  chmodSync(targetFull, 0o755);
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  const docFull = join(projectDir, "docs", "x.md");
  writeFileSync(docFull, "plain docs content\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "docs: add x.md and bin/real-tool.sh"], projectDir);

  rmSync(docFull);
  symlinkSync("../bin/real-tool.sh", docFull);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "docs: replace x.md with a symlink"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), false);
});

test("commitTouchesOnlyNonCodePaths: true when the commit touches only a plain non-executable docs/*.md (mode 100644, unchanged happy path)", () => {
  commitFile("README.md", "root readme", "root");
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  const full = join(projectDir, "docs", "x.md");
  writeFileSync(full, "plain docs content\n");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "docs: add plain x.md"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), true);
});

test("commitTouchesOnlyNonCodePaths: true for a docs/*.md file with a unicode filename (no false-deny from git's default path quoting)", () => {
  commitFile("README.md", "root readme", "root");
  const commit = commitFile("docs/résumé.md", "unicode docs file", "docs: résumé");
  assert.equal(commitTouchesOnlyNonCodePaths(projectDir, commit), true);
});

// ── collectOutOfBandEvidence: lane evidence derivation ─────────────────────────

test("collectOutOfBandEvidence: docs-only commit → laneEvidence kind=non_code_diff, no host-verification lookup needed", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("docs/FG-400.md", "docs", "docs: FG-400");
  writeTicket(projectDir, { id: "FG-400", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });

  const result = collectOutOfBandEvidence(projectDir, item());
  assert.deepEqual(result.laneEvidence, { kind: "non_code_diff" });
  assert.equal(result.closedCommitReachableOnBase, true);
});

test("collectOutOfBandEvidence: code-touching commit + recorded/all-exit-zero host verification → laneEvidence kind=host_verification", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-401");
  writeTicket(projectDir, { id: "FG-401", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-401",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-401" }));
  assert.deepEqual(result.laneEvidence, { kind: "host_verification", recorded: true, allExitZero: true });
});

test("collectOutOfBandEvidence: code disguised as docs (docs/tool.ts) is NOT satisfied by the docs path — falls through to host-verification, absent → laneEvidence null (lane_evidence_missing)", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("docs/tool.ts", "export const x = 1;\n", "feat: FG-409 sneak code into docs");
  writeTicket(projectDir, { id: "FG-409", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-409" }));
  assert.equal(result.laneEvidence, null, "docs/tool.ts must not be classified as non_code_diff");
  const evaluation = evaluateOutOfBandEvidence(result);
  assert.equal(evaluation.eligible, false);
  assert.ok(evaluation.missing.includes("lane_evidence_missing"));
});

test("collectOutOfBandEvidence: docs/*.md with the executable bit set is NOT satisfied by the docs lane — falls through to host verification, absent → laneEvidence null (lane_evidence_missing)", () => {
  commitFile("README.md", "root", "root");
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  const full = join(projectDir, "docs", "x.md");
  writeFileSync(full, "#!/bin/sh\necho hi\n");
  chmodSync(full, 0o755);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "feat: FG-411 executable docs"], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  writeTicket(projectDir, { id: "FG-411", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-411" }));
  assert.equal(result.laneEvidence, null, "executable docs/x.md must not be classified as non_code_diff");
  const evaluation = evaluateOutOfBandEvidence(result);
  assert.equal(evaluation.eligible, false);
  assert.ok(evaluation.missing.includes("lane_evidence_missing"));
});

test("collectOutOfBandEvidence: code disguised as docs (docs/deploy.sh) with a recorded host verification → laneEvidence kind=host_verification", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("docs/deploy.sh", "#!/bin/sh\necho deploying\n", "feat: FG-410 sneak script into docs");
  writeTicket(projectDir, { id: "FG-410", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-410",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-410" }));
  assert.deepEqual(result.laneEvidence, { kind: "host_verification", recorded: true, allExitZero: true });
});

test("collectOutOfBandEvidence: code-touching commit with NO host verification recorded → laneEvidence null", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-402");
  writeTicket(projectDir, { id: "FG-402", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-402" }));
  assert.equal(result.laneEvidence, null);
});

test("collectOutOfBandEvidence: code-touching commit with a host-verification row that has a non-zero exit code → laneEvidence null", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-403");
  writeTicket(projectDir, { id: "FG-403", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-403",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-403" }));
  assert.equal(result.laneEvidence, null);
});

test("collectOutOfBandEvidence: spoofing guard — a host_verifications row for the WRONG commit sha does not satisfy lane evidence", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-404");
  writeTicket(projectDir, { id: "FG-404", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-404",
    projectDir,
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-404" }));
  assert.equal(result.laneEvidence, null);
});

test("collectOutOfBandEvidence: laneEvidence null when there is no closedCommit at all", () => {
  writeTicket(projectDir, { id: "FG-405", type: "story", status: "active", title: "t", body: "" });
  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-405" }));
  assert.equal(result.laneEvidence, null);
  assert.equal(result.closedCommitReachableOnBase, null);
});

test("collectOutOfBandEvidence: ticket unreadable — facts stay undefined, no throw", () => {
  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-DOES-NOT-EXIST" }));
  assert.equal(result.ticketStatus, undefined);
  assert.equal(result.ticketClosedCommit, undefined);
  assert.equal(result.laneEvidence, null);
});

// ── item.runId's event history is never consulted ──────────────────────────────

test("collectOutOfBandEvidence: never reads item.runId's event history — collection succeeds even with a disqualifying event log", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("docs/FG-406.md", "docs", "docs: FG-406");
  writeTicket(projectDir, { id: "FG-406", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });

  const runId = "run-with-failing-verdicts";
  // A run whose event log would fail evaluateReconcileEvidence's fact 5 outright:
  // a fail verdict with no later pass or qualifying force-advance. If this
  // collector ever consulted item.runId's events, it would have no way to derive
  // laneEvidence from them (the shape doesn't even resemble lane evidence) —
  // asserting the docs lane still resolves proves runId is never touched.
  logEvent("verdict.received", { runId, payload: { redRole: "r", verdict: "fail", authority: "authoritative" } });

  const withRunId = item({ ticketId: "FG-406", runId });
  const withoutRunId = item({ ticketId: "FG-406", runId: undefined });

  const resultWithRunId = collectOutOfBandEvidence(projectDir, withRunId);
  const resultWithoutRunId = collectOutOfBandEvidence(projectDir, withoutRunId);

  assert.deepEqual(resultWithRunId.laneEvidence, { kind: "non_code_diff" });
  assert.deepEqual(resultWithRunId, resultWithoutRunId, "runId must have zero effect on the collected evidence");
});

// ── closedCommitReachableOnBase reuse (checkClosedCommitReachableOnBase) ───────

test("collectOutOfBandEvidence: closedCommitReachableOnBase false when the commit is on a branch never merged to main", () => {
  commitFile("README.md", "main-base", "root");
  gitExec(["checkout", "-b", "feature/off-main-oob"], projectDir);
  const offMainCommit = commitFile("docs/off-main.md", "off", "docs off main");
  gitExec(["checkout", "main"], projectDir);

  writeTicket(projectDir, { id: "FG-407", type: "story", status: "done", closedCommit: offMainCommit, title: "t", body: "" });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-407" }));
  assert.equal(result.closedCommitReachableOnBase, false);
});

test("collectOutOfBandEvidence: closedCommitReachableOnBase respects a configured baseBranch other than main", () => {
  commitFile("README.md", "main-base", "root");
  gitExec(["checkout", "-b", "release"], projectDir);
  const releaseCommit = commitFile("docs/release.md", "release", "docs release");
  gitExec(["checkout", "main"], projectDir);

  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ baseBranch: "release" }));

  writeTicket(projectDir, { id: "FG-408", type: "story", status: "done", closedCommit: releaseCommit, title: "t", body: "" });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-408" }));
  assert.equal(result.closedCommitReachableOnBase, true, "reachable on the configured 'release' base, not main");
});

// ── FG-452: ancestry + base-reachability coverage replaces exact-sha (AC2/AC3) ──
//
// FG-440 records the tested CURRENT BASE HEAD, not closedCommit — a real
// reconcile-captured row's commit_sha is almost always a later commit than the
// ticket's closedCommit. The pre-FG-452 exact-sha query could never match such a
// row (that was the FG-422 wedge); collectOutOfBandEvidence must now match by
// ancestry (closedCommit is an ancestor of the row's tested sha) AND
// base-reachability (that tested sha is itself on the configured base branch).

test("collectOutOfBandEvidence: FG-452 AC2 — a row recorded at a LATER base HEAD than closedCommit (not an exact-sha match) still satisfies the host_verification lane", () => {
  commitFile("README.md", "root", "root");
  const closedCommit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-450");
  writeTicket(projectDir, { id: "FG-450", type: "story", status: "done", closedCommit, title: "t", body: "" });
  // Mirrors FG-440's reconcile-time capture: the row is recorded at the CURRENT
  // base HEAD (one commit later than closedCommit), never at closedCommit itself.
  const testedHead = commitFile("later.txt", "later", "close FG-450");
  insertHostVerification({
    ticketId: "FG-450",
    projectDir,
    commitSha: testedHead,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-450" }));
  assert.notEqual(testedHead, closedCommit, "precondition: the row's tested sha is NOT the exact closedCommit");
  assert.deepEqual(result.laneEvidence, { kind: "host_verification", recorded: true, allExitZero: true });
});

test("collectOutOfBandEvidence: FG-452 AC2 — passing-row model preserved: a failing covering row does not satisfy the lane, but a later passing covering row does, and both coexist", () => {
  commitFile("README.md", "root", "root");
  const closedCommit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-460");
  writeTicket(projectDir, { id: "FG-460", type: "story", status: "done", closedCommit, title: "t", body: "" });

  const failingTestedHead = commitFile("close-1.txt", "close 1", "close FG-460 (attempt 1)");
  insertHostVerification({
    ticketId: "FG-460",
    projectDir,
    commitSha: failingTestedHead,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 3,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  let result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-460" }));
  assert.equal(result.laneEvidence, null, "a covering row that failed must not satisfy the lane");

  const passingTestedHead = commitFile("close-2.txt", "close 2", "close FG-460 (attempt 2, fixed)");
  insertHostVerification({
    ticketId: "FG-460",
    projectDir,
    commitSha: passingTestedHead,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-02T00:00:00Z",
  });

  result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-460" }));
  assert.deepEqual(
    result.laneEvidence,
    { kind: "host_verification", recorded: true, allExitZero: true },
    "a later real green must satisfy the lane even though an earlier covering row failed"
  );
});

test("collectOutOfBandEvidence: FG-452 AC3 (negative) — a row whose commit_sha closedCommit is NOT an ancestor of does not satisfy the lane", () => {
  const earlierCommit = commitFile("early.txt", "early", "early base commit");
  commitFile("README.md", "root readme", "root");
  const closedCommit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-451");
  writeTicket(projectDir, { id: "FG-451", type: "story", status: "done", closedCommit, title: "t", body: "" });

  // earlierCommit predates closedCommit in history — closedCommit cannot be an
  // ancestor of a commit that came before it.
  insertHostVerification({
    ticketId: "FG-451",
    projectDir,
    commitSha: earlierCommit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-451" }));
  assert.equal(
    result.laneEvidence,
    null,
    "a row whose tested sha does not descend from closedCommit must not satisfy the lane"
  );
});

test("collectOutOfBandEvidence: FG-452 AC3 (negative) — a row whose tested sha descends from closedCommit but is NOT itself reachable on base does not satisfy the lane", () => {
  commitFile("README.md", "root readme", "root");
  const closedCommit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-452a");
  writeTicket(projectDir, { id: "FG-452a", type: "story", status: "done", closedCommit, title: "t", body: "" });

  gitExec(["checkout", "-b", "off-branch-verify"], projectDir);
  const offBranchHead = commitFile("off-branch.txt", "off branch", "off-branch build, never merged");
  gitExec(["checkout", "main"], projectDir);

  insertHostVerification({
    ticketId: "FG-452a",
    projectDir,
    commitSha: offBranchHead,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-452a" }));
  assert.equal(
    result.laneEvidence,
    null,
    "closedCommit IS an ancestor of offBranchHead, but offBranchHead itself was never merged to base — must not satisfy the lane"
  );
});

// ── FG-500 round 2: the collectOutOfBandEvidence host_verification lane must
// cover the FULL derived gate list, not just requiredGate — same shared
// evaluator reconcile-collect.ts's pre-check and done-audit/collect.ts use.

function writePackageJsonWithGateScripts(): void {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      { name: "synthetic", version: "0.0.0", scripts: { "test:all": "exit 0", "test:extended": "exit 0" } },
      null,
      2
    )
  );
}

test("FG-500 round 2: a fast-only passing row on a tiered project does NOT satisfy the host_verification lane", () => {
  writePackageJsonWithGateScripts();
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-460 tiered, fast-only");
  writeTicket(projectDir, { id: "FG-460", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-460",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-460" }));
  assert.equal(
    result.laneEvidence,
    null,
    "fast-tier-only evidence must not satisfy a tiered project's lane — the extended tier has no covering row yet"
  );
});

test("FG-500 round 2: passing rows for BOTH the fast and extended gate satisfy the host_verification lane", () => {
  writePackageJsonWithGateScripts();
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-461 tiered, both pass");
  writeTicket(projectDir, { id: "FG-461", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-461",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  insertHostVerification({
    ticketId: "FG-461",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:extended",
    command: "npm run test:extended",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:01Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-461" }));
  assert.deepEqual(result.laneEvidence, { kind: "host_verification", recorded: true, allExitZero: true });
});

test("FG-500 round 2: a ci-sourced passing row for the primary gate alone satisfies the host_verification lane (whole-workflow evidence)", () => {
  writePackageJsonWithGateScripts();
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-462 tiered, ci-sourced primary only");
  writeTicket(projectDir, { id: "FG-462", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-462",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
    source: "ci",
    ciUrl: "https://example.test/run/1",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-462" }));
  assert.deepEqual(
    result.laneEvidence,
    { kind: "host_verification", recorded: true, allExitZero: true },
    "a ci-sourced primary pass is whole-workflow evidence — no separate extended-tier row is needed"
  );
});

test("FG-500 round 2 regression: a single-gate project (no test:extended) still satisfies the lane from one row, unchanged", () => {
  commitFile("README.md", "root", "root");
  const commit = commitFile("src/feature.ts", "export const x = 1;\n", "feat: FG-463 single-gate regression");
  writeTicket(projectDir, { id: "FG-463", type: "story", status: "done", closedCommit: commit, title: "t", body: "" });
  insertHostVerification({
    ticketId: "FG-463",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectOutOfBandEvidence(projectDir, item({ ticketId: "FG-463" }));
  assert.deepEqual(result.laneEvidence, { kind: "host_verification", recorded: true, allExitZero: true });
});
