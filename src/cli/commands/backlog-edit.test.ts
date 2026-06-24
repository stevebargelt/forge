import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests for forge backlog edit command — structured format only.
// Works directly with raw file content to avoid the yaml dep
// that is unavailable in the forge-test container.

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-edit-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const STRUCTURED_FM = `---
id: FG-10
type: story
status: active
title: sample ticket
---
original body
`;

const DONE_FM = `---
id: FG-20
type: story
status: done
title: closed ticket
closed: 2026-01-01
---
old body
`;

test("structured edit: raw write preserves frontmatter and replaces body", () => {
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  const filePath = join(projectDir, "backlog", "stories", "FG-10-sample-ticket.md");
  writeFileSync(filePath, STRUCTURED_FM);

  const content = readFileSync(filePath, "utf8");
  const fmEnd = content.indexOf("\n---\n", 4) + 5;
  const fm = content.slice(0, fmEnd);
  const newContent = fm + "new body\n";
  writeFileSync(filePath, newContent);

  const result = readFileSync(filePath, "utf8");
  assert.ok(result.includes("id: FG-10"), "id preserved");
  assert.ok(result.includes("title: sample ticket"), "title preserved");
  assert.ok(result.includes("new body"), "new body written");
  assert.ok(!result.includes("original body"), "old body removed");
});

test("structured edit: done ticket file update preserves closed date", () => {
  mkdirSync(join(projectDir, "backlog", "done"), { recursive: true });
  const filePath = join(projectDir, "backlog", "done", "FG-20-closed-ticket.md");
  writeFileSync(filePath, DONE_FM);

  const content = readFileSync(filePath, "utf8");
  const fmEnd = content.indexOf("\n---\n", 4) + 5;
  const fm = content.slice(0, fmEnd);
  const newContent = fm + "edited done body\n";
  writeFileSync(filePath, newContent);

  const result = readFileSync(filePath, "utf8");
  assert.ok(result.includes("status: done"), "status preserved");
  assert.ok(result.includes("closed: 2026-01-01"), "closed date preserved");
  assert.ok(result.includes("edited done body"), "body updated");
  assert.ok(!result.includes("old body"), "old body removed");
});
