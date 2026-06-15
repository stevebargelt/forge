// FG-318 integration tests — proxy mode for non-compliant agents.
//
// These cover:
//  1. compression_mode: proxy → docker env vars set (FORGE_HEADROOM_PROXY + base URLs)
//  2. Agent API calls route through proxy (base URL is the sidecar address)
//  3. compression_mode: none → no proxy env vars
//  4. compression_mode: mcp (default) → no proxy env vars
//  5. claude-with-proxy.example.yml seed parses + has correct compression_mode
//  6. PROXY_PORT constant matches the port in agent-entrypoint.sh

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Runtime } from "./schema.js";
import { RuntimeSchema } from "./schema.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";
import { PROXY_PORT, PROXY_BASE_URL } from "./compression-modes.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");

// ── helpers ──────────────────────────────────────────────────────────────────

const BASE_RUNTIME: Runtime = {
  name: "test-runtime",
  description: "FG-318 test fixture",
  compression_mode: "mcp",
  image: "agent-dev-worker:latest",
  models: { default: "claude-sonnet-4-6" },
  auth: { mode: "apikey" },
  env: {},
  mounts: [
    { host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false },
    { host: "${PROJECT_DIR}", container: "/project", mode: "rw", optional: false },
  ],
  invocation: { command: "claude", args: ["--model", "${MODEL}", "--print"] },
  container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
  result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
};

const BASE_CTX: SpawnContext = {
  TASK_ID: "task-proxy-test",
  TASK_DIR: "/tmp/forge/task-proxy-test",
  PROJECT_DIR: "/tmp/project",
  PROJECT_MODE: "rw",
  MODEL: "claude-sonnet-4-6",
  SYSTEM_PROMPT: "system",
  TASK_PACKAGE_MARKDOWN: "# Task\n",
};

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

let savedApiKey: string | undefined;

// ── setup/teardown ────────────────────────────────────────────────────────────

import { beforeEach, afterEach } from "node:test";

beforeEach(() => {
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-fg318";
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
});

// ── 1. proxy mode spawns headroom sidecar env vars ───────────────────────────

test("FG-318: compression_mode=proxy sets FORGE_HEADROOM_PROXY=1", () => {
  const rt: Runtime = { ...BASE_RUNTIME, compression_mode: "proxy" };
  const env = pickEnv(buildDockerArgs(rt, BASE_CTX).args);
  assert.equal(env.FORGE_HEADROOM_PROXY, "1",
    "FORGE_HEADROOM_PROXY must be 1 — entrypoint uses this to start the sidecar");
});

// ── 2. proxy mode routes API calls through the sidecar ───────────────────────

test("FG-318: compression_mode=proxy sets ANTHROPIC_BASE_URL to proxy sidecar address", () => {
  const rt: Runtime = { ...BASE_RUNTIME, compression_mode: "proxy" };
  const env = pickEnv(buildDockerArgs(rt, BASE_CTX).args);
  assert.equal(env.ANTHROPIC_BASE_URL, PROXY_BASE_URL,
    "ANTHROPIC_BASE_URL must point at the in-container sidecar so all Claude calls route through it");
});

test("FG-318: compression_mode=proxy sets OPENAI_BASE_URL to proxy sidecar address", () => {
  const rt: Runtime = { ...BASE_RUNTIME, compression_mode: "proxy" };
  const env = pickEnv(buildDockerArgs(rt, BASE_CTX).args);
  assert.equal(env.OPENAI_BASE_URL, PROXY_BASE_URL,
    "OPENAI_BASE_URL must also point at the sidecar for codex-style clients");
});

test("FG-318: PROXY_BASE_URL is http://localhost:<PROXY_PORT>", () => {
  assert.equal(PROXY_BASE_URL, `http://localhost:${PROXY_PORT}`);
  assert.equal(PROXY_PORT, 8787);
});

// ── 3. none mode skips all compression ───────────────────────────────────────

test("FG-318: compression_mode=none does not set FORGE_HEADROOM_PROXY", () => {
  const rt: Runtime = { ...BASE_RUNTIME, compression_mode: "none" };
  const env = pickEnv(buildDockerArgs(rt, BASE_CTX).args);
  assert.equal(env.FORGE_HEADROOM_PROXY, undefined,
    "compression_mode=none must not start the proxy sidecar");
});

test("FG-318: compression_mode=none does not set ANTHROPIC_BASE_URL", () => {
  const rt: Runtime = { ...BASE_RUNTIME, compression_mode: "none" };
  const env = pickEnv(buildDockerArgs(rt, BASE_CTX).args);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
});

// ── 4. mcp (default) mode unchanged ──────────────────────────────────────────

test("FG-318: compression_mode=mcp (explicit) does not set proxy env vars", () => {
  const rt: Runtime = { ...BASE_RUNTIME, compression_mode: "mcp" };
  const env = pickEnv(buildDockerArgs(rt, BASE_CTX).args);
  assert.equal(env.FORGE_HEADROOM_PROXY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
});

test("FG-318: omitted compression_mode defaults to mcp — no proxy env vars", () => {
  // BASE_RUNTIME has no compression_mode set; schema default resolves to 'mcp'
  const env = pickEnv(buildDockerArgs(BASE_RUNTIME, BASE_CTX).args);
  assert.equal(env.FORGE_HEADROOM_PROXY, undefined,
    "default runtime must not start headroom proxy — agents opt in via compression_mode: proxy");
});

// ── 5. example seed parses and carries the right compression_mode ─────────────

test("FG-318: claude-with-proxy.example.yml Zod-validates as a Runtime", () => {
  const path = join(REPO_ROOT, "seeds", "runtimes", "claude-with-proxy.example.yml");
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const r = RuntimeSchema.safeParse(parsed);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error!.issues, null, 2));
});

test("FG-318: claude-with-proxy.example.yml has compression_mode: proxy", () => {
  const path = join(REPO_ROOT, "seeds", "runtimes", "claude-with-proxy.example.yml");
  const rt = RuntimeSchema.parse(parseYaml(readFileSync(path, "utf8")));
  assert.equal(rt.compression_mode, "proxy",
    "the example seed must declare proxy mode — it's the whole point of the file");
});

test("FG-318: buildDockerArgs on claude-with-proxy.example.yml injects proxy env vars", () => {
  const path = join(REPO_ROOT, "seeds", "runtimes", "claude-with-proxy.example.yml");
  const rt = RuntimeSchema.parse(parseYaml(readFileSync(path, "utf8")));
  // Override auth to oauth-volume (no API key needed) — the seed uses oauth-volume.
  // oauth-volume just adds a -v flag, no credential lookup at build time.
  const env = pickEnv(buildDockerArgs(rt, BASE_CTX).args);
  assert.equal(env.FORGE_HEADROOM_PROXY, "1");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://localhost:8787");
});

// ── 6. proxy cleanup — entrypoint EXIT trap ───────────────────────────────────
// Verify the entrypoint script contains the EXIT trap that kills the proxy.

test("FG-318: agent-entrypoint.sh starts headroom when FORGE_HEADROOM_PROXY=1", () => {
  const entrypoint = readFileSync(join(REPO_ROOT, "docker", "agent-entrypoint.sh"), "utf8");
  assert.match(entrypoint, /FORGE_HEADROOM_PROXY.*=.*1/,
    "entrypoint must guard proxy startup on FORGE_HEADROOM_PROXY=1");
  assert.match(entrypoint, /headroom proxy --port 8787/,
    "entrypoint must launch headroom on the expected port");
});

test("FG-318: agent-entrypoint.sh registers EXIT trap to kill the proxy on container exit", () => {
  const entrypoint = readFileSync(join(REPO_ROOT, "docker", "agent-entrypoint.sh"), "utf8");
  assert.match(entrypoint, /trap.*EXIT/,
    "proxy must be cleaned up via an EXIT trap so the sidecar dies with the container");
  assert.match(entrypoint, /kill.*HEADROOM_PID/,
    "EXIT trap must kill the HEADROOM_PID process");
});

test("FG-318: entrypoint port in script matches PROXY_PORT constant", () => {
  const entrypoint = readFileSync(join(REPO_ROOT, "docker", "agent-entrypoint.sh"), "utf8");
  const portMatch = entrypoint.match(/headroom proxy --port (\d+)/);
  assert.ok(portMatch, "entrypoint must contain 'headroom proxy --port <N>'");
  assert.equal(Number(portMatch![1]), PROXY_PORT,
    `entrypoint port (${portMatch![1]}) must match PROXY_PORT constant (${PROXY_PORT})`);
});
