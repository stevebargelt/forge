// #229 review: the doctor/upgrade CLI WIRING (not just the pure report builder).
// Specifically proves project-local .forge/model-policy.yml is respected through
// the gather path that `forge upgrade`'s release-check tail uses
// (gatherReleaseInputs(undefined, { projectDir: cwd })). Docker probes are
// injected; policy/auth reads run real against a temp project — no live provider
// call (probeAuth is env-presence only), no DB.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherPolicy, gatherProfileAuth, gatherReleaseInputs, type DoctorProbes } from "./doctor.js";
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
  inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, createdMs: 5000, dockerfileMtimeMs: 1000, ...over }),
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
