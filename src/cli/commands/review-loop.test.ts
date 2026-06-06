// #301 slice 6: buildReviewLoopDeps wires the engine to invoke(). Tests use an
// injected invokeFn (no containers) — assert verdict mapping, dispatch-failure
// handling, runId threading, and the reviewer/fixer dispatch shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { InvokeArgs, InvokeResult } from "../../v2/invoke.js";
import { buildReviewLoopDeps, type ReviewLoopContext } from "./review-loop.js";

function ctx(over: Partial<ReviewLoopContext> = {}): ReviewLoopContext {
  return {
    ticketId: "301", acceptance: "#301 — do the thing", diff: "diff --git ...",
    projectDir: "/tmp/proj", scripts: {}, unrouted: true, ...over,
  };
}
const RESULT = (over: Partial<InvokeResult>): InvokeResult => ({ runId: "run-1", taskId: "t-1", status: "complete", ...over });

test("#301 deps.review: complete + valid result.json → parsed verdict", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ result: { verdict: "needs_fix", findings: [{ summary: "x", file: "a.ts", line: 1 }] } }));
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(r.ok, true);
  assert.equal((r as { verdict: string }).verdict, "needs_fix");
});

test("#301 deps.review: dispatches red-wide read-only", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  assert.equal(seen!.agentRole, "red-wide");
  assert.equal(seen!.readOnlyProject, true);
  assert.match(seen!.task, /REVIEWER/);
});

test("reviewer brief carries the hardening rubric (docs-vs-impl, per-path semantics, coverage gaps)", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  assert.match(seen!.task, /behavioral claim/i);        // docs/ADRs verified against impl
  assert.match(seen!.task, /multiple execution paths/i); // each path asserts the semantic
  assert.match(seen!.task, /lacks direct test coverage/i); // coverage-gap callout
});

test("#301 deps.review: invoke status failed → ok false", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ status: "failed", error: "boom" }));
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /boom/);
});

test("#301 deps.review: complete but invalid result.json → ok false (never a silent pass)", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ result: { verdict: "lgtm" } }));
  const r = await deps.review({ ok: true, steps: [] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /result\.json invalid/);
});

test("#301 deps.fix: dispatches engineer with the findings; complete → ok", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({}); });
  const r = await deps.fix([{ summary: "off-by-one", file: "a.ts", line: 7 }]);
  assert.equal(r.ok, true);
  assert.equal(seen!.agentRole, "engineer");
  assert.match(seen!.task, /FIXER/);
  assert.match(seen!.task, /a\.ts:7 — off-by-one/);
});

test("#301 deps.fix: invoke failed → ok false", async () => {
  const { deps } = buildReviewLoopDeps(ctx(), async () => RESULT({ status: "failed", error: "engineer crashed" }));
  const r = await deps.fix([{ summary: "x", unanchored: true }]);
  assert.equal(r.ok, false);
  assert.match((r as { error?: string }).error ?? "", /engineer crashed/);
});

test("#301 deps: threads one runId across dispatches (review creates it, fix reuses it)", async () => {
  const seen: (string | undefined)[] = [];
  const { deps, getRunId } = buildReviewLoopDeps(ctx(), async (a) => {
    seen.push(a.runId);
    return RESULT({ runId: "run-shared", result: { verdict: "needs_fix", findings: [{ summary: "x", unanchored: true }] } });
  });
  await deps.review({ ok: true, steps: [] }); // no runId yet → creates run-shared
  await deps.fix([{ summary: "x", unanchored: true }]); // reuses run-shared
  assert.deepEqual(seen, [undefined, "run-shared"]);
  assert.equal(getRunId(), "run-shared");
});
