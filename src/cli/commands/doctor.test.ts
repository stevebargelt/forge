// #229 review: the doctor/upgrade CLI WIRING (not just the pure report builder).
// Specifically proves project-local .forge/model-policy.yml is respected through
// the gather path that `forge upgrade`'s release-check tail uses
// (gatherReleaseInputs(undefined, { projectDir: cwd })). Docker probes are
// injected; policy/auth reads run real against a temp project — no live provider
// call (probeAuth is env-presence only), no DB.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  doctorJson,
  doctorReady,
  gatherDoctorFindings,
  registerDoctor,
  gatherPolicy,
  gatherProfileAuth,
  gatherReleaseInputs,
  computeCurrentBuildInputDigest,
  readRecordedDigest,
  renderDoctor,
  renderDocsSurfaces,
  type DoctorFindings,
  type DoctorProbes,
} from "./doctor.js";
import { buildReleaseReport, type ImageInputs, type ReleaseReport } from "../../v2/release-doctor.js";
import { computeBuildInputDigest } from "../../v2/build-input-digest.js";
import { Command } from "commander";
import { assetRoot } from "../../v2/asset-root.js";
import {
  currentAdapterStamp,
  detectProtocolDrift,
  renderProtocolDrift,
  detectSeedDrift,
  renderSeedDrift,
  detectProjectAdapterDrift,
  projectAdapterBaseline,
  renderProjectAdapterDrift,
} from "../../v2/seed-drift.js";
import { protocolRelPath } from "../../v2/agent-protocol.js";
import { publishTestGeneration } from "../../v2/seed-generation.testkit.js";
import { adapterStampForAssetRoot, resolveAdapterStampForAssetRoot } from "../../v2/adapter-stamp.js";

// proj-default is the reachable default; proj-optin is defined but only
// selectable via --profile (not in defaults/overrides).
const PROJECT_POLICY = `
on_unavailable: fail
schema_version: 2
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
  inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, recordedDigest: "d", currentInputDigest: "d", ...over }),
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
    inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, recordedDigest: "d", currentInputDigest: "d" }),
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

test("#229 gatherReleaseInputs: ctx.forgeRepoDir is forwarded to the build-input digest check", () => {
  // Use the buildInputDigest sub-probe to verify the repo dir is forwarded correctly
  // (avoids real docker + real filesystem — both can vary across environments).
  let capturedDir: string | undefined;
  gatherReleaseInputs("nonexistent-image-for-test-xyz", { projectDir, forgeRepoDir: "/custom/forge-repo" }, {
    probeClisInImage: () => ({}),
    buildInputDigest: (dir) => { capturedDir = dir; return "digest"; },
  });
  assert.equal(capturedDir, "/custom/forge-repo");
});

// FG-543: the image's staleness is a build-input CONTENT digest, computed by the
// ONE shared function (src/v2/build-input-digest.ts) at build time and check time.
// The Dockerfile COPYs forge-test.sh / agent-entrypoint.sh, so their CONTENT is
// part of the digest — an image with the OLD wrapper content is STALE. corp-root.pem
// is a COPY source but is EXCLUDED (staged/removed by build.sh, unreadable at check).
function writeBuildContext(repoDir: string, files: Record<string, string>): void {
  const dockerDir = join(repoDir, "docker");
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(join(dockerDir, "agent-dev-worker.Dockerfile"), [
    "FROM node:22",
    "COPY corp-root.pem /usr/local/share/ca-certificates/corp-root.crt",
    "COPY forge-test.sh /usr/local/bin/forge-test",
    "COPY agent-entrypoint.sh /usr/local/bin/agent-entrypoint",
  ].join("\n"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dockerDir, name), content);
  }
}

test("FG-543 computeBuildInputDigest: changing a COPYed file's CONTENT flips the digest (AC3)", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-repo-"));
  try {
    writeBuildContext(repoDir, { "forge-test.sh": "#!/bin/sh\necho v1\n", "agent-entrypoint.sh": "#!/bin/sh\n" });
    const dockerDir = join(repoDir, "docker");
    const before = computeBuildInputDigest(dockerDir);

    writeFileSync(join(dockerDir, "forge-test.sh"), "#!/bin/sh\necho v2\n");
    const after = computeBuildInputDigest(dockerDir);
    assert.notEqual(before, after, "changed build-input content must change the digest");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("FG-543 computeBuildInputDigest: an mtime-only touch (same bytes) does NOT change the digest (AC2)", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-repo-"));
  try {
    writeBuildContext(repoDir, { "forge-test.sh": "#!/bin/sh\necho hi\n", "agent-entrypoint.sh": "#!/bin/sh\n" });
    const dockerDir = join(repoDir, "docker");
    const before = computeBuildInputDigest(dockerDir);

    // Bump the mtime far into the future (as a git pull/checkout would) — and,
    // belt-and-suspenders, rewrite one file with identical content.
    const future = Date.now() + 10 * 60_000;
    utimesSync(join(dockerDir, "forge-test.sh"), future / 1000, future / 1000);
    writeFileSync(join(dockerDir, "agent-entrypoint.sh"), "#!/bin/sh\n");
    const after = computeBuildInputDigest(dockerDir);
    assert.equal(before, after, "a timestamp-only change must NOT change the digest — the FG-543 false positive");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("FG-543 computeBuildInputDigest: corp-root.pem is excluded and a missing COPY source is skipped, not fatal", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-repo-"));
  try {
    // corp-root.pem (excluded) and forge-test.sh/agent-entrypoint.sh are the COPY
    // sources; none of corp-root.pem exists on disk. The digest is still computable.
    writeBuildContext(repoDir, { "forge-test.sh": "#!/bin/sh\n", "agent-entrypoint.sh": "#!/bin/sh\n" });
    const dockerDir = join(repoDir, "docker");
    const digest = computeBuildInputDigest(dockerDir);
    assert.match(digest, /^[0-9a-f]{64}$/, "a stable hex sha256 despite the excluded/missing corp-root.pem");

    // Writing corp-root.pem (the excluded source) must NOT change the digest.
    writeFileSync(join(dockerDir, "corp-root.pem"), "-----CERT-----\n");
    assert.equal(computeBuildInputDigest(dockerDir), digest, "corp-root.pem is excluded, so staging it cannot move the digest");

    // An unreadable Dockerfile (docker/ absent) makes the wrapper return undefined.
    assert.equal(computeCurrentBuildInputDigest(join(repoDir, "no-such-repo")), undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("FG-543 AC1-AC4 wiring: recorded==current → ok; differ → STALE; absent → STALE", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-repo-"));
  try {
    writeBuildContext(repoDir, { "forge-test.sh": "#!/bin/sh\necho hi\n", "agent-entrypoint.sh": "#!/bin/sh\n" });
    const current = computeCurrentBuildInputDigest(repoDir)!;
    assert.match(current, /^[0-9a-f]{64}$/);

    const imageCheckStatus = (over: Partial<ImageInputs>): string =>
      buildReleaseReport(gatherReleaseInputs("agent-dev-worker:latest", { projectDir, forgeRepoDir: repoDir }, {
        inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, currentInputDigest: current, ...over }),
        probeClisInImage: () => ({}),
      })).checks.find((c) => c.name.includes("image"))!.status;

    // AC1/AC2: a cached rebuild / mtime-only touch records the SAME digest → ok.
    assert.equal(imageCheckStatus({ recordedDigest: current }), "ok");
    // AC3: changed build-input content → recorded no longer matches → STALE.
    assert.equal(imageCheckStatus({ recordedDigest: "some-other-digest" }), "warn");
    // AC4: no digest recorded (old pre-label image) → fail toward STALE.
    assert.equal(imageCheckStatus({ recordedDigest: undefined }), "warn");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ─────────── FG-543 RF-1: a docker inspect FAILURE must not fabricate a STALE ───────────
//
// readRecordedDigest previously turned EVERY inspect failure into undefined, which
// the pure check reads as an absent label → fail toward STALE (AC4). A transient
// daemon/permission failure is INCONCLUSIVE, not an absent label: it must surface
// as an error so inspectImage routes it to dockerError (image check skips), exactly
// like the ls-unreachable path — never a false STALE on a present image.

test("FG-543 RF-1: a docker inspect FAILURE is an inconclusive error probe, not an absent label", () => {
  const boom = (): string => {
    const e = new Error("Command failed: docker image inspect") as Error & { stderr?: string };
    e.stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock";
    throw e;
  };
  const probe = readRecordedDigest("sha256:abc", boom);
  assert.equal(probe.kind, "error", "an exec failure is inconclusive, NOT an absent label");
  assert.match((probe as { message: string }).message, /Cannot connect to the Docker daemon/);
});

test("FG-543 RF-1: an inspect failure with no stderr still yields a non-empty error message", () => {
  const probe = readRecordedDigest("id", () => { throw new Error(""); });
  assert.equal(probe.kind, "error");
  assert.ok((probe as { message: string }).message.length > 0, "the message is never empty");
});

test("FG-543 RF-1: a SUCCESSFUL inspect with no label value is a genuinely absent record (→ STALE, AC4)", () => {
  assert.deepEqual(readRecordedDigest("id", () => "<no value>\n"), { kind: "absent" });
  assert.deepEqual(readRecordedDigest("id", () => "   \n"), { kind: "absent" });
});

test("FG-543 RF-1: a SUCCESSFUL inspect returning a digest yields it verbatim (trimmed)", () => {
  assert.deepEqual(readRecordedDigest("id", () => "  deadbeef\n"), { kind: "value", digest: "deadbeef" });
});

// ─────────── FG-543 RF-2: an unreadable-but-PRESENT COPY source must not fabricate a STALE ───────────
//
// A COPY source hashed into the recorded digest at build time but transiently
// UNREADABLE at check time (permission/IO) was silently omitted, shrinking the
// input set so the digests differ → false STALE. Only a source ABSENT on disk
// (ENOENT — skipped at both build and check, so they agree) may be dropped; any
// other read failure makes the current digest UNCOMPUTABLE, which fails safe to
// NOT stale via computeCurrentBuildInputDigest's undefined.

test("FG-543 RF-2: a COPY source PRESENT but unreadable is uncomputable (throws), not a partial digest", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-rf2-"));
  try {
    writeBuildContext(repoDir, { "forge-test.sh": "#!/bin/sh\n", "agent-entrypoint.sh": "#!/bin/sh\n" });
    const dockerDir = join(repoDir, "docker");
    assert.match(computeBuildInputDigest(dockerDir), /^[0-9a-f]{64}$/, "baseline: all sources readable → computable");

    // Replace a COPY source with a DIRECTORY: present on disk, but readFileSync
    // cannot read it (EISDIR) — the "present at build, unreadable at check" case.
    rmSync(join(dockerDir, "agent-entrypoint.sh"));
    mkdirSync(join(dockerDir, "agent-entrypoint.sh"));
    assert.throws(() => computeBuildInputDigest(dockerDir), /EISDIR/, "an existing-but-unreadable source is uncomputable, not skipped");
    // The doctor wrapper turns that throw into undefined → the pure check reads
    // "can't compute" as "can't prove stale", NOT a false STALE.
    assert.equal(computeCurrentBuildInputDigest(repoDir), undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("FG-543 RF-2: a COPY source ABSENT on disk (ENOENT) is still skipped deterministically", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "forge-doctor-rf2-enoent-"));
  try {
    // agent-entrypoint.sh is a COPY source but never written → ENOENT → skipped,
    // exactly as before, so build and check agree and the digest stays computable.
    writeBuildContext(repoDir, { "forge-test.sh": "#!/bin/sh\n" });
    const digest = computeBuildInputDigest(join(repoDir, "docker"));
    assert.match(digest, /^[0-9a-f]{64}$/, "a genuinely-absent COPY source is skipped, not fatal");
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
      buildInputDigest: (dir) => { probed = dir; return "digest"; },
    });
    assert.equal(probed, assetRoot());
    assert.ok(!probed!.startsWith(hostile), "the ambient env must not choose which Dockerfile the image is judged against");
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(hostile, { recursive: true, force: true });
  }
});

// FG-577 → FG-543: cpSync materializes the release tree with fresh timestamps but
// IDENTICAL bytes. The old mtime heuristic read the restamped inputs as "newer than
// the image" → permanent false STALE. The content digest reads the SAME bytes → the
// digest recorded at build time still matches, so the release is not stale — and,
// because the judgement is content-based, this holds in BOTH modes without a gate.
test("FG-543 (was FG-577): a cpSync-materialized release matches the recorded digest — no false STALE, driven for real", () => {
  const source = mkdtempSync(join(tmpdir(), "fg577-src-"));
  const release = mkdtempSync(join(tmpdir(), "fg577-rel-digest-"));
  try {
    // A dev checkout whose build inputs were last edited long ago…
    const edited = Date.now() - 10 * 60_000;
    writeBuildContext(source, { "forge-test.sh": "#!/bin/sh\necho real\n", "agent-entrypoint.sh": "#!/bin/sh\n" });
    utimesSync(join(source, "docker", "agent-dev-worker.Dockerfile"), edited / 1000, edited / 1000);

    // The digest the image would have recorded at build time, from the source tree.
    const recordedDigest = computeBuildInputDigest(join(source, "docker"))!;

    // …materialized into a release exactly as release.ts does it (fresh mtimes).
    cpSync(join(source, "docker"), join(release, "docker"), { recursive: true });
    const future = Date.now() + 5 * 60_000;
    for (const f of ["agent-dev-worker.Dockerfile", "forge-test.sh", "agent-entrypoint.sh"]) {
      utimesSync(join(release, "docker", f), future / 1000, future / 1000);
    }

    // cpSync preserved content, so the release tree's digest equals the recorded one
    // even though every mtime is now newer than the image (the old trap).
    const copiedDigest = computeCurrentBuildInputDigest(release)!;
    assert.equal(copiedDigest, recordedDigest, "cpSync preserves content, so the digest is unchanged despite fresh mtimes");

    const probes: DoctorProbes = {
      inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, recordedDigest, currentInputDigest: computeCurrentBuildInputDigest(release) }),
      probeClisInImage: () => ({}),
    };

    for (const mode of ["release", "dev"] as const) {
      const report = buildReleaseReport(gatherReleaseInputs("agent-dev-worker:latest", { projectDir, forgeRepoDir: release }, probes, mode));
      const check = report.checks.find((c) => c.name.includes("image"))!;
      assert.equal(check.status, "ok", `matching content is not stale in ${mode} — the permanently-STALE dead end this fixes`);
      assert.doesNotMatch(check.detail, /STALE/);
    }
  } finally {
    for (const d of [source, release]) rmSync(d, { recursive: true, force: true });
  }
});

test("FG-577: an explicit ctx.forgeRepoDir still overrides the probe root (upgrade's tail passes its asset root)", () => {
  let probed: string | undefined;
  gatherReleaseInputs("nonexistent-image-for-fg577", { projectDir, forgeRepoDir: "/some/release" }, {
    probeClisInImage: () => ({}),
    buildInputDigest: (dir) => { probed = dir; return "digest"; },
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

// ─────────── FG-253: the project-adapter section in `forge doctor` ───────────
//
// doctor already runs with projectDir: process.cwd(), so it can honestly report the
// adapters of the project it was invoked in and nothing else. These tests drive the
// three pure faces of the command (human section, --json payload, exit code) over a
// synthetic findings value, so no host state and no docker are involved.

const OK_REPORT: ReleaseReport = { checks: [{ name: "probe", status: "ok", detail: "fine" }], ok: true };

function findings(over: Partial<DoctorFindings> = {}): DoctorFindings {
  // FG-693: the synthetic project is UNRESOLVED, and deliberately so — /tmp/p is not
  // on disk, and a fixture that quietly claimed a proven identity for a path nobody
  // resolved would be the very confusion the contract removes.
  const projectIdentity = { kind: "unresolved" as const, asWritten: "/tmp/p", reason: "ENOENT" };
  return {
    report: OK_REPORT,
    seedDrift: { entries: [], stale: [], ok: true },
    protocolDrift: { entries: [], stale: [], ok: true },
    seedInstall: { kind: "healthy", generation: "/tmp/gen" },
    projectAdapters: { projectDir: "/tmp/p", projectIdentity, expectedStamp: "release-x", entries: [], stale: [], ok: true },
    docsSurfaces: { verdict: "missing", path: "/tmp/p/.forge/docs-surfaces.yml" },
    // FG-560: a benign default status fixture — host policy current, no projects.
    modelPolicyStatus: {
      host: { scope: "host", state: "reachable-no-policy", projectDir: "/tmp/home", policyPath: null, verdict: null, schemaVersionFound: null, action: "none", detail: "no policy file — legacy mode (runtime.models)" },
      projects: [],
      completeness: "historical-best-effort",
      registeredInspected: 0,
      registeredUnreachable: 0,
      registeredNoPath: 0,
      hostNeedsUpgrade: false,
      anyNewerUnsupported: false,
    },
    project: projectIdentity,
    ...over,
  };
}

// realpathSync because one of these tests chdir's into the fixture and compares
// the dir against what doctor read from process.cwd(). On darwin os.tmpdir() is
// /var/folders/... — a symlink to /private/var/folders/... — so the raw mkdtemp
// path does not survive a chdir round-trip and the equality assertion fails on
// the host while passing in a Linux container.
function adapterProject(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg253-doctor-proj-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("FG-253 doctor: no project-adapter section when every adapter is current", () => {
  const { dir, cleanup } = adapterProject();
  try {
    const stamp = "release-abc1234-deadbeef";
    for (const base of projectAdapterBaseline(stamp)) {
      const abs = join(dir, ...base.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, base.bytes);
    }
    const f = findings({ projectAdapters: detectProjectAdapterDrift(dir, stamp) });
    assert.ok(!renderDoctor(f).includes("Project orientation/handoff adapters"));
    assert.equal(doctorReady(f), true);
  } finally {
    cleanup();
  }
});

test("FG-253 doctor: a non-current adapter renders a section naming the inspected project", () => {
  const { dir, cleanup } = adapterProject();
  try {
    const f = findings({ projectAdapters: detectProjectAdapterDrift(dir, "release-abc1234-deadbeef") });
    const human = renderDoctor(f);
    assert.match(human, /Project orientation\/handoff adapters/);
    assert.ok(human.includes(dir), "the section names the project doctor inspected");
    // The release readiness block is still first — the new section is additive.
    assert.match(human, /^Release readiness:/);
  } finally {
    cleanup();
  }
});

// Readiness is keyed on COUPLING for every member of the conjunction. Adapters are
// prose, so a project with none installed is still a ready host: an exit code that
// fired on missing project adapters would fire forever on every project that owns
// its own /orient, which is noise, not signal.
test("FG-253 doctor: prose-only adapter drift does not move the exit code", () => {
  const { dir, cleanup } = adapterProject();
  try {
    const adapters = detectProjectAdapterDrift(dir, "release-abc1234-deadbeef");
    assert.ok(adapters.stale.length > 0, "fixture precondition: the adapters are absent");
    assert.equal(doctorReady(findings({ projectAdapters: adapters })), true);
    // ... and the conjunction is structural, not omitted: an executable-coupled
    // adapter WOULD move it, so the rule follows the taxonomy rather than a comment.
    assert.equal(doctorReady(findings({ projectAdapters: { ...adapters, ok: false } })), false);
  } finally {
    cleanup();
  }
});

test("FG-253 doctor --json: carries the same adapter entries the human section renders", () => {
  const { dir, cleanup } = adapterProject();
  try {
    const adapters = detectProjectAdapterDrift(dir, "release-abc1234-deadbeef");
    const f = findings({ projectAdapters: adapters });
    const payload = JSON.parse(JSON.stringify(doctorJson(f))) as { projectAdapters: typeof adapters };
    assert.deepEqual(payload.projectAdapters, JSON.parse(JSON.stringify(adapters)));
    const human = renderDoctor(f);
    for (const e of payload.projectAdapters.stale) {
      assert.ok(human.includes(e.path), `${e.path} appears in both the JSON and the human section`);
    }
    assert.equal(payload.projectAdapters.projectDir, dir);
  } finally {
    cleanup();
  }
});

// An operator's own /orient must be visible in BOTH renderings and named in
// neither remedy — forge declining to clobber a file it does not own is the
// command working, not a finding to fix.
test("FG-253 doctor: an operator-owned adapter is reported, and never under a forge upgrade remedy", () => {
  const { dir, cleanup } = adapterProject();
  try {
    const stamp = "release-abc1234-deadbeef";
    for (const base of projectAdapterBaseline(stamp)) {
      const abs = join(dir, ...base.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, base.bytes);
    }
    const mine = projectAdapterBaseline(stamp)[0]!.path;
    writeFileSync(join(dir, ...mine.split("/")), "# mine\n");

    const adapters = detectProjectAdapterDrift(dir, stamp);
    const f = findings({ projectAdapters: adapters });
    const human = renderDoctor(f);
    assert.ok(human.includes(mine));
    for (const line of human.split("\n").filter((l) => l.includes("forge upgrade"))) {
      assert.ok(!line.includes(mine), `operator-owned file named in a remedy: ${line}`);
    }
    assert.equal(doctorReady(f), true);
    const payload = doctorJson(f) as { projectAdapters: typeof adapters };
    assert.equal(payload.projectAdapters.entries.find((e) => e.path === mine)?.ownership, "operator-authored");
  } finally {
    cleanup();
  }
});

// The acceptance is about `forge doctor`, not only its pure faces — so drive the
// REAL registered action (same shape as fg583-doctor-seed-install), with cwd
// pointed at a disposable project. Docker probes fail gracefully in-container; the
// adapter assertions are independent of the image/policy checks. Operates only on
// the disposable $FORGE_HOME from src/test-setup.ts.
async function runRegisteredDoctor(cwd: string, args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerDoctor(program);
  const lines: string[] = [];
  const realLog = console.log;
  const savedExit = process.exitCode;
  const savedCwd = process.cwd();
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  process.chdir(cwd);
  try {
    await program.parseAsync(["node", "forge", "doctor", ...args]);
    return { out: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    process.chdir(savedCwd);
    console.log = realLog;
    process.exitCode = savedExit;
  }
}

test("FG-253 `forge doctor`: the real action reports THIS project's adapters, human and --json alike", async () => {
  const { dir, cleanup } = adapterProject();
  try {
    const human = await runRegisteredDoctor(dir, []);
    assert.match(human.out, /Project orientation\/handoff adapters/);
    assert.ok(human.out.includes(dir), "the section names the project doctor was invoked in");
    assert.match(human.out, /no other checkout on this host was read/);

    const json = await runRegisteredDoctor(dir, ["--json"]);
    const payload = JSON.parse(json.out) as {
      projectAdapters: { projectDir: string; entries: Array<{ path: string; status: string }> };
    };
    assert.equal(payload.projectAdapters.projectDir, dir);
    for (const e of payload.projectAdapters.entries) {
      assert.equal(e.status, "missing");
      assert.ok(human.out.includes(e.path), `${e.path} is in both renderings`);
    }
    // Installing exactly what this release renders silences the section entirely.
    for (const base of projectAdapterBaseline(currentAdapterStamp())) {
      const abs = join(dir, ...base.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, base.bytes);
    }
    const after = await runRegisteredDoctor(dir, []);
    assert.ok(!after.out.includes("Project orientation/handoff adapters"));
    // Adapter state never moved the exit code in either direction: readiness is a
    // function of coupling, and these are prose.
    assert.equal(after.exitCode, human.exitCode);
  } finally {
    cleanup();
  }
});

// ───────── FG-693 step 7: doctor and the drift checks decide on IDENTITY ─────────
//
// THE DEFECT, IN THIS EXACT FILE. Read `adapterProject()` above: it realpaths its
// fixture root, and the comment says why — doctor reads its project from
// process.cwd(), the assertions compare that against the path the test made, and on
// darwin os.tmpdir() is a /var/folders/… spelling of /private/var/folders/…, so the
// comparison called ONE directory two directories. FG-253 canonicalized at the call
// site and moved on; that is a workaround in a test, and it is the third time this
// class was fixed locally rather than settled. The production fix is here: doctor
// resolves its project ONCE through the one contract and reports the PROVEN identity
// alongside the operator's spelling, so a reader comparing two doctor runs compares
// trees rather than strings.
//
// PORTABLE BY CONSTRUCTION. Every alias below is one these tests CREATE — a
// symlinked parent, a trailing separator, a `..` segment, a relative spelling. None
// depends on an alias a particular OS happens to provide, which is exactly why the
// earlier coverage was CI-green and host-red. On darwin the /var vs /private/var
// spellings are the SAME class and are exercised natively by this file's own tmpdir
// fixtures (see the HOST note in the step's acceptance).

/** A project under a symlinked parent, so one checkout has several spellings.
 *  `physical` is the realpath; every entry of `aliases` names that same tree. */
function aliasedProject(): { physical: string; aliases: string[]; root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg693-doctor-")));
  mkdirSync(join(root, "real"), { recursive: true });
  const physical = join(root, "real", "checkout");
  mkdirSync(physical, { recursive: true });
  symlinkSync(join(root, "real"), join(root, "link"), "dir");
  return {
    physical,
    root,
    aliases: [
      join(root, "link", "checkout"), // a symlinked parent
      physical + sep, // a trailing separator
      `${physical}${sep}..${sep}checkout`, // an uncollapsed `..` segment
    ],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("FG-693 AC4: doctor run from an aliased spelling reports the SAME findings as the canonical one", () => {
  const { physical, aliases, cleanup } = aliasedProject();
  try {
    const canonical = gatherDoctorFindings(physical);
    assert.equal(canonical.project.kind, "resolved", "fixture precondition: the checkout resolves");

    for (const alias of aliases) {
      const aliased = gatherDoctorFindings(alias);

      // The identity is the same tree — this is the comparison every consumer makes.
      assert.deepEqual(aliased.project, { kind: "resolved", physical, asWritten: alias });
      assert.equal(
        (aliased.projectAdapters.projectIdentity as { physical?: string }).physical,
        (canonical.projectAdapters.projectIdentity as { physical?: string }).physical,
        `${alias} and ${physical} are one checkout`,
      );

      // ...and the drift verdict itself is identical: same entries, same stale set,
      // same readiness. "Reports no drift against the same checkout's canonical
      // spelling" is a claim about the FINDINGS, not only about the identity field.
      assert.deepEqual(aliased.projectAdapters.entries, canonical.projectAdapters.entries);
      assert.deepEqual(aliased.projectAdapters.stale, canonical.projectAdapters.stale);
      assert.equal(aliased.projectAdapters.ok, canonical.projectAdapters.ok);
      assert.equal(doctorReady(aliased), doctorReady(canonical));

      // THE FALSIFICATION (AC8), at doctor's own seam rather than at the primitive:
      // the two runs are only equal BECAUSE the comparison is on identity. Raw string
      // equality — what every consumer did before this ticket — calls them different.
      if (alias !== physical) {
        assert.notEqual(
          aliased.projectAdapters.projectDir,
          canonical.projectAdapters.projectDir,
          "precondition: this spelling really is a different string",
        );
      }
      // Display fidelity is preserved: the operator's spelling is reported verbatim,
      // and it is the field that decides nothing.
      assert.equal(aliased.projectAdapters.projectDir, alias);
    }
  } finally {
    cleanup();
  }
});

test("FG-693 AC2: a RELATIVE spelling of the checkout is the same identity to doctor", () => {
  const { physical, root, cleanup } = aliasedProject();
  const saved = process.cwd();
  try {
    process.chdir(join(root, "real"));
    const relative = gatherDoctorFindings("checkout");
    process.chdir(saved);
    const canonical = gatherDoctorFindings(physical);

    assert.deepEqual(relative.project, { kind: "resolved", physical, asWritten: "checkout" });
    assert.deepEqual(relative.projectAdapters.entries, canonical.projectAdapters.entries);
    assert.equal(relative.projectAdapters.projectDir, "checkout", "display keeps what the operator typed");
  } finally {
    process.chdir(saved);
    cleanup();
  }
});

test("FG-693 AC7 negative control: two distinct checkouts sharing a lexical prefix stay distinct", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg693-doctor-distinct-")));
  try {
    const a = join(root, "project");
    const b = join(root, "project-two"); // `a` is a strict string prefix of `b`
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    // Install this release's adapters into `a` only, so the two reports must differ.
    const stamp = currentAdapterStamp();
    for (const base of projectAdapterBaseline(stamp)) {
      const abs = join(a, ...base.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, base.bytes);
    }

    const left = gatherDoctorFindings(a);
    const right = gatherDoctorFindings(b);
    assert.notDeepEqual(left.project, right.project);
    assert.deepEqual(left.projectAdapters.stale, [], "the converged checkout reports no adapter drift");
    assert.ok(right.projectAdapters.stale.length > 0, "the other checkout is NOT credited with its neighbour's bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FG-693: an UNRESOLVED project dir is reported as unresolved, not as a tree doctor read", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg693-doctor-gone-")));
  const gone = join(root, "deleted-checkout");
  try {
    const f = gatherDoctorFindings(gone);
    assert.equal(f.project.kind, "unresolved");
    assert.equal(f.project.asWritten, gone, "the spelling is still reported — under a discriminator that says nothing was proven");
    assert.equal(f.projectAdapters.projectIdentity.kind, "unresolved");

    const section = renderProjectAdapterDrift(f.projectAdapters);
    assert.match(section, /UNRESOLVED/, "the printed spelling is LABELLED, never shown as though it were proven");
    assert.match(section, /did not resolve/);
    // Prose coupling still decides readiness — an unresolvable project dir is a
    // reported condition, not a new exit-code trigger.
    assert.equal(doctorReady(f), doctorReady({ ...f, projectAdapters: { ...f.projectAdapters, stale: [], ok: true } }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── adapterStampForAssetRoot: agreement is only ever claimed about a tree it read ──

test("FG-693 AC4: an ALIASED spelling of the running asset root resolves to the same stamp", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg693-assetroot-")));
  try {
    const alias = join(root, "running-forge");
    symlinkSync(assetRoot(), alias, "dir");

    const direct = resolveAdapterStampForAssetRoot(assetRoot());
    const aliased = resolveAdapterStampForAssetRoot(alias);
    assert.notEqual(direct.stamp, null, "fixture precondition: the running tree names itself");
    assert.equal(aliased.stamp, direct.stamp, "one tree, two spellings, one generation");
    assert.equal(aliased.basis, direct.basis);
    assert.equal(adapterStampForAssetRoot(alias), adapterStampForAssetRoot(assetRoot()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The regression the deleted isSameTree() could not survive. Its catch arm returned
// `resolve(p)` — a LEXICAL guess — in the position a proven path is read from, so a
// root that does NOT EXIST but whose lexical resolution spells out to the running
// tree compared EQUAL and was handed the running forge's dev stamp: agreement with a
// generation it never looked at, derived from a directory it never resolved.
test("FG-693: two UNRESOLVABLE spellings are INDETERMINATE — never agreement between guesses", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fg693-promoted-away-")));
  try {
    // The release tree a concurrent promote replaced: the running forge still names
    // it, and it is no longer there. BOTH sides of the comparison are the same
    // unresolvable spelling — the case the deleted isSameTree() got wrong, because
    // resolve() of a gone path is the path, so its two guesses matched and it
    // returned the running dev stamp for a tree neither side had read.
    const promotedAway = join(root, "release-that-was-replaced");
    assert.equal(resolve(promotedAway), promotedAway, "precondition: lexically, the two guesses are identical");

    const resolution = resolveAdapterStampForAssetRoot(promotedAway, promotedAway);
    assert.equal(resolution.basis, "indeterminate", "byte-equal spellings prove nothing when neither resolves");
    assert.equal(resolution.stamp, null, "no stamp is claimed for a tree that was never read");
    assert.match(resolution.detail, /INDETERMINATE/);
    assert.match(resolution.detail, /UNRESOLVED/, "both unresolved sides are named and labelled");

    // ...and it stays indeterminate against the tree that IS running, rather than
    // being reported as a proven difference from it.
    const againstRunning = resolveAdapterStampForAssetRoot(promotedAway);
    assert.equal(againstRunning.basis, "indeterminate");
    assert.equal(adapterStampForAssetRoot(promotedAway), null);

    // Non-vacuity: the same fixture, once it EXISTS, is a proven answer — so the
    // indeterminate arm above is about resolvability and not about this path.
    mkdirSync(promotedAway, { recursive: true });
    assert.equal(resolveAdapterStampForAssetRoot(promotedAway, promotedAway).basis, "running-tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FG-693: a resolvable tree that is NOT the running one is a NAMED disagreement, not indeterminate", () => {
  const foreign = realpathSync(mkdtempSync(join(tmpdir(), "fg693-foreign-forge-")));
  try {
    const resolution = resolveAdapterStampForAssetRoot(foreign);
    assert.equal(resolution.basis, "foreign-tree", "both sides resolved — this is a real disagreement");
    assert.equal(resolution.stamp, null, "somebody else's dev checkout has only a content identity this process cannot render");
    assert.ok(resolution.detail.includes(foreign));
    assert.ok(!resolution.detail.includes("INDETERMINATE"), "a proven difference must not read as 'we could not tell'");
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

// ─────────── FG-546: `forge doctor` reports docs-surfaces config state ───────────
//
// AC7: doctor distinguishes the four states the shared classifier
// (src/v2/contract.ts) adjudicates — valid project config, missing config, the
// known generated legacy shape, and customized-invalid content — the last two
// each naming their repair action. This is a reported diagnostic: read/dispatch
// is fail-soft, so docs-surfaces state never moves the exit code. These tests
// drive both the pure render/JSON faces over synthetic verdicts AND the real
// gather path against on-disk fixtures, so doctor and the write side (init/
// upgrade) can never disagree about the verdict.

function writeDocsSurfaces(body: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "docs-surfaces.yml"), body);
}

// The exact frozen legacy object template forge's old seed emitted, dressed with
// comments/whitespace to prove structural (not byte) matching.
const LEGACY_DOCS_SURFACES = `# docs surfaces
surfaces:
  - name: readme       # user-facing entry point
    kind: user-facing
    path: README.md
  - name: api-reference
    kind: public-api
    path: docs/api.md
`;

test("FG-546 renderDocsSurfaces: the four verdicts render distinctly", () => {
  const valid = renderDocsSurfaces({ verdict: "valid-project", path: "/p/.forge/docs-surfaces.yml" });
  const missing = renderDocsSurfaces({ verdict: "missing", path: "/p/.forge/docs-surfaces.yml" });
  const legacy = renderDocsSurfaces({ verdict: "known-legacy-generated", path: "/p/.forge/docs-surfaces.yml" });
  const invalid = renderDocsSurfaces({ verdict: "customized-invalid", path: "/p/.forge/docs-surfaces.yml", detail: "surfaces: Required" });

  // Each state produces a distinct rendering.
  const all = [valid, missing, legacy, invalid];
  assert.equal(new Set(all).size, 4, "every verdict renders a distinct line");

  // Valid/missing report cleanly — no scary framing, no remedy.
  assert.match(valid, /OK/);
  assert.doesNotMatch(valid, /forge upgrade|Fix:/);
  assert.match(missing, /default/);
  assert.doesNotMatch(missing, /forge upgrade|Fix:/);

  // Legacy names the file and the auto-repair action (forge upgrade).
  assert.match(legacy, /LEGACY/);
  assert.match(legacy, /forge upgrade/);
  assert.match(legacy, /\/p\/\.forge\/docs-surfaces\.yml/);

  // Customized-invalid names the file, the validation error, and the operator
  // repair action — and explicitly promises forge will NOT overwrite it.
  assert.match(invalid, /INVALID/);
  assert.match(invalid, /surfaces: Required/);
  assert.match(invalid, /will not overwrite|not.*overwrite/i);
  assert.doesNotMatch(invalid, /forge upgrade/); // customized files are the operator's to fix
});

test("FG-546 doctor: docs-surfaces state never moves the exit code (fail-soft diagnostic)", () => {
  for (const v of ["valid-project", "missing", "known-legacy-generated", "customized-invalid"] as const) {
    const f = findings({ docsSurfaces: { verdict: v, path: "/tmp/p/.forge/docs-surfaces.yml", detail: "x" } });
    assert.equal(doctorReady(f), true, `${v} is a reported diagnostic, not a readiness fail`);
  }
});

test("FG-546 doctor --json: carries the classifier verdict a script can branch on", () => {
  const f = findings({ docsSurfaces: { verdict: "customized-invalid", path: "/tmp/p/.forge/docs-surfaces.yml", detail: "surfaces: Required" } });
  const payload = JSON.parse(JSON.stringify(doctorJson(f))) as { docsSurfaces: DoctorFindings["docsSurfaces"] };
  assert.deepEqual(payload.docsSurfaces, { verdict: "customized-invalid", path: "/tmp/p/.forge/docs-surfaces.yml", detail: "surfaces: Required" });
  // The human section renders the same verdict — the two faces cannot disagree.
  assert.match(renderDoctor(f), /INVALID/);
});

test("FG-546 doctor (real gather): a valid project docs-surfaces file reads as valid-project", () => {
  writeDocsSurfaces("surfaces:\n  - src/cli/\n  - src/v2/contract.ts\n");
  const f = gatherDoctorFindings(projectDir);
  assert.equal(f.docsSurfaces.verdict, "valid-project");
  assert.match(renderDoctor(f), /Docs-surfaces config: OK/);
});

test("FG-546 doctor (real gather): no file reads as missing and reports cleanly", () => {
  const f = gatherDoctorFindings(projectDir);
  assert.equal(f.docsSurfaces.verdict, "missing");
  const human = renderDoctor(f);
  assert.match(human, /Docs-surfaces config: default/);
  assert.doesNotMatch(human, /Docs-surfaces config: (LEGACY|INVALID)/);
});

test("FG-546 doctor (real gather): the exact legacy template reads as known-legacy-generated with the upgrade remedy", () => {
  writeDocsSurfaces(LEGACY_DOCS_SURFACES);
  const f = gatherDoctorFindings(projectDir);
  assert.equal(f.docsSurfaces.verdict, "known-legacy-generated");
  const human = renderDoctor(f);
  assert.match(human, /Docs-surfaces config: LEGACY/);
  assert.match(human, /forge upgrade/);
  // JSON encodes the same verdict for a script.
  const payload = JSON.parse(JSON.stringify(doctorJson(f))) as { docsSurfaces: DoctorFindings["docsSurfaces"] };
  assert.equal(payload.docsSurfaces.verdict, "known-legacy-generated");
});

test("FG-546 doctor (real gather): a hand-authored invalid file reads as customized-invalid, never legacy", () => {
  // Not the frozen 2-entry template — a 1-entry object variant. Structurally
  // deviant => customized-invalid, so doctor must NOT advise auto-repair.
  writeDocsSurfaces("surfaces:\n  - name: custom\n    kind: mine\n    path: CHANGELOG.md\n");
  const f = gatherDoctorFindings(projectDir);
  assert.equal(f.docsSurfaces.verdict, "customized-invalid");
  assert.ok((f.docsSurfaces.detail ?? "").length > 0, "the schema validation error is carried");
  assert.match(renderDoctor(f), /Docs-surfaces config: INVALID/);
  // The docs-surfaces SECTION itself must not advise auto-repair (forge upgrade
  // clobbers nothing here); assert against the isolated section, since the full
  // doctor output legitimately mentions `forge upgrade` in other sections.
  assert.doesNotMatch(renderDocsSurfaces(f.docsSurfaces), /forge upgrade/);
});

test("FG-546 `forge doctor`: the real action renders docs-surfaces state, human and --json alike", async () => {
  writeDocsSurfaces(LEGACY_DOCS_SURFACES);
  const human = await runRegisteredDoctor(projectDir, []);
  assert.match(human.out, /Docs-surfaces config: LEGACY/);
  assert.match(human.out, /forge upgrade/);

  const json = await runRegisteredDoctor(projectDir, ["--json"]);
  const payload = JSON.parse(json.out) as { docsSurfaces: { verdict: string } };
  assert.equal(payload.docsSurfaces.verdict, "known-legacy-generated");
});
