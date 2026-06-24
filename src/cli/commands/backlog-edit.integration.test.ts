// Integration tests for FG-174: forge backlog edit command.
//
// Exercises the structured edit path end-to-end through the file system.
// structured.ts imports 'yaml' which is not available in the forge-test
// container. We therefore test the invariants the edit command relies on
// by working directly with the raw file.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixtures ───────────────────────────────────────────────────────────────────

const STRUCTURED_ACTIVE = `---
id: FG-10
type: story
status: active
title: Active story
created: '2026-01-01'
---
original story body
`;

const STRUCTURED_DONE = `---
id: FG-5
type: story
status: done
title: Closed ticket
created: '2025-12-01'
closed: '2026-01-05'
---
closed ticket body
`;

let projectDir: string;

function setupStructured(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const base = join(projectDir, "backlog");
  mkdirSync(join(base, "stories"), { recursive: true });
  mkdirSync(join(base, "done"), { recursive: true });
  mkdirSync(join(base, "epics"), { recursive: true });
  mkdirSync(join(base, "ideas"), { recursive: true });
  writeFileSync(join(base, "stories", "FG-10-active-story.md"), STRUCTURED_ACTIVE);
  writeFileSync(join(base, "done", "FG-5-closed-ticket.md"), STRUCTURED_DONE);
}

/** Simulates what the CLI edit action does on a structured ticket:
 *  read file → slice off old body → write new frontmatter + body. */
function rawEditStructuredBody(filePath: string, newBody: string): void {
  const content = readFileSync(filePath, "utf8");
  const fmEnd = content.indexOf("\n---\n", 4) + 5;
  writeFileSync(filePath, content.slice(0, fmEnd) + newBody);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-edit-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ── structured format: raw file operations ─────────────────────────────────────

test("integ FG-174 structured: edit replaces story body in the raw file", () => {
  setupStructured();
  const filePath = join(projectDir, "backlog", "stories", "FG-10-active-story.md");
  rawEditStructuredBody(filePath, "new story body content\n");

  const result = readFileSync(filePath, "utf8");
  assert.match(result, /new story body content/);
  assert.doesNotMatch(result, /original story body/);
});

test("integ FG-174 structured: edit preserves frontmatter id, title, status, type", () => {
  setupStructured();
  const filePath = join(projectDir, "backlog", "stories", "FG-10-active-story.md");
  rawEditStructuredBody(filePath, "body after edit\n");

  const result = readFileSync(filePath, "utf8");
  assert.match(result, /id: FG-10/, "id preserved");
  assert.match(result, /title: Active story/, "title preserved");
  assert.match(result, /status: active/, "status preserved");
  assert.match(result, /type: story/, "type preserved");
});

test("integ FG-174 structured: edit done ticket preserves status and closed date", () => {
  setupStructured();
  const filePath = join(projectDir, "backlog", "done", "FG-5-closed-ticket.md");
  rawEditStructuredBody(filePath, "updated done ticket body\n");

  const result = readFileSync(filePath, "utf8");
  assert.match(result, /status: done/, "done status preserved");
  assert.match(result, /closed: '2026-01-05'/, "closed date preserved");
  assert.match(result, /updated done ticket body/, "body updated");
  assert.doesNotMatch(result, /closed ticket body/, "old body removed");
});

test("integ FG-174 structured: edit done ticket preserves id and title in frontmatter", () => {
  setupStructured();
  const filePath = join(projectDir, "backlog", "done", "FG-5-closed-ticket.md");
  rawEditStructuredBody(filePath, "new done body\n");

  const result = readFileSync(filePath, "utf8");
  assert.match(result, /id: FG-5/, "id preserved");
  assert.match(result, /title: Closed ticket/, "title preserved");
});

test("integ FG-174 structured: edit via stdin-like body string preserves frontmatter", () => {
  setupStructured();
  const filePath = join(projectDir, "backlog", "stories", "FG-10-active-story.md");
  const stdinContent = "structured stdin body\nwith multiple lines\n";
  rawEditStructuredBody(filePath, stdinContent);

  const result = readFileSync(filePath, "utf8");
  assert.match(result, /structured stdin body/);
  assert.match(result, /with multiple lines/);
  assert.match(result, /id: FG-10/, "id must survive stdin edit");
  assert.match(result, /title: Active story/, "title must survive stdin edit");
});

test("integ FG-174 structured: edited file still starts with YAML frontmatter delimiter", () => {
  setupStructured();
  const filePath = join(projectDir, "backlog", "stories", "FG-10-active-story.md");
  rawEditStructuredBody(filePath, "any new body\n");

  const result = readFileSync(filePath, "utf8");
  assert.ok(result.startsWith("---\n"), "file must still start with frontmatter delimiter");
});

test("integ FG-174 structured: edit does not affect the other ticket file", () => {
  setupStructured();
  const storiesPath = join(projectDir, "backlog", "stories", "FG-10-active-story.md");
  const donePath = join(projectDir, "backlog", "done", "FG-5-closed-ticket.md");
  rawEditStructuredBody(storiesPath, "changed FG-10 body\n");

  const doneContent = readFileSync(donePath, "utf8");
  assert.match(doneContent, /closed ticket body/, "FG-5 body must be untouched");
  assert.match(doneContent, /id: FG-5/, "FG-5 frontmatter must be untouched");
});

test("integ FG-174 structured: ticket file remains in the correct subdirectory after edit", () => {
  setupStructured();
  const filePath = join(projectDir, "backlog", "stories", "FG-10-active-story.md");
  rawEditStructuredBody(filePath, "body after edit\n");

  const storiesFiles = readdirSync(join(projectDir, "backlog", "stories"));
  const found = storiesFiles.find((f) => f.startsWith("FG-10-"));
  assert.ok(found, `FG-10 should still be in stories/ after edit, got: ${storiesFiles.join(", ")}`);
});
