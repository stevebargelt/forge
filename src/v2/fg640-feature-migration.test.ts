// FG-640: the `feature` workflow migration — the explicit cutover and risk-targeted lens
// selection.
//
// AC scenarios placed here because this is where the migration decides them:
//   #16 — `feature` selects only the declared risk lenses, not all discipline reds.
//   #23 — drift beyond the approved lenses is settled by contract confirmation/amendment;
//         changed paths NEVER move the panel on their own (review-contract.test.ts proves the
//         confirmation half; here we prove the SELECTION half — that a path-driven guess has
//         no way to reach the dispatcher).
//   #27 — a coordinator-added lens (with evidence) widens the panel; a refused removal leaves
//         it wide, because the panel is the contract and a refused change is not a change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { WorkflowSchema } from "./schema.js";
import { confirmContract, selectRedsForContract, lensForRole, type ReviewContract } from "./review-contract.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function seedWorkflow(name: string): unknown {
  const parsed = WorkflowSchema.safeParse(parseYaml(readFileSync(resolve(repoRoot, "seeds", "workflows", `${name}.yml`), "utf8")));
  assert.ok(parsed.success, `seeds/workflows/${name}.yml did not parse: ${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

type ParsedWorkflow = {
  name: string;
  review_mode: string;
  steps: Array<{ id: string; gate: string; reds: Array<{ agent: string; authority: string; gate_on_verdict: boolean }> }>;
};

const FEATURE = seedWorkflow("feature") as ParsedWorkflow;
const BUILD = FEATURE.steps.find((s) => s.id === "build")!;

const APPROVED: ReviewContract = {
  threat_model: "a backend write path that can lose data under concurrent publication",
  protected_invariants: ["publication is CAS-guarded"],
  acceptance_refs: ["FG-640 AC 16"],
  risk_lenses: ["backend", "security"],
  non_goals: [],
  lens_scopes: { backend: ["src/store/"], security: ["src/util/creds.ts"] },
};

// ── the explicit cutover ─────────────────────────────────────────────────────

test("FG-640: `feature` declares the cutover in the WORKFLOW — not in a command flag", () => {
  assert.equal(FEATURE.review_mode, "evidence_led");
});

test("FG-640: build's six reds are all advisory under the cutover — no authority left to combine", () => {
  assert.equal(BUILD.reds.length, 6);
  for (const red of BUILD.reds) {
    assert.equal(red.authority, "specialist", `${red.agent} still claims authoritative authority`);
    assert.equal(red.gate_on_verdict, false, `${red.agent} still gates on its verdict`);
  }
});

test("FG-640: build stays at `gate: verdict` — the review_disposition gate takes that POSITION, no new status", () => {
  assert.equal(BUILD.gate, "verdict");
});

// Data-driven over the shipped seed set, so a workflow migrated later without being named
// here reddens rather than sliding through. FG-640 migrates `feature` and nothing else — the
// PRD's "keep the coexistence window short" is a schedule, not a licence to migrate quietly.
test("FG-640: every OTHER shipped workflow keeps the legacy authority model", () => {
  const dir = resolve(repoRoot, "seeds", "workflows");
  const others = readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .filter((n) => n !== "feature");
  assert.ok(others.length > 0, "no other seed workflows to compare against — this guard is inert");
  for (const name of others) {
    const wf = seedWorkflow(name) as ParsedWorkflow;
    assert.equal(wf.review_mode, "legacy_verdict", `${name} was migrated without being named in FG-640`);
    for (const step of wf.steps) {
      for (const red of step.reds) {
        assert.ok(
          typeof red.authority === "string",
          `${name}/${step.id}/${red.agent} lost its declared authority`,
        );
      }
    }
  }
});

test("FG-640: review_mode DEFAULTS to legacy_verdict — a workflow that says nothing changes nothing", () => {
  const parsed = WorkflowSchema.safeParse({
    name: "silent",
    description: "says nothing about review mode",
    steps: [{ id: "only", agent: "engineer", gate: "auto" }],
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.review_mode, "legacy_verdict");
});

// ── AC #16 ───────────────────────────────────────────────────────────────────

test("FG-640 / PRD #16: `feature` selects only the contract's declared risk lenses", () => {
  const { selected, skipped } = selectRedsForContract(BUILD.reds, APPROVED);
  assert.deepEqual(selected.map((r) => r.agent).sort(), ["red-backend", "red-security", "shipping-reviewer"]);
  assert.deepEqual(skipped.map((r) => r.agent).sort(), ["red-frontend", "red-narrow", "red-wide"]);
});

test("FG-640 / PRD #16: the shipping reviewer is not a risk lens, so it is never selected away", () => {
  assert.equal(lensForRole("shipping-reviewer"), undefined);
  const narrow = selectRedsForContract(BUILD.reds, {
    ...APPROVED,
    risk_lenses: ["narrow"],
    lens_scopes: { narrow: ["src/store/"] },
  });
  assert.ok(narrow.selected.some((r) => r.agent === "shipping-reviewer"));
  assert.deepEqual(narrow.selected.map((r) => r.agent).sort(), ["red-narrow", "shipping-reviewer"]);
});

test("FG-640: with NO approved contract, selection fails closed WIDER — every declared red runs", () => {
  for (const absent of [undefined, null, {}, { risk_lenses: [] }, "backend"]) {
    const { selected, skipped } = selectRedsForContract(BUILD.reds, absent);
    assert.equal(selected.length, 6, `an unapproved contract (${JSON.stringify(absent)}) narrowed the panel`);
    assert.equal(skipped.length, 0);
  }
});

// ── AC #23 ───────────────────────────────────────────────────────────────────

test("FG-640 / PRD #23: changed file paths cannot reach the panel — selection reads the contract only", () => {
  // The frontend lens is NOT approved. A diff that is entirely frontend paths must not
  // conjure it: the only input `selectRedsForContract` takes is the contract.
  const frontendHeavy = ["dashboard/src/App.tsx", "dashboard/src/styles.css", "dashboard/src/routes.tsx"];
  const confirmed = confirmContract(APPROVED, { candidateSha: "cand1", changedPaths: frontendHeavy });
  assert.equal(confirmed.kind, "confirmed");
  assert.deepEqual(confirmed.kind === "confirmed" ? confirmed.contract.risk_lenses : [], ["backend", "security"]);

  const { selected } = selectRedsForContract(BUILD.reds, confirmed.kind === "confirmed" ? confirmed.contract : undefined);
  assert.ok(!selected.some((r) => r.agent === "red-frontend"), "a path guess added a lens");
});

test("FG-640 / PRD #23: drift the coordinator cannot classify returns to plan and NEVER narrows the panel", () => {
  const returned = confirmContract(APPROVED, {
    candidateSha: "cand2",
    unclassifiableDrift: "the diff adds a new IPC surface I cannot map to a lens",
    changedPaths: ["src/ipc/bridge.ts"],
  });
  assert.equal(returned.kind, "returns_to_plan");
  // Nothing was confirmed, so nothing selects: the approved contract still governs, unchanged.
  const { selected } = selectRedsForContract(BUILD.reds, APPROVED);
  assert.deepEqual(selected.map((r) => r.agent).sort(), ["red-backend", "red-security", "shipping-reviewer"]);
});

// ── AC #27 ───────────────────────────────────────────────────────────────────

test("FG-640 / PRD #27: a coordinator-added lens with recorded evidence WIDENS the dispatched panel", () => {
  const widened = confirmContract(APPROVED, {
    candidateSha: "cand3",
    widening: [
      {
        lens: "frontend",
        reason: "the final diff adds a rendered operator surface the approved contract did not cover",
        diffEvidence: ["dashboard/src/ReviewLedger.tsx (new file, 240 lines)"],
        scopePaths: ["dashboard/src/ReviewLedger.tsx"],
      },
    ],
    changedPaths: ["dashboard/src/ReviewLedger.tsx"],
  });
  assert.equal(widened.kind, "confirmed");
  assert.deepEqual(widened.kind === "confirmed" ? widened.addedLenses : [], ["frontend"]);

  const { selected } = selectRedsForContract(BUILD.reds, widened.kind === "confirmed" ? widened.contract : undefined);
  assert.deepEqual(selected.map((r) => r.agent).sort(), [
    "red-backend",
    "red-frontend",
    "red-security",
    "shipping-reviewer",
  ]);
});

test("FG-640 / PRD #27: a REFUSED removal leaves the panel wide — the contract is what selects", () => {
  const removal = confirmContract(APPROVED, {
    candidateSha: "cand4",
    contract: { ...APPROVED, risk_lenses: ["backend"], lens_scopes: { backend: APPROVED.lens_scopes.backend } },
  });
  assert.equal(removal.kind, "needs_approving_authority");
  assert.deepEqual(removal.kind === "needs_approving_authority" ? removal.removedLenses : [], ["security"]);

  // The refused proposal never becomes a contract, so the security lens still dispatches.
  const { selected } = selectRedsForContract(BUILD.reds, APPROVED);
  assert.ok(selected.some((r) => r.agent === "red-security"), "a refused removal narrowed the panel anyway");
});

test("FG-640 / PRD #27: changing the threat model cannot narrow the panel either", () => {
  const rewrite = confirmContract(APPROVED, {
    candidateSha: "cand5",
    contract: {
      ...APPROVED,
      threat_model: "nothing much can go wrong here",
      risk_lenses: ["narrow"],
      lens_scopes: { narrow: ["src/store/"] },
    },
  });
  assert.equal(rewrite.kind, "needs_approving_authority");
  assert.deepEqual(
    rewrite.kind === "needs_approving_authority" ? rewrite.changedFields : [],
    ["threat_model"],
  );
});
