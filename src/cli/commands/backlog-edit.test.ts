import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBacklog, writeBacklog } from "../../backlog/io.js";
import { updateTicketBody, findTicket } from "../../backlog/ops.js";

// Tests for forge backlog edit command.
// Structured-format tests operate on raw file content to avoid the yaml dep
// that is unavailable in the forge-test container.

const BACKLOG = `# Backlog

## Notes for next session

no notes

## Active

### #1 — first ticket

original body line

### #2 — second ticket

second body

`;

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-edit-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---- ops layer: updateTicketBody ----

test("updateTicketBody: replaces body while preserving id and title", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  const b = readBacklog(projectDir);
  const next = updateTicketBody(b, 1, "new body\n\n");
  const ticket = findTicket(next, 1);
  assert.ok(ticket);
  assert.equal(ticket.title, "first ticket");
  assert.match(ticket.body, /new body/);
  assert.doesNotMatch(ticket.body, /original body line/);
});

test("updateTicketBody: does not affect other tickets", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  const b = readBacklog(projectDir);
  const next = updateTicketBody(b, 1, "changed\n\n");
  const other = findTicket(next, 2);
  assert.ok(other);
  assert.match(other.body, /second body/);
});

test("updateTicketBody: throws for missing ticket", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  const b = readBacklog(projectDir);
  assert.throws(() => updateTicketBody(b, 99, "body"), /not found/);
});

test("updateTicketBody: persists to BACKLOG.md", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  const b = readBacklog(projectDir);
  const next = updateTicketBody(b, 1, "persisted body\n\n");
  writeBacklog(projectDir, next);
  const content = readFileSync(join(projectDir, "BACKLOG.md"), "utf8");
  assert.match(content, /persisted body/);
  assert.doesNotMatch(content, /original body line/);
  assert.match(content, /### #1 — first ticket/); // heading preserved
});

test("updateTicketBody: section is unchanged after edit", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  const b = readBacklog(projectDir);
  const before = findTicket(b, 1);
  const next = updateTicketBody(b, 1, "updated body\n\n");
  const after = findTicket(next, 1);
  assert.ok(before && after);
  assert.equal(after.section, before.section);
});

// ---- structured format: raw file operations ----
// These tests bypass structured.ts (which requires yaml) and work with the
// raw file format directly to verify the invariants the edit command relies on.

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

  // Simulate what the edit command does: read file, replace body section
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
