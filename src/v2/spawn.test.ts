// Tests for runtime YAML → docker args translation.
// Uses FORGE_AWS_CREDS_FOR_TEST (creds.ts escape hatch) to avoid real STS calls.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Runtime } from "./schema.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";

const BASE_RUNTIME: Runtime = {
  name: "claude-bedrock",
  description: "test",
  image: "agent-dev-worker:latest",
  models: { default: "claude-sonnet-4-6", "spec-writer": "claude-sonnet-4-6" },
  auth: { mode: "env-snapshot" },
  env: {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "${AWS_REGION:-us-east-1}",
  },
  mounts: [
    { host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false },
    { host: "${PROJECT_DIR}", container: "/project", mode: "${PROJECT_MODE:-rw}", optional: false },
    { host: "${DESIGN_DIR}", container: "/design", mode: "ro", optional: true },
  ],
  invocation: {
    command: "claude",
    args: ["--model", "${MODEL}", "--print"],
  },
  container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
  result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
};

const BASE_CTX: SpawnContext = {
  TASK_ID: "task-x",
  TASK_DIR: "/tmp/forge/task-x",
  PROJECT_DIR: "/tmp/project",
  PROJECT_MODE: "rw",
  MODEL: "claude-sonnet-4-6",
  SYSTEM_PROMPT: "system",
  TASK_PACKAGE_MARKDOWN: "# Task task-x\n",
};

let envSnap: Record<string, string | undefined>;

beforeEach(() => {
  envSnap = {
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AWS_PROFILE: process.env.AWS_PROFILE,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    FORGE_AWS_DIR: process.env.FORGE_AWS_DIR,
    FORGE_AUTH_MODE: process.env.FORGE_AUTH_MODE,
    FORGE_AWS_CREDS_FOR_TEST: process.env.FORGE_AWS_CREDS_FOR_TEST,
  };
  for (const k of Object.keys(envSnap)) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function pickMount(args: string[], containerPath: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-v") {
      const parts = args[i + 1]!.split(":");
      if (parts.length >= 2 && parts[1] === containerPath) return args[i + 1];
    }
  }
  return undefined;
}

function pickEnv(args: string[]): Record<string, string> {
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

test("buildDockerArgs: container --name is substituted with TASK_ID", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const nameIdx = args.indexOf("--name");
  assert.ok(nameIdx >= 0);
  assert.equal(args[nameIdx + 1], "forge-task-x");
});

test("buildDockerArgs: env-snapshot auth injects STS env vars", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=AK,AWS_SECRET_ACCESS_KEY=SK,AWS_SESSION_TOKEN=TK";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const env = pickEnv(args);
  assert.equal(env.AWS_ACCESS_KEY_ID, "AK");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "SK");
  assert.equal(env.AWS_SESSION_TOKEN, "TK");

  // No legacy mount, no AWS_PROFILE
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(pickMount(args, "/home/agent/.aws"), undefined);
});

test("buildDockerArgs: FORGE_AUTH_MODE=mount forces legacy mount path", () => {
  process.env.AWS_PROFILE = "adx-dev";
  process.env.FORGE_AWS_DIR = "/Users/test/.aws";
  process.env.FORGE_AUTH_MODE = "mount";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const env = pickEnv(args);
  assert.equal(env.AWS_PROFILE, "adx-dev");
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  const awsMount = pickMount(args, "/home/agent/.aws");
  assert.ok(awsMount);
  assert.match(awsMount!, /:\/home\/agent\/\.aws:ro$/);
});

test("buildDockerArgs: substitutes $\\{AWS_REGION:-us-east-1\\} from runtime.env", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";
  // AWS_REGION unset → fallback to us-east-1.

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  assert.equal(pickEnv(args).AWS_REGION, "us-east-1");
});

test("buildDockerArgs: AWS_REGION from process.env overrides default", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";
  process.env.AWS_REGION = "ap-northeast-1";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  assert.equal(pickEnv(args).AWS_REGION, "ap-northeast-1");
});

test("buildDockerArgs: TASK_DIR mounted at /task", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const m = pickMount(args, "/task");
  assert.equal(m, "/tmp/forge/task-x:/task:rw");
});

test("buildDockerArgs: PROJECT_MODE=ro is honored for reds", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, { ...BASE_CTX, PROJECT_MODE: "ro" });
  assert.match(pickMount(args, "/project")!, /:ro$/);
});

test("buildDockerArgs: optional DESIGN_DIR mount is skipped when unset", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  assert.equal(pickMount(args, "/design"), undefined);
});

test("buildDockerArgs: claude invocation appended after image with substituted MODEL", () => {
  process.env.FORGE_AWS_CREDS_FOR_TEST = "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t";
  process.env.AWS_PROFILE = "adx-dev";

  const { args } = buildDockerArgs(BASE_RUNTIME, BASE_CTX);
  const imageIdx = args.indexOf(BASE_RUNTIME.image);
  assert.ok(imageIdx >= 0);
  // claude command comes right after the image
  assert.equal(args[imageIdx + 1], "claude");
  // ${MODEL} substitutes to the context's model id
  assert.ok(args.includes("claude-sonnet-4-6"), `MODEL should substitute; got args: ${args.join(" ")}`);
  // The raw ${MODEL} should NOT survive substitution
  assert.ok(!args.some(a => a.includes("${MODEL}")), "no unresolved template vars after build");
});

test("buildDockerArgs: apikey auth mode passes ANTHROPIC_API_KEY", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-abc";

  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  const { args } = buildDockerArgs(rt, BASE_CTX);
  assert.equal(pickEnv(args).ANTHROPIC_API_KEY, "sk-test-abc");
  // No bedrock STS vars
  assert.equal(pickEnv(args).AWS_ACCESS_KEY_ID, undefined);
});

test("buildDockerArgs: apikey auth mode throws when ANTHROPIC_API_KEY is unset", () => {
  const rt: Runtime = { ...BASE_RUNTIME, auth: { mode: "apikey" } };
  assert.throws(() => buildDockerArgs(rt, BASE_CTX), /ANTHROPIC_API_KEY/);
});
