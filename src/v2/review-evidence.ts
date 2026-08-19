// FG-639 (evidence-led review, Change 2): what counts as evidence.
//
// A SKIPPED TEST IS NEVER EVIDENCE (operator, 2026-07-29). That is the rule this module
// exists to make mechanical, and it is stricter than it first sounds:
//
//   - Execution is established PER TEST, from the runner's own output. A suite that
//     exited green while the cited test printed `# SKIP` proves nothing about the cited
//     assertion, and "the suite passed" is exactly the shape of that mistake.
//   - A cited test that does not APPEAR in the runner output is not evidence either.
//     Absence is unproven, not passing.
//   - When no mandatory lane executed a required assertion, the coverage is recorded
//     `not_executed` — or `blocked_environment` when the environment itself could not
//     run it — and the finding stays `inconclusive`. Never green. Never resolved.
//   - Alternate-lane coverage must NAME the lane, the candidate SHA, and the executed
//     assertion, AND carry that lane's own runner-output execution record for it. Naming a
//     lane is not an execution record: the alternate lane is held to exactly the per-test
//     identity the primary lane is, so a lane that cannot show its assertion executing
//     resolves nothing. Unnamed "covered elsewhere" is refused at ingestion, and a lane
//     whose sha is not this candidate's is refused by name. AND THE LANE MUST COVER EVERY
//     TEST THE CLAIM NAMES: a lane that executed one of the two assertions a claim names
//     has rescued one of them, and the other executed nowhere at all.
//
// AND RESOLUTION EVIDENCE IS PROPORTIONAL TO THE FINDING'S ORIGINAL REACHABILITY:
//
//   demonstrated ⇒ a named regression test, a replayed reproduction, or an equivalent
//                  deterministic proof. Model re-inspection can never close it.
//   supported    ⇒ anchored contradictory evidence PLUS an EXECUTED verification step.
//   speculative  ⇒ bounded inspection, with its limitation stated explicitly.
//
// AND EXECUTION IS ESTABLISHED IN THE RUNNER'S OWN TERMS. The TAP/glyph parser answers
// "did this test run" about a TEST RUNNER's output; a typecheck, a curl or a script has no
// TAP in it, so a non-test step carries {command, output, exit_status} and is judged on the
// exit status its own runner returned. A step whose output or exit shows FAILURE is refused
// as resolution evidence by name — a red check is the finding still being present.
//
// "Named regression test" names a BEHAVIOR/INVARIANT in the canonical subsystem suite.
// It does not mean, and must not become, one new finding- or ticket-named test file per
// finding (FG-641 owns consolidating the existing ticket-named suite; this lifecycle's
// job is to stop adding to it).

import { z } from "zod";
import type { Reachability } from "./review-discovery.js";

export const RESOLUTION_EVIDENCE_KINDS = [
  "regression_test",
  "replayed_reproduction",
  "anchored_verification",
  "bounded_inspection",
] as const;
export type ResolutionEvidenceKind = (typeof RESOLUTION_EVIDENCE_KINDS)[number];

/** A claim that another mandatory lane executed the same assertion. Every field is
 *  required because each one is a thing an unnamed claim leaves out: WHICH lane ran it,
 *  at WHICH candidate, WHICH assertion, and — the one naming alone can never supply —
 *  the lane's OWN runner output establishing that the assertion executed there.
 *
 *  `executed_assertion` carries the same list semantics `ran` and `test_name` do, and is
 *  checked for CORRESPONDENCE as well as execution: it must name every test the claim it
 *  rescues names.
 *
 *  `runner_output` is optional in the SCHEMA and required by `checkAlternateLane` on
 *  purpose: a claim that omits it must refuse with a reason naming the missing execution
 *  record, and under the coverage outcome the surrounding case calls for
 *  (`blocked_environment` when the environment could not run the check at all), rather
 *  than as a generic union-parse error that loses both. */
const AlternateLaneSchema = z
  .object({
    lane: z.string().trim().min(1),
    candidate_sha: z.string().trim().min(1),
    executed_assertion: z.string().trim().min(1),
    runner_output: z.string().optional(),
  })
  .strict();

export type AlternateLaneClaim = z.infer<typeof AlternateLaneSchema>;

/** `environment_blocked` is a REASON STRING or absent — never a boolean (FG-719). A
 *  rechecker that emits `environment_blocked: false` means "not blocked", which is the field
 *  ABSENT, not a present boolean. Before this normalizer that `false` failed schema parse and
 *  the whole payload was recorded `not_executed`, silently degrading a PASSING regression_test
 *  and wedging a resolved `demonstrated` fix_now. So a boolean is normalized at the boundary:
 *  `false` coerces to absent (the check ran, nothing blocked it), and `true` — a claim of a
 *  block that states no reason — is refused with a message naming the missing reason rather
 *  than the bare "expected string, received boolean" a raw parse produces. */
const EnvironmentBlockedSchema = z.preprocess(
  (v) => (v === false ? undefined : v),
  z
    .string({
      error: (issue) =>
        issue.input === true
          ? "environment_blocked must be a non-empty reason string naming what the environment could not " +
            "run, or be omitted (false) when nothing was blocked — a bare `true` states no reason"
          : undefined,
    })
    .trim()
    .min(1)
    .optional(),
);

const RegressionTestSchema = z
  .object({
    kind: z.literal("regression_test"),
    /** The test's name as the runner prints it. This is what per-test identity is
     *  matched against — a file path alone cannot establish that one test executed. */
    test_name: z.string().trim().min(1),
    /** Where it lives, for a reader. Not what execution is established from. */
    test_file: z.string().trim().min(1).optional(),
    runner_output: z.string().optional(),
    /** Set when the environment could not run the check at all. A non-empty reason string
     *  or absent; a boolean `false` is normalized to absent (see EnvironmentBlockedSchema). */
    environment_blocked: EnvironmentBlockedSchema,
    alternate_lane: AlternateLaneSchema.optional(),
  })
  .strict();

const ReplayedReproductionSchema = z
  .object({
    kind: z.literal("replayed_reproduction"),
    command: z.string().trim().min(1),
    output: z.string().trim().min(1),
  })
  .strict();

/** What a verification step IS, structurally: something that RAN, plus that runner's own
 *  record of it. Prose ("I ran the typecheck") is a claim that a step ran, and the
 *  anchored reading it accompanies is already a claim about the source — two claims are
 *  not a verification.
 *
 *  TWO SHAPES, BECAUSE A VERIFICATION STEP IS NOT ALWAYS A TEST. The TAP/glyph parser
 *  below establishes per-test identity in a TEST RUNNER's output; applied to `tsc`, a
 *  curl, or a shell script it can only ever answer "absent", so holding a typecheck to it
 *  refuses a step that genuinely ran. A non-test step carries the executed identity its
 *  own runner has: the command, its output, and the exit status it returned. */
const TestStepSchema = z
  .object({
    /** ONE FINDING IS OFTEN COVERED BY SEVERAL TESTS, so `ran` names a LIST of test
     *  identities (FG-657). Both shapes are accepted on purpose: the array is the honest
     *  form — it removes the delimiter guess at the source — and is what a step should
     *  carry going forward; the string stays because it is what the rechecker seed
     *  documents and what every claim recorded so far was written as, and refusing those
     *  would discard complete evidence for a formatting reason. A string is split on the
     *  separator agents already join with, and EVERY member the split produces must resolve
     *  on its own — a blank one included (see `ranTestNames`). That is the mechanism that
     *  keeps splitting from widening the gate: a name that genuinely contained "; " becomes
     *  two names nothing matches, and a malformed list like "alpha; ;" refuses on its blank
     *  member instead of validating on the subset that happened to parse. */
    ran: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]),
    runner_output: z.string().trim().min(1),
  })
  .strict();

const CommandStepSchema = z
  .object({
    command: z.string().trim().min(1),
    /** Present, possibly empty: a clean `tsc --noEmit` prints nothing, and refusing that
     *  would refuse the commonest non-test step there is. `exit_status` is what carries
     *  the execution record here. */
    output: z.string(),
    exit_status: z.number().int(),
  })
  .strict();

const ExecutedStepSchema = z.union([TestStepSchema, CommandStepSchema]);

export type ExecutedStep = z.infer<typeof ExecutedStepSchema>;

function isCommandStep(step: ExecutedStep): step is z.infer<typeof CommandStepSchema> {
  return "command" in step;
}

function stepLabel(step: ExecutedStep): string {
  return isCommandStep(step) ? step.command : ranTestNames(step.ran).join("; ");
}

const AnchoredVerificationSchema = z
  .object({
    kind: z.literal("anchored_verification"),
    file: z.string().trim().min(1),
    line: z.number().int().positive(),
    fact: z.string().trim().min(1),
    /** The "plus a relevant verification step" half. Anchored code reading alone is an
     *  argument about the source, not a verification of behavior. */
    verification_step: ExecutedStepSchema,
  })
  .strict();

const BoundedInspectionSchema = z
  .object({
    kind: z.literal("bounded_inspection"),
    inspection: z.string().trim().min(1),
    /** Required: a bounded inspection whose bound is unstated is presented as more than
     *  it is. */
    limitation: z.string().trim().min(1),
  })
  .strict();

export const ResolutionEvidenceSchema = z.discriminatedUnion("kind", [
  RegressionTestSchema,
  ReplayedReproductionSchema,
  AnchoredVerificationSchema,
  BoundedInspectionSchema,
]);

export type ResolutionEvidence = z.infer<typeof ResolutionEvidenceSchema>;

// ─── per-test execution identity ────────────────────────────────────────────

export type TestExecution = "executed" | "skipped" | "failed" | "absent";

const TAP_LINE = /^\s*(not\s+)?ok\s+\d+\s*-?\s*(.+?)\s*$/;
/** RUNNER-EMITTED SHAPES ONLY. The ASCII hyphen used to be in this class, which made every
 *  markdown bullet — `- I ran the typecheck` — parse as a passing test line and read as
 *  EXECUTED. Prose that looks like a list is not a runner's output, so the glyphs are
 *  exactly the ones node:test's spec reporter emits. */
const NODE_GLYPH_LINE = /^\s*([✔✖✗﹣~])\s+(.+?)\s*(?:\(\d+(?:\.\d+)?m?s\))?\s*$/u;
const SKIP_DIRECTIVE = /#\s*(skip|todo)\b/i;

/** Strip the reporter's decorations off a captured test name. Order matters: the skip
 *  directive comes AFTER the duration in the glyph reporter's output, so removing the
 *  duration first leaves it stranded at the end of the name and nothing matches. */
function stripTiming(name: string): string {
  return name
    .replace(/#\s*(skip|todo)\b.*$/i, "")
    .replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, "")
    .trim();
}

/** Did THIS test execute, per the runner's own output?
 *
 *  Handles both shapes node:test emits — TAP (`ok 3 - name`, `ok 4 - name # SKIP`) and
 *  the spec/glyph reporter (`✔ name (1.2ms)`, `﹣ name (0ms) # SKIP`) — plus TAP's
 *  standalone `# SKIP`/`# TODO` directives. Matching is on the test NAME, because a
 *  suite-level exit code cannot distinguish a test that ran from one that was skipped:
 *  that conflation is the entire defect this function exists to catch.
 *
 *  A name that appears both skipped and executed reads as EXECUTED — that is the
 *  parameterized-suite case where one variant skipped and another ran the assertion. A
 *  name that appears only skipped reads as SKIPPED. A name that never appears is ABSENT.
 *  A name that appears FAILED reads as failed wherever else it appears: a red assertion
 *  is the finding still being present, and a green sibling does not cancel it.
 *
 *  FAILURE ALSO DOMINATES A DIRECTIVE ON ITS OWN LINE. `not ok 1 - the guard # TODO` is a
 *  test the runner marked RED, and reading it as skipped is not a harmless downgrade: a
 *  skip is a gap an alternate mandatory lane may legitimately fill, while a failure at this
 *  candidate is the finding still being present and refuses before any lane is consulted.
 *  So the failure test runs BEFORE the skip test, not after it.
 *
 *  A CITED IDENTITY MAY NAME MORE THAN ONE TEST (FG-657), as an array or as the "; "-joined
 *  string agents write. Every named test must have EXECUTED: one absent, skipped or failed
 *  member refuses the whole claim, exactly as it does on its own. A BLANK member is not a
 *  name, so it is ABSENT and refuses too — a malformed list is never validated on whichever
 *  of its members happened to parse. */
export function testExecution(runnerOutput: string, ran: string | readonly string[]): TestExecution {
  return resolveTestExecution(runnerOutput, ran).execution;
}

/** The tests a cited identity names, in the order it names them — BLANK MEMBERS INCLUDED.
 *
 *  Blanks are kept, not filtered. Filtering them made a malformed list validate on the
 *  subset that happened to parse: "alpha; ;", "alpha;;", "; alpha" and ["alpha", ""] all
 *  collapsed to ["alpha"] and passed against output that only ever ran alpha — where the
 *  unsplit string matched no captured name and was refused. That is splitting ACCEPTING
 *  MORE, which is the one thing it must never do.
 *
 *  Of the two ways to close it — keep the blank and resolve it, or refuse the malformed
 *  list outright — this keeps it. A blank names no test, so `absent` is already the true
 *  answer for it, and one rule (every named member must have EXECUTED) then covers a blank
 *  member, a misspelled one and a deleted one alike, at all three surfaces that resolve a
 *  list: a step's `ran`, a cited test's `test_name`, and a lane's `executed_assertion`.
 *  A second "malformed list" vocabulary would have to be threaded through each of them and
 *  could drift from the rule it exists to serve. Refusals name a blank by its position, so
 *  a reader can tell it apart from a name the runner never printed. */
export function ranTestNames(ran: string | readonly string[]): string[] {
  const parts = typeof ran === "string" ? ran.split(/\s*;\s*/) : ran;
  return parts.map((p) => p.trim());
}

/** How one member of a cited list is named in a refusal. A blank member has no name to
 *  print, and printing the empty string reads as a test called nothing. */
function memberLabel(names: readonly string[], index: number): string {
  const name = names[index];
  return name === undefined || name === "" ? `(blank member ${index + 1} of ${names.length})` : name;
}

/** The same answer as `testExecution`, plus WHICH of the named tests produced it — so a
 *  refusal can name the one test that failed the check instead of echoing the whole list
 *  back at a reader who then cannot tell which member was the problem. */
export function resolveTestExecution(
  runnerOutput: string,
  ran: string | readonly string[],
): { execution: TestExecution; test: string } {
  const names = ranTestNames(ran);
  if (names.length === 0) return { execution: "absent", test: typeof ran === "string" ? ran.trim() : "" };

  // A blank member is resolved, never matched. Nothing in any output can establish that a
  // test with no name ran, and handing "" to the matcher would be worse than useless: the
  // empty string is a suffix of every captured name the runner printed.
  const perTest = names.map((name, i) => ({
    test: memberLabel(names, i),
    execution: name === "" ? ("absent" as const) : oneTestExecution(runnerOutput, name),
  }));
  // Failure dominates the LIST exactly as it dominates one name's own lines: a red
  // assertion is the finding still being present, and a sibling that merely skipped —
  // the case an alternate lane may legitimately fill — must not mask it.
  return (
    perTest.find((r) => r.execution === "failed") ??
    perTest.find((r) => r.execution !== "executed") ?? { execution: "executed", test: names.join("; ") }
  );
}

function oneTestExecution(runnerOutput: string, wanted: string): TestExecution {
  let sawSkipped = false;
  let sawExecuted = false;

  for (const rawLine of runnerOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const tap = TAP_LINE.exec(line);
    const glyph = tap ? null : NODE_GLYPH_LINE.exec(line);
    const captured = tap?.[2] ?? glyph?.[2];
    if (captured === undefined) continue;

    const name = stripTiming(captured);
    if (name !== wanted && !name.endsWith(` > ${wanted}`) && !name.startsWith(`${wanted} > `)) continue;

    if (tap?.[1] !== undefined || /^\s*[✖✗]/u.test(line)) return "failed";
    if (SKIP_DIRECTIVE.test(line) || /^\s*[﹣~]/u.test(line)) {
      sawSkipped = true;
      continue;
    }
    sawExecuted = true;
  }
  return sawExecuted ? "executed" : sawSkipped ? "skipped" : "absent";
}

/** Did the cited VERIFICATION STEP execute and succeed? Kind-aware on purpose: a test
 *  step is held to the same per-test identity a cited regression test is, and a non-test
 *  step is held to its own runner's exit status. Neither can be satisfied by prose. */
function checkVerificationStep(step: ExecutedStep): { ok: true } | { ok: false; refusal: string } {
  if (isCommandStep(step)) {
    if (step.exit_status !== 0) {
      return {
        ok: false,
        refusal:
          `'${step.command}', which exited ${step.exit_status} — a verification step that FAILED is never ` +
          `resolution evidence, in any lane or any evidence kind`,
      };
    }
    return { ok: true };
  }
  const named = ranTestNames(step.ran);
  const { execution, test } = resolveTestExecution(step.runner_output, step.ran);
  if (execution === "executed") return { ok: true };
  return {
    ok: false,
    refusal:
      `'${test}'${named.length > 1 ? ` (one of the ${named.length} tests that step names)` : ""}` +
      `, but the output it carries shows that step ` +
      (execution === "skipped"
        ? `SKIPPED — a skipped check is never evidence, in any lane or any evidence kind`
        : execution === "failed"
          ? `FAILED — a failed check is never resolution evidence, in any lane or any evidence kind`
          : `nowhere at all, so nothing establishes that it ran`),
  };
}

// ─── validation ─────────────────────────────────────────────────────────────

/** How coverage is RECORDED when it was not executed. Never green, never resolved. */
export const COVERAGE_OUTCOMES = ["executed", "not_executed", "blocked_environment"] as const;
export type CoverageOutcome = (typeof COVERAGE_OUTCOMES)[number];

export type EvidenceCheck =
  | { ok: true; kind: ResolutionEvidenceKind; coverage: "executed"; detail: string; evidence: ResolutionEvidence }
  | { ok: false; refusal: string; coverage: CoverageOutcome };

/** Which evidence kinds can close a finding of each reachability. Proportional, and
 *  stated as data so the three arms cannot drift apart in prose. */
const SUFFICIENT: Record<Reachability, readonly ResolutionEvidenceKind[]> = {
  demonstrated: ["regression_test", "replayed_reproduction"],
  supported: ["regression_test", "replayed_reproduction", "anchored_verification"],
  speculative: ["regression_test", "replayed_reproduction", "anchored_verification", "bounded_inspection"],
};

/** The proportionality rule, readable WITHOUT a payload to validate.
 *
 *  FG-640's gate re-derives it from the ledger: a recheck stores the validated evidence KIND
 *  and a rendered detail string, not the raw payload, so the gate can still ask "is this kind
 *  proportional to that reachability" long after the payload itself is gone. Same table, one
 *  reader — the gate cannot drift from what `validateResolutionEvidence` enforced. */
export function sufficientEvidenceKinds(reachability: Reachability): readonly ResolutionEvidenceKind[] {
  return SUFFICIENT[reachability];
}

export function evidenceKindSufficientFor(reachability: Reachability, kind: string | undefined): boolean {
  return kind !== undefined && SUFFICIENT[reachability].some((k) => k === kind);
}

export type EvidenceContext = {
  /** The candidate the resolution is claimed against. An alternate lane must name THIS
   *  sha — coverage at some other candidate is coverage of some other code. */
  candidateSha: string;
  reachability: Reachability;
  findingRef: string;
};

/** Validate one resolution-evidence claim. Returns the evidence to store, or a refusal
 *  plus the coverage outcome to RECORD (`not_executed` / `blocked_environment`) so the
 *  caller writes the honest thing rather than nothing. */
export function validateResolutionEvidence(raw: unknown, ctx: EvidenceContext): EvidenceCheck {
  const parsed = ResolutionEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return {
      ok: false,
      coverage: "not_executed",
      refusal: `${ctx.findingRef}: resolution evidence did not validate: ${detail}`,
    };
  }
  const ev = parsed.data;

  const sufficient = SUFFICIENT[ctx.reachability];
  if (!sufficient.includes(ev.kind)) {
    return {
      ok: false,
      coverage: "not_executed",
      refusal:
        `${ctx.findingRef}: reachability '${ctx.reachability}' cannot be resolved by ${ev.kind} — ` +
        `it requires ${sufficient.join(" or ")}. ` +
        (ctx.reachability === "demonstrated"
          ? `A demonstrated finding is never closed by model re-inspection; it needs a named regression test, ` +
            `a replayed reproduction, or an equivalent deterministic proof (or an explicitly authorized ` +
            `limitation recorded as a disposition).`
          : `Nothing was resolved.`),
    };
  }

  // EVERY KIND IS ENFORCED STRUCTURALLY, PER KIND. Nothing is accepted on nonempty prose:
  // each arm of the union above states the fields its kind requires (replayed_reproduction
  // needs its command AND its output; bounded_inspection its inspection AND its limitation),
  // so a missing field is already a refusal that names it. What a schema cannot decide is
  // whether a cited step EXECUTED — so anchored_verification's step goes through the
  // kind-aware execution check above. A step that skipped is a skip, a step that failed is
  // a failure, and neither is ever evidence.
  if (ev.kind === "anchored_verification") {
    const step = checkVerificationStep(ev.verification_step);
    if (!step.ok) {
      return {
        ok: false,
        coverage: "not_executed",
        refusal:
          `${ctx.findingRef}: the anchored verification at ${ev.file}:${ev.line} rests on ${step.refusal}. ` +
          `Coverage is recorded not_executed. Nothing was resolved.`,
      };
    }
  }

  if (ev.kind !== "regression_test") {
    return { ok: true, kind: ev.kind, coverage: "executed", detail: describeEvidence(ev), evidence: ev };
  }

  // A cited test. Everything below is the skip-evidence rule.
  if (ev.environment_blocked !== undefined) {
    const lane = checkAlternateLane(ev.alternate_lane, ctx, ranTestNames(ev.test_name));
    if (lane.ok) {
      return {
        ok: true,
        kind: ev.kind,
        coverage: "executed",
        detail:
          `${ev.test_name} could not run here (${ev.environment_blocked}) but ${lane.detail}`,
        evidence: ev,
      };
    }
    return {
      ok: false,
      coverage: "blocked_environment",
      refusal:
        `${ctx.findingRef}: the environment could not execute ${ev.test_name} (${ev.environment_blocked}) — ` +
        `coverage is recorded blocked_environment, never green and never resolved. ${lane.refusal}`,
    };
  }

  if (ev.runner_output === undefined || ev.runner_output.trim() === "") {
    return {
      ok: false,
      coverage: "not_executed",
      refusal:
        `${ctx.findingRef}: ${ev.test_name} is cited with no runner output, so nothing establishes that it ` +
        `EXECUTED against ${ctx.candidateSha}. A green suite is not per-test execution. Nothing was resolved.`,
    };
  }

  const { execution, test } = resolveTestExecution(ev.runner_output, ev.test_name);
  // A RED CITED TEST IS NOT RESCUED BY ANOTHER LANE. A skip or an absence is a gap another
  // mandatory lane can fill; a failure at this candidate is the finding still being
  // present, so it refuses before the alternate-lane arm is ever consulted.
  if (execution === "failed") {
    return {
      ok: false,
      coverage: "not_executed",
      refusal:
        `${ctx.findingRef}: ${test} FAILED in the cited runner output — a failing test is never ` +
        `resolution evidence; at ${ctx.candidateSha} it is the finding still being present. Coverage is ` +
        `recorded not_executed. Nothing was resolved.`,
    };
  }
  if (execution === "executed") {
    return {
      ok: true,
      kind: ev.kind,
      coverage: "executed",
      detail: `${ev.test_name} executed against ${ctx.candidateSha}`,
      evidence: ev,
    };
  }

  const lane = checkAlternateLane(ev.alternate_lane, ctx, ranTestNames(ev.test_name));
  if (lane.ok) {
    return {
      ok: true,
      kind: ev.kind,
      coverage: "executed",
      detail: `${test} ${execution} here, but ${lane.detail}`,
      evidence: ev,
    };
  }

  const why =
    execution === "skipped"
      ? `${test} SKIPPED in the cited runner output — a skipped test is never evidence, even when the ` +
        `enclosing suite exited green and the skip was named`
      : `${test} does not appear in the cited runner output at all, so it was never established to run`;

  return {
    ok: false,
    coverage: "not_executed",
    refusal: `${ctx.findingRef}: ${why}. Coverage is recorded not_executed. ${lane.refusal}`,
  };
}

type LaneCheck = { ok: true; detail: string } | { ok: false; refusal: string };

/** A skip is sound ONLY when another mandatory lane EXECUTED the same assertion against
 *  the same candidate. Naming that lane makes the claim checkable; the lane's own runner
 *  output is what makes it checked. Both are required — a lane accepted on its name alone
 *  would be the skip rule with one indirection added.
 *
 *  `required` is every test the claim being rescued names. The lane must cover ALL of them:
 *  a lane is a substitute for the claim, not a discount on it. */
function checkAlternateLane(
  claim: AlternateLaneClaim | undefined,
  ctx: EvidenceContext,
  required: readonly string[],
): LaneCheck {
  if (claim === undefined) {
    return {
      ok: false,
      refusal:
        `No alternate lane is named. Claiming coverage elsewhere requires --lane-style naming: the lane, the ` +
        `candidate sha, and the executed assertion, plus that lane's runner output for it; unnamed ` +
        `"covered elsewhere" is refused.`,
    };
  }
  if (claim.candidate_sha !== ctx.candidateSha) {
    return {
      ok: false,
      refusal:
        `Alternate lane '${claim.lane}' names candidate ${claim.candidate_sha}, not this review's candidate ` +
        `${ctx.candidateSha} — coverage at another candidate is coverage of other code.`,
    };
  }
  if (claim.runner_output === undefined || claim.runner_output.trim() === "") {
    return {
      ok: false,
      refusal:
        `Alternate lane '${claim.lane}' names '${claim.executed_assertion}' but carries no execution record for ` +
        `it — the lane's own runner output is required, because naming a lane resolves nothing. The alternate ` +
        `lane is held to the same per-test identity the primary lane is.`,
    };
  }
  const assertion = resolveTestExecution(claim.runner_output, claim.executed_assertion);
  if (assertion.execution !== "executed") {
    return {
      ok: false,
      refusal:
        assertion.execution === "skipped"
          ? `Alternate lane '${claim.lane}' cites '${assertion.test}', but its own output shows that ` +
            `assertion skipped — a skip is never evidence, in any lane.`
          : assertion.execution === "failed"
            ? `Alternate lane '${claim.lane}' cites '${assertion.test}', but its own output shows that ` +
              `assertion FAILING — a failed check is never evidence, in any lane.`
            : `Alternate lane '${claim.lane}' cites '${assertion.test}', but that assertion does not ` +
              `appear in its own output at all, so the lane never established it ran.`,
    };
  }

  // THE LANE MUST COVER EVERY TEST THE CLAIM NAMES. Executing SOME of them is coverage of
  // some of the finding: "alpha; beta" rescued by a lane that ran only alpha leaves beta
  // executed in no lane at all, which is this file's guarantee — every named test must have
  // executed — quietly not holding. Correspondence is by WHOLE NAME, never substring or
  // prefix. A lane naming a superset passes: running more than was asked for still runs
  // what was asked for. Coverage is checked over the members the claim names, not over the
  // subset that failed here, so the lane stands in for the whole claim it rescues.
  const covered = new Set(ranTestNames(claim.executed_assertion));
  const uncovered = required.findIndex((name) => !covered.has(name));
  if (uncovered !== -1) {
    return {
      ok: false,
      refusal:
        `Alternate lane '${claim.lane}' executed '${claim.executed_assertion}', which does not cover ` +
        `'${memberLabel(required, uncovered)}' — a lane rescues a claim only by executing EVERY test that ` +
        `claim names, and that member executed in no lane at all. Covering a subset resolves a subset, ` +
        `which is not what the claim asserts.`,
    };
  }

  return {
    ok: true,
    detail:
      `mandatory lane '${claim.lane}' executed '${claim.executed_assertion}' against ${claim.candidate_sha}`,
  };
}

function describeEvidence(ev: ResolutionEvidence): string {
  switch (ev.kind) {
    case "regression_test":
      return `regression test ${ev.test_name}`;
    case "replayed_reproduction":
      return `replayed ${ev.command}`;
    case "anchored_verification":
      return `${ev.file}:${ev.line} — ${ev.fact} (verified by ${stepLabel(ev.verification_step)}, which executed)`;
    case "bounded_inspection":
      return `bounded inspection: ${ev.inspection} (limitation: ${ev.limitation})`;
  }
}

// ─── coverage of a NON-resolution recheck entry (FG-664, half B) ────────────

/** What coverage did an entry ACTUALLY carry, for the arm that is not claiming resolution?
 *
 *  Stage 8 used to record every `still_present`/`inconclusive` entry as `executed` coverage
 *  unconditionally, so a lane that could not run a single test still wrote "these findings
 *  were checked by tests that ran" into the ledger (FG-664; it produced three such verdicts
 *  on FG-662). This answers that one question — did anything execute — and NOTHING else.
 *
 *  WHY THIS IS NOT `validateResolutionEvidence`'s coverage. That function is calibrated for
 *  the RESOLUTION arm, where a cited test that FAILED is recorded `not_executed` because a
 *  red assertion resolves nothing. Here a red assertion is the honest, expected shape of a
 *  `still_present` verdict: the test RAN and it failed, and that IS executed coverage. Same
 *  parser, different arm, so the two calibrations must not be shared.
 *
 *  THE CEILING, STATED HONESTLY. This closes the case where the lane DECLARES it could not
 *  run — `environment_blocked`, or a citation with no runner output behind it. It CANNOT
 *  detect a substituted engine that produced plausible `not ok` lines: engine-difference
 *  failures are textually indistinguishable from a real regression, and no rule applied to
 *  the output can authenticate the engine that emitted it. That determination is host-side
 *  and pre-dispatch (FG-664 half A); nothing here is a substitution detector, and it must
 *  not be read or extended as one.
 *
 *  It does not touch the VERDICT plane either: the `resolved`/`still_present`/`inconclusive`
 *  result the rechecker reported is recorded exactly as reported. Only the coverage fact
 *  changes, and a stage that stops on `blocked_environment` is a separate caller's job. */
export function classifyRecheckCoverage(raw: unknown): CoverageOutcome {
  const parsed = ResolutionEvidenceSchema.safeParse(raw);
  // Evidence that does not even parse establishes no execution. Nothing is `executed` by
  // default — the default is the absence of a record, which is what `not_executed` means.
  if (!parsed.success) return "not_executed";
  const ev = parsed.data;

  switch (ev.kind) {
    case "regression_test":
      // A DECLARED environment block dominates, including over an alternate lane. The
      // declaration is precisely the signal the stage stop consumes, and a lane that says
      // it could not run must not be recorded as though something here did.
      if (ev.environment_blocked !== undefined) return "blocked_environment";
      if (ev.runner_output === undefined || ev.runner_output.trim() === "") return "not_executed";
      return ranOrWentRed(resolveTestExecution(ev.runner_output, ev.test_name).execution);
    case "replayed_reproduction":
      // The schema already requires the command AND the output it produced: a reproduction
      // that was replayed ran, whatever it showed.
      return "executed";
    case "anchored_verification":
      return stepCoverage(ev.verification_step);
    case "bounded_inspection":
      // Reading the source is not running it. An inspection executes nothing, and saying so
      // is the whole point of recording coverage separately from the verdict.
      return "not_executed";
  }
}

/** Executed coverage is "the check RAN", not "the check was green" — a skip and an absence
 *  are the only ways nothing ran. */
function ranOrWentRed(execution: TestExecution): CoverageOutcome {
  return execution === "executed" || execution === "failed" ? "executed" : "not_executed";
}

function stepCoverage(step: ExecutedStep): CoverageOutcome {
  // A non-test step carries its own runner's exit status. A nonzero exit is a step that ran
  // and went red, which is executed coverage on this arm for the same reason a failing test
  // is.
  if (isCommandStep(step)) return "executed";
  return ranOrWentRed(resolveTestExecution(step.runner_output, step.ran).execution);
}

// ─── acceptance-criterion evidence (Stage 9 check 2) ────────────────────────

export const AC_VERDICTS = ["met", "unmet", "unproven"] as const;
export type AcVerdict = (typeof AC_VERDICTS)[number];

export type AcClaim = {
  ref: string;
  verdict: AcVerdict;
  /** The cited evidence. When the criterion is claimed `met`, this is validated by the
   *  same executed-test rule as a resolution: a criterion whose only evidence is a
   *  skipped test is `unproven`, not met. */
  evidence?: unknown;
};

/** FG-733: read-time shape validation for `--acceptance`. The command used to cast the parsed
 *  JSON straight to `AcClaim[]`, so an object like `{acceptance_criteria:[…]}` reached the
 *  shipping stage and threw `claims.map is not a function` — a raw stack where every other
 *  malformed input on this command names its shape. A `met` claim must CITE evidence here (a
 *  well-formed `ResolutionEvidence`); `assessAcceptanceClaims` still downgrades met→unproven when
 *  that evidence does not establish execution — this rejects only a met claim that cites nothing,
 *  and evidence that is structurally not a `ResolutionEvidence` at all. */
export const AcClaimSchema = z
  .object({
    ref: z.string().trim().min(1),
    verdict: z.enum(AC_VERDICTS),
    evidence: ResolutionEvidenceSchema.optional(),
  })
  .strict()
  .refine((c) => c.verdict !== "met" || c.evidence !== undefined, {
    message: 'a claim with verdict "met" must cite `evidence` (a ResolutionEvidence object)',
    path: ["evidence"],
  });

export const AcClaimsSchema = z.array(AcClaimSchema);

export type AcAssessment = {
  ref: string;
  verdict: AcVerdict;
  detail: string;
};

/** Map each acceptance criterion to a settled verdict. A `met` claim is DOWNGRADED to
 *  `unproven` when its evidence does not establish execution against the reviewed
 *  candidate — the mapping is verified per test, not by a suite exiting green. */
export function assessAcceptanceClaims(claims: readonly AcClaim[], candidateSha: string): AcAssessment[] {
  return claims.map((c) => {
    if (c.verdict !== "met") {
      return { ref: c.ref, verdict: c.verdict, detail: `claimed ${c.verdict}` };
    }
    if (c.evidence === undefined) {
      return { ref: c.ref, verdict: "unproven", detail: `claimed met with no cited evidence` };
    }
    // An AC mapping is a claim about observed behavior, so `speculative` is the right
    // floor here: it accepts every evidence kind and lets the skip rule do the work.
    const check = validateResolutionEvidence(c.evidence, {
      candidateSha,
      reachability: "speculative",
      findingRef: c.ref,
    });
    return check.ok
      ? { ref: c.ref, verdict: "met", detail: check.detail }
      : { ref: c.ref, verdict: "unproven", detail: check.refusal };
  });
}
