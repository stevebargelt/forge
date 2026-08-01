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
import { fixBatchBundleDir, taskDir } from "../../util/paths.js";
import { readTaskManifest } from "../../v2/task-manifest.js";
import type { LensProtocolRecord } from "../../v2/review-discovery.js";
import { renderFixBatchEnvelope, verifyMaterializedEnvelope, verifyMaterializedPayload } from "../../store/fix-batches.js";
import { getRun } from "../../store/runs.js";
import type { CoordinatorDeps, FixerContext, LensContext, RecheckContextIn } from "../../v2/review-run.js";
import type { VerificationEntry } from "../../v2/review-coordinator.js";
import type { ContractProposal, LensWidening, RiskLens } from "../../v2/review-contract.js";
import { REVIEW_DISPATCH_ROLES } from "../../v2/review-contract.js";
import type { AcClaim } from "../../v2/review-evidence.js";
import type { DocsCloseout } from "../../v2/review-shipping.js";
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
  /** FG-640 shipping duty 6, read from --docs-closeout <file.json>. Absent means NOT
   *  assessed — which the eighth check blocks on, deliberately: the reviewer's duty is to
   *  look, and an unasked question is not a clean answer. */
  docsCloseout?: DocsCloseout;
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

/** FG-649: the paths `git status --porcelain -z --untracked-files=all` reports as moved.
 *
 *  `-z` because a NUL-separated record is the only form that cannot be misread on a path
 *  containing a space, a quote or a newline — the C-quoting of the non-`-z` format would have
 *  to be un-quoted here, and a scope guard that mis-parses a path is a scope guard that
 *  commits the wrong file. `--untracked-files=all` because a fixer's new test file is
 *  untracked and is exactly the evidence the recheck depends on.
 *
 *  Porcelain paths are relative to the REPOSITORY ROOT (unlike the human format, which is
 *  relative to cwd), so they are comparable to the fixer's declared paths without knowing
 *  where the git seam's cwd sits. A rename reports BOTH its new and its original path, and
 *  both are returned: staging a rename without its source leaves the deletion uncommitted. */
function porcelainPaths(out: string): string[] {
  const fields = out.split("\0").filter((f) => f !== "");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i] as string;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // `R`/`C` in either column: the ORIGINAL path is the next NUL-separated field.
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      i += 1;
      const origin = fields[i];
      if (origin !== undefined) paths.push(origin);
    }
  }
  return [...new Set(paths)];
}

/** THE SUBJECT IS AN INTERFACE, NOT A LOG LINE, and since FG-649/RF-2 it is also the fix
 *  cycle's per-revision IDEMPOTENCY KEY: it is how a retry after a crash recognises the commit
 *  this coordinator already authored instead of refusing forever. It must not reference the
 *  ticket — `resolveCommitRange` infers a later review's comparison base from the OLDEST commit
 *  whose subject references the ticket, and a review whose base is inferred as its own
 *  remediation commit can never confirm its contract. One definition, because a subject written
 *  in one place and matched in another is a key that silently stops matching. */
function fixCycleSubject(batch: { id: string; revision: number }): string {
  return `fix(review): fix batch ${batch.id} revision ${batch.revision}`;
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

  // FG-649 RF-2/RF-6: the three reads that describe a commit that already exists. Each answers
  // "" / [] when git cannot answer, and every caller treats that as NOT RECOGNISED and NOT
  // VERIFIED — an unreadable commit is never adopted on the strength of a read that failed.
  const subjectOf = (sha: string): string => {
    try {
      return git(["log", "-1", "--format=%s", sha]).trim();
    } catch {
      return "";
    }
  };
  const parentsOf = (sha: string): string[] => {
    try {
      return git(["rev-list", "-1", "--parents", sha]).trim().split(/\s+/).filter((f) => f !== "").slice(1);
    } catch {
      return [];
    }
  };
  const pathsOf = (sha: string): string[] => {
    try {
      return [...new Set(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha]).split("\0"))].filter(
        (p) => p !== "",
      );
    } catch {
      return [];
    }
  };

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

  // FG-654: read the dispatched task's RECORDED protocol stamp back off its manifest.
  // Two independent artifacts by design — the manifest is authoritative (invariant 6),
  // the ledger row below is an index of it (invariant 20). If they ever disagree, that
  // drift is stated, never reconciled here. Undefined for a refused/never-dispatched
  // task (no manifest is written) and for pre-FG-654 manifests.
  // The taskId is REQUIRED in this return, unlike LensProtocolRecord's: it is read off the
  // manifest of a task that demonstrably dispatched, and the ledger record it feeds keys
  // on it. A record naming no task names no dispatch.
  const dispatchedProtocol = (
    res: InvokeResult,
  ): { protocol: LensProtocolRecord & { taskId: string } } | undefined => {
    if (!res.taskId || !res.runId) return undefined;
    const stamp = readTaskManifest(taskDir(res.runId, res.taskId))?.agentProtocol;
    if (!stamp) return undefined;
    return { protocol: { role: stamp.role, sha256: stamp.sha256, taskId: res.taskId } };
  };

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
        // FG-654: a protocol refusal's failureKind is the bare `stale_protocol` literal,
        // so the message that names both shas and the remedy would otherwise be dropped.
        ...(res.failureKind !== undefined && res.error !== undefined ? { detail: res.error } : {}),
        result: res.result,
        taskId: res.taskId,
        // FG-654: WHICH protocol generation this lens actually ran under, read back off
        // the dispatched task's manifest — the ledger INDEXES the manifest, it does not
        // restate it. Per DISPATCH, so two lenses on two generations record two shas.
        ...(dispatchedProtocol(res) ?? {}),
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
        agentRole: REVIEW_DISPATCH_ROLES.fixBatch,
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
      const stamp = dispatchedProtocol(res);
      return {
        ok: res.status === "complete",
        taskId: res.taskId,
        result: res.result,
        ...(res.error !== undefined ? { error: res.error } : {}),
        // FG-654: the fixer's own protocol generation — the `engineer` seed carries the
        // batch-remediation rules, and a fixer running a seed that never had them is the
        // measured cause of "named its verification tests but never executed them".
        ...(stamp ? { protocol: { role: stamp.protocol.role, sha256: stamp.protocol.sha256 } } : {}),
      };
    },

    // FG-649 change 1: THE FIX CYCLE'S COMMIT IS THE COORDINATOR'S, so the post-fix sha is one
    // forge CREATED rather than one it read back and hoped was the right one. The orchestrator
    // no longer commits a review fix cycle.
    //
    // ONLY THE DECLARED PATHS ARE COMMITTED. The expected-changes set is the fixer's own
    // per-finding `files_changed` claim, read back from the ledger — so a tree that moved
    // outside it is NAMED rather than swept in by `git add -A`. That matters because this is a
    // WRITE into an operator checkout that other agents may be editing concurrently.
    //
    // THE SUBJECT IS AN INTERFACE, NOT A LOG LINE — see `fixCycleSubject`, which is also the
    // per-revision idempotency key the recovery arm below matches on.
    commitFixCycle: async ({ review, batch, declaredFiles }) => {
      const subject = fixCycleSubject(batch);
      const at = headSha();
      const declared = new Set(declaredFiles.map((p) => p.replace(/^\.\//, "")));

      // FG-649 RF-7: ONE PREDICATE DECIDES ADOPTION, for every commit that could become the
      // candidate — the one this pass authors and the one an earlier pass already did. Recognition
      // used to be a strictly WEAKER test (subject + anchor, nothing else), which made the
      // post-commit refusal below non-durable: a commit refused `fix_cycle_commit_raced` for
      // carrying an undeclared path, or for being a merge, was adopted verbatim by the very next
      // `forge review continue` — the same commit, the same content, a different door. The
      // refusal's own advice is "reset the checkout and re-run", and re-running WITHOUT the reset
      // is exactly what converted it. Adoption is one question, so it gets one answer.
      //
      // ANCHOR: the review's candidate is the commit's sole parent (a cycle whose ledger writes
      // have not run yet) or the commit ITSELF (a cycle whose candidate advance already landed —
      // the row moved, so its pre-fix parent is no longer knowable from it). On the authored path
      // only the first arm is reachable: a commit that just landed is not the sha it sits on.
      const adoption = (sha: string): { ok: true; committedPaths: string[] } | { ok: false; why: string } => {
        const parents = parentsOf(sha);
        // Exactly one parent: a merge carries a second history the review never saw.
        if (parents.length !== 1 || !(parents[0] === review.candidateSha || sha === review.candidateSha)) {
          return {
            ok: false,
            why:
              `its parent is ${parents.join(" ") || "(none)"}, not the candidate ` +
              `${review.candidateSha ?? "(unset)"}`,
          };
        }
        const committedPaths = pathsOf(sha);
        const smuggled = committedPaths.filter((p) => !declared.has(p));
        if (smuggled.length > 0) {
          return { ok: false, why: `it carries ${smuggled.join(", ")}, which no fix result declared` };
        }
        return { ok: true, committedPaths };
      };
      const notAdopted = (sha: string, why: string) =>
        ({
          kind: "refused",
          reason: "fix_cycle_commit_raced",
          detail:
            `the fix-cycle commit ${sha} in ${ctx.projectDir} did not land as authored — ${why}. ` +
            `Something else wrote this checkout, so the commit is NOT adopted as the candidate and nothing was ` +
            `recorded. Inspect ${sha}, reset the checkout to ${review.candidateSha ?? "the candidate"}, and re-run`,
        }) as const;

      // FG-649 RF-2: FIRST, RECOGNISE A COMMIT THIS COORDINATOR ALREADY AUTHORED.
      //
      // The git commit is an irreversible external write and the three ledger writes that
      // record it (candidate advance, resolution invalidation, stage record) are separate
      // SQLite transactions after it. Nothing can make those atomic with git, so the only
      // way a crash in between is recoverable is for the retry to RECOGNISE the commit. The
      // subject is already a per-revision idempotency key, and both crash windows land on an
      // anchored HEAD: crash before the candidate advance leaves HEAD's PARENT at the
      // candidate, crash after it leaves HEAD AT the candidate. Without this, the first
      // refuses `candidate_not_checked_out` forever and the second
      // `fix_cycle_declared_changes_absent` forever — the exact FG-649 stuck loop, whose only
      // exits were hand re-anchoring or re-dispatching a fixer over already-fixed code.
      //
      // BOTH HALVES ARE REQUIRED. The subject alone would let any commit carrying that text
      // be adopted as the candidate; the anchor alone would adopt any commit sitting on the
      // candidate. Together they say: this commit is on the tree under review AND names this
      // batch revision, which is what the coordinator's own commit does and nothing else.
      //
      // AND THEY IDENTIFY THE COMMIT, THEY DO NOT VET IT (FG-649 RF-7). Which commit this is and
      // whether it landed as this coordinator would have authored it are different questions, so
      // an anchored commit still goes through the one adoption predicate above.
      if (subjectOf(at) === subject && (at === review.candidateSha || parentsOf(at).includes(review.candidateSha ?? ""))) {
        const adopted = adoption(at);
        if (!adopted.ok) return notAdopted(at, adopted.why);
        return { kind: "committed", sha: at, committedPaths: adopted.committedPaths, recognized: true };
      }

      // THE COMMIT GOES ON TOP OF THE CANDIDATE OR NOWHERE. This is the same HEAD-vs-candidate
      // comparison `verify` makes, under the same name, and it is not redundant with it: by the
      // time Stage 5 commits, that check ran stages ago. A fix-cycle commit authored on a head
      // the review is not about would produce a candidate whose parent is a foreign tree — a
      // silently mis-anchored evidence ledger rather than a stop.
      if (at !== review.candidateSha) {
        return {
          kind: "refused",
          reason: "candidate_not_checked_out",
          detail:
            `the workspace at ${ctx.projectDir} is on ${at}, not the candidate ${review.candidateSha ?? "(unset)"} ` +
            `this fix cycle was dispatched for — refusing to author a commit on a tree the review is not about. ` +
            `Check the candidate out (or point --project at the workspace that has it) and re-run`,
        };
      }

      let moved: string[];
      try {
        moved = porcelainPaths(git(["status", "--porcelain", "-z", "--untracked-files=all"]));
      } catch (err) {
        return {
          kind: "refused",
          reason: "fix_cycle_commit_failed",
          detail: `the worktree state at ${ctx.projectDir} could not be read: ${(err as Error).message}`,
        };
      }

      const outside = moved.filter((p) => !declared.has(p));
      if (outside.length > 0) {
        return {
          kind: "refused",
          reason: "fix_cycle_tree_dirty_outside_declared_scope",
          detail:
            `the worktree at ${ctx.projectDir} has changes no fix result declared: ${outside.slice(0, 10).join(", ")}` +
            `${outside.length > 10 ? `, +${outside.length - 10} more` : ""} (declared: ` +
            `${declaredFiles.length > 0 ? declaredFiles.join(", ") : "nothing"}). The fix cycle's commit carries ` +
            `only what the fixer itself claimed to change, so an undeclared change is never swept into it`,
        };
      }
      // FG-649 RF-5: THE RECONCILIATION IS TWO-DIRECTIONAL. `outside` above catches a tree that
      // moved beyond the declaration; `absent` catches a DECLARATION that reaches beyond the
      // tree. It used to be consulted only for an ENTIRELY clean worktree, so a partly-
      // fabricated `files_changed` went through in silence: declare [a, b], dirty only `a`, and
      // the cycle committed `a` while the stage record stored declaredFiles [a, b] beside
      // committedPaths [a] with nothing naming the disagreement.
      //
      // THE TWO CASES ARE NOT THE SAME STOP, and deliberately so:
      //   - nothing moved at all -> refuse. The claim is wholly unsupported, there is nothing to
      //     commit, and a resolution without a code change must declare no files.
      //   - something moved -> COMMIT WHAT MOVED and NAME what did not. `committed ⊆ declared`
      //     still holds, so the commit-only-declared-paths invariant is intact, and the
      //     discrepancy travels on the outcome into the stage record and the operator's line.
      //     Refusing here instead would dead-end a converging review: a second fix cycle that
      //     re-writes a test file it already committed declares it honestly and moves nothing,
      //     and no re-entry can ever change that — which is the FG-649 stuck loop again, bought
      //     for a disagreement the recheck is what actually adjudicates.
      const movedSet = new Set(moved);
      const declaredNotMoved = [...declared].filter((p) => !movedSet.has(p)).sort();
      if (moved.length === 0) {
        if (declaredNotMoved.length > 0) {
          return {
            kind: "refused",
            reason: "fix_cycle_declared_changes_absent",
            detail:
              `the fix results declare ${declaredFiles.join(", ")} but the worktree at ${ctx.projectDir} is clean — ` +
              `the fixer's own ledger claim contradicts the tree, so there is nothing to commit and the claim ` +
              `cannot be honoured. This is deliberately NOT read as a resolution without a code change: a cycle ` +
              `that legitimately changed nothing declares no files`,
          };
        }
        // A legitimate no-change cycle. The candidate does not move, and fixCycleKey already
        // makes this cycle earn its own recheck even at an unmoved candidate.
        return { kind: "no_change", sha: headSha() };
      }

      try {
        // FG-649 RF-6: THE INDEX IS SHARED; THE COMMIT MUST NOT BE. `git add` + a bare `git
        // commit` commits whatever the INDEX holds at commit time, so a process sharing this
        // checkout could stage an undeclared file between the porcelain scan and the commit
        // and have it carried into a review-authored commit. Passing the same pathspecs to
        // `commit` makes it a partial commit — git builds the tree from HEAD plus exactly
        // these paths and ignores everything else staged — which closes that window
        // structurally rather than by narrowing it. The `add` stays because an untracked
        // path (a fixer's new test file) must be known to git before a pathspec can name it.
        //
        // `:/`-prefixed pathspecs are repo-root relative, matching what porcelain reported —
        // the git seam's cwd need not be the repository root for the add to name the same file.
        const pathspecs = moved.map((p) => `:/${p}`);
        git(["add", "--", ...pathspecs]);
        git(["commit", "-m", subject, "--", ...pathspecs]);
      } catch (err) {
        return {
          kind: "refused",
          reason: "fix_cycle_commit_failed",
          detail: `git refused the fix-cycle commit in ${ctx.projectDir}: ${(err as Error).message}`,
        };
      }

      // FG-649 RF-6: AND THE COMMIT IS VERIFIED AFTER THE FACT, which no check made before it
      // can be. A concurrent writer advancing HEAD between the candidate check and the commit
      // would give the review a candidate whose parent is a foreign tree; reading the parent
      // and the touched paths off the commit that actually landed is the only statement about
      // it with no window at all. It does not un-commit — it refuses to ADOPT, which is the
      // decision that matters: nothing is recorded and the sha never becomes the candidate.
      const sha = headSha();
      // The predicate's self-anchor arm belongs to RECOVERY, where the candidate advance already
      // moved the row onto the commit. On this path the row has not moved, so a HEAD still at the
      // candidate means the commit git just reported making is not there — a writer rewound the
      // checkout — and the cycle must not record itself against a tree without the fixes in it.
      if (sha === review.candidateSha) {
        return notAdopted(sha, `HEAD is still the candidate, so the commit that was just authored is not there`);
      }
      const adopted = adoption(sha);
      if (!adopted.ok) return notAdopted(sha, adopted.why);
      return {
        kind: "committed",
        sha,
        committedPaths: adopted.committedPaths,
        ...(declaredNotMoved.length > 0 ? { declaredNotMoved } : {}),
      };
    },

    dispatchDocs: async ({ review, candidateSha }: { review: Review; candidateSha: string }) => {
      const res = await dispatch({
        agentRole: REVIEW_DISPATCH_ROLES.docs,
        task:
          `Reconcile durable operator-facing docs against the change under review ` +
          `(${review.ticketId ?? "(no ticket)"}) at candidate ${candidateSha}. This phase runs BEFORE final ` +
          `verification and recheck, so it may change the candidate.`,
        projectDir: ctx.projectDir,
        ...(runIdFor() !== undefined ? { runId: runIdFor() as string } : {}),
        runTitle: `review docs reconciliation — ${ctx.ticketId}`,
        ...(ctx.route !== undefined ? { routeKey: ctx.route } : {}),
      });
      return {
        ok: res.status === "complete",
        ...dispatchedProtocol(res),
        ...(res.error !== undefined ? { error: res.error } : {}),
      };
    },

    dispatchRechecker: async (recheckCtx: RecheckContextIn) => {
      const res = await dispatch({
        agentRole: REVIEW_DISPATCH_ROLES.recheck,
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
        ...dispatchedProtocol(res),
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
        ...(ctx.docsCloseout !== undefined ? { docsCloseout: ctx.docsCloseout } : {}),
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
  // COMMIT-NESS IS CHECKED, NOT ASSUMED. Bare `git rev-parse <40-hex>` ECHOES any 40-hex
  // string back with exit 0 without ever consulting the object store, so a sha that was
  // rebased away, gc'd, or pasted from another repo "resolved" here and opened exactly the
  // permanently-stuck review this function exists to prevent — Stage 2's
  // `git diff --name-only <base>..<candidate>` then dies inside execFileSync with a raw stack
  // trace, no verb supplies a base after the fact, and no verb removes a review.
  // `rev-parse --verify <rev>^{commit}` is the idiom that both consults the object store and
  // requires the object to be a commit rather than a tag, tree or blob.
  const revParseCommit = (rev: string): string | undefined => {
    try {
      const sha = git(["rev-parse", "--verify", `${rev}^{commit}`]).trim();
      return sha === "" ? undefined : sha;
    } catch {
      return undefined;
    }
  };

  if (ctx.since !== undefined) {
    const sha = revParseCommit(ctx.since);
    return sha !== undefined
      ? { ok: true, baseSha: sha }
      : {
          ok: false,
          refusal:
            `--since ${ctx.since} does not name a commit in ${ctx.projectDir}, so the review has no ` +
            `comparison base and its contract could never be confirmed. A 40-hex string that is not a commit ` +
            `in this repository is refused here for the same reason: bare rev-parse echoes it back, but every ` +
            `later diff against it fails. Nothing was written.`,
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
  const baseSha = revParseCommit(`${oldest}^`);
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
