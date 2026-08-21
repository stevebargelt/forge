// FG-677 (a): the unified disposition vocabulary + formatter. Pure — no fs/git/store.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recoveryForReason,
  removedDisposition,
  retainedDisposition,
  emptyRunCleanupReport,
  allDispositions,
  formatRetainedDisposition,
  formatRemovedDisposition,
  formatRunCleanupReport,
  type CleanupReason,
} from "./run-cleanup-report.js";

// Every named reason the ticket requires, plus the reused reaper + retention labels,
// must have a concrete recovery action — recoveryForReason is total.
const ALL_REASONS: CleanupReason[] = [
  "uncommitted_work",
  "unmerged_commits",
  "submodules_present",
  "private_clone_substrate",
  "unknown_substrate",
  "workspace_not_owned",
  "remote_target_uncaptured",
  "removal_failed",
  "parent_repacking",
  "within_retention_for_investigation",
  "expired_eligible",
  "leaked",
  "active_process_cwd",
  "active_mount",
  "ownership_ambiguous",
  "publication_in_flight",
  "readiness_live_reader",
  "retained_failure_kind",
  "run_not_terminal",
  "branch_uncaptured",
];

test("FG-677 report: every reason has a non-empty recovery action", () => {
  for (const r of ALL_REASONS) {
    const recovery = recoveryForReason(r);
    assert.ok(typeof recovery === "string" && recovery.length > 0, `reason ${r} must have a recovery action`);
  }
});

test("FG-677 report: retainedDisposition auto-fills recovery from the reason", () => {
  const d = retainedDisposition("git_workspace", "/w/clone", "uncommitted_work");
  assert.equal(d.action, "retained");
  assert.equal(d.reason, "uncommitted_work");
  assert.equal(d.recovery, recoveryForReason("uncommitted_work"));
});

test("FG-677 report: the ticket's new named reasons carry a holder into the record", () => {
  const cwd = retainedDisposition("git_workspace", "/w/live", "active_process_cwd", { holder: "tmux server pid 42" });
  assert.equal(cwd.holder, "tmux server pid 42");
  const mount = retainedDisposition("git_workspace", "/w/mounted", "active_mount", { holder: "forge-task-x" });
  assert.equal(mount.holder, "forge-task-x");
});

test("FG-677 report: dry-run marks the record as a proposal", () => {
  const removed = removedDisposition("publication_worktree", "/p/dir", { dryRun: true });
  assert.equal(removed.action, "removed");
  assert.equal(removed.dryRun, true);
  assert.match(formatRemovedDisposition(removed), /^  would remove/);
  const real = removedDisposition("publication_worktree", "/p/dir");
  assert.equal(real.dryRun, undefined);
  assert.match(formatRemovedDisposition(real), /^  removed/);
});

test("FG-677 report: a retained line names the exact reason, path, and recovery", () => {
  const d = retainedDisposition("git_workspace", "/w/unique", "unmerged_commits");
  const line = formatRetainedDisposition(d);
  assert.match(line, /retained git_workspace \/w\/unique — unmerged_commits/);
  assert.match(line, /recover:/);
});

test("FG-677 report: combined report renders owned sections and REPORTS the FG-590 disposition", () => {
  const report = emptyRunCleanupReport({ runId: "run-x", dryRun: false });
  report.gitWorkspaces.push(removedDisposition("git_workspace", "/w/gone"));
  report.gitWorkspaces.push(retainedDisposition("git_workspace", "/w/dirty", "uncommitted_work"));
  report.publicationWorktrees.push(retainedDisposition("publication_worktree", "/p/orphan", "ownership_ambiguous"));
  report.readinessRecords.push(removedDisposition("readiness_record", "/r/rec.json"));
  report.reportedElsewhere.launches = "retired 3, retained 1";
  report.reportedElsewhere.containers = "retired 2/5, retained 3";

  assert.equal(allDispositions(report).length, 4);
  const out = formatRunCleanupReport(report);
  assert.match(out, /run run-x/);
  assert.match(out, /git workspaces: 1 removed, 1 retained/);
  assert.match(out, /uncommitted_work/);
  assert.match(out, /ownership_ambiguous/);
  // The FG-590 disposition is REPORTED, not re-run — one line each, labelled.
  assert.match(out, /tmux launches \(FG-590, reported\): retired 3, retained 1/);
  assert.match(out, /task containers \(FG-590, reported\): retired 2\/5, retained 3/);
});

test("FG-677 report: a dry-run report header names it a proposal", () => {
  const report = emptyRunCleanupReport({ dryRun: true });
  assert.match(formatRunCleanupReport(report), /DRY RUN \(proposal only, no mutation\)/);
});
