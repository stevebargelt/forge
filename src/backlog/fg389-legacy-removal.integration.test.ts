// Integration tests: FG-389 legacy BACKLOG.md removal regression guards.
//
// Verifies that after FG-389:
// - No normal backlog runtime path reads or writes BACKLOG.md.
// - forge backlog config --show always reports 'format: structured'.
// - forge backlog-migrate is the only command that reads BACKLOG.md (isolated).
// - forge backlog-migrate correctly handles error cases.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;

function runForge(args: string[], input?: string) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: projectDir,
    input: input ?? "",
    encoding: "utf8",
  });
}

function setupStructured(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const base = join(projectDir, "backlog");
  mkdirSync(join(base, "ideas"), { recursive: true });
  mkdirSync(join(base, "epics"), { recursive: true });
  mkdirSync(join(base, "stories"), { recursive: true });
  mkdirSync(join(base, "done"), { recursive: true });
  writeFileSync(
    join(base, "stories", "FG-10-active-story.md"),
    "---\nid: FG-10\ntype: story\nstatus: active\ntitle: Active story\ncreated: '2026-01-01'\n---\n\nStory body.\n",
  );
  writeFileSync(
    join(base, "done", "FG-5-closed-story.md"),
    "---\nid: FG-5\ntype: story\nstatus: done\ntitle: Closed story\ncreated: '2025-12-01'\nclosed: '2026-01-05'\n---\n\nClosed body.\n",
  );
}

const LEGACY_BACKLOG_CONTENT = `# forge — backlog

Intro paragraph.

## Notes for next session

Some handoff notes.

## Active

### #1 — first active ticket
**Why:** Body content for the first ticket.

### #2 — second active ticket
**Why:** Another body.

## In progress

## Done (recent)

### #116 — Shipped feature X
**Why:** Because it shipped.

## Done (archived)
`;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg389-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── Normal runtime does NOT touch BACKLOG.md ──────────────────────────────

test("FG-389: forge backlog list does not create BACKLOG.md", () => {
  setupStructured();
  const res = runForge(["backlog", "list", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(!existsSync(join(projectDir, "BACKLOG.md")), "BACKLOG.md must not be created by list");
});

test("FG-389: forge backlog file does not create BACKLOG.md", () => {
  setupStructured();
  const res = runForge(["backlog", "file", "New test ticket", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(!existsSync(join(projectDir, "BACKLOG.md")), "BACKLOG.md must not be created by file");
  // ticket should land in stories/
  const stories = readdirSync(join(projectDir, "backlog", "stories"));
  const newFile = stories.find((f) => f.includes("new-test-ticket"));
  assert.ok(newFile, `expected file matching 'new-test-ticket' in stories/, got: ${stories.join(", ")}`);
});

test("FG-389: forge backlog show does not create BACKLOG.md", () => {
  setupStructured();
  const res = runForge(["backlog", "show", "FG-10", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(!existsSync(join(projectDir, "BACKLOG.md")), "BACKLOG.md must not be created by show");
});

test("FG-389: forge backlog close does not create BACKLOG.md", () => {
  setupStructured();
  const res = runForge(["backlog", "close", "FG-10", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(!existsSync(join(projectDir, "BACKLOG.md")), "BACKLOG.md must not be created by close");
});

test("FG-389: forge backlog notes add does not create BACKLOG.md", () => {
  setupStructured();
  const res = runForge(["backlog", "notes", "add", "test note", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(!existsSync(join(projectDir, "BACKLOG.md")), "BACKLOG.md must not be created by notes add");
});

// ─── BACKLOG.md present alongside structured backlog/ — structured wins ─────

test("FG-389: forge backlog list ignores BACKLOG.md when backlog/ exists", () => {
  setupStructured();
  // Write a BACKLOG.md that would yield different results if read
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);

  const res = runForge(["backlog", "list", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  // Structured has FG-10 and FG-5; legacy content has #1, #2, #116.
  // If legacy were read we'd see ticket ids like 1, 2, 116 — not FG- prefixed ids.
  assert.match(res.stdout, /FG-10/, "should show structured ticket FG-10");
  assert.doesNotMatch(res.stdout, /#1\b.*first active ticket/, "must not show legacy ticket #1");
});

test("FG-389: forge backlog show reads from structured backlog/, not BACKLOG.md", () => {
  setupStructured();
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);

  const res = runForge(["backlog", "show", "FG-10", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Active story/, "should show structured ticket title");
});

// ─── forge backlog config --show always reports structured ─────────────────

test("FG-389: forge backlog config --show reports format: structured (no legacy mode)", () => {
  setupStructured();
  const res = runForge(["backlog", "config", "--show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /format:\s*structured/, "format must always be structured");
  assert.doesNotMatch(res.stdout, /format:\s*legacy/, "legacy format must not appear");
});

test("FG-389: forge backlog config --show reports prefix from .forge/config.yml", () => {
  setupStructured();
  const res = runForge(["backlog", "config", "--show", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /prefix:\s*FG/, "prefix should match config");
});

test("FG-389: forge backlog config --show fails without backlog/ dir (no BACKLOG.md fallback)", () => {
  // No backlog/ dir, only a BACKLOG.md — should fail, not fall back to legacy
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);
  const res = runForge(["backlog", "config", "--show", "--project", projectDir]);
  assert.notEqual(res.status, 0, "must fail when only BACKLOG.md exists; no legacy fallback");
  const combined = res.stderr + res.stdout;
  assert.match(combined, /No backlog found|backlog/i, "error should mention backlog");
});

// ─── forge backlog-migrate: isolated legacy import ─────────────────────────

test("FG-389: forge backlog-migrate fails when BACKLOG.md is absent", () => {
  // No BACKLOG.md present
  const res = runForge(["backlog-migrate", "--project", projectDir]);
  assert.notEqual(res.status, 0, "migrate must fail when BACKLOG.md is absent");
  const combined = res.stderr + res.stdout;
  assert.match(combined, /BACKLOG\.md not found|not found/i);
});

test("FG-389: forge backlog-migrate fails when backlog/ already exists", () => {
  // Both BACKLOG.md and backlog/ present — migration should refuse
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);
  setupStructured();

  const res = runForge(["backlog-migrate", "--project", projectDir]);
  assert.notEqual(res.status, 0, "migrate must fail when backlog/ already exists");
  const combined = res.stderr + res.stdout;
  assert.match(combined, /already exists|already migrated/i);
});

test("FG-389: forge backlog-migrate --dry-run shows ticket count without writing files", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");

  const res = runForge(["backlog-migrate", "--dry-run", "--project", projectDir]);
  assert.equal(res.status, 0, `dry-run failed: ${res.stderr}`);
  // dry-run should print preview info
  assert.match(res.stdout, /Dry-run|dry-run|preview/i, "should show dry-run indicator");
  // should NOT create a backlog/ directory
  assert.ok(!existsSync(join(projectDir, "backlog")), "dry-run must not create backlog/ directory");
  // should NOT rename BACKLOG.md
  assert.ok(existsSync(join(projectDir, "BACKLOG.md")), "dry-run must not rename BACKLOG.md");
});

test("FG-389: forge backlog-migrate --dry-run previews ticket IDs with configured prefix", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");

  const res = runForge(["backlog-migrate", "--dry-run", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  // The legacy content has tickets #1, #2 (active) and #116 (done recent)
  // dry-run should show structured filenames with FG- prefix
  assert.match(res.stdout, /FG-1|FG-2|FG-116/, "should preview ticket IDs with configured prefix");
});

test("FG-389: forge backlog-migrate migrates BACKLOG.md to structured files and renames it", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");

  const res = runForge(["backlog-migrate", "--project", projectDir]);
  assert.equal(res.status, 0, `migration failed: ${res.stderr}\n${res.stdout}`);

  // BACKLOG.md should be renamed, not deleted
  assert.ok(!existsSync(join(projectDir, "BACKLOG.md")), "BACKLOG.md should be renamed away");
  assert.ok(existsSync(join(projectDir, "BACKLOG.md.old")), "BACKLOG.md.old should exist after migration");

  // Structured backlog/ directories should exist
  assert.ok(existsSync(join(projectDir, "backlog", "stories")), "backlog/stories/ must be created");
  assert.ok(existsSync(join(projectDir, "backlog", "done")), "backlog/done/ must be created");

  // Active tickets (#1, #2) should be in stories/
  const stories = readdirSync(join(projectDir, "backlog", "stories"));
  assert.ok(stories.length >= 2, `expected >=2 stories, got: ${stories.join(", ")}`);

  // Done ticket (#116) should be in done/
  const done = readdirSync(join(projectDir, "backlog", "done"));
  assert.ok(done.length >= 1, `expected >=1 done ticket, got: ${done.join(", ")}`);
});

test("FG-389: after migrate, forge backlog list works on the newly structured backlog", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");

  const migrateRes = runForge(["backlog-migrate", "--project", projectDir]);
  assert.equal(migrateRes.status, 0, `migration failed: ${migrateRes.stderr}`);

  // After migration, normal backlog commands should work on the new structured backlog
  const listRes = runForge(["backlog", "list", "--project", projectDir]);
  assert.equal(listRes.status, 0, `list after migrate failed: ${listRes.stderr}`);
  // Should show FG-prefixed structured tickets
  assert.match(listRes.stdout, /FG-/, "list should show structured tickets with FG- prefix");
});

test("FG-389: forge backlog notes shows backlog/notes.md content written during migration", () => {
  writeFileSync(join(projectDir, "BACKLOG.md"), LEGACY_BACKLOG_CONTENT);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");

  const migrateRes = runForge(["backlog-migrate", "--project", projectDir]);
  assert.equal(migrateRes.status, 0, `migration failed: ${migrateRes.stderr}`);

  // Legacy content has notes: "Some handoff notes."
  // After migration, forge backlog notes show should read them from backlog/notes.md
  assert.ok(existsSync(join(projectDir, "backlog", "notes.md")), "backlog/notes.md must exist after migration");
  const notesContent = readFileSync(join(projectDir, "backlog", "notes.md"), "utf8");
  assert.match(notesContent, /Some handoff notes/, "notes content must be preserved from BACKLOG.md");
});
