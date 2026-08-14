// FG-524: capability-keyed anti-bypass guard for the implementer-completion seams.
//
// FG-523 put the ONE reading of the tests_run contract in
// src/v2/validation-contract.ts (evaluateValidationContract). FG-524 extended it
// to the two markTaskComplete seams that used to bypass it: fanout implementer
// CHILDREN (validated by holding the fanout PARENT at awaiting_gate) and ad-hoc
// `forge invoke` completions (WARN — complete + a named advisory, no hold). The
// hazard this guard exists to prevent is a FOURTH completion seam that quietly
// finalizes an implementer result without going through the declared policy.
//
// A guard that pins today's call sites by line/name is defeated by the next
// caller. So this keys on CAPABILITY: it enumerates EVERY markTaskComplete( call
// site in the source, resolves each to its enclosing top-level function, and
// requires that function to be ACCOUNTED FOR by the declared policy — either its
// seam consults evaluateValidationContract (directly, or via the
// holdIfValidationContractFails / warnIfValidationContractFails wrappers, or a
// named upstream seam that does), or it is on an explicit, rationale-annotated
// exemption set with a CAPABILITY class saying why the contract does not apply
// there. A markTaskComplete caller in a function that is on neither list FAILS
// the guard — the next seam cannot be added silently.
//
// Precedent: the source-scanning dispatch guards fg612-dispatch-guard.test.ts and
// self-host-guard.test.ts. Like those, this asserts a structural property of the
// tree, not a runtime behavior — the seams' behavior is proven by
// fg524-fanout-validation-hold.worktree.test.ts and
// fg524-invoke-validation-warn.integration.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // <repo>/src
const REPO_ROOT = dirname(SRC_ROOT);

// The evaluator lives in exactly one module; these are its ONLY sanctioned
// entrypoints. A seam "consults the evaluator" iff its function body references
// one of these — the two wrappers are proven to bottom out in
// evaluateValidationContract by the one-evaluator test below.
const EVALUATOR_ENTRYPOINTS = [
  "evaluateValidationContract",
  "holdIfValidationContractFails",
  "warnIfValidationContractFails",
];

// ─────────────────────────────────────────────────────────────────────────────
// The declared policy. Keyed by "<repo-relative file>::<enclosing function>",
// NOT by line number — a site that moves lines is still accounted for; a site in
// a NEW function is not. Every markTaskComplete( caller in the tree must appear
// here, or the guard fails.
//
//  - evaluator-gated  : the seam's own body calls an evaluator entrypoint.
//                       Verified: that call is present.
//  - covered-upstream : the seam completes an implementer result, but a NAMED
//                       upstream seam evaluates the contract before this site can
//                       run. Verified: the upstream seam exists and consults the
//                       evaluator (and, for the primary, is actually invoked on
//                       the path that reaches this site).
//  - non-implementer  : the seam only ever completes a non-implementer role, for
//                       which evaluateValidationContract returns held:false.
//  - human-gated      : the site lands only after a human `forge gate --advance`
//                       decision — the gate override IS the validation decision;
//                       re-holding would bounce the operator's own advance.
//  - recovery-sweep   : crash-recovery of a result the container already produced
//                       for an invoke-like run; the invoke dispatch seam is the
//                       WARN surface, and this path never completes a workflow
//                       primary (it fails them unfinalized).
//  - orchestrator-meta: completes an orchestrator/session bookkeeping task row,
//                       not a dispatched agent result — no agentRole, so the
//                       contract's implementer set never applies.
// ─────────────────────────────────────────────────────────────────────────────
type PolicyClass =
  | "evaluator-gated"
  | "covered-upstream"
  | "non-implementer"
  | "human-gated"
  | "recovery-sweep"
  | "orchestrator-meta";

type PolicyEntry = {
  class: PolicyClass;
  rationale: string;
  // For covered-upstream only: the seam(s) that evaluate the contract before this
  // site can complete. Each must exist and reference an evaluator entrypoint.
  upstream?: { file: string; fn: string; alsoCalledIn?: { file: string; fn: string } }[];
};

const POLICY: Record<string, PolicyEntry> = {
  // ── The FG-524 seams and the FG-523 primary ───────────────────────────────
  "src/v2/runNext.ts::finalizePrimary": {
    class: "covered-upstream",
    rationale:
      "FG-523 primary completion. holdIfValidationContractFails runs on the primary " +
      "path (dispatchSingleStep) BEFORE finalizePrimary, so a held result never reaches here.",
    upstream: [
      {
        file: "src/v2/runNext.ts",
        fn: "holdIfValidationContractFails",
        alsoCalledIn: { file: "src/v2/runNext.ts", fn: "dispatchSingleStep" },
      },
    ],
  },
  "src/v2/runNext.ts::dispatchFanoutStep": {
    class: "evaluator-gated",
    rationale:
      "FG-524 fanout parent-hold: each completed implementer CHILD is run through " +
      "evaluateValidationContract here; any held child holds the PARENT at awaiting_gate. " +
      "The markTaskComplete in this region is the synthetic parent aggregate on the " +
      "red-rejection path (landFanoutBlockedByRed) — exempt in its own right, and gated all the same.",
  },
  "src/v2/runNext.ts::runFanoutChild": {
    class: "covered-upstream",
    rationale:
      "FG-524: the child completes so its result is available to the parent's aggregate " +
      "validation; dispatchFanoutStep evaluates each child and holds the parent if any fails, " +
      "so this child completion is gated at the parent seam.",
    upstream: [{ file: "src/v2/runNext.ts", fn: "dispatchFanoutStep" }],
  },
  "src/v2/invoke.ts::dispatchInvokeTask": {
    class: "evaluator-gated",
    rationale:
      "FG-524 invoke WARN: both markTaskComplete sites (the FG-337 inferred-result path and " +
      "the main completion) call warnIfValidationContractFails first — an implementer " +
      "complete-without-tests_run completes but emits an advisory task.validation_warning.",
  },

  // ── Post-gate landings: the human advance IS the validation decision ───────
  "src/v2/gate.ts::gate": {
    class: "human-gated",
    rationale:
      "`forge gate --advance` in-place completion. Reached only after an operator advance " +
      "decision — the documented recovery verb for a validation-held primary or fanout parent. " +
      "Re-holding here would bounce the operator's own advance.",
  },
  "src/v2/runNext.ts::republishForcedPrimary": {
    class: "human-gated",
    rationale:
      "FG-353 forced-advance re-entry: completes a primary whose gate was advanced with --force. " +
      "The advance decision is already recorded; re-gating would bounce it back to awaiting_gate.",
  },

  // ── Non-implementer / recovery / orchestrator seams ───────────────────────
  "src/v2/runNext.ts::runOneRed": {
    class: "non-implementer",
    rationale:
      "Completes a RED task. Reds are outside IMPLEMENTER_ROLES, so evaluateValidationContract " +
      "returns held:false for them — validating here would be a no-op.",
  },
  "src/v2/reconcile.ts::reconcileRun": {
    class: "recovery-sweep",
    rationale:
      "Crash-recovery sweep. Both sites are gated by isInvokeLikeRun — a workflow/pipeline task " +
      "is failed-unfinalized (failPipelineUnfinalized), never completed here. It recovers an " +
      "invoke-like result the container already produced; the invoke dispatch seam is the WARN " +
      "surface for that role. Known residual: reconcile does not re-emit the invoke WARN, but it " +
      "opens no new work-completion path.",
  },
  "src/cli/commands/design.ts::captureDesignUsage": {
    class: "orchestrator-meta",
    rationale:
      "Settles a design-session bookkeeping task ({note}/{rowCount}) — orchestrator meta-state, " +
      "not a dispatched agent result. No agentRole, so the implementer set never applies.",
  },
  "src/orchestrator/codex-adapter.ts::createCodexAdapter": {
    class: "orchestrator-meta",
    rationale:
      "settleOrchestratorTask completes the OUTER orchestrator's own task row (exitCode/signal), " +
      "not a dispatched implementer result.",
  },
  "src/orchestrator/claude-adapter.ts::createClaudeAdapter": {
    class: "orchestrator-meta",
    rationale:
      "settleOrchestratorTask completes the OUTER orchestrator's own task row (exitCode/signal), " +
      "not a dispatched implementer result.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure source helpers (operate on an in-memory Map so the negative tests can
// inject synthetic seams without touching disk).
// ─────────────────────────────────────────────────────────────────────────────

const DECL_PATTERNS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[:=]/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
];

/** A top-level (column-0) declaration name, or null. Nested declarations are
 *  indented, so they never match — the enclosing SEAM is the top-level function,
 *  which is the granularity the policy is keyed at. */
function topLevelDeclName(line: string): string | null {
  for (const re of DECL_PATTERNS) {
    const m = line.match(re);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Blank the contents of block and line comments while preserving newlines and
 *  offsets, so a `markTaskComplete(` mentioned in prose is never read as a call.
 *  String literals are left intact — a call token inside a string is not a real
 *  call site either, but none exist and leaving them avoids quote-tracking bugs. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
      i = stop;
    } else if (two === "//") {
      let k = i;
      while (k < n && src[k] !== "\n") k++;
      out += " ".repeat(k - i);
      i = k;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

type Site = { file: string; fn: string; line: number };

/** Every markTaskComplete( call site in `src`, resolved to its enclosing
 *  top-level function. The markTaskComplete DEFINITION (store/tasks.ts) is not a
 *  call and is skipped. */
function completionSites(file: string, src: string): Site[] {
  const clean = stripComments(src);
  const rawLines = src.split("\n");
  const cleanLines = clean.split("\n");
  const sites: Site[] = [];
  let currentFn = "<module>";
  for (let i = 0; i < cleanLines.length; i++) {
    const cleanLine = cleanLines[i] ?? "";
    const decl = topLevelDeclName(cleanLine);
    if (decl) currentFn = decl;
    if (!/markTaskComplete\s*\(/.test(cleanLine)) continue;
    // The definition itself (`function markTaskComplete(` / `const markTaskComplete =`).
    if (/(?:function|const|let|var)\s+markTaskComplete\b/.test(rawLines[i] ?? "")) continue;
    sites.push({ file, fn: currentFn, line: i + 1 });
  }
  return sites;
}

/** The source region of a top-level function: from its column-0 declaration to
 *  (exclusive) the next column-0 declaration. Enough to test whether the seam's
 *  body references a token. Returns "" if the function is not found. */
function functionRegion(src: string, fn: string): string {
  const clean = stripComments(src).split("\n");
  let start = -1;
  for (let i = 0; i < clean.length; i++) {
    if (topLevelDeclName(clean[i] ?? "") === fn) {
      start = i;
      break;
    }
  }
  if (start === -1) return "";
  let end = clean.length;
  for (let i = start + 1; i < clean.length; i++) {
    if (topLevelDeclName(clean[i] ?? "") !== null) {
      end = i;
      break;
    }
  }
  return clean.slice(start, end).join("\n");
}

/** Does the top-level function `fn` in `src` consult the ONE evaluator? Checks
 *  its region for a call to an evaluator entrypoint, EXCLUDING self-references —
 *  a wrapper (holdIf.../warnIf...) is itself an entrypoint, and its own
 *  declaration line would otherwise read as a call to itself and mask a gutted body. */
function seamConsultsEvaluator(src: string, fn: string): boolean {
  const region = functionRegion(src, fn).replace(new RegExp(`\\b${fn}\\s*\\(`, "g"), "SELFREF ");
  return EVALUATOR_ENTRYPOINTS.some((e) => new RegExp(`\\b${e}\\s*\\(`).test(region));
}

type Unaccounted = { site: Site; why: string };

/** The core audit. Returns every markTaskComplete caller the policy does not
 *  account for — a non-empty result is the guard failing. */
function audit(sources: Map<string, string>): { sites: Site[]; unaccounted: Unaccounted[] } {
  const sites: Site[] = [];
  for (const [file, src] of sources) sites.push(...completionSites(file, src));

  const unaccounted: Unaccounted[] = [];
  for (const site of sites) {
    const key = `${site.file}::${site.fn}`;
    const entry = POLICY[key];
    if (!entry) {
      unaccounted.push({
        site,
        why:
          `${key} completes a task but is not in the FG-524 policy. Route it through ` +
          `evaluateValidationContract, or add a rationale-annotated exemption if it cannot ` +
          `carry an implementer result.`,
      });
      continue;
    }
    if (entry.class === "evaluator-gated") {
      if (!seamConsultsEvaluator(sources.get(site.file) ?? "", site.fn)) {
        unaccounted.push({
          site,
          why: `${key} is declared evaluator-gated but its body calls no evaluator entrypoint.`,
        });
      }
    }
    if (entry.class === "covered-upstream") {
      for (const up of entry.upstream ?? []) {
        if (!seamConsultsEvaluator(sources.get(up.file) ?? "", up.fn)) {
          unaccounted.push({
            site,
            why: `${key} is covered-upstream by ${up.file}::${up.fn}, but that seam calls no evaluator entrypoint.`,
          });
        }
        if (up.alsoCalledIn) {
          const callerRegion = functionRegion(sources.get(up.alsoCalledIn.file) ?? "", up.alsoCalledIn.fn);
          if (!new RegExp(`\\b${up.fn}\\s*\\(`).test(callerRegion)) {
            unaccounted.push({
              site,
              why: `${key}: upstream ${up.fn} is not invoked in ${up.alsoCalledIn.file}::${up.alsoCalledIn.fn} — the primary path is no longer gated.`,
            });
          }
        }
      }
    }
  }
  return { sites, unaccounted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read the real tree (all non-test .ts under src/, keyed repo-relative).
// ─────────────────────────────────────────────────────────────────────────────
function readRealSources(): Map<string, string> {
  const files = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts"))
    .map((p) => join(SRC_ROOT, p));
  const map = new Map<string, string>();
  for (const abs of files) {
    map.set(relative(REPO_ROOT, abs).split("\\").join("/"), readFileSync(abs, "utf8"));
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("the shipped tree has no unaccounted implementer-completion seam", () => {
  const { sites, unaccounted } = audit(readRealSources());
  assert.ok(sites.length >= 10, `expected the known completion seams to be discovered, found ${sites.length}`);
  assert.deepEqual(
    unaccounted,
    [],
    "unaccounted markTaskComplete seam(s):\n" + unaccounted.map((u) => `  ${u.site.file}:${u.site.line} — ${u.why}`).join("\n"),
  );
});

// The resolver is the guard's foundation: if enclosing-function resolution ever
// drifts (a regex/template hazard, a refactor), accounting silently mis-attributes.
// Pin the known anchor sites so drift fails loudly instead of hiding a bypass.
test("the resolver attributes every known seam to the expected enclosing function", () => {
  const sources = readRealSources();
  const byKey = new Map<string, Site[]>();
  for (const [file, src] of sources) {
    for (const s of completionSites(file, src)) {
      const k = `${s.file}::${s.fn}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s);
    }
  }
  for (const expected of [
    "src/v2/runNext.ts::finalizePrimary",
    "src/v2/runNext.ts::dispatchFanoutStep",
    "src/v2/runNext.ts::runFanoutChild",
    "src/v2/runNext.ts::runOneRed",
    "src/v2/runNext.ts::republishForcedPrimary",
    "src/v2/invoke.ts::dispatchInvokeTask",
    "src/v2/gate.ts::gate",
    "src/v2/reconcile.ts::reconcileRun",
  ]) {
    assert.ok(byKey.has(expected), `expected a completion seam at ${expected}; resolver found none`);
  }
});

// Every policy entry must correspond to a real site — a stale entry (seam removed
// or renamed) means the policy is describing a tree that no longer exists, and a
// stale evaluator-gated entry could mask a genuinely new bypass under an old name.
test("no policy entry is stale — every declared seam still completes a task", () => {
  const { sites } = audit(readRealSources());
  const liveKeys = new Set(sites.map((s) => `${s.file}::${s.fn}`));
  const stale = Object.keys(POLICY).filter((k) => !liveKeys.has(k));
  assert.deepEqual(stale, [], `policy names seam(s) that no longer complete a task: ${stale.join(", ")}`);
});

// The whole point of the ticket: a FOURTH implementer-completion seam cannot be
// added silently. A new function that completes a task is unaccounted until a
// human classifies it.
test("a NEW markTaskComplete caller in a new file FAILS the guard", () => {
  const sources = readRealSources();
  sources.set(
    "src/v2/sneaky-seam.ts",
    [
      "export function completeAnImplementerBehindThePolicy(taskId: string, result: unknown): void {",
      "  // no evaluateValidationContract in sight",
      "  markTaskComplete(taskId, result);",
      "}",
    ].join("\n"),
  );
  const { unaccounted } = audit(sources);
  assert.ok(
    unaccounted.some((u) => u.site.fn === "completeAnImplementerBehindThePolicy"),
    "a brand-new completion seam must be flagged unaccounted",
  );
});

test("a NEW markTaskComplete caller added to an existing file FAILS the guard", () => {
  const sources = readRealSources();
  const gate = sources.get("src/v2/gate.ts")!;
  sources.set(
    "src/v2/gate.ts",
    gate + "\n\nexport function anotherCompletionPath(taskId: string, r: unknown): void {\n  markTaskComplete(taskId, r);\n}\n",
  );
  const { unaccounted } = audit(sources);
  assert.ok(
    unaccounted.some((u) => u.site.fn === "anotherCompletionPath"),
    "a new completion function in an existing file must be flagged",
  );
});

// The verify sub-checks must BITE: an evaluator-gated seam that drops its
// evaluator call, or a covered-upstream seam whose upstream loses the gate, is a
// silent reopening of the bypass and must fail the guard.
test("an evaluator-gated seam that drops its evaluator call FAILS the guard", () => {
  const sources = readRealSources();
  const invoke = sources.get("src/v2/invoke.ts")!;
  // Remove every warn/evaluate call from dispatchInvokeTask's reach.
  const gutted = invoke.replace(/warnIfValidationContractFails\s*\(/g, "noop_removed_gate(");
  sources.set("src/v2/invoke.ts", gutted);
  const { unaccounted } = audit(sources);
  assert.ok(
    unaccounted.some((u) => u.site.file === "src/v2/invoke.ts" && /evaluator-gated/.test(u.why)),
    "removing the evaluator call from an evaluator-gated seam must fail verification",
  );
});

test("a covered-upstream seam whose upstream loses the gate FAILS the guard", () => {
  const sources = readRealSources();
  const runNext = sources.get("src/v2/runNext.ts")!;
  // Neuter holdIfValidationContractFails so the primary path's upstream no longer
  // consults the evaluator.
  const gutted = runNext.replace(/evaluateValidationContract\s*\(/g, "noop_removed_eval(");
  sources.set("src/v2/runNext.ts", gutted);
  const { unaccounted } = audit(sources);
  assert.ok(
    unaccounted.some((u) => u.site.fn === "finalizePrimary" && /covered-upstream/.test(u.why)),
    "a covered-upstream seam must fail once its upstream stops consulting the evaluator",
  );
});

test("a covered-upstream seam whose upstream is no longer invoked FAILS the guard", () => {
  const sources = readRealSources();
  const runNext = sources.get("src/v2/runNext.ts")!;
  // Drop the invocation of holdIfValidationContractFails from dispatchSingleStep,
  // leaving its definition intact.
  const gutted = runNext.replace(/const contractHold = holdIfValidationContractFails\(/, "const contractHold = null && noop_uninvoked(");
  assert.notEqual(gutted, runNext, "fixture: the primary-path invocation must be present to remove");
  sources.set("src/v2/runNext.ts", gutted);
  const { unaccounted } = audit(sources);
  assert.ok(
    unaccounted.some((u) => u.site.fn === "finalizePrimary" && /is not invoked/.test(u.why)),
    "the primary seam must fail once its upstream gate is no longer called on the path",
  );
});

// Accounting must not be keyed on line numbers: shifting a site down the file
// leaves it accounted for.
test("accounting is stable under line shifts — it is not keyed on line numbers", () => {
  const sources = readRealSources();
  const invoke = sources.get("src/v2/invoke.ts")!;
  sources.set("src/v2/invoke.ts", "// padding\n// padding\n// padding\n" + invoke);
  const { unaccounted } = audit(sources);
  assert.deepEqual(unaccounted, [], "shifting a seam's lines must not make it unaccounted");
});

// The one-evaluator constraint, enforced at guard level: the wrappers bottom out
// in evaluateValidationContract, and no seam grew its own copy of the contract's
// role set or waiver field.
test("the wrappers resolve to the ONE evaluator", () => {
  const invoke = readFileSync(join(SRC_ROOT, "v2", "invoke.ts"), "utf8");
  const runNext = readFileSync(join(SRC_ROOT, "v2", "runNext.ts"), "utf8");
  assert.ok(
    seamConsultsEvaluator(invoke, "warnIfValidationContractFails"),
    "warnIfValidationContractFails must call evaluateValidationContract",
  );
  assert.ok(
    seamConsultsEvaluator(runNext, "holdIfValidationContractFails"),
    "holdIfValidationContractFails must call evaluateValidationContract",
  );
});

test("the contract vocabulary lives ONLY in validation-contract.ts — no seam grew its own copy", () => {
  const sources = readRealSources();
  for (const token of ["const IMPLEMENTER_ROLES", "const WAIVER_FIELD", "function evaluateValidationContract"]) {
    const owners = [...sources.entries()].filter(([, src]) => stripComments(src).includes(token)).map(([f]) => f);
    assert.deepEqual(
      owners,
      ["src/v2/validation-contract.ts"],
      `${token} must be defined only in validation-contract.ts, found in: ${owners.join(", ")}`,
    );
  }
});
