// FG-639 (evidence-led review, Change 2): the coordinator's real host wiring.
//
// Everything with a side effect lives here so `src/v2/review-run.ts` stays a pure stage
// sequencer over injected deps — the same split review-loop already uses (a pure engine in
// src/v2, the invoke/git/verification wiring in the CLI layer).
//
// VERIFICATION IS NOT REIMPLEMENTED. Stage 1 and Stage 7 call review-loop's OWN
// `verifyWithReuse` through `buildReviewLoopDeps`, which is what consults
// `findCoveringGateEvidence` for covering evidence at the exact sha, probes and waits on
// CI, and runs the host-readiness preflight before any local fallback. A second
// verification model would be a second set of evidence semantics to keep honest.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReviewLoopDeps, resolveReviewedTipTrust } from "./review-loop.js";
import { resolveCommitRange } from "../../v2/review-loop.js";
import { invoke, type InvokeArgs, type InvokeResult } from "../../v2/invoke.js";
import { fixBatchBundleDir } from "../../util/paths.js";
import { renderFixBatchEnvelope, verifyMaterializedEnvelope, verifyMaterializedPayload } from "../../store/fix-batches.js";
import { getRun } from "../../store/runs.js";
import type { CoordinatorDeps, FixerContext, LensContext, RecheckContextIn } from "../../v2/review-run.js";
import type { VerificationEntry } from "../../v2/review-coordinator.js";
import type { ContractProposal, LensWidening, RiskLens } from "../../v2/review-contract.js";
import type { AcClaim } from "../../v2/review-evidence.js";
import type { Review } from "../../store/reviews.js";

export type InvokeFn = (args: InvokeArgs) => Promise<InvokeResult>;

// FG-639 live-pilot defect: the fixer's bundle, delivered INSIDE the container.
//
// The host bundle under ~/.forge/reviews/<review>/<batch>/ is on NO mount, so naming it in
// the prompt named a path the fixer cannot open — it searched every mount and honestly
// reported the authoritative handoff undelivered, and the host then refused its empty
// findings array. /task is already the package delivery channel (CLAUDE.md, package.md,
// result.json all ride that rw bind), so the bundle rides along with them: no new mount,
// and the in-container path is the one the prompt names.
const FIX_BATCH_TASK_SUBDIR = "fix-batch";
const FIX_BATCH_CONTAINER_DIR = `/task/${FIX_BATCH_TASK_SUBDIR}`;
export const FIX_BATCH_PAYLOAD_PATH = `${FIX_BATCH_CONTAINER_DIR}/payload.json`;
export const FIX_BATCH_ENVELOPE_PATH = `${FIX_BATCH_CONTAINER_DIR}/envelope.json`;

export type WiringContext = {
  projectDir: string;
  ticketId: string;
  runId?: string;
  route?: string;
  unrouted?: boolean;
  /** Operator-supplied contract widening — the ONLY way a lens gets added. There is no
   *  file-path classifier: the coordinator/operator states the widening and its evidence. */
  addLenses?: LensWidening[];
  /** Operator-named drift the coordinator cannot classify — returns to plan/architecture. */
  unclassifiableDrift?: string;
  /** The evaluator's statement that the final diff needs no lens change. Recorded as the
   *  `no_drift` evaluation, with the diff summary it was made against. */
  evaluatedNoDrift?: string;
  /** Acceptance claims for Stage 9, read from --acceptance <file.json>. */
  acceptance?: AcClaim[];
  git?: (args: string[]) => string;
  invokeFn?: InvokeFn;
};

function realGit(projectDir: string) {
  return (args: string[]): string =>
    execFileSync("git", args, { cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function projectScripts(projectDir: string): Record<string, unknown> {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/** The discovery prompt's REQUIRED shape, stated to the reviewer. Every field is listed
 *  because a lens whose output omits one is not schema-valid and therefore is not a
 *  completed outcome — leaving the requirement implicit is how a panel goes incomplete for
 *  a reason nobody can see. */
function discoveryTask(ctx: LensContext, diff: string, contract: unknown): string {
  return [
    `# Risk-targeted discovery — ${ctx.lens} lens`,
    ``,
    `Review ${ctx.review.ticketId ?? "(no ticket)"} at candidate sha ${ctx.candidateSha}. READ-ONLY.`,
    ``,
    `## Confirmed review contract`,
    "```json",
    JSON.stringify(contract, null, 2),
    "```",
    ``,
    `Stay inside this contract. Its non_goals are boundaries you must not silently expand,`,
    `and its protected_invariants are the promises whose violation is fix-before-advance`,
    `irrespective of the severity you assign.`,
    ``,
    `## Implementation diff under review`,
    "```diff",
    diff,
    "```",
    ``,
    `## Output contract`,
    ``,
    `Write /task/result.json as:`,
    "```json",
    JSON.stringify(
      {
        outcome: "pass | fail | inconclusive",
        inconclusive_reason: "required when outcome is inconclusive — say what you could not establish",
        findings: [
          {
            summary: "…",
            evidence: "…",
            severity: "critical | high | medium | low",
            risk_lens: ctx.lens,
            reachability: "demonstrated | supported | speculative",
            challenges_contract: false,
            remediation_advice: "advice only — you do not decide the fix",
            file: "src/…", line: 1, quoted_text: "the exact line",
            acceptance_ref: "optional", invariant_ref: "optional",
          },
        ],
      },
      null,
      2,
    ),
    "```",
    ``,
    `Rules that decide whether your output counts as a completed review:`,
    `- Every field above is REQUIRED per finding except file/line/quoted_text (anchor where`,
    `  applicable), acceptance_ref and invariant_ref. A finding missing a required field`,
    `  invalidates the whole result and your lens is recorded as having produced NO review.`,
    `- \`inconclusive\` is a legitimate authored outcome and must state why. Do NOT return a`,
    `  pass because you found nothing conclusive.`,
    `- \`remediation_advice\` is ADVICE. You do not disposition findings and you do not change`,
    `  the contract; flag a contract challenge with challenges_contract: true instead.`,
  ].join("\n");
}

function fixerTask(ctx: FixerContext): string {
  return [
    `# Batch remediation — fix batch ${ctx.batch.id} revision ${ctx.batch.revision}`,
    ``,
    `The AUTHORITATIVE handoff is the batch the HOST has persisted. Your working copies of`,
    `it were verified against that record and written here for convenience:`,
    `  ${FIX_BATCH_PAYLOAD_PATH}   (sha256 ${ctx.batch.payloadSha256} as delivered)`,
    `  ${FIX_BATCH_ENVELOPE_PATH}`,
    ``,
    `That directory is writable, like the rest of /task — these copies are not a tamper-proof`,
    `record and nothing downstream reads them back. Your result is validated against the`,
    `host's expected finding set for this batch and revision regardless of what these files`,
    `say, so editing them changes nothing except which findings YOU work from.`,
    ``,
    `Read the payload. Solve the finding set COHERENTLY — it is one batch, not N tasks.`,
    ``,
    `Candidate sha: ${ctx.batch.candidateSha}`,
    ``,
    `## Output contract`,
    ``,
    `Write /task/result.json as:`,
    "```json",
    JSON.stringify(
      {
        fix_batch_id: ctx.batch.id,
        revision: ctx.batch.revision,
        findings: [
          {
            finding_id: ctx.batch.payload.findings[0]?.finding_id ?? "<review>/RF-1",
            result: "fixed | scope_change | not_fixed",
            remediation_summary: "…",
            files_changed: ["src/…"],
            evidence: "the test you added or the existing evidence you used",
            interaction: "optional — how this interacts with another finding in the batch",
            scope_change_reason: "required when result is scope_change",
          },
        ],
      },
      null,
      2,
    ),
    "```",
    ``,
    `- EXACTLY ONE entry per finding id in the payload. An omitted, duplicated, or foreign`,
    `  id is refused by the host and NOTHING from your result is applied. An omission is`,
    `  never read as a resolution.`,
    `- If a finding cannot be resolved without changing scope, say so with`,
    `  result: "scope_change" and a reason. It returns to disposition as an architecture`,
    `  question; do not guess through it.`,
  ].join("\n");
}

function recheckerTask(ctx: RecheckContextIn): string {
  return [
    `# Exact recheck + bounded remediation-delta review`,
    ``,
    `Review ${ctx.review.id}. Discovery sha ${ctx.confirmedSha}; final candidate ${ctx.candidateSha}.`,
    ``,
    `## The findings you must recheck, EXACTLY — one result per id, no additions`,
    "```json",
    JSON.stringify(
      ctx.expected.map((f) => ({
        finding_id: f.id,
        finding_ref: f.findingRef,
        summary: f.summary,
        original_evidence: f.evidence,
        reachability: f.reachability,
        anchor: f.file !== undefined ? `${f.file}${f.line !== undefined ? `:${f.line}` : ""}` : undefined,
        invariant_ref: f.invariantRef,
        acceptance_ref: f.acceptanceRef,
        source_lens_instructions: ctx.lensInstructions[f.findingRef],
        fixer_claim: ctx.fixerEvidence[f.id],
      })),
      null,
      2,
    ),
    "```",
    ``,
    `## Confirmed review contract`,
    "```json",
    JSON.stringify(ctx.contract, null, 2),
    "```",
    ``,
    `## The complete delta between the discovery sha and the final candidate`,
    "```diff",
    ctx.delta,
    "```",
    ``,
    `## Output contract`,
    ``,
    `Write /task/result.json as:`,
    "```json",
    JSON.stringify(
      {
        review_id: ctx.review.id,
        candidate_sha: ctx.candidateSha,
        rechecked: [
          {
            finding_id: "<the id above>",
            result: "resolved | still_present | inconclusive",
            evidence_kind: "regression_test | replayed_reproduction | anchored_verification | bounded_inspection",
            evidence: { kind: "regression_test", test_name: "…", test_file: "src/…", runner_output: "…" },
          },
        ],
        new_findings: [],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/** The changed paths, named as far as is useful and counted beyond that. Used both by the
 *  fail-closed refusal and by the recorded `no_drift` evaluation, so the diff an evaluator
 *  is shown and the diff their evaluation is recorded against are the same summary. */
function diffSummary(changedPaths: readonly string[]): string {
  const shown = changedPaths.slice(0, 10);
  const more = changedPaths.length - shown.length;
  return `${changedPaths.length} changed path(s): ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/** The diff summary a fail-closed confirmation surfaces. Enough for the coordinator to
 *  evaluate and come back with a recorded evaluation — not a reproduction of the diff. */
function unevaluatedDiffSummary(changedPaths: readonly string[]): string {
  return (
    `no drift evaluation has been recorded for the final implementation diff — ` +
    `${diffSummary(changedPaths)}. ` +
    `The coordinator will not auto-confirm the approved contract against a diff nobody evaluated. Evaluate the ` +
    `diff and record it: --add-lens <lens>:<reason>:<diff-evidence> to widen, ` +
    `--evaluated-no-drift <statement> to record that you examined the diff and no lens change is needed, ` +
    `or --drift <text> to name drift you cannot classify`
  );
}

export function buildCoordinatorDeps(ctx: WiringContext): CoordinatorDeps {
  const git = ctx.git ?? realGit(ctx.projectDir);
  const invokeFn = ctx.invokeFn ?? invoke;
  const headSha = (): string => git(["rev-parse", "HEAD"]).trim();

  // review-loop's own verify — covering evidence, CI wait, host-readiness preflight.
  const loop = buildReviewLoopDeps(
    {
      ticketId: ctx.ticketId,
      acceptance: "",
      diffProvider: () => "",
      projectDir: ctx.projectDir,
      scripts: projectScripts(ctx.projectDir),
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      ...(ctx.route !== undefined ? { route: ctx.route } : {}),
      ...(ctx.unrouted !== undefined ? { unrouted: ctx.unrouted } : {}),
    },
    invokeFn,
  );

  const runIdFor = (): string | undefined => loop.getRunId() ?? ctx.runId;

  const dispatch = async (args: InvokeArgs): Promise<InvokeResult> => invokeFn(args);

  return {
    headSha,

    verify: async (sha: string): Promise<VerificationEntry> => {
      // review-loop's verify resolves HEAD itself. If HEAD is not the candidate the
      // coordinator asked about, its answer is about a different tree — say so rather than
      // stamping the requested sha onto someone else's result.
      const head = headSha();
      if (head !== sha) {
        return {
          ok: false,
          sha,
          detail: `the workspace head is ${head}, not the candidate ${sha} under review`,
          environmentRefusal: {
            reason: "candidate_not_checked_out",
            message:
              `verification cannot run at candidate ${sha}: the workspace at ${ctx.projectDir} is on ${head}. ` +
              `Check the candidate out (or point --project at the workspace that has it) and re-run.`,
          },
        };
      }
      const result = await loop.deps.verify();
      const readiness = result.readiness;
      if (readiness?.outcome === "refused") {
        return {
          ok: false,
          sha,
          detail: readiness.message ?? readiness.reason ?? "host verification readiness refused",
          environmentRefusal: {
            reason: readiness.reason ?? "unclassified",
            message: readiness.message ?? "the verification environment could not be established",
          },
        };
      }
      const executed = result.reusedEvidence !== undefined || result.steps.length > 0;
      return {
        ok: result.ok,
        sha,
        executedRequiredChecks: executed,
        detail:
          result.reusedEvidence ??
          result.steps.map((s) => `${s.name}: ${s.ok ? "ok" : "FAILED"}`).join(", ") ??
          "no verification steps were discoverable",
      };
    },

    changedPaths: (fromSha: string, toSha: string): string[] =>
      git(["diff", "--name-only", `${fromSha}..${toSha}`])
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),

    diff: (fromSha: string, toSha: string): string => git(["diff", `${fromSha}..${toSha}`]),

    // The widening asymmetry's operator surface, and it is FAIL-CLOSED against the final
    // implementation diff. Forwarding the changed paths while always proposing the unchanged
    // contract made drift classification inert: the diff was carried into the confirmation
    // record and never evaluated, so every candidate auto-confirmed. Silently proposing the
    // unchanged contract over a diff nobody evaluated is the one forbidden outcome, so an
    // unevaluated nonempty diff REFUSES here and surfaces its summary for the coordinator's
    // confirmation dispatch (--add-lens, with the evidence), the operator's --drift, or the
    // recorded "I looked and nothing needs widening" of --evaluated-no-drift. Only the
    // SILENT unevaluated auto-confirm is forbidden; an evaluation that concludes no_drift is
    // a legitimate outcome and advances, because it is recorded with what it examined.
    //
    // Still not a path classifier: the refusal reports which paths changed and stops. It
    // never decides that a path implies a lens — that is the coordinator's or operator's
    // recorded evaluation, and this seam is where it enters.
    proposeContract: ({ changedPaths }): ContractProposal => {
      const widening = ctx.addLenses !== undefined && ctx.addLenses.length > 0 ? ctx.addLenses : undefined;
      const noDrift =
        ctx.evaluatedNoDrift !== undefined && ctx.evaluatedNoDrift.trim() !== ""
          ? { diffSummary: diffSummary(changedPaths), statement: ctx.evaluatedNoDrift.trim() }
          : undefined;
      const evaluated = widening !== undefined || ctx.unclassifiableDrift !== undefined || noDrift !== undefined;
      if (!evaluated && changedPaths.length > 0) {
        return { candidateSha: "", changedPaths, unclassifiableDrift: unevaluatedDiffSummary(changedPaths) };
      }
      return {
        candidateSha: "",
        changedPaths,
        ...(widening !== undefined ? { widening } : {}),
        ...(noDrift !== undefined ? { noDrift } : {}),
        ...(ctx.unclassifiableDrift !== undefined ? { unclassifiableDrift: ctx.unclassifiableDrift } : {}),
      };
    },

    dispatchLens: async (lensCtx: LensContext) => {
      const base = lensCtx.review.baseSha ?? `${lensCtx.candidateSha}~1`;
      let diff = "";
      try {
        diff = git(["diff", `${base}..${lensCtx.candidateSha}`]);
      } catch {
        diff = "(the implementation diff could not be computed)";
      }
      const res = await dispatch({
        agentRole: lensCtx.role,
        task: discoveryTask(lensCtx, diff, lensCtx.contract),
        projectDir: ctx.projectDir,
        readOnlyProject: true,
        ...(runIdFor() !== undefined ? { runId: runIdFor() as string } : {}),
        runTitle: `review discovery ${lensCtx.lens} — ${ctx.ticketId}`,
        ...(ctx.route !== undefined ? { routeKey: ctx.route } : {}),
      });
      const failureKind = res.failureKind ?? (res.status === "complete" ? undefined : res.error);
      return {
        lens: lensCtx.lens,
        role: lensCtx.role,
        dispatched: res.status === "complete",
        ...(failureKind !== undefined ? { failureKind } : {}),
        result: res.result,
        taskId: res.taskId,
      };
    },

    // Materialize the delivery snapshot. The BYTES on disk are what review-run re-hashes
    // against the persisted value before the container starts.
    materializeFixBatch: (fixCtx: FixerContext): string => {
      const dir = fixBatchBundleDir(fixCtx.review.id, fixCtx.batch.id);
      mkdirSync(dir, { recursive: true });
      const payloadPath = join(dir, "payload.json");
      writeFileSync(payloadPath, fixCtx.payload);
      writeFileSync(join(dir, "envelope.json"), renderFixBatchEnvelope(fixCtx.batch));
      return readFileSync(payloadPath, "utf8");
    },

    // Deliver the verified bundle into the container, then start it. The bytes DELIVERED
    // are the bytes re-hashed here — verifying the materialization and then shipping a
    // separate read of the same file would leave the delivered copy unverified.
    //
    // BOTH halves are verified against the store, and neither is trusted from disk: the
    // payload against the batch's recorded sha256, the envelope byte-for-byte against a
    // rendering re-derived from the row. A refusal returns the empty taskId sentinel, so
    // the batch stays open at this revision (see CoordinatorDeps.dispatchFixer).
    dispatchFixer: async (fixCtx: FixerContext) => {
      const dir = fixBatchBundleDir(fixCtx.review.id, fixCtx.batch.id);
      const payload = readFileSync(join(dir, "payload.json"), "utf8");
      const envelope = readFileSync(join(dir, "envelope.json"), "utf8");
      const verified = verifyMaterializedPayload(fixCtx.batch, payload);
      if (!verified.ok) return { ok: false, taskId: "", error: verified.refusal };
      const envelopeVerified = verifyMaterializedEnvelope(fixCtx.batch.id, envelope);
      if (!envelopeVerified.ok) return { ok: false, taskId: "", error: envelopeVerified.refusal };
      const res = await dispatch({
        agentRole: "engineer",
        task: fixerTask(fixCtx),
        taskFiles: {
          [`${FIX_BATCH_TASK_SUBDIR}/payload.json`]: payload,
          [`${FIX_BATCH_TASK_SUBDIR}/envelope.json`]: envelope,
        },
        projectDir: ctx.projectDir,
        ...(runIdFor() !== undefined ? { runId: runIdFor() as string } : {}),
        runTitle: `review batch fix ${fixCtx.batch.id} — ${ctx.ticketId}`,
        ...(ctx.route !== undefined ? { routeKey: ctx.route } : {}),
      });
      return {
        ok: res.status === "complete",
        taskId: res.taskId,
        result: res.result,
        ...(res.error !== undefined ? { error: res.error } : {}),
      };
    },

    dispatchDocs: async ({ review, candidateSha }: { review: Review; candidateSha: string }) => {
      const res = await dispatch({
        agentRole: "documentation-maintainer",
        task:
          `Reconcile durable operator-facing docs against the change under review ` +
          `(${review.ticketId ?? "(no ticket)"}) at candidate ${candidateSha}. This phase runs BEFORE final ` +
          `verification and recheck, so it may change the candidate.`,
        projectDir: ctx.projectDir,
        ...(runIdFor() !== undefined ? { runId: runIdFor() as string } : {}),
        runTitle: `review docs reconciliation — ${ctx.ticketId}`,
        ...(ctx.route !== undefined ? { routeKey: ctx.route } : {}),
      });
      return { ok: res.status === "complete", ...(res.error !== undefined ? { error: res.error } : {}) };
    },

    dispatchRechecker: async (recheckCtx: RecheckContextIn) => {
      const res = await dispatch({
        agentRole: "review-rechecker",
        task: recheckerTask(recheckCtx),
        projectDir: ctx.projectDir,
        readOnlyProject: true,
        ...(runIdFor() !== undefined ? { runId: runIdFor() as string } : {}),
        runTitle: `review recheck — ${ctx.ticketId}`,
        ...(ctx.route !== undefined ? { routeKey: ctx.route } : {}),
      });
      return {
        ok: res.status === "complete",
        taskId: res.taskId,
        result: res.result,
        ...(res.error !== undefined ? { error: res.error } : {}),
      };
    },

    shippingInput: async ({ review, candidateSha }) => {
      const verification = await loop.deps.verify();
      const trust = resolveReviewedTipTrust(ctx.projectDir, candidateSha);
      const head = headSha();
      // Identity continuity, as far as this pilot can establish it deterministically: the
      // reviewed candidate IS the working tree's head, and a review that names a run names
      // a run that still exists. Gate/receipt/publication continuity beyond that belongs to
      // the FG-640 gate derivation, and claiming it here would be claiming a check that was
      // not performed.
      const runOk = review.runId === undefined || getRun(review.runId) !== undefined;
      const continuous = head === candidateSha && runOk;
      return {
        verification: {
          ok: verification.ok,
          sha: candidateSha,
          executedRequiredChecks: verification.reusedEvidence !== undefined || verification.steps.length > 0,
          detail:
            verification.reusedEvidence ??
            verification.steps.map((s) => `${s.name}: ${s.ok ? "ok" : "FAILED"}`).join(", "),
        },
        acceptance: ctx.acceptance ?? [],
        tipTrust: {
          kind: trust.kind,
          reviewedSha: candidateSha,
          ...(trust.kind !== "trusted" ? { detail: JSON.stringify(trust) } : {}),
        },
        identity: {
          continuous,
          detail: continuous
            ? `candidate ${candidateSha} is the current head and the review's run record is intact`
            : head !== candidateSha
              ? `the working tree head is ${head}, not the reviewed candidate ${candidateSha}`
              : `review ${review.id} names run ${review.runId} which no longer exists`,
        },
        contractCoverage: {
          confirmedSha: review.contractConfirmedSha ?? candidateSha,
          finalSha: candidateSha,
          postConfirmationPaths:
            review.contractConfirmedSha !== undefined && review.contractConfirmedSha !== candidateSha
              ? git(["diff", "--name-only", `${review.contractConfirmedSha}..${candidateSha}`])
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l !== "")
              : [],
          deltaReviewed: review.stageEvidence?.recheck?.sha === candidateSha,
        },
      };
    },
  };
}

export type ReviewBase =
  | { ok: true; baseSha: string; inferredFrom?: string; spansUnmatched?: boolean }
  | { ok: false; refusal: string };

/** The review's comparison base, resolved AT OPEN.
 *
 *  Stage 2 refuses a review that records no base sha — correctly, since an empty diff there
 *  would auto-confirm the approved contract over a change nobody computed. But no verb
 *  supplies a base after the fact and no verb removes a review, so a review OPENED without
 *  one is stuck at contract confirmation permanently. The base is therefore resolved here,
 *  where a refusal still means "nothing was written": `--since` names it, and otherwise it
 *  is INFERRED from the ticket's landed commit range by the same `resolveCommitRange` that
 *  gives `forge review-loop` its range — the oldest commit whose SUBJECT references the
 *  ticket, minus one.
 *
 *  When inference is impossible (no commit references the ticket, the range starts at a root
 *  commit, or the log cannot be read) this refuses and names `--since`. A review never opens
 *  into a state it cannot advance out of. */
export function resolveReviewBase(ctx: {
  projectDir: string;
  ticketId: string;
  since?: string;
  git?: (args: string[]) => string;
}): ReviewBase {
  const git = ctx.git ?? realGit(ctx.projectDir);
  const revParse = (rev: string): string | undefined => {
    try {
      const sha = git(["rev-parse", rev]).trim();
      return sha === "" ? undefined : sha;
    } catch {
      return undefined;
    }
  };

  if (ctx.since !== undefined) {
    const sha = revParse(ctx.since);
    return sha !== undefined
      ? { ok: true, baseSha: sha }
      : {
          ok: false,
          refusal:
            `--since ${ctx.since} does not resolve to a commit in ${ctx.projectDir}, so the review has no ` +
            `comparison base and its contract could never be confirmed. Nothing was written.`,
        };
  }

  let range;
  try {
    range = resolveCommitRange(ctx.ticketId, { git });
  } catch (err) {
    return {
      ok: false,
      refusal:
        `the commit log in ${ctx.projectDir} could not be read (${(err as Error).message}), so the comparison ` +
        `base for ${ctx.ticketId} cannot be inferred — name it with --since <sha>. Nothing was written.`,
    };
  }
  if (range.mode !== "inferred") {
    return {
      ok: false,
      refusal:
        `no commit subject in ${ctx.projectDir} references ${ctx.ticketId}, so the implementation comparison ` +
        `base cannot be inferred — name it with --since <sha>. A review that records no base sha can never ` +
        `confirm its contract, so it is refused HERE rather than opened into a stage it cannot pass. ` +
        `Nothing was written.`,
    };
  }
  const oldest = range.shas[range.shas.length - 1] as string;
  const baseSha = revParse(`${oldest}^`);
  if (baseSha === undefined) {
    return {
      ok: false,
      refusal:
        `the oldest commit referencing ${ctx.ticketId} (${oldest}) has no parent, so there is nothing to ` +
        `compare the implementation against — name a base with --since <sha>. Nothing was written.`,
    };
  }
  return { ok: true, baseSha, inferredFrom: oldest, spansUnmatched: range.spansUnmatched };
}

export function parseLensWidening(specs: readonly string[]): { ok: true; widening: LensWidening[] } | { ok: false; refusal: string } {
  const widening: LensWidening[] = [];
  for (const spec of specs) {
    // lens:reason:evidence[,evidence…]
    const [lens, reason, evidence] = spec.split(":");
    if (lens === undefined || reason === undefined || evidence === undefined || evidence.trim() === "") {
      return {
        ok: false,
        refusal:
          `--add-lens expects <lens>:<reason>:<diff-evidence> (got '${spec}') — a lens may be added only with ` +
          `the evidence and reason that made it necessary.`,
      };
    }
    widening.push({
      lens: lens.trim() as RiskLens,
      reason: reason.trim(),
      diffEvidence: evidence.split(",").map((e) => e.trim()).filter((e) => e !== ""),
    });
  }
  return { ok: true, widening };
}
