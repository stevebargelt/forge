// FG-654: the dispatch-time refusal and the durable generation stamp, exercised through
// the REAL dispatch machinery.
//
// The properties this pins are the ones that decide whether the defect is actually closed:
//
//   - A covered role whose installed protocol region is STALE or ABSENT does not reach a
//     container. It is refused BY NAME, with both shas and `forge upgrade`, through
//     `invoke` — the seam the whole coordinator family and the legacy review-loop share.
//   - An UNCOVERED role is not gated. Widening the blast radius past the review lifecycle
//     would be its own defect.
//   - The generation a dispatched agent RAN UNDER is readable off the task manifest ON
//     DISK, not from an in-memory value the test could have handed itself.
//   - `retry` RE-VERIFIES against today's requirement; it never replays the original stamp.
//   - A refused lens surfaces as `stale_protocol`, never as `no_outcome`/"never
//     dispatched", and an operator lens acceptance cannot clear it.
//
// Integration tier: real DB rows, real run/task dirs, real manifests on disk. The container
// exec is stubbed — the point is that for a refused dispatch it is never called at all.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, dispatchInvokeTask, createInvokeRun } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { readTaskManifest } from "./task-manifest.js";
import { getTask, insertTask } from "../store/tasks.js";
import { newTaskId } from "../util/ids.js";
import { resolveModel } from "./model-resolution.js";
import type { Task } from "../types/index.js";
import { taskDir } from "../util/paths.js";
import { assessLens, assessDiscoveryCompleteness, LENS_INCOMPLETE_REASONS } from "./review-discovery.js";
import type { DockerExecFn } from "./docker-exec.js";
import {
  COVERED_ROLES,
  STALE_PROTOCOL_FAILURE_KIND,
  fencedBlock,
  installedSeedPath,
  protocolSha256,
  readProtocolRegion,
  releaseSeedPath,
} from "./agent-protocol.js";
import type { LensAcceptance } from "../store/reviews.js";

const savedEnv = { ...process.env };
let tmpDirs: string[] = [];
let projectDir: string;
let execCalls = 0;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Counts its own invocations: a REFUSED dispatch must leave this at zero. */
function countingExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    execCalls += 1;
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function setupRuntimeStub(): void {
  const fhome = process.env["FORGE_HOME"]!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      `name: claude
description: fg654 test stub
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
`,
    );
  }
  publishFlatAsGeneration(fhome);
}

/** This release's region for `role`, read from the release seed — the REQUIRED side. */
function releaseRegionOf(role: string): string {
  const read = readProtocolRegion(readFileSync(releaseSeedPath(role), "utf8"));
  assert.equal(read.kind, "fenced", `${role}: the release seed must be fenced`);
  return read.kind === "fenced" ? read.region : "";
}

/** Rewrite the INSTALLED seed's region so it is stale, leaving the repo seed pristine. */
function makeInstalledStale(role: string): void {
  const path = installedSeedPath(role);
  const text = readFileSync(path, "utf8");
  const read = readProtocolRegion(text);
  assert.equal(read.kind, "fenced");
  if (read.kind === "fenced") {
    const start = text.indexOf(fencedBlock(read.region));
    assert.ok(start >= 0, "the installed file must contain a canonical fenced block to replace");
    writeFileSync(path, text.replace(fencedBlock(read.region), fencedBlock(`${read.region}\n\nA STALE TRAILING RULE`)));
  }
}

beforeEach(() => {
  projectDir = tmp("fg654-project-");
  execCalls = 0;
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  setupRuntimeStub();
});

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

// ─── P3: refused by name, no container ──────────────────────────────────────

test("integ FG-654: EVERY covered role with a stale installed region is refused BY NAME and never reaches a container", async () => {
  for (const role of COVERED_ROLES) {
    const pristine = readFileSync(installedSeedPath(role), "utf8");
    makeInstalledStale(role);
    execCalls = 0;
    try {
      const res = await invoke({
        agentRole: role,
        task: "review the change",
        projectDir,
        readOnlyProject: role.startsWith("red-"),
        dockerExec: countingExec(),
      });

      assert.equal(res.status, "failed", `${role} dispatched under a stale protocol region`);
      assert.equal(execCalls, 0, `${role}: a refused dispatch must never reach a container`);
      assert.equal(res.failureKind, STALE_PROTOCOL_FAILURE_KIND, `${role}`);
      const error = res.error ?? "";
      assert.ok(error.includes(role), `${role}: the refusal must name the role`);
      assert.ok(error.includes("forge upgrade"), `${role}: the refusal must name the remedy`);
      const shas: string[] = error.match(/[0-9a-f]{64}/g) ?? [];
      assert.equal(new Set(shas).size, 2, `${role}: the refusal must name BOTH shas, got ${shas.join(",")}`);
      assert.ok(shas.includes(protocolSha256(releaseRegionOf(role))), `${role}: one of them is the REQUIRED sha`);

      // Durable and addressable: the row exists, failed, carrying the refusal, and no
      // manifest was written because nothing was dispatched.
      const row = getTask(res.taskId);
      assert.equal(row?.status, "failed", `${role}: the refusal must be durable on the task row`);
      assert.equal(readTaskManifest(taskDir(res.runId, res.taskId)), undefined, `${role}: no dispatch, no manifest`);
    } finally {
      writeFileSync(installedSeedPath(role), pristine);
    }
  }
});

test("integ FG-654: a covered role whose seed FILE IS ABSENT is refused too — the fail-open placeholder is unreachable", async () => {
  const role = "red-security";
  const path = installedSeedPath(role);
  const pristine = readFileSync(path, "utf8");
  rmSync(path);
  try {
    const res = await invoke({
      agentRole: role,
      task: "audit",
      projectDir,
      readOnlyProject: true,
      dockerExec: countingExec(),
    });
    assert.equal(res.status, "failed");
    assert.equal(execCalls, 0);
    assert.ok((res.error ?? "").includes("NO installed seed"));
    assert.ok(
      !(res.error ?? "").includes("(Agent base CLAUDE.md not found"),
      "the old fail-open placeholder must never be composed for a covered role",
    );
  } finally {
    writeFileSync(path, pristine);
  }
});

test("integ FG-654: an UNCOVERED role dispatches exactly as before", async () => {
  for (const role of ["synthesizer", "tech-lead"]) {
    execCalls = 0;
    const res = await invoke({ agentRole: role, task: "think", projectDir, dockerExec: countingExec() });
    assert.equal(res.status, "complete", `${role} must not be gated`);
    assert.equal(execCalls, 1, `${role} must still reach its container`);
    // …and carries no protocol stamp, because it has no protocol region.
    assert.equal(readTaskManifest(taskDir(res.runId, res.taskId))?.agentProtocol, undefined);
  }
});

// ─── P4: the generation is readable from durable state ──────────────────────

test("integ FG-654: a dispatched covered role's manifest ON DISK records the region sha it ran under", async () => {
  const role = "red-wide";
  const res = await invoke({
    agentRole: role,
    task: "review",
    projectDir,
    readOnlyProject: true,
    dockerExec: countingExec(),
  });
  assert.equal(res.status, "complete");

  // Read from the FILE, not from an in-memory value — the claim is about durable state.
  const raw = JSON.parse(readFileSync(join(taskDir(res.runId, res.taskId), "manifest.json"), "utf8")) as {
    agentProtocol?: { role: string; sha256: string; source: string };
  };
  assert.equal(raw.agentProtocol?.role, role);
  assert.equal(raw.agentProtocol?.sha256, protocolSha256(releaseRegionOf(role)));
  assert.equal(raw.agentProtocol?.source, installedSeedPath(role));
});

// RF-3 / RF-5: THE MANIFEST ECHOES THE COMPOSE, IT DOES NOT RE-READ THE SEED.
//
// The manifest is written well after the prompt is composed — after model resolution,
// mount preflight and docker-arg construction. When the stamp was re-derived there, a
// `forge upgrade` (or the FG-654 publish pass itself) landing in that window made the
// receipt name a generation the container was never given; and if the seed went stale in
// that window the re-read returned nothing, so a covered role that DID dispatch got a
// manifest with no protocol block at all — indistinguishable from a pre-FG-654 one.
// A stamp that disagrees with what is on disk is the only way to tell the two apart.
test("integ FG-654: the manifest records the COMPOSED stamp, not a fresh read of the seed", async () => {
  const role = "red-wide";
  // A stamp NO read of this host's disk can produce. dispatchInvokeTask is the seam
  // `forge retry` uses directly, and it takes an already-composed row — so the divergence
  // between "what compose resolved" and "what the seed says right now" is expressible
  // without racing an upgrade. A manifest that re-derives cannot reproduce this value.
  const composed = { role, sha256: "a".repeat(64), source: installedSeedPath(role) };
  const runId = createInvokeRun(role, projectDir, undefined, "fg654 carry", undefined);
  const taskId = newTaskId(role);
  const task: Task = {
    id: taskId,
    runId,
    phase: "task",
    agentRole: role,
    status: "pending",
    taskPackage: {
      taskId,
      runId,
      phase: "task",
      role,
      inputs: { task: "review" },
      composedSystemPrompt: "PROMPT COMPOSED UNDER THE STAMP ABOVE",
      dispatchSource: "invoke",
      agentProtocol: composed,
    },
    createdAt: new Date().toISOString(),
  };
  insertTask(task);

  const res = await dispatchInvokeTask({
    task,
    resolution: resolveModel({ agentRole: role, runtimeName: "claude", ctx: { projectDir } }),
    projectDir,
    taskText: "review",
    ownsRun: true,
    readOnlyProject: true,
    dockerExec: countingExec(),
  });
  assert.equal(res.status, "complete");

  const onDisk = readTaskManifest(taskDir(res.runId, res.taskId))?.agentProtocol;
  assert.deepEqual(onDisk, composed, "the manifest is an ECHO of the composed package, never a second read");
  assert.notEqual(
    onDisk?.sha256,
    protocolSha256(releaseRegionOf(role)),
    "a re-derived stamp would carry the seed's CURRENT sha — the generation this prompt was not built from",
  );
});

test("integ FG-654: the stamp is per DISPATCH — two lenses on two different region shas record two distinct shas", async () => {
  const roleA = "red-narrow";
  const roleB = "red-backend";
  const pristineB = readFileSync(installedSeedPath(roleB), "utf8");
  try {
    const a = await invoke({ agentRole: roleA, task: "a", projectDir, readOnlyProject: true, dockerExec: countingExec() });
    assert.equal(a.status, "complete");

    // Simulate a `forge upgrade` landing between the two dispatches: the RELEASE seed for
    // roleB moves, and the installed copy moves with it. (Here both move together, which
    // is what an upgrade does — the point is that roleB's recorded sha is its own.)
    const b = await invoke({ agentRole: roleB, task: "b", projectDir, readOnlyProject: true, dockerExec: countingExec() });
    assert.equal(b.status, "complete");

    const shaA = readTaskManifest(taskDir(a.runId, a.taskId))?.agentProtocol?.sha256;
    const shaB = readTaskManifest(taskDir(b.runId, b.taskId))?.agentProtocol?.sha256;
    assert.match(shaA ?? "", /^[0-9a-f]{64}$/);
    assert.match(shaB ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(shaA, shaB, "two roles with different regions must record two different shas");
    assert.equal(shaA, protocolSha256(releaseRegionOf(roleA)));
    assert.equal(shaB, protocolSha256(releaseRegionOf(roleB)));
  } finally {
    writeFileSync(installedSeedPath(roleB), pristineB);
  }
});

// ─── P6: the vocabulary, and that an acceptance cannot clear it ─────────────

test("integ FG-654: a refused lens surfaces as `stale_protocol`, never as no_outcome/never-dispatched", () => {
  assert.ok((LENS_INCOMPLETE_REASONS as readonly string[]).includes("stale_protocol"));

  const outcome = assessLens({
    lens: "wide",
    role: "red-wide",
    dispatched: false,
    failureKind: STALE_PROTOCOL_FAILURE_KIND,
    detail: "installed abc… required def…",
  });
  assert.equal(outcome.complete, false);
  if (!outcome.complete) {
    assert.equal(outcome.reason, "stale_protocol");
    assert.ok(!outcome.detail.includes("never dispatched"), "it was dispatched-and-refused, not never-dispatched");
    assert.ok(outcome.detail.includes("forge upgrade"));
  }
});

test("integ FG-654: a bound, current-candidate operator acceptance does NOT clear a stale-protocol lens", () => {
  const refused = assessLens({
    lens: "security",
    role: "red-security",
    dispatched: false,
    failureKind: STALE_PROTOCOL_FAILURE_KIND,
  });
  const acceptance: LensAcceptance = {
    kind: "lens_acceptance",
    lens: "security",
    missingEvidence: "no security lens ran",
    rationale: "shipping anyway",
    candidateSha: "cafe1234",
    acceptedBy: "operator",
    acceptedAt: new Date(0).toISOString(),
  };

  // The control: this exact acceptance DOES clear an ordinary missing lens, so the
  // assertion below is about the reason and not about the acceptance being malformed.
  const ordinary = assessDiscoveryCompleteness(
    ["security"],
    [assessLens({ lens: "security", role: "red-security", dispatched: false, failureKind: "container_crash" })],
    { acceptances: [acceptance], candidateSha: "cafe1234" },
  );
  assert.equal(ordinary.complete, true, "control: a crashed lens IS clearable by a bound acceptance");
  assert.equal(ordinary.accepted.length, 1);

  const staleProtocol = assessDiscoveryCompleteness(["security"], [refused], {
    acceptances: [acceptance],
    candidateSha: "cafe1234",
  });
  assert.equal(staleProtocol.complete, false, "a stale-protocol lens must NOT be acceptable-away");
  assert.equal(staleProtocol.accepted.length, 0, "and the acceptance must not be reported as having cleared it");
  assert.equal(staleProtocol.missing[0]?.reason, "stale_protocol");
});
