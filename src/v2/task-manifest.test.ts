import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTaskManifest, type TaskManifest } from "./task-manifest.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "forge-manifest-test-"));
}

test("writeTaskManifest: produces the correct shape with all required fields", () => {
  const dir = makeTmpDir();
  try {
    writeTaskManifest(dir, {
      taskId: "task-abc",
      runId: "run-xyz",
      files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
      container: { name: "forge-task-abc" },
      auth: { profileRequested: false, stateMounted: false },
    });

    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as TaskManifest;

    assert.equal(parsed.taskId, "task-abc");
    assert.equal(parsed.runId, "run-xyz");
    assert.equal(parsed.files.prompt, "CLAUDE.md");
    assert.equal(parsed.files.package, "package.md");
    assert.equal(parsed.files.result, "result.json");
    assert.equal(parsed.files.stdout, "container.stdout.log");
    assert.equal(parsed.files.stderr, "container.stderr.log");
    assert.equal(parsed.container.name, "forge-task-abc");
    assert.equal(parsed.auth.profileRequested, false);
    assert.equal(parsed.auth.stateMounted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTaskManifest: auth block contains only booleans — no credential keys, no path values", () => {
  const dir = makeTmpDir();
  try {
    writeTaskManifest(dir, {
      taskId: "task-sec",
      runId: "run-sec",
      files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
      container: { name: "forge-task-sec" },
      auth: { profileRequested: true, stateMounted: true },
    });

    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as TaskManifest;

    // Auth block must have exactly two boolean keys
    const authKeys = Object.keys(parsed.auth);
    assert.deepEqual(authKeys.sort(), ["profileRequested", "stateMounted"]);
    assert.equal(typeof parsed.auth.profileRequested, "boolean");
    assert.equal(typeof parsed.auth.stateMounted, "boolean");

    // No credential fields
    const forbidden = ["token", "profile", "path", "hostPath", "state", "secret", "key"];
    for (const k of forbidden) {
      assert.ok(!(k in parsed.auth), `auth must not contain '${k}'`);
    }

    // No path-like values (containing '/') in auth
    for (const v of Object.values(parsed.auth as Record<string, unknown>)) {
      assert.ok(typeof v !== "string" || !v.includes("/"), `auth value must not be a path: ${String(v)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTaskManifest: profileRequested=false, stateMounted=false when no auth profile", () => {
  const dir = makeTmpDir();
  try {
    writeTaskManifest(dir, {
      taskId: "task-noauth",
      runId: "run-noauth",
      files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
      container: { name: "forge-task-noauth" },
      auth: { profileRequested: false, stateMounted: false },
    });

    const parsed = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;
    assert.equal(parsed.auth.profileRequested, false);
    assert.equal(parsed.auth.stateMounted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
