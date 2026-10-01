// FG-822: the task-action registry's eligibility and its closed table, as pure functions —
// every FailureKind the retry policy knows, every status, and the argv each action can
// build. The HTTP half is fg822-task-actions.integration.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RE_DRIVABLE_FAILURE_KINDS, recordedRetryDisposition, retryPolicy } from "@forge/retry-policy";
import {
  ACTION_FORGE_VERBS,
  ACTION_ROUTES,
  GATE_DECISIONS,
  buildActionArgv,
  isActionMutationPath,
  previewTaskActions,
  taskIdOperand,
  type TaskAction,
} from "./action-mutation.js";
import { QUEUE_MUTATION_FORGE_VERBS } from "./queue-mutation.js";
import {
  actionButtons,
  actionResult,
  actionsFromResponse,
  confirmRequest,
  previewCommand,
} from "../client/task-actions-render.js";

const ALL_KINDS = Object.keys(RE_DRIVABLE_FAILURE_KINDS);

const failed = (failureKind: string | null, dispatchSource: string | null = "workflow") =>
  ({ taskId: "task-9", status: "failed", failureKind, dispatchSource });

const eligibleActions = (p: ReturnType<typeof previewTaskActions>) => p.eligible.map((e) => e.action);
const refusedOf = (p: ReturnType<typeof previewTaskActions>, action: TaskAction) => p.refused.find((r) => r.action === action);

test("FG-822: every FailureKind — retry is eligible exactly when POLICY says retryable with no advice", () => {
  assert.ok(ALL_KINDS.length > 20, "the kind list is the full FailureKind set");
  for (const kind of ALL_KINDS) {
    const disposition = recordedRetryDisposition(kind);
    assert.ok(disposition, `${kind} has a POLICY row`);
    const preview = previewTaskActions(failed(kind));
    const retryEligible = eligibleActions(preview).includes("retry");
    const expected = disposition.retryable && disposition.advice === undefined;
    assert.equal(retryEligible, expected, `${kind}: retry eligibility`);
    if (!expected) {
      const refusal = refusedOf(preview, "retry");
      assert.ok(refusal, `${kind}: retry is refused by name`);
      if (disposition.advice !== undefined) {
        assert.equal(refusal.advice, retryPolicy(kind, "task-9").advice, `${kind}: the refusal carries the policy's advice, for this task`);
      }
    } else {
      assert.equal(refusedOf(preview, "retry"), undefined);
    }
  }
});

test("FG-822: every FailureKind — re-drive is eligible exactly when RE_DRIVABLE_FAILURE_KINDS is true", () => {
  for (const kind of ALL_KINDS) {
    const preview = previewTaskActions(failed(kind));
    const expected = RE_DRIVABLE_FAILURE_KINDS[kind as keyof typeof RE_DRIVABLE_FAILURE_KINDS];
    assert.equal(eligibleActions(preview).includes("recover-re-drive"), expected, `${kind}: re-drive eligibility`);
    if (!expected) assert.ok(refusedOf(preview, "recover-re-drive"), `${kind}: re-drive refused by name`);
  }
});

test("FG-822: a kind this build does not know, or no kind at all, fails closed for both actions", () => {
  // retryPolicy()'s advisory default calls an unknown kind retryable — the mutation guard must not.
  assert.equal(retryPolicy("kind_from_the_future").retryable, true);
  for (const kind of ["kind_from_the_future", null]) {
    const preview = previewTaskActions(failed(kind));
    assert.deepEqual(eligibleActions(preview), [], `${kind}: nothing eligible`);
    assert.ok(refusedOf(preview, "retry"));
    assert.ok(refusedOf(preview, "recover-re-drive"));
  }
  assert.equal(recordedRetryDisposition("toString"), undefined, "a prototype key is not a policy row");
});

test("FG-822: retry of a task that is not a runner-stamped workflow step is refused (its container would run in the child)", () => {
  for (const source of ["invoke", null]) {
    const preview = previewTaskActions(failed("container_crash", source));
    assert.ok(!eligibleActions(preview).includes("retry"), `${source}: not offered`);
    assert.match(refusedOf(preview, "retry")!.advice ?? "", /forge retry task-9/);
  }
  assert.ok(eligibleActions(previewTaskActions(failed("container_crash"))).includes("retry"));
});

test("FG-822: awaiting_gate offers the three gate decisions, each labeled with its verb; other statuses refuse the gate", () => {
  const preview = previewTaskActions({ taskId: "task-1", status: "awaiting_gate", failureKind: null, dispatchSource: "workflow" });
  assert.deepEqual(preview.eligible.map((e) => e.verb), GATE_DECISIONS.map((d) => `forge gate task-1 ${d}`));
  for (const e of preview.eligible) {
    assert.equal(e.requiresRationale, true);
    assert.equal(e.route, "/api/task/task-1/gate");
    assert.deepEqual(e.argv, ["gate", "task-1", e.decision, "--rationale", "<rationale>", "--decided-by", "dashboard"]);
  }
  assert.ok(refusedOf(preview, "retry"));
  assert.ok(refusedOf(preview, "recover-re-drive"));
  for (const status of ["pending", "running", "complete", "blocked_by_red", "awaiting_red", "awaiting_recovery", "failed"]) {
    const p = previewTaskActions({ taskId: "t", status, failureKind: null, dispatchSource: "workflow" });
    assert.ok(!eligibleActions(p).includes("gate"), `${status}: no gate`);
    assert.ok(refusedOf(p, "gate"), `${status}: gate refused by name`);
    if (status !== "failed") assert.deepEqual(eligibleActions(p), [], `${status}: nothing eligible`);
  }
});

test("FG-822: the registry is closed — three task rows, FG-823's three attention rows, FG-834's two RACI rows and FG-835's two model-policy rows and FG-845's two attribution rows, seven verbs, none of the CLI-only capabilities", () => {
  assert.deepEqual(Object.keys(ACTION_ROUTES).sort(), [
    "ai-attribution-host", "ai-attribution-project", "attention-dismiss", "attention-snooze", "attention-undismiss", "gate", "model-policy-apply", "model-policy-propose", "raci-apply", "raci-propose", "recover-re-drive", "retry",
  ]);
  assert.deepEqual([...ACTION_FORGE_VERBS].sort(), ["attention", "config", "gate", "model", "raci", "recover", "retry"]);
  assert.deepEqual([...new Set(Object.values(ACTION_ROUTES).map((r) => r.verb))].sort(), [...ACTION_FORGE_VERBS].sort());
  const forbidden = ["dispatcher", "arm", "disarm", "max-active-runs", "cancel", "next", "route", "routing", "model-policy", "apply", "backlog", "--force"];
  for (const word of forbidden) {
    assert.ok(!(ACTION_FORGE_VERBS as readonly string[]).includes(word), `${word} is not an action verb`);
    assert.ok(!(QUEUE_MUTATION_FORGE_VERBS as readonly string[]).includes(word), `${word} is not a queue verb`);
    assert.ok(!Object.keys(ACTION_ROUTES).includes(word), `${word} is not an action route`);
  }
  for (const path of ["/api/task/t/cancel", "/api/task/t/next", "/api/task/t/force", "/api/task/t/dispatcher-arm", "/api/task/t/actions", "/api/task/t",
    "/api/raci", "/api/raci/validate", "/api/raci/compile", "/api/route/compile", "/api/raci/apply/force",
    "/api/model-policy", "/api/model-policy/apply/force", "/api/model-policy/migrate"]) {
    assert.equal(isActionMutationPath(path), false, `${path} is not a mutation route`);
  }
});

test("FG-822: --force never appears in any argv the builder can emit, whatever the body carries", () => {
  const cases: Array<[TaskAction, { status: string; failureKind: string | null }, unknown]> = [];
  for (const decision of GATE_DECISIONS) cases.push(["gate", { status: "awaiting_gate", failureKind: null }, { decision, rationale: "looks right" }]);
  for (const kind of ALL_KINDS) {
    cases.push(["retry", { status: "failed", failureKind: kind }, {}]);
    cases.push(["recover-re-drive", { status: "failed", failureKind: kind }, {}]);
  }
  let built = 0;
  for (const [action, state, body] of cases) {
    const out = buildActionArgv(action, { taskId: "task-9", dispatchSource: "workflow", ...state }, body);
    if (!out.ok) continue;
    built += 1;
    assert.ok(!out.argv.includes("--force"), `${action}: no --force`);
    assert.ok((ACTION_FORGE_VERBS as readonly string[]).includes(out.argv[0]!), `${action}: a registered verb`);
  }
  assert.ok(built > 5, "the sweep built real argv");
  for (const body of [{ force: true }, { "--force": true }, { decision: "advance", rationale: "x", force: true }]) {
    const out = buildActionArgv("gate", { taskId: "t", status: "awaiting_gate", failureKind: null, dispatchSource: null }, body);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.status, 400);
  }
  const retry = buildActionArgv("retry", failed("container_crash"), { force: true });
  assert.equal(retry.ok, false);
});

test("FG-822: the gate requires a rationale for every decision, and refuses a flag-shaped one", () => {
  const gateFacts = { taskId: "task-1", status: "awaiting_gate", failureKind: null, dispatchSource: "workflow" };
  for (const decision of GATE_DECISIONS) {
    for (const rationale of [undefined, "", "   ", 7]) {
      const out = buildActionArgv("gate", gateFacts, { decision, rationale });
      assert.equal(out.ok, false, `${decision} with ${JSON.stringify(rationale)}`);
      if (!out.ok) assert.match(out.error, /rationale is required/);
    }
  }
  for (const rationale of ["--force", "-x", "  --all"]) {
    const out = buildActionArgv("gate", gateFacts, { decision: "advance", rationale });
    assert.equal(out.ok, false, rationale);
    if (!out.ok) assert.match(out.error, /must not begin with "-"/);
  }
  const bad = buildActionArgv("gate", gateFacts, { decision: "approve", rationale: "ok" });
  assert.equal(bad.ok, false);
  const ok = buildActionArgv("gate", gateFacts, { decision: "request-changes", rationale: "Tighten the test.\nThen resubmit." });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.argv, ["gate", "task-1", "request-changes", "--rationale", "Tighten the test.\nThen resubmit.", "--decided-by", "dashboard"]);
});

test("FG-822: an ineligible action is refused 409 by name, with the policy's advice", () => {
  const out = buildActionArgv("retry", failed("auth_expired"), {});
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 409);
    assert.match(out.error, /auth_expired needs a human precondition/);
    assert.match(out.error, /refresh the session\/profile/);
  }
  const reDrive = buildActionArgv("recover-re-drive", failed("container_crash"), {});
  assert.equal(reDrive.ok, false);
  const good = buildActionArgv("recover-re-drive", failed("prerequisite_blocked"), {});
  assert.ok(good.ok);
  if (good.ok) assert.deepEqual(good.argv, ["recover", "task-9", "--re-drive"]);
});

test("FG-822: task ids are operands — a leading dash, a separator or a traversal never becomes argv", () => {
  assert.equal(taskIdOperand("task-1"), "task-1");
  for (const raw of ["-rf", "--force", "%2D%2Dforce", "a%2Fb", "..", "a b", "%E0%A4%A"]) {
    const out = taskIdOperand(raw);
    assert.equal(typeof out, "object", raw);
  }
});

// ── the client's render module ───────────────────────────────────────────────

test("FG-822 client: buttons come only from the server's eligible list, and only when mutations are available", () => {
  const body = { ...previewTaskActions({ taskId: "task-1", status: "awaiting_gate", failureKind: null, dispatchSource: null }), mutations: { available: true, reason: null } };
  const load = actionsFromResponse(200, body);
  assert.deepEqual(actionButtons(load).map((b: { label: string }) => b.label), ["forge gate task-1 advance", "forge gate task-1 reject", "forge gate task-1 request-changes"]);
  const offLoopback = actionsFromResponse(200, { ...body, mutations: { available: false, reason: "bound to 0.0.0.0" } });
  assert.deepEqual(actionButtons(offLoopback), []);
  assert.equal(actionsFromResponse(200, { eligible: "nope", refused: [] }).phase, "unavailable");
  assert.equal(actionsFromResponse(404, { error: "no task" }).phase, "unavailable");
});

test("FG-822 client: the preview names the command, and a gate cannot be confirmed without a rationale", () => {
  const [advance] = previewTaskActions({ taskId: "task-1", status: "awaiting_gate", failureKind: null, dispatchSource: null }).eligible;
  assert.equal(previewCommand(advance!, ""), 'forge gate task-1 advance --rationale "<rationale>"');
  assert.equal(previewCommand(advance!, "ship it"), 'forge gate task-1 advance --rationale "ship it"');
  assert.deepEqual(confirmRequest(advance!, "  "), { ok: false, error: "A rationale is required for every gate decision." });
  assert.deepEqual(confirmRequest(advance!, "ship it"), { ok: true, route: "/api/task/task-1/gate", body: { decision: "advance", rationale: "ship it" } });
  const [retry] = previewTaskActions(failed("container_crash")).eligible;
  assert.equal(previewCommand(retry!), "forge retry task-9");
  assert.deepEqual(confirmRequest(retry!), { ok: true, route: "/api/task/task-9/retry", body: {} });
});

test("FG-822 client: the result is the verb's own exit status and output", () => {
  const ok = actionResult(200, { ok: true, verb: "forge retry task-9", exitCode: 0, stdout: "Reset task-9", stderr: "" }, "forge retry task-9");
  assert.deepEqual(ok, { ok: true, line: "forge retry task-9 exited 0", output: "Reset task-9", detail: null });
  const refused = actionResult(409, { ok: false, verb: "forge gate t advance", exitCode: 1, stdout: "", stderr: "blocked_by_red" , error: "blocked_by_red" }, "x");
  assert.equal(refused.line, "forge gate t advance exited 1");
  assert.equal(refused.detail, null, "the error is not repeated when it is the output");
  const guard = actionResult(403, { ok: false, error: "cross-origin request refused" }, "forge retry t");
  assert.equal(guard.line, "forge retry t was refused (HTTP 403)");
  assert.equal(guard.detail, "cross-origin request refused");
});
