import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProjectRoot,
  extractNameFromArgs,
  stripNameFromArgs,
  extractBedrockFromArgs,
  extractAwsProfileFromArgs,
  stripBedrockFlagsFromArgs,
  buildClaudeChildEnv,
} from "./claude.js";

const MARKER = "<!-- forge:orchestrator-start -->";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "forge-claude-test-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ----- findProjectRoot -----

test("findProjectRoot: returns cwd when CLAUDE.md with the orchestrator marker is at cwd", () => {
  writeFileSync(join(tmp, "CLAUDE.md"), `# x\n${MARKER}\nbody\n`);
  assert.equal(findProjectRoot(tmp), tmp);
});

test("findProjectRoot: walks up from a subdir to find the marker", () => {
  writeFileSync(join(tmp, "CLAUDE.md"), `# x\n${MARKER}\nbody\n`);
  const sub = join(tmp, "src", "deep", "subdir");
  mkdirSync(sub, { recursive: true });
  assert.equal(findProjectRoot(sub), tmp);
});

test("findProjectRoot: returns null when no CLAUDE.md exists anywhere up the tree", () => {
  // tmp dir is unrelated to user's homedir; walking up wouldn't normally hit
  // a marker file in this scenario.
  const sub = join(tmp, "no-claude-md");
  mkdirSync(sub);
  // Walking up from /tmp/.../no-claude-md would eventually hit / — and on a
  // dev machine the user's home CLAUDE.md might match. We can't assume null,
  // so the safest assertion is: when starting from tmp itself (which has no
  // CLAUDE.md), the function either returns null OR returns a path
  // outside tmp. Both are acceptable; only "returned tmp itself" would be wrong.
  const result = findProjectRoot(sub);
  assert.ok(result === null || !result.startsWith(tmp), `should not match inside tmp; got ${result}`);
});

test("findProjectRoot: ignores CLAUDE.md WITHOUT the orchestrator marker", () => {
  // Plain CLAUDE.md doesn't make a project the orchestrator's home.
  writeFileSync(join(tmp, "CLAUDE.md"), `# this project has no forge block\n`);
  const sub = join(tmp, "sub");
  mkdirSync(sub);
  const result = findProjectRoot(sub);
  // Same caveat as above — might match a parent CLAUDE.md. But it must NOT
  // return tmp itself, because tmp's CLAUDE.md lacks the marker.
  assert.ok(result !== tmp, `should not return tmp (no marker in its CLAUDE.md); got ${result}`);
});

// ----- extractNameFromArgs / stripNameFromArgs -----

test("extractNameFromArgs: returns undefined when -n / --name not present", () => {
  assert.equal(extractNameFromArgs([]), undefined);
  assert.equal(extractNameFromArgs(["--continue", "--model", "sonnet"]), undefined);
});

test("extractNameFromArgs: extracts value from `-n foo` (two tokens)", () => {
  assert.equal(extractNameFromArgs(["-n", "myname"]), "myname");
  assert.equal(extractNameFromArgs(["--continue", "-n", "myname", "--model", "sonnet"]), "myname");
});

test("extractNameFromArgs: extracts value from `--name foo` (two tokens)", () => {
  assert.equal(extractNameFromArgs(["--name", "myname"]), "myname");
});

test("extractNameFromArgs: extracts value from `--name=foo` (one token)", () => {
  assert.equal(extractNameFromArgs(["--name=myname", "--continue"]), "myname");
});

test("stripNameFromArgs: removes -n and its value, leaves the rest", () => {
  assert.deepEqual(
    stripNameFromArgs(["--continue", "-n", "foo", "--model", "sonnet"]),
    ["--continue", "--model", "sonnet"],
  );
});

test("stripNameFromArgs: removes --name and its value", () => {
  assert.deepEqual(
    stripNameFromArgs(["--name", "foo", "--continue"]),
    ["--continue"],
  );
});

test("stripNameFromArgs: removes --name=foo (single-token form)", () => {
  assert.deepEqual(
    stripNameFromArgs(["--name=foo", "--continue", "--model=sonnet"]),
    ["--continue", "--model=sonnet"],
  );
});

test("stripNameFromArgs: returns input unchanged when no -n / --name", () => {
  const input = ["--continue", "--model", "sonnet"];
  assert.deepEqual(stripNameFromArgs(input), input);
});

test("strip + extract together: user override survives through the pipeline", () => {
  // The action's flow: extract user name (use it), then strip from args, then
  // re-insert our own. The result should preserve the user's name AND have it
  // appear exactly once.
  const args = ["--continue", "-n", "user-chose-this", "--model", "sonnet"];
  const userName = extractNameFromArgs(args);
  const stripped = stripNameFromArgs(args);
  const final = ["-n", userName ?? "fallback", ...stripped];
  assert.equal(userName, "user-chose-this");
  assert.deepEqual(final, ["-n", "user-chose-this", "--continue", "--model", "sonnet"]);
  // -n appears exactly once.
  assert.equal(final.filter((a) => a === "-n" || a === "--name").length, 1);
});

// ----- extractBedrockFromArgs -----

test("extractBedrockFromArgs: returns false when --bedrock not present", () => {
  assert.equal(extractBedrockFromArgs([]), false);
  assert.equal(extractBedrockFromArgs(["--continue", "--model", "sonnet"]), false);
});

test("extractBedrockFromArgs: returns true when --bedrock is present", () => {
  assert.equal(extractBedrockFromArgs(["--bedrock"]), true);
  assert.equal(extractBedrockFromArgs(["--continue", "--bedrock", "--model", "sonnet"]), true);
});

// ----- extractAwsProfileFromArgs -----

test("extractAwsProfileFromArgs: returns undefined when not present", () => {
  assert.equal(extractAwsProfileFromArgs([]), undefined);
  assert.equal(extractAwsProfileFromArgs(["--bedrock", "--continue"]), undefined);
});

test("extractAwsProfileFromArgs: extracts value from two-token form", () => {
  assert.equal(extractAwsProfileFromArgs(["--aws-profile", "my-profile"]), "my-profile");
  assert.equal(
    extractAwsProfileFromArgs(["--bedrock", "--aws-profile", "adx-dev", "--continue"]),
    "adx-dev",
  );
});

test("extractAwsProfileFromArgs: extracts value from --aws-profile=<value> form", () => {
  assert.equal(extractAwsProfileFromArgs(["--aws-profile=my-profile"]), "my-profile");
  assert.equal(extractAwsProfileFromArgs(["--bedrock", "--aws-profile=adx-dev"]), "adx-dev");
});

// ----- stripBedrockFlagsFromArgs -----

test("stripBedrockFlagsFromArgs: returns input unchanged when no bedrock flags", () => {
  const input = ["--continue", "--model", "sonnet"];
  assert.deepEqual(stripBedrockFlagsFromArgs(input), input);
});

test("stripBedrockFlagsFromArgs: removes --bedrock", () => {
  assert.deepEqual(
    stripBedrockFlagsFromArgs(["--bedrock", "--continue"]),
    ["--continue"],
  );
  assert.deepEqual(
    stripBedrockFlagsFromArgs(["--continue", "--bedrock", "--model", "sonnet"]),
    ["--continue", "--model", "sonnet"],
  );
});

test("stripBedrockFlagsFromArgs: removes --aws-profile and its value (two-token form)", () => {
  assert.deepEqual(
    stripBedrockFlagsFromArgs(["--aws-profile", "adx-dev", "--continue"]),
    ["--continue"],
  );
});

test("stripBedrockFlagsFromArgs: removes --aws-profile=value (one-token form)", () => {
  assert.deepEqual(
    stripBedrockFlagsFromArgs(["--aws-profile=adx-dev", "--continue"]),
    ["--continue"],
  );
});

test("stripBedrockFlagsFromArgs: removes both --bedrock and --aws-profile together", () => {
  assert.deepEqual(
    stripBedrockFlagsFromArgs(["--bedrock", "--aws-profile", "adx-dev", "--continue"]),
    ["--continue"],
  );
  assert.deepEqual(
    stripBedrockFlagsFromArgs(["--bedrock", "--aws-profile=adx-dev", "--model", "sonnet"]),
    ["--model", "sonnet"],
  );
});

// ----- buildClaudeChildEnv -----

test("buildClaudeChildEnv: disables background tasks for non-Bedrock sessions", () => {
  const parentEnv: NodeJS.ProcessEnv = { PATH: "/test/bin" };

  const childEnv = buildClaudeChildEnv(parentEnv);

  assert.equal(childEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(childEnv.PATH, "/test/bin");
  assert.equal(childEnv.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(childEnv.AWS_PROFILE, undefined);
  assert.deepEqual(parentEnv, { PATH: "/test/bin" });
});

test("buildClaudeChildEnv: overrides an unsafe parent value without mutating it", () => {
  const parentEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
  };

  const childEnv = buildClaudeChildEnv(parentEnv);

  assert.equal(childEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(parentEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "0");
});

test("buildClaudeChildEnv: combines the invariant with Bedrock configuration", () => {
  const parentEnv: NodeJS.ProcessEnv = {
    PATH: "/test/bin",
    AWS_PROFILE: "old-profile",
  };

  const childEnv = buildClaudeChildEnv(parentEnv, "forge-profile");

  assert.equal(childEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(childEnv.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(childEnv.AWS_PROFILE, "forge-profile");
  assert.equal(childEnv.PATH, "/test/bin");
  assert.equal(parentEnv.AWS_PROFILE, "old-profile");
  assert.equal(parentEnv.CLAUDE_CODE_USE_BEDROCK, undefined);
});
