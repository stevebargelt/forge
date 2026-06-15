// Integration tests for FG-326: forge backlog notes commands work with structured format.
// Exercises the full CLI via subprocess (tsx entry point) against real backlog directories.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;

function runForge(args: string[], input?: string) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: projectDir,
    input: input ?? "",
    encoding: "utf8",
  });
}

function notesPath(): string {
  return join(projectDir, "backlog", "notes.md");
}

function setupStructured(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "done"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "epics"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "ideas"), { recursive: true });
}

function setupStructuredWithNotes(content: string): void {
  setupStructured();
  writeFileSync(notesPath(), content);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-notes-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ── notes show ────────────────────────────────────────────────────────────────

test("integ FG-326: notes show reads backlog/notes.md content", () => {
  setupStructuredWithNotes("session handoff: resume from FG-326\n");
  const res = runForge(["backlog", "notes", "show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /session handoff: resume from FG-326/);
});

test("integ FG-326: notes show prints '(no notes)' when backlog/notes.md absent", () => {
  setupStructured();
  assert.ok(!existsSync(notesPath()), "notes.md should not exist yet");
  const res = runForge(["backlog", "notes", "show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /\(no notes\)/);
});

test("integ FG-326: notes show prints full multi-line notes block", () => {
  const content = "Line 1: what was done.\n\nLine 2: what comes next.\n";
  setupStructuredWithNotes(content);
  const res = runForge(["backlog", "notes", "show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Line 1: what was done\./);
  assert.match(res.stdout, /Line 2: what comes next\./);
});

// ── notes add ─────────────────────────────────────────────────────────────────

test("integ FG-326: notes add appends text to backlog/notes.md", () => {
  setupStructuredWithNotes("first note\n");
  const res = runForge(["backlog", "notes", "add", "second note", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Notes updated/);
  const notes = readFileSync(notesPath(), "utf8");
  assert.match(notes, /first note/);
  assert.match(notes, /second note/);
});

test("integ FG-326: notes add creates backlog/notes.md when absent", () => {
  setupStructured();
  assert.ok(!existsSync(notesPath()), "notes.md should not exist before add");
  const res = runForge(["backlog", "notes", "add", "brand new note", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(existsSync(notesPath()), "notes.md should be created by add");
  assert.match(readFileSync(notesPath(), "utf8"), /brand new note/);
});

test("integ FG-326: notes add appends with newline separator when existing content lacks trailing blank", () => {
  setupStructuredWithNotes("first line\n");
  runForge(["backlog", "notes", "add", "second line", "--project", projectDir]);
  const notes = readFileSync(notesPath(), "utf8");
  // both lines should be present, newline-separated
  assert.match(notes, /first line/);
  assert.match(notes, /second line/);
  assert.ok(notes.indexOf("first line") < notes.indexOf("second line"), "first note before second");
});

test("integ FG-326: notes add preserves all prior content", () => {
  const prior = "Prior handoff note.\n\nDetailed second paragraph.\n";
  setupStructuredWithNotes(prior);
  runForge(["backlog", "notes", "add", "appended", "--project", projectDir]);
  const notes = readFileSync(notesPath(), "utf8");
  assert.match(notes, /Prior handoff note\./);
  assert.match(notes, /Detailed second paragraph\./);
  assert.match(notes, /appended/);
});

// ── notes replace ─────────────────────────────────────────────────────────────

test("integ FG-326: notes replace overwrites backlog/notes.md", () => {
  setupStructuredWithNotes("old content\n");
  const res = runForge(["backlog", "notes", "replace", "new content", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Notes replaced/);
  const notes = readFileSync(notesPath(), "utf8");
  assert.match(notes, /new content/);
  assert.doesNotMatch(notes, /old content/);
});

test("integ FG-326: notes replace creates backlog/notes.md when absent", () => {
  setupStructured();
  assert.ok(!existsSync(notesPath()), "notes.md should not exist before replace");
  const res = runForge(["backlog", "notes", "replace", "brand new", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(existsSync(notesPath()), "notes.md should be created by replace");
  assert.match(readFileSync(notesPath(), "utf8"), /brand new/);
});

test("integ FG-326: notes replace adds trailing newline when text lacks one", () => {
  setupStructured();
  runForge(["backlog", "notes", "replace", "no trailing newline", "--project", projectDir]);
  const notes = readFileSync(notesPath(), "utf8");
  assert.ok(notes.endsWith("\n"), "notes.md should end with a newline");
});

test("integ FG-326: notes replace with argv text (the /handoff path)", () => {
  setupStructuredWithNotes("stale handoff from last session\n");
  const res = runForge([
    "backlog", "notes", "replace",
    "**Next:** close FG-326.",
    "--project", projectDir,
  ]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const notes = readFileSync(notesPath(), "utf8");
  assert.match(notes, /\*\*Next:\*\* close FG-326\./);
  assert.doesNotMatch(notes, /stale handoff/);
});

// ── format detection routing ──────────────────────────────────────────────────

test("integ FG-326: format detection routes notes to backlog/notes.md for structured format", () => {
  setupStructured();
  // Adding a note should write to backlog/notes.md, not BACKLOG.md
  runForge(["backlog", "notes", "add", "structured note", "--project", projectDir]);
  assert.ok(existsSync(notesPath()), "backlog/notes.md should exist");
  assert.ok(!existsSync(join(projectDir, "BACKLOG.md")), "BACKLOG.md should not be created");
});

test("integ FG-326: format detection routes notes to BACKLOG.md for legacy format", () => {
  const backlogMd = `# Backlog\n\n## Notes for next session\n\nlegacy note\n\n## Active\n`;
  writeFileSync(join(projectDir, "BACKLOG.md"), backlogMd);
  const res = runForge(["backlog", "notes", "show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /legacy note/);
  // backlog/notes.md should NOT have been created
  assert.ok(!existsSync(notesPath()), "backlog/notes.md should not be created for legacy format");
});

test("integ FG-326: structured format takes precedence when both backlog/ and BACKLOG.md exist", () => {
  // Has both — structured wins
  writeFileSync(join(projectDir, "BACKLOG.md"), "# Backlog\n\n## Notes for next session\n\nlegacy\n");
  setupStructuredWithNotes("structured note\n");
  const res = runForge(["backlog", "notes", "show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /structured note/);
  assert.doesNotMatch(res.stdout, /legacy/);
});
