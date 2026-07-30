// Integration tests for task-manifest (#197, learnings/decisions/observability.md Crawl §5).
// Verify the manifest end-to-end across the dispatch → task-manifest → show boundary.
//
// Unit tests in invoke.integration.test.ts, runNext.integration.test.ts, show.test.ts cover each layer in
// isolation. These integration tests add:
//   1. invoke dispatch → manifest written with correct shape (full chain assertion)
//   2. invoke WITH real auth profile → secrets discipline when stateMounted=true
//   3. invoke WITHOUT auth profile → secrets discipline when stateMounted=false
//   4. show chain: invoke → real task dir → listPresentArtifacts via manifest index
//   5. show chain: older-task simulation → listPresentArtifacts fallback to stat scan
//   6. runNext pipeline dispatch → manifest written → show chain (performShow + artifacts)
//
// Run via: forge-test (full suite, no file args) per bug #199.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync, mkdirSync, existsSync, readFileSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { invoke, type DockerExecFn } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import { writeProfile } from "../util/auth-profiles.js";
import { listPresentArtifacts, performShow } from "../cli/commands/show.js";
import type { TaskManifest } from "./task-manifest.js";
import type { Workflow } from "./schema.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let savedApiKey: string | undefined;
let savedContainerHost: string | undefined;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedContainerHost = process.env.FORGE_CONTAINER_HOST;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedContainerHost === undefined) delete process.env.FORGE_CONTAINER_HOST;
  else process.env.FORGE_CONTAINER_HOST = savedContainerHost;
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStubExec(resultJson: unknown = { status: "complete", tests_run: 1 }, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(resultJson));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

function ensureClaudeRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `name: claude
description: test stub runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
}

// Write a browser-tools-capable runtime for auth-profile tests (#176, #181, #183).
// Returns the btDir path so the caller can populate it.
function setupBtRuntime(): string {
  const fhome = process.env.FORGE_HOME!;
  const btDir = join(fhome, "bt-integ-skill");
  mkdirSync(btDir, { recursive: true });
  // #181 guard: auth-inject.js must exist in the browser-tools skill dir.
  writeFileSync(join(btDir, "auth-inject.js"), "// stub injector for integration tests\n");
  const runtimePath = join(fhome, "runtimes", "claude-bt-integ.yml");
  // Embed the literal btDir path — the runtime YAML carries the host path so
  // spawn.ts's substitute() leaves it intact (no ${...} template here).
  writeFileSync(runtimePath, `name: claude-bt-integ
description: browser-tools stub for manifest integration tests
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
  - { host: "${btDir}", container: /home/agent/.claude/skills/browser-tools }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
  return btDir;
}

function makeSupabaseValue(expiresAt: number): string {
  return JSON.stringify({ access_token: "h.p.s", expires_at: expiresAt, refresh_token: "r" });
}

const ONE_STEP_WF: Workflow = {
  name: "test-manifest-integ-wf",
  description: "single-step workflow for manifest integration tests",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "work",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
  ],
};

// ─── 1. Dispatch writes manifest — full chain from invoke through filesystem ──

test("integ manifest dispatch: invoke writes manifest.json with full correct shape — taskId, runId, files, container, auth", async () => {
  ensureClaudeRuntime();

  const r = await invoke({
    agentRole: "engineer",
    task: "do the thing",
    projectDir: "/tmp/integ-manifest-project",
    dockerExec: makeStubExec({ status: "complete", tests_run: 1 }),
  });

  assert.equal(r.status, "complete");

  const dir = taskDir(r.runId, r.taskId);
  const manifestPath = join(dir, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json must exist in the task dir after invoke dispatch");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
  assert.equal(manifest.taskId, r.taskId, "taskId must match the dispatched task");
  assert.equal(manifest.runId, r.runId, "runId must match the owning run");
  assert.deepEqual(manifest.files, {
    prompt: "CLAUDE.md",
    package: "package.md",
    result: "result.json",
    stdout: "container.stdout.log",
    stderr: "container.stderr.log",
  }, "files map must enumerate all five known artifacts with correct filenames");
  assert.equal(manifest.container.name, `forge-${r.taskId}`,
    "container.name must be forge-<taskId>");
  assert.equal(typeof manifest.container.idleTimeoutMs, "number",
    "container.idleTimeoutMs must record the effective timeout this task ran under");
  assert.ok(manifest.container.idleTimeoutMs! > 0, "idleTimeoutMs must be positive");
  assert.equal(typeof manifest.auth.profileRequested, "boolean");
  assert.equal(typeof manifest.auth.stateMounted, "boolean");

  // performShow confirms the task is queryable — same IDs, manifest readable
  const show = performShow(r.taskId);
  assert.equal(show.kind, "task");
  if (show.kind === "task") {
    assert.equal(show.task.id, r.taskId, "performShow must find the dispatched task");
    assert.equal(show.task.runId, r.runId);
  }
});

// ─── 2. Secrets discipline: WITH real auth profile (stateMounted=true) ────────

test("integ manifest secrets: invoke WITH staging auth profile → auth block is EXACTLY {profileRequested:true, stateMounted:true}, no credential material", async () => {
  // Non-localhost staging profile: reconcileStateForContainer returns changed=false,
  // so hostPath = original profile path (non-empty) → stateMounted=true.
  delete process.env.FORGE_CONTAINER_HOST;
  setupBtRuntime();

  const future = Math.floor(Date.now() / 1000) + 3600;
  writeProfile("integ-staging-auth-profile", {
    cookies: [],
    origins: [{
      origin: "https://staging.example.test",
      localStorage: [{ name: "sb-x-auth-token", value: makeSupabaseValue(future) }],
    }],
  });

  const r = await invoke({
    agentRole: "manual-qa",
    task: "test the staging app",
    projectDir: "/tmp/integ-manifest-project",
    authProfile: "integ-staging-auth-profile",
    runtimeName: "claude-bt-integ",
    dockerExec: makeStubExec({ status: "complete", tests_run: 1 }),
  });

  assert.equal(r.status, "complete", "invoke with valid staging auth profile must succeed");

  const dir = taskDir(r.runId, r.taskId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;

  // Auth block values
  assert.equal(manifest.auth.profileRequested, true,
    "profileRequested must be true when --auth-profile was supplied");
  assert.equal(manifest.auth.stateMounted, true,
    "stateMounted must be true when auth state was resolved and will be mounted");

  // SECRETS DISCIPLINE: auth block must have EXACTLY {profileRequested, stateMounted}
  const authKeys = Object.keys(manifest.auth).sort();
  assert.deepEqual(authKeys, ["profileRequested", "stateMounted"],
    "auth block must have EXACTLY two keys: profileRequested and stateMounted — no extras");

  // Both must be booleans — no string, number, or object values
  assert.equal(typeof manifest.auth.profileRequested, "boolean",
    "profileRequested must be a boolean");
  assert.equal(typeof manifest.auth.stateMounted, "boolean",
    "stateMounted must be a boolean");

  // No string values containing '/' (no file paths, no bearer tokens, no URLs)
  for (const [k, v] of Object.entries(manifest.auth as Record<string, unknown>)) {
    assert.ok(
      typeof v !== "string",
      `auth.${k} must be a boolean, not a string (strings may carry credentials): ${String(v)}`,
    );
  }

  // Explicitly forbid keys that would carry credential material
  const credentialKeys = ["token", "profile", "path", "hostPath", "state",
    "secret", "key", "bearer", "name", "origin", "url"];
  for (const k of credentialKeys) {
    assert.ok(!(k in manifest.auth), `auth block must not contain '${k}' — credential/path leakage`);
  }

  // Profile name must not appear anywhere in the serialised auth block
  const authJson = JSON.stringify(manifest.auth);
  assert.ok(
    !authJson.includes("integ-staging-auth-profile"),
    "profile name must not appear in the manifest auth block",
  );
  // No filesystem path separator in the serialised auth block
  assert.ok(
    !authJson.includes("/"),
    "manifest auth block must not contain '/' — no host paths or URL credentials",
  );
});

// ─── 3. Secrets discipline: WITHOUT auth profile (stateMounted=false) ─────────

test("integ manifest secrets: invoke WITHOUT auth profile → auth block is EXACTLY {profileRequested:false, stateMounted:false}", async () => {
  ensureClaudeRuntime();

  const r = await invoke({
    agentRole: "engineer",
    task: "no auth needed here",
    projectDir: "/tmp/integ-manifest-project",
    dockerExec: makeStubExec({ status: "complete", tests_run: 1 }),
  });

  assert.equal(r.status, "complete");

  const dir = taskDir(r.runId, r.taskId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;

  assert.equal(manifest.auth.profileRequested, false,
    "profileRequested must be false when no auth profile was supplied");
  assert.equal(manifest.auth.stateMounted, false,
    "stateMounted must be false when no auth state was resolved");

  const authKeys = Object.keys(manifest.auth).sort();
  assert.deepEqual(authKeys, ["profileRequested", "stateMounted"],
    "auth block must have EXACTLY {profileRequested, stateMounted} — no extra keys");

  // No string values (both must be booleans)
  for (const v of Object.values(manifest.auth as Record<string, unknown>)) {
    assert.ok(typeof v !== "string",
      `auth values must all be booleans: ${String(v)}`);
  }
});

// ─── 4. show chain: invoke → real task dir with manifest → listPresentArtifacts ─

test("integ manifest show: task WITH manifest.json → listPresentArtifacts uses manifest as authoritative index, not raw stat scan", async () => {
  ensureClaudeRuntime();

  const r = await invoke({
    agentRole: "engineer",
    task: "build artifact index",
    projectDir: "/tmp/integ-manifest-project",
    dockerExec: makeStubExec({ status: "complete", tests_run: 1 }),
  });

  assert.equal(r.status, "complete");
  const dir = taskDir(r.runId, r.taskId);

  // Confirm manifest is present (written by invoke dispatch)
  assert.ok(existsSync(join(dir, "manifest.json")), "manifest.json must be present");

  // performShow confirms task is in DB
  const show = performShow(r.taskId);
  assert.equal(show.kind, "task");

  // listPresentArtifacts: uses manifest as authoritative index when manifest exists.
  // invoke + stub exec writes: CLAUDE.md, package.md, result.json, container.stdout.log,
  // container.stderr.log. All are in manifest.files so all should appear.
  const artifacts = listPresentArtifacts(dir);

  assert.ok(artifacts.includes("CLAUDE.md"), "CLAUDE.md (prompt) must appear via manifest index");
  assert.ok(artifacts.includes("package.md"), "package.md must appear via manifest index");
  assert.ok(artifacts.includes("result.json"), "result.json must appear via manifest index");
  assert.ok(artifacts.includes("container.stdout.log"),
    "container.stdout.log must appear via manifest index");

  // manifest.json itself must NOT appear — it is the index, not an artifact
  assert.ok(!artifacts.includes("manifest.json"),
    "manifest.json must not appear as an artifact in its own index");

  // Verify via negative: write an extra file NOT in manifest.files.
  // The manifest-based path must NOT return it (unlike a raw stat scan which would).
  writeFileSync(join(dir, "extra-debug.txt"), "debug output");
  const artifactsAfter = listPresentArtifacts(dir);
  assert.ok(!artifactsAfter.includes("extra-debug.txt"),
    "files not listed in manifest.files must not appear when manifest is authoritative");
});

// ─── 5. show chain: older task (no manifest) → listPresentArtifacts fallback ─

test("integ manifest show: task WITHOUT manifest.json (older task) → listPresentArtifacts falls back to direct stat scan", async () => {
  ensureClaudeRuntime();

  const r = await invoke({
    agentRole: "engineer",
    task: "simulate older task with no manifest",
    projectDir: "/tmp/integ-manifest-project",
    dockerExec: makeStubExec({ status: "complete", tests_run: 1 }),
  });

  const dir = taskDir(r.runId, r.taskId);

  // Simulate an older task by removing the manifest (as if it was created before #197).
  rmSync(join(dir, "manifest.json"));
  assert.ok(!existsSync(join(dir, "manifest.json")), "manifest.json removed for older-task simulation");

  // performShow still returns the task (DB row unaffected by manifest presence)
  const show = performShow(r.taskId);
  assert.equal(show.kind, "task",
    "performShow must still find the task even without manifest.json");
  if (show.kind === "task") {
    assert.equal(show.task.id, r.taskId);
  }

  // listPresentArtifacts falls back to the hardcoded known-files scan.
  // invoke + stub exec wrote: CLAUDE.md, package.md, result.json, container.stdout.log.
  const artifacts = listPresentArtifacts(dir);
  assert.ok(artifacts.length > 0,
    "fallback stat scan must return at least some artifacts when files are present");
  assert.ok(artifacts.includes("result.json"),
    "result.json must be found via fallback stat scan");
  assert.ok(artifacts.includes("CLAUDE.md"),
    "CLAUDE.md must be found via fallback stat scan");

  // The fallback stat scan covers the known hardcoded list — extra files not in
  // the hardcoded list are NOT returned (unlike a glob scan of the whole dir).
  assert.ok(!artifacts.includes("manifest.json"),
    "manifest.json must not appear even in fallback (it was deleted)");
});

// ─── 6. runNext pipeline dispatch → manifest → show chain ────────────────────

test("integ manifest pipeline: runNext dispatch writes manifest.json → correct shape → listPresentArtifacts reads it via manifest index", async () => {
  ensureClaudeRuntime();

  const { runId } = startRun({
    workflow: ONE_STEP_WF,
    title: "manifest integration pipeline test",
    inputs: {},
    projectDir: "/tmp/integ-manifest-project",
  });

  await runNext({
    runId,
    workflow: ONE_STEP_WF,
    dockerExec: makeStubExec({ status: "complete", tests_run: 1 }),
  });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined);
  assert.ok(primary, "primary task must exist after runNext dispatch");
  assert.equal(primary!.status, "complete");

  const dir = taskDir(runId, primary!.id);
  const manifestPath = join(dir, "manifest.json");
  assert.ok(existsSync(manifestPath),
    "manifest.json must be written into the task dir by runNext dispatch");

  // Manifest shape verification
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
  assert.equal(manifest.taskId, primary!.id, "taskId must match primary task id");
  assert.equal(manifest.runId, runId, "runId must match the workflow run");
  assert.equal(manifest.container.name, `forge-${primary!.id}`,
    "container.name must be forge-<taskId>");

  // Auth block: no auth profile on this workflow → booleans-only false values
  assert.deepEqual(Object.keys(manifest.auth).sort(), ["profileRequested", "stateMounted"],
    "auth block must have exactly the two boolean keys");
  assert.equal(manifest.auth.profileRequested, false);
  assert.equal(manifest.auth.stateMounted, false);

  // performShow sees the task
  const show = performShow(primary!.id);
  assert.equal(show.kind, "task");
  if (show.kind === "task") {
    assert.equal(show.task.id, primary!.id);
  }

  // listPresentArtifacts uses manifest as authoritative index
  const artifacts = listPresentArtifacts(dir);
  assert.ok(artifacts.length > 0,
    "manifest-based artifact index must return present files from pipeline dispatch");
  assert.ok(!artifacts.includes("manifest.json"),
    "manifest.json must not appear in its own artifact index");

  // The manifest's files map covers all five known artifacts; stub exec wrote
  // result.json and the log files. CLAUDE.md and package.md are written by runContainer.
  assert.ok(artifacts.includes("result.json"), "result.json must appear via manifest index");
  assert.ok(artifacts.includes("container.stdout.log"),
    "container.stdout.log must appear via manifest index");
});

