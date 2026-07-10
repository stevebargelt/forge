import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decideMilestone, emitMilestone, isMilestoneKind, composeDispatchBody, milestoneActionMarker, milestoneDispatchBody, MILESTONE_KINDS, BATCH_ELAPSED_MIN_MS } from "./milestone.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import { logEvent, eventsForRun } from "../store/events.js";
import type { Run, Task } from "../types/index.js";

function mkRun(id: string, createdAt = new Date().toISOString()): Run {
  const run: Run = {
    id,
    workflow: "invoke",
    title: "t",
    status: "active",
    createdAt,
    metadata: {},
    projectDir: "/tmp/x",
  };
  insertRun(run);
  return run;
}

// ---- pure policy ----

test("decideMilestone: interrupt-worthy kinds always send", () => {
  for (const k of ["decision_needed", "blocked", "risk_found", "acceptance_green", "shipped", "ready_for_review"] as const) {
    assert.equal(decideMilestone(k, 0, false).send, true, `${k} should send`);
  }
});

test("decideMilestone: plan_started is suppressed by default", () => {
  const d = decideMilestone("plan_started", 9_999_999, false);
  assert.equal(d.send, false);
  assert.match(d.reason, /low importance/);
});

test("decideMilestone: batch_complete gates on elapsed (>=10m sends, <10m suppresses)", () => {
  assert.equal(decideMilestone("batch_complete", BATCH_ELAPSED_MIN_MS, false).send, true);
  assert.equal(decideMilestone("batch_complete", BATCH_ELAPSED_MIN_MS - 1, false).send, false);
});

test("decideMilestone: dedupe wins over everything (even always-send kinds)", () => {
  const d = decideMilestone("blocked", 0, true, "k1");
  assert.equal(d.send, false);
  assert.match(d.reason, /dedupe.*k1/);
});

test("isMilestoneKind rejects unknown kinds", () => {
  assert.equal(isMilestoneKind("blocked"), true);
  assert.equal(isMilestoneKind("nope"), false);
});

// ---- emit (record + policy + dedupe) ----

test("emitMilestone: always records an orchestrator.milestone event (provider off → dispatched=false)", async () => {
  const run = mkRun("run-ms-1");
  const res = await emitMilestone({ runId: run.id, kind: "decision_needed", title: "need a call" });
  assert.equal(res.decision.send, true, "policy wants to send");
  assert.equal(res.dispatched, false, "no provider in tests → not dispatched");
  const evts = eventsForRun(run.id).filter((e) => e.eventType === "orchestrator.milestone");
  assert.equal(evts.length, 1);
  const p = evts[0]!.payload as Record<string, unknown>;
  assert.equal(p["kind"], "decision_needed");
  assert.equal(p["title"], "need a call");
  assert.equal(p["importance"], "high");
  assert.equal(p["dispatched"], false);
});

// FG-494: milestone recording must stay independent of provider delivery
// outcome, but the recorded/returned `dispatched` flag must still reflect
// that outcome (AC2). The pre-fix bug had ntfy's Title header throw
// "Cannot convert argument to a ByteString..." for any title with a
// non-Latin-1 character (em-dash, arrows, etc); notifyNtfy's try/catch already
// converts that into a returned error rather than a throw, so dispatch()
// swallows it — this pins that the milestone event is recorded regardless,
// while `dispatched` correctly reads false since delivery failed.
test("emitMilestone: milestone event is recorded even when ntfy delivery throws (ByteString-shaped failure)", async () => {
  const savedNoNotify = process.env["NO_NOTIFY"];
  const savedForgeNotify = process.env["FORGE_NOTIFY"];
  const savedNtfyUrl = process.env["NTFY_URL"];
  const originalFetch = globalThis.fetch;
  try {
    process.env["NO_NOTIFY"] = "";
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
    globalThis.fetch = (async () => {
      throw new TypeError(
        "Cannot convert argument to a ByteString because the character at index 10 has a value of 8212 which is greater than 255.",
      );
    }) as typeof fetch;

    const run = mkRun("run-ms-bytestring-1");
    const res = await emitMilestone({ runId: run.id, kind: "blocked", title: "Milestone — blocked" });
    assert.equal(res.decision.send, true);
    assert.equal(res.dispatched, false, "provider failed (network throw), so not really delivered");
    assert.match(res.dispatchError ?? "", /ntfy/);
    const evts = eventsForRun(run.id).filter((e) => e.eventType === "orchestrator.milestone");
    assert.equal(evts.length, 1, "milestone event recorded despite provider throwing");
    assert.equal((evts[0]!.payload as Record<string, unknown>)["dispatched"], false);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedNoNotify !== undefined) process.env["NO_NOTIFY"] = savedNoNotify; else delete process.env["NO_NOTIFY"];
    if (savedForgeNotify !== undefined) process.env["FORGE_NOTIFY"] = savedForgeNotify; else delete process.env["FORGE_NOTIFY"];
    if (savedNtfyUrl !== undefined) process.env["NTFY_URL"] = savedNtfyUrl; else delete process.env["NTFY_URL"];
  }
});

// FG-494 (this task): end-to-end at the milestone emission surface — the
// composed ntfy Title (`forge: <kind> — <title>`) always contains a non-ASCII
// em-dash even for ASCII-only inputs, so this exercises the full
// emitMilestone -> dispatch -> notifyNtfy -> encodeNtfyTitle chain with a
// title/body that also carry emoji, pinning that RFC 2047 encoding and the
// audit-trail event both survive the real wiring (not just notifyNtfy tested
// in isolation, as ntfy.test.ts already does).
test("emitMilestone -> dispatch -> notifyNtfy: Unicode title/body round-trip through the real wiring, event recorded", async () => {
  const savedNoNotify = process.env["NO_NOTIFY"];
  const savedForgeNotify = process.env["FORGE_NOTIFY"];
  const savedNtfyUrl = process.env["NTFY_URL"];
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> | undefined;
  let capturedBody: unknown;
  try {
    process.env["NO_NOTIFY"] = "";
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as typeof fetch;

    const run = mkRun("run-ms-unicode-1");
    const title = "Launch 🚀 — done ✓";
    const body = "Release ✓ shipped — 🎉 all systems go";
    const res = await emitMilestone({ runId: run.id, kind: "blocked", title, body });

    assert.equal(res.dispatched, true);

    // The Title header ntfy actually receives is `forge: <kind> — <title>`
    // (composed in emitMilestone), not the bare title.
    const expectedTitle = `forge: blocked — ${title}`;
    const header = capturedHeaders?.["Title"];
    assert.ok(header, "Title header was set");
    const match = header!.match(/^=\?UTF-8\?B\?(.+)\?=$/);
    assert.ok(match, `expected RFC 2047 encoded-word, got: ${header}`);
    assert.equal(Buffer.from(match![1]!, "base64").toString("utf8"), expectedTitle);

    // The dispatched body is the composed action-marker body — assert it
    // matches exactly and still carries the original Unicode bytes unmangled.
    const expectedBody = milestoneDispatchBody("blocked", body);
    assert.equal(capturedBody, expectedBody);
    assert.equal(Buffer.from(capturedBody as string, "utf8").toString("utf8"), expectedBody);
    assert.match(capturedBody as string, /🎉/);
    assert.match(capturedBody as string, /✓/);

    const evts = eventsForRun(run.id).filter((e) => e.eventType === "orchestrator.milestone");
    assert.equal(evts.length, 1);
    const p = evts[0]!.payload as Record<string, unknown>;
    assert.equal(p["title"], title);
    assert.equal(p["body"], body);
    assert.equal(p["dispatched"], true);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedNoNotify !== undefined) process.env["NO_NOTIFY"] = savedNoNotify; else delete process.env["NO_NOTIFY"];
    if (savedForgeNotify !== undefined) process.env["FORGE_NOTIFY"] = savedForgeNotify; else delete process.env["FORGE_NOTIFY"];
    if (savedNtfyUrl !== undefined) process.env["NTFY_URL"] = savedNtfyUrl; else delete process.env["NTFY_URL"];
  }
});

// FG-494 (this task): same real wiring, but ntfy answers HTTP 500 — the
// audit-trail event must still be recorded, the failure must surface (via
// dispatch's console.error path, per trigger.ts's documented contract), and
// nothing may throw up through emitMilestone. AC2: `dispatched` must read
// false here (delivery failed), distinct from the HTTP-200 success case above.
test("emitMilestone -> dispatch -> notifyNtfy: HTTP 500 still records the milestone event, reports non-delivery, and surfaces the error without throwing", async () => {
  const savedNoNotify = process.env["NO_NOTIFY"];
  const savedForgeNotify = process.env["FORGE_NOTIFY"];
  const savedNtfyUrl = process.env["NTFY_URL"];
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  try {
    process.env["NO_NOTIFY"] = "";
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
    console.error = (...args: unknown[]) => { consoleErrors.push(args); };
    globalThis.fetch = (async () => {
      return { ok: false, status: 500, text: async () => "internal error" } as Response;
    }) as typeof fetch;

    const run = mkRun("run-ms-unicode-500-1");
    const title = "Launch 🚀 — done ✓";
    let res: Awaited<ReturnType<typeof emitMilestone>> | undefined;
    await assert.doesNotReject(async () => {
      res = await emitMilestone({ runId: run.id, kind: "blocked", title });
    });

    assert.equal(res!.dispatched, false, "provider returned HTTP 500, so delivery did not succeed");
    assert.match(res!.dispatchError ?? "", /ntfy.*HTTP 500/);

    const evts = eventsForRun(run.id).filter((e) => e.eventType === "orchestrator.milestone");
    assert.equal(evts.length, 1, "milestone event recorded despite provider HTTP 500");
    assert.equal((evts[0]!.payload as Record<string, unknown>)["dispatched"], false, "event's dispatched field must distinguish this failure from a real success");
    assert.match(String((evts[0]!.payload as Record<string, unknown>)["dispatchError"]), /HTTP 500/);

    assert.equal(consoleErrors.length, 1, "the ntfy failure is surfaced via console.error");
    assert.match(String(consoleErrors[0]?.[0]), /ntfy failed/);
    assert.match(String(consoleErrors[0]?.[0]), /HTTP 500/);
    assert.match(String(consoleErrors[0]?.[0]), /internal error/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (savedNoNotify !== undefined) process.env["NO_NOTIFY"] = savedNoNotify; else delete process.env["NO_NOTIFY"];
    if (savedForgeNotify !== undefined) process.env["FORGE_NOTIFY"] = savedForgeNotify; else delete process.env["FORGE_NOTIFY"];
    if (savedNtfyUrl !== undefined) process.env["NTFY_URL"] = savedNtfyUrl; else delete process.env["NTFY_URL"];
  }
});

test("emitMilestone: suppressed kind is still recorded (audit), not dispatched", async () => {
  const run = mkRun("run-ms-2");
  const res = await emitMilestone({ runId: run.id, kind: "plan_started", title: "starting" });
  assert.equal(res.decision.send, false);
  assert.equal(eventsForRun(run.id).filter((e) => e.eventType === "orchestrator.milestone").length, 1);
});

test("emitMilestone: dedupe suppresses a second push for a key already dispatched this run", async () => {
  const run = mkRun("run-ms-3");
  // Simulate a prior DISPATCHED milestone with the same dedupe key.
  logEvent("orchestrator.milestone", { runId: run.id, payload: { kind: "blocked", dedupeKey: "dk", dispatched: true } });
  const res = await emitMilestone({ runId: run.id, kind: "blocked", title: "again", dedupeKey: "dk" });
  assert.equal(res.decision.send, false, "deduped");
  assert.match(res.decision.reason, /dedupe/);
});

test("emitMilestone: a prior NON-dispatched same-key milestone does NOT dedupe", async () => {
  const run = mkRun("run-ms-4");
  logEvent("orchestrator.milestone", { runId: run.id, payload: { kind: "blocked", dedupeKey: "dk2", dispatched: false } });
  const res = await emitMilestone({ runId: run.id, kind: "blocked", title: "go", dedupeKey: "dk2" });
  assert.equal(res.decision.send, true, "prior was never sent, so not a dup");
});

test("FG-516: dedupeScope 'global' suppresses a same-key milestone dispatched on a DIFFERENT run", async () => {
  // A prior dispatched milestone under key 'gk' on run A.
  const runA = mkRun("run-ms-globalA");
  logEvent("orchestrator.milestone", { runId: runA.id, payload: { kind: "blocked", dedupeKey: "gk", dispatched: true } });
  // The re-park lands on run B (the `forge campaign retry` cleared-runId shape).
  const runB = mkRun("run-ms-globalB");
  const res = await emitMilestone({ runId: runB.id, kind: "blocked", title: "re-park", dedupeKey: "gk", dedupeScope: "global" });
  assert.equal(res.decision.send, false, "global scope finds the prior push on run A and suppresses");
  assert.match(res.decision.reason, /dedupe/);
});

test("FG-516: default 'run' scope does NOT suppress across runs (byte-compatible with existing callers)", async () => {
  const runA = mkRun("run-ms-runA");
  logEvent("orchestrator.milestone", { runId: runA.id, payload: { kind: "blocked", dedupeKey: "rk", dispatched: true } });
  const runB = mkRun("run-ms-runB");
  // No dedupeScope → run-scoped scan of run B finds nothing → still sends.
  const res = await emitMilestone({ runId: runB.id, kind: "blocked", title: "other run", dedupeKey: "rk" });
  assert.equal(res.decision.send, true, "run scope only scans its own run, so a cross-run key is not a dup");
});

test("emitMilestone: unknown kind throws; missing run throws", async () => {
  const run = mkRun("run-ms-5");
  await assert.rejects(() => emitMilestone({ runId: run.id, kind: "bogus", title: "x" }), /unknown milestone kind/);
  await assert.rejects(() => emitMilestone({ runId: "no-such-run", kind: "blocked", title: "x" }), /run not found/);
});

// ---- #242 advisory docs-impact on shipped ----

function mkCompleteTask(runId: string, id: string, filesModified: string[]): void {
  const task: Task = {
    id,
    runId,
    phase: "engineer",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  };
  insertTask(task);
  const dir = taskDir(runId, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", files_modified: filesModified }));
}

test("composeDispatchBody: appends the advisory to the pushed body, or returns base", () => {
  assert.equal(composeDispatchBody("done"), "done");
  const withWarn = composeDispatchBody("done", "UNRESOLVED docs impact");
  assert.match(withWarn, /done/);
  assert.match(withWarn, /⚠ UNRESOLVED docs impact/);
});

test("FG-464 milestoneActionMarker: action-needed kinds read distinctly from FYI kinds", () => {
  // Operator-action kinds lead with ▶ ACTION; the rest lead with ✓ FYI.
  assert.match(milestoneActionMarker("decision_needed"), /^▶ ACTION: your decision needed$/);
  assert.match(milestoneActionMarker("blocked"), /^▶ ACTION: /);
  assert.match(milestoneActionMarker("risk_found"), /^▶ ACTION: /);
  assert.match(milestoneActionMarker("ready_for_review"), /^▶ ACTION: /);
  assert.match(milestoneActionMarker("shipped"), /^✓ FYI: shipped$/);
  assert.match(milestoneActionMarker("batch_complete"), /^✓ FYI: /);
  assert.match(milestoneActionMarker("acceptance_green"), /^✓ FYI: /);
  // Every kind is covered (no fallthrough to an empty marker).
  for (const k of MILESTONE_KINDS) {
    assert.match(milestoneActionMarker(k), /^(▶ ACTION|✓ FYI): .+/, `marker for ${k}`);
  }
});

test("FG-464 milestoneDispatchBody: the composed push body leads with the marker, then text, then advisory", () => {
  // This is the exact body emitMilestone dispatches to a provider.
  assert.equal(milestoneDispatchBody("decision_needed", "AWN-7 Walk smoke complete"), "▶ ACTION: your decision needed — AWN-7 Walk smoke complete");
  assert.equal(milestoneDispatchBody("shipped", "FG-464 shipped"), "✓ FYI: shipped — FG-464 shipped");
  const withWarn = milestoneDispatchBody("shipped", "FG-464 shipped", "UNRESOLVED docs impact");
  assert.match(withWarn, /^✓ FYI: shipped — FG-464 shipped/);
  assert.match(withWarn, /⚠ UNRESOLVED docs impact/);
});

test("emitMilestone: shipped on a run that changed operator surfaces returns + records the advisory", async () => {
  const run = mkRun("run-ms-ship-1");
  mkCompleteTask(run.id, "task-eng-ship-1", ["src/cli/commands/usage.ts"]); // operator surface, no docs work
  const res = await emitMilestone({ runId: run.id, kind: "shipped", title: "feature X" });
  assert.ok(res.docsImpactWarning, "advisory computed for shipped with unresolved impact");
  assert.match(res.docsImpactWarning!, /UNRESOLVED/);
  const evt = eventsForRun(run.id).find((e) => e.eventType === "orchestrator.milestone");
  assert.ok((evt!.payload as Record<string, unknown>)["docsImpactWarning"], "advisory recorded in the event payload");
});

test("emitMilestone: shipped on a docs-only run yields no advisory", async () => {
  const run = mkRun("run-ms-ship-2");
  mkCompleteTask(run.id, "task-doc-ship-2", ["docs/concepts.md"]); // remediation, not a behavior change
  const res = await emitMilestone({ runId: run.id, kind: "shipped", title: "doc tidy" });
  assert.equal(res.docsImpactWarning, undefined);
});

test("emitMilestone: non-shipped kinds never compute the advisory", async () => {
  const run = mkRun("run-ms-ship-3");
  mkCompleteTask(run.id, "task-eng-ship-3", ["src/cli/commands/usage.ts"]);
  const res = await emitMilestone({ runId: run.id, kind: "ready_for_review", title: "rfr" });
  assert.equal(res.docsImpactWarning, undefined);
});
