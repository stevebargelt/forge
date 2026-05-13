import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIdleWatchdog, _buildDockerArgs, _readResultJson, resolveIdleTimeoutMs } from "./spawn.js";

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
  // No env signals (no CLAUDE_CODE_USE_BEDROCK, no ANTHROPIC_API_KEY, no
  // AWS_PROFILE) AND an FORGE_AWS_DIR pointing at a path without an SSO-
  // configured [default] profile → falls through to oauth. The /dev/null
  // override is the simplest "definitely no SSO here" stub.
  process.env.FORGE_AWS_DIR = "/dev/null";

  const args = _buildDockerArgs(ARGS_INPUT_BASE);

  // Mount is at /home/agent (parent of .claude/) so claude's $HOME-level
  // .claude.json is captured alongside .claude/.credentials.json — see the
  // commit migrating the mount point.
  const claudeMount = pickMount(args, "/home/agent");
  assert.ok(claudeMount, "should mount /home/agent");
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

test("buildDockerArgs: designDir absent → no /design mount (#114)", () => {
  const args = _buildDockerArgs(ARGS_INPUT_BASE);
  assert.equal(pickMount(args, "/design"), undefined, "no design mount when designDir unset");
});

test("buildDockerArgs: designDir set → mounts /design read-only (#114)", () => {
  const args = _buildDockerArgs({ ...ARGS_INPUT_BASE, designDir: "/Users/test/widget-design" });
  const designMount = pickMount(args, "/design");
  assert.ok(designMount, "should mount /design when designDir set");
  assert.equal(
    designMount,
    "/Users/test/widget-design:/design:ro",
    "design mount must always be read-only (corpus is human-curated)"
  );
});

test("buildDockerArgs: designDir is RO even when readOnlyProject is false (#114)", () => {
  // Blue agents in feature-ui-design-* get rw on /project. /design stays ro
  // unconditionally — the design corpus is host-curated, agents never write.
  const args = _buildDockerArgs({
    ...ARGS_INPUT_BASE,
    readOnlyProject: false,
    designDir: "/Users/test/widget-design",
  });
  const designMount = pickMount(args, "/design");
  assert.match(designMount!, /:ro$/, "design mount stays ro for blue agents too");
});

test("resolveIdleTimeoutMs: explicit value wins over env and default", () => {
  const prev = process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
  process.env.FORGE_AGENT_IDLE_TIMEOUT_MS = "60000";
  try {
    assert.equal(resolveIdleTimeoutMs(12345), 12345);
  } finally {
    if (prev === undefined) delete process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
    else process.env.FORGE_AGENT_IDLE_TIMEOUT_MS = prev;
  }
});

test("resolveIdleTimeoutMs: env override applies when no explicit value", () => {
  const prev = process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
  process.env.FORGE_AGENT_IDLE_TIMEOUT_MS = "30000";
  try {
    assert.equal(resolveIdleTimeoutMs(undefined), 30000);
  } finally {
    if (prev === undefined) delete process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
    else process.env.FORGE_AGENT_IDLE_TIMEOUT_MS = prev;
  }
});

test("resolveIdleTimeoutMs: default when nothing set", () => {
  const prev = process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
  delete process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
  try {
    assert.equal(resolveIdleTimeoutMs(undefined), 5 * 60 * 1000);
  } finally {
    if (prev === undefined) delete process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
    else process.env.FORGE_AGENT_IDLE_TIMEOUT_MS = prev;
  }
});

test("buildDockerArgs: --include-partial-messages is passed to claude", () => {
  const args = _buildDockerArgs(ARGS_INPUT_BASE);
  assert.ok(args.includes("--include-partial-messages"), "claude argv should include --include-partial-messages so stdout flows during long thinking turns");
});

test("buildDockerArgs: bedrock without AWS_REGION falls back to us-east-1", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "adx-dev";
  // No AWS_REGION set — resolveAwsRegion() supplies the default so the
  // container always has a region to call against (matches use-bedrock.sh).
  process.env.FORGE_AWS_DIR = "/tmp/.aws";

  const args = _buildDockerArgs(ARGS_INPUT_BASE);
  const envPairs = pickEnvPairs(args);
  assert.equal(envPairs.AWS_PROFILE, "adx-dev");
  assert.equal(envPairs.AWS_REGION, "us-east-1", "AWS_REGION defaults to us-east-1 when not in env");
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
