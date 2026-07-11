// #229 review: the doctor/upgrade CLI WIRING (not just the pure report builder).
// Specifically proves project-local .forge/model-policy.yml is respected through
// the gather path that `forge upgrade`'s release-check tail uses
// (gatherReleaseInputs(undefined, { projectDir: cwd })). Docker probes are
// injected; policy/auth reads run real against a temp project — no live provider
// call (probeAuth is env-presence only), no DB.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherPolicy, gatherProfileAuth, gatherReleaseInputs, newestBuildInputMtime, type DoctorProbes } from "./doctor.js";
import { buildReleaseReport, type ImageInputs } from "../../v2/release-doctor.js";

// proj-default is the reachable default; proj-optin is defined but only
// selectable via --profile (not in defaults/overrides).
const PROJECT_POLICY = `
on_unavailable: fail
model_profiles:
  proj-default:
    provider: groq
    runtime: pi-apikey
    auth: api
    map:
      default: { model: m, cost_tier: cheap }
  proj-optin:
    provider: anthropic
    auth: api
    map:
      default: { model: m2, cost_tier: standard }
defaults:
  profile: proj-default
  activity: {}
allowed_profiles: [proj-default, proj-optin]
`;

let projectDir: string;
let envSnap: Record<string, string | undefined>;
const ENV_KEYS = ["GROQ_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE"];

function writeProjectPolicy(body = PROJECT_POLICY): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), body);
}

const fakeImage = (over: Partial<ImageInputs> = {}): DoctorProbes => ({
  inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, createdMs: 5000, buildInputMtimeMs: 1000, ...over }),
  probeClisInImage: () => ({}), // no runtimes in the temp FORGE_HOME → empty
});

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-doctor-proj-"));
  envSnap = {};
  for (const k of ENV_KEYS) { envSnap[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (envSnap[k] === undefined) delete process.env[k];
    else process.env[k] = envSnap[k];
  }
});

test("#229 gatherPolicy: project-local .forge/model-policy.yml is detected as present+valid", () => {
  writeProjectPolicy();
  assert.deepEqual(gatherPolicy({ projectDir }), { present: true, valid: true });
});

test("#229 gatherPolicy: a present-but-invalid project policy → present, NOT valid, with the error", () => {
  writeProjectPolicy("model_profiles: {}\n"); // schema requires >=1 profile
  const p = gatherPolicy({ projectDir });
  assert.equal(p.present, true);
  assert.equal(p.valid, false);
  assert.ok((p.error ?? "").length > 0);
});

test("#229 gatherPolicy: no project policy and no workspace policy → absent (legacy)", () => {
  // FORGE_HOME is the fresh temp dir from test-setup (no model-policy.yml there).
  assert.deepEqual(gatherPolicy({ projectDir }), { present: false, valid: false });
});

test("#229 gatherProfileAuth: reads the PROJECT policy's profiles + marks reachability", () => {
  writeProjectPolicy();
  const rows = gatherProfileAuth({ projectDir });
  const byName = Object.fromEntries(rows.map((r) => [r.profile, r]));
  assert.deepEqual(Object.keys(byName).sort(), ["proj-default", "proj-optin"]);
  assert.equal(byName["proj-default"]!.reachable, true, "defaults.profile is reachable");
  assert.equal(byName["proj-optin"]!.reachable, false, "defined-but-not-defaulted is opt-in");
});

test("#229 upgrade-tail path: a project profile with a missing cred fails the release check (reachable)", () => {
  writeProjectPolicy();
  // GROQ_API_KEY unset (beforeEach) → proj-default (reachable) is unavailable.
  const inputs = gatherReleaseInputs("agent-dev-worker:latest", { projectDir }, fakeImage());
  const report = buildReleaseReport(inputs);
  const groq = report.checks.find((c) => c.name.includes("proj-default"))!;
  assert.equal(groq.status, "fail", "a reachable project profile without its key blocks");
  assert.equal(report.ok, false);
  // proj-optin (opt-in, ANTHROPIC_API_KEY also unset) only warns, never blocks.
  assert.equal(report.checks.find((c) => c.name.includes("proj-optin"))!.status, "warn");
});

test("#229 upgrade-tail path: project profile cred present → that check passes (green via CLI wiring)", () => {
  writeProjectPolicy();
  process.env.GROQ_API_KEY = "gsk-test";       // proj-default now available
  process.env.ANTHROPIC_API_KEY = "sk-test";   // proj-optin now available too
  const inputs = gatherReleaseInputs("agent-dev-worker:latest", { projectDir }, fakeImage());
  const report = buildReleaseReport(inputs);
  assert.equal(report.checks.find((c) => c.name.includes("proj-default"))!.status, "ok");
  assert.equal(report.checks.find((c) => c.name.includes("proj-optin"))!.status, "ok");
  // the injected image is present + fresh → image check ok.
  assert.equal(report.checks.find((c) => c.name.includes("image"))!.status, "ok");
});

// Minimal valid runtime YAML (all RuntimeSchema required fields).
const MINIMAL_PI_RUNTIME = `
name: pi-apikey
description: test pi runtime
image: agent-dev-worker:latest
models:
  default: some-model
auth:
  mode: apikey
mounts: []
invocation:
  command: pi
  args: []
container:
  name: forge-test
  remove_on_exit: true
  idle_timeout_seconds: 300
result:
  file: /task/result.json
`;

test("#229 project-local runtime CLI is probed: policy profile.runtime drives the in-image check", () => {
  writeProjectPolicy();
  mkdirSync(join(projectDir, ".forge", "runtimes"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "runtimes", "pi-apikey.yml"), MINIMAL_PI_RUNTIME);

  const probedCommands: string[] = [];
  const inputs = gatherReleaseInputs("agent-dev-worker:latest", { projectDir }, {
    inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, createdMs: 5000, buildInputMtimeMs: 1000 }),
    probeClisInImage: (_image, commands) => { probedCommands.push(...commands); return {}; },
  });

  assert.ok(probedCommands.includes("pi"), "project-local pi runtime command must be probed in-image");
  const piCli = inputs.clis.find((c) => c.command === "pi");
  assert.ok(piCli !== undefined, "pi CLI entry must appear in clis");
  assert.ok(piCli!.neededBy.includes("pi-apikey"), "pi-apikey must appear in neededBy for pi");
});

test("#229 gatherReleaseInputs: injected docker probe controls the image check (no real docker)", () => {
  writeProjectPolicy();
  process.env.GROQ_API_KEY = "gsk-test";
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const missing = gatherReleaseInputs("agent-dev-worker:latest", { projectDir }, {
    inspectImage: () => ({ name: "agent-dev-worker:latest", present: false }),
    probeClisInImage: () => ({}),
  });
  const report = buildReleaseReport(missing);
  assert.equal(report.checks.find((c) => c.name.includes("image"))!.status, "fail");
  assert.equal(report.ok, false);
});

test("#229 gatherReleaseInputs: ctx.forgeRepoDir is forwarded to the build-input mtime check", () => {
  // Use the buildInputMtime sub-probe to verify the repo dir is forwarded correctly
  // (avoids real docker + real filesystem — both can vary across environments).
  let capturedDir: string | undefined;
  gatherReleaseInputs("nonexistent-image-for-test-xyz", { projectDir, forgeRepoDir: "/custom/forge-repo" }, {
    probeClisInImage: () => ({}),
    buildInputMtime: (dir) => { capturedDir = dir; return 9999; },
  });
  assert.equal(capturedDir, "/custom/forge-repo");
});

// FG-520: the wrapper the image bakes in (forge-test.sh) is COPYed by the Dockerfile.
// Staleness measured off the Dockerfile alone would call an image with the OLD
// wrapper "current", so the rebuild acceptance couldn't be enforced.
function writeBuildContext(repoDir: string, files: Record<string, number>): void {
  const dockerDir = join(repoDir, "docker");
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(join(dockerDir, "agent-dev-worker.Dockerfile"), [
    "FROM node:22",
    "COPY corp-root.pem /usr/local/share/ca-certificates/corp-root.crt",
    "COPY forge-test.sh /usr/local/bin/forge-test",
    "COPY agent-entrypoint.sh /usr/local/bin/agent-entrypoint",
  ].join("\n"));
  for (const [name, mtimeMs] of Object.entries(files)) {
    const p = join(dockerDir, name);
    writeFileSync(p, "#!/bin/sh\n");
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  }
}

test("FG-520 newestBuildInputMtime: a COPYed script newer than the Dockerfile drives staleness", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-repo-"));
  try {
    const dockerfileMs = Date.now() - 100_000;
    writeBuildContext(repoDir, { "forge-test.sh": dockerfileMs + 50_000, "agent-entrypoint.sh": dockerfileMs - 10_000 });
    utimesSync(join(repoDir, "docker", "agent-dev-worker.Dockerfile"), dockerfileMs / 1000, dockerfileMs / 1000);

    const newest = newestBuildInputMtime(repoDir);
    assert.ok(newest !== undefined);
    assert.ok(newest > dockerfileMs, "forge-test.sh's mtime must win over the older Dockerfile");

    // an image built between the two → STALE, which the Dockerfile-only check missed
    const inputs = gatherReleaseInputs("agent-dev-worker:latest", { projectDir }, {
      inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, createdMs: dockerfileMs + 10_000, buildInputMtimeMs: newest }),
      probeClisInImage: () => ({}),
    });
    const check = buildReleaseReport(inputs).checks.find((c) => c.name.includes("image"))!;
    assert.equal(check.status, "warn");
    assert.match(check.detail, /STALE/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("FG-520 newestBuildInputMtime: a COPY source that doesn't exist is skipped, not fatal", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-repo-"));
  try {
    // corp-root.pem is generated at build time and absent from the repo
    writeBuildContext(repoDir, { "forge-test.sh": Date.now() - 5_000, "agent-entrypoint.sh": Date.now() - 5_000 });
    assert.ok(newestBuildInputMtime(repoDir) !== undefined);
    assert.equal(newestBuildInputMtime(join(repoDir, "no-such-repo")), undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
