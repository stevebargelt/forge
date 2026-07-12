import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCodexTerminalJsonObject, recoverStructuredStreamResult } from "./stream-result-recovery.js";
import { parseReviewerVerdict, runReviewLoop } from "./review-loop.js";

// ── FG-540 regression fixture ────────────────────────────────────────────────
// Sanitized from the preserved incident stream (run-review-loop-fg-536-eaa5be /
// task-red-wide-0dc174): codex `exec --json`, clean exit 0, turn.completed,
// terminal agent_message carrying the exact reviewer pass object — and an
// EMPTY result.json. Structure, event order, and the terminal object's shape
// are verbatim; long free-text fields are truncated.
const TERMINAL_PASS_OBJECT = {
  status: "complete",
  verdict: "pass",
  findings: [],
  notes:
    "Adjacent-surface matrix reviewed: invoke and workflow/runNext dispatch (including reviewer/fixer roles), attached escape-hatch/provisioner fallbacks, detached stdin/log handling…",
  invariants_verified: [
    "Detached executor records container.started only after docker run -d succeeds.",
    "Invoke recovery finalizes a real result.json after watcher death.",
  ],
};

const INCIDENT_STREAM = [
  `{"type":"thread.started","thread_id":"019f557b-3c14-7f50-92fa-d38a1675ecb6"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'm auditing the current working tree against the detached-execution acceptance path."}}`,
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \\"rg -n onContainerStarted src/v2\\""}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \\"rg -n onContainerStarted src/v2\\""}}`,
  `{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"/bin/bash -lc \\"sed -n 700,880p src/v2/reconcile.ts\\""}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"/bin/bash -lc \\"sed -n 700,880p src/v2/reconcile.ts\\""}}`,
  `{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":${JSON.stringify(JSON.stringify(TERMINAL_PASS_OBJECT))}}}`,
  `{"type":"turn.completed","usage":{"input_tokens":179821,"cached_input_tokens":67584,"output_tokens":2226,"reasoning_output_tokens":1591}}`,
].join("\n");

test("FG-540 AC3: the incident fixture recovers the exact pass object, and parseReviewerVerdict validates it normally", () => {
  const recovered = extractCodexTerminalJsonObject(INCIDENT_STREAM);
  assert.deepEqual(recovered, TERMINAL_PASS_OBJECT);

  // The recovered object flows through the consumer's NORMAL schema validation
  // — nothing about recovery pre-blesses it.
  const verdict = parseReviewerVerdict(recovered);
  assert.equal(verdict.ok, true);
  assert.equal((verdict as { verdict: string }).verdict, "pass");
});

test("FG-540 AC7: selection is deterministic — the earlier narrative agent_message never outranks the terminal one", () => {
  // The fixture itself carries a narrative item_0 before the terminal item_4;
  // recovery must return the terminal object, not fail on (or return) the prose.
  const recovered = extractCodexTerminalJsonObject(INCIDENT_STREAM);
  assert.equal((recovered as Record<string, unknown>)["verdict"], "pass");

  // Two JSON-object agent_messages: the LAST completed one wins.
  const twoJson = [
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"{\\"verdict\\":\\"needs_fix\\",\\"findings\\":[{\\"summary\\":\\"draft\\"}]}"}}`,
    `{"type":"item.completed","item":{"id":"b","type":"agent_message","text":"{\\"verdict\\":\\"pass\\",\\"findings\\":[]}"}}`,
    `{"type":"turn.completed","usage":{}}`,
  ].join("\n");
  assert.deepEqual(extractCodexTerminalJsonObject(twoJson), { verdict: "pass", findings: [] });
});

test("FG-540 AC5: fail-closed — every non-clean or non-object shape recovers nothing", () => {
  const terminal = (text: string) =>
    `{"type":"item.completed","item":{"id":"x","type":"agent_message","text":${JSON.stringify(text)}}}`;
  const done = `{"type":"turn.completed","usage":{}}`;
  const started = `{"type":"turn.started"}`;

  // Each fixture carries a proper turn envelope so the NAMED condition is what
  // refuses, not a missing turn.started.
  // Malformed JSON text.
  assert.equal(extractCodexTerminalJsonObject([started, terminal("{not json"), done].join("\n")), undefined);
  // JSON array.
  assert.equal(extractCodexTerminalJsonObject([started, terminal("[1,2]"), done].join("\n")), undefined);
  // JSON primitives.
  assert.equal(extractCodexTerminalJsonObject([started, terminal("42"), done].join("\n")), undefined);
  assert.equal(extractCodexTerminalJsonObject([started, terminal("\"ok\""), done].join("\n")), undefined);
  assert.equal(extractCodexTerminalJsonObject([started, terminal("null"), done].join("\n")), undefined);
  // Narrative prose.
  assert.equal(extractCodexTerminalJsonObject([started, terminal("All checks passed, looks good."), done].join("\n")), undefined);
  // Missing turn.completed (incomplete stream).
  assert.equal(extractCodexTerminalJsonObject([started, terminal("{\"verdict\":\"pass\"}")].join("\n")), undefined);
  // turn.failed anywhere.
  assert.equal(
    extractCodexTerminalJsonObject([started, terminal("{\"verdict\":\"pass\"}"), `{"type":"turn.failed","error":{"message":"boom"}}`, done].join("\n")),
    undefined,
  );
  // Top-level provider error anywhere.
  assert.equal(
    extractCodexTerminalJsonObject([`{"type":"error","message":"quota"}`, started, terminal("{\"verdict\":\"pass\"}"), done].join("\n")),
    undefined,
  );
  // Ambiguous: an agent_message completing AFTER the last turn.completed.
  assert.equal(
    extractCodexTerminalJsonObject([started, done, terminal("{\"verdict\":\"pass\"}")].join("\n")),
    undefined,
  );
  // No agent_message at all / empty stream.
  assert.equal(extractCodexTerminalJsonObject([started, done].join("\n")), undefined);
  assert.equal(extractCodexTerminalJsonObject(""), undefined);
});

test("FG-540: non-JSONL noise lines are skipped, not fatal — a real log is not guaranteed pure JSONL", () => {
  const started = `{"type":"turn.started"}`;
  const terminal = `{"type":"item.completed","item":{"id":"x","type":"agent_message","text":"{\\"verdict\\":\\"pass\\"}"}}`;
  const done = `{"type":"turn.completed","usage":{}}`;
  const pass = { verdict: "pass" };

  // Wrapper noise on stdout, a truncated trailing record, a corrupt line mid-stream,
  // and well-formed JSON that isn't an event object: each is skipped, and the intact
  // turn envelope around the terminal message still recovers it — the same tolerance
  // every other codex stdout consumer (provider-failure.ts's eachJsonl) already has.
  assert.deepEqual(extractCodexTerminalJsonObject([started, "warning: sandbox slow", terminal, done].join("\n")), pass);
  assert.deepEqual(extractCodexTerminalJsonObject([started, terminal, done, `{"type":"turn.co`].join("\n")), pass);
  assert.deepEqual(extractCodexTerminalJsonObject([`{"type":"thread.started"`, started, terminal, done].join("\n")), pass);
  assert.deepEqual(extractCodexTerminalJsonObject([started, terminal, `["not","an","event"]`, done].join("\n")), pass);
  assert.deepEqual(extractCodexTerminalJsonObject([started, terminal, `"noise"`, done].join("\n")), pass);

  // Tolerance does NOT weaken the envelope: a stream truncated before its
  // turn.completed still recovers nothing.
  assert.equal(extractCodexTerminalJsonObject([started, terminal, `{"type":"turn.comp`].join("\n")), undefined);
});

test("FG-540 AC6: a recovered object that violates the REVIEWER schema is never converted to a pass", async () => {
  const stream = (text: string) =>
    [
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"x","type":"agent_message","text":${JSON.stringify(text)}}}`,
      `{"type":"turn.completed","usage":{}}`,
    ].join("\n");

  // Well-formed JSON objects that recovery DOES return — the extraction rule only
  // requires an object — but that are not valid reviewer verdicts.
  const cases = [
    '{"status":"complete","summary":"looks fine to me"}', // engineer-shaped: no verdict at all
    '{"verdict":"lgtm","findings":[]}', // unknown verdict vocabulary
    '{"verdict":"needs_fix","findings":[]}', // needs_fix with no findings
  ];

  for (const text of cases) {
    const recovered = recoverStructuredStreamResult({ logFormat: "codex-jsonl", stdoutRaw: stream(text) });
    assert.notEqual(recovered, undefined, "the object recovers — schema validation is the consumer's job, not recovery's");

    // The consumer's normal validation rejects it...
    const parsed = parseReviewerVerdict(recovered);
    assert.equal(parsed.ok, false, `must not validate: ${text}`);

    // ...and the review loop stops structurally rather than treating it as a pass,
    // exactly as it does for a reviewer that returned an invalid result.json itself
    // (cli/commands/review-loop.ts maps !parsed.ok → review dispatch not ok).
    const r = await runReviewLoop(
      { maxRounds: 1 },
      {
        verify: () => ({ ok: true, steps: [{ name: "test", ok: true, output: "" }] }),
        review: () => ({ ok: false, error: `reviewer result.json invalid: ${(parsed as { error: string }).error}` }),
        fix: () => ({ ok: true }),
      },
    );
    assert.equal(r.stopReason, "reviewer_failed");
    assert.equal(r.closeable, false);
    assert.notEqual(r.rounds[0]!.verdict, "pass");
  }
});

test("FG-540 AC7: recovery is scoped to the final completed turn's OWN started→completed envelope", () => {
  const terminal = (text: string) =>
    `{"type":"item.completed","item":{"id":"x","type":"agent_message","text":${JSON.stringify(text)}}}`;
  const done = `{"type":"turn.completed","usage":{}}`;
  const started = `{"type":"turn.started"}`;

  // Turn 1 completes with a JSON agent_message; turn 2 completes with none. The
  // stale turn-1 object must not be promoted into turn 2's recovery.
  assert.equal(
    extractCodexTerminalJsonObject(
      [started, terminal('{"verdict":"pass"}'), done, started, done].join("\n"),
    ),
    undefined,
  );

  // Round-2 review finding: a message stranded BETWEEN turns (after turn 1
  // completed, before turn 2 started) is not part of the final completed turn
  // and must refuse — the previous-turn.completed boundary admitted it.
  assert.equal(
    extractCodexTerminalJsonObject(
      [started, terminal('{"verdict":"needs_fix"}'), done, terminal('{"verdict":"pass"}'), started, done].join("\n"),
    ),
    undefined,
  );

  // A trailing turn that began but never completed makes the stream ambiguous.
  assert.equal(
    extractCodexTerminalJsonObject(
      [started, terminal('{"verdict":"pass"}'), done, started].join("\n"),
    ),
    undefined,
  );

  // A completed turn with no turn.started envelope is ambiguous.
  assert.equal(
    extractCodexTerminalJsonObject([terminal('{"verdict":"pass"}'), done].join("\n")),
    undefined,
  );

  // Overlapping turns: a second turn.started while the first is still open. The
  // trailing started→completed pair looks like a clean envelope, but the first
  // turn never completed — the stream is not intact, so refuse.
  assert.equal(
    extractCodexTerminalJsonObject([started, started, terminal('{"verdict":"pass"}'), done].join("\n")),
    undefined,
  );
  assert.equal(
    extractCodexTerminalJsonObject(
      [started, terminal('{"verdict":"needs_fix"}'), started, terminal('{"verdict":"pass"}'), done].join("\n"),
    ),
    undefined,
  );

  // A turn.completed with no matching turn.started (extra completion) is equally
  // not a real envelope.
  assert.equal(
    extractCodexTerminalJsonObject([started, terminal('{"verdict":"pass"}'), done, done].join("\n")),
    undefined,
  );

  // The final turn's own terminal message still recovers across a multi-turn stream.
  assert.deepEqual(
    extractCodexTerminalJsonObject(
      [started, terminal('{"verdict":"needs_fix"}'), done, started, terminal('{"verdict":"pass"}'), done].join("\n"),
    ),
    { verdict: "pass" },
  );
});

test("FG-540: dispatch is keyed by log format — non-codex formats recover nothing", () => {
  const stream = [
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"x","type":"agent_message","text":"{\\"verdict\\":\\"pass\\"}"}}`,
    `{"type":"turn.completed","usage":{}}`,
  ].join("\n");
  assert.notEqual(recoverStructuredStreamResult({ logFormat: "codex-jsonl", stdoutRaw: stream }), undefined);
  assert.notEqual(recoverStructuredStreamResult({ runtimeKind: "codex", stdoutRaw: stream }), undefined);
  assert.equal(recoverStructuredStreamResult({ logFormat: "claude-stream-json", stdoutRaw: stream }), undefined);
  assert.equal(recoverStructuredStreamResult({ logFormat: "pi-jsonl", stdoutRaw: stream }), undefined);
  assert.equal(recoverStructuredStreamResult({ stdoutRaw: stream }), undefined);
});
