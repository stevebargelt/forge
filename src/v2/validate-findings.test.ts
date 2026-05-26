import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFinding, validateVerdict } from "./validate-findings.js";
import type { Finding, Verdict } from "../types/index.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-vf-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeProjectFile(rel: string, content: string): void {
  const path = join(projectDir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const baseFinding = (over: Partial<Finding>): Finding => ({
  severity: "medium",
  summary: "summary",
  evidence: "evidence",
  hypothesis: "hypothesis",
  ...over,
});

// ----- validateFinding -----

test("validateFinding: returns ok for un-anchored finding (no file/line/quoted_text)", () => {
  const r = validateFinding(baseFinding({}), projectDir);
  assert.deepEqual(r, { ok: true });
});

test("validateFinding: returns ok when quoted_text appears exactly at file:line", () => {
  writeProjectFile("src/foo.ts", "line 1\nline 2\nfn bar() {}\nline 4\n");
  const r = validateFinding(
    baseFinding({ file: "src/foo.ts", line: 3, quoted_text: "fn bar() {}" }),
    projectDir,
  );
  assert.deepEqual(r, { ok: true });
});

test("validateFinding: returns ok when quoted_text appears within ±3 line window of cited line", () => {
  writeProjectFile("src/foo.ts", "1\n2\n3\n4\n5\nfn target() {}\n7\n8\n9\n10\n");
  // Cite line 4 but the real location is line 6 (within ±3).
  const r = validateFinding(
    baseFinding({ file: "src/foo.ts", line: 4, quoted_text: "fn target() {}" }),
    projectDir,
  );
  assert.deepEqual(r, { ok: true });
});

test("validateFinding: rejects when file does not exist", () => {
  const r = validateFinding(
    baseFinding({ file: "src/missing.ts", line: 10, quoted_text: "anything" }),
    projectDir,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /does not exist/);
});

test("validateFinding: rejects when line is past EOF", () => {
  writeProjectFile("src/foo.ts", "one\ntwo\n");
  const r = validateFinding(
    baseFinding({ file: "src/foo.ts", line: 999, quoted_text: "one" }),
    projectDir,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /line 999/);
});

test("validateFinding: rejects when quoted_text doesn't appear at file:line ±3", () => {
  writeProjectFile("src/foo.ts", "1\n2\n3\n4\n5\n6\n7\n8\n9\nfn way_down_here() {}\n");
  // Cite line 2 but the real location is line 10 (outside ±3 window).
  const r = validateFinding(
    baseFinding({ file: "src/foo.ts", line: 2, quoted_text: "fn way_down_here() {}" }),
    projectDir,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /quoted_text not found/);
});

test("validateFinding: treats partial anchors (file+line only) as un-anchored", () => {
  // No quoted_text → un-anchored, passes through.
  const r = validateFinding(
    baseFinding({ file: "src/missing.ts", line: 999 }),
    projectDir,
  );
  assert.deepEqual(r, { ok: true });
});

test("validateFinding: tolerates indentation drift in quoted_text", () => {
  // Source has leading spaces; quoted_text from the agent has none. The
  // validator's whitespace-normalize ('collapse runs of whitespace to single
  // space, trim') handles this. It does NOT handle arbitrary punctuation
  // differences (e.g. spaces inside parens vs none), which is fine — the
  // common drift is indentation, not punctuation.
  writeProjectFile("src/foo.ts", "    if (cond) { doThing(); }\n");
  const r = validateFinding(
    baseFinding({ file: "src/foo.ts", line: 1, quoted_text: "if (cond) { doThing(); }" }),
    projectDir,
  );
  assert.deepEqual(r, { ok: true });
});

// ----- validateVerdict -----

test("validateVerdict: passes verdict through unchanged when all findings validate", () => {
  writeProjectFile("src/foo.ts", "real code here\n");
  const v: Verdict = {
    verdict: "fail",
    confidence: 0.9,
    findings: [
      baseFinding({ file: "src/foo.ts", line: 1, quoted_text: "real code here" }),
    ],
  };
  const out = validateVerdict(v, projectDir);
  assert.equal(out.validated.verdict, "fail");
  assert.equal(out.validated.findings.length, 1);
  assert.equal(out.dropped.length, 0);
});

test("validateVerdict: filters out invalidated findings but keeps verdict if some survive", () => {
  writeProjectFile("src/foo.ts", "real code here\n");
  const v: Verdict = {
    verdict: "fail",
    confidence: 0.9,
    findings: [
      baseFinding({ summary: "good", file: "src/foo.ts", line: 1, quoted_text: "real code here" }),
      baseFinding({ summary: "bad",  file: "src/missing.ts", line: 1, quoted_text: "fake" }),
    ],
  };
  const out = validateVerdict(v, projectDir);
  assert.equal(out.validated.verdict, "fail");
  assert.equal(out.validated.findings.length, 1);
  assert.equal(out.validated.findings[0]!.summary, "good");
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]!.finding.summary, "bad");
});

test("validateVerdict: downgrades fail → inconclusive when ALL findings dropped (hallucinated case)", () => {
  // Empty project — every file:line citation will fail.
  const v: Verdict = {
    verdict: "fail",
    confidence: 0.95,
    findings: [
      baseFinding({ file: "src/a.ts", line: 1, quoted_text: "x" }),
      baseFinding({ file: "src/b.ts", line: 2, quoted_text: "y" }),
    ],
  };
  const out = validateVerdict(v, projectDir);
  assert.equal(out.validated.verdict, "inconclusive");
  assert.equal(out.validated.findings.length, 0);
  assert.match(out.validated.notes ?? "", /downgraded from fail to inconclusive/);
  assert.equal(out.dropped.length, 2);
});

test("validateVerdict: leaves pass verdict unchanged even when all findings dropped", () => {
  const v: Verdict = {
    verdict: "pass",
    confidence: 0.7,
    findings: [baseFinding({ file: "src/a.ts", line: 1, quoted_text: "x" })],
  };
  const out = validateVerdict(v, projectDir);
  assert.equal(out.validated.verdict, "pass");
  assert.equal(out.validated.findings.length, 0);
  assert.equal(out.dropped.length, 1);
});

test("validateVerdict: leaves inconclusive verdict unchanged even when all findings dropped", () => {
  const v: Verdict = {
    verdict: "inconclusive",
    confidence: 0.3,
    findings: [baseFinding({ file: "src/a.ts", line: 1, quoted_text: "x" })],
  };
  const out = validateVerdict(v, projectDir);
  assert.equal(out.validated.verdict, "inconclusive");
  assert.equal(out.dropped.length, 1);
});

test("validateVerdict: un-anchored findings pass through and don't trigger downgrade", () => {
  const v: Verdict = {
    verdict: "fail",
    confidence: 0.9,
    findings: [baseFinding({ summary: "abstract concern, no citation" })],
  };
  const out = validateVerdict(v, projectDir);
  // No findings have anchors, so nothing was DROPPED — verdict stays fail.
  assert.equal(out.validated.verdict, "fail");
  assert.equal(out.validated.findings.length, 1);
  assert.equal(out.dropped.length, 0);
});
