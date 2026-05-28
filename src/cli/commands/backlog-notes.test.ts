import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression coverage for `forge backlog notes replace`. The bug (fixed
// 2026-05-28): `replace` read only stdin and ignored argv, while the /handoff
// command invokes `notes replace "<block>"` with the text as an argument. The
// arg was dropped and the empty stdin silently wiped the whole Notes block,
// which is why successive sessions kept finding stale handoff notes.

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

const BACKLOG = `# Backlog

## Notes for next session

ORIGINAL NOTE — must be replaced.

## Active

### #1 — sample ticket

body
`;

let projectDir: string;

function runForge(args: string[], input?: string) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: projectDir,
    input: input ?? "",
    encoding: "utf8",
  });
}

function currentNotes(): string {
  return readFileSync(join(projectDir, "BACKLOG.md"), "utf8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-notes-"));
  writeFileSync(join(projectDir, "BACKLOG.md"), BACKLOG);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("notes replace: text passed as argv lands in the block (the /handoff path)", () => {
  const res = runForge(["backlog", "notes", "replace", "**Picked up next:** ship it."]);
  assert.equal(res.status, 0, res.stderr);
  const notes = currentNotes();
  assert.match(notes, /\*\*Picked up next:\*\* ship it\./);
  assert.doesNotMatch(notes, /ORIGINAL NOTE/);
  assert.match(notes, /### #1 — sample ticket/); // tickets untouched
});

test("notes replace: '-' reads replacement from stdin", () => {
  const res = runForge(["backlog", "notes", "replace", "-"], "**Where we left off:** stdin.\n");
  assert.equal(res.status, 0, res.stderr);
  assert.match(currentNotes(), /\*\*Where we left off:\*\* stdin\./);
});

test("notes replace: empty input errors instead of wiping the block", () => {
  const res = runForge(["backlog", "notes", "replace"]); // no argv, empty stdin
  assert.equal(res.status, 1);
  assert.match(res.stderr, /empty input/);
  assert.match(currentNotes(), /ORIGINAL NOTE/); // original survived
});
