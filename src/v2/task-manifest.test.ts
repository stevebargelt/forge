import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTaskManifest, manifestControlPlaneBlock, type TaskManifest, type ControlPlaneReceiptInputs } from "./task-manifest.js";

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

// ─── FG-350: ControlPlaneReceipt and manifestControlPlaneBlock ───────────────

function makeFullReceiptInputs(): ControlPlaneReceiptInputs {
  return {
    workflow: { name: "my-workflow", source: "project", path: "/proj/.forge/workflows/my-workflow.yml" },
    runtime: { name: "claude", source: "host", path: "/home/.forge/runtimes/claude.yml" },
    modelPolicy: { source: "project", path: "/proj/.forge/model-policy.yml" },
    routing: {
      routeKey: "feature-work",
      source: "host",
      policyPath: "/home/.forge/routing-policy.yml",
      responsible: "backend-team",
      pathType: "agent",
      requiredFollowups: ["qa", "review"],
    },
    docsSurfaces: { source: "project", path: "/proj/.forge/docs-surfaces.yml" },
    constraints: { dir: "/home/.forge/constraints", suggestCount: 3, forceCount: 1 },
    projectDir: "/proj",
    mountMode: "rw",
  };
}

test("manifestControlPlaneBlock: returns correct shape with all routing fields present", () => {
  const receipt = manifestControlPlaneBlock(makeFullReceiptInputs());

  assert.equal(receipt.workflow.name, "my-workflow");
  assert.equal(receipt.workflow.source, "project");
  assert.equal(receipt.workflow.path, "/proj/.forge/workflows/my-workflow.yml");

  assert.equal(receipt.runtime.name, "claude");
  assert.equal(receipt.runtime.source, "host");
  assert.equal(receipt.runtime.path, "/home/.forge/runtimes/claude.yml");

  assert.equal(receipt.modelPolicy.source, "project");
  assert.equal(receipt.modelPolicy.path, "/proj/.forge/model-policy.yml");

  assert.ok(receipt.routing !== undefined, "routing must be present");
  assert.equal(receipt.routing!.routeKey, "feature-work");
  assert.equal(receipt.routing!.responsible, "backend-team");
  assert.equal(receipt.routing!.pathType, "agent");
  assert.deepEqual(receipt.routing!.requiredFollowups, ["qa", "review"]);
  assert.equal(receipt.routing!.source, "host");
  assert.equal(receipt.routing!.policyPath, "/home/.forge/routing-policy.yml");

  assert.equal(receipt.docsSurfaces.source, "project");
  assert.equal(receipt.constraints.suggestCount, 3);
  assert.equal(receipt.constraints.forceCount, 1);
  assert.equal(receipt.projectDir, "/proj");
  assert.equal(receipt.warnings, undefined, "no warnings when none provided");
});

test("manifestControlPlaneBlock: routing field is omitted when no routing input provided", () => {
  const inputs: ControlPlaneReceiptInputs = { ...makeFullReceiptInputs(), routing: undefined };
  const receipt = manifestControlPlaneBlock(inputs);
  assert.equal(receipt.routing, undefined, "routing must be absent when not provided");
  assert.equal(receipt.workflow.name, "my-workflow");
  assert.equal(receipt.constraints.forceCount, 1);
});

test("manifestControlPlaneBlock: synthetic workflow source has no path", () => {
  const inputs: ControlPlaneReceiptInputs = {
    ...makeFullReceiptInputs(),
    workflow: { name: "invoke", source: "synthetic" },
    routing: undefined,
  };
  const receipt = manifestControlPlaneBlock(inputs);
  assert.equal(receipt.workflow.source, "synthetic");
  assert.equal(receipt.workflow.path, undefined, "synthetic workflow has no path");
});

test("manifestControlPlaneBlock: modelPolicy absent source recorded without path", () => {
  const inputs: ControlPlaneReceiptInputs = {
    ...makeFullReceiptInputs(),
    modelPolicy: { source: "absent" },
    routing: undefined,
  };
  const receipt = manifestControlPlaneBlock(inputs);
  assert.equal(receipt.modelPolicy.source, "absent");
  assert.equal(receipt.modelPolicy.path, undefined);
});

test("manifestControlPlaneBlock: warnings captured when present", () => {
  const inputs: ControlPlaneReceiptInputs = {
    ...makeFullReceiptInputs(),
    warnings: ["routing lookup failed: policy not found"],
  };
  const receipt = manifestControlPlaneBlock(inputs);
  assert.deepEqual(receipt.warnings, ["routing lookup failed: policy not found"]);
});

test("manifestControlPlaneBlock: empty warnings array is omitted from receipt", () => {
  const inputs: ControlPlaneReceiptInputs = { ...makeFullReceiptInputs(), warnings: [] };
  const receipt = manifestControlPlaneBlock(inputs);
  assert.equal(receipt.warnings, undefined, "empty warnings array must be omitted");
});

test("writeTaskManifest: manifest.json without controlPlane is parseable and controlPlane === undefined (legacy compat)", () => {
  const dir = makeTmpDir();
  try {
    writeTaskManifest(dir, {
      taskId: "task-legacy",
      runId: "run-legacy",
      files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
      container: { name: "forge-task-legacy" },
      auth: { profileRequested: false, stateMounted: false },
      // intentionally no controlPlane — simulates pre-FG-350 manifest
    });

    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as TaskManifest;
    assert.equal(parsed.controlPlane, undefined, "legacy manifests without controlPlane must remain readable");
    assert.equal(parsed.taskId, "task-legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTaskManifest: manifest with controlPlane round-trips correctly", () => {
  const dir = makeTmpDir();
  try {
    const cp = manifestControlPlaneBlock(makeFullReceiptInputs());
    writeTaskManifest(dir, {
      taskId: "task-cp",
      runId: "run-cp",
      files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
      container: { name: "forge-task-cp" },
      auth: { profileRequested: false, stateMounted: false },
      controlPlane: cp,
    });

    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as TaskManifest;
    assert.ok(parsed.controlPlane !== undefined, "controlPlane must be present after round-trip");
    assert.equal(parsed.controlPlane!.workflow.name, "my-workflow");
    assert.equal(parsed.controlPlane!.routing?.responsible, "backend-team");
    assert.equal(parsed.controlPlane!.projectDir, "/proj");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
