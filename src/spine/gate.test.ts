import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateVerdicts } from "./gate.js";
import type { VerdictRow, RedAuthority } from "../types/index.js";

function v(
  partial: Partial<VerdictRow> & { verdict: VerdictRow["verdict"]; authority: RedAuthority }
): VerdictRow {
  return {
    id: partial.id ?? "verdict-x",
    taskId: partial.taskId ?? "task-x",
    redTaskId: partial.redTaskId ?? "task-red-x",
    redRole: partial.redRole ?? "red-wide",
    verdict: partial.verdict,
    confidence: partial.confidence ?? 0.8,
    authority: partial.authority,
    findings: partial.findings ?? [],
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

test("aggregateVerdicts: empty list is inconclusive", () => {
  const r = aggregateVerdicts([]);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.authoritativeFails.length, 0);
  assert.equal(r.specialistFails.length, 0);
});

test("aggregateVerdicts: all pass → pass", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "specialist" }),
    v({ verdict: "pass", authority: "authoritative" }),
  ]);
  assert.equal(r.verdict, "pass");
});

test("aggregateVerdicts: any authoritative fail → fail (regardless of others)", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "specialist" }),
    v({ verdict: "fail", authority: "authoritative" }),
    v({ verdict: "pass", authority: "specialist" }),
  ]);
  assert.equal(r.verdict, "fail");
  assert.equal(r.authoritativeFails.length, 1);
});

test("aggregateVerdicts: specialist fail with passing peers → inconclusive (warns, doesn't block)", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "authoritative" }),
    v({ verdict: "fail", authority: "specialist" }),
  ]);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.authoritativeFails.length, 0);
  assert.equal(r.specialistFails.length, 1);
});

test("aggregateVerdicts: triage fail alone → inconclusive", () => {
  const r = aggregateVerdicts([v({ verdict: "fail", authority: "triage" })]);
  assert.equal(r.verdict, "inconclusive");
});

test("aggregateVerdicts: inconclusive verdict → inconclusive (not pass, not fail)", () => {
  const r = aggregateVerdicts([
    v({ verdict: "pass", authority: "authoritative" }),
    v({ verdict: "inconclusive", authority: "specialist" }),
  ]);
  assert.equal(r.verdict, "inconclusive");
});

test("aggregateVerdicts: multiple authoritative fails all captured", () => {
  const r = aggregateVerdicts([
    v({ verdict: "fail", authority: "authoritative", redRole: "red-wide" }),
    v({ verdict: "fail", authority: "authoritative", redRole: "red-narrow" }),
  ]);
  assert.equal(r.verdict, "fail");
  assert.equal(r.authoritativeFails.length, 2);
});
