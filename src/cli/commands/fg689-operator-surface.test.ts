// FG-689 step 9: THE OPERATOR SURFACE FOR SHARDS.
//
// A shard set that is deterministic, reproducible and recorded is only operationally
// load-bearing if an operator can ACT on one shard of it and READ what each one delivered.
// Everything here is about that half:
//
//   * `forge review show` renders the plan as EXPECTED VS DELIVERED, and renders the three
//     states a shard can be in as THREE DISTINCT FORMS. "A skip is distinguishable at the gate
//     from a lens that produced no outcome" is an acceptance criterion, and it is only true
//     operationally if it is distinguishable in what an operator reads — an assessor that
//     returns three arrays into a render that prints two lines has not delivered it.
//   * `forge review accept-lens --shard <n>` carries D16's rule through to the terminal: the
//     shardless acceptance is refused BY NAME the moment a plan names shards, and an
//     acceptance of shard 1 leaves shard 2 blocking.
//   * The two flag parsers refuse a malformed spec by name rather than coercing it. A shard
//     index that took a different value than the operator typed would retry — or clear — a
//     shard they did not name, which is the same fail-open from the keyboard.
//
// Asserted on the HUMAN output, following FG-638's rule for this surface: the refusal and the
// render an operator has to act on are the text printed to a terminal.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import {
  getReview,
  insertReview,
  mergeLensOutcomesByShard,
  recordLensSkipped,
  recordShardPlan,
  type ShardDerivation,
} from "../../store/reviews.js";
import { registerReview } from "./review.js";
import { parseRetryShards, parseShardBudget } from "./review-wiring.js";
import { DEFAULT_SHARD_BUDGET, SHARD_BUDGET_UNIT, shardPlanDigest } from "../../v2/review-shards.js";
import { REVIEW_DIFF_RENDERING_ID } from "../../v2/review-diff.js";
import type { Run } from "../../types/index.js";

const RUN: Run = {
  id: "run-fg689-ops",
  workflow: "feature",
  title: "shard operator surface",
  status: "active",
  createdAt: "2026-08-07T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg689-ops";
const CONF = "conf689ops";

const CONTRACT = {
  threat_model: "a shard that crashed and was never read must not be cleared by one acceptance",
  protected_invariants: ["an operator acceptance clears exactly the shard it names"],
  acceptance_refs: ["FG-689 AC3", "FG-689 D16"],
  risk_lenses: ["wide", "backend", "security"],
  non_goals: ["a path classifier of any kind"],
  lens_scopes: {
    wide: ["src/"],
    backend: ["src/store/"],
    security: ["src/util/creds.ts"],
  },
};

const DERIVATION: ShardDerivation = {
  baseSha: "base689ops",
  candidateSha: CONF,
  renderingId: REVIEW_DIFF_RENDERING_ID,
  budget: DEFAULT_SHARD_BUDGET,
  unit: SHARD_BUDGET_UNIT,
  envelopes: {},
  budgetValidatedRuntime: "unvalidated",
  scopesDigest: "scopes689ops",
};
const DIGEST = shardPlanDigest(DERIVATION);

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

type Captured = { out: string; err: string };

async function runCli(argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  mock.method(console, "log", (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  mock.method(console, "error", (...a: unknown[]) => {
    err.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    registerReview(program);
    await program.parseAsync(argv, { from: "user" });
    return { out: out.join("\n"), err: err.join("\n") };
  } finally {
    mock.restoreAll();
  }
}

/** A review parked AFTER a discovery pass that left the panel in all three states at once:
 *  `wide` shard 1 authored, `wide` shard 2 crashed, `backend` shard 1 never dispatched, and
 *  `security` intentionally skipped because its authored scope matched no changed path. */
function seedPartiallyDeliveredReview(): void {
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-689",
    reviewMode: "evidence_led",
    baseSha: DERIVATION.baseSha,
    candidateSha: CONF,
    contractConfirmedSha: CONF,
    contract: CONTRACT,
    state: "discovering",
  });

  recordShardPlan(REVIEW, {
    derivation: DERIVATION,
    digest: DIGEST,
    fanoutWidth: 4,
    lenses: [
      {
        lens: "backend",
        shards: [{ index: 1, of: 1, paths: ["src/store/reviews.ts"], chars: 900 }],
      },
      {
        lens: "wide",
        shards: [
          { index: 1, of: 2, paths: ["src/store/reviews.ts"], chars: 900 },
          { index: 2, of: 2, paths: ["src/v2/review-run.ts"], chars: 1200 },
        ],
      },
    ],
    skipped: [{ lens: "security", reason: "zero_in_scope_paths" }],
  });

  recordLensSkipped(REVIEW, {
    lens: "security",
    reason: "zero_in_scope_paths",
    derivationDigest: DIGEST,
    candidateSha: CONF,
  });

  mergeLensOutcomesByShard(REVIEW, [
    {
      lens: "wide",
      role: "red-wide",
      complete: true,
      authored: true,
      outcome: "pass",
      findings: [],
      shard: { index: 1, of: 2 },
      derivationDigest: DIGEST,
      taskId: "task-wide-1",
    },
    {
      lens: "wide",
      role: "red-wide",
      complete: false,
      reason: "crashed",
      detail: "the container exited before writing result.json",
      shard: { index: 2, of: 2 },
      derivationDigest: DIGEST,
      taskId: "task-wide-2",
    },
  ]);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  seedPartiallyDeliveredReview();
  process.exitCode = undefined;
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  process.exitCode = undefined;
});

// ─── forge review show: expected vs delivered ───────────────────────────────

test("FG-689: `forge review show` renders the shard plan as expected-vs-delivered per lens", async () => {
  const { out } = await runCli(["review", "show", REVIEW]);

  assert.match(out, /Shard plan \(expected vs delivered\):/);
  assert.match(out, new RegExp(`partition:\\s+${DIGEST}`));
  assert.match(out, new RegExp(`derivation:\\s+base689ops\\.\\.${CONF} rendered by `));
  // FG-689 RF-1: the budget bounds the COMPOSED input, so the line says so. Reading it as a
  // diff allowance is the misreading that shipped the defect — the dogfood's largest shard was
  // 593,919 bytes of diff under a 600,000 budget, with the envelope on top of it, unmeasured.
  assert.match(
    out,
    new RegExp(
      `shard budget:\\s+${DEFAULT_SHARD_BUDGET} ${SHARD_BUDGET_UNIT} per COMPOSED input \\(diff \\+ dispatch envelope\\)`,
    ),
    "the budget must travel with its UNIT and say what it bounds (D10/D4)",
  );
  assert.match(out, /validated against:\s+unvalidated/, "and with the runtime a real dispatch proved it against");
  assert.match(out, /envelope reserve:\s+/, "and what was reserved out of it, per lens");
  assert.match(out, /fan-out width:\s+4/);

  assert.match(out, /wide: 2 shard\(s\) planned, 1 delivered/);
  assert.match(out, /backend: 1 shard\(s\) planned, 0 delivered/);
  // The path list is what makes "shard 2 of 2" mean something to a reader.
  assert.match(out, /shard 2 of 2 — no outcome[\s\S]*src\/v2\/review-run\.ts/);
});

test("FG-689: intentionally skipped, no outcome, and accepted missing evidence are THREE distinct rendered forms", async () => {
  // Accept `backend` shard 1 so all three states are on one render at once.
  const accepted = await runCli([
    "review",
    "accept-lens",
    REVIEW,
    "backend",
    "--shard",
    "1",
    "--operator",
    "--missing-evidence",
    "the store writers were never read by a backend reviewer",
    "--rationale",
    "the change is covered by the wide lens and the shard crashed twice",
  ]);
  assert.equal(accepted.err, "", accepted.err);

  const { out } = await runCli(["review", "show", REVIEW]);

  const skipped = /security: intentionally skipped \(zero in-scope paths\)/;
  const noOutcome = /shard 2 of 2 — no outcome \(crashed: the container exited before writing result\.json\)/;
  const acceptedForm = /shard 1 of 1 — accepted missing evidence: the store writers were never read/;

  assert.match(out, skipped, "a lens with nothing in scope must render as intentionally skipped");
  assert.match(out, noOutcome, "a shard that owes an outcome and has none must render as no outcome");
  assert.match(out, acceptedForm, "an accepted shard must render as an acceptance, never as a review");

  // ...and the three are genuinely different lines, not one form matched three ways.
  const lines = out.split("\n");
  const matched = [skipped, noOutcome, acceptedForm].map((re) => lines.findIndex((l) => re.test(l)));
  assert.ok(matched.every((i) => i >= 0), "each form must appear on its own line");
  assert.equal(new Set(matched).size, 3, "the three states collapsed onto fewer than three lines");

  // A skip is never rendered as a delivered outcome, and never as an absence.
  assert.doesNotMatch(out, /security:.*delivered/);
  assert.doesNotMatch(out, /security:.*no outcome/);
});

test("FG-689: the delivered shard renders its authored outcome, and accepting shard 1 leaves shard 2 blocking", async () => {
  const before = await runCli(["review", "show", REVIEW]);
  assert.match(before.out, /shard 1 of 2 — delivered pass \(1 path\(s\), 900 utf8_bytes\)/);

  const accepted = await runCli([
    "review",
    "accept-lens",
    REVIEW,
    "wide",
    "--shard",
    "1",
    "--operator",
    "--missing-evidence",
    "irrelevant — shard 1 already authored",
    "--rationale",
    "asserting that an acceptance does not blanket the lens",
  ]);
  assert.equal(accepted.err, "", accepted.err);

  const after = await runCli(["review", "show", REVIEW]);
  assert.match(after.out, /shard 2 of 2 — no outcome \(crashed/, "shard 2 must still block after shard 1 is accepted");
  assert.match(
    after.out,
    /lens accepted:\s+wide — missing evidence:[^\n]*, shard 1\)/,
    "the acceptance line must NAME the shard it cleared",
  );
});

// ─── forge review accept-lens --shard ───────────────────────────────────────

test("FG-689 D16: accept-lens on a SHARDED lens without --shard refuses by name and writes nothing", async () => {
  const { err } = await runCli([
    "review",
    "accept-lens",
    REVIEW,
    "wide",
    "--operator",
    "--missing-evidence",
    "shard 2 crashed",
    "--rationale",
    "one acceptance for the whole lens",
  ]);

  assert.match(err, /was dispatched as 2 shard\(s\), so an acceptance must NAME the one it clears/);
  assert.match(err, /--shard <1\.\.2>/);
  assert.match(err, /clear shards that crashed and were never read/);
  assert.equal(process.exitCode, 1);

  const outcomes = getReview(REVIEW)?.lensOutcomes as unknown[];
  assert.equal(
    outcomes.filter((r) => (r as { kind?: string }).kind === "lens_acceptance").length,
    0,
    "the refusal must write nothing",
  );
});

test("FG-689: accept-lens --shard names a shard that does not exist, and refuses by name", async () => {
  const { err } = await runCli([
    "review",
    "accept-lens",
    REVIEW,
    "wide",
    "--shard",
    "3",
    "--operator",
    "--missing-evidence",
    "x",
    "--rationale",
    "y",
  ]);
  assert.match(err, /--shard 3 is not one of the wide lens's shards — the recorded plan names 1\.\.2/);
  assert.equal(process.exitCode, 1);
});

test("FG-689: accept-lens --shard refuses a non-integral index rather than coercing it", async () => {
  for (const bad of ["2.7", "0", "-1", "two", "1e0"]) {
    process.exitCode = undefined;
    const { err } = await runCli([
      "review",
      "accept-lens",
      REVIEW,
      "wide",
      "--shard",
      bad,
      "--operator",
      "--missing-evidence",
      "x",
      "--rationale",
      "y",
    ]);
    assert.match(err, /--shard expects a whole number from 1/, `--shard ${bad} was not refused`);
    assert.equal(process.exitCode, 1, `--shard ${bad} did not exit nonzero`);
  }
});

test("FG-689: the recorded acceptance is stamped with the partition it was made against (D17)", async () => {
  const { out } = await runCli([
    "review",
    "accept-lens",
    REVIEW,
    "wide",
    "--shard",
    "2",
    "--operator",
    "--missing-evidence",
    "the container crashed twice at shard 2",
    "--rationale",
    "shipping with a named gap in coverage",
    "--json",
  ]);
  const recorded = JSON.parse(out) as { shard?: number; derivationDigest?: string; kind?: string };
  assert.equal(recorded.kind, "lens_acceptance");
  assert.equal(recorded.shard, 2);
  assert.equal(recorded.derivationDigest, DIGEST, "an unstamped acceptance cannot be detected as superseded");
});

// ─── the flag parsers ───────────────────────────────────────────────────────

test("FG-689: --retry-shard parses <lens>:<index> and refuses everything else by name", () => {
  const ok = parseRetryShards(["wide:2", "backend:1"]);
  assert.deepEqual(ok, { ok: true, shards: [{ lens: "wide", index: 2 }, { lens: "backend", index: 1 }] });

  for (const bad of ["wide", "wide:2:3", ""]) {
    const r = parseRetryShards([bad]);
    assert.equal(r.ok, false, `'${bad}' was accepted`);
    if (!r.ok) assert.match(r.refusal, /--retry-shard expects <lens>:<index>/);
  }

  const unknownLens = parseRetryShards(["frontned:1"]);
  assert.equal(unknownLens.ok, false);
  if (!unknownLens.ok) assert.match(unknownLens.refusal, /is not a risk lens\. The vocabulary is fixed/);

  // A coerced index would retry a shard the operator did not name.
  for (const bad of ["wide:0", "wide:-1", "wide:2.0", "wide:+2", "wide:0x2", "wide:two"]) {
    const r = parseRetryShards([bad]);
    assert.equal(r.ok, false, `'${bad}' was accepted`);
    if (!r.ok) assert.match(r.refusal, /the shard index must be a whole number from 1/);
  }
});

test("FG-689 D10: --shard-budget refuses anything but a whole positive number, and states the UNIT", () => {
  const ok = parseShardBudget("450000");
  assert.deepEqual(ok, { ok: true, budget: 450_000 });

  for (const bad of ["0", "-1", "600_000", "6e5", "600000.5", "lots", ""]) {
    const r = parseShardBudget(bad);
    assert.equal(r.ok, false, `'${bad}' was accepted`);
    if (!r.ok) {
      assert.match(r.refusal, new RegExp(`whole positive number of ${SHARD_BUDGET_UNIT}`));
      assert.match(r.refusal, new RegExp(`default is ${DEFAULT_SHARD_BUDGET} ${SHARD_BUDGET_UNIT}`));
    }
  }
});

// ─── a review with no plan is untouched ─────────────────────────────────────

test("FG-689: a review with no recorded shard plan renders no shard section and accepts a lens as it did before", async () => {
  insertReview({
    id: "review-fg689-unplanned",
    runId: RUN.id,
    ticketId: "FG-689",
    reviewMode: "evidence_led",
    contractConfirmedSha: CONF,
    candidateSha: CONF,
    contract: CONTRACT,
    state: "discovering",
  });

  const shown = await runCli(["review", "show", "review-fg689-unplanned"]);
  assert.doesNotMatch(shown.out, /Shard plan/);

  const accepted = await runCli([
    "review",
    "accept-lens",
    "review-fg689-unplanned",
    "wide",
    "--operator",
    "--missing-evidence",
    "no plan exists, so there is no shard to name",
    "--rationale",
    "pre-FG-689 behaviour is unchanged where the fact does not exist",
  ]);
  assert.equal(accepted.err, "");
  assert.match(accepted.out, /the wide lens's missing evidence is accepted by operator/);

  // ...and naming a shard against a review that has no plan is refused, not silently accepted.
  process.exitCode = undefined;
  const named = await runCli([
    "review",
    "accept-lens",
    "review-fg689-unplanned",
    "backend",
    "--shard",
    "1",
    "--operator",
    "--missing-evidence",
    "x",
    "--rationale",
    "y",
  ]);
  assert.match(named.err, /--shard 1 names a shard that does not exist: review review-fg689-unplanned has no recorded shard plan/);
});
