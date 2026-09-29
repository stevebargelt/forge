// FG-823: the attention-row argv builder — the exact argv each of the three routes may
// spawn, the actor always `dashboard`, and every malformed body or operand refused before
// argv exists. The routes themselves run through the real server in
// fg823-attention-actions.integration.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_ROUTES, buildAttentionArgv, isActionMutationPath, itemKeyOperand } from "./action-mutation.js";

const NOW = Date.parse("2026-09-29T09:00:00Z");

function argv(out: ReturnType<typeof buildAttentionArgv>): string[] {
  assert.ok(out.ok, `refused: ${JSON.stringify(out)}`);
  return out.argv;
}

test("FG-823: the three attention routes are registry rows shelling `forge attention`", () => {
  assert.deepEqual(
    Object.entries(ACTION_ROUTES).filter(([key]) => key.startsWith("attention-")).map(([, row]) => [row.path, row.verb]),
    [
      ["/api/attention/:itemKey/dismiss", "attention"],
      ["/api/attention/:itemKey/snooze", "attention"],
      ["/api/attention/:itemKey/undismiss", "attention"],
    ],
  );
  for (const path of ["/api/attention/task%3Aa/dismiss", "/api/attention/task%3Aa/snooze", "/api/attention/task%3Aa/undismiss"]) {
    assert.equal(isActionMutationPath(path), true, path);
  }
  for (const path of ["/api/attention/task%3Aa/delete", "/api/attention/task%3Aa", "/api/attention-inbox", "/api/attention/a/b/dismiss"]) {
    assert.equal(isActionMutationPath(path), false, path);
  }
});

test("FG-823: each action builds exactly its argv, actor dashboard", () => {
  assert.deepEqual(argv(buildAttentionArgv("attention-dismiss", "task:t1", {})), ["attention", "dismiss", "task:t1", "--actor", "dashboard"]);
  assert.deepEqual(
    argv(buildAttentionArgv("attention-dismiss", "task:t1", { rationale: "known flake" })),
    ["attention", "dismiss", "task:t1", "--actor", "dashboard", "--rationale", "known flake"],
  );
  assert.deepEqual(argv(buildAttentionArgv("attention-dismiss", "task:t1", { rationale: "  " })), ["attention", "dismiss", "task:t1", "--actor", "dashboard"]);
  assert.deepEqual(
    argv(buildAttentionArgv("attention-snooze", "wait:gate:r1", { until: "4h" }, NOW)),
    ["attention", "snooze", "wait:gate:r1", "--until", "4h", "--actor", "dashboard"],
  );
  assert.deepEqual(
    argv(buildAttentionArgv("attention-snooze", "wait:gate:r1", { until: "2026-09-30T00:00:00Z", rationale: "after standup" }, NOW)),
    ["attention", "snooze", "wait:gate:r1", "--until", "2026-09-30T00:00:00Z", "--actor", "dashboard", "--rationale", "after standup"],
  );
  assert.deepEqual(argv(buildAttentionArgv("attention-undismiss", "task:t1", {})), ["attention", "undismiss", "task:t1", "--actor", "dashboard"]);
});

test("FG-823: bodies outside each action's one shape are refused 400, never passed through", () => {
  const cases: Array<[Parameters<typeof buildAttentionArgv>[0], unknown]> = [
    ["attention-dismiss", []],
    ["attention-dismiss", "x"],
    ["attention-dismiss", { actor: "mallory" }],
    ["attention-dismiss", { force: true }],
    ["attention-dismiss", { until: "1h" }],
    ["attention-dismiss", { rationale: "--force" }],
    ["attention-dismiss", { rationale: 7 }],
    ["attention-dismiss", { rationale: "a\u0000b" }],
    ["attention-dismiss", { rationale: "x".repeat(4001) }],
    ["attention-snooze", {}],
    ["attention-snooze", { until: "yesterday" }],
    ["attention-snooze", { until: "2026-09-28T00:00:00Z" }],
    ["attention-snooze", { until: "--now" }],
    ["attention-undismiss", { rationale: "x" }],
  ];
  for (const [action, body] of cases) {
    const out = buildAttentionArgv(action, "task:t1", body, NOW);
    assert.equal(out.ok, false, `${action} ${JSON.stringify(body)} must be refused`);
    if (!out.ok) assert.equal(out.status, 400);
  }
});

test("FG-823: the item-key operand is decoded, then refused unless it is an inbox item id", () => {
  assert.equal(itemKeyOperand(encodeURIComponent("wait:gate:run-1:task-2")), "wait:gate:run-1:task-2");
  for (const raw of ["-rf", encodeURIComponent("--force"), "%E0%A4%A", encodeURIComponent("task: x"), "nocolon", encodeURIComponent("task:a\nb")]) {
    const out = itemKeyOperand(raw);
    assert.equal(typeof out, "object", raw);
    if (typeof out === "object") assert.equal(out.status, 400);
  }
});
