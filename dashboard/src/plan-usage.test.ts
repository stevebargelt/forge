import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPlanUsage } from "./plan-usage.js";

const NOW = Date.parse("2026-07-15T19:00:00.000Z");

test("Bedrock mode replaces Claude subscription limits with an explicit extension state", async () => {
  let fetched = false;
  const result = await collectPlanUsage({
    env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "work" },
    homeDir: mkdtempSync(join(tmpdir(), "forge-plan-bedrock-")),
    now: () => NOW,
    fetchImpl: async () => { fetched = true; return new Response(); },
  });

  assert.equal(fetched, false, "Bedrock mode must not call Anthropic");
  assert.deepEqual(result.services[0], {
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
    readClaudeCredential: () => ({ accessToken: "sk-ant-oat01-test", subscriptionType: "max" }),
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

  const claude = result.services[0]!;
  assert.equal(claude.status, "live");
  assert.equal(claude.plan, "Claude Max");
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

  const claude = result.services[0]!;
  assert.equal(claude.status, "error");
  assert.equal(claude.windows.length, 0);
  assert.match(claude.note ?? "", /expired or revoked/);
});

test("Codex reads the latest local rollout rate-limit windows and reports freshness", async () => {
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
  const codex = result.services[1]!;
  assert.equal(codex.status, "live");
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
  const codex = result.services[1]!;
  assert.equal(codex.status, "stale");
  assert.equal(codex.windows[0]!.usedPct, 30);
  assert.match(codex.note ?? "", /may have changed/);
});
