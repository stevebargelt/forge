// FG-830: `readCheckoutNotes` pairs a note's content with the mtime of the same revision,
// even when `forge backlog notes` rewrites the file mid-read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCheckoutNotes } from "./checkout-notes.js";

const OLD = new Date("2026-09-01T00:00:00.000Z");
const NEW = new Date("2026-09-29T00:00:00.000Z");

function notesFile(content: string, mtime: Date): string {
  const path = join(mkdtempSync(join(tmpdir(), "fg830-checkout-notes-")), "notes.md");
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
  return path;
}

test("FG-830: an in-place rewrite during the read never pairs old content with the new mtime", () => {
  const path = notesFile("Old undated handoff.\n", OLD);
  let calls = 0;
  const result = readCheckoutNotes(path, () => {
    if (calls++ > 0) return;
    writeFileSync(path, "New undated handoff, a longer revision.\n");
    utimesSync(path, NEW, NEW);
  });
  assert.deepEqual(result, { notes: "New undated handoff, a longer revision.\n", modifiedAt: NEW.toISOString() });
  assert.equal(calls, 2, "the straddled read is retried");
});

test("FG-830: a replace-by-rename during the read keeps the opened revision's content and mtime together", () => {
  const path = notesFile("Old undated handoff.\n", OLD);
  const result = readCheckoutNotes(path, () => {
    const next = `${path}.next`;
    writeFileSync(next, "New undated handoff.\n");
    utimesSync(next, NEW, NEW);
    renameSync(next, path);
  });
  assert.deepEqual(result, { notes: "Old undated handoff.\n", modifiedAt: OLD.toISOString() });
});

test("FG-830: a note that never settles reports its mtime as unknown, not guessed", () => {
  const path = notesFile("v0\n", OLD);
  let n = 0;
  const result = readCheckoutNotes(path, () => {
    n += 1;
    writeFileSync(path, `v${n} ${"x".repeat(n)}\n`);
    utimesSync(path, new Date(OLD.getTime() + n * 1000), new Date(OLD.getTime() + n * 1000));
  });
  assert.equal(result.modifiedAt, null);
});

test("FG-830: a missing note reads as empty with no mtime; a quiet one as its content and mtime", () => {
  assert.deepEqual(readCheckoutNotes(join(tmpdir(), "fg830-no-such-dir", "notes.md")), { notes: "", modifiedAt: null });
  const path = notesFile("**Last session ended 2026-08-13.**\n", OLD);
  assert.deepEqual(readCheckoutNotes(path), { notes: "**Last session ended 2026-08-13.**\n", modifiedAt: OLD.toISOString() });
});
