import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { assembleBundle, NEVER_BUNDLE } from "./bundle.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let outRoot: string;

const RUN: Run = { id: "run-bundle", workflow: "feature", title: "bundle me", status: "complete", createdAt: "2026-05-20T00:00:00Z", projectDir: "/tmp/proj" };

function mkTask(id: string): Task {
  return { id, runId: RUN.id, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId: id, runId: RUN.id, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-20T00:00:00Z" };
}

// Materialize a task dir with the full set of real files, INCLUDING a secret.
function seedTaskDir(taskId: string) {
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ container: { name: `forge-${taskId}` }, auth: { profileRequested: false, stateMounted: false } }));
  writeFileSync(join(dir, "CLAUDE.md"), "system prompt");
  writeFileSync(join(dir, "package.md"), "task package");
  writeFileSync(join(dir, "container.stdout.log"), "stdout output\n");
  writeFileSync(join(dir, "container.stderr.log"), "stderr output\n");
  writeFileSync(join(dir, "progress.jsonl"), '{"type":"progress","message":"x"}\n');
  // THE SECRET — must never end up in the bundle.
  writeFileSync(join(dir, "auth-state.json"), JSON.stringify({ bearer: "SECRET-TOKEN-DO-NOT-LEAK" }));
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  outRoot = mkdtempSync(join(tmpdir(), "forge-bundle-test-"));
});
afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(outRoot, { recursive: true, force: true });
});

test("assembleBundle: SECURITY — auth-state.json is never included, no secret leaks", () => {
  insertTask(mkTask("task-a"));
  seedTaskDir("task-a");
  const r = assembleBundle(RUN.id, outRoot);

  // The secret file must not exist anywhere in the bundle.
  assert.ok(!existsSync(join(r.bundleDir, "tasks", "task-a", "auth-state.json")), "auth-state.json must NOT be copied");
  for (const f of r.filesIncluded) assert.ok(!NEVER_BUNDLE.some((n) => f.endsWith(n)), `bundle must not list a never-bundle file: ${f}`);

  // And the token string must not appear in ANY bundled file.
  const walk = (p: string): string[] =>
    readdirSync(p).flatMap((name) => {
      const full = join(p, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  for (const f of walk(r.bundleDir)) {
    assert.ok(!readFileSync(f, "utf8").includes("SECRET-TOKEN-DO-NOT-LEAK"), `secret leaked into ${f}`);
  }
});

test("assembleBundle: includes allowlisted files; prompts only with includePrompts", () => {
  insertTask(mkTask("task-a"));
  seedTaskDir("task-a");

  const noPrompts = assembleBundle(RUN.id, outRoot);
  assert.ok(existsSync(join(noPrompts.bundleDir, "tasks/task-a/result.json")));
  assert.ok(existsSync(join(noPrompts.bundleDir, "tasks/task-a/manifest.json")));
  assert.ok(existsSync(join(noPrompts.bundleDir, "tasks/task-a/container.stdout.log")));
  assert.ok(existsSync(join(noPrompts.bundleDir, "tasks/task-a/progress.jsonl")));
  assert.ok(!existsSync(join(noPrompts.bundleDir, "tasks/task-a/CLAUDE.md")), "prompts excluded by default");

  rmSync(noPrompts.bundleDir, { recursive: true, force: true });
  const withPrompts = assembleBundle(RUN.id, outRoot, { includePrompts: true });
  assert.ok(existsSync(join(withPrompts.bundleDir, "tasks/task-a/CLAUDE.md")), "prompts included on opt-in");
  assert.ok(existsSync(join(withPrompts.bundleDir, "tasks/task-a/package.md")));
});

test("assembleBundle: bundle.json carries run, tasks, events", () => {
  insertTask(mkTask("task-a"));
  seedTaskDir("task-a");
  logEvent("task.completed", { runId: RUN.id, taskId: "task-a" });
  const r = assembleBundle(RUN.id, outRoot);
  const manifest = JSON.parse(readFileSync(join(r.bundleDir, "bundle.json"), "utf8"));
  assert.equal(manifest.runId, RUN.id);
  assert.equal(manifest.run.title, "bundle me");
  assert.equal(manifest.tasks.length, 1);
  assert.equal(manifest.tasks[0].task.id, "task-a");
  assert.ok(manifest.events.some((e: { eventType: string }) => e.eventType === "task.completed"));
});

test("assembleBundle: SECURITY — bundle.json strips composedSystemPrompt + inputs unless --include-prompts", () => {
  const t: Task = {
    id: "task-pp", runId: RUN.id, phase: "engineer", agentRole: "engineer", status: "complete",
    taskPackage: { taskId: "task-pp", runId: RUN.id, phase: "engineer", role: "engineer",
      inputs: { brief: "SECRET-BRIEF-CONTENT" }, composedSystemPrompt: "SECRET-SYSTEM-PROMPT" },
    createdAt: "2026-05-20T00:00:00Z", result: { status: "complete" },
  };
  insertTask(t);
  const dir = taskDir(RUN.id, "task-pp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), "{}");

  // Default: prompt context must NOT be in bundle.json.
  const def = assembleBundle(RUN.id, outRoot);
  let raw = readFileSync(join(def.bundleDir, "bundle.json"), "utf8");
  assert.ok(!raw.includes("SECRET-SYSTEM-PROMPT"), "composedSystemPrompt must be stripped by default");
  assert.ok(!raw.includes("SECRET-BRIEF-CONTENT"), "inputs must be stripped by default");
  const manifest = JSON.parse(raw);
  const taskNode = manifest.tasks.find((x: any) => x.task.id === "task-pp").task;
  assert.equal(taskNode.taskPackage.composedSystemPrompt, undefined);
  assert.equal(taskNode.taskPackage.inputs, undefined);
  assert.equal(taskNode.taskPackage.role, "engineer", "identity fields retained");
  assert.deepEqual(taskNode.result, { status: "complete" }, "result (debug signal) retained");

  // Opt-in: now present.
  rmSync(def.bundleDir, { recursive: true, force: true });
  const withP = assembleBundle(RUN.id, outRoot, { includePrompts: true });
  raw = readFileSync(join(withP.bundleDir, "bundle.json"), "utf8");
  assert.ok(raw.includes("SECRET-SYSTEM-PROMPT"), "composedSystemPrompt included on opt-in");
  assert.ok(raw.includes("SECRET-BRIEF-CONTENT"), "inputs included on opt-in");
});

test("assembleBundle: bounds large logs to a tail and flags truncation", () => {
  insertTask(mkTask("task-big"));
  const dir = taskDir(RUN.id, "task-big");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), "{}");
  writeFileSync(join(dir, "container.stdout.log"), "X".repeat(400 * 1024)); // > 256KB cap
  const r = assembleBundle(RUN.id, outRoot);
  assert.ok(r.truncated.includes("tasks/task-big/container.stdout.log"), "large log must be flagged truncated");
  const bundled = readFileSync(join(r.bundleDir, "tasks/task-big/container.stdout.log"), "utf8");
  assert.ok(bundled.length < 400 * 1024, "bundled log must be smaller than the original");
  assert.match(bundled, /bundled tail/);
});

test("assembleBundle: throws on unknown run", () => {
  assert.throws(() => assembleBundle("run-nope", outRoot), /run not found/);
});
