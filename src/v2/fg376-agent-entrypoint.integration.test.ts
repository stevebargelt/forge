// FG-376 integration test: docker/agent-entrypoint.sh's dependency-provisioning
// contract (FORGE_NM_INSTALL_ROOT / FORGE_NM_SHADOW_PATHS / exit 123).
//
// The build phase validated this shell script by hand-tracing it under a
// stubbed npm/sudo (see the engineer's notes) but never committed that as a
// regression test — the script is untestable by any of the TS unit/worktree
// suites since it never gets imported, only exec'd by dockerd. This file
// closes that gap by actually running the real script via `bash` with
// stubbed `npm`/`sudo` binaries shadowing PATH, following the same
// spawnSync-a-real-script pattern as
// src/cli/commands/forge-test-default-tier.integration.test.ts (for
// docker/forge-test.sh).
//
// FORGE_NO_BROWSER=1 is set on every invocation so the chromium-launch block
// never fires — this suite verifies the FG-376 dependency-provisioning
// blocks only, not the browser-tools bootstrap.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE } from "./dependency-provisioning.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(here, "..", "..", "docker", "agent-entrypoint.sh");

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** A stub bin dir containing `npm` (logs its argv + cwd, exits per
 *  NPM_STUB_EXIT_CODE) and `sudo` (logs its argv, always exits 0 — mirrors
 *  the container's NOPASSWD sudo without needing real privilege escalation). */
function makeStubBin(): { binDir: string; npmLog: string; sudoLog: string } {
  const binDir = makeTmpDir("forge-entrypoint-stubbin-");
  const npmLog = join(binDir, "npm.log");
  const sudoLog = join(binDir, "sudo.log");
  writeFileSync(npmLog, "");
  writeFileSync(sudoLog, "");
  writeFileSync(
    join(binDir, "npm"),
    `#!/bin/sh\necho "argv=$* cwd=$(pwd)" >> "${npmLog}"\nexit "\${NPM_STUB_EXIT_CODE:-0}"\n`,
  );
  chmodSync(join(binDir, "npm"), 0o755);
  writeFileSync(join(binDir, "sudo"), `#!/bin/sh\necho "$@" >> "${sudoLog}"\nexit 0\n`);
  chmodSync(join(binDir, "sudo"), 0o755);
  return { binDir, npmLog, sudoLog };
}

function runEntrypoint(opts: {
  env: Record<string, string | undefined>;
  binDir: string;
  agentArgs: string[];
}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [ENTRYPOINT, ...opts.agentArgs], {
    env: {
      PATH: `${opts.binDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "/tmp",
      FORGE_NO_BROWSER: "1",
      ...opts.env,
    },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("agent-entrypoint.sh: neither FORGE_NM_SHADOW_PATHS nor FORGE_NM_INSTALL_ROOT set → npm never invoked, agent command runs unchanged", () => {
  const { binDir, npmLog } = makeStubBin();
  const workDir = makeTmpDir("forge-entrypoint-marker-");
  const marker = join(workDir, "ran.marker");

  const result = runEntrypoint({ env: {}, binDir, agentArgs: ["touch", marker] });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}, stderr: ${result.stderr}`);
  assert.ok(existsSync(marker), "agent command must still run when no FG-376 vars are set");
  assert.equal(readFileSync(npmLog, "utf8").trim(), "", "npm must never be invoked when FORGE_NM_INSTALL_ROOT is unset");
});

test("agent-entrypoint.sh: FORGE_NM_INSTALL_ROOT with a package-lock.json present → npm ci (not install), then agent command runs", () => {
  const { binDir, npmLog } = makeStubBin();
  const installRoot = makeTmpDir("forge-entrypoint-installroot-");
  writeFileSync(join(installRoot, "package-lock.json"), "{}");
  const marker = join(installRoot, "ran.marker");

  const result = runEntrypoint({
    env: { FORGE_NM_INSTALL_ROOT: installRoot },
    binDir,
    agentArgs: ["touch", marker],
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}, stderr: ${result.stderr}`);
  const npmCalls = readFileSync(npmLog, "utf8").trim();
  assert.match(npmCalls, /^argv=ci cwd=/, `expected 'npm ci' from installRoot, got: ${npmCalls}`);
  assert.match(npmCalls, new RegExp(`cwd=${installRoot}$`), "npm must run with cwd = FORGE_NM_INSTALL_ROOT");
  assert.doesNotMatch(npmCalls, /argv=install /, "must not fall back to npm install when a lockfile is present");
  assert.ok(existsSync(marker), "agent command must run after a successful install");
});

test("agent-entrypoint.sh: FORGE_NM_INSTALL_ROOT with no lockfile → npm install (not ci)", () => {
  const { binDir, npmLog } = makeStubBin();
  const installRoot = makeTmpDir("forge-entrypoint-installroot-nolock-");
  const marker = join(installRoot, "ran.marker");

  const result = runEntrypoint({
    env: { FORGE_NM_INSTALL_ROOT: installRoot },
    binDir,
    agentArgs: ["touch", marker],
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}, stderr: ${result.stderr}`);
  const npmCalls = readFileSync(npmLog, "utf8").trim();
  assert.match(npmCalls, /^argv=install cwd=/, `expected 'npm install' with no lockfile, got: ${npmCalls}`);
  assert.ok(existsSync(marker));
});

test("agent-entrypoint.sh: a failed install exits DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE before exec — agent command never runs, stderr carries a diagnostic", () => {
  const { binDir } = makeStubBin();
  const installRoot = makeTmpDir("forge-entrypoint-installroot-fail-");
  writeFileSync(join(installRoot, "package-lock.json"), "{}");
  const marker = join(installRoot, "ran.marker");

  const result = runEntrypoint({
    env: { FORGE_NM_INSTALL_ROOT: installRoot, NPM_STUB_EXIT_CODE: "1" },
    binDir,
    agentArgs: ["touch", marker],
  });

  assert.equal(
    result.status,
    DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE,
    `expected exit ${DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE}, got ${result.status}, stderr: ${result.stderr}`,
  );
  assert.ok(!existsSync(marker), "agent command must never run when the dependency install fails");
  assert.match(result.stderr, /forge: dependency install failed/, "the entrypoint's own diagnostic must be on stderr");
});

test("agent-entrypoint.sh: FORGE_NM_SHADOW_PATHS chowns only paths that actually exist on disk, then still execs the agent command", () => {
  const { binDir, sudoLog } = makeStubBin();
  const existingA = makeTmpDir("forge-entrypoint-shadow-a-");
  const existingB = makeTmpDir("forge-entrypoint-shadow-b-");
  const missing = join(makeTmpDir("forge-entrypoint-shadow-parent-"), "does-not-exist");
  const marker = join(existingA, "ran.marker");

  const result = runEntrypoint({
    env: { FORGE_NM_SHADOW_PATHS: `${existingA}:${missing}:${existingB}` },
    binDir,
    agentArgs: ["touch", marker],
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}, stderr: ${result.stderr}`);
  assert.ok(existsSync(marker));

  const sudoCalls = readFileSync(sudoLog, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(sudoCalls.some((l) => l === `chown agent:agent ${existingA}`), `expected a chown for ${existingA}, got: ${JSON.stringify(sudoCalls)}`);
  assert.ok(sudoCalls.some((l) => l === `chown agent:agent ${existingB}`), `expected a chown for ${existingB}, got: ${JSON.stringify(sudoCalls)}`);
  assert.ok(!sudoCalls.some((l) => l.includes(missing)), `must not chown a nonexistent path, got: ${JSON.stringify(sudoCalls)}`);
});

test("agent-entrypoint.sh: legacy FORGE_NM_SHADOW single-path chown still fires alongside FORGE_NM_SHADOW_PATHS (both blocks are additive, not mutually exclusive)", () => {
  const { binDir, sudoLog } = makeStubBin();
  const legacyPath = makeTmpDir("forge-entrypoint-legacy-shadow-");
  const memberPath = makeTmpDir("forge-entrypoint-member-shadow-");
  const marker = join(legacyPath, "ran.marker");

  const result = runEntrypoint({
    env: { FORGE_NM_SHADOW: legacyPath, FORGE_NM_SHADOW_PATHS: memberPath },
    binDir,
    agentArgs: ["touch", marker],
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}, stderr: ${result.stderr}`);
  const sudoCalls = readFileSync(sudoLog, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(sudoCalls.some((l) => l === `chown agent:agent ${legacyPath}`), "legacy FORGE_NM_SHADOW chown must still fire");
  assert.ok(sudoCalls.some((l) => l === `chown agent:agent ${memberPath}`), "FORGE_NM_SHADOW_PATHS chown must also fire");
});
