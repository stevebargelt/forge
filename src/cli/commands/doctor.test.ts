// #229 review: the doctor/upgrade CLI WIRING (not just the pure report builder).
// Specifically proves project-local .forge/model-policy.yml is respected through
// the gather path that `forge upgrade`'s release-check tail uses
// (gatherReleaseInputs(undefined, { projectDir: cwd })). Docker probes are
// injected; policy/auth reads run real against a temp project — no live provider
// call (probeAuth is env-presence only), no DB.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherPolicy, gatherProfileAuth, gatherReleaseInputs, newestBuildInputMtime, type DoctorProbes } from "./doctor.js";
import { buildReleaseReport, type ImageInputs } from "../../v2/release-doctor.js";
import { assetRoot } from "../../v2/asset-root.js";
import { detectProtocolDrift, renderProtocolDrift, detectSeedDrift, renderSeedDrift } from "../../v2/seed-drift.js";
import { protocolRelPath } from "../../v2/agent-protocol.js";
import { publishTestGeneration } from "../../v2/seed-generation.testkit.js";

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

// ─────────── FG-577 (criterion 9): the image probe judges against the EXECUTING tree ───────────
//
// doctor.ts:31-32 was the third independent re-derivation of
// `$FORGE_REPO_DIR ?? ~/code/forge`. Under a release that made the staleness
// probe compare the running image against the DEV checkout's Dockerfile mtime —
// false drift or false-clean on any host whose dev tree diverges. docker/ is a
// REQUIRED release asset dir (release.ts:195), so the release carries the
// Dockerfile the image should be judged against. The probe is a READ and follows
// the release; the rebuild ACTION refuses (upgrade.ts).

test("FG-577: the build-input probe defaults to the executing asset root, not FORGE_REPO_DIR", () => {
  const hostile = mkdtempSync(join(tmpdir(), "fg577-doctor-hostile-"));
  const before = process.env.FORGE_REPO_DIR;
  process.env.FORGE_REPO_DIR = hostile;
  try {
    let probed: string | undefined;
    gatherReleaseInputs("nonexistent-image-for-fg577", { projectDir }, {
      probeClisInImage: () => ({}),
      buildInputMtime: (dir) => { probed = dir; return 42; },
    });
    assert.equal(probed, assetRoot());
    assert.ok(!probed!.startsWith(hostile), "the ambient env must not choose which Dockerfile the image is judged against");
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(hostile, { recursive: true, force: true });
  }
});

// FG-577: pointing the probe at the release fixed WHICH Dockerfile is judged, but
// under a release the judgement itself is a category error. release.ts materializes
// the tree with cpSync, which does not preserve timestamps — so this drives the
// REAL cpSync, not a hand-stamped mtime, and pins that a release host cannot be
// told its image is stale by bytes it just copied.
test("FG-577: a cpSync-materialized release reports no STALE — the mechanism, driven for real", () => {
  const source = mkdtempSync(join(tmpdir(), "fg577-src-"));
  const release = mkdtempSync(join(tmpdir(), "fg577-rel-mtime-"));
  try {
    // A dev checkout whose build inputs were last edited long ago…
    const edited = Date.now() - 10 * 60_000;
    writeBuildContext(source, { "forge-test.sh": edited, "agent-entrypoint.sh": edited });
    utimesSync(join(source, "docker", "agent-dev-worker.Dockerfile"), edited / 1000, edited / 1000);

    // …materialized into a release exactly as release.ts does it.
    cpSync(join(source, "docker"), join(release, "docker"), { recursive: true });

    // The image was built AFTER every real edit — genuinely current. It is only
    // "stale" against the copy's own timestamps.
    const createdMs = Date.now() - 5 * 60_000;
    const copiedMtime = newestBuildInputMtime(release);
    assert.ok(copiedMtime !== undefined && copiedMtime > createdMs, "the fixture must reproduce the trap: cpSync restamps the inputs newer than the image");

    const probes: DoctorProbes = {
      inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, createdMs, buildInputMtimeMs: newestBuildInputMtime(release) }),
      probeClisInImage: () => ({}),
    };

    const asRelease = buildReleaseReport(gatherReleaseInputs("agent-dev-worker:latest", { projectDir, forgeRepoDir: release }, probes, "release"));
    const relCheck = asRelease.checks.find((c) => c.name.includes("image"))!;
    assert.equal(relCheck.status, "ok", "a permanently-STALE release host is the dead end this fixes");
    assert.doesNotMatch(relCheck.detail, /STALE/);
    // The dead end was STALE advising a command that refuses here — neither half survives.
    assert.ok(!(relCheck.next ?? "").includes("forge upgrade --rebuild-image"));

    // Same bytes, same probe, dev mode: still STALE. The suppression is scoped to
    // the mode where the timestamps are meaningless, not switched off.
    const asDev = buildReleaseReport(gatherReleaseInputs("agent-dev-worker:latest", { projectDir, forgeRepoDir: release }, probes, "dev"));
    assert.equal(asDev.checks.find((c) => c.name.includes("image"))!.status, "warn");
  } finally {
    for (const d of [source, release]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577: an explicit ctx.forgeRepoDir still overrides the probe root (upgrade's tail passes its asset root)", () => {
  let probed: string | undefined;
  gatherReleaseInputs("nonexistent-image-for-fg577", { projectDir, forgeRepoDir: "/some/release" }, {
    probeClisInImage: () => ({}),
    buildInputMtime: (dir) => { probed = dir; return 42; },
  });
  assert.equal(probed, "/some/release");
});

// ─────────────────────────────────────────────────────────────────────────────
// FG-654: the Forge-owned protocol is DISPATCH-COUPLED, so a covered role whose
// protocol does not resolve out of the published generation — or whose installed
// seed still carries an embedded legacy copy — is a readiness FAIL, while the
// operator's own prose in ~/.forge/agents stays a warn.
//
// This is a visible change to a published exit-code contract: a host that has not
// upgraded goes from green to red. That is the point — such a host cannot review.
// ─────────────────────────────────────────────────────────────────────────────

test("FG-654: a freshly published generation is ready and prints nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-doctor-ok-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  const clean = detectProtocolDrift({ generation: gen, forgeHome: home });
  assert.equal(clean.ok, true, "a freshly published host is ready");
  assert.equal(clean.entries.length, 9, "one entry per covered role");
  assert.equal(renderProtocolDrift(clean), "", "and prints nothing");
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: a protocol missing from the generation makes doctor's readiness FAIL", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-doctor-"));
  const gen = publishTestGeneration(home, { assetsParent: home, agentProtocols: false });
  const stale = detectProtocolDrift({ generation: gen, forgeHome: home });
  assert.equal(stale.ok, false, "an unresolvable protocol is NOT ready — doctor exits non-zero");
  assert.equal(stale.stale.length, 9, "every covered role is named, not just the first");
  const rendered = renderProtocolDrift(stale);
  assert.match(rendered, /\[FAIL\]/);
  assert.match(rendered, /red-wide/);
  assert.match(rendered, /forge upgrade/);
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: protocol bytes tampered inside the generation make readiness FAIL, by role", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-doctor-tamper-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  const path = join(gen.root, protocolRelPath("red-wide"));
  writeFileSync(path, `${readFileSync(path, "utf8")}\n\nMUTATED\n`);
  const stale = detectProtocolDrift({ generation: gen, forgeHome: home });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale.length, 1);
  assert.equal(stale.stale[0]?.role, "red-wide");
  assert.match(renderProtocolDrift(stale), /\[FAIL\]\s+red-wide/);
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: an installed seed carrying an EMBEDDED legacy protocol is a readiness FAIL", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-doctor-legacy-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  const agentDir = join(home, "agents", "red-wide");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "CLAUDE.md"),
    "# red-wide\n\n<!-- forge:agent-protocol-start -->\n\n## Ancient\n\nold\n\n<!-- forge:agent-protocol-end -->\n",
  );
  const report = detectProtocolDrift({ generation: gen, forgeHome: home });
  assert.equal(report.ok, false, "a leftover embedded protocol is a host that cannot dispatch red-wide");
  assert.equal(report.stale.length, 1);
  assert.equal(report.stale[0]?.role, "red-wide");
  assert.match(renderProtocolDrift(report), /\[FAIL\]\s+red-wide/);
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: OPERATOR-side prose in ~/.forge/agents stays a warn — readiness is unaffected", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-doctor-warn-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  const seeds = join(assetRoot(), "seeds");
  // A customized operator seed, carrying no embedded protocol.
  cpSync(join(seeds, "agents"), join(home, "agents"), { recursive: true });
  const path = join(home, "agents", "red-wide", "CLAUDE.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n\n## My house rule\n\nAlways read the ledger first.\n`);

  const protocol = detectProtocolDrift({ generation: gen, forgeHome: home });
  assert.equal(protocol.ok, true, "the operator's own edit must NOT make the host unready");
  assert.equal(renderProtocolDrift(protocol), "");

  // The FG-335 detector still reports it — as a warn, exactly as before.
  const seedDrift = detectSeedDrift(seeds, home, join(home, "skills"));
  const entry = seedDrift.entries.find((e) => e.path === join("agents", "red-wide", "CLAUDE.md"));
  assert.equal(entry?.status, "drifted");
  assert.equal(entry?.coupling, "prose", "the file as a whole is still prose-coupled → warn");
  assert.match(renderSeedDrift(seedDrift), /\[warn\]\s+drifted\s+agents\/red-wide/);
  rmSync(home, { recursive: true, force: true });
});
