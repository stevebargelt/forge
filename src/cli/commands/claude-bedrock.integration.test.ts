/**
 * Integration tests for FG-158: --bedrock / --aws-profile flags + project.json auth config.
 *
 * Covers five areas thin in the existing unit-test suite:
 *   (1) AWS_PROFILE resolution order: --aws-profile flag > project.json.awsProfile
 *                                     > AWS_PROFILE env > "default"
 *   (2) Child env receives CLAUDE_CODE_USE_BEDROCK=1 + AWS_PROFILE while
 *       the parent process.env is NOT mutated.
 *   (3) Forge-specific --bedrock / --aws-profile flags are stripped from the
 *       argv that would be forwarded to claude.
 *   (4) apikey mode exits non-zero when ANTHROPIC_API_KEY is unset (subprocess test).
 *   (5) readProjectAuth returns null for absent / invalid project.json (cross-check).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  extractAwsProfileFromArgs,
  stripBedrockFlagsFromArgs,
  stripNameFromArgs,
} from "./claude.js";
import { readProjectAuth } from "../../util/project-meta.js";

const here = dirname(fileURLToPath(import.meta.url));
// From src/cli/commands/ go up two to src/, then into cli/index.ts.
const entry = resolve(here, "..", "..", "cli", "index.ts");
// node_modules lives at the project root (three levels above here).
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let tmp: string;
let savedAwsProfile: string | undefined;
let savedBedrockEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "forge-claude-bedrock-integ-"));
  savedAwsProfile = process.env.AWS_PROFILE;
  savedBedrockEnv = process.env.CLAUDE_CODE_USE_BEDROCK;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  // Restore env vars touched by individual tests.
  if (savedAwsProfile === undefined) {
    delete process.env.AWS_PROFILE;
  } else {
    process.env.AWS_PROFILE = savedAwsProfile;
  }
  if (savedBedrockEnv === undefined) {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  } else {
    process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrockEnv;
  }
});

function writeForgeProjectJson(projectDir: string, body: Record<string, unknown>): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "project.json"), JSON.stringify(body));
}

// Mirrors the resolution logic in claude.ts action (the single expression the
// action evaluates when bedrockActive is true):
//   awsProfileFlag ?? projectAuth?.awsProfile ?? process.env.AWS_PROFILE ?? "default"
function resolveProfile(
  awsProfileFlag: string | undefined,
  projectAuth: ReturnType<typeof readProjectAuth>,
): string {
  return awsProfileFlag ?? projectAuth?.awsProfile ?? process.env.AWS_PROFILE ?? "default";
}

// ─── (1) AWS_PROFILE resolution order ────────────────────────────────────────

test("integ FG-158: --aws-profile CLI flag wins over project.json.awsProfile", () => {
  writeForgeProjectJson(tmp, { auth: "bedrock", awsProfile: "project-profile" });
  const awsProfileFlag = extractAwsProfileFromArgs(["--bedrock", "--aws-profile", "cli-profile"]);
  const projectAuth = readProjectAuth(tmp);
  assert.equal(resolveProfile(awsProfileFlag, projectAuth), "cli-profile");
});

test("integ FG-158: --aws-profile CLI flag wins over AWS_PROFILE env var", () => {
  process.env.AWS_PROFILE = "env-profile";
  const awsProfileFlag = extractAwsProfileFromArgs(["--bedrock", "--aws-profile", "cli-profile"]);
  assert.equal(resolveProfile(awsProfileFlag, null), "cli-profile");
});

test("integ FG-158: --aws-profile=<value> (single-token form) wins over project.json.awsProfile", () => {
  writeForgeProjectJson(tmp, { auth: "bedrock", awsProfile: "project-profile" });
  const awsProfileFlag = extractAwsProfileFromArgs(["--bedrock", "--aws-profile=flag-profile"]);
  const projectAuth = readProjectAuth(tmp);
  assert.equal(resolveProfile(awsProfileFlag, projectAuth), "flag-profile");
});

test("integ FG-158: project.json.awsProfile wins over AWS_PROFILE env var", () => {
  writeForgeProjectJson(tmp, { auth: "bedrock", awsProfile: "project-profile" });
  process.env.AWS_PROFILE = "env-profile";
  // No --aws-profile flag in the args.
  const awsProfileFlag = extractAwsProfileFromArgs(["--bedrock"]);
  const projectAuth = readProjectAuth(tmp);
  assert.equal(resolveProfile(awsProfileFlag, projectAuth), "project-profile");
});

test("integ FG-158: AWS_PROFILE env var wins over hard-coded 'default' fallback", () => {
  process.env.AWS_PROFILE = "env-profile";
  // No --aws-profile flag, no project.json.
  const awsProfileFlag = extractAwsProfileFromArgs(["--bedrock"]);
  const projectAuth = readProjectAuth(tmp);   // returns null — no project.json
  assert.equal(resolveProfile(awsProfileFlag, projectAuth), "env-profile");
});

test("integ FG-158: falls back to 'default' when no profile source is configured", () => {
  delete process.env.AWS_PROFILE;
  const awsProfileFlag = extractAwsProfileFromArgs(["--bedrock"]);
  const projectAuth = readProjectAuth(tmp);   // returns null — no project.json
  assert.equal(resolveProfile(awsProfileFlag, projectAuth), "default");
});

// ─── (2) Parent process.env is not mutated when building childEnv ─────────────
// The action in claude.ts arms the child via spread:
//   childEnv = { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: resolvedProfile }
// This verifies that the spread pattern never writes back to process.env.

test("integ FG-158: childEnv has CLAUDE_CODE_USE_BEDROCK=1 and AWS_PROFILE; process.env is not mutated", () => {
  // Ensure the bedrock key is absent from the parent before we run.
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  const originalAwsProfile = process.env.AWS_PROFILE;

  // Reproduce the exact pattern from claude.ts action:
  const resolvedProfile = "integ-bedrock-profile";
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: resolvedProfile,
  };

  // Child env carries the expected values.
  assert.equal(childEnv.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(childEnv.AWS_PROFILE, "integ-bedrock-profile");

  // Parent process.env must NOT have been mutated.
  assert.equal(
    process.env.CLAUDE_CODE_USE_BEDROCK,
    undefined,
    "spread must not write CLAUDE_CODE_USE_BEDROCK back to process.env",
  );
  assert.equal(
    process.env.AWS_PROFILE,
    originalAwsProfile,
    "spread must not change process.env.AWS_PROFILE",
  );
});

test("integ FG-158: childEnv inherits all parent env vars alongside the injected bedrock vars", () => {
  process.env._FG158_SENTINEL = "sentinel-value";
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "bedrock-profile",
    };
    // Injected vars are present.
    assert.equal(childEnv.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(childEnv.AWS_PROFILE, "bedrock-profile");
    // Pre-existing parent var is carried into the child.
    assert.equal(childEnv._FG158_SENTINEL, "sentinel-value");
    // Parent itself is still uncontaminated.
    assert.equal(process.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  } finally {
    delete process.env._FG158_SENTINEL;
  }
});

// ─── (3) Forge flags stripped from argv passed to claude ─────────────────────

test("integ FG-158: --bedrock and --aws-profile (two-token form) stripped; other flags reach claude", () => {
  const rawArgs = ["--bedrock", "--aws-profile", "adx-dev", "--continue", "--model", "sonnet"];
  // Reproduce the pipeline the action uses:
  const stripped = stripBedrockFlagsFromArgs(rawArgs);          // strip forge flags
  const passthrough = stripNameFromArgs(stripped);               // strip user -n if any
  const finalArgs = ["-n", "my-project", ...passthrough];       // forge re-inserts -n

  assert.ok(!finalArgs.includes("--bedrock"), "--bedrock must not reach claude");
  assert.ok(!finalArgs.includes("--aws-profile"), "--aws-profile must not reach claude");
  assert.ok(!finalArgs.includes("adx-dev"), "aws-profile value must not reach claude");
  assert.ok(finalArgs.includes("--continue"), "--continue must pass through");
  assert.ok(finalArgs.includes("--model"), "--model must pass through");
  assert.ok(finalArgs.includes("sonnet"), "model value must pass through");
  // forge always puts -n <name> first.
  assert.equal(finalArgs[0], "-n");
  assert.equal(finalArgs[1], "my-project");
});

test("integ FG-158: --aws-profile=<value> (single-token form) stripped; other flags reach claude", () => {
  const rawArgs = ["--bedrock", "--aws-profile=adx-dev", "--resume", "abc123"];
  const stripped = stripBedrockFlagsFromArgs(rawArgs);
  const passthrough = stripNameFromArgs(stripped);
  const finalArgs = ["-n", "my-project", ...passthrough];

  assert.ok(!finalArgs.includes("--bedrock"), "--bedrock must not reach claude");
  assert.ok(
    !finalArgs.some((a) => a.startsWith("--aws-profile")),
    "--aws-profile=... must not reach claude",
  );
  assert.ok(finalArgs.includes("--resume"), "--resume must pass through");
  assert.ok(finalArgs.includes("abc123"), "resume value must pass through");
});

test("integ FG-158: no bedrock flags in args → finalArgs unchanged (no spurious strips)", () => {
  const rawArgs = ["--continue", "--model", "sonnet"];
  const stripped = stripBedrockFlagsFromArgs(rawArgs);
  const passthrough = stripNameFromArgs(stripped);
  const finalArgs = ["-n", "my-project", ...passthrough];

  // Everything except the auto-inserted -n pair should be present.
  assert.ok(finalArgs.includes("--continue"));
  assert.ok(finalArgs.includes("--model"));
  assert.ok(finalArgs.includes("sonnet"));
  assert.equal(finalArgs.length, 5, "only 5 elements: -n name --continue --model sonnet");
});

// ─── (4) apikey mode exits non-zero when ANTHROPIC_API_KEY is unset ──────────

test("integ FG-158: forge claude exits 1 when auth=apikey and ANTHROPIC_API_KEY is not set", () => {
  // Write a minimal git root with .forge/project.json auth=apikey.
  // findGitRoot will stop here because .git is present; readProjectAuth
  // will then find .forge/project.json at this same dir.
  mkdirSync(join(tmp, ".git"));
  writeForgeProjectJson(tmp, { auth: "apikey" });

  // Strip ANTHROPIC_API_KEY from the subprocess env so the guard fires.
  const testEnv = { ...process.env };
  delete testEnv.ANTHROPIC_API_KEY;
  delete testEnv.CLAUDE_CODE_USE_BEDROCK;   // ensure only the apikey path is hit

  const result = spawnSync(tsx, [entry, "claude"], {
    cwd: tmp,
    env: testEnv,
    encoding: "utf8",
    timeout: 15_000,
  });

  assert.equal(
    result.status,
    1,
    `expected exit code 1 for apikey with no key; got ${result.status}. stderr: ${result.stderr}`,
  );
  assert.match(
    result.stderr,
    /auth=apikey requires ANTHROPIC_API_KEY/,
    "error message must name the missing variable",
  );
});

test("integ FG-158: forge claude does NOT exit prematurely when auth=apikey and ANTHROPIC_API_KEY IS set", () => {
  // When the key is present, the apikey guard passes and the process continues
  // until it tries to spawn `claude` (which will fail if not installed, but
  // that error comes from the child spawn, not the apikey guard).
  mkdirSync(join(tmp, ".git"));
  writeForgeProjectJson(tmp, { auth: "apikey" });

  const testEnv: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: "sk-test-placeholder" };
  delete testEnv.CLAUDE_CODE_USE_BEDROCK;

  const result = spawnSync(tsx, [entry, "claude"], {
    cwd: tmp,
    env: testEnv,
    encoding: "utf8",
    timeout: 15_000,
  });

  // The apikey guard must NOT have fired (which exits 1 with "auth=apikey requires ...").
  const apiKeyGuardFired =
    result.status === 1 && result.stderr.includes("auth=apikey requires ANTHROPIC_API_KEY");
  assert.ok(!apiKeyGuardFired, "apikey guard must not fire when ANTHROPIC_API_KEY is set");
});

// ─── (5) readProjectAuth returns null for absent / invalid project.json ────────
// Cross-checks the unit-test coverage from project-meta.test.ts in integration context.

test("integ FG-158: readProjectAuth returns null when .forge/ directory is entirely absent", () => {
  // tmp has no .forge/ directory at all.
  assert.equal(readProjectAuth(tmp), null);
});

test("integ FG-158: readProjectAuth returns null for project.json with no auth fields", () => {
  writeForgeProjectJson(tmp, {});
  assert.equal(readProjectAuth(tmp), null);
});

test("integ FG-158: readProjectAuth returns null for project.json containing unrecognised auth value", () => {
  writeForgeProjectJson(tmp, { auth: "saml-sso" });
  assert.equal(readProjectAuth(tmp), null);
});

test("integ FG-158: readProjectAuth returns null for project.json containing malformed JSON", () => {
  mkdirSync(join(tmp, ".forge"), { recursive: true });
  writeFileSync(join(tmp, ".forge", "project.json"), "{ broken json ");
  assert.equal(readProjectAuth(tmp), null);
});
