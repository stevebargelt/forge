import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPlanUsage,
  getPlanUsage,
  queryCodexAppServerRateLimits,
  resetPlanUsageCacheForTests,
} from "./plan-usage.js";

const NOW = Date.parse("2026-07-15T19:00:00.000Z");

function service(result: Awaited<ReturnType<typeof collectPlanUsage>>, id: string) {
  const found = result.services.find((candidate) => candidate.id === id);
  assert.ok(found, `expected service ${id}`);
  return found;
}

test("Bedrock configuration is reported without inventing subscription limits", async () => {
  let fetched = false;
  const result = await collectPlanUsage({
    env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "work" },
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-bedrock-")),
    now: () => NOW,
    fetchImpl: async () => { fetched = true; return new Response(); },
  });

  assert.equal(fetched, false, "Bedrock mode must not call Anthropic");
  assert.deepEqual(service(result, "bedrock"), {
    id: "bedrock",
    name: "Amazon Bedrock",
    plan: "AWS usage · work",
    authMode: "bedrock",
    status: "not_configured",
    source: "environment",
    observedAt: null,
    windows: [],
    note: "Bedrock usage metrics are not configured on this host yet.",
  });
});

test("Claude OAuth maps authoritative session, weekly, and scoped windows without invented caps", async () => {
  const reset5h = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
  const reset7d = new Date(NOW + 4 * 24 * 60 * 60 * 1000).toISOString();
  const result = await collectPlanUsage({
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-claude-")),
    now: () => NOW,
    claudeVersion: "test",
    readClaudeCredential: () => ({
      accessToken: "sk-ant-oat01-test",
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    }),
    fetchImpl: async (_input, init) => {
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer sk-ant-oat01-test");
      return new Response(JSON.stringify({
        limits: [
          { kind: "session", percent: 25, resets_at: reset5h },
          { kind: "weekly_all", percent: 40, resets_at: reset7d },
          { kind: "weekly_scoped", percent: 46, resets_at: reset7d, scope: { model: { display_name: "Fable" } } },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const claude = service(result, "claude-subscription");
  assert.equal(claude.status, "live");
  assert.equal(claude.plan, "Claude Max (20x)");
  assert.equal(claude.source, "anthropic-oauth-api");
  assert.deepEqual(claude.windows.map((window) => [window.label, window.usedPct]), [
    ["5-hour limit", 25],
    ["Weekly · all models", 40],
    ["Weekly · Fable", 46],
  ]);
  assert.equal(claude.windows[0]!.resetsAt, reset5h);
  assert.equal(claude.windows[0]!.pacePct, 42);
});

test("Claude provider failures are surfaced without local quota estimates", async () => {
  const result = await collectPlanUsage({
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-claude-error-")),
    now: () => NOW,
    claudeVersion: "test",
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test", subscriptionType: "pro" }),
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  });

  const claude = service(result, "claude-subscription");
  assert.equal(claude.status, "error");
  assert.equal(claude.windows.length, 0);
  assert.match(claude.note ?? "", /expired or revoked/);
});

test("Codex uses a local rollout only as a stale fallback when the live query is unavailable", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-"));
  const codexDir = join(home, ".codex");
  const sessions = join(codexDir, "sessions", "2026", "07", "15");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ tokens: { access_token: "invalid.jwt.value" } }));
  writeFileSync(join(sessions, "rollout-test.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-15T18:55:00.000Z", payload: { unrelated: true } }),
    JSON.stringify({
      timestamp: "2026-07-15T18:55:00.000Z",
      payload: {
        rate_limits: {
          plan_type: "pro",
          primary: { used_percent: 12, window_minutes: 300, resets_at: (NOW + 2 * 60 * 60 * 1000) / 1000 },
          secondary: { used_percent: 21, window_minutes: 10080, resets_at: (NOW + 4 * 24 * 60 * 60 * 1000) / 1000 },
        },
      },
    }),
  ].join("\n"));

  const result = await collectPlanUsage({
    env: {},
    homeDir: home,
    now: () => NOW,
    readClaudeCredential: () => null,
  });
  const codex = service(result, "codex-subscription");
  assert.equal(codex.status, "stale");
  assert.equal(codex.plan, "ChatGPT Pro (20×)");
  assert.equal(codex.source, "codex-rollout");
  assert.deepEqual(codex.windows.map((window) => [window.label, window.usedPct]), [["5h", 12], ["Weekly", 21]]);
  assert.equal(codex.observedAt, "2026-07-15T18:55:00.000Z");
});

test("an old Codex observation remains visible but is marked stale", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-stale-"));
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-old.jsonl"), JSON.stringify({
    timestamp: "2026-07-15T16:00:00.000Z",
    payload: { rate_limits: { plan_type: "plus", primary: { used_percent: 30, window_minutes: 300 } } },
  }));

  const result = await collectPlanUsage({ env: {}, homeDir: home, now: () => NOW, readClaudeCredential: () => null });
  const codex = service(result, "codex-subscription");
  assert.equal(codex.status, "stale");
  assert.equal(codex.windows[0]!.usedPct, 30);
  assert.match(codex.note ?? "", /may have changed/);
});

test("Claude preserves official Max plan names and treats percent fields as percentages", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-claude-labels-"));
  const fetchImpl = async () => new Response(JSON.stringify({
    limits: [{ kind: "session", percent: 1, resets_at: "not-a-date" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  const max20 = await collectPlanUsage({
    env: {}, homeDir: home, now: () => NOW, claudeVersion: "test", fetchImpl,
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test", subscriptionType: "max20" }),
  });
  const max5 = await collectPlanUsage({
    env: {}, homeDir: home, now: () => NOW, claudeVersion: "test", fetchImpl,
    readClaudeCredential: () => ({
      accessToken: "sk-ant-oat01-test",
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
    }),
  });
  const ambiguousMax = await collectPlanUsage({
    env: {}, homeDir: home, now: () => NOW, claudeVersion: "test", fetchImpl,
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test", subscriptionType: "max" }),
  });

  assert.equal(service(max20, "claude-subscription").plan, "Claude Max (20x)");
  assert.equal(service(max5, "claude-subscription").plan, "Claude Max (5x)");
  assert.equal(service(ambiguousMax, "claude-subscription").plan, "Claude Max");
  assert.equal(service(max20, "claude-subscription").windows[0]!.usedPct, 1);
  assert.equal(service(max20, "claude-subscription").windows[0]!.resetsAt, null);
});

test("Claude HTTP 200 without a usable window is unavailable rather than live", async () => {
  const result = await collectPlanUsage({
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-claude-empty-")),
    now: () => NOW,
    claudeVersion: "test",
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test", subscriptionType: "pro" }),
    fetchImpl: async () => new Response(JSON.stringify({ limits: [] }), { status: 200 }),
  });

  const claude = service(result, "claude-subscription");
  assert.equal(claude.status, "unavailable");
  assert.equal(claude.windows.length, 0);
  assert.equal(claude.source, "anthropic-oauth-api");
});

test("Claude network errors do not return raw thrown messages", async () => {
  const result = await collectPlanUsage({
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-claude-sanitize-")),
    now: () => NOW,
    claudeVersion: "test",
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test" }),
    fetchImpl: async () => { throw new Error("sensitive-provider-detail"); },
  });

  const claude = service(result, "claude-subscription");
  assert.equal(claude.status, "error");
  assert.doesNotMatch(claude.note ?? "", /sensitive-provider-detail/);
});

test("Claude timeouts are reported as unavailable usage rather than zero usage", async () => {
  const timeout = new Error("request token and provider detail");
  timeout.name = "TimeoutError";
  const result = await collectPlanUsage({
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-claude-timeout-")),
    now: () => NOW,
    claudeVersion: "test",
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test" }),
    fetchImpl: async () => { throw timeout; },
  });

  const claude = service(result, "claude-subscription");
  assert.equal(claude.status, "error");
  assert.deepEqual(claude.windows, []);
  assert.equal(claude.note, "The Anthropic usage request timed out.");
  assert.doesNotMatch(claude.note, /provider detail/);
});

test("malformed cached credentials fail closed and do not call providers", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-malformed-auth-"));
  const claudeDir = join(home, ".claude");
  const codexDir = join(home, ".codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(claudeDir, ".credentials.json"), "{partial");
  writeFileSync(join(codexDir, "auth.json"), "{partial");
  let fetched = false;

  const result = await collectPlanUsage({
    env: {},
    homeDir: home,
    now: () => NOW,
    fetchImpl: async () => { fetched = true; return new Response(); },
    codexAppServerQuery: async () => null,
  });
  assert.equal(fetched, false);
  assert.deepEqual(result.services, []);
});

test("Codex subscription observations and OpenAI API configuration coexist", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-api-key-"));
  const codexDir = join(home, ".codex");
  const sessions = join(codexDir, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-only" }));
  writeFileSync(join(sessions, "rollout-old-subscription.jsonl"), JSON.stringify({
    timestamp: new Date(NOW).toISOString(),
    payload: { rate_limits: { plan_type: "plus", primary: { used_percent: 44, window_minutes: 300 } } },
  }));

  const result = await collectPlanUsage({ env: {}, homeDir: home, now: () => NOW, readClaudeCredential: () => null });
  const codex = service(result, "codex-subscription");
  const api = service(result, "openai-api");
  assert.equal(codex.status, "stale");
  assert.equal(codex.windows[0]!.usedPct, 44);
  assert.equal(api.authMode, "api_key");
  assert.equal(api.status, "not_applicable");
  assert.equal(api.windows.length, 0);
  assert.match(api.note ?? "", /API-key billing/);
});

test("OPENAI_API_KEY reports an API channel without inventing a subscription", async () => {
  const result = await collectPlanUsage({
    env: { OPENAI_API_KEY: "test-only" },
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-codex-env-api-key-")),
    now: () => NOW,
    readClaudeCredential: () => null,
  });

  const api = service(result, "openai-api");
  assert.equal(api.authMode, "api_key");
  assert.equal(api.status, "not_applicable");
  assert.equal(api.windows.length, 0);
  assert.equal(result.services.some((candidate) => candidate.id === "codex-subscription"), false);
});

test("Codex relative reset timing is anchored to the rollout observation", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-relative-reset-"));
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  const observedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  writeFileSync(join(sessions, "rollout-relative.jsonl"), JSON.stringify({
    timestamp: observedAt,
    payload: {
      rate_limits: {
        plan_type: "plus",
        primary: { used_percent: 22, window_minutes: 300, resets_in_seconds: 3600 },
      },
    },
  }));

  const result = await collectPlanUsage({ env: {}, homeDir: home, now: () => NOW, readClaudeCredential: () => null });
  const codex = service(result, "codex-subscription");
  assert.equal(codex.status, "stale");
  assert.equal(codex.windows[0]!.resetsAt, new Date(Date.parse(observedAt) + 3600_000).toISOString());
});

test("malformed Codex window fields cannot crash or create a live empty observation", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-malformed-window-"));
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-malformed.jsonl"), JSON.stringify({
    timestamp: new Date(NOW).toISOString(),
    payload: {
      rate_limits: {
        plan_type: "plus",
        primary: { used_percent: 120, window_minutes: 300, resets_at: "bad" },
        secondary: { used_percent: 20, window_minutes: 0 },
      },
    },
  }));

  const result = await collectPlanUsage({ env: {}, homeDir: home, now: () => NOW, readClaudeCredential: () => null });
  const codex = service(result, "codex-subscription");
  assert.equal(codex.status, "unavailable");
  assert.equal(codex.windows.length, 0);
  assert.equal(codex.source, "codex-rollout");
});

test("all configured subscription, API, and Bedrock channels coexist on one host", async () => {
  let fetched = false;
  const home = mkdtempSync(join(tmpdir(), "forge-plan-all-channels-"));
  const codexDir = join(home, ".codex");
  const sessions = join(codexDir, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(codexDir, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: "test-only",
    tokens: { access_token: "invalid.jwt.value" },
  }));
  writeFileSync(join(sessions, "rollout-all-channels.jsonl"), JSON.stringify({
    timestamp: new Date(NOW).toISOString(),
    payload: { rate_limits: { plan_type: "pro", primary: { used_percent: 31, window_minutes: 300 } } },
  }));
  const result = await collectPlanUsage({
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "work",
      ANTHROPIC_API_KEY: "test-only",
      OPENAI_API_KEY: "test-only",
    },
    homeDir: home,
    now: () => NOW,
    claudeVersion: "test",
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test", subscriptionType: "max20" }),
    fetchImpl: async () => {
      fetched = true;
      return new Response(JSON.stringify({
        limits: [{ kind: "session", percent: 18, resets_at: new Date(NOW + 3600_000).toISOString() }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(fetched, true, "coexisting Bedrock/API configuration must not suppress OAuth usage collection");
  assert.deepEqual(result.services.map((candidate) => candidate.id), [
    "claude-subscription",
    "anthropic-api",
    "bedrock",
    "codex-subscription",
    "openai-api",
  ]);
  assert.equal(service(result, "claude-subscription").status, "live");
  assert.equal(service(result, "anthropic-api").status, "not_applicable");
  assert.equal(service(result, "bedrock").plan, "AWS usage · work");
  assert.equal(service(result, "codex-subscription").windows[0]!.usedPct, 31);
  assert.equal(service(result, "openai-api").status, "not_applicable");
});

test("channels without configuration or observations are omitted", async () => {
  const result = await collectPlanUsage({
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-no-channels-")),
    now: () => NOW,
    readClaudeCredential: () => null,
  });

  assert.deepEqual(result.services, []);
});

test("Codex App Server limits replace JSONL observations as the live source", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-live-"));
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-stale.jsonl"), JSON.stringify({
    timestamp: "2026-07-14T19:00:00.000Z",
    payload: { rate_limits: { plan_type: "plus", primary: { used_percent: 99, window_minutes: 300 } } },
  }));

  const result = await collectPlanUsage({
    env: {},
    homeDir: home,
    now: () => NOW,
    readClaudeCredential: () => null,
    codexAppServerQuery: async () => ({
      planType: "pro",
      primary: { used_percent: 17, window_minutes: 300, resets_at: (NOW + 3600_000) / 1000 },
      secondary: { used_percent: 23, window_minutes: 10080, resets_at: (NOW + 86_400_000) / 1000 },
      observedAt: new Date(NOW).toISOString(),
      source: "codex-app-server",
    }),
  });

  const codex = service(result, "codex-subscription");
  assert.equal(codex.status, "live");
  assert.equal(codex.source, "codex-app-server");
  assert.equal(codex.plan, "ChatGPT Pro (20×)");
  assert.deepEqual(codex.windows.map((window) => window.usedPct), [17, 23]);
  assert.equal(codex.note, null);
});

test("Codex App Server stdio transport performs initialization and maps the installed schema", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "forge-plan-app-server-fixture-"));
  const fixture = join(fixtureDir, "fake-codex");
  writeFileSync(fixture, `#!${process.execPath}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { serverInfo: { name: "fixture" } } }) + "\\n");
    }
    if (message.method === "account/rateLimits/read") {
      const leaked = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.AWS_SECRET_ACCESS_KEY;
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        rateLimits: { planType: "plus", primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: ${Math.floor((NOW + 3600_000) / 1000)} }, secondary: null },
        rateLimitsByLimitId: { codex: { limitId: "codex", planType: "prolite", primary: { usedPercent: leaked ? 99 : 13, windowDurationMins: 300, resetsAt: ${Math.floor((NOW + 7200_000) / 1000)} }, secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: ${Math.floor((NOW + 86_400_000) / 1000)} } } }
      } }) + "\\n");
    }
  }
});
`);
  chmodSync(fixture, 0o700);

  const limits = await queryCodexAppServerRateLimits(
    join(fixtureDir, "codex-home"),
    {
      FORGE_CODEX_BIN: fixture,
      ANTHROPIC_API_KEY: "must-not-reach-child",
      OPENAI_API_KEY: "must-not-reach-child",
      AWS_SECRET_ACCESS_KEY: "must-not-reach-child",
    },
    () => NOW,
    3_000,
  );

  assert.ok(limits);
  assert.equal(limits.source, "codex-app-server");
  assert.equal(limits.planType, "prolite");
  assert.equal(limits.primary?.used_percent, 13);
  assert.equal(limits.primary?.window_minutes, 300);
  assert.equal(limits.secondary?.used_percent, 21);
  assert.equal(limits.observedAt, new Date(NOW).toISOString());
});

test("Codex App Server timeout fails closed without exposing child-process output", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "forge-plan-app-server-timeout-"));
  const fixture = join(fixtureDir, "hanging-codex");
  writeFileSync(fixture, `#!${process.execPath}\nprocess.stderr.write("sensitive-child-detail");\nsetInterval(() => {}, 1000);\n`);
  chmodSync(fixture, 0o700);

  const started = Date.now();
  const limits = await queryCodexAppServerRateLimits(
    join(fixtureDir, "codex-home"),
    { FORGE_CODEX_BIN: fixture },
    () => NOW,
    60,
  );
  assert.equal(limits, null);
  assert.ok(Date.now() - started < 1_000);
});

test("a malformed live Codex window is unavailable and never replaced with a fabricated successful value", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-live-malformed-"));
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-older.jsonl"), JSON.stringify({
    timestamp: new Date(NOW - 60_000).toISOString(),
    payload: { rate_limits: { plan_type: "plus", primary: { used_percent: 77, window_minutes: 300 } } },
  }));

  const result = await collectPlanUsage({
    env: {},
    homeDir: home,
    now: () => NOW,
    readClaudeCredential: () => null,
    codexAppServerQuery: async () => ({
      planType: "plus",
      primary: { used_percent: 120, window_minutes: 0 },
      secondary: null,
      observedAt: new Date(NOW).toISOString(),
      source: "codex-app-server",
    }),
  });

  const codex = service(result, "codex-subscription");
  assert.equal(codex.status, "unavailable");
  assert.equal(codex.source, "codex-app-server");
  assert.deepEqual(codex.windows, []);
});

test("malformed and partial rollout lines are skipped while finding the previous valid observation", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-plan-codex-partial-"));
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-partial.jsonl"), [
    JSON.stringify({
      timestamp: new Date(NOW - 60_000).toISOString(),
      payload: { rate_limits: { plan_type: "plus", primary: { used_percent: 33, window_minutes: 300 } } },
    }),
    "{\"payload\":{\"rate_limits\":",
  ].join("\n"));

  const result = await collectPlanUsage({
    env: {},
    homeDir: home,
    now: () => NOW,
    readClaudeCredential: () => null,
    codexAppServerQuery: async () => null,
  });
  const codex = service(result, "codex-subscription");
  assert.equal(codex.status, "stale");
  assert.equal(codex.windows[0]?.usedPct, 33);
});

test("concurrent forced refreshes coalesce into one provider collection", async () => {
  resetPlanUsageCacheForTests();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const options = {
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-coalesce-")),
    now: () => NOW,
    readClaudeCredential: () => null,
    codexAppServerQuery: async () => {
      calls++;
      await gate;
      return null;
    },
  };

  const first = getPlanUsage(true, options);
  const second = getPlanUsage(true, options);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  resetPlanUsageCacheForTests();
});
