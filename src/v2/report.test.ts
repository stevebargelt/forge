import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import type { Run } from "../types/index.js";
import { buildReportMarkdown, resolveReportPath } from "./report.js";
import type { SynthesizeResult } from "./report.js";

// report.ts transitively imports the SQLite store — initialize an in-memory DB
// so the module loads cleanly even though these tests never touch the database.
let db: DatabaseInstance;
let prev: DatabaseInstance | null;

before(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

after(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-abcdefgh12345678",
    workflow: "research-synthesis",
    title: "Does X cause Y?",
    status: "complete",
    createdAt: "2026-06-01T00:00:00Z",
    projectDir: "/home/user/myproject",
    ...overrides,
  };
}

const FULL_RESULT: SynthesizeResult = {
  status: "complete",
  overall_summary:
    "The evidence strongly supports claim A. Claim B remains inconclusive due to conflicting data. Overall, X is likely a contributing factor to Y.",
  claims: [
    {
      id: "c1",
      claim: "X increases Y by 20%",
      verdict: "supported",
      confidence: "high",
      evidence: "Three independent studies confirm a 15–25% increase.",
      disagreements: "Branch-skeptic noted one outlier study showing no effect.",
    },
    {
      id: "c2",
      claim: "X has no long-term effects",
      verdict: "inconclusive",
      confidence: "low",
      evidence: "Only short-term data available.",
      disagreements: "Both branches agree data is insufficient.",
    },
  ],
};

// (a) buildReportMarkdown with full result including overall_summary
test("buildReportMarkdown: renders question, summary, and all claims", () => {
  const md = buildReportMarkdown("Does X cause Y?", FULL_RESULT);

  // H1 contains the question
  assert.ok(md.includes("# Does X cause Y?"), "missing H1 with question");

  // overall_summary text is present
  assert.ok(
    md.includes("The evidence strongly supports claim A."),
    "missing overall_summary content"
  );

  // Per-claim H2 sections
  assert.ok(md.includes("## X increases Y by 20%"), "missing claim 1 heading");
  assert.ok(md.includes("## X has no long-term effects"), "missing claim 2 heading");

  // Verdict and confidence for claim 1
  assert.ok(md.includes("SUPPORTED"), "missing verdict for claim 1");
  assert.ok(md.includes("high"), "missing confidence for claim 1");

  // Evidence text
  assert.ok(
    md.includes("Three independent studies confirm"),
    "missing evidence for claim 1"
  );

  // Disagreements text
  assert.ok(
    md.includes("Branch-skeptic noted one outlier"),
    "missing disagreements for claim 1"
  );

  // Verdict for claim 2
  assert.ok(md.includes("INCONCLUSIVE"), "missing verdict for claim 2");
});

// (b) buildReportMarkdown without overall_summary — no crash, no undefined/null literals
test("buildReportMarkdown: handles missing overall_summary gracefully", () => {
  const resultWithoutSummary: SynthesizeResult = {
    status: "complete",
    claims: [
      {
        id: "c1",
        claim: "Z is real",
        verdict: "refuted",
        confidence: "medium",
        evidence: "No evidence found.",
        disagreements: "Branches agree.",
      },
    ],
  };

  let md: string;
  assert.doesNotThrow(() => {
    md = buildReportMarkdown("Is Z real?", resultWithoutSummary);
  }, "buildReportMarkdown must not throw when overall_summary is absent");

  md = buildReportMarkdown("Is Z real?", resultWithoutSummary);

  // No 'undefined' or 'null' literals in output
  assert.ok(!md.includes("undefined"), "output must not contain literal 'undefined'");
  assert.ok(!md.includes("null"), "output must not contain literal 'null'");

  // H1 and per-claim sections still render
  assert.ok(md.includes("# Is Z real?"), "missing H1");
  assert.ok(md.includes("## Z is real"), "missing claim heading");
  assert.ok(md.includes("REFUTED"), "missing verdict");
});

// (c) resolveReportPath: uses run.metadata.reportOutputPath when present
test("resolveReportPath: returns metadata.reportOutputPath when set", () => {
  const run = makeRun({
    metadata: { reportOutputPath: "/custom/output/report.md" },
  });

  const path = resolveReportPath(run);
  assert.equal(path, "/custom/output/report.md");
});

// (d) resolveReportPath: builds deterministic path from projectDir + title + run id suffix
test("resolveReportPath: builds <projectDir>/research/<slug>-<8-char-id>.md when no override", () => {
  const run = makeRun(); // id ends in "12345678"

  const path = resolveReportPath(run);

  assert.ok(
    path.startsWith("/home/user/myproject/research/"),
    `expected path under projectDir/research/, got: ${path}`
  );

  // Sanitized title: "Does X cause Y?" -> "does-x-cause-y"
  assert.ok(path.includes("does-x-cause-y"), `expected sanitized title in path, got: ${path}`);

  // Last 8 chars of run.id = "12345678"
  assert.ok(path.includes("12345678"), `expected last 8 chars of run id in path, got: ${path}`);

  assert.ok(path.endsWith(".md"), "path must end with .md");
});
