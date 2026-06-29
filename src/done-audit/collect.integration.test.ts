import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeTicket } from "../backlog/structured.js";
import { collectDoneAuditInput } from "./collect.js";
import type { CampaignItem } from "../types/index.js";

let projectDir: string;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

function makeItem(ticketId: string): CampaignItem {
  return {
    id: `item-${ticketId}`,
    campaignId: "campaign-test",
    itemOrder: 1,
    ticketId,
    lifecycleStatus: "complete",
    outcome: "shipped",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "collect-integ-"));
  gitExec(["init"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ── missing ticket → ticket null ──────────────────────────────────────────────

test("collect: missing ticket → ticket null (unknown checks)", () => {
  // Do NOT write any ticket to projectDir — ticketId does not exist
  const item = makeItem("FG-NONEXISTENT-9999");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.ticket, null, "ticket must be null when ticketId not found in backlog");
  // ticket=null → ticket_closed and closed_commit_present will be unknown
  // (covered by the evaluator; here we verify collect returns null, not throws)
});

// ── dirty working tree → git.dirty=true ──────────────────────────────────────

test("collect: dirty working tree → git.dirty=true", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-1",
    type: "story",
    status: "done",
    title: "Collect Test One",
    body: "done",
    related: [],
  });

  // Create an untracked (dirty) file in the git repo
  writeFileSync(join(projectDir, "untracked.txt"), "dirty content");

  const item = makeItem("FG-COLLECT-1");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.git.dirty, true, "dirty must be true when working tree has uncommitted changes");
});

// ── clean working tree → git.dirty=false ──────────────────────────────────────

test("collect: clean working tree → git.dirty=false", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-2",
    type: "story",
    status: "done",
    title: "Collect Test Two",
    body: "done",
    related: [],
  });

  // Make a commit so git status is clean (nothing staged, nothing untracked)
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "--allow-empty", "-m", "initial"], projectDir);

  const item = makeItem("FG-COLLECT-2");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.git.dirty, false, "dirty must be false when working tree is clean");
});

// ── non-existent closedCommit → commitExists=false ───────────────────────────

test("collect: non-existent closedCommit → commitExists=false (not null)", () => {
  const fakeCommit = "deadbeef1234567890deadbeef1234567890dead";

  writeTicket(projectDir, {
    id: "FG-COLLECT-3",
    type: "story",
    status: "done",
    closedCommit: fakeCommit,
    title: "Collect Test Three",
    body: "done",
    related: [],
  });

  // Init a bare git repo with no commits — the fake commit cannot exist
  const item = makeItem("FG-COLLECT-3");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.ticket?.closedCommit, fakeCommit, "ticket must contain the closedCommit");
  assert.equal(
    input.git.commitExists,
    false,
    "commitExists must be false when closedCommit does not exist in the repository"
  );
  assert.notEqual(input.git.commitExists, null, "commitExists must be false, not null — the commit is definitely absent");
});

// ── existing closedCommit → commitExists=true ────────────────────────────────

test("collect: existing closedCommit → commitExists=true", () => {
  // Make an initial commit so we have a real commit hash
  writeFileSync(join(projectDir, "README.md"), "init");
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init commit"], projectDir);

  const realCommit = gitExec(["rev-parse", "HEAD"], projectDir).trim();

  writeTicket(projectDir, {
    id: "FG-COLLECT-4",
    type: "story",
    status: "done",
    closedCommit: realCommit,
    title: "Collect Test Four",
    body: "done",
    related: [],
  });

  const item = makeItem("FG-COLLECT-4");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.ticket?.closedCommit, realCommit);
  assert.equal(input.git.commitExists, true, "commitExists must be true when the commit exists in the repo");
});

// ── ticket fields passed through correctly ────────────────────────────────────

test("collect: ticket fields (status, body, related) passed through from backlog", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-5",
    type: "story",
    status: "done",
    title: "Collect Test Five",
    body: "## Deferred\nFollow-up in FG-999.\n",
    related: ["FG-999"],
  });

  const item = makeItem("FG-COLLECT-5");
  const input = collectDoneAuditInput(projectDir, item);

  assert.ok(input.ticket !== null, "ticket must not be null for a readable ticket");
  assert.equal(input.ticket!.status, "done");
  assert.ok(input.ticket!.body.includes("Deferred"), "ticket body must be passed through");
  assert.deepEqual(input.ticket!.related, ["FG-999"]);
});

// ── verification fields: host always null in current scope ────────────────────

test("collect: hostVerified is always null (recorder not implemented in FG-383)", () => {
  writeTicket(projectDir, {
    id: "FG-COLLECT-6",
    type: "story",
    status: "done",
    title: "Collect Test Six",
    body: "done",
    related: [],
  });

  const item = makeItem("FG-COLLECT-6");
  const input = collectDoneAuditInput(projectDir, item);

  assert.equal(input.verification.hostVerified, null, "hostVerified must be null — recorder is out of scope for FG-383");
  assert.equal(input.verification.containerTestsRun, null, "containerTestsRun must be null — not cheaply accessible");
  assert.equal(input.verification.acceptedException, null, "acceptedException must be null");
});
