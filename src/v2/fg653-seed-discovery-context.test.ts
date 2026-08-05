// FG-653: the five red seeds are CONTEXT-AWARE, so a seed-compliant reviewer is not refused
// on the evidence-led discovery path.
//
// The defect: every red seed's "Review-quality fields (AWN-5)" section told the reviewer to
// enrich each finding with `confidence`, `affected_files`, `recommended_fix` and `disposition`.
// None of the four is accepted by DiscoveryFindingSchema, which is deliberately `.strict()` at
// the FINDING level (FG-650 tolerated unknown ROOT keys only). A red that followed its own seed
// on a discovery dispatch therefore had its ENTIRE lens output refused `malformed_output` — and
// an incomplete panel is recorded as nobody having reviewed that lens.
//
// The fix is a CONTEXT SPLIT IN THE PROSE, not a schema change: nested strictness is untouched,
// the four keys are still refused inside a discovery finding, and the legacy verdict path keeps
// its enrichment. So this suite binds the two halves that can drift apart independently:
//   - the seeds STATE the discovery rule (mechanically, all five, at the point AWN-5 is stated);
//   - the SCHEMA still refuses exactly the four keys the seeds name, and still fails closed on
//     an invented one.
// A test that only read the prose would pass forever after a schema change; a test that only
// exercised the schema would pass after a seed edit dropped the rule. Both are here.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import {
  findingsForReview,
  getReview,
  insertReview,
  markDocsDispatchDelivered,
  openDocsDispatch,
} from "../store/reviews.js";
import { RISK_LENSES, lensRole } from "./review-contract.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import { gradeFindings } from "./review-quality.js";
import type { Finding, Run } from "../types/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** FG-654: the Forge-owned protocol — which is where AWN-5 is stated — moved OUT of the
 *  operator-authored agent seed into its own generation-published file. The contract a
 *  dispatched agent receives is both halves, in compose order, so that is what is read. */
const roleContract = (role: string): string =>
  `${readFileSync(join(repoRoot, "seeds", "agent-protocols", `${role}.md`), "utf8")}\n\n` +
  `${readFileSync(join(repoRoot, "seeds", "agents", role, "CLAUDE.md"), "utf8")}`;

/** The AWN-5 section only. The rule has to be stated where AWN-5 is stated — a caveat filed
 *  elsewhere in a 160-line seed is one the reviewer reads after it has already emitted. */
function awn5Section(role: string): string {
  const md = roleContract(role);
  const start = md.indexOf("## Review-quality fields (AWN-5)");
  assert.notEqual(start, -1, `${role}: the AWN-5 section is missing`);
  const rest = md.slice(start + 1);
  const end = rest.indexOf("\n## ");
  return rest.slice(0, end === -1 ? rest.length : end);
}

/** Line wrapping is prose style, not contract — normalize it away so an editor may rewrap. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The four AWN-5 enrichment keys a discovery finding must NOT carry. Named here once so the
 *  prose assertion and the schema assertion below are about the same set. */
const FORBIDDEN_ON_DISCOVERY = ["confidence", "affected_files", "recommended_fix", "disposition"] as const;

const LENS_ROLES = RISK_LENSES.map(lensRole);

// ─── AC-2: all five seeds carry the context-specific rule ───────────────────

test("FG-653: every lens seed states, inside its AWN-5 section, that the discovery schema wins", () => {
  for (const role of LENS_ROLES) {
    const section = flat(awn5Section(role));
    assert.ok(
      section.includes("`# Risk-targeted discovery — <lens> lens`"),
      `${role}: the seed must name the dispatch that triggers the rule, or the reviewer cannot tell which path it is on`,
    );
    assert.ok(
      section.includes(
        "`confidence`, `affected_files`, `recommended_fix` and `disposition` are UNKNOWN KEYS inside a discovery finding",
      ),
      `${role}: the four refused keys must be named explicitly`,
    );
    assert.ok(
      section.includes("refuses your ENTIRE lens output as `malformed_output`"),
      `${role}: the mechanical consequence must be stated — the cost is the whole lens, not the one field`,
    );
    assert.ok(
      section.includes("Keep `remediation_advice`; never rename it to `recommended_fix`"),
      `${role}: the seed must keep remediation_advice on the discovery path`,
    );
    assert.ok(
      section.includes("Emit no `disposition` at all"),
      `${role}: a reviewer never authors a disposition on the discovery path`,
    );
    assert.ok(
      section.includes("`finding_type` is the ONE field below that a discovery finding also accepts"),
      `${role}: finding_type IS legal in the discovery schema and must not read as forbidden`,
    );
  }
});

test("FG-653: the rule is stated BEFORE the enrichment bullets, not as a trailing caveat", () => {
  for (const role of LENS_ROLES) {
    const section = awn5Section(role);
    const rule = section.indexOf("DISCOVERY LENS");
    const firstEnrichment = section.indexOf("- `confidence`:");
    assert.notEqual(rule, -1, `${role}: the discovery-context rule is missing`);
    assert.notEqual(firstEnrichment, -1, `${role}: the legacy enrichment bullets are missing`);
    assert.ok(
      rule < firstEnrichment,
      `${role}: the reviewer must read the context split before the field it would otherwise emit`,
    );
  }
});

test("FG-653: durable disposition is stated as the ledger's alone, never the reviewer's", () => {
  for (const role of LENS_ROLES) {
    const section = flat(awn5Section(role));
    assert.ok(
      section.includes("authored only by a human or the coordinator through `forge review disposition`"),
      `${role}: the seed must point durable disposition at the ledger`,
    );
    assert.ok(
      section.includes("You never author a durable disposition, on either path"),
      `${role}: and say the reviewer authors none, on either path`,
    );
  }
});

test("FG-653: the legacy verdict enrichment survives in every seed — this is a split, not a deletion", () => {
  for (const role of LENS_ROLES) {
    const section = awn5Section(role);
    for (const key of FORBIDDEN_ON_DISCOVERY) {
      assert.ok(
        section.includes(`- \`${key}\`:`),
        `${role}: the legacy verdict path still accepts ${key} and the seed must still teach it`,
      );
    }
    assert.ok(
      flat(section).includes("On the LEGACY VERDICT path above (`verdict` + `findings`), enrich each finding"),
      `${role}: the enrichment must be attributed to the legacy path rather than left unqualified`,
    );
  }
});

// ─── the prose is bound to the schema it describes ─────────────────────────

test("FG-653: each key the seeds forbid is in fact refused by the discovery schema, and finding_type is not", async () => {
  for (const key of FORBIDDEN_ON_DISCOVERY) {
    const h = harness({ findingOver: { [key]: key === "confidence" ? 0.9 : "x" } });
    const outcome = await driveToDiscovery(h.deps);
    assert.equal(outcome.status, "refused", `a discovery finding carrying ${key} must not validate`);
    assert.match(outcome.message, /malformed_output/);
  }

  const ok = harness({ findingOver: { finding_type: "correctness" } });
  const advanced = await driveToDiscovery(ok.deps);
  assert.equal(advanced.status, "advanced", "finding_type IS legal in the discovery schema");
  assert.equal(findingsForReview(REVIEW)[0]?.findingType, "correctness");
});

// ─── AC-1: a seed-compliant discovery result ingests through the real path ──

test("FG-653: a result authored exactly as the amended seeds instruct ingests, findings intact", async () => {
  const h = harness();
  const outcome = await driveToDiscovery(h.deps);

  assert.equal(
    outcome.status,
    "advanced",
    `a seed-compliant discovery output must complete the panel — got: ${outcome.message}`,
  );
  assert.deepEqual(h.calls, [...RISK_LENSES], "every selected lens was dispatched");

  const findings = findingsForReview(REVIEW);
  assert.equal(findings.length, RISK_LENSES.length, "one finding per lens survived ingestion");
  for (const lens of RISK_LENSES) {
    const f = findings.find((x) => x.riskLens === lens);
    assert.ok(f, `the ${lens} lens finding reached the ledger`);
    assert.equal(f.summary, `${lens}: the reconcile path writes before it commits`);
    assert.equal(f.evidence, `src/store/reviews.ts:${lineFor(lens)} — and src/v2/review-run.ts, also implicated`);
    assert.equal(f.reachability, "supported");
    assert.equal(f.findingType, "correctness");
    assert.equal(f.file, "src/store/reviews.ts");
    assert.equal(f.invariantRef, "no partial write");
    assert.equal(f.disposition, "untriaged", "the ledger — not the reviewer — decides disposition");
  }

  // FG-650's root tolerance is what carries the harness-mandated keys; it is untouched here.
  const stage = getReview(REVIEW)?.stageEvidence?.["discovery"];
  assert.ok(stage, "the discovery stage was recorded");
  assert.equal((stage.meta?.["toleratedRootKeys"] as unknown[])?.length, RISK_LENSES.length);
});

// ─── AC-3: an invented nested key still fails closed ───────────────────────

test("FG-653: an invented key inside a finding is still refused whole — nested strictness is unchanged", async () => {
  const h = harness({ findingOver: { blast_radius: "the whole reconcile path" } });
  const outcome = await driveToDiscovery(h.deps);

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /discovery is INCOMPLETE/);
  assert.match(outcome.message, /malformed_output/);
  assert.equal(findingsForReview(REVIEW).length, 0, "a refused lens ingests nothing");
  assert.equal(getReview(REVIEW)?.stageEvidence?.["discovery"], undefined, "and records no stage");
});

// ─── AC-4: the legacy verdict path keeps its enrichment ────────────────────

test("FG-653: a legacy verdict finding carrying every AWN-5 field still grades and keeps them", () => {
  const legacy: Finding = {
    severity: "high",
    summary: "the reconcile path writes before it commits",
    evidence: "src/store/reviews.ts:410",
    hypothesis: "a crash between the write and the commit leaves a partial row",
    file: "src/store/reviews.ts",
    line: 410,
    quoted_text: "if (!committed) throw new Error('refusing a partial write');",
    finding_type: "correctness",
    confidence: 0.9,
    affected_files: ["src/store/reviews.ts", "src/v2/review-run.ts"],
    recommended_fix: "commit inside the same transaction as the write",
    disposition: "confirmed",
  };

  const graded = gradeFindings([legacy]);
  assert.equal(graded.rejected.length, 0, "the legacy path still accepts the AWN-5 enrichment");
  assert.equal(graded.graded.length, 1);
  assert.equal(graded.graded[0]?.downgraded, false);
  assert.deepEqual(graded.graded[0]?.finding, legacy, "every enrichment field survives grading unchanged");
});

// ─── harness ────────────────────────────────────────────────────────────────

const RUN: Run = {
  id: "run-fg653",
  workflow: "feature",
  title: "fg653",
  status: "active",
  createdAt: "2026-07-31T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg653";
const CANDIDATE = "cand653";
const CONTRACT = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["no partial write"],
  acceptance_refs: ["FG-653 AC 1"],
  risk_lenses: [...RISK_LENSES],
  non_goals: ["loosening nested validation"],
};

const lineFor = (lens: string): number => (RISK_LENSES as readonly string[]).indexOf(lens) + 400;

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-653",
    reviewMode: "evidence_led",
    baseSha: "base653",
    candidateSha: CANDIDATE,
    contract: CONTRACT,
    state: "confirming_contract",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

/** The result.json a red authors when it follows the AMENDED seed on a discovery dispatch:
 *  the harness output contract's root keys (tolerated since FG-650), the discovery `outcome` +
 *  `findings` shape, `finding_type` as the one AWN-5 field that survives, `remediation_advice`
 *  rather than `recommended_fix`, every implicated file named in `evidence` rather than in an
 *  `affected_files` array, and no `confidence` or `disposition` anywhere inside a finding. */
function seedCompliantResult(lens: string, over: Record<string, unknown>): unknown {
  return {
    status: "complete",
    verdict: "fail",
    confidence: 0.9,
    notes: `the ${lens} lens reviewed the reconcile path`,
    invariants_verified: ["no partial write"],
    outcome: "fail",
    findings: [
      {
        summary: `${lens}: the reconcile path writes before it commits`,
        evidence: `src/store/reviews.ts:${lineFor(lens)} — and src/v2/review-run.ts, also implicated`,
        severity: "high",
        risk_lens: lens,
        reachability: "supported",
        challenges_contract: false,
        remediation_advice: "advice: consider committing inside the same transaction as the write",
        finding_type: "correctness",
        file: "src/store/reviews.ts",
        line: lineFor(lens),
        quoted_text: "if (!committed) throw new Error('refusing a partial write');",
        invariant_ref: "no partial write",
        ...over,
      },
    ],
  };
}

/** FG-655: the durable docs-dispatch binding a stubbed `dispatchDocs` must create, exactly as
 *  the real wiring does — the row exists before the dispatch, and the host-minted task
 *  identity is written onto it. The re-entry short-circuit reads this row, so a stub that
 *  returned a binding the store does not hold would be a stub that cannot be re-entered. */
function docsBinding(reviewId: string, candidateSha: string, taskId = "task-docs-1") {
  const opened = openDocsDispatch(reviewId, candidateSha);
  return markDocsDispatchDelivered(opened.id, { taskId });
}

function harness(opts: { findingOver?: Record<string, unknown> } = {}): { deps: CoordinatorDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CoordinatorDeps = {
    headSha: () => CANDIDATE,
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" }),
    changedPaths: () => ["src/store/reviews.ts"],
    diff: () => "--- a/src/store/reviews.ts",
    proposeContract: ({ changedPaths }) => ({ candidateSha: "", changedPaths }),
    dispatchLens: (ctx) => {
      calls.push(ctx.lens);
      return {
        lens: ctx.lens,
        role: ctx.role,
        dispatched: true,
        taskId: `task-${ctx.lens}`,
        result: seedCompliantResult(ctx.lens, opts.findingOver ?? {}),
      };
    },
    materializeFixBatch: (ctx) => ctx.payload,
    dispatchFixer: () => ({ ok: false, taskId: "", error: "not reached" }),
    commitFixCycle: () => ({ kind: "no_change", sha: CANDIDATE }),
    // FG-655: a durably-bound docs dispatch whose agent declares nothing against a clean
    // tree — the legitimate no-op. This suite never reaches Stage 6, but the seams are
    // required members, so a stub that lied about them would be worse than none.
    dispatchDocs: ({ review, candidateSha }) => ({ ok: true, binding: docsBinding(review.id, candidateSha) }),
    docsDelivery: ({ binding }) => ({ kind: "delivered", taskId: binding.taskId ?? "task-docs", docsUpdated: [] }),
    commitDocsCycle: () => ({ kind: "no_change", sha: CANDIDATE }),
    dispatchRechecker: () => ({ ok: false, error: "not reached" }),
    shippingInput: () => {
      throw new Error("the shipping stage is not reached by this suite");
    },
  };
  return { deps, calls };
}

/** Run the real stage machine until discovery has run, and return ITS outcome. Nothing about
 *  the reviewer's output is pre-validated on the way: it travels dispatchLens → assessLens →
 *  normalization → ingestFindings exactly as a container's result.json does. */
async function driveToDiscovery(deps: CoordinatorDeps) {
  for (let i = 0; i < 6; i++) {
    const outcome = await runNextStage(REVIEW, deps);
    if (outcome.transition.kind === "discover") return outcome;
    assert.equal(outcome.status, "advanced", `stage ${outcome.transition.kind} did not advance: ${outcome.message}`);
  }
  assert.fail("discovery was never reached");
}
