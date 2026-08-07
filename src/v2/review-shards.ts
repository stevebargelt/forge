// FG-689 step 5: the PURE DECIDERS between the pinned rendering and dispatch — which lens
// owns which changed path, whether anything is owned by nobody, and how each lens's owned
// bytes are cut into size-bounded shards.
//
// Everything here is a function of its arguments. No git, no store, no clock, no randomness:
// the shard set has to be reproducible from the recorded derivation alone, because a durable
// decision bound to "shard 2 of 3" means nothing if shard 2 of 3 cannot be re-derived. That
// is also why `recordedAt` is NOT produced here — a timestamp inside the plan would make two
// calls with identical inputs differ, and the store stamps it at write time instead.
//
// WHAT THIS MODULE MUST NOT BECOME. `resolveScopes` matches AUTHORED patterns against a path
// set. It does not read a filename for meaning: there is no extension rule, no "src/ is
// backend", no `dist/` or `node_modules/` exclusion, and no negation form (D5). A generated
// or vendored artifact is owned by whoever the contract's approving authority said owns it,
// or it is UNCOVERED and the confirmation refuses. The cost is real and accepted: the dogfood
// candidate's `dashboard/client/*.js` build outputs are ~53,000 bytes of low-evidence shard
// budget that some lens has to pay for. That is the price of not owning a path classifier,
// and FG-689's PRD pays it deliberately.
//
// FAIL BY MEASUREMENT, NEVER BY FITTING (AC5/AC6). There is no truncation, no sampling, no
// head/tail, no "summarise the rest" anywhere below. A single file whose rendered body is
// larger than one shard's allowance is UNFITTABLE and stops the review with a refusal that
// cites the host's own measurement against the budget and names the unit. The failure this
// ticket exists to fix is a reviewer authoring an honest pass over something that was not the
// diff; quietly making the input fit is the most direct way to reintroduce it.
//
// AND THE BUDGET BOUNDS THE COMPOSED INPUT, NOT THE DIFF (RF-1). Packing bare
// `ReviewDiffFile.chars` against the budget bounded the wrong quantity: the reviewer receives
// the diff PLUS the envelope the dispatch seam composes around it — the contract JSON, the
// shard's path list, the output contract, the fixed instructions — and none of that was
// measured. The dogfood's largest shard was 593,919 bytes of diff against a 600,000 budget, a
// 6,081-byte margin the ~20,000-25,000-byte envelope then blew straight through. So the
// derivation now carries a per-lens `envelopes` measurement, `planShards` packs into
// `budget - envelope`, and the seam that composes the prompt MEASURES the assembled string and
// refuses before starting a container. Two guards, deliberately: the reserve is what makes a
// normal review fit, and the measurement is what makes the guarantee about the real bytes
// rather than about a model of them. The reserve is DIGESTED, because it decides where the
// cuts fall — editing the reviewer prompt re-partitions, and it has to say so.
//
// THE UNIT TRAVELS WITH THE BUDGET (D10), and it is not a formality. `review-diff.ts`
// establishes that FG-689's recorded measurements — 1,170,885 for the whole dogfood
// candidate, 80,462 for its largest single file — are UTF-8 BYTES written down as
// "characters"; the same rendering is 1,148,986 UTF-16 code units. This module compares the
// budget against `ReviewDiffFile.chars`, which is the byte count, and carries
// `REVIEW_DIFF_SIZE_UNIT` beside every number it reports. 600,000 bytes reinterpreted as
// 600,000 tokens under a provider change is a ~4x overshoot straight back into the crash.
//
// TWO DELIBERATE DEVIATIONS from the literal signature in FG-689's plan, both to remove a
// second source of truth:
//   * `planShards` takes `budget` and `unit` FROM `derivation` rather than as separate
//     arguments beside it. `ShardDerivation` already carries both, `digest` is computed over
//     them, and a `budget` argument that disagreed with `derivation.budget` would produce a
//     plan whose recorded identity describes a partition that was not the one cut — exactly
//     the silent-supersession failure D17 exists to make detectable.
//   * `resolveScopes` returns `skipped` alongside `{owned, uncovered}`. A lens with zero
//     owned paths is decided here, once, by the code that did the matching; deriving it a
//     second time at the call site is how the plan's `lenses` and `skipped` lists drift apart.

import { createHash } from "node:crypto";
import { RISK_LENSES, type LensScopes, type ReviewContract, type RiskLens } from "./review-contract.js";
import { REVIEW_DIFF_SIZE_UNIT, type ReviewDiffFile, type ReviewDiffSizeUnit } from "./review-diff.js";
import type { PlannedLens, PlannedShard, ShardDerivation, ShardPlan, SkippedLens } from "../store/reviews.js";

/** FG-689 D4. A CONFIGURED number, not one derived from any provider's cap.
 *
 *  The host composes only its own half of a reviewer's input and can measure only that half.
 *  FG-591's crash is the proof: the provider reported 1,174,814 characters against a diff the
 *  host had composed at 1,170,885, and forge's own envelope beside the diff (task package,
 *  contract, protocol, instructions) measures ~20,000-25,000. Neither number accounts for the
 *  provider's system prompt and tool schemas, which the host never sees and cannot tighten by
 *  measuring itself more carefully. So the ~40% headroom below the ~1,048,576 cap that crashed
 *  is RESERVE against an envelope outside the host's view, not slack in an arithmetic budget.
 *
 *  Deriving this from the cap would be worse than arbitrary: it would encode a number the host
 *  learns only by crashing, and it would silently re-derive itself when a provider changes.
 *  FG-689 step 11 validates this against ONE REAL dispatch and replaces it with the number
 *  that dispatch proved. */
export const DEFAULT_SHARD_BUDGET = 600_000;

/** The unit `DEFAULT_SHARD_BUDGET` and every size in a `ShardPlan` are denominated in — the
 *  same unit `review-diff.ts` measures bodies in, because a budget compared against a
 *  measurement in another unit is not a budget. */
export const SHARD_BUDGET_UNIT: ReviewDiffSizeUnit = REVIEW_DIFF_SIZE_UNIT;

/** The value `budgetValidatedRuntime` carries until a real dispatch has proven the budget.
 *
 *  It is deliberately this string and not a runtime name, and it is NOT a placeholder waiting
 *  for someone to hand-edit it into one: a runtime name written here would be a runtime nobody
 *  measured, which is the untested number D4 exists to prevent. The honest value is recorded
 *  by OBSERVATION — `recordShardBudgetValidation` replaces it with the runtime name read back
 *  off the manifest of a dispatch that actually delivered a composed input at this budget and
 *  completed. A plan that has dispatched nothing says so.
 *
 *  This is why `shardPlanDigest` deliberately excludes the field (see below): recording the
 *  validation after the fan-out must not re-partition anything. */
export const UNVALIDATED_BUDGET_RUNTIME = "unvalidated";

/** D9. Discovery's fan-out is a bare `Promise.all` that does not route through the runner's
 *  concurrency limit, and dispatch is about to become lenses x shards rather than one per
 *  lens. 4 mirrors `runNext.ts`'s `fanout.max_concurrency ?? 4` so the review path is bounded
 *  the same way every other fan-out in forge is. Recorded WITH the plan: a bound nobody wrote
 *  down is a bound nobody can audit afterwards. */
export const DEFAULT_FANOUT_WIDTH = 4;

/** A contract, or just the two fields scope resolution reads. Narrow on purpose — nothing
 *  here needs the threat model, and a narrow parameter is a statement that scope resolution
 *  cannot come to depend on the rest of the contract. */
export type ScopedContract = Pick<ReviewContract, "risk_lenses" | "lens_scopes">;

export type ScopeResolution = {
  /** Selected lens -> the paths it owns, sorted, deduped. Keyed in `RISK_LENSES` order.
   *  OVERLAP BETWEEN LENSES IS EXPECTED, not a conflict: two reviewers reading the same file
   *  through different lenses is the point of having lenses. */
  owned: Map<RiskLens, string[]>;
  /** Paths no selected lens's scope matches. Non-empty means the diff grew a surface nobody
   *  was assigned, and step 7's confirmation returns it to plan rather than guessing an
   *  owner. */
  uncovered: string[];
  /** Selected lenses that own nothing in THIS change. A third state, decided here so the
   *  plan's `lenses` and `skipped` lists cannot disagree about the same lens. */
  skipped: SkippedLens[];
};

/** Byte-order string comparison. Explicitly NOT `localeCompare`, which is locale-dependent
 *  and would let the same inputs partition differently on two machines. */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Does one AUTHORED pattern own one path?
 *
 *  A pattern is a literal repo-relative path, or a directory prefix. That is the whole
 *  vocabulary. There is no glob expansion: `*` is an ordinary character here, so a contract
 *  that authored `src/*.ts` owns nothing and its paths surface as UNCOVERED, which refuses.
 *  Failing that way round is the point — a half-understood pattern silently owning the wrong
 *  set is a coverage guarantee that reports success while being false.
 *
 *  There is no negation and no exclusion form (D5); `review-contract.ts` refuses a leading
 *  `!` at the schema, and nothing here would honour one anyway. */
export function matchesScopePattern(path: string, pattern: string): boolean {
  const p = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (p === "") return false;
  if (path === p) return true;
  // A prefix owns a DIRECTORY, not a string prefix: `src/queue` owns `src/queue/loop.ts` and
  // must not own `src/queue-board.ts`.
  return path.startsWith(`${p}/`);
}

/** Match every selected lens's authored patterns against the pinned rendering's path set.
 *
 *  `paths` must be the path set of the ONE pinned rendering the shards will be cut from
 *  (D14). Passing a set from a second git invocation is the defect `review-diff.ts` exists to
 *  remove: coverage would then be asserted over bytes nobody dispatched. */
export function resolveScopes(contract: ScopedContract, paths: readonly string[]): ScopeResolution {
  const selected = RISK_LENSES.filter((l) => contract.risk_lenses.includes(l));
  const unique = [...new Set(paths)].sort(byPath);

  const owned = new Map<RiskLens, string[]>();
  const skipped: SkippedLens[] = [];
  const covered = new Set<string>();

  for (const lens of selected) {
    const patterns = contract.lens_scopes[lens] ?? [];
    const mine = unique.filter((path) => patterns.some((pattern) => matchesScopePattern(path, pattern)));
    owned.set(lens, mine);
    for (const path of mine) covered.add(path);
    if (mine.length === 0) skipped.push({ lens, reason: "zero_in_scope_paths" });
  }

  return { owned, uncovered: unique.filter((p) => !covered.has(p)), skipped };
}

/** A digest over the AUTHORED scopes, for `ShardDerivation.scopesDigest`.
 *
 *  Over the authored patterns rather than the resolved owned sets, and that is sufficient:
 *  the resolution is a pure function of (patterns, paths), and the paths are already pinned by
 *  `baseSha`, `candidateSha` and `renderingId` in the same derivation. Digesting the patterns
 *  keeps the field's name honest — it says what the contract's approving authority approved. */
export function scopesDigestOf(scopes: LensScopes): string {
  const canonical = RISK_LENSES.filter((l) => scopes[l] !== undefined).map((l) => [
    l,
    [...new Set(scopes[l] as string[])].sort(byPath),
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

/** The partition's IDENTITY (D17).
 *
 *  Over exactly the seven inputs that DETERMINE the partition: the two shas and the
 *  `renderingId` fix the bytes, `scopesDigest` fixes who owns which of them, and
 *  `budget`+`unit`+`envelopes` fix where the cuts fall. Change any one and every recorded
 *  shard-scoped decision is detectably about a partition that no longer exists.
 *
 *  `envelopes` is digested for the same reason `renderingId` is (RF-1). The allowance a lens
 *  is packed into is `budget - envelopes[lens]`, so editing the reviewer prompt moves the
 *  cuts; a re-partition that did not move the digest would leave every recorded shard-scoped
 *  decision silently honored against a partition that no longer exists.
 *
 *  The validation fields of `ShardDerivation` are deliberately NOT digested:
 *   * `budgetValidatedRuntime` / `budgetValidatedChars` — re-validating the same budget against
 *     a new runtime does not move a single byte between shards, and the validation is recorded
 *     AFTER the fan-out. Digesting either would supersede every operator's acceptance for a
 *     partition that is identical, which is D17 crying wolf.
 *   * `fanoutWidth` (not part of the derivation at all) — how many dispatches run at once
 *     does not change what any of them reads. */
export function shardPlanDigest(derivation: ShardDerivation): string {
  const canonical = [
    ["baseSha", derivation.baseSha],
    ["candidateSha", derivation.candidateSha],
    ["scopesDigest", derivation.scopesDigest],
    ["budget", derivation.budget],
    ["unit", derivation.unit],
    ["envelopes", Object.entries(derivation.envelopes ?? {}).sort(([a], [b]) => byPath(a, b))],
    ["renderingId", derivation.renderingId],
  ];
  return `shard-plan-1-${createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32)}`;
}

/** The plan as this module produces it: everything the store persists except `recordedAt`,
 *  which is a clock reading and would break reproducibility if it were decided here. */
export type ShardPlanDraft = Omit<ShardPlan, "recordedAt">;

export type UnfittableFile = {
  path: string;
  /** The HOST's measurement of this file's rendered body, in `unit`. */
  chars: number;
  /** Every selected lens that owns it — all of them are blocked, not just the first. */
  lenses: RiskLens[];
  /** The tightest DIFF allowance among `lenses` — the budget minus that lens's measured
   *  dispatch envelope. The allowance, not the budget, is what the body has to fit in. */
  allowance: number;
};

export type ShardPlanRefusalReason =
  | "file_exceeds_budget"
  | "budget_not_positive"
  | "fanout_width_invalid"
  | "owned_path_not_rendered"
  | "skipped_lens_disagreement"
  | "envelope_exceeds_budget"
  | "envelope_not_measured";

export type PlanShardsResult =
  | { ok: true; plan: ShardPlanDraft }
  | { ok: false; reason: ShardPlanRefusalReason; refusal: string; unfittable?: UnfittableFile[] };

export type PlanShardsArgs = {
  /** The pinned rendering's per-file bodies. Every owned path must appear here. */
  files: readonly ReviewDiffFile[];
  owned: ReadonlyMap<RiskLens, string[]>;
  skipped: readonly SkippedLens[];
  /** Carries `budget`, `unit` and `envelopes`; see the deviation note at the top of this file.
   *  The reserve rides here rather than beside it for the same reason the budget does: it
   *  determines the partition, `digest` is computed over it, and a second copy that disagreed
   *  would produce a plan whose recorded identity describes a partition that was not cut. */
  derivation: ShardDerivation;
  fanoutWidth?: number;
};

/** Cut each lens's owned bodies into shards of at most `derivation.budget`.
 *
 *  Sorted by path, then greedily filled: a file that does not fit in the open shard closes it
 *  and opens the next. Deterministic, order-independent of the rendering, and — the property
 *  that actually matters — LOSSLESS. Nothing is dropped, deduplicated across shards,
 *  truncated or reordered; the union of a lens's shard path lists is its owned set exactly.
 *
 *  Greedy rather than optimal on purpose. Bin-packing a lens into the fewest shards would
 *  scatter related files across shards to fill gaps, so which shard a path lands in would
 *  depend on the sizes of unrelated files. A reviewer reads a shard; contiguity by path is
 *  worth more than one fewer container. */
export function planShards(args: PlanShardsArgs): PlanShardsResult {
  const { derivation } = args;
  const budget = derivation.budget;
  const unit = derivation.unit;
  const fanoutWidth = args.fanoutWidth ?? DEFAULT_FANOUT_WIDTH;

  if (!Number.isInteger(budget) || budget <= 0) {
    return {
      ok: false,
      reason: "budget_not_positive",
      refusal:
        `the shard budget must be a positive whole number of ${unit}; the recorded derivation carries ` +
        `${budget}. No shard set was planned and nothing was dispatched.`,
    };
  }
  if (!Number.isInteger(fanoutWidth) || fanoutWidth < 1) {
    return {
      ok: false,
      reason: "fanout_width_invalid",
      refusal:
        `the dispatch fan-out width must be a positive whole number; ${fanoutWidth} was supplied. An ` +
        `unbounded lens x shard fan-out is what FG-689 D9 exists to prevent. No shard set was planned.`,
    };
  }

  const byPathIndex = new Map(args.files.map((f) => [f.path, f]));
  const lenses = [...args.owned.keys()].filter((l) => RISK_LENSES.includes(l)).sort(byPath);
  const skippedLenses = new Set(args.skipped.map((s) => s.lens));

  // A lens is skipped or it has shards. The two lists disagreeing would either dispatch a
  // zero-path container or leave a lens owed nothing with nobody having recorded why.
  for (const lens of lenses) {
    const paths = args.owned.get(lens) ?? [];
    if (paths.length === 0 && !skippedLenses.has(lens)) {
      return {
        ok: false,
        reason: "skipped_lens_disagreement",
        refusal:
          `the ${lens} lens owns no path in this change but was not recorded as intentionally skipped. A ` +
          `zero-path lens is never dispatched and never silently dropped — it is recorded skipped with a ` +
          `reason. No shard set was planned.`,
      };
    }
    if (paths.length > 0 && skippedLenses.has(lens)) {
      return {
        ok: false,
        reason: "skipped_lens_disagreement",
        refusal:
          `the ${lens} lens is recorded as intentionally skipped but owns ${paths.length} path(s) in this ` +
          `change. Skipping a lens that owns paths would drop a reviewed surface while reporting the review ` +
          `complete. No shard set was planned.`,
      };
    }
  }

  // THE DIFF ALLOWANCE, PER LENS: what is left of the budget once the dispatch envelope the
  // host will compose AROUND this lens's shards is paid for. Every measurement and every
  // packing decision below is made against the allowance and never against `budget`, because
  // `budget` bounds the input the reviewer receives and the diff is only part of it.
  const allowanceOf = new Map<RiskLens, number>();
  for (const lens of lenses) {
    if ((args.owned.get(lens) ?? []).length === 0) continue;
    const envelope = (derivation.envelopes ?? {})[lens];
    if (envelope === undefined || !Number.isInteger(envelope) || envelope < 0) {
      return {
        ok: false,
        reason: "envelope_not_measured",
        refusal:
          `no dispatch-envelope measurement was supplied for the ${lens} lens, so the shard budget of ` +
          `${budget} ${unit} would bound only the diff bytes and not the input a reviewer actually receives. ` +
          `That is the FG-689 RF-1 defect exactly, and it is not defaulted to zero here — a zero reserve is the ` +
          `old behaviour wearing the new field's name. No shard set was planned and nothing was dispatched.`,
      };
    }
    if (envelope >= budget) {
      return {
        ok: false,
        reason: "envelope_exceeds_budget",
        refusal:
          `the ${lens} lens's dispatch envelope alone measures ${envelope} ${unit} against a shard budget of ` +
          `${budget} ${unit}, so no diff byte fits beside it and this review CANNOT be dispatched. The envelope ` +
          `is the contract JSON, the shard's path list and the fixed instructions — none of which is truncated ` +
          `or summarized to make room. Shrink the confirmed contract, or raise the budget ` +
          `(forge review continue --shard-budget <n>) only if a real dispatch validates the larger number. No ` +
          `container was started.`,
      };
    }
    allowanceOf.set(lens, budget - envelope);
  }

  // MEASURE FIRST, ACROSS EVERY LENS, AND REPORT EVERY OFFENDER. Refusing on the first
  // oversize file would make an operator raise the budget, re-run, and meet the next one.
  const unfittable = new Map<string, UnfittableFile>();
  const missing: string[] = [];
  for (const lens of lenses) {
    const allowance = allowanceOf.get(lens) as number;
    for (const path of args.owned.get(lens) ?? []) {
      const file = byPathIndex.get(path);
      if (file === undefined) {
        missing.push(`${path} (owned by ${lens})`);
        continue;
      }
      if (file.chars > allowance) {
        const existing = unfittable.get(path);
        if (existing) {
          existing.lenses.push(lens);
          existing.allowance = Math.min(existing.allowance, allowance);
        } else unfittable.set(path, { path, chars: file.chars, lenses: [lens], allowance });
      }
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: "owned_path_not_rendered",
      refusal:
        `${missing.length} owned path(s) do not appear in the pinned rendering: ${missing.sort(byPath).join(", ")}. ` +
        `The scopes and the shards must be resolved against ONE rendering; a path owned but not rendered would ` +
        `be silently reviewed by nobody. No shard set was planned.`,
    };
  }

  if (unfittable.size > 0) {
    const offenders = [...unfittable.values()].sort((a, b) => byPath(a.path, b.path));
    return {
      ok: false,
      reason: "file_exceeds_budget",
      unfittable: offenders,
      refusal:
        `${offenders.length} file(s) cannot fit in one shard, so this review CANNOT be dispatched: ` +
        offenders
          .map(
            (f) =>
              `${f.path} measures ${f.chars} ${unit} against a diff allowance of ${f.allowance} ${unit} ` +
              `(the ${budget} ${unit} shard budget less the ${budget - f.allowance} ${unit} the host measures ` +
              `for the dispatch envelope it composes around the diff; owned by ${f.lenses.join(", ")})`,
          )
          .join("; ") +
        `. The unit is UTF-8 bytes — FG-689 records these measurements as "characters" and they are byte ` +
        `counts; it travels with the budget so it cannot later be read as tokens. Nothing is truncated, ` +
        `sampled or summarized to make a file fit: a reviewer handed part of a file authors an honest pass ` +
        `over a change they did not see. Raise the budget (forge review continue --shard-budget <n>) only if ` +
        `a real dispatch validates the larger number, or split the file. No container was started.`,
    };
  }

  const planned: PlannedLens[] = [];
  for (const lens of lenses) {
    const paths = args.owned.get(lens) ?? [];
    if (paths.length === 0) continue;

    const allowance = allowanceOf.get(lens) as number;
    const groups: { paths: string[]; chars: number }[] = [];
    let current: { paths: string[]; chars: number } | undefined;
    for (const path of [...paths].sort(byPath)) {
      const file = byPathIndex.get(path) as ReviewDiffFile;
      if (current !== undefined && current.chars + file.chars > allowance) {
        groups.push(current);
        current = undefined;
      }
      if (current === undefined) current = { paths: [], chars: 0 };
      current.paths.push(path);
      current.chars += file.chars;
    }
    if (current !== undefined) groups.push(current);

    const of = groups.length;
    const shards: PlannedShard[] = groups.map((g, i) => ({ index: i + 1, of, paths: g.paths, chars: g.chars }));
    planned.push({ lens, shards });
  }

  return {
    ok: true,
    plan: {
      derivation,
      digest: shardPlanDigest(derivation),
      fanoutWidth,
      lenses: planned,
      skipped: [...args.skipped].sort((a, b) => byPath(a.lens, b.lens)),
    },
  };
}
