// Integration tests for FG-374: project-mount resolution.
//
// Unit tests in src/util/resolve-project-mount.test.ts cover the 3-case matrix
// of resolveProjectMount() in isolation. These tests cover the integration surface:
//
//   1. MANIFEST: invoke with FG-374 fields → written controlPlane block carries
//      invocationCwd, resolvedFromSubdir, explicitSubproject with correct values.
//   2. MANIFEST: legacy-safety — invoke WITHOUT FG-374 fields produces a manifest
//      whose controlPlane.invocationCwd/resolvedFromSubdir/explicitSubproject are
//      absent (not `null`, not `false` — absent); the manifest is still parseable.
//   3. PREFLIGHT: preflightProjectMount passes when .git marker is present.
//   4. PREFLIGHT: preflightProjectMount passes when package.json marker is present.
//   5. PREFLIGHT: preflightProjectMount throws a clear, actionable error when
//      neither marker is present (hard-fail path).
//   6. CLI wiring: SKIPPED — requires a real container; see note below.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { invoke, type DockerExecFn } from "./invoke.js";
import { taskDir } from "../util/paths.js";
import type { TaskManifest } from "./task-manifest.js";
import { preflightProjectMount } from "./spawn.js";

// ─── Shared test harness ─────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let savedApiKey: string | undefined;
let tmpProjectDir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  // Create a temp dir with a package.json so preflightProjectMount passes inside invoke.
  tmpProjectDir = mkdtempSync(join(tmpdir(), "forge-fg374-proj-"));
  writeFileSync(join(tmpProjectDir, "package.json"), "{}");
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  rmSync(tmpProjectDir, { recursive: true, force: true });
});

function makeStubExec(resultJson: unknown = { status: "complete" }, exitCode = 0): DockerExecFn {
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
  if (existsSync(runtimePath)) return;
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

// ─── 1. MANIFEST: FG-374 fields propagate into controlPlane block ────────────

test("fg374 manifest: invoke with invocationCwd/resolvedFromSubdir/explicitSubproject → controlPlane carries correct values", async () => {
  ensureClaudeRuntime();

  // Simulate: invoked from a subdirectory, resolved up to project root.
  const fakeInvocationCwd = join(tmpProjectDir, "packages", "api");

  const r = await invoke({
    agentRole: "engineer",
    task: "implement the feature",
    projectDir: tmpProjectDir,
    invocationCwd: fakeInvocationCwd,
    resolvedFromSubdir: true,
    explicitSubproject: false,
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "complete");

  const dir = taskDir(r.runId, r.taskId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;

  assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
  assert.equal(
    manifest.controlPlane!.invocationCwd,
    fakeInvocationCwd,
    "invocationCwd must match the value passed to invoke"
  );
  assert.equal(
    manifest.controlPlane!.resolvedFromSubdir,
    true,
    "resolvedFromSubdir=true must be persisted in the manifest"
  );
  assert.equal(
    manifest.controlPlane!.explicitSubproject,
    false,
    "explicitSubproject=false must be persisted when explicitly provided"
  );
  // Sanity: projectDir is still correct (not clobbered by invocationCwd)
  assert.equal(manifest.controlPlane!.projectDir, tmpProjectDir);
});

test("fg374 manifest: explicitSubproject=true is persisted when --allow-subproject was used", async () => {
  ensureClaudeRuntime();

  const r = await invoke({
    agentRole: "engineer",
    task: "intentional subdir mount",
    projectDir: tmpProjectDir,
    invocationCwd: tmpProjectDir,
    resolvedFromSubdir: false,
    explicitSubproject: true,
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "complete");

  const dir = taskDir(r.runId, r.taskId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;

  assert.ok(manifest.controlPlane !== undefined);
  assert.equal(manifest.controlPlane!.explicitSubproject, true,
    "explicitSubproject=true must be persisted when --allow-subproject was passed");
  assert.equal(manifest.controlPlane!.resolvedFromSubdir, false);
});

// ─── 2. MANIFEST: legacy-safety — FG-374 fields are optional ─────────────────

test("fg374 manifest legacy-safety: invoke WITHOUT fg374 fields → controlPlane.invocationCwd/resolvedFromSubdir/explicitSubproject are absent, manifest still parseable", async () => {
  ensureClaudeRuntime();

  // Do NOT pass invocationCwd, resolvedFromSubdir, or explicitSubproject.
  // This simulates a pre-FG-374 call path or a caller that omits them.
  const r = await invoke({
    agentRole: "engineer",
    task: "legacy invoke with no mount metadata",
    projectDir: tmpProjectDir,
    dockerExec: makeStubExec({ status: "complete" }),
  });

  assert.equal(r.status, "complete");

  const dir = taskDir(r.runId, r.taskId);
  const raw = readFileSync(join(dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as TaskManifest;

  // controlPlane itself is written (FG-350 is active), but the optional FG-374
  // fields must NOT appear when the caller didn't pass them.
  assert.ok(manifest.controlPlane !== undefined, "controlPlane block must still be present");
  assert.equal(
    manifest.controlPlane!.invocationCwd,
    undefined,
    "invocationCwd must be absent when not provided — not null or false"
  );
  assert.equal(
    manifest.controlPlane!.resolvedFromSubdir,
    undefined,
    "resolvedFromSubdir must be absent when not provided"
  );
  assert.equal(
    manifest.controlPlane!.explicitSubproject,
    undefined,
    "explicitSubproject must be absent when not provided"
  );

  // The JSON must not contain these keys at all (not just undefined at runtime).
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const cp = parsed.controlPlane as Record<string, unknown> | undefined;
  assert.ok(cp !== undefined);
  assert.ok(!("invocationCwd" in cp!), "invocationCwd key must not appear in serialised JSON");
  assert.ok(!("resolvedFromSubdir" in cp!), "resolvedFromSubdir key must not appear in serialised JSON");
  assert.ok(!("explicitSubproject" in cp!), "explicitSubproject key must not appear in serialised JSON");
});

// ─── 3–5. PREFLIGHT: preflightProjectMount — direct function tests ────────────
// Tests use real temp directories. No container invocation.

test("fg374 preflight: passes when .git marker is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-preflight-git-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    // Must not throw
    assert.doesNotThrow(
      () => preflightProjectMount(dir),
      "preflightProjectMount must pass when .git is present"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fg374 preflight: passes when package.json marker is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-preflight-pkg-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    assert.doesNotThrow(
      () => preflightProjectMount(dir),
      "preflightProjectMount must pass when package.json is present"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fg374 preflight: passes when both .git and package.json are present", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-preflight-both-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    assert.doesNotThrow(
      () => preflightProjectMount(dir),
      "preflightProjectMount must pass when both markers are present"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fg374 preflight: throws clear actionable error when no marker present", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-preflight-empty-"));
  try {
    assert.throws(
      () => preflightProjectMount(dir),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        // The message must name the projectDir so operators can diagnose which dir failed.
        assert.ok(
          (err as Error).message.includes(dir),
          `error message must include the failing dir: ${(err as Error).message}`
        );
        // The message must name the expected markers so the operator knows what to check.
        assert.match((err as Error).message, /\.git/, "error must mention .git marker");
        assert.match((err as Error).message, /package\.json/, "error must mention package.json marker");
        // Must name the preflight so it's diagnosable in CI logs.
        assert.match(
          (err as Error).message,
          /preflight/i,
          "error must reference preflight to distinguish from other mount errors"
        );
        return true;
      },
      "preflightProjectMount must throw with a clear, actionable error when no marker is present"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. CLI wiring: skipped ──────────────────────────────────────────────────
// Asserting that the CLI (invoke.ts command handler) passes explicitSubproject
// through to invoke() would require a real container or a full CLI invocation
// harness that spawns a child process. The integration path from resolveProjectMount
// → invoke args is exercised at the unit level (the CLI calls resolveProjectMount
// and spreads its result into invoke args — readable directly in
// src/cli/commands/invoke.ts lines 57-98). A container-free wiring test would
// require mocking the commander action, which duplicates the unit test surface.
// The end-to-end manifest tests above (tests 1 & 2) prove the full chain from
// invoke() args → controlPlane block → written manifest.json, which is the
// observable integration boundary that matters for ops.
