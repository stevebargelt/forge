// FG-804: exercise the shipped `forge doctor` process against its Docker boundary.
// The disposable `docker` executable emulates image discovery, command presence,
// and `claude --version`; no daemon/image is required. The policy, CLI process,
// and report renderer are all real.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_EXEC, BUILT_CLI_ENTRY } from "../../integration-cli-spawn.js";
import { gatherReleaseInputs } from "./doctor.js";
import { buildReleaseReport } from "../../v2/release-doctor.js";

let projectDir: string;
let binDir: string;

const runtime = (name: string, command: string, model: string) => `
name: ${name}
description: FG-804 integration fixture
image: agent-dev-worker:latest
models:
  default: ${model}
auth:
  mode: apikey
mounts: []
invocation:
  command: ${command}
  args: []
container:
  name: forge-fg804
  remove_on_exit: true
  idle_timeout_seconds: 300
result:
  file: /task/result.json
`;

// The only Bedrock Opus mapping is profile-only; the [1m] spelling is a claude
// runtime alias. Codex and pi deliberately carry the same floored id as controls.
const policy = `
on_unavailable: fail
schema_version: 2
model_profiles:
  profile-only-opus:
    provider: anthropic
    runtime: claude-profile
    auth: api
    map:
      default: { model: us.anthropic.claude-opus-5-5-v1:0, cost_tier: premium }
defaults:
  profile: profile-only-opus
  activity: {}
allowed_profiles: [profile-only-opus]
`;

function writeFixture(): void {
  mkdirSync(join(projectDir, ".forge", "runtimes"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), policy);
  writeFileSync(join(projectDir, ".forge", "runtimes", "claude-profile.yml"), runtime("claude-profile", "claude", "claude-opus-5-5[1m]"));
  writeFileSync(join(projectDir, ".forge", "runtimes", "codex-fixture.yml"), runtime("codex-fixture", "codex", "claude-opus-5-5"));
  writeFileSync(join(projectDir, ".forge", "runtimes", "pi-fixture.yml"), runtime("pi-fixture", "pi", "claude-opus-5-5"));
}

function writeDockerSeam(): void {
  mkdirSync(binDir, { recursive: true });
  const docker = join(binDir, "docker");
  writeFileSync(docker, `#!/bin/sh
set -eu
if [ "$1" = image ] && [ "$2" = ls ]; then echo fixture-image-id; exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then echo fixture-digest; exit 0; fi
if [ "$1" = run ] && [ "$4" = sh ]; then echo 'OK claude'; exit 0; fi
if [ "$1" = run ] && [ "$4" = claude ]; then
  if [ "\${FG804_CLAUDE_VERSION:-}" = unreadable ]; then echo 'broken version output'; else echo "\${FG804_CLAUDE_VERSION:-2.1.281} (Claude Code)"; fi
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 64
`);
  chmodSync(docker, 0o755);
}

function runDoctor(version: string) {
  return spawnSync(NODE_EXEC, [BUILT_CLI_ENTRY, "doctor", "--json"], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, FG804_CLAUDE_VERSION: version, ANTHROPIC_API_KEY: "fixture" },
  });
}

function versionRow(stdout: string) {
  const payload = JSON.parse(stdout) as { checks: Array<{ name: string; status: string; detail: string; next?: string }> };
  const row = payload.checks.find((check) => check.name === "claude CLI version");
  assert.ok(row, `missing Claude version row in ${stdout}`);
  return row;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg804-doctor-"));
  binDir = join(projectDir, "bin");
  writeFixture();
  writeDockerSeam();
});

afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

test("FG-804 CLI spawn: old in-image Claude blocks doctor and names actionable details", () => {
  const result = runDoctor("2.1.224");
  assert.notEqual(result.status, 0, result.stderr);
  const row = versionRow(result.stdout);
  assert.equal(row.status, "fail");
  assert.match(row.detail, /us\.anthropic\.claude-opus-5-5-v1:0/);
  assert.match(row.detail, /claude-opus-5-5\[1m\]/);
  assert.match(row.detail, /2\.1\.280/);
  assert.match(row.detail, /2\.1\.224/);
  assert.match(row.next ?? "", /docker\/build\.sh|forge upgrade --rebuild-image/);
  assert.doesNotMatch(row.detail, /codex-fixture|pi-fixture/, "non-claude runtimes must not affect this floor row");
});

test("FG-804 CLI spawn: at-floor in-image Claude passes the version row", () => {
  const result = runDoctor("2.1.280");
  const row = versionRow(result.stdout);
  assert.equal(row.status, "ok");
  assert.match(row.detail, /meets every configured model floor/);
});

test("FG-804 CLI spawn: unreadable in-image Claude version is an explicit blocking failure", () => {
  const result = runDoctor("unreadable");
  assert.notEqual(result.status, 0, result.stderr);
  const row = versionRow(result.stdout);
  assert.equal(row.status, "fail");
  assert.match(row.detail, /could not determine the in-image Claude Code version/);
  assert.match(row.detail, /unrecognized.*claude --version.*broken version output/i);
});

test("FG-804 release gather path: upgrade's gathered inputs surface the same blocking row", () => {
  const inputs = gatherReleaseInputs("agent-dev-worker:latest", { projectDir }, {
    inspectImage: () => ({ name: "agent-dev-worker:latest", present: true, recordedDigest: "fixture", currentInputDigest: "fixture" }),
    probeClisInImage: (_image, commands) => Object.fromEntries(commands.map((command) => [command, true])),
    probeClaudeCliVersion: () => ({ kind: "version", version: "2.1.224" }),
  });
  const report = buildReleaseReport(inputs);
  const row = report.checks.find((check) => check.name === "claude CLI version");
  assert.equal(row?.status, "fail");
  assert.match(row?.detail ?? "", /us\.anthropic\.claude-opus-5-5-v1:0/);
  assert.match(row?.detail ?? "", /claude-opus-5-5\[1m\]/);
  assert.doesNotMatch(row?.detail ?? "", /codex-fixture|pi-fixture/);
  assert.equal(report.ok, false);
});
