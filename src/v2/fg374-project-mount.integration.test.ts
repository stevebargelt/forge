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
//   5. PREFLIGHT: preflightProjectMount throws on an EMPTY directory (genuinely
//      broken mount). A non-empty dir WITHOUT markers passes with a warning.
//   6. CLI wiring: exercises the option-parsing → resolveProjectMount seam that
//      the FG-359 incident exposed (running from a workspace subdir).

import { test, beforeEach, afterEach, mock } from "node:test";
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
import { resolveProjectMount } from "../util/resolve-project-mount.js";

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

test("fg374 preflight: throws when directory does not exist", () => {
  const dir = "/tmp/forge-preflight-nonexistent-should-not-exist-" + Date.now();
  assert.throws(
    () => preflightProjectMount(dir),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes(dir));
      assert.match((err as Error).message, /preflight/i);
      assert.match((err as Error).message, /does not exist/i);
      return true;
    },
    "preflightProjectMount must throw when the directory does not exist"
  );
});

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

test("fg374 preflight: warns (does not throw) for an empty directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-preflight-empty-"));
  const warnLines: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnLines.push(args.join(" ")); };
  try {
    assert.doesNotThrow(
      () => preflightProjectMount(dir),
      "preflightProjectMount must NOT throw for an empty dir — only warns"
    );
    assert.ok(
      warnLines.some((l) => l.includes(dir)),
      "must emit a console.warn mentioning the dir when it is empty"
    );
    assert.ok(
      warnLines.some((l) => /empty/i.test(l)),
      "warning must mention that the directory is empty"
    );
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fg374 preflight: passes (with warning) for non-empty dir without .git or package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-preflight-nomarker-"));
  const warnLines: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnLines.push(args.join(" ")); };
  try {
    writeFileSync(join(dir, "README.md"), "# project");
    assert.doesNotThrow(
      () => preflightProjectMount(dir),
      "preflightProjectMount must NOT throw for a non-empty dir without markers"
    );
    assert.ok(
      warnLines.some((l) => l.includes(dir)),
      "must emit a console.warn mentioning the dir when no marker is present"
    );
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. CLI wiring: option-parsing → resolveProjectMount seam ───────────────
// The FG-359 incident was triggered by a CLI command run from a workspace
// subdir. These tests exercise the resolveProjectMount boundary that the CLI
// option-parsing feeds into — the same seam that would have caught FG-359.
// We test the seam directly (parse-equivalent args → resolved result) rather
// than driving Commander full-stack, which requires a container. The unit tests
// in src/util/resolve-project-mount.test.ts cover resolveProjectMount in
// isolation; these integration tests verify the OUTCOME the CLI produces for
// each user-visible option combination.

test("fg374 cli-seam: implicit invocation from workspace subdir → resolves to git root", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fg374-cli-root-"));
  try {
    // Set up a git repo root with confident markers
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const sub = join(root, "dashboard");
    mkdirSync(sub, { recursive: true });

    // Simulate: no --project flag (requestedDir=undefined), isTTY=false, cwd=subdir
    // This mirrors: running `forge invoke` from `<repo>/dashboard/`
    const result = resolveProjectMount(undefined, { isTTY: false, json: false, allowSubproject: false }, sub);

    assert.equal(result.projectDir, root, "must resolve up to the git root");
    assert.equal(result.resolvedFromSubdir, true, "must set resolvedFromSubdir=true");
    assert.equal(result.explicitSubproject, false);
    assert.equal(result.invocationCwd, sub, "invocationCwd must record where we were invoked from");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fg374 cli-seam: explicit --project <subdir> with --json hard-fails (automation guard)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fg374-cli-hardfail-"));
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const sub = join(root, "dashboard");
    mkdirSync(sub, { recursive: true });

    // Simulate: --project <subdir> --json (automation mode, no --allow-subproject)
    // This is the failure mode from FG-359: explicit subdir + json flag = hard-fail.
    assert.throws(
      () => resolveProjectMount(sub, { isTTY: true, json: true, allowSubproject: false }),
      /is a subdirectory of/,
      "must hard-fail when --project is a subdir and --json is set"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fg374 cli-seam: explicit --project <subdir> + --allow-subproject succeeds with explicitSubproject=true", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fg374-cli-allowsub-"));
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const sub = join(root, "packages", "api");
    mkdirSync(sub, { recursive: true });

    // Simulate: --project <subdir> --allow-subproject (intentional subdir mount)
    const result = resolveProjectMount(sub, { isTTY: false, json: false, allowSubproject: true });

    assert.equal(result.projectDir, sub, "must honor the requested subdir");
    assert.equal(result.explicitSubproject, true, "must set explicitSubproject=true");
    assert.equal(result.resolvedFromSubdir, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fg374 cli-seam: interactive (isTTY=true, json=false) warns and honors subdir", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fg374-cli-tty-"));
  const stderrLines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const sub = join(root, "dashboard");
    mkdirSync(sub, { recursive: true });

    // Simulate: interactive shell (isTTY=true, json=false), explicit --project <subdir>
    const result = resolveProjectMount(sub, { isTTY: true, json: false, allowSubproject: false });

    assert.equal(result.projectDir, sub, "must honor the subdir in interactive mode");
    assert.equal(result.explicitSubproject, false, "explicitSubproject is false (no --allow-subproject)");
    assert.ok(
      stderrLines.some((l) => l.includes("cross-workspace deps may be missing")),
      "must emit a warning about subdir mount in interactive mode"
    );
  } finally {
    mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  }
});
