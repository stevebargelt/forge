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
import { insertHostVerification } from "../store/host-verifications.js";
import { logEvent } from "../store/events.js";
import { collectReconcileEvidence } from "./reconcile-collect.js";
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

test("hostVerification: recorded true + allExitZero true when all rows for the actual closedCommit exit 0", () => {
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
  assert.deepEqual(result.hostVerification, { recorded: true, allExitZero: true });
});

test("hostVerification: allExitZero false when any row for the closedCommit is non-zero", () => {
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
  assert.deepEqual(result.hostVerification, { recorded: true, allExitZero: false });
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
  assert.deepEqual(result.hostVerification, { recorded: false, allExitZero: false });
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
  assert.deepEqual(wrongGate.hostVerification, { recorded: false, allExitZero: false });

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
  assert.deepEqual(rightGate.hostVerification, { recorded: true, allExitZero: true });
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
