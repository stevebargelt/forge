import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSeedCorrections, projectDirsFromFailedRuns } from "./headroom-learn.js";
import type { FailedRunRow } from "./headroom-learn.js";

test("parseSeedCorrections: extracts 'Writing' lines", () => {
  const output = `
Detected agents: Claude Code

============================================================
[claude] project
Path: /some/project
============================================================
  Writing CLAUDE.md
  Writing .claude/CLAUDE.md
`;
  const corrections = parseSeedCorrections(output);
  assert.equal(corrections.length, 2);
  assert.equal(corrections[0]!.file, "CLAUDE.md");
  assert.equal(corrections[1]!.file, ".claude/CLAUDE.md");
});

test("parseSeedCorrections: extracts 'Would write' lines (dry-run)", () => {
  const output = `
  Would write CLAUDE.md
  Would update some-other.md
`;
  const corrections = parseSeedCorrections(output);
  assert.equal(corrections.length, 2);
});

test("parseSeedCorrections: returns empty for no matching lines", () => {
  const output = "No actionable corrections found.\nAnalysis complete.";
  const corrections = parseSeedCorrections(output);
  assert.equal(corrections.length, 0);
});

test("projectDirsFromFailedRuns: deduplicates project dirs", () => {
  const rows: FailedRunRow[] = [
    makeRow("t1", "r1", "/project/a"),
    makeRow("t2", "r2", "/project/a"),
    makeRow("t3", "r3", "/project/b"),
    makeRow("t4", "r4", null),
  ];
  const dirs = projectDirsFromFailedRuns(rows);
  assert.deepEqual(dirs.sort(), ["/project/a", "/project/b"]);
});

test("projectDirsFromFailedRuns: returns empty when all projectDirs are null", () => {
  const rows: FailedRunRow[] = [
    makeRow("t1", "r1", null),
    makeRow("t2", "r2", null),
  ];
  assert.deepEqual(projectDirsFromFailedRuns(rows), []);
});

function makeRow(taskId: string, runId: string, projectDir: string | null): FailedRunRow {
  return {
    task: {
      id: taskId,
      runId,
      phase: "implement",
      agentRole: "engineer",
      status: "failed",
      taskPackage: {
        taskId,
        runId,
        phase: "implement",
        role: "engineer",
        inputs: {},
        composedSystemPrompt: "",
      },
      createdAt: "2026-06-15T00:00:00.000Z",
      error: "some error",
    },
    runId,
    agentRole: "engineer",
    completedAt: "2026-06-15T01:00:00.000Z",
    error: "some error",
    projectDir,
  };
}
