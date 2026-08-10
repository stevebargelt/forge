// FG-688: the ONE source every surface reads when it answers "would `forge
// recover <parent> --re-drive` be ACCEPTED right now, and if not, which verb
// WOULD be?".
//
// It lives here rather than beside the verb in cli/commands/recover.ts because
// `forge retry` asks the same question about the same parent (v2/retry.ts's
// ordered-wave redirect). The build review found those two surfaces answering it
// with two different predicates — recover consulted supersession and the run
// accept-set, retry consulted neither — so `forge retry` could advise a
// `--re-drive` that immediately refused, which is the misadvising defect FG-688
// exists to close, reintroduced one command over. Two predicates drift; one
// cannot.

import type { Run, Task } from "../types/index.js";
import { eventsForTask } from "../store/events.js";
import { isOrderedFanoutWave } from "./reconcile.js";
import { retryPolicy, isReDrivableFailureKind } from "./retry-policy.js";

const TERMINAL = new Set(["complete", "failed"]);

// A recommended next step: the command(s) to run, and why. Rendered as
// `cmd [&& cmd]  (note)` — the `&&` chain is literal, copy-pasteable shell.
export type Recommendation = { commands: string[]; note: string };

export function renderRecommendation(r: Recommendation): string {
  return r.commands.join(" && ") + (r.note ? `  (${r.note})` : "");
}

// FG-688 / AC3, the verb-level half of "cross-parent adoption stays closed".
//
// A parent is SUPERSEDED when another parent-less primary in the same phase was
// created at or after it. Such a primary OWNS the phase now — `forge gate
// request-changes` mints exactly this shape — so the older parent belongs to a
// DEAD LINEAGE, and reopening it would put two live parents in one phase. That is
// precisely the cross-wave hazard FG-584's RF-3b review closed by scoping adoption
// to the current parent, arriving through the recovery door instead of the
// dispatch one, and the reason decision (a) reuses the parent row is so that guard
// never has to move.
//
// The comparison is `>=`, not `>`: two primaries stamped in the same millisecond
// leave the phase's ownership genuinely ambiguous, and this gates a MUTATION, so
// the tie refuses. It subsumes the old `dupePending` check (a pending re-drive is
// a superseding primary), whose "run forge next instead" advice is preserved by
// the recommendation below.
export function supersedingPrimary(parent: Task, allTasks: Task[]): Task | undefined {
  return allTasks.find(
    (t) => t.id !== parent.id && t.phase === parent.phase && t.parentId === undefined && t.createdAt >= parent.createdAt,
  );
}

/** FG-688: which clause of `--re-drive`'s eligibility conjunction decided this
 *  parent — `eligible`, or the one that refused. Surfaced on the view so a
 *  `--json` consumer reads WHY rather than inferring it from a rendered string. */
export type ReDriveDispositionCode =
  | "eligible"
  | "superseded"
  | "run_not_reopenable"
  | "failure_kind_refused"
  | "ordered_resumable_in_place"
  | "wave_in_flight"
  | "not_failed";

export type ReDriveDisposition = {
  /** Would `performReDrive` accept this parent right now? */
  eligible: boolean;
  disposition: ReDriveDispositionCode;
  /** One sentence: the clause that decided it, in operator language. */
  why: string;
  /** The wave's DURABLE shape (isOrderedFanoutWave) — what picks the lane. */
  ordered: boolean;
  /** Set only for `superseded`: the later primary that owns the phase now. */
  supersededBy?: string;
};

// ── FG-688: the fanout recommendation, held to the same rule as the task one ──
//
// `buildFanoutView` used to hardcode `forge recover <id> --re-drive` for EVERY
// fanout parent regardless of failure kind, while the mutation guard accepts only
// an enumerated set — so on the `prerequisite_blocked` parent this ticket is about
// (FG-576), following forge's own printed advice produced a refusal. That is the
// same defect `recommendationForKind` already fixed once for --continue by
// routing through CONTINUABLE_KINDS, and it is fixed the same way here: the
// recommendation reads the SAME predicate the guard enforces, and every refusing
// clause names a verb that WILL be accepted instead.
//
// The invariant, stated once: a printed recommendation may never name a verb the
// mutation guard would reject — for ANY failure kind, not just this ticket's, and
// on ANY surface that advises about the re-drive. So the clauses below mirror
// performReDrive's conjunction and are deliberately at least as STRICT as it:
// anything this predicate cannot decide from durable state resolves to "not
// eligible", because a run-level inspect must stay docker-free (no container
// probe) and a false --re-drive recommendation IS the defect.
export function reDriveDisposition(
  parent: Task,
  allTasks: Task[],
  run: Run | undefined,
  failureKind: string | undefined,
): ReDriveDisposition {
  const ordered = isOrderedFanoutWave(parent.id);

  // Guard (iv), read first because a dead lineage is never re-driven whatever
  // else is true. performReDrive checks status before this; checking it earlier
  // only makes this predicate stricter, never looser, which is the safe direction.
  const superseding = supersedingPrimary(parent, allTasks);
  if (superseding) {
    return {
      eligible: false,
      disposition: "superseded",
      ordered,
      supersededBy: superseding.id,
      why:
        `${superseding.id} (status=${superseding.status}) is a later primary in phase '${parent.phase}', so this parent is a ` +
        "dead lineage — reopening it would put two live parents in one phase",
    };
  }

  if (!run || (run.status !== "failed" && run.status !== "active")) {
    return {
      eligible: false,
      disposition: "run_not_reopenable",
      ordered,
      why:
        `run ${parent.runId} is '${run?.status ?? "missing"}' — --re-drive only reopens a 'failed' run (an 'active' one it ` +
        "leaves alone), and no recovery verb resurrects a completed or abandoned one",
    };
  }

  if (parent.status === "failed") {
    if (!isReDrivableFailureKind(failureKind)) {
      return {
        eligible: false,
        disposition: "failure_kind_refused",
        ordered,
        why:
          `failure_kind=${failureKind ?? "none"} is not in the re-drivable enumeration (an unrecognized kind fails closed here ` +
          "too) — a re-drive would re-read the same plan and re-gate the same tree",
      };
    }
    return {
      eligible: true,
      disposition: "eligible",
      ordered,
      why: ordered
        ? `failure_kind=${failureKind} is re-drivable and the wave is ORDERED — the parent is reopened in place`
        : `failure_kind=${failureKind} is re-drivable — the wave is re-driven as a fresh pending primary`,
    };
  }

  if (parent.status === "running") {
    // An ordered wave stranded by a crash is NOT a re-drive case: reconcile puts
    // the parent back to `pending` on its own row (ordered_fanout_resumable) and
    // the controller resumes it. --re-drive would then refuse a `pending` parent.
    if (ordered) {
      return {
        eligible: false,
        disposition: "ordered_resumable_in_place",
        ordered,
        why:
          "a crash-stranded ORDERED wave is put back to pending on its own row by reconcile (ordered_fanout_resumable) — it is " +
          "resumed automatically, not re-driven",
      };
    }
    // The unordered shape reconcile settles: no container of its own, every child
    // terminal. --re-drive reconciles first, and BOTH of reconcile's landings for
    // this shape stamp `fanout_wave_orphaned`, which the guard accepts — so this
    // stays eligible, exactly as it was before FG-688.
    const waveSettleable =
      !eventsForTask(parent.id).some((e) => e.eventType === "container.started") &&
      allTasks.filter((t) => t.parentId === parent.id).every((c) => TERMINAL.has(c.status));
    if (waveSettleable) {
      return {
        eligible: true,
        disposition: "eligible",
        ordered,
        why:
          "every child is terminal and the parent never had a container of its own — --re-drive settles the wave to " +
          "fanout_wave_orphaned first, then re-drives it",
      };
    }
    return {
      eligible: false,
      disposition: "wave_in_flight",
      ordered,
      why: "a child is still non-terminal, so the wave may still be in flight — --re-drive refuses a running wave",
    };
  }

  return { eligible: false, disposition: "not_failed", ordered, why: `the parent is '${parent.status}', not a failed fanout parent` };
}

export function fanoutRecommendation(parent: Task, d: ReDriveDisposition, failureKind: string | undefined): Recommendation {
  if (d.eligible) {
    return {
      commands: [`forge recover ${parent.id} --re-drive`],
      note: d.ordered
        ? "reopens this parent in place — adopts the items whose captured commits are already integrated and dispatches only the ones that did not complete"
        : "",
    };
  }
  switch (d.disposition) {
    case "superseded":
      return { commands: [`forge next ${parent.runId}`], note: `${d.why}; drive the live wave (${d.supersededBy}) instead` };
    // The general fallback the ticket asks for: name what the OTHER mutation verb
    // will accept, derived from retryPolicy rather than special-cased per kind, so
    // a kind added by a later build gets a correct line without editing this.
    case "failure_kind_refused": {
      const policy = retryPolicy(failureKind);
      return policy.retryable
        ? { commands: [`forge retry ${parent.id}`], note: `${d.why}; it IS retryable without --force` }
        : { commands: [`forge retry ${parent.id} --force`], note: `${d.why}, and retryPolicy needs --force for this kind` };
    }
    case "ordered_resumable_in_place":
      return { commands: [`forge next ${parent.runId}`], note: `${d.why} — drive the run` };
    case "not_failed":
      return parent.status === "pending"
        ? { commands: [`forge next ${parent.runId}`], note: "this wave's parent is already pending — dispatch it" }
        : { commands: [`forge show ${parent.id}`], note: d.why };
    default:
      return { commands: [`forge show ${parent.id}`], note: d.why };
  }
}
