import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { startIdleWatchdog, _buildDockerArgs } from "./spawn.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("idle watchdog: fires when stream stays silent", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 30, () => {
    fired++;
  });
  await delay(80);
  assert.equal(fired, 1, "should have fired once");
});

test("idle watchdog: does not fire while data keeps arriving", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 50, () => {
    fired++;
  });
  // Push every 20ms — gap stays under 50ms.
  for (let i = 0; i < 5; i++) {
    stream.push(Buffer.from(`chunk-${i}`));
    await delay(20);
  }
  assert.equal(fired, 0, "should not have fired while data was arriving");
});

test("idle watchdog: fires after stream goes silent following activity", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 30, () => {
    fired++;
  });
  stream.push(Buffer.from("hello"));
  await delay(10);
  stream.push(Buffer.from("world"));
  // Now silent — should fire after another ~30ms.
  await delay(80);
  assert.equal(fired, 1, "should fire once after silence resumes");
});

test("idle watchdog: stop() prevents firing", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  const w = startIdleWatchdog(stream, 30, () => {
    fired++;
  });
  w.stop();
  await delay(80);
  assert.equal(fired, 0, "should not fire after stop()");
});

test("idle watchdog: only fires once even on long silence", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 20, () => {
    fired++;
  });
  await delay(120);
  assert.equal(fired, 1, "should fire exactly once");
});

// ---------- buildDockerArgs: credential mode wiring ----------

const ARGS_INPUT_BASE = {
  claudeMdPath: "/tmp/x/CLAUDE.md",
  packagePath: "/tmp/x/package.md",
  resultPath: "/tmp/x/result.json",
  projectDir: "/tmp/project",
  readOnlyProject: false,
  image: "agent-dev-worker",
  litellmUrl: "http://host.docker.internal:4000",
  model: "claude-sonnet-4-6",
  systemPrompt: "test prompt",
  containerName: "forge-task-x",
};

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AWS_PROFILE: process.env.AWS_PROFILE,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    FORGE_AWS_DIR: process.env.FORGE_AWS_DIR,
    FORGE_USE_LITELLM: process.env.FORGE_USE_LITELLM,
  };
  // Wipe so each test sets only what it needs.
  for (const k of Object.keys(envSnapshot)) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("buildDockerArgs: bedrock mode mounts ~/.aws RO and passes AWS_PROFILE", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  process.env.AWS_REGION = "us-east-1";
  process.env.FORGE_AWS_DIR = "/Users/test/.aws"; // override so the test isn't host-specific

  const args = _buildDockerArgs(ARGS_INPUT_BASE);

  // Must set bedrock flag and the profile
  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(envPairs.AWS_PROFILE, "adx-dev");
  assert.equal(envPairs.AWS_REGION, "us-east-1");

  // Must NOT pass STS env vars — they would go stale
  assert.equal(envPairs.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(envPairs.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(envPairs.AWS_SESSION_TOKEN, undefined);

  // Must mount ~/.aws RO
  const awsMount = pickMount(args, "/home/agent/.aws");
  assert.ok(awsMount, "should mount /home/agent/.aws");
  assert.match(awsMount, /:\/home\/agent\/\.aws:ro$/);
  assert.match(awsMount, /^\/Users\/test\/\.aws:/);
});

test("buildDockerArgs: anthropic-apikey mode passes the key, no AWS mount", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-123";

  const args = _buildDockerArgs(ARGS_INPUT_BASE);

  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.ANTHROPIC_API_KEY, "sk-test-123");
  assert.equal(envPairs.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(pickMount(args, "/home/agent/.aws"), undefined);
});

test("buildDockerArgs: anthropic-oauth mode mounts the OAuth volume, no AWS env", () => {
  // No CLAUDE_CODE_USE_BEDROCK, no ANTHROPIC_API_KEY → falls through to oauth.
  const args = _buildDockerArgs(ARGS_INPUT_BASE);

  const claudeMount = pickMount(args, "/home/agent/.claude");
  assert.ok(claudeMount, "should mount /home/agent/.claude");
  // No AWS state in this mode
  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.AWS_PROFILE, undefined);
  assert.equal(envPairs.CLAUDE_CODE_USE_BEDROCK, undefined);
});

test("buildDockerArgs: bedrock without AWS_REGION still sets profile", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  // No AWS_REGION set
  process.env.FORGE_AWS_DIR = "/tmp/.aws";

  const args = _buildDockerArgs(ARGS_INPUT_BASE);
  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.AWS_PROFILE, "adx-dev");
  assert.equal(envPairs.AWS_REGION, undefined, "AWS_REGION omitted when not in env");
});

// Helpers

function pickEnvPairs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") {
      const pair = args[i + 1]!;
      const eq = pair.indexOf("=");
      if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}

function pickMount(args: string[], containerPath: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-v") {
      const spec = args[i + 1]!;
      // Format: <host>:<container>[:flags]
      const parts = spec.split(":");
      if (parts.length >= 2 && parts[1] === containerPath) return spec;
    }
  }
  return undefined;
}
