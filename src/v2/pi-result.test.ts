import { test } from "node:test";
import assert from "node:assert/strict";
import { attributePiNoResult } from "./pi-result.js";

// Event shapes are the real ones captured from pi 0.74.2 `--mode json` runs
// (see scripts/pi-context-proof.sh / the #261 dispatch proof).

function jsonl(...events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

test("#264: a provider error is attributed from the assistant errorMessage", () => {
  const stdout = jsonl(
    { type: "session", id: "s1" },
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "task" }] } },
    { type: "agent_end", messages: [
      { role: "user", content: [] },
      { role: "assistant", stopReason: "error", errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' },
    ] },
  );
  const msg = attributePiNoResult(stdout);
  assert.match(msg, /^pi run failed:/);
  assert.match(msg, /authentication_error|invalid x-api-key/);
});

test("#264: a clean completion with no result.json blames the agent contract, not the provider", () => {
  const stdout = jsonl(
    { type: "session", id: "s2" },
    { type: "agent_start" },
    { type: "turn_end", message: { role: "assistant", stopReason: "end_turn" } },
    { type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] },
  );
  const msg = attributePiNoResult(stdout);
  assert.match(msg, /completed but wrote no .*result\.json/);
  assert.doesNotMatch(msg, /pi run failed/);
});

test("#264: no agent_end (truncated/crashed) is attributed as a missing completion event", () => {
  const stdout = jsonl(
    { type: "session", id: "s3" },
    { type: "agent_start" },
    { type: "turn_start" },
    // stream cut off here — no agent_end
  );
  const msg = attributePiNoResult(stdout);
  assert.match(msg, /no completion event \(agent_end\)/);
});

test("#264: empty stdout is attributed, never silent", () => {
  assert.match(attributePiNoResult(""), /no output/);
  assert.match(attributePiNoResult("\n  \n"), /no output/);
});

test("#264: corrupt JSONL lines are tolerated; error still surfaces", () => {
  const stdout = [
    "not json at all",
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", errorMessage: "rate_limit_exceeded" }] }),
    "}{ broken",
  ].join("\n");
  assert.match(attributePiNoResult(stdout), /pi run failed: rate_limit_exceeded/);
});

// ── #267: analyzePiFailure — provider error → modelError ─────────────────────
import { analyzePiFailure } from "./pi-result.js";

test("#267: a provider errorMessage → modelError true, cause surfaced", () => {
  const stdout = jsonl(
    { type: "agent_end", messages: [
      { role: "assistant", stopReason: "error", errorMessage: '400 {"error":{"message":"out of extra usage"}}' },
    ] },
  );
  const a = analyzePiFailure(stdout);
  assert.equal(a.modelError, true);
  assert.match(a.error, /^pi run failed:/);
  assert.match(a.error, /out of extra usage/);
});

test("#267: auto_retry_* events → modelError true even without a final errorMessage", () => {
  const stdout = jsonl({ type: "agent_start" }, { type: "auto_retry_attempt", attempt: 1 });
  assert.equal(analyzePiFailure(stdout).modelError, true);
});

test("#267: contract failure (clean completion, no result) is NOT a model error", () => {
  const stdout = jsonl({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] });
  const a = analyzePiFailure(stdout);
  assert.equal(a.modelError, false);
  assert.match(a.error, /wrote no .*result\.json/);
});

test("#267: truncated output (no agent_end) is NOT a model error", () => {
  assert.equal(analyzePiFailure(jsonl({ type: "agent_start" })).modelError, false);
  assert.equal(analyzePiFailure("").modelError, false);
});
