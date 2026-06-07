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
  assert.match(seen!.task, /full operator path/i);      // config->resolver->dispatch->auth->doctor
  assert.match(seen!.task, /runnable contract/i);       // example config traced end-to-end
  assert.match(seen!.task, /accepted PRDs/i);           // reconcile design records, not just how-tos
});

test("#305 reviewer brief carries the adjacent-surface regression matrix", async () => {
  let seen: InvokeArgs | undefined;
  const { deps } = buildReviewLoopDeps(ctx(), async (a) => { seen = a; return RESULT({ result: { verdict: "pass" } }); });
  await deps.review({ ok: true, steps: [] });
  const t = seen!.task;
  // 1. stale closeout status language
  assert.match(t, /stale closeout/i);
  assert.match(t, /Deferred/);
  // 2. all supported log_format / runtime_kind, not just the named one
  assert.match(t, /every currently supported log_format/i);
  assert.match(t, /runtime_kind/i);
  // 3. recently-activated paths + the active codex path named
  assert.match(t, /recently-activated paths/i);
  assert.match(t, /codex-jsonl/i);
  // 4. stale non-prose: comments, seed text, fixtures, ADR/backlog
  assert.match(t, /fixtures/i);
  assert.match(t, /seed text/i);
  // 5. name the matrix + 6. explicit out-of-scope
  assert.match(t, /name the .*matrix/i);
  assert.match(t, /runtime kinds/i);
  assert.match(t, /auth modes/i);
  assert.match(t, /CLI modes/i);
  assert.match(t, /out of scope/i);
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
