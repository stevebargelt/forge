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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import { assertStoreForLookup } from "../no-store.js";
import {
  DISPOSITIONS,
  DISPROVING_EVIDENCE_KINDS,
  recordDisposition,
  lensAcceptancesOf,
  lensOutcomeRecordsOf,
  lensSkipRecordsOf,
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
import { compareIdentity, describeIdentity, identify } from "../../util/path-identity.js";
import { nextTransition } from "../../v2/review-coordinator.js";
import { runNextStage, type CoordinatorDeps, type StageOutcome } from "../../v2/review-run.js";
import { validateReviewContract } from "../../v2/review-contract.js";
import { assessShardCompleteness, type LensOutcome } from "../../v2/review-discovery.js";
import { DEFAULT_SHARD_BUDGET, SHARD_BUDGET_UNIT } from "../../v2/review-shards.js";
import {
  buildCoordinatorDeps,
  parseLensWidening,
  parseRetryShards,
  parseShardBudget,
  resolveReviewBase,
} from "./review-wiring.js";
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

/** "wide shard 2 of 3", or "wide" when there is no shard identity to name. */
function shardLabel(lens: string, shard?: number, of?: number): string {
  if (shard === undefined) return lens;
  return of === undefined ? `${lens} shard ${shard}` : `${lens} shard ${shard} of ${of}`;
}

/** FG-689: WHAT DISCOVERY WAS OWED, BESIDE WHAT IT DELIVERED — per lens, per shard.
 *
 *  THE THREE STATES A SHARD CAN BE IN ARE THREE DIFFERENT RENDERED FORMS, deliberately, because
 *  "distinguishable at the gate" is only true operationally if it is distinguishable in what an
 *  operator reads:
 *
 *    - `intentionally skipped (zero in-scope paths)` — the lens's authored scope matched no
 *      changed path, so nothing was owed. NOT a review, and NOT an absence.
 *    - `no outcome` — a shard that owes a reviewer-authored outcome and has none. This blocks.
 *    - `accepted missing evidence` — an operator decided to proceed with a narrower review of
 *      THAT shard. It clears completeness and is never evidence.
 *
 *  Collapsing any two of them into one line would put the distinction back where only the
 *  assessor can see it, which is where it was before this ticket.
 *
 *  Computed from the durable row rather than restated from the stage record: the stage record
 *  is written only when discovery COMPLETES, and the moment an operator most needs this is when
 *  it did not. */
export function renderShardPlan(review: Review): string[] {
  const plan = review.shardPlan;
  if (plan === undefined) return [];

  const outcomes = lensOutcomeRecordsOf(review) as LensOutcome[];
  const state = assessShardCompleteness(plan, outcomes, {
    acceptances: lensAcceptancesOf(review),
    skips: lensSkipRecordsOf(review),
    ...(review.contractConfirmedSha !== undefined ? { candidateSha: review.contractConfirmedSha } : {}),
  });

  const d = plan.derivation;
  const lines: string[] = [];
  lines.push("");
  lines.push("Shard plan (expected vs delivered):");
  lines.push(`  partition:          ${plan.digest}`);
  lines.push(`  recorded at:        ${plan.recordedAt}`);
  lines.push(`  derivation:         ${d.baseSha}..${d.candidateSha} rendered by ${d.renderingId}`);
  // FG-689 RF-1: the budget bounds the COMPOSED input, so the line that reports it says what
  // was reserved for the envelope and what is therefore left for diff bytes. `d.budget` alone
  // reads as the diff allowance, which is exactly the misreading that shipped the defect.
  // `budgetValidatedChars` is the largest composed input a real dispatch actually delivered —
  // the evidence behind "validated against", not a restatement of the budget.
  const reserved = Object.entries(d.envelopes ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  lines.push(
    `  shard budget:       ${d.budget} ${d.unit} per COMPOSED input (diff + dispatch envelope)` +
      `${d.budgetValidatedChars !== undefined ? `, largest validated ${d.budgetValidatedChars} ${d.unit}` : ""}`,
  );
  lines.push(`  validated against:  ${d.budgetValidatedRuntime}`);
  lines.push(
    `  envelope reserve:   ${
      reserved.length > 0
        ? reserved.map(([lens, n]) => `${lens} ${n} (diff allowance ${d.budget - n})`).join(", ")
        : "(none recorded)"
    }`,
  );
  lines.push(`  fan-out width:      ${plan.fanoutWidth}`);

  for (const planned of plan.lenses) {
    const current = outcomes.filter(
      (o) => o.lens === planned.lens && o.derivationDigest === plan.digest && o.shard !== undefined,
    );
    const delivered = planned.shards.filter((s) =>
      current.some((o) => o.shard?.index === s.index && o.complete),
    ).length;
    lines.push(
      `  ${planned.lens}: ${planned.shards.length} shard(s) planned, ${delivered} delivered`,
    );
    for (const shard of planned.shards) {
      const label = `shard ${shard.index} of ${shard.of}`;
      const facts = `${shard.paths.length} path(s), ${shard.chars} ${d.unit}`;
      const forShard = current.filter((o) => o.shard?.index === shard.index);
      const authored = forShard.filter((o) => o.complete);
      const last = authored[authored.length - 1] ?? forShard[forShard.length - 1];
      const acceptance = state.accepted.find((a) => a.lens === planned.lens && a.shard === shard.index);
      const miss = state.missing.find((m) => m.lens === planned.lens && m.shard === shard.index);

      if (last?.complete) {
        lines.push(`      ${label} — delivered ${last.outcome} (${facts})`);
      } else if (acceptance !== undefined) {
        lines.push(
          `      ${label} — accepted missing evidence: ${acceptance.missingEvidence} ` +
            `(by ${acceptance.acceptedBy} at ${acceptance.acceptedAt}) (${facts})`,
        );
      } else {
        const why = miss !== undefined ? `${miss.reason}: ${miss.detail}` : "no reviewer-authored outcome";
        lines.push(`      ${label} — no outcome (${why}) (${facts})`);
      }
      for (const p of shard.paths) lines.push(`          ${p}`);
    }
  }

  for (const s of plan.skipped) {
    const recorded = state.skipped.some((r) => r.lens === s.lens);
    lines.push(
      recorded
        ? `  ${s.lens}: intentionally skipped (zero in-scope paths)`
        : `  ${s.lens}: intentionally skipped (zero in-scope paths) in the plan, but NO matching skip record for ` +
          `partition ${plan.digest} — it satisfies nothing and discovery stays incomplete`,
    );
  }

  // D17. Named, never dropped: an operator who decided something once has to be able to read
  // that it no longer applies, and a decision that quietly vanished reads as one never made.
  for (const sup of state.superseded) {
    lines.push(`  superseded ${sup.kind}: ${sup.detail}`);
  }

  return lines;
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
    // FG-689 D16: an acceptance clears exactly the shard it names, so the render names it too.
    // A line that said only "wide" while the ledger record cleared shard 2 of 3 would read as a
    // decision about the whole lens — the very reading the shardless acceptance is refused for.
    // It rides the provenance parenthetical rather than replacing the lens token, so the line
    // keeps saying which lens first, which is what an operator scans for.
    lines.push(
      `  lens accepted:      ${a.lens} — missing evidence: ${a.missingEvidence} ` +
        `(by ${a.acceptedBy} at ${a.acceptedAt}, candidate ${a.candidateSha}` +
        `${a.shard !== undefined ? `, shard ${a.shard}` : ""})`,
    );
    lines.push(`      rationale: ${a.rationale}`);
  }
  lines.push(`  dispositions:       ${counts(s.countsByDisposition)}`);
  lines.push(`  resolutions:        ${counts(s.countsByResolution)}`);
  lines.push(`  unsettled findings: ${s.unsettledCount}`);
  if (r.settledAt !== undefined) lines.push(`  settled at:         ${r.settledAt}`);

  lines.push(...renderShardPlan(r));

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
  shard?: string;
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
  shardBudget?: string;
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
  shardBudget?: string;
  retryShard?: string[];
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
 *  diffs and commits would be scoped differently than the review expects) is refused too.
 *
 *  FG-693: the root check goes through the ONE identity contract (src/util/path-identity.ts)
 *  and takes the ACTING projection. This is the workspace every later stage READS and
 *  COMMITS in, so a spelling the filesystem would not confirm must never reach the ok:true
 *  arm: an indeterminate comparison refuses by name here rather than authorizing a write
 *  into a directory nobody proved. The private canonicalizer this replaced caught the
 *  realpath failure and returned `resolve(dir)` — a LEXICAL guess in the proven position —
 *  so two unresolvable spellings compared equal and a guessed directory passed the check. */
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
  const here = identify(dir);
  if (here.kind !== "resolved") {
    return {
      ok: false,
      refusal:
        `${WORKSPACE_REFUSALS.unusable}: ${origin} ${describeIdentity(here)} — the filesystem would not ` +
        `confirm what it names, so it cannot be the checkout a review reads and COMMITS in. Name the ` +
        `checkout with --project <dir> — it is then recorded on the review. Nothing was written.`,
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
  const atRoot = compareIdentity(top, here);
  if (atRoot === "indeterminate") {
    return {
      ok: false,
      refusal:
        `${WORKSPACE_REFUSALS.unusable}: ${origin} ${dir} names the git worktree rooted at ` +
        `${describeIdentity(top)}, whose identity could not be established — so it cannot be shown to BE ` +
        `that root. Name the checkout root with --project <dir> — it is then recorded on the review. ` +
        `Nothing was written.`,
    };
  }
  if (atRoot === "different") {
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
 *  cwd is irrelevant in every arm.
 *
 *  FG-649 RF-3: `record: false` runs the identical resolution and the identical refusals but
 *  WRITES NOTHING. It is what `--dry-run` passes. Recording the binding is a durable change to
 *  which repository every later stage — including the coordinator's own git commit — writes
 *  into, and a documented preview that "reports the next transition and exits without running
 *  it" must not make it. The checks stay on the preview path so the answer is still about the
 *  invocation being previewed; only the write is dropped. */
export function resolveReviewWorkspace(
  review: Review,
  explicit: string | undefined,
  opts: { record?: boolean } = {},
): { ok: true; dir: string; source: "flag" | "review" | "run" } | { ok: false; refusal: string } {
  const record = opts.record !== false;

  if (explicit !== undefined) {
    const dir = resolve(explicit);
    const checked = checkWorkspace(dir, review.runId, "--project");
    if (!checked.ok) return checked;
    if (record && review.workspaceDir !== checked.dir) updateReview(review.id, { workspaceDir: checked.dir });
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
    if (record) updateReview(review.id, { workspaceDir: checked.dir });
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
    shardBudget?: string;
    retryShard?: string[];
    dryRun?: boolean;
  },
): { ok: true; deps: CoordinatorDeps } | { ok: false; refusal: string } {
  const review = getReview(reviewId);
  if (!review) return { ok: false, refusal: `no review ${reviewId}` };

  const widening = parseLensWidening(opts.addLens ?? []);
  if (!widening.ok) return { ok: false, refusal: widening.refusal };

  // FG-689: both shard overrides are parsed HERE, beside the widening, so `--dry-run` refuses a
  // malformed one identically to the real run — the preview must go through the same checks the
  // act does, or it is an answer about a different invocation.
  const budget = opts.shardBudget !== undefined ? parseShardBudget(opts.shardBudget) : undefined;
  if (budget !== undefined && !budget.ok) return { ok: false, refusal: budget.refusal };
  const retry = parseRetryShards(opts.retryShard ?? []);
  if (!retry.ok) return { ok: false, refusal: retry.refusal };

  // FG-649: the dispatch workspace comes from the REVIEW, never from cwd. A --dry-run
  // preview resolves and refuses identically but records nothing (RF-3) — rebinding which
  // checkout later stages COMMIT into is not something a preview may do.
  const workspace = resolveReviewWorkspace(review, opts.project, { record: opts.dryRun !== true });
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
      ...(budget !== undefined && budget.ok ? { shardBudget: budget.budget } : {}),
      ...(retry.shards.length > 0 ? { retryShards: retry.shards } : {}),
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
      "--add-lens <lens:reason:evidence:scope-paths>",
      "ADD a risk lens with recorded diff evidence AND the authored paths it owns, or WIDEN an " +
        "already-selected lens's scope with the same evidence (repeatable). The coordinator may only widen " +
        "the contract; removing a lens, NARROWING a lens's scope, or changing any other boundary returns to " +
        "the approving authority",
      (v: string, acc: string[] = []) => [...acc, v],
    )
    .option("--drift <text>", "name implementation drift you cannot classify — returns to plan/architecture")
    .option(
      "--evaluated-no-drift <statement>",
      "record that you EXAMINED the final diff and no lens change is needed. The statement is stored with " +
        "the diff summary it was made against; the confirmation then advances",
    )
    .option(
      "--shard-budget <n>",
      `override the per-shard size budget for discovery, in ${SHARD_BUDGET_UNIT} (default ${DEFAULT_SHARD_BUDGET}). ` +
        `The number travels with its unit into the recorded derivation, so a provider change cannot reinterpret it`,
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
      // FG-674: the BASIS is stated, not implied — which of the three rules produced this base.
      const basis =
        base.basis === "since"
          ? `--since`
          : base.basis === "merge-base"
            ? `merge-base with ${base.defaultBranch} — the branch point of this feature branch`
            : `ticket-range inference — inferred from the oldest commit referencing ${ticketId} that changes ` +
              `implementation files, ${(base.inferredFrom ?? "").slice(0, 9)}`;
      console.log(`  base sha: ${base.baseSha} (basis: ${basis})`);
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
      "--add-lens <lens:reason:evidence:scope-paths>",
      "ADD a risk lens, or WIDEN a selected lens's scope, with recorded diff evidence and the authored " +
        "paths it owns (repeatable). Narrowing a scope returns to the approving authority",
      (v: string, acc: string[] = []) => [...acc, v],
    )
    .option("--drift <text>", "name implementation drift you cannot classify — returns to plan/architecture")
    .option(
      "--evaluated-no-drift <statement>",
      "record that you EXAMINED the final diff and no lens change is needed — the confirmation then advances",
    )
    .option("--acceptance <file>", "acceptance-criterion claims for the shipping review, as JSON")
    .option("--docs-closeout <file>", "FG-640 shipping duty 6: the ticket-required docs/closeout assessment, as JSON {assessed, gaps[], detail?}. Omitting it reads as NOT assessed, which blocks")
    .option(
      "--retry-shard <lens:index>",
      "re-dispatch ONLY the named shard(s) of the discovery stage (repeatable, e.g. wide:2). Every " +
        "already-authored shard outcome is left untouched; a shard that owes nothing refuses by name",
      (v: string, acc: string[] = []) => [...acc, v],
    )
    .option(
      "--shard-budget <n>",
      `override the per-shard size budget for discovery, in ${SHARD_BUDGET_UNIT} (default ${DEFAULT_SHARD_BUDGET}). ` +
        `A change RE-PARTITIONS: every shard-scoped decision recorded under the old partition is named as ` +
        `superseded rather than silently honored or dropped`,
    )
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

      // FG-689 D7: --retry-shard is a DISCOVERY instruction, and the coordinator drives the one
      // valid next transition from durable state. Accepting the flag when discovery is not that
      // transition would silently drive some other stage while the operator believed they had
      // named a shard — so it refuses here, before anything dispatches, and names what is
      // actually next. It is checked on the real path and the preview alike.
      if ((opts.retryShard ?? []).length > 0) {
        const pending = nextTransition(snapshotFor(reviewId));
        if (pending.kind !== "discover") {
          console.error(
            `forge review continue: --retry-shard names a shard of the DISCOVERY stage, but this review's one ` +
              `valid next transition is '${pending.kind}' — ${pending.reason}. Nothing was dispatched and nothing ` +
              `was written. Drop the flag to drive that transition.`,
          );
          process.exitCode = 1;
          return;
        }
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
    .option(
      "--shard <n>",
      "WHICH shard of the lens this acceptance clears, 1-based as `forge review show` renders it. REQUIRED " +
        "once the review's recorded shard plan gives the lens shards — one acceptance covering every shard " +
        "would clear shards that crashed and were never read",
    )
    .option("--json", "emit the recorded acceptance as JSON")
    .description(
      "Accept a selected lens's MISSING evidence — the third route by which an absent lens clears " +
        "(the others being retrying the lens and amending the contract through its approving authority)",
    )
    .action((reviewId: string, lens: string, opts: AcceptLensOpts) => {
      ensureForgeDirs();
      assertStoreForLookup(`review ${reviewId}`);

      // Matched on the LITERAL, like --retry-shard's index: an acceptance that cleared a
      // different shard than the operator typed is exactly the fail-open D16 closes, and
      // Number("2.7") would silently produce one.
      if (opts.shard !== undefined && !/^[1-9][0-9]*$/.test(opts.shard.trim())) {
        console.error(
          `forge review accept-lens: --shard expects a whole number from 1, as \`forge review show\` renders it ` +
            `("shard 2 of 3" is --shard 2); got '${opts.shard}'. Nothing was written.`,
        );
        process.exitCode = 1;
        return;
      }

      const outcome = recordLensAcceptance(reviewId, {
        lens,
        missingEvidence: opts.missingEvidence ?? "",
        rationale: opts.rationale ?? "",
        operator: opts.operator === true,
        ...(opts.shard !== undefined ? { shard: Number(opts.shard.trim()) } : {}),
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
      console.log(
        `${reviewId}: the ${a.lens} lens's ${a.shard !== undefined ? `shard ${a.shard} ` : ""}missing evidence is ` +
          `accepted by ${a.acceptedBy} at ${a.acceptedAt}`,
      );
      console.log(`  missing evidence: ${a.missingEvidence}`);
      console.log(`  rationale: ${a.rationale}`);
      console.log(`  candidate sha: ${a.candidateSha}`);
      if (a.derivationDigest !== undefined) console.log(`  partition: ${a.derivationDigest}`);
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
