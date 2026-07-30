// FG-638 (evidence-led review, Change 1): the operator surfaces over the review
// ledger — reading a review, and recording a disposition with its authority and
// preconditions enforced.
//
// FG-639 (Change 2) adds the coordinator's two verbs. `start` verifies, confirms the
// contract against the final diff, discovers, and STOPS at disposition when findings
// exist — it never fixes. `continue` drives the ONE valid next transition from durable
// state and never repeats a completed stage; both read what to do next from the ledger
// rather than from anything the process that started the review was holding.
//
// FG-640 (Change 3) landed both of the things this header used to disclaim: `feature` declares
// `review_mode: evidence_led`, so these verbs now drive the ledger that SETTLES its build gate
// (`review_disposition`) rather than a pilot running beside verdict aggregation.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import { assertStoreForLookup } from "../no-store.js";
import {
  DISPOSITIONS,
  DISPROVING_EVIDENCE_KINDS,
  recordDisposition,
  lookupFinding,
  recordLensAcceptance,
  summarizeReview,
  insertReview,
  getReview,
  findingsForReview,
  updateReview,
  type Disposition,
  type Review,
  type ReviewFinding,
  type ReviewSummary,
} from "../../store/reviews.js";
import { fixBatchesForReview } from "../../store/fix-batches.js";
import { getRun } from "../../store/runs.js";
import { computeRepositoryEvidence, registryByEvidence } from "../../store/project-registry.js";
import { newReviewId } from "../../util/ids.js";
import { nextTransition } from "../../v2/review-coordinator.js";
import { runNextStage, type CoordinatorDeps, type StageOutcome } from "../../v2/review-run.js";
import { validateReviewContract } from "../../v2/review-contract.js";
import { buildCoordinatorDeps, parseLensWidening, resolveReviewBase } from "./review-wiring.js";
import type { AcClaim } from "../../v2/review-evidence.js";
import { DocsCloseoutSchema, type DocsCloseout } from "../../v2/review-shipping.js";

const DASH = "—";

function anchorOf(f: ReviewFinding): string | undefined {
  if (f.file === undefined) return undefined;
  const at = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  return f.quotedText !== undefined ? `${at} "${f.quotedText}"` : at;
}

function sourceLabel(s: { redRole?: string; redTaskId?: string; verdictId?: string; modelFindingId?: string }): string {
  const who = s.redRole ?? s.redTaskId ?? s.verdictId ?? (s.modelFindingId !== undefined ? "model-supplied id" : "unattributed");
  const via = s.verdictId !== undefined && s.redRole !== undefined ? ` (${s.verdictId})` : "";
  return `${who}${via}`;
}

function counts(record: Record<string, number>): string {
  const parts = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return parts.length === 0 ? DASH : parts.map(([k, n]) => `${k} ${n}`).join(", ");
}

/** The human render, exported so the operator surface is asserted directly rather
 *  than inferred from the JSON one. */
export function renderReview(s: ReviewSummary): string {
  const r = s.review;
  const lines: string[] = [];
  lines.push(`Review ${r.id}`);
  lines.push(`  state:              ${r.state}`);
  lines.push(`  review mode:        ${r.reviewMode}`);
  lines.push(`  ticket:             ${r.ticketId ?? DASH}`);
  lines.push(`  run:                ${r.runId ?? DASH}`);
  lines.push(`  subject task:       ${r.subjectTaskId ?? DASH}`);
  lines.push(`  base sha:           ${r.baseSha ?? DASH}`);
  lines.push(`  contract confirmed: ${r.contractConfirmedSha ?? DASH}`);
  lines.push(`  candidate sha:      ${r.candidateSha ?? DASH}`);
  lines.push(`  trusted remote sha: ${r.trustedRemoteSha ?? DASH}`);
  lines.push(`  workspace:          ${r.workspaceDir ?? DASH}`);
  lines.push(`  risk lenses:        ${s.riskLenses.length > 0 ? s.riskLenses.join(", ") : DASH}`);
  for (const a of s.lensAcceptances) {
    lines.push(
      `  lens accepted:      ${a.lens} — missing evidence: ${a.missingEvidence} ` +
        `(by ${a.acceptedBy} at ${a.acceptedAt}, candidate ${a.candidateSha})`,
    );
    lines.push(`      rationale: ${a.rationale}`);
  }
  lines.push(`  dispositions:       ${counts(s.countsByDisposition)}`);
  lines.push(`  resolutions:        ${counts(s.countsByResolution)}`);
  lines.push(`  unsettled findings: ${s.unsettledCount}`);
  if (r.settledAt !== undefined) lines.push(`  settled at:         ${r.settledAt}`);

  lines.push("");
  if (s.findings.length === 0) {
    lines.push("Findings: none ingested yet");
    return lines.join("\n");
  }
  lines.push("Findings:");
  for (const f of s.findings) {
    const facets = [f.severity, f.riskLens, f.reachability].filter((x) => x !== undefined).join("/");
    lines.push(`  ${f.findingRef} [${facets === "" ? DASH : facets}] ${f.summary}`);
    lines.push(`      id: ${f.id}`);
    const anchor = anchorOf(f);
    if (anchor !== undefined) lines.push(`      anchor: ${anchor}`);
    if (f.acceptanceRef !== undefined) lines.push(`      acceptance: ${f.acceptanceRef}`);
    if (f.invariantRef !== undefined) lines.push(`      invariant: ${f.invariantRef}`);
    lines.push(`      sources: ${f.sources.length === 0 ? DASH : f.sources.map(sourceLabel).join(", ")}`);
    const by = f.decidedBy !== undefined ? ` (by ${f.decidedBy}${f.decidedAt !== undefined ? ` at ${f.decidedAt}` : ""})` : "";
    lines.push(`      disposition: ${f.disposition}${by}`);
    if (f.dispositionRationale !== undefined) lines.push(`      rationale: ${f.dispositionRationale}`);
    if (f.dispositionEvidence !== undefined) lines.push(`      evidence: ${f.dispositionEvidence}`);
    if (f.duplicateOf !== undefined) lines.push(`      duplicate of: ${f.duplicateOf}`);
    if (f.followupTicketId !== undefined) lines.push(`      follow-up: ${f.followupTicketId}`);
    lines.push(`      resolution: ${f.resolution ?? DASH}${f.resolvedSha !== undefined ? ` at ${f.resolvedSha}` : ""}`);
    if (f.resolutionEvidence !== undefined) {
      lines.push(`      resolution evidence: [${f.resolutionEvidenceKind ?? DASH}] ${f.resolutionEvidence}`);
    }
  }
  return lines.join("\n");
}

type DispositionOpts = {
  rationale?: string;
  evidence?: string;
  evidenceKind?: string;
  duplicateOf?: string;
  ticket?: string;
  operator?: boolean;
  review?: string;
  json?: boolean;
};

type AcceptLensOpts = {
  missingEvidence?: string;
  rationale?: string;
  operator?: boolean;
  json?: boolean;
};

type StartOpts = {
  project?: string;
  since?: string;
  contract?: string;
  run?: string;
  route?: string;
  unrouted?: boolean;
  addLens?: string[];
  drift?: string;
  evaluatedNoDrift?: string;
  json?: boolean;
};

type ContinueOpts = {
  project?: string;
  route?: string;
  unrouted?: boolean;
  addLens?: string[];
  drift?: string;
  evaluatedNoDrift?: string;
  acceptance?: string;
  docsCloseout?: string;
  all?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

// ─── FG-649: the review row is the authority for WHICH checkout its stages act on ──
//
// `resolve(opts.project ?? process.cwd())` on every invocation meant `forge review
// continue` from a wrong cwd drove a review against a different tree. That used to be a
// wrong READ, surfaced as the candidate_not_checked_out stop; since the coordinator
// commits the fix cycle it is a WRITE into a possibly-wrong repository.
//
// So the workspace is BOUND to the review: recorded when it is opened, re-recorded when
// an operator overrides it, adopted-and-recorded from the run for a legacy row, and
// otherwise REFUSED by name. There is deliberately no cwd fallback — the store-first-
// with-cwd-fallback pattern in next.ts is right for a read verb, and its fallback half is
// exactly what a committing verb must not keep: it fails in the least visible case (path
// deleted, repo re-cloned elsewhere) by silently acting somewhere else.

const WORKSPACE_REFUSALS = {
  unbound: "review_workspace_unbound",
  unusable: "review_workspace_unusable",
  identityMismatch: "review_workspace_identity_mismatch",
} as const;

function canonicalPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

function gitToplevel(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** Identity, not string equality: a path that still exists can be a DIFFERENT repository
 *  than the one this review's run belongs to (re-cloned, or a scratch tree at the same
 *  location). Only answerable where the ledger has an arbiter — the run names a project
 *  dir whose repository evidence is REGISTERED in project_identity. Everywhere else this
 *  says nothing rather than guessing. */
function identityRefusal(runId: string | undefined, dir: string): string | undefined {
  if (runId === undefined) return undefined;
  const runDir = getRun(runId)?.projectDir;
  if (runDir === undefined || !existsSync(runDir)) return undefined;

  let runEvidenceKey: string;
  let hereEvidenceKey: string;
  try {
    runEvidenceKey = computeRepositoryEvidence(runDir).key;
    hereEvidenceKey = computeRepositoryEvidence(dir).key;
  } catch {
    return undefined;
  }
  if (runEvidenceKey === hereEvidenceKey) return undefined;

  const registered = registryByEvidence(runEvidenceKey);
  if (!registered) return undefined;
  const here = registryByEvidence(hereEvidenceKey);
  if (here && here.projectKey === registered.projectKey) return undefined;

  return (
    `${WORKSPACE_REFUSALS.identityMismatch}: ${dir} is not the repository this review's run ${runId} belongs to ` +
    `(${runDir}, project ${registered.projectKey}${here ? `; that path is project ${here.projectKey}` : ""}). ` +
    `A review's stages read and COMMIT in this directory, so a same-path different-repository match is refused ` +
    `rather than written into — point --project <dir> at the right checkout. Nothing was written.`
  );
}

/** A usable workspace is the ROOT of a git worktree that exists. `git -C <dir> rev-parse
 *  --show-toplevel` resolving to <dir> is the check, so a subdirectory of a repo (whose
 *  diffs and commits would be scoped differently than the review expects) is refused too. */
function checkWorkspace(
  dir: string,
  runId: string | undefined,
  origin: string,
): { ok: true; dir: string } | { ok: false; refusal: string } {
  if (!existsSync(dir)) {
    return {
      ok: false,
      refusal:
        `${WORKSPACE_REFUSALS.unusable}: ${origin} ${dir} does not exist. Name the checkout with ` +
        `--project <dir> — it is then recorded on the review. Nothing was written.`,
    };
  }
  const top = gitToplevel(dir);
  if (top === undefined) {
    return {
      ok: false,
      refusal:
        `${WORKSPACE_REFUSALS.unusable}: ${origin} ${dir} is not a git worktree. Name the checkout with ` +
        `--project <dir> — it is then recorded on the review. Nothing was written.`,
    };
  }
  if (canonicalPath(top) !== canonicalPath(dir)) {
    return {
      ok: false,
      refusal:
        `${WORKSPACE_REFUSALS.unusable}: ${origin} ${dir} is inside the git worktree rooted at ${top}, not its ` +
        `root. Name the checkout root with --project <dir> — it is then recorded on the review. Nothing was written.`,
    };
  }
  const mismatch = identityRefusal(runId, dir);
  if (mismatch !== undefined) return { ok: false, refusal: mismatch };
  return { ok: true, dir };
}

/** The one resolution order, for every stage-driving invocation:
 *    explicit --project (verified, then RECORDED)
 *  > the review's persisted workspace_dir
 *  > for a legacy row with no workspace_dir, the run's project_dir (adopted and RECORDED,
 *    so the next invocation is bound)
 *  > refuse by name.
 *  cwd is irrelevant in every arm. */
export function resolveReviewWorkspace(
  review: Review,
  explicit: string | undefined,
): { ok: true; dir: string; source: "flag" | "review" | "run" } | { ok: false; refusal: string } {
  if (explicit !== undefined) {
    const dir = resolve(explicit);
    const checked = checkWorkspace(dir, review.runId, "--project");
    if (!checked.ok) return checked;
    if (review.workspaceDir !== checked.dir) updateReview(review.id, { workspaceDir: checked.dir });
    return { ok: true, dir: checked.dir, source: "flag" };
  }

  if (review.workspaceDir !== undefined) {
    const checked = checkWorkspace(review.workspaceDir, review.runId, `the workspace recorded on ${review.id},`);
    if (!checked.ok) return checked;
    return { ok: true, dir: checked.dir, source: "review" };
  }

  const runDir = review.runId !== undefined ? getRun(review.runId)?.projectDir : undefined;
  if (runDir !== undefined) {
    const checked = checkWorkspace(resolve(runDir), review.runId, `the project dir of run ${review.runId},`);
    if (!checked.ok) return checked;
    updateReview(review.id, { workspaceDir: checked.dir });
    return { ok: true, dir: checked.dir, source: "run" };
  }

  return {
    ok: false,
    refusal:
      `${WORKSPACE_REFUSALS.unbound}: ${review.id} records no workspace and ` +
      (review.runId === undefined
        ? `names no run to adopt one from`
        : `its run ${review.runId} records no project dir to adopt`) +
      `. A review's stages read and COMMIT in a checkout, so forge will not guess one from the current ` +
      `directory — name it with --project <dir> and it is recorded on the review. Nothing was written.`,
  };
}

function readJsonFile(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (err) {
    throw new Error(`forge review: could not read ${what} from ${path}: ${(err as Error).message}`);
  }
}

/** Build the deps once per invocation. `--add-lens` / `--evaluated-no-drift` / `--drift`
 *  are the three recorded evaluations of the final diff: a lens is ADDED with recorded
 *  evidence, an examined diff that needs no lens change is recorded as `no_drift`, and
 *  drift the coordinator cannot classify is NAMED so the review returns to
 *  plan/architecture. There is no path classifier and there is no flag that removes a lens. */
function depsFor(
  reviewId: string,
  opts: {
    project?: string;
    route?: string;
    unrouted?: boolean;
    addLens?: string[];
    drift?: string;
    evaluatedNoDrift?: string;
    acceptance?: string;
    docsCloseout?: string;
  },
): { ok: true; deps: CoordinatorDeps } | { ok: false; refusal: string } {
  const review = getReview(reviewId);
  if (!review) return { ok: false, refusal: `no review ${reviewId}` };

  const widening = parseLensWidening(opts.addLens ?? []);
  if (!widening.ok) return { ok: false, refusal: widening.refusal };

  // FG-649: the dispatch workspace comes from the REVIEW, never from cwd.
  const workspace = resolveReviewWorkspace(review, opts.project);
  if (!workspace.ok) return { ok: false, refusal: workspace.refusal };

  const acceptance =
    opts.acceptance !== undefined ? (readJsonFile(opts.acceptance, "acceptance claims") as AcClaim[]) : undefined;

  // FG-640 duty 6. Read the same way the acceptance claims are, and — like them — supplying
  // NOTHING is not the clean answer: the shipping check reads an absent assessment as an
  // unasked question, which blocks. There is deliberately no flag that means "assessed, no
  // gaps" without a file, because that flag would be the rubber stamp the check replaces.
  let docsCloseout: DocsCloseout | undefined;
  if (opts.docsCloseout !== undefined) {
    const parsed = DocsCloseoutSchema.safeParse(readJsonFile(opts.docsCloseout, "docs/closeout assessment"));
    if (!parsed.success) {
      return {
        ok: false,
        refusal:
          `--docs-closeout must be {"assessed": <bool>, "gaps": [<string>, …], "detail"?: <string>}: ` +
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      };
    }
    docsCloseout = parsed.data;
  }

  return {
    ok: true,
    deps: buildCoordinatorDeps({
      projectDir: workspace.dir,
      ticketId: review.ticketId ?? review.id,
      ...(review.runId !== undefined ? { runId: review.runId } : {}),
      ...(opts.route !== undefined ? { route: opts.route } : {}),
      ...(opts.unrouted !== undefined ? { unrouted: opts.unrouted } : {}),
      ...(widening.widening.length > 0 ? { addLenses: widening.widening } : {}),
      ...(opts.drift !== undefined ? { unclassifiableDrift: opts.drift } : {}),
      ...(opts.evaluatedNoDrift !== undefined ? { evaluatedNoDrift: opts.evaluatedNoDrift } : {}),
      ...(acceptance !== undefined ? { acceptance } : {}),
      ...(docsCloseout !== undefined ? { docsCloseout } : {}),
    }),
  };
}

function reportStage(outcome: StageOutcome, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(outcome, null, 2));
  } else {
    const glyph = outcome.status === "advanced" ? "✓" : outcome.status === "stopped" ? "•" : "✗";
    console.log(`${glyph} ${outcome.transition.kind}: ${outcome.message}`);
    if (outcome.shipping) {
      for (const c of outcome.shipping.checks) console.log(`    ${c.ok ? "✓" : "✗"} ${c.id} — ${c.detail}`);
    }
  }
  if (outcome.status === "refused") process.exitCode = 1;
}

function snapshotFor(reviewId: string) {
  const review = getReview(reviewId);
  if (!review) throw new Error(`Not found: ${reviewId}`);
  return { review, findings: findingsForReview(reviewId), batches: fixBatchesForReview(reviewId) };
}

export function registerReview(program: Command): void {
  const review = program
    .command("review")
    .description("Read and disposition the durable review ledger (evidence-led review lifecycle)");

  review
    .command("start")
    .argument("<ticket-id>", "the ticket whose landed implementation is under review")
    .option("--project <dir>", "the candidate workspace (default: cwd) — RECORDED on the review and used by every later stage")
    .option(
      "--since <sha>",
      "the implementation comparison base (default: inferred from the commits whose subject references the ticket)",
    )
    .option("--contract <file>", "the approved review contract, as JSON — required to open a review")
    .option("--run <run-id>", "attach the review to an existing run")
    .option("--route <route-key>", "the resolved routing-policy key for the dispatches this drives")
    .option("--unrouted", "acknowledge a deliberately unrouted dispatch")
    .option(
      "--add-lens <lens:reason:evidence>",
      "ADD a risk lens with recorded diff evidence (repeatable). The coordinator may widen the " +
        "contract; removing a lens or changing any other boundary returns to the approving authority",
      (v: string, acc: string[] = []) => [...acc, v],
    )
    .option("--drift <text>", "name implementation drift you cannot classify — returns to plan/architecture")
    .option(
      "--evaluated-no-drift <statement>",
      "record that you EXAMINED the final diff and no lens change is needed. The statement is stored with " +
        "the diff summary it was made against; the confirmation then advances",
    )
    .option("--json", "emit each stage outcome as JSON")
    .description("Open a review: verify, confirm the contract against the final diff, discover, stop at disposition")
    .action(async (ticketId: string, opts: StartOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`review for ${ticketId}`);

      if (opts.contract === undefined) {
        console.error(
          `forge review start: --contract <file> is required. The review contract is APPROVED by the plan gate ` +
            `and persisted with the review; it is never reconstructed from prompts after the fact. Nothing was written.`,
        );
        process.exitCode = 1;
        return;
      }
      const validated = validateReviewContract(readJsonFile(opts.contract, "review contract"));
      if (!validated.ok) {
        console.error(`forge review start: ${validated.refusal} Nothing was written.`);
        process.exitCode = 1;
        return;
      }

      // EVERY PRECONDITION OF AN ADVANCEABLE REVIEW IS CHECKED BEFORE THE ROW EXISTS. A
      // malformed --add-lens spec and an unresolvable comparison base both used to be
      // discovered after the insert, which left a row nothing could advance and no verb
      // could remove.
      const widening = parseLensWidening(opts.addLens ?? []);
      if (!widening.ok) {
        console.error(`forge review start: ${widening.refusal} Nothing was written.`);
        process.exitCode = 1;
        return;
      }

      // FG-649: the workspace is BOUND when the review is opened — verified here and
      // persisted by the same insert that records the base sha, so every later `continue`
      // resolves it from the review row rather than from the cwd it happens to run in.
      const projectDir = resolve(opts.project ?? process.cwd());
      const workspace = checkWorkspace(
        projectDir,
        opts.run,
        opts.project !== undefined ? "--project" : "the current directory,",
      );
      if (!workspace.ok) {
        console.error(`forge review start: ${workspace.refusal}`);
        process.exitCode = 1;
        return;
      }

      const base = resolveReviewBase({
        projectDir,
        ticketId,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      });
      if (!base.ok) {
        console.error(`forge review start: ${base.refusal}`);
        process.exitCode = 1;
        return;
      }

      const reviewId = newReviewId();
      insertReview({
        id: reviewId,
        reviewMode: "evidence_led",
        ticketId,
        ...(opts.run !== undefined ? { runId: opts.run } : {}),
        baseSha: base.baseSha,
        workspaceDir: workspace.dir,
        contract: validated.contract,
        state: "confirming_contract",
      });

      const built = depsFor(reviewId, opts);
      if (!built.ok) {
        console.error(`forge review start: ${built.refusal}`);
        process.exitCode = 1;
        return;
      }
      const candidate = await built.deps.headSha();
      updateReview(reviewId, { candidateSha: candidate });

      console.log(`Review ${reviewId} — ticket ${ticketId}, candidate ${candidate}`);
      console.log(`  workspace: ${workspace.dir} (recorded on the review; later stages act on it, not on cwd)`);
      console.log(
        `  base sha: ${base.baseSha}` +
          (base.inferredFrom !== undefined
            ? ` (inferred from the oldest commit referencing ${ticketId}, ${base.inferredFrom.slice(0, 9)})`
            : ` (--since)`),
      );
      if (base.spansUnmatched === true) {
        console.log(
          `  note: that range also spans commits which do not reference ${ticketId}, so the confirmation diff ` +
            `includes them — pass --since <sha> to narrow it.`,
        );
      }
      console.log(`  lenses: ${validated.contract.risk_lenses.join(", ")}`);

      // start drives stages 1–3 ONLY. It stops at disposition; it never fixes.
      const startStages = new Set(["verify_entry", "confirm_contract", "discover"]);
      for (;;) {
        const pending = nextTransition(snapshotFor(reviewId));
        if (!startStages.has(pending.kind)) {
          console.log(`• next: ${pending.kind} — ${pending.reason}`);
          console.log(`  run \`forge review continue ${reviewId}\` to drive it.`);
          break;
        }
        const outcome = await runNextStage(reviewId, built.deps);
        reportStage(outcome, opts.json === true);
        if (outcome.status !== "advanced") break;
      }
    });

  review
    .command("continue")
    .argument("<review-id>", "review id")
    .option(
      "--project <dir>",
      "override the workspace recorded on the review — the override is RECORDED. Without it the workspace " +
        "comes from the review row, never from cwd",
    )
    .option("--route <route-key>", "the resolved routing-policy key for the dispatches this drives")
    .option("--unrouted", "acknowledge a deliberately unrouted dispatch")
    .option(
      "--add-lens <lens:reason:evidence>",
      "ADD a risk lens with recorded diff evidence (repeatable)",
      (v: string, acc: string[] = []) => [...acc, v],
    )
    .option("--drift <text>", "name implementation drift you cannot classify — returns to plan/architecture")
    .option(
      "--evaluated-no-drift <statement>",
      "record that you EXAMINED the final diff and no lens change is needed — the confirmation then advances",
    )
    .option("--acceptance <file>", "acceptance-criterion claims for the shipping review, as JSON")
    .option("--docs-closeout <file>", "FG-640 shipping duty 6: the ticket-required docs/closeout assessment, as JSON {assessed, gaps[], detail?}. Omitting it reads as NOT assessed, which blocks")
    .option("--all", "keep driving while each transition advances, instead of one transition")
    .option("--dry-run", "report the one valid next transition and exit without running it")
    .option("--json", "emit each stage outcome as JSON")
    .description("Drive the ONE valid next transition from durable state — never repeats a completed stage")
    .action(async (reviewId: string, opts: ContinueOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`review ${reviewId}`);

      // THE PRECONDITIONS COME FIRST, FOR BOTH PATHS. --dry-run used to be handled before
      // the deps were built, so an unknown review threw a raw `Not found:` out of the action
      // instead of the named `no review <id>` refusal the real path emits, and --add-lens /
      // --acceptance were not validated at all. An answer that skipped the checks the act
      // applies is an answer about a different invocation than the one it previews.
      const built = depsFor(reviewId, opts);
      if (!built.ok) {
        console.error(`forge review continue: ${built.refusal}`);
        process.exitCode = 1;
        return;
      }

      // --dry-run answers "what would continue do?" without dispatching anything. It reads
      // the same nextTransition the real run does, so the answer cannot drift from the act.
      if (opts.dryRun === true) {
        const pending = nextTransition(snapshotFor(reviewId));
        console.log(opts.json === true ? JSON.stringify({ transition: pending, status: "dry_run" }, null, 2) : `• next: ${pending.kind} — ${pending.reason}`);
        return;
      }

      for (;;) {
        const outcome = await runNextStage(reviewId, built.deps);
        reportStage(outcome, opts.json === true);
        if (opts.all !== true || outcome.status !== "advanced") break;
      }

      if (opts.json !== true) {
        const pending = nextTransition(snapshotFor(reviewId));
        console.log(`  next: ${pending.kind} — ${pending.reason}`);
      }
    });

  review
    .command("show")
    .argument("<review-id>", "review id")
    .option("--json", "emit the review summary and findings as JSON")
    .description("Render a review's summary and findings, read-only")
    .action((reviewId: string, opts: { json?: boolean }) => {
      ensureForgeDirs();
      assertStoreForLookup(`review ${reviewId}`);
      const summary = summarizeReview(reviewId);
      if (!summary) throw new Error(`Not found: ${reviewId}`);
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log(renderReview(summary));
    });

  review
    .command("accept-lens")
    .argument("<review-id>", "review id")
    .argument("<lens>", "the selected risk lens whose evidence is missing")
    .option("--missing-evidence <text>", "WHAT was not reviewed — required; an unnamed acceptance is a blanket override")
    .option("--rationale <text>", "why the missing evidence is acceptable for this candidate — required")
    .option("--operator", "record this as the operator's decision — required: an acceptance narrows the approved discovery coverage")
    .option("--json", "emit the recorded acceptance as JSON")
    .description(
      "Accept a selected lens's MISSING evidence — the third route by which an absent lens clears " +
        "(the others being retrying the lens and amending the contract through its approving authority)",
    )
    .action((reviewId: string, lens: string, opts: AcceptLensOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`review ${reviewId}`);

      const outcome = recordLensAcceptance(reviewId, {
        lens,
        missingEvidence: opts.missingEvidence ?? "",
        rationale: opts.rationale ?? "",
        operator: opts.operator === true,
      });
      if (!outcome.ok) {
        console.error(`forge review accept-lens: ${outcome.refusal}`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(outcome.acceptance, null, 2));
        return;
      }
      const a = outcome.acceptance;
      console.log(`${reviewId}: the ${a.lens} lens's missing evidence is accepted by ${a.acceptedBy} at ${a.acceptedAt}`);
      console.log(`  missing evidence: ${a.missingEvidence}`);
      console.log(`  rationale: ${a.rationale}`);
      console.log(`  candidate sha: ${a.candidateSha}`);
    });

  review
    .command("disposition")
    .argument("<finding-id>", "finding id (review-x/RF-2) or bare ref (RF-2, with --review when ambiguous)")
    .argument("<decision>", DISPOSITIONS.join(" | "))
    .option("--rationale <text>", "why this decision was made — required")
    .option(
      "--evidence <json>",
      "candidate-bound disproving evidence for rejected_premise, as a JSON payload whose fields " +
        "are set by --evidence-kind: replayed_command {command, output}, " +
        "deterministic_reproduction {reproduction, result}, anchored_contradiction {file, line, fact}",
    )
    .option("--evidence-kind <kind>", DISPROVING_EVIDENCE_KINDS.join(" | "))
    .option("--duplicate-of <finding-id>", "the canonical finding this one duplicates")
    .option("--ticket <ticket-id>", "the durable destination for a deferred finding")
    .option(
      "--operator",
      "record this as the operator's decision — required for an authority-changing accepted_risk " +
        "and for authorizing a new deferral destination",
    )
    .option("--review <review-id>", "scope a bare RF-n ref to one review")
    .option("--json", "emit the recorded disposition as JSON")
    .description("Record a disposition on a ledger finding, enforcing its per-value preconditions")
    .action((findingRef: string, decision: string, opts: DispositionOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`finding ${findingRef}`);

      if (!(DISPOSITIONS as readonly string[]).includes(decision)) {
        console.error(
          `forge review disposition: decision must be one of ${DISPOSITIONS.join(", ")} (got '${decision}'). Nothing was written.`,
        );
        process.exitCode = 1;
        return;
      }

      const found = lookupFinding(findingRef, { reviewId: opts.review });
      if (found.kind === "not_found") {
        console.error(`forge review disposition: no finding ${findingRef}. Nothing was written.`);
        process.exitCode = 1;
        return;
      }
      if (found.kind === "ambiguous") {
        console.error(
          `forge review disposition: '${findingRef}' matches ${found.candidates.length} findings ` +
            `(${found.candidates.map((c) => c.id).join(", ")}) — pass the full id or --review <review-id>. Nothing was written.`,
        );
        process.exitCode = 1;
        return;
      }

      const outcome = recordDisposition(found.finding.id, {
        decision: decision as Disposition,
        rationale: opts.rationale ?? "",
        operator: opts.operator === true,
        evidence: opts.evidence,
        evidenceKind: opts.evidenceKind,
        duplicateOf: opts.duplicateOf,
        followupTicketId: opts.ticket,
      });

      if (!outcome.ok) {
        console.error(`forge review disposition: ${outcome.refusal}`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      const f = outcome.finding;
      console.log(`${f.findingRef} (${f.id}): ${f.disposition} — decided by ${f.decidedBy} at ${f.decidedAt}`);
      console.log(`  candidate sha: ${f.decidedCandidateSha ?? DASH}`);
      console.log(`  rationale: ${f.dispositionRationale}`);
      if (f.dispositionEvidence !== undefined) console.log(`  evidence: ${f.dispositionEvidence}`);
      if (f.followupTicketId !== undefined) console.log(`  durable destination: ${f.followupTicketId}`);
      if (outcome.absorbedInto) {
        console.log(
          `  canonical ${outcome.absorbedInto.findingRef} now carries ${outcome.absorbedInto.sources.length} source(s) ` +
            `after absorbing this finding's provenance`,
        );
      }
    });
}
