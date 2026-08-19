// FG-733: `forge review continue --acceptance/--docs-closeout` validates the JSON SHAPE at the
// read site. The file used to be cast straight to `AcClaim[]` and handed to the shipping stage,
// so an object like `{acceptance_criteria:[…]}` threw a raw `TypeError: claims.map is not a
// function` — a stack trace where every other malformed input on this command names its shape.
//
// Driven through the REAL `registerReview` command in-process (no container dispatch): the
// validation lives in `depsFor`, ahead of workspace resolution, so a wrong shape refuses at input
// time. The negative arms assert the actionable refusal; the positive arm asserts that a valid
// top-level array passes validation and control reaches the (unrelated) workspace refusal.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertReview } from "../../store/reviews.js";
import { registerReview } from "./review.js";
import { AcClaimsSchema } from "../../v2/review-evidence.js";
import { DocsCloseoutSchema } from "../../v2/review-shipping.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let workDir: string;

beforeEach(() => {
  prev = null;
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  workDir = mkdtempSync(join(tmpdir(), "fg733-"));
  insertReview({
    id: "review-fg733",
    reviewMode: "evidence_led",
    ticketId: "FG-733",
    baseSha: "base000",
    candidateSha: "cand111",
    contract: {
      threat_model: "operator_trusted_candidate",
      risk_lenses: ["wide"],
      lens_scopes: { wide: ["src/"] },
    },
    state: "awaiting_disposition",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function continueWith(flag: string, value: unknown): Promise<string> {
  const file = join(workDir, "input.json");
  writeFileSync(file, JSON.stringify(value));
  const err: string[] = [];
  mock.method(console, "log", () => {});
  mock.method(console, "error", (...a: unknown[]) => {
    err.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    registerReview(program);
    await program.parseAsync(["review", "continue", "review-fg733", flag, file], { from: "user" });
    return err.join("\n");
  } finally {
    mock.restoreAll();
    // The command signals a refused invocation with `process.exitCode = 1`; clear it so a
    // deliberately-refused arm does not fail the whole test process.
    process.exitCode = 0;
  }
}

test("FG-733: --acceptance as an OBJECT refuses with the top-level-array shape, not claims.map", async () => {
  const err = await continueWith("--acceptance", { acceptance_criteria: [{ ref: "AC-1", verdict: "met" }] });
  assert.doesNotMatch(err, /claims\.map is not a function/);
  assert.match(err, /--acceptance must be a top-level ARRAY/);
  assert.match(err, /Received an object with keys \[acceptance_criteria\]/);
  assert.match(err, /Minimal valid example:/);
});

test("FG-733: --acceptance with a `met` claim missing evidence refuses actionably", async () => {
  const err = await continueWith("--acceptance", [{ ref: "AC-1", verdict: "met" }]);
  assert.doesNotMatch(err, /claims\.map is not a function/);
  assert.match(err, /--acceptance must be a top-level ARRAY/);
  assert.match(err, /evidence.*must cite `evidence`|evidence: a claim with verdict/);
});

test("FG-733: --acceptance whose element 0 is missing `ref` names the field", async () => {
  const err = await continueWith("--acceptance", [{ verdict: "unmet" }]);
  assert.match(err, /--acceptance must be a top-level ARRAY/);
  assert.match(err, /0\.ref/);
});

test("FG-733: --docs-closeout missing `gaps` refuses actionably", async () => {
  const err = await continueWith("--docs-closeout", { assessed: true });
  assert.doesNotMatch(err, /is not a function/);
  assert.match(err, /--docs-closeout must be an OBJECT/);
  assert.match(err, /gaps/);
  assert.match(err, /Minimal valid example:/);
});

test("FG-733: --docs-closeout given an array (object required) refuses actionably", async () => {
  const err = await continueWith("--docs-closeout", [{ assessed: true, gaps: [] }]);
  assert.match(err, /--docs-closeout must be an OBJECT/);
  assert.match(err, /Received an array of 1 element/);
});

test("FG-733: a valid top-level --acceptance array passes validation (reaches the workspace refusal)", async () => {
  const err = await continueWith("--acceptance", [
    { ref: "AC-1", verdict: "met", evidence: { kind: "bounded_inspection", inspection: "read the guard", limitation: "not executed" } },
    { ref: "AC-2", verdict: "unmet" },
  ]);
  // Validation passed — the ONLY refusal left is the unrelated "no workspace" one.
  assert.doesNotMatch(err, /--acceptance must be/);
  assert.match(err, /records no workspace/);
});

test("FG-733: schemas accept the documented valid shapes", () => {
  assert.equal(
    AcClaimsSchema.safeParse([
      { ref: "AC-1", verdict: "met", evidence: { kind: "bounded_inspection", inspection: "x", limitation: "y" } },
      { ref: "AC-2", verdict: "unmet" },
      { ref: "AC-3", verdict: "unproven" },
    ]).success,
    true,
  );
  assert.equal(DocsCloseoutSchema.safeParse({ assessed: true, gaps: [] }).success, true);
  assert.equal(DocsCloseoutSchema.safeParse({ assessed: false, gaps: ["docs/concepts.md acceptance section"], detail: "todo" }).success, true);
});
