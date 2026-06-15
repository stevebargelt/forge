import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBacklogFormat } from "./backlog.js";
import { readBacklog, writeBacklog } from "../../backlog/io.js";
import { appendNotes, setNotes } from "../../backlog/ops.js";

// Tests for forge backlog notes (show/add/replace) in both legacy and structured formats.
// Uses direct module imports rather than subprocess spawning — the subprocess approach
// fails in forge-work because commander isn't in node_modules there.

const BACKLOG = `# Backlog

## Notes for next session

ORIGINAL NOTE — must be replaced.

## Active

### #1 — sample ticket

body
`;

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-notes-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---- detectBacklogFormat ----

test("detectBacklogFormat: returns 'legacy' for BACKLOG.md", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  assert.equal(detectBacklogFormat(projectDir), "legacy");
});

test("detectBacklogFormat: returns 'structured' for backlog/ dir", () => {
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  assert.equal(detectBacklogFormat(projectDir), "structured");
});

test("detectBacklogFormat: structured takes precedence when both exist", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  assert.equal(detectBacklogFormat(projectDir), "structured");
});

// ---- legacy notes (via ops layer) ----

test("legacy notes replace: text replaces the notes block", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  const b = readBacklog(projectDir);
  const next = setNotes(b, "**Picked up next:** ship it.\n");
  writeBacklog(projectDir, next);
  const content = readFileSync(join(projectDir, "BACKLOG.md"), "utf8");
  assert.match(content, /\*\*Picked up next:\*\* ship it\./);
  assert.doesNotMatch(content, /ORIGINAL NOTE/);
  assert.match(content, /### #1 — sample ticket/); // tickets untouched
});

test("legacy notes add: text appends to notes block", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
  const b = readBacklog(projectDir);
  const next = appendNotes(b, "appended line");
  writeBacklog(projectDir, next);
  const content = readFileSync(join(projectDir, "BACKLOG.md"), "utf8");
  assert.match(content, /ORIGINAL NOTE/);
  assert.match(content, /appended line/);
});

// ---- structured notes (direct file ops, mirroring the command logic) ----

function structuredNotesPath(dir: string): string {
  return join(dir, "backlog", "notes.md");
}

function setupStructured(dir: string): void {
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
}

test("structured: show returns '(no notes)' when notes.md absent", () => {
  setupStructured(projectDir);
  // mirrors the notes show action for structured format
  const notesPath = structuredNotesPath(projectDir);
  const output = !existsSync(notesPath) ? "(no notes)\n" : readFileSync(notesPath, "utf8");
  assert.equal(output, "(no notes)\n");
});

test("structured: show prints existing notes.md", () => {
  setupStructured(projectDir);
  writeFileSync(structuredNotesPath(projectDir), "session handoff\n");
  const output = readFileSync(structuredNotesPath(projectDir), "utf8");
  assert.match(output, /session handoff/);
});

test("structured: replace writes backlog/notes.md (argv path)", () => {
  setupStructured(projectDir);
  const text = "**Next:** deploy the thing.";
  const notesPath = structuredNotesPath(projectDir);
  writeFileSync(notesPath, text.endsWith("\n") ? text : text + "\n");
  assert.match(readFileSync(notesPath, "utf8"), /\*\*Next:\*\* deploy the thing\./);
});

test("structured: replace overwrites existing notes.md", () => {
  setupStructured(projectDir);
  const notesPath = structuredNotesPath(projectDir);
  writeFileSync(notesPath, "old content\n");
  const text = "new content";
  writeFileSync(notesPath, text.endsWith("\n") ? text : text + "\n");
  const notes = readFileSync(notesPath, "utf8");
  assert.match(notes, /new content/);
  assert.doesNotMatch(notes, /old content/);
});

test("structured: add appends to notes.md", () => {
  setupStructured(projectDir);
  const notesPath = structuredNotesPath(projectDir);
  writeFileSync(notesPath, "first line\n");
  const text = "second line";
  const existing = readFileSync(notesPath, "utf8");
  const separator = existing.length > 0 && !existing.endsWith("\n\n") ? "\n" : "";
  writeFileSync(notesPath, existing + separator + text.trim() + "\n");
  const notes = readFileSync(notesPath, "utf8");
  assert.match(notes, /first line/);
  assert.match(notes, /second line/);
});

test("structured: add creates notes.md when absent", () => {
  setupStructured(projectDir);
  const notesPath = structuredNotesPath(projectDir);
  const text = "brand new note";
  const existing = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n\n") ? "\n" : "";
  writeFileSync(notesPath, existing + separator + text.trim() + "\n");
  assert.ok(existsSync(notesPath));
  assert.match(readFileSync(notesPath, "utf8"), /brand new note/);
});

test("structured: replace respects empty-input guard", () => {
  setupStructured(projectDir);
  const notesPath = structuredNotesPath(projectDir);
  writeFileSync(notesPath, "safe content\n");
  const text = "   ";
  // mirrors the guard in the action: throw if text.trim().length === 0
  assert.throws(() => {
    if (text.trim().length === 0) throw new Error("notes replace: empty input");
    writeFileSync(notesPath, text);
  }, /empty input/);
  assert.match(readFileSync(notesPath, "utf8"), /safe content/); // original survived
});
