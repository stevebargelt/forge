// FG-428: integration coverage for collectReconcileEvidence — real temp git repo
// (real commits, real merge-base ancestor/non-ancestor) and a real in-memory store
// DB with inserted host-verification rows and events.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { insertHostVerification, queryHostVerificationRows, queryHostVerificationRowsForGate } from "../store/host-verifications.js";
import { logEvent } from "../store/events.js";
import { collectReconcileEvidence, getRequiredHostGate, runAndRecordHostVerification } from "./reconcile-collect.js";
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

function makeCommit(label: string): string {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function item(overrides: Partial<CampaignItem> = {}): CampaignItem {
  return {
    id: "citem-1",
    campaignId: "campaign-1",
    itemOrder: 0,
    ticketId: "FG-200",
    lifecycleStatus: "failed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "reconcile-collect-"));
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

test("closedCommitReachableOnBase: true when the commit is an ancestor of main", () => {
  const commit = makeCommit("on-main");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Ancestor case",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, true);
  assert.equal(result.ticketStatus, "done");
  assert.equal(result.ticketClosedCommit, commit);
});

test("closedCommitReachableOnBase: false when the commit is on a branch never merged to main", () => {
  makeCommit("main-base");
  gitExec(["checkout", "-b", "feature/off-main"], projectDir);
  const offMainCommit = makeCommit("off-main-only");
  gitExec(["checkout", "main"], projectDir);

  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: offMainCommit,
    title: "Non-ancestor case",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, false);
});

test("closedCommitReachableOnBase respects a configured baseBranch other than main", () => {
  makeCommit("main-base");
  gitExec(["checkout", "-b", "release"], projectDir);
  const releaseCommit = makeCommit("release-only");
  gitExec(["checkout", "main"], projectDir);

  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ baseBranch: "release" }));

  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: releaseCommit,
    title: "Configured base branch",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, true, "reachable on the configured 'release' base, not main");
});

test("closedCommitReachableOnBase is null when closedCommit is malformed (option-injection guard)", () => {
  makeCommit("main-base-injection");
  // An operator-editable ticket frontmatter value crafted to be parsed as a git
  // option rather than a positional commit-ish, if it ever reached git unvalidated.
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: "--upload-pack=evil",
    title: "Malformed closedCommit",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, null, "a malformed closedCommit must never reach git as a positional arg");
});

test("closedCommitReachableOnBase is null when baseBranch is malformed (option-injection guard)", () => {
  const commit = makeCommit("main-base-injection-2");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ baseBranch: "--upload-pack=evil" }));
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Malformed baseBranch",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, null);
});

test("closedCommitReachableOnBase is null when there is no closedCommit", () => {
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "active",
    title: "No closed commit",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.equal(result.closedCommitReachableOnBase, null);
});

test("hostVerification: recorded true + passed true when a row for the actual closedCommit exits 0", () => {
  const commit = makeCommit("verified");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Verified",
    body: "",
  });
  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(result.hostVerification, { recorded: true, passed: true });
});

test("hostVerification: passed false when the only covering row for the closedCommit is non-zero", () => {
  const commit = makeCommit("mixed-verify");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Mixed",
    body: "",
  });
  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(result.hostVerification, { recorded: true, passed: false });
});

test("hostVerification: null when no rows recorded for the closedCommit", () => {
  const commit = makeCommit("unverified");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Unverified",
    body: "",
  });

  const result = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(result.hostVerification, { recorded: false, passed: false });
});

test("hostVerification respects a configured requiredHostGate", () => {
  const commit = makeCommit("custom-gate");
  writeTicket(projectDir, {
    id: "FG-200",
    type: "story",
    status: "done",
    closedCommit: commit,
    title: "Custom gate",
    body: "",
  });
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ requiredHostGate: "npm run verify" }));

  // A row under the DEFAULT gate name must not satisfy the configured gate.
  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  const wrongGate = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(wrongGate.hostVerification, { recorded: false, passed: false });

  insertHostVerification({
    ticketId: "FG-200",
    projectDir,
    commitSha: commit,
    gateName: "npm run verify",
    command: "npm run verify",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:01Z",
  });
  const rightGate = collectReconcileEvidence(projectDir, item());
  assert.deepEqual(rightGate.hostVerification, { recorded: true, passed: true });
});

test("events: ordered verdict.received and gate.decided events mapped by ascending event id", () => {
  const runId = "run-collect-1";
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "fail", authority: "authoritative" } });
  logEvent("gate.decided", { runId, payload: { decision: "advance", rationale: "override", force: true } });
  logEvent("verdict.received", { runId, payload: { redRole: "shipping-reviewer", verdict: "pass", authority: "authoritative" } });
  // Non-matching event types must be filtered out.
  logEvent("task.started", { runId });

  const result = collectReconcileEvidence(projectDir, item({ runId }));
  assert.equal(result.events.length, 3);
  assert.ok(result.events[0]!.id < result.events[1]!.id);
  assert.ok(result.events[1]!.id < result.events[2]!.id);

  assert.equal(result.events[0]!.kind, "verdict");
  assert.equal((result.events[0] as { verdict: string }).verdict, "fail");
  assert.equal(result.events[1]!.kind, "gate");
  assert.equal((result.events[1] as { force: boolean }).force, true);
  assert.equal(result.events[2]!.kind, "verdict");
  assert.equal((result.events[2] as { verdict: string }).verdict, "pass");
});

test("events: empty when the item has no runId", () => {
  const result = collectReconcileEvidence(projectDir, item({ runId: undefined }));
  assert.deepEqual(result.events, []);
});

test("ticket unreadable: ticketStatus/ticketClosedCommit undefined, no throw", () => {
  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-DOES-NOT-EXIST" }));
  assert.equal(result.ticketStatus, undefined);
  assert.equal(result.ticketClosedCommit, undefined);
  assert.equal(result.closedCommitReachableOnBase, null);
});

// ── FG-440: getRequiredHostGate + runAndRecordHostVerification ─────────────────
//
// The gate now runs in projectDir itself (which has node_modules, since it's
// the real project checkout) at whatever HEAD currently is — never a detached
// checkout of some other commit (that earlier design guaranteed npm-based
// gates would false-fail on missing dependencies). Recorded commitSha is
// always the real tested HEAD.

function writePackageJsonWithGateScript(scriptBody: string): void {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.0.0", scripts: { "test:all": scriptBody } }, null, 2)
  );
}

function commitAll(label: string): string {
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function headSha(): string {
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

test("getRequiredHostGate: project default when unconfigured, configured value when set", () => {
  assert.equal(getRequiredHostGate(projectDir), "npm run test:all");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.json"), JSON.stringify({ requiredHostGate: "npm run verify" }));
  assert.equal(getRequiredHostGate(projectDir), "npm run verify");
});

test("runAndRecordHostVerification: real pass — runs in projectDir at HEAD, records exitCode 0, commitSha equal to the REAL HEAD sha, gateName/command equal to the configured requiredHostGate string", () => {
  writePackageJsonWithGateScript("exit 0");
  const commit = commitAll("add passing gate script");

  const result = runAndRecordHostVerification(projectDir, "FG-600");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.equal((result as { commitSha: string }).commitSha, commit, "commitSha must equal rev-parse HEAD, not any closedCommit value");
  assert.equal((result as { commitSha: string }).commitSha, headSha());

  const rows = queryHostVerificationRowsForGate("FG-600", projectDir, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 0);
  assert.equal(rows[0]!.gateName, "npm run test:all", "gateName must be the configured gate string, never the executed argv");
  assert.equal(rows[0]!.command, "npm run test:all");
  assert.equal(rows[0]!.commitSha, commit);
});

test("runAndRecordHostVerification: real failure — records the ACTUAL non-zero exit code, never a fabricated 0", () => {
  writePackageJsonWithGateScript("exit 7");
  const commit = commitAll("add failing gate script");

  const result = runAndRecordHostVerification(projectDir, "FG-601");
  assert.equal(result.status, "recorded");
  assert.equal((result as { exitCode: number }).exitCode, 7);

  const rows = queryHostVerificationRows("FG-601", projectDir, commit, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 7);
});

test("runAndRecordHostVerification: skip when the required gate's script is absent in projectDir — writes NO row", () => {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synthetic", scripts: { lint: "exit 0" } }, null, 2)
  );
  commitAll("package.json without the required gate script");

  const result = runAndRecordHostVerification(projectDir, "FG-602");
  assert.equal(result.status, "skipped");
  assert.equal(
    queryHostVerificationRowsForGate("FG-602", projectDir, "npm run test:all").length,
    0,
    "a skipped gate must never write a synthetic pass row"
  );
});

test("runAndRecordHostVerification: skip when there is no package.json at all in projectDir — writes NO row", () => {
  makeCommit("no-package-json");
  const result = runAndRecordHostVerification(projectDir, "FG-603");
  assert.equal(result.status, "skipped");
  assert.equal(queryHostVerificationRowsForGate("FG-603", projectDir, "npm run test:all").length, 0);
});

test("runAndRecordHostVerification: dirty working tree (uncommitted change) — writes NO row, does not run the gate", () => {
  writePackageJsonWithGateScript("exit 0");
  commitAll("add passing gate script");
  // Uncommitted modification — the working tree is no longer clean.
  writeFileSync(join(projectDir, "uncommitted-change.txt"), "uncommitted change");

  const result = runAndRecordHostVerification(projectDir, "FG-608");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /not clean/, "reason must explain the dirty-tree refusal");
  assert.equal(
    queryHostVerificationRowsForGate("FG-608", projectDir, "npm run test:all").length,
    0,
    "an operator's dirty working state must never be recorded as a tested result"
  );
});

test("runAndRecordHostVerification: dirty working tree (untracked file) — writes NO row", () => {
  writePackageJsonWithGateScript("exit 0");
  commitAll("add passing gate script");
  writeFileSync(join(projectDir, "untracked.txt"), "not added or committed");

  const result = runAndRecordHostVerification(projectDir, "FG-609");
  assert.equal(result.status, "skipped");
  assert.equal(queryHostVerificationRowsForGate("FG-609", projectDir, "npm run test:all").length, 0);
});

test("runAndRecordHostVerification: a gate that times out records a real non-zero sentinel, never exit 0", () => {
  writePackageJsonWithGateScript("sleep 2 && exit 0");
  commitAll("add slow gate script");

  const prevTimeout = process.env["FORGE_HOST_GATE_TIMEOUT_MS"];
  process.env["FORGE_HOST_GATE_TIMEOUT_MS"] = "200";
  try {
    const result = runAndRecordHostVerification(projectDir, "FG-606");
    assert.equal(result.status, "recorded");
    assert.notEqual((result as { exitCode: number }).exitCode, 0, "a timeout must never be recorded as a pass");
  } finally {
    if (prevTimeout === undefined) delete process.env["FORGE_HOST_GATE_TIMEOUT_MS"];
    else process.env["FORGE_HOST_GATE_TIMEOUT_MS"] = prevTimeout;
  }
});

// ── FG-440: ancestry-based coverage (checkClosedCommitCoveredByTestedSha via collectReconcileEvidence) ──

test("hostVerification: ancestry — an item whose closedCommit is an ANCESTOR of a recorded row's tested HEAD is covered", () => {
  writePackageJsonWithGateScript("exit 0");
  const closedCommit = commitAll("closedCommit for FG-630");
  writeTicket(projectDir, { id: "FG-630", type: "story", status: "done", closedCommit, title: "Ancestor coverage", body: "" });

  // HEAD advances beyond closedCommit before the gate runs — the recorded row's
  // commitSha will be this later HEAD, not closedCommit itself.
  const testedHead = commitAll("HEAD advances past closedCommit");

  const captured = runAndRecordHostVerification(projectDir, "FG-630");
  assert.equal(captured.status, "recorded");
  assert.equal((captured as { commitSha: string }).commitSha, testedHead);

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-630" }));
  assert.deepEqual(
    result.hostVerification,
    { recorded: true, passed: true },
    "closedCommit is an ancestor of the tested HEAD — covered, even though the row's commitSha != closedCommit"
  );
});

test("hostVerification: ancestry — an item whose closedCommit is NOT an ancestor of any recorded row's commitSha is NOT covered", () => {
  writePackageJsonWithGateScript("exit 0");
  makeCommit("main-base-631");
  gitExec(["checkout", "-b", "feature/off-main-631"], projectDir);
  const offMainCommit = makeCommit("off-main-631-closed-commit");
  gitExec(["checkout", "main"], projectDir);

  // A row is recorded for main's HEAD (tree still clean — the ticket write below
  // happens after), which never includes the off-main commit.
  const captured = runAndRecordHostVerification(projectDir, "FG-631");
  assert.equal(captured.status, "recorded");

  writeTicket(projectDir, { id: "FG-631", type: "story", status: "done", closedCommit: offMainCommit, title: "Non-ancestor coverage", body: "" });

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-631" }));
  assert.deepEqual(
    result.hostVerification,
    { recorded: false, passed: false },
    "closedCommit is not reachable from the tested row's commitSha — must not be covered"
  );
});

// ── FIX 1 (FG-440 follow-up): testedSha must itself be reachable on the base branch ──

test("hostVerification: MATCH-time base-reachability — a row whose testedSha is off the base branch does NOT cover, even though closedCommit IS an ancestor of testedSha", () => {
  const closedCommit = makeCommit("closedCommit-for-off-branch-632");

  // A feature branch cut AFTER closedCommit: closedCommit is its ancestor, but
  // the branch itself is never merged to main. The ticket write happens AFTER
  // returning to main — writing it before the checkout would let `makeCommit`'s
  // `git add .` on the feature branch sweep up the uncommitted ticket file and
  // commit it there instead, which `checkout main` would then delete.
  gitExec(["checkout", "-b", "feature/off-branch-632"], projectDir);
  const offBranchTestedSha = makeCommit("off-branch-tested-head-632");
  gitExec(["checkout", "main"], projectDir);

  writeTicket(projectDir, { id: "FG-632", type: "story", status: "done", closedCommit, title: "Off-branch tested sha", body: "" });

  insertHostVerification({
    ticketId: "FG-632",
    projectDir,
    commitSha: offBranchTestedSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-632" }));
  assert.deepEqual(
    result.hostVerification,
    { recorded: false, passed: false },
    "a never-merged off-branch build must never permanently cover the ticket, even though closedCommit is its ancestor"
  );
});

test("hostVerification: a row whose testedSha IS on the base branch covers (positive control for the base-reachability check above)", () => {
  const closedCommit = makeCommit("closedCommit-for-on-branch-633");
  writeTicket(projectDir, { id: "FG-633", type: "story", status: "done", closedCommit, title: "On-branch tested sha", body: "" });
  const onBranchTestedSha = makeCommit("on-branch-tested-head-633");

  insertHostVerification({
    ticketId: "FG-633",
    projectDir,
    commitSha: onBranchTestedSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const result = collectReconcileEvidence(projectDir, item({ ticketId: "FG-633" }));
  assert.deepEqual(result.hostVerification, { recorded: true, passed: true });
});

test("runAndRecordHostVerification: CAPTURE-time — HEAD not reachable on the base branch SKIPS, never runs the gate, writes NO row", () => {
  writePackageJsonWithGateScript("exit 0");
  commitAll("add gate script on main");
  gitExec(["checkout", "-b", "feature/off-main-634"], projectDir);
  makeCommit("feature-commit-634");

  const result = runAndRecordHostVerification(projectDir, "FG-634");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /not reachable on base branch/, "reason must explain the off-branch refusal");
  assert.equal(
    queryHostVerificationRowsForGate("FG-634", projectDir, "npm run test:all").length,
    0,
    "an operator sitting on a feature branch must never have that build recorded as the tested base line"
  );
});

// ── FIX 3 (FG-440 follow-up): capture-window TOCTOU ─────────────────────────────

test("runAndRecordHostVerification: TOCTOU — the working tree becomes dirty DURING the gate run itself — discards the result, writes NO row", () => {
  writePackageJsonWithGateScript("echo dirty > mid-run-dirty.txt && exit 0");
  commitAll("add gate script that dirties the tree while running");

  const result = runAndRecordHostVerification(projectDir, "FG-640");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /changed during the gate run/, "reason must explain the discarded unstable result");
  assert.equal(
    queryHostVerificationRowsForGate("FG-640", projectDir, "npm run test:all").length,
    0,
    "a gate result observed against a tree that changed mid-run must never be recorded"
  );
});

test("runAndRecordHostVerification: TOCTOU — HEAD moves DURING the gate run itself — discards the result, writes NO row", () => {
  writePackageJsonWithGateScript('git commit --allow-empty -m "sneaky-commit-during-gate" && exit 0');
  commitAll("add gate script that advances HEAD while running");

  const result = runAndRecordHostVerification(projectDir, "FG-641");
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /changed during the gate run/, "reason must explain the discarded unstable result");
  assert.equal(
    queryHostVerificationRowsForGate("FG-641", projectDir, "npm run test:all").length,
    0,
    "a gate result observed against a HEAD that moved mid-run must never be recorded against the stale pre-run sha"
  );
});
