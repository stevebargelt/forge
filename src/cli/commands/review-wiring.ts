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
import type { DependencyEnvironmentReceipt } from "../../v2/dependency-provisioning.js";
import { renderFixBatchEnvelope, verifyMaterializedEnvelope, verifyMaterializedPayload } from "../../store/fix-batches.js";
import { getRun } from "../../store/runs.js";
import { getTask } from "../../store/tasks.js";
import { getDocsDispatch, markDocsDispatchDelivered, openDocsDispatch } from "../../store/reviews.js";
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

/** FG-655 RF-5: stage the paths the commit is about to name, tolerating one git cannot MATCH
 *  because the index already fully represents it.
 *
 *  `git mv` is the idiomatic way for an agent to rename a file, and it leaves the rename
 *  STAGED: the original is gone from the worktree AND from the index, so `git add --
 *  :/<original>` matches nothing anywhere and fails with exit 128 — taking the whole batch
 *  with it, since git validates every pathspec before staging anything. The partial `commit`
 *  that follows would have carried that rename whole straight off the index, and the original
 *  must stay in the COMMIT pathspecs or the deletion is left behind, so the tolerance belongs
 *  in the `add` and nowhere else. (An UNSTAGED rename is a plain deletion git adds happily;
 *  that case never reaches the retry.)
 *
 *  It is narrow by construction: a path is excused only when `git diff --cached` proves the
 *  index ALREADY differs from HEAD for it, which is precisely "there is nothing left to stage".
 *  A path git does not know at all shows nothing there and its error is re-thrown, so a genuine
 *  add failure is still a named refusal rather than silence. Nothing here widens the pathspecs:
 *  the declared-paths-only guarantee is the caller's `moved` set, untouched. */
function stageDeclaredPaths(git: (args: string[]) => string, paths: string[]): void {
  try {
    git(["add", "--", ...paths.map((p) => `:/${p}`)]);
    return;
  } catch {
    // Nothing was staged, so the retry judges each path on its own.
  }
  for (const path of paths) {
    try {
      git(["add", "--", `:/${path}`]);
    } catch (err) {
      if (git(["diff", "--cached", "--name-only", "--no-renames", "-z", "--", `:/${path}`]) === "") throw err;
    }
  }
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

/** FG-655: the docs cycle's subject, and — like the fix cycle's — its STAGE-SCOPED
 *  IDEMPOTENCY KEY. The docs dispatch binding's id is what makes it per-cycle, so a retry
 *  after a crash recognises the commit this coordinator already authored instead of
 *  authoring a second one.
 *
 *  It does NOT reference the ticket, for the same reason `fixCycleSubject` does not:
 *  `resolveReviewBase` infers a later review's comparison base from the OLDEST commit whose
 *  subject references the ticket, and it does not filter docs/ paths out of that inference, so
 *  a ticket-referencing docs commit would anchor a later review on its own documentation.
 *  Written and matched in ONE place. */
function docsCycleSubject(binding: { id: string }): string {
  return `docs(review): docs cycle ${binding.id}`;
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

  // FG-664: the same read, for the dependency-environment receipt the host recorded
  // before this task's container started — cache key plus the node/ABI/native-package
  // identity a FORGE-OWNED probe container attested in the reviewer's exact mount
  // shape. Undefined for a refused/never-dispatched task, for a read-write dispatch,
  // and for the configurations the resolver reports not-applicable (non-darwin,
  // FORGE_NO_NM_SHADOW=1, no package-lock.json).
  const dispatchedDependencyEnvironment = (
    res: InvokeResult,
  ): { dependencyEnvironment: DependencyEnvironmentReceipt } | undefined => {
    if (!res.taskId || !res.runId) return undefined;
    const receipt = readTaskManifest(taskDir(res.runId, res.taskId))?.dependencyEnvironment;
    return receipt ? { dependencyEnvironment: receipt } : undefined;
  };

  // FG-655 AC4: IS THE CHECKOUT CLEAN, AT THE CANDIDATE? One predicate, and it is installed
  // at BOTH in-lifecycle verification readers — the coordinator's verify seam (Stages 1 and
  // 7) and the Stage 9 shipping reader, which calls loop verification directly and bypasses
  // that seam entirely. The head-vs-candidate half already existed; the dirty half is new,
  // and without it a dirty tree at the RIGHT head passed, review-loop degraded to a
  // `dirty tree -- local verification` run, and a green verification line was computed
  // against a tree nobody reviewed. A stage that leaves a dirty tree is a NAMED refusal in
  // its own right, not a silent degradation.
  //
  // IT IS DELIBERATELY NOT INSTALLED IN review-loop.ts. That module's dirty-tree local arm is
  // the STANDALONE loop's intended behaviour for operators with uncommitted work; refusing
  // there would change behaviour for every non-coordinator caller to fix an invariant that
  // belongs to the review lifecycle.
  const workspaceRefusal = (sha: string): { reason: string; message: string } | undefined => {
    const head = headSha();
    if (head !== sha) {
      return {
        reason: "candidate_not_checked_out",
        message:
          `verification cannot run at candidate ${sha}: the workspace at ${ctx.projectDir} is on ${head}. ` +
          `Check the candidate out (or point --project at the workspace that has it) and re-run.`,
      };
    }
    let dirty: string[];
    try {
      dirty = porcelainPaths(git(["status", "--porcelain", "-z", "--untracked-files=all"]));
    } catch (err) {
      return {
        reason: "workspace_unreadable",
        message: `the worktree state at ${ctx.projectDir} could not be read: ${(err as Error).message}`,
      };
    }
    if (dirty.length === 0) return undefined;
    return {
      reason: "workspace_dirty_at_candidate",
      message:
        `verification cannot run at candidate ${sha}: the workspace at ${ctx.projectDir} is ON that candidate but ` +
        `carries uncommitted changes — ${dirty.slice(0, 10).join(", ")}${dirty.length > 10 ? `, +${dirty.length - 10} more` : ""}. ` +
        `A verification run here would silently be about a tree the candidate does not name, and its result would ` +
        `be recorded as evidence about the candidate. Commit those changes (a review stage that produced them ` +
        `should have committed them itself — say so), stash them, or discard them, then re-run.`,
    };
  };

  return {
    headSha,

    verify: async (sha: string): Promise<VerificationEntry> => {
      // review-loop's verify resolves HEAD itself and tolerates a dirty tree by degrading to
      // a local run. If HEAD is not the candidate the coordinator asked about, or the tree is
      // dirty, its answer is about a different tree — say so rather than stamping the
      // requested sha onto someone else's result.
      const refusal = workspaceRefusal(sha);
      if (refusal !== undefined) {
        return {
          ok: false,
          sha,
          detail: refusal.message,
          environmentRefusal: refusal,
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
        stageDeclaredPaths(git, moved);
        git(["commit", "-m", subject, "--", ...moved.map((p) => `:/${p}`)]);
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

    // FG-655: THE DOCS CYCLE'S COMMIT IS THE COORDINATOR'S TOO.
    //
    // Same shape as `commitFixCycle` above and deliberately NOT generalized with it: three
    // similar functions beat a premature base class, and the fix cycle's behaviour must not
    // move because the docs stage acquired the same authority. Every property below is one
    // the fix cycle already justifies in its own comments — one predicate decides adoption
    // for a commit this pass authors and one an earlier pass already made; identity is two
    // terms TOGETHER (the stage-scoped subject key AND an anchored head) and never
    // substitutes for adoption; the declared paths go to `git commit` ITSELF because the
    // index is shared; and the reconciliation runs in both directions.
    commitDocsCycle: async ({ review, binding, declaredFiles }) => {
      const subject = docsCycleSubject(binding);
      const at = headSha();
      const declared = new Set(declaredFiles.map((p) => p.replace(/^\.\//, "")));

      const adoption = (sha: string): { ok: true; committedPaths: string[] } | { ok: false; why: string } => {
        const parents = parentsOf(sha);
        if (parents.length !== 1 || !(parents[0] === review.candidateSha || sha === review.candidateSha)) {
          return {
            ok: false,
            why: `its parent is ${parents.join(" ") || "(none)"}, not the candidate ${review.candidateSha ?? "(unset)"}`,
          };
        }
        const committedPaths = pathsOf(sha);
        const smuggled = committedPaths.filter((p) => !declared.has(p));
        if (smuggled.length > 0) {
          return { ok: false, why: `it carries ${smuggled.join(", ")}, which the docs agent never declared` };
        }
        return { ok: true, committedPaths };
      };
      const notAdopted = (sha: string, why: string) =>
        ({
          kind: "refused",
          reason: "docs_cycle_commit_raced",
          detail:
            `the docs-cycle commit ${sha} in ${ctx.projectDir} did not land as authored — ${why}. ` +
            `Something else wrote this checkout, so the commit is NOT adopted as the candidate and nothing was ` +
            `recorded. Inspect ${sha}, return the checkout to ${review.candidateSha ?? "the candidate"} ` +
            `(\`git reset --soft ${review.candidateSha ?? "<candidate>"}\` puts its content back in the worktree ` +
            `so the coordinator can author the commit itself), and re-run`,
        }) as const;

      // RECOGNISE A COMMIT THIS COORDINATOR ALREADY AUTHORED, first. The git commit is
      // irreversible and the two ledger writes that record it (candidate advance, stage
      // record) are separate transactions after it, so the only way a crash in between is
      // recoverable is for the retry to recognise the commit. Both crash windows land on an
      // anchored HEAD: before the advance, HEAD's PARENT is the candidate; after it, HEAD IS
      // the candidate. The subject key says WHICH commit; adoption still decides WHETHER —
      // a recognition test weaker than the adoption test is a refusal one `continue` away
      // from being reversed (FG-649 RF-7).
      if (subjectOf(at) === subject && (at === review.candidateSha || parentsOf(at).includes(review.candidateSha ?? ""))) {
        const adopted = adoption(at);
        if (!adopted.ok) return notAdopted(at, adopted.why);
        return { kind: "committed", sha: at, committedPaths: adopted.committedPaths, recognized: true };
      }

      // THE COMMIT GOES ON TOP OF THE CANDIDATE OR NOWHERE — and this is also where a docs
      // agent that COMMITTED ITS OWN WORK lands. Its commit is left exactly where it is; the
      // remedy names the soft reset that returns those edits to the worktree so the
      // coordinator authors the commit itself on re-entry.
      if (at !== review.candidateSha) {
        return {
          kind: "refused",
          reason: "candidate_not_checked_out",
          detail:
            `the workspace at ${ctx.projectDir} is on ${at}, not the candidate ${review.candidateSha ?? "(unset)"} ` +
            `this docs cycle was dispatched for — refusing to author a commit on a tree the review is not about. ` +
            `If the docs agent committed its own work, leave that commit alone and run ` +
            `\`git reset --soft ${review.candidateSha ?? "<candidate>"}\` to return its edits to the worktree, so ` +
            `the coordinator authors the docs-cycle commit itself. Otherwise check the candidate out (or point ` +
            `--project at the workspace that has it) and re-run`,
        };
      }

      let moved: string[];
      try {
        moved = porcelainPaths(git(["status", "--porcelain", "-z", "--untracked-files=all"]));
      } catch (err) {
        return {
          kind: "refused",
          reason: "docs_cycle_commit_failed",
          detail:
            `the worktree state at ${ctx.projectDir} could not be read: ${(err as Error).message} — with no ` +
            `porcelain scan there is no declared-path scope, so nothing was staged or committed. Make ` +
            `\`git status\` answer there again (a stale \`.git/index.lock\` from a killed git is the usual cause), ` +
            `or point --project at the checkout that holds the candidate ${review.candidateSha ?? "(unset)"}, then ` +
            `re-run`,
        };
      }

      // THE TREE MOVED BEYOND THE DECLARATION. Named, never swept in — and with an EMPTY
      // declaration this is exactly the FG-655 stranding shape: an agent that claims it
      // changed nothing while its edits sit in the worktree. That is why a legitimate no-op
      // (clean tree) stays distinguishable from a stranded one (this refusal).
      const outside = moved.filter((p) => !declared.has(p));
      if (outside.length > 0) {
        return {
          kind: "refused",
          reason: "docs_cycle_tree_dirty_outside_declared_scope",
          detail:
            `the worktree at ${ctx.projectDir} has changes the docs agent never declared: ` +
            `${outside.slice(0, 10).join(", ")}${outside.length > 10 ? `, +${outside.length - 10} more` : ""} ` +
            `(declared: ${declaredFiles.length > 0 ? declaredFiles.join(", ") : "nothing"}). The docs cycle's ` +
            `commit carries only what the agent itself claimed to change, so an undeclared change is never swept ` +
            `into it. Either have the agent declare every path it touched — an incomplete \`docs_updated\` is a ` +
            `stop, not a tidier answer — or commit/stash/discard the undeclared paths yourself, then re-run`,
        };
      }

      // THE RECONCILIATION IS TWO-DIRECTIONAL, exactly as the fix cycle's is: `outside`
      // catches a tree beyond the declaration, `declaredNotMoved` a declaration beyond the
      // tree. Nothing moved at all is a stop — the claim is wholly unsupported. Something
      // moved is a commit of what moved, NAMING what did not, so `committed ⊆ declared`
      // still holds and the disagreement travels rather than being reconciled away.
      const movedSet = new Set(moved);
      const declaredNotMoved = [...declared].filter((p) => !movedSet.has(p)).sort();
      if (moved.length === 0) {
        if (declaredNotMoved.length > 0) {
          // THE REMEDY MUST BE REACHABLE FROM THIS BRANCH. This is only reached with HEAD AT
          // the candidate (a foreign head refuses candidate_not_checked_out above) and the
          // tree wholly clean, so the soft reset the sibling refusals name would be a no-op
          // here — and the declaration itself is immutable, read off the durable task record
          // every pass, so "correct the declaration" names nothing an operator can do. Both
          // remedies would have made this refusal terminal. `treeCleanAtCandidate` is the
          // caller's authorisation to retire the spent binding instead: a clean tree at the
          // candidate proves nothing of this delivery is in the worktree, so retiring it
          // strands nothing and the next pass runs exactly one more docs agent.
          return {
            kind: "refused",
            reason: "docs_cycle_declared_changes_absent",
            treeCleanAtCandidate: true,
            detail:
              `the docs agent declares ${declaredFiles.join(", ")} but the worktree at ${ctx.projectDir} is clean ` +
              `at the candidate ${review.candidateSha ?? "(unset)"} — its own declaration contradicts the tree, so ` +
              `there is nothing to commit and the claim cannot be honoured. This is deliberately NOT read as a ` +
              `docs cycle that changed nothing: a cycle that legitimately changed nothing declares no paths. The ` +
              `clean tree is also what makes this recoverable — nothing of that delivery is present here to ` +
              `strand, so the spent dispatch is retired and one more docs agent runs`,
          };
        }
        // THE LEGITIMATE NO-OP (AC2): nothing declared, nothing moved, clean tree. The
        // candidate does not move and the stage records candidate-unchanged.
        return { kind: "no_change", sha: at };
      }

      try {
        // THE INDEX IS SHARED; THE COMMIT MUST NOT BE (FG-649 RF-6). Passing the same
        // pathspecs to `commit` makes it a partial commit — git builds the tree from HEAD
        // plus exactly these paths and ignores everything else staged — which closes the
        // stage-then-commit window structurally rather than by narrowing it. The `add` stays
        // because a new docs file is untracked and must be known to git before a pathspec
        // can name it. `:/` makes the pathspecs repo-root relative, matching porcelain.
        // A path the index already fully represents — the far side of a `git mv` — is
        // staged-and-done, and `stageDeclaredPaths` is what keeps that from failing the batch.
        stageDeclaredPaths(git, moved);
        git(["commit", "-m", subject, "--", ...moved.map((p) => `:/${p}`)]);
      } catch (err) {
        // THE REMEDY MUST TERMINATE, not just describe (FG-655 RF-5). This refusal retires
        // nothing and cannot use the clean-tree authorisation — the tree is dirty by
        // definition here — so git's own error text alone would reproduce itself on every
        // subsequent `continue` forever. Both arms below leave the review somewhere a further
        // pass makes progress: a staged tree commits, and a clean tree at the candidate is
        // what `docs_cycle_declared_changes_absent` retires the spent dispatch on.
        return {
          kind: "refused",
          reason: "docs_cycle_commit_failed",
          detail:
            `git refused the docs-cycle commit in ${ctx.projectDir}: ${(err as Error).message}. The docs agent's ` +
            `edits are still in the worktree, so nothing is lost: resolve what git reported — staging the paths ` +
            `yourself (\`git add -- ${moved.slice(0, 5).map((p) => `'${p}'`).join(" ")}\`) is enough, since the ` +
            `commit is taken from the index — and re-run. If those edits cannot be made committable at all, ` +
            `\`git stash\` (or discard) them so the tree is CLEAN at the candidate ` +
            `${review.candidateSha ?? "(unset)"}: a clean tree retires this spent docs dispatch and runs one more ` +
            `documentation-maintainer, so the review moves rather than reproducing this refusal`,
        };
      }

      // AND THE COMMIT IS VERIFIED AFTER THE FACT, which no check made before it can be.
      const sha = headSha();
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

    // FG-655: the declaration, read off the DURABLE task record the binding names. The task
    // record is authoritative (invariant 6) and the binding row is an index of identity only
    // — the declaration is deliberately NOT copied into the ledger, so the two can never
    // drift into disagreeing about what the commit's scope was.
    //
    // A delivery that is absent or unparseable is `unreadable`, never an empty declaration:
    // "the agent said it changed nothing" and "nobody can tell what the agent said" are
    // different facts and only the first may advance a stage.
    docsDelivery: ({ binding }) => {
      if (binding.taskId === undefined) {
        return { kind: "unreadable", detail: `the docs dispatch ${binding.id} never bound a task id` };
      }
      const task = getTask(binding.taskId);
      if (task === undefined) {
        return { kind: "unreadable", detail: `no task ${binding.taskId} exists for docs dispatch ${binding.id}` };
      }
      // FG-655 RF-2: NON-TERMINAL IS NOT DEAD. A task that failed is a dead delivery and joins
      // the unreadable set, where a clean tree at the candidate proves it left nothing behind.
      // Anything else non-terminal — a `running` row a CLI killed mid-dispatch leaves behind
      // permanently, since nothing reaps it — is a dispatch that may still be WRITING, and a
      // clean tree cannot tell that apart from a dead one. Retiring it would dispatch a second
      // maintainer over a live one's checkout, so it gets its own refusal instead.
      if (task.status !== "complete" && task.status !== "failed") {
        return {
          kind: "in_flight",
          taskId: binding.taskId,
          status: task.status,
          detail: `task ${binding.taskId} is ${task.status}, which is neither a terminal delivery nor a dead one`,
        };
      }
      if (task.status !== "complete") {
        return {
          kind: "unreadable",
          detail: `task ${binding.taskId} is ${task.status}, not a terminal successful delivery`,
        };
      }
      const result = task.result;
      if (result === null || typeof result !== "object") {
        return { kind: "unreadable", detail: `task ${binding.taskId} recorded no result object` };
      }
      // The SAME `docs_updated` read `assessRunDocsImpact` makes — the documentation
      // maintainer's contract already returns it, so the coordinator does not have to invent
      // a second declaration channel for the same fact.
      //
      // FG-655 RF-3: an ABSENT field is unreadable, not an empty declaration. The contract
      // REQUIRES `docs_updated`, so its omission is a contract violation — reading it as the
      // agent's positive claim that it changed nothing is exactly the conflation the
      // unreadable/delivered split exists to prevent.
      const raw = (result as Record<string, unknown>)["docs_updated"];
      if (raw === undefined) {
        return {
          kind: "unreadable",
          detail:
            `task ${binding.taskId} recorded no docs_updated at all — the documentation-maintainer contract ` +
            `requires the field, so its absence is a contract violation, not a claim that nothing changed`,
        };
      }
      if (!Array.isArray(raw)) {
        return { kind: "unreadable", detail: `task ${binding.taskId} recorded a non-array docs_updated` };
      }
      // FG-655 AC2, the same class as the absent case above: a MALFORMED MEMBER fails closed
      // by name too. Filtering the non-strings away turned `docs_updated: [42]` into `[]` —
      // which the stage reads as the agent's positive claim that it changed nothing — so a
      // contract violation reached the clean-tree no_change path as the legitimate no-op.
      const docsUpdated: string[] = [];
      const malformed: string[] = [];
      raw.forEach((p, i) => {
        if (typeof p === "string") docsUpdated.push(p);
        else malformed.push(`[${i}]=${JSON.stringify(p) ?? String(p)}`);
      });
      if (malformed.length > 0) {
        return {
          kind: "unreadable",
          detail:
            `task ${binding.taskId} recorded a docs_updated with ${malformed.length} non-string member(s) ` +
            `(${malformed.join(", ")}) — the documentation-maintainer contract requires a list of paths, so ` +
            `nobody can tell which paths that agent claims it changed`,
        };
      }
      return { kind: "delivered", taskId: binding.taskId, docsUpdated };
    },

    dispatchDocs: async ({ review, candidateSha }: { review: Review; candidateSha: string }) => {
      // CREATE THE BINDING BEFORE THE DISPATCH, AND COMPLETE IT AT MINT TIME. The row exists
      // before `invoke` is even called, and the host-minted task identity is written onto it
      // from invoke's mint-time hook — after the task row and its `task.created` event are
      // durable and before anything can start a container. NO CONTAINER WRITE MAY PRECEDE
      // THE BINDING: a crash mid-dispatch must leave behind the fact that a docs agent WAS
      // dispatched, or re-entry runs a second one over its own output.
      const binding = openDocsDispatch(review.id, candidateSha);
      const res = await dispatch({
        agentRole: REVIEW_DISPATCH_ROLES.docs,
        task:
          `Reconcile durable operator-facing docs against the change under review ` +
          `(${review.ticketId ?? "(no ticket)"}) at candidate ${candidateSha}. This phase runs BEFORE final ` +
          `verification and recheck, so it may change the candidate.\n\n` +
          `DO NOT COMMIT. The review coordinator authors this cycle's commit from your declaration: list EVERY ` +
          `path you touched in \`docs_updated\`, including adjacent ones (an index, a cross-reference, a rendered ` +
          `block) a narrative summary would omit. A path you touched but did not declare STOPS the review; a path ` +
          `you declare but did not change is named too. Committing your own work refuses candidate_not_checked_out.`,
        projectDir: ctx.projectDir,
        ...(runIdFor() !== undefined ? { runId: runIdFor() as string } : {}),
        runTitle: `review docs reconciliation — ${ctx.ticketId}`,
        ...(ctx.route !== undefined ? { routeKey: ctx.route } : {}),
        onTaskMinted: (identity) => {
          markDocsDispatchDelivered(binding.id, identity);
        },
      });
      return {
        ok: res.status === "complete",
        binding: getDocsDispatch(binding.id) ?? binding,
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
        // FG-664: the CLASSIFIED failure, forwarded so Stage 8 can tell an
        // environment fault (`verification_environment_unavailable` — the host
        // refused the dispatch because it could not give this lane the project's
        // real native dependencies) from a rechecker that ran and crashed. The
        // first is a STOP; the second is a refusal that re-enters.
        ...(res.failureKind !== undefined ? { failureKind: res.failureKind } : {}),
        // FG-664 / AC3: the engine identity the host attested for THIS dispatch,
        // read back off the task manifest exactly the way the protocol stamp above
        // is. The manifest is authoritative (invariant 6); the stage evidence the
        // coordinator writes from this is an index of it.
        ...dispatchedDependencyEnvironment(res),
        ...dispatchedProtocol(res),
        ...(res.error !== undefined ? { error: res.error } : {}),
      };
    },

    shippingInput: async ({ review, candidateSha }) => {
      // FG-655 AC4, THE SECOND READER. Stage 9 calls loop verification DIRECTLY and bypasses
      // the `verify` seam above entirely, and its result is the verification block operators
      // read as authoritative — so the same predicate is installed here, ahead of the run.
      // Without it a dirty tree at the candidate produced a green-looking shipping check
      // computed against a tree the candidate does not name.
      const refusal = workspaceRefusal(candidateSha);
      const verification = refusal !== undefined ? undefined : await loop.deps.verify();
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
        verification:
          verification === undefined
            ? {
                ok: false,
                sha: candidateSha,
                executedRequiredChecks: false,
                detail: `${(refusal as { reason: string }).reason}: ${(refusal as { message: string }).message}`,
                // FG-655 AC4: the refusal keeps its NAME across the seam. A workspace that
                // could not be verified means verification COULD NOT RUN — the lifecycle's
                // `blocked_environment` stop — and Stage 9 can only tell that apart from a
                // failed check if the refusal reaches it as one.
                environmentRefusal: refusal as { reason: string; message: string },
              }
            : {
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

/** Which rule produced the base. Stated in `forge review start`'s output (FG-674) so an
 *  operator reads WHY this base was chosen rather than inferring it from a parenthetical. */
export type ReviewBaseBasis = "since" | "merge-base" | "ticket-range";

export type ReviewBase =
  | {
      ok: true;
      baseSha: string;
      basis: ReviewBaseBasis;
      /** The default branch the branch point was computed against — `merge-base` basis only. */
      defaultBranch?: string;
      inferredFrom?: string;
      spansUnmatched?: boolean;
    }
  | { ok: false; refusal: string };

/** A CONVENTIONAL subject prefix — the subject OPENS with the ticket id and a colon
 *  ("FG-674: …", "#301: …"), rather than mentioning it mid-sentence. Same right boundary as
 *  `ticketSubjectPattern` so FG-674 never also matches FG-6740 or FG-674-a. */
function ticketSubjectPrefixPattern(ticketId: string): RegExp {
  const id = ticketId.replace(/^#/, "").trim();
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#?${escaped}(?![0-9]|-[A-Za-z0-9])\\s*:`);
}

/** True when every path this commit changed is backlog/planning material, which by construction
 *  cannot be an implementation commit. This is the FG-674 defect in one predicate: an
 *  orchestrator's own session hygiene ("plan: FG-666 shipped; FG-648 to Now ahead of FG-609")
 *  names a ticket as a QUEUE POSITION long before any code exists, so those commits are the
 *  OLDEST ones mentioning it and anchored the base three commits too early.
 *
 *  Unreadable or empty (a merge commit shows no paths) reads as NOT planning-only: this filter
 *  may only ever narrow the candidate set on positive evidence. */
function changesOnlyPlanningPaths(sha: string, git: (args: string[]) => string): boolean {
  let out: string;
  try {
    out = git(["show", "--name-only", "--format=", sha]);
  } catch {
    return false;
  }
  const paths = out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return paths.length > 0 && paths.every((p) => p.startsWith("backlog/"));
}

/** The review's comparison base, resolved AT OPEN by the FIRST RULE THAT APPLIES (FG-674):
 *
 *    1. `--since` — the operator named it.
 *    2. merge-base with the default branch, when the candidate is on a feature branch. The
 *       branch point needs no text heuristics at all.
 *    3. ticket-range inference — the oldest commit whose SUBJECT references the ticket AND
 *       which changes something other than backlog/planning paths, minus one.
 *    4. otherwise refuse, naming `--since`. Never silently widen.
 *
 *  Stage 2 refuses a review that records no base sha — correctly, since an empty diff there
 *  would auto-confirm the approved contract over a change nobody computed. But no verb
 *  supplies a base after the fact and no verb removes a review, so a review OPENED without
 *  one is stuck at contract confirmation permanently. The base is therefore resolved here,
 *  where a refusal still means "nothing was written". Rule 3 keeps using the same
 *  `resolveCommitRange` that gives `forge review-loop` its range — that contract is shared, so
 *  the planning-commit filtering lives HERE, at the review-base layer, and review-loop's range
 *  is unchanged.
 *
 *  When no rule can produce a base (no commit references the ticket, every commit that does is
 *  planning material, the range starts at a root commit, or the log cannot be read) this
 *  refuses and names `--since`. A review never opens into a state it cannot advance out of. */
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
      ? { ok: true, baseSha: sha, basis: "since" }
      : {
          ok: false,
          refusal:
            `--since ${ctx.since} does not name a commit in ${ctx.projectDir}, so the review has no ` +
            `comparison base and its contract could never be confirmed. A 40-hex string that is not a commit ` +
            `in this repository is refused here for the same reason: bare rev-parse echoes it back, but every ` +
            `later diff against it fails. Nothing was written.`,
        };
  }

  const branchPoint = mergeBaseWithDefaultBranch(git, revParseCommit);
  if (branchPoint !== undefined) {
    return { ok: true, baseSha: branchPoint.baseSha, basis: "merge-base", defaultBranch: branchPoint.branch };
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
  const implementation = range.shas.filter((sha) => !changesOnlyPlanningPaths(sha, git));
  if (implementation.length === 0) {
    return {
      ok: false,
      refusal:
        `every commit whose subject references ${ctx.ticketId} in ${ctx.projectDir} changes only backlog/ ` +
        `paths, so none of them implements it and the comparison base cannot be inferred — name it with ` +
        `--since <sha>. Widening to the oldest of them would anchor the review on planning material and pull ` +
        `unrelated shipped work into the confirmation diff, so it is refused HERE. Nothing was written.`,
    };
  }

  // Newest-first, so the LAST entry is the oldest. A conventional `FG-NNN:` subject prefix is a
  // stronger claim to be the ticket's implementation than an incidental mid-sentence mention, so
  // the oldest prefixed commit anchors the base when any exists.
  const subjects = commitSubjects(git);
  const prefixRe = ticketSubjectPrefixPattern(ctx.ticketId);
  const prefixed = implementation.filter((sha) => prefixRe.test(subjects.get(sha) ?? ""));
  const preferred = prefixed.length > 0 ? prefixed : implementation;
  const oldest = preferred[preferred.length - 1] as string;

  const baseSha = revParseCommit(`${oldest}^`);
  if (baseSha === undefined) {
    return {
      ok: false,
      refusal:
        `the oldest commit referencing ${ctx.ticketId} (${oldest}) has no parent, so there is nothing to ` +
        `compare the implementation against — name a base with --since <sha>. Nothing was written.`,
    };
  }
  return {
    ok: true,
    baseSha,
    basis: "ticket-range",
    inferredFrom: oldest,
    spansUnmatched: spansUnmatchedFrom(oldest, range, git),
  };
}

/** Rule 2: the branch point. Undefined — fall through to ticket-range inference — whenever the
 *  candidate is NOT on a feature branch off the default branch: HEAD is the default branch
 *  itself, the merge base IS HEAD (already-merged work, where this rule would compute an empty
 *  range), or the default branch cannot be resolved at all. */
function mergeBaseWithDefaultBranch(
  git: (args: string[]) => string,
  revParseCommit: (rev: string) => string | undefined,
): { baseSha: string; branch: string } | undefined {
  const head = revParseCommit("HEAD");
  if (head === undefined) return undefined;
  const def = resolveDefaultBranch(git, revParseCommit);
  if (def === undefined) return undefined;
  const current = tryGit(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current === def.name) return undefined;
  const mergeBase = tryGit(git, ["merge-base", "HEAD", def.ref]);
  if (mergeBase === undefined) return undefined;
  const sha = revParseCommit(mergeBase);
  // A merge base is an ancestor of HEAD by construction; PROPER is the part that matters, and
  // it is exactly what excludes already-merged work whose merge base is its own tip.
  if (sha === undefined || sha === head) return undefined;
  return { baseSha: sha, branch: def.name };
}

/** The default branch, resolved rather than assumed to be `main`: origin/HEAD names it when the
 *  remote published one, otherwise the conventional names are tried. The local branch is
 *  preferred over its remote-tracking ref — the branch point is where the feature branch left
 *  the checkout's own default branch. */
function resolveDefaultBranch(
  git: (args: string[]) => string,
  revParseCommit: (rev: string) => string | undefined,
): { name: string; ref: string } | undefined {
  const published = tryGit(git, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const names = [...(published !== undefined ? [published.replace(/^origin\//, "")] : []), "main", "master"];
  for (const name of names) {
    if (name === "") continue;
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      if (revParseCommit(ref) !== undefined) return { name, ref };
    }
  }
  return undefined;
}

function tryGit(git: (args: string[]) => string, args: string[]): string | undefined {
  try {
    const out = git(args).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** Every commit's subject, by sha. Same `%H %s` read `resolveCommitRange` does — `%s` is
 *  newline-free, so one line per commit. */
function commitSubjects(git: (args: string[]) => string): Map<string, string> {
  const subjects = new Map<string, string>();
  const log = tryGit(git, ["log", "--format=%H %s"]);
  if (log === undefined) return subjects;
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const sp = trimmed.indexOf(" ");
    subjects.set(sp === -1 ? trimmed : trimmed.slice(0, sp), sp === -1 ? "" : trimmed.slice(sp + 1));
  }
  return subjects;
}

/** Does the span from the chosen anchor still include commits that do not reference the ticket?
 *  `resolveCommitRange` already answered that for ITS oldest match; when the planning filter or
 *  the prefix preference moved the anchor later, the span shrank and the answer is recomputed. */
function spansUnmatchedFrom(
  anchor: string,
  range: { shas: string[]; spansUnmatched: boolean },
  git: (args: string[]) => string,
): boolean {
  const at = range.shas.indexOf(anchor);
  if (at === range.shas.length - 1) return range.spansUnmatched;
  const newest = range.shas[0] as string;
  const span = tryGit(git, ["log", "--format=%H", `${anchor}^..${newest}`]);
  if (span === undefined) return range.spansUnmatched;
  const count = span.split("\n").filter((l) => l.trim() !== "").length;
  return count !== at + 1;
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
