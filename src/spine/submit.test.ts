// Tests for `forge submit` (FORGE-DEC-016): validates the artifact-existence
// rules, hard-errors on missing designDir, and transitions awaiting_human_input
// → awaiting_gate with the captured paths in result.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { submit } from "./submit.js";
import { validateUiDesignArtifacts } from "./submitValidators.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let designDir: string;

const RUN_BASE: Omit<Run, "metadata"> = {
  id: "run-submit",
  workflow: "ui-design",
  title: "stats widget",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
};

function reviewTask(): Task {
  return {
    id: "t-review",
    runId: RUN_BASE.id,
    phase: "ui-review",
    agentRole: "",
    status: "awaiting_human_input",
    taskPackage: {
      taskId: "t-review",
      runId: RUN_BASE.id,
      phase: "ui-review",
      role: "",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-08T00:00:00Z",
  };
}

function seedHappyPath(dir: string) {
  // Slug derives from basename(designDir), not the run title — that's the
  // contract the prompt-author writes into PROMPT.md. Tests create designDirs
  // with a fixed basename ("stats-widget") via a tmp parent.
  writeFileSync(join(dir, "stats-widget.pen"), "PENCIL_FILE_BYTES");
  mkdirSync(join(dir, "designs"));
  writeFileSync(join(dir, "designs", "01-home.png"), "PNG");
  mkdirSync(join(dir, "code"));
  writeFileSync(join(dir, "code", "01-home.html"), "<html></html>");
}

let tmpParent: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  // Create a tmp parent dir, then designDir under it with a fixed basename so
  // the validator's basename-derived slug is deterministic.
  tmpParent = mkdtempSync(join(tmpdir(), "forge-submit-test-"));
  designDir = join(tmpParent, "stats-widget");
  mkdirSync(designDir);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(tmpParent, { recursive: true, force: true });
});

// ---------- validator ----------

test("validateUiDesignArtifacts: throws when .pen is missing", () => {
  mkdirSync(join(designDir, "designs"));
  writeFileSync(join(designDir, "designs", "x.png"), "PNG");
  mkdirSync(join(designDir, "code"));
  writeFileSync(join(designDir, "code", "x.html"), "h");
  assert.throws(
    () => validateUiDesignArtifacts(designDir, "stats widget"),
    /stats-widget\.pen/
  );
});

test("validateUiDesignArtifacts: throws when .pen is 0 bytes (Cmd+S not pressed)", () => {
  writeFileSync(join(designDir, "stats-widget.pen"), "");
  mkdirSync(join(designDir, "designs"));
  writeFileSync(join(designDir, "designs", "x.png"), "PNG");
  mkdirSync(join(designDir, "code"));
  writeFileSync(join(designDir, "code", "x.html"), "h");
  assert.throws(
    () => validateUiDesignArtifacts(designDir, "stats widget"),
    /empty \(0 bytes\).*Cmd\+S/i
  );
});

test("validateUiDesignArtifacts: throws when no PNGs in designs/", () => {
  writeFileSync(join(designDir, "stats-widget.pen"), "PEN");
  mkdirSync(join(designDir, "designs"));
  mkdirSync(join(designDir, "code"));
  writeFileSync(join(designDir, "code", "x.html"), "h");
  assert.throws(
    () => validateUiDesignArtifacts(designDir, "stats widget"),
    /No PNG files/
  );
});

test("validateUiDesignArtifacts: throws when no HTML in code/", () => {
  writeFileSync(join(designDir, "stats-widget.pen"), "PEN");
  mkdirSync(join(designDir, "designs"));
  writeFileSync(join(designDir, "designs", "x.png"), "PNG");
  mkdirSync(join(designDir, "code"));
  assert.throws(
    () => validateUiDesignArtifacts(designDir, "stats widget"),
    /No HTML files/
  );
});

test("validateUiDesignArtifacts: .pen filename comes from basename(designDir), NOT the run title", () => {
  // The prompt-author seed tells the human "save to <basename(designDir)>.pen".
  // Validator must agree, regardless of how funky the title is. This test pins
  // the basename-not-title contract that the prompt-author + submit share.
  writeFileSync(join(designDir, "stats-widget.pen"), "PEN");
  mkdirSync(join(designDir, "designs"));
  writeFileSync(join(designDir, "designs", "x.png"), "PNG");
  mkdirSync(join(designDir, "code"));
  writeFileSync(join(designDir, "code", "x.html"), "h");
  // Title that would slugify to a different filename — validator should ignore it.
  const out = validateUiDesignArtifacts(designDir, "test-prompt-author-v3");
  assert.equal(out.penFile, join(designDir, "stats-widget.pen"));
});

test("validateUiDesignArtifacts: success returns sorted absolute paths", () => {
  writeFileSync(join(designDir, "stats-widget.pen"), "PEN");
  mkdirSync(join(designDir, "designs"));
  writeFileSync(join(designDir, "designs", "02-detail.png"), "PNG");
  writeFileSync(join(designDir, "designs", "01-home.png"), "PNG");
  mkdirSync(join(designDir, "code"));
  writeFileSync(join(designDir, "code", "01-home.html"), "h");
  const out = validateUiDesignArtifacts(designDir, "stats widget");
  assert.equal(out.penFile, join(designDir, "stats-widget.pen"));
  assert.deepEqual(out.pngFiles, [
    join(designDir, "designs", "01-home.png"),
    join(designDir, "designs", "02-detail.png"),
  ]);
  assert.deepEqual(out.htmlFiles, [join(designDir, "code", "01-home.html")]);
});

// ---------- submit ----------

test("submit: throws when task is not awaiting_human_input", async () => {
  insertRun({ ...RUN_BASE, metadata: { designDir } });
  const t = reviewTask();
  t.status = "complete";
  insertTask(t);
  await assert.rejects(submit(t.id), /not awaiting_human_input/);
});

test("submit: hard-errors when designDir is missing on the run", async () => {
  insertRun({ ...RUN_BASE });
  insertTask(reviewTask());
  await assert.rejects(submit("t-review"), /requires --design-dir/);
});

test("submit: success transitions to awaiting_gate with captured paths", async () => {
  insertRun({ ...RUN_BASE, metadata: { designDir } });
  insertTask(reviewTask());
  seedHappyPath(designDir);

  const out = await submit("t-review", { notes: "tried two color variants" });

  assert.equal(out.task.status, "awaiting_gate");
  assert.equal(out.result.status, "complete");
  assert.equal(out.result.penFile, join(designDir, "stats-widget.pen"));
  assert.equal(out.result.pngFiles.length, 1);
  assert.equal(out.result.htmlFiles.length, 1);
  assert.equal(out.result.notes, "tried two color variants");

  const refreshed = getTask("t-review")!;
  assert.equal(refreshed.status, "awaiting_gate");
  const persisted = refreshed.result as Record<string, unknown>;
  assert.equal(persisted.penFile, join(designDir, "stats-widget.pen"));
});

test("submit: omits notes from result when not provided", async () => {
  insertRun({ ...RUN_BASE, metadata: { designDir } });
  insertTask(reviewTask());
  seedHappyPath(designDir);

  const out = await submit("t-review");

  assert.equal(out.result.notes, undefined);
});

test("submit: validator failure leaves the task in awaiting_human_input", async () => {
  insertRun({ ...RUN_BASE, metadata: { designDir } });
  insertTask(reviewTask());
  // No artifacts seeded — validator should throw before we mutate.

  await assert.rejects(submit("t-review"), /Pencil source not found/);

  const refreshed = getTask("t-review")!;
  assert.equal(refreshed.status, "awaiting_human_input");
  assert.equal(refreshed.result, undefined);
});
