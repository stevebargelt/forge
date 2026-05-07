import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIdleWatchdog, _buildDockerArgs, _readResultJson } from "./spawn.js";

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
  taskDir: "/tmp/x",
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
    PENCIL_CLI_KEY: process.env.PENCIL_CLI_KEY,
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

test("buildDockerArgs: task dir is mounted as a writable directory at /task", () => {
  const args = _buildDockerArgs(ARGS_INPUT_BASE);
  const taskMount = pickMount(args, "/task");
  assert.ok(taskMount, "should mount /task");
  assert.equal(taskMount, "/tmp/x:/task", "should be a directory mount, no :ro flag");
});

test("buildDockerArgs: designer image forwards PENCIL_CLI_KEY when set", () => {
  process.env.PENCIL_CLI_KEY = "pk-test-abc";
  const args = _buildDockerArgs({ ...ARGS_INPUT_BASE, image: "agent-designer-worker" });
  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.PENCIL_CLI_KEY, "pk-test-abc");
});

test("buildDockerArgs: designer image without PENCIL_CLI_KEY does not pass an empty value", () => {
  // No PENCIL_CLI_KEY set — must not surface as -e PENCIL_CLI_KEY=
  const args = _buildDockerArgs({ ...ARGS_INPUT_BASE, image: "agent-designer-worker" });
  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.PENCIL_CLI_KEY, undefined);
});

test("buildDockerArgs: designer image attaches --mcp-config for the Pencil MCP server", () => {
  const args = _buildDockerArgs({ ...ARGS_INPUT_BASE, image: "agent-designer-worker" });
  // --mcp-config <path> appears as two consecutive argv entries somewhere in the tail.
  const idx = args.indexOf("--mcp-config");
  assert.ok(idx >= 0, "should include --mcp-config when image is agent-designer-worker");
  assert.equal(args[idx + 1], "/etc/forge/designer-mcp.json");
});

test("buildDockerArgs: non-designer image does not attach --mcp-config", () => {
  const args = _buildDockerArgs(ARGS_INPUT_BASE);
  assert.equal(args.indexOf("--mcp-config"), -1, "no MCP config for default image");
});

test("buildDockerArgs: non-designer image never forwards PENCIL_CLI_KEY", () => {
  process.env.PENCIL_CLI_KEY = "pk-leak";
  const args = _buildDockerArgs(ARGS_INPUT_BASE); // image: agent-dev-worker
  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.PENCIL_CLI_KEY, undefined);
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

// ---------- readResultJson: envelope parsing + contract enforcement ----------

let tmpResultDir: string;

beforeEach(() => {
  tmpResultDir = join(tmpdir(), `forge-result-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpResultDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpResultDir, { recursive: true, force: true });
});

function writeResult(name: string, content: string): string {
  const path = join(tmpResultDir, name);
  writeFileSync(path, content);
  return path;
}

test("readResultJson: returns undefined for missing file", () => {
  assert.equal(_readResultJson(join(tmpResultDir, "no-such-file.json")), undefined);
});

test("readResultJson: returns undefined for empty file", () => {
  const p = writeResult("result.json", "");
  assert.equal(_readResultJson(p), undefined);
});

test("readResultJson: passes through valid agent JSON object directly", () => {
  const p = writeResult(
    "result.json",
    JSON.stringify({ status: "complete", findings: [{ severity: "high" }] })
  );
  const r = _readResultJson(p) as { status: string; findings: { severity: string }[] };
  assert.equal(r.status, "complete");
  assert.equal(r.findings[0]!.severity, "high");
});

test("readResultJson: unwraps claude envelope with valid inner JSON", () => {
  const inner = JSON.stringify({ status: "complete", x: 42 });
  const envelope = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: inner });
  const p = writeResult("stdout.log", envelope);
  const r = _readResultJson(p) as { status: string; x: number };
  assert.equal(r.status, "complete");
  assert.equal(r.x, 42);
});

test("readResultJson: claude envelope with prose inner returns synthetic failure preserving text", () => {
  const proseReply = "I cannot determine the scope of this task because no codebase was provided.";
  const envelope = JSON.stringify({ type: "result", is_error: false, result: proseReply });
  const p = writeResult("stdout.log", envelope);
  const r = _readResultJson(p) as { status: string; error: string; agentText: string };
  assert.equal(r.status, "failed", "should be marked failed, not silently passed");
  assert.equal(r.error, "agent_replied_text");
  assert.match(r.agentText, /cannot determine the scope/);
});

test("readResultJson: claude envelope with is_error=true surfaces as failed", () => {
  const envelope = JSON.stringify({ type: "result", is_error: true, result: "rate limit exceeded" });
  const p = writeResult("stdout.log", envelope);
  const r = _readResultJson(p) as { status: string; error: string };
  assert.equal(r.status, "failed");
  assert.equal(r.error, "rate limit exceeded");
});

test("readResultJson: extracts JSON from prose-with-json-block in envelope inner", () => {
  // claude sometimes wraps JSON in prose; the extractor pulls the last { ... } block.
  const inner = "Here's my analysis:\n\n{\"status\": \"complete\", \"x\": 1}\n";
  const envelope = JSON.stringify({ type: "result", is_error: false, result: inner });
  const p = writeResult("stdout.log", envelope);
  const r = _readResultJson(p) as { status: string; x: number };
  assert.equal(r.status, "complete");
  assert.equal(r.x, 1);
});

test("readResultJson: claude envelope with non-string inner returns synthetic failure", () => {
  const envelope = JSON.stringify({ type: "result", is_error: false /* no result field */ });
  const p = writeResult("stdout.log", envelope);
  const r = _readResultJson(p) as { status: string; error: string };
  assert.equal(r.status, "failed");
  assert.equal(r.error, "agent_envelope_missing_inner_result");
});

test("readResultJson: bare JSON without status field passes through (status check happens upstream)", () => {
  // readResultJson's job is parsing, not contract enforcement. The missing-status check
  // lives in spawn() so it can also catch bare {} written directly to result.json.
  const p = writeResult("result.json", JSON.stringify({ findings: [] }));
  const r = _readResultJson(p) as { findings: unknown[] };
  assert.deepEqual(r, { findings: [] });
});

// ---------- readResultJson: stream-json (NDJSON) shape ----------
// `claude --output-format stream-json --verbose --print` emits NDJSON: one JSON
// object per line, ending with a {type:"result", result:"..."} envelope identical
// in shape to --output-format=json. The parser must pluck that last envelope and
// unwrap the inner result string just like the single-blob case.

test("readResultJson: stream-json — picks the trailing result envelope, unwraps inner JSON", () => {
  const inner = JSON.stringify({ status: "complete", findings: [{ severity: "high" }] });
  const ndjson = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "abc", tools: ["Read"] }),
    JSON.stringify({ type: "system", subtype: "status", status: "requesting" }),
    JSON.stringify({
      type: "assistant",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "thinking..." }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: inner,
      duration_ms: 4321,
    }),
  ].join("\n");
  const p = writeResult("stdout.log", ndjson);
  const r = _readResultJson(p) as { status: string; findings: { severity: string }[] };
  assert.equal(r.status, "complete");
  assert.equal(r.findings[0]!.severity, "high");
});

test("readResultJson: stream-json — is_error=true on the trailing envelope surfaces as failed", () => {
  const ndjson = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", is_error: true, result: "rate limit exceeded" }),
  ].join("\n");
  const p = writeResult("stdout.log", ndjson);
  const r = _readResultJson(p) as { status: string; error: string };
  assert.equal(r.status, "failed");
  assert.equal(r.error, "rate limit exceeded");
});

test("readResultJson: stream-json — prose inner on result envelope is a contract violation", () => {
  const ndjson = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", is_error: false, result: "I couldn't write JSON because..." }),
  ].join("\n");
  const p = writeResult("stdout.log", ndjson);
  const r = _readResultJson(p) as { status: string; error: string; agentText: string };
  assert.equal(r.status, "failed");
  assert.equal(r.error, "agent_replied_text");
  assert.match(r.agentText, /couldn't write JSON/);
});

test("readResultJson: stream-json — extracts JSON from prose-wrapped inner result", () => {
  const inner = "Here's the answer:\n\n{\"status\": \"complete\", \"x\": 1}\n";
  const ndjson = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", is_error: false, result: inner }),
  ].join("\n");
  const p = writeResult("stdout.log", ndjson);
  const r = _readResultJson(p) as { status: string; x: number };
  assert.equal(r.status, "complete");
  assert.equal(r.x, 1);
});
