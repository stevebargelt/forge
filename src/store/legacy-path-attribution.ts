// FG-693: THE LEGACY (NULL-CANONICAL) ATTRIBUTION RULE — ONE DEFINITION.
//
// Every durable table keyed on a project directory now carries TWO columns: the
// as-written `project_dir` (audit evidence, bytes verbatim, decides nothing) and
// `project_dir_canonical` (PROVEN filesystem identity, or NULL). A row written
// BEFORE FG-693 — or written after it while the path was unresolvable — has NULL
// there. Nothing backfills it: resolving a stored spelling later would establish
// only that it resolves TODAY, never that it resolves to the tree the row was
// written against, so a backfill would mint proof that does not exist.
//
// This module is the ONE decision about what such a row may be used for. It is
// imported by src/store/host-verifications.ts (gate evidence, FG-693 step 4) and
// src/store/orchestrator-receipts.ts (receipts, step 6) so the two cannot drift.
// It delegates every filesystem question to src/util/path-identity.ts and
// re-canonicalizes nothing.
//
// ── WHY READ-TIME RESOLUTION ALONE IS NOT ENOUGH ───────────────────────────
//
// The obvious compatibility projection — "resolve the stored spelling at read
// time and compare" — is WRONG, and wrong in the direction that grants
// authority. Read-time resolution establishes AT MOST that the stored spelling
// resolves today. It never establishes that it resolves to the tree the row was
// written against.
//
// Concretely: a row is written under the spelling `/projects/current`, a symlink
// then pointing at checkout A. The symlink is later repointed at checkout B. The
// spelling still resolves — now to B. A reader asking "is there evidence for
// checkout B?" resolves the stored spelling, gets B, sees a match, and credits
// checkout A's gate evidence to checkout B. That is a FALSE PASS: a gate that
// never ran against B is reported as having covered it. It is reachable whenever
// two checkouts of one branch sit at the same commit for the same ticket, which
// a clone plus a worktree makes ordinary here. Nothing in the row can contradict
// it — the canonical column is NULL precisely because identity was never proven.
//
// THEREFORE READ-TIME RESOLUTION ALONE MUST NOT AUTHORIZE ATTRIBUTION.
//
// ── THE RETARGET-PROOF PREDICATE ───────────────────────────────────────────
//
// A legacy row is attributable only where we can say WHY retargeting cannot have
// intervened, and there is exactly one such statement that enumerates nothing:
//
//   the stored spelling traversed no symlink at all.
//
// Derived from the contract's own fields: the identity RESOLVES, and the
// resolved `physical` byte-equals the LEXICAL resolution of the same stored
// spelling. When those agree, the recorded bytes already ARE the physical path,
// so there is no link under the path that could have been repointed since.
//
// One extra clause the byte-equality alone does not cover: a `..` segment.
// `resolve("/a/link/../b")` is "/a/b" for every possible target of `link`, while
// realpath must follow `link` first — so a `..`-bearing spelling can satisfy the
// byte-equality while HAVING traversed a link that was since repointed. `..` is
// the only lexical operation with that property (`.` and repeated or trailing
// separators collapse identically in both), so a `..`-bearing spelling is
// declined. That is strictly more conservative than plain byte-equality: it can
// only ever produce a redundant gate run, never a false pass.
//
// Everything else is DECLINED, under one of two reason codes, so a redundant
// gate run is explained rather than mysterious:
//
//   legacy-unresolved        the stored spelling no longer resolves at all (the
//                            directory is gone — routine here, where clones and
//                            per-task worktrees are disposable).
//   legacy-alias-unprovable  it resolves, but through a traversed symlink whose
//                            write-time target the row cannot state. Retargeting
//                            cannot be excluded, so identity cannot be claimed.
//
// A DECLINED row is still fully READABLE. It is returned verbatim by every audit
// and listing read, never filtered out, never rewritten, never re-attributed.
// What it loses is AUTHORITY: it does not satisfy a gate and it does not
// authorize a lifecycle transition or a cleanup. Consumers differ in what they
// do with the decline (step 4 declines outright and re-runs the gate; step 6
// still SHOWS the receipt, labelled, and refuses only what it would AUTHORIZE) —
// the RULE is identical, the disposition is the consumer's.
//
// ── NAMED RESIDUAL (not closed, not hidden) ────────────────────────────────
//
// PATH RECREATION. `mv /a /b; mkdir /a` makes one absolute physical path name a
// different tree over time, and no amount of realpath sees through that. This
// residual is IDENTICAL for a post-change PROVEN-canonical row, is not an
// aliasing phenomenon, and is out of scope for FG-693 rather than fixed by it.

import {
  asIdentity,
  lexicalResolutionOf,
  provenSameOnly,
  type PathIdentityInput,
  type ResolvedPathIdentity,
} from "../util/path-identity.js";

/** Why a NULL-canonical row was refused authority. Exactly two, both surfaced to
 *  the operator at the point the decline costs something (a redundant gate run,
 *  a refused transition), so the repeat is explained. */
export type LegacyDeclineReason = "legacy-unresolved" | "legacy-alias-unprovable";

export type RetargetProof =
  | { readonly provable: true; readonly identity: ResolvedPathIdentity }
  | { readonly provable: false; readonly reason: LegacyDeclineReason };

/** `..` is the one lexical segment that collapses a symlink traversal invisibly
 *  — see the header. Both separators are treated as separators: where `\` is an
 *  ordinary filename character this can only over-decline, and over-declining is
 *  the safe direction for every consumer of this module. */
function hasParentSegment(spelling: string): boolean {
  return spelling.split(/[/\\]+/).includes("..");
}

/** Can this stored spelling's identity be claimed at all, given that nothing
 *  proved it when the row was written? Resolvable AND demonstrably link-free —
 *  nothing else. Never throws; an unresolvable path is a decline, not an error. */
export function retargetProofIdentity(storedSpelling: string): RetargetProof {
  const identity = asIdentity(storedSpelling);
  if (identity.kind !== "resolved") return { provable: false, reason: "legacy-unresolved" };
  if (hasParentSegment(storedSpelling)) return { provable: false, reason: "legacy-alias-unprovable" };
  if (identity.physical !== lexicalResolutionOf(storedSpelling)) {
    return { provable: false, reason: "legacy-alias-unprovable" };
  }
  return { provable: true, identity };
}

export type LegacyRowAttribution =
  /** Retarget-proof AND proven to be the caller's tree. */
  | { readonly outcome: "attributed"; readonly physical: string }
  /** Retarget-proof, but a DIFFERENT tree. Not a decline — someone else's row. */
  | { readonly outcome: "other_project"; readonly physical: string }
  /** The row's own identity cannot be claimed. Counted, and reported. */
  | { readonly outcome: "declined"; readonly reason: LegacyDeclineReason }
  /** The CALLER's path is unproven, so nothing can be attributed to it. Not a
   *  property of the row, so deliberately not one of the two reason codes. */
  | { readonly outcome: "unproven_target" };

/** THE decision. `storedSpelling` is the row's as-written project_dir; `target`
 *  is the project the caller is asking about. Takes the ACTING-class projection
 *  (provenSameOnly) — an unproven identity never authorizes anything. */
export function attributeLegacyRow(storedSpelling: string, target: PathIdentityInput): LegacyRowAttribution {
  const asked = asIdentity(target);
  if (asked.kind !== "resolved") return { outcome: "unproven_target" };

  const proof = retargetProofIdentity(storedSpelling);
  if (!proof.provable) return { outcome: "declined", reason: proof.reason };

  return provenSameOnly(proof.identity, asked)
    ? { outcome: "attributed", physical: proof.identity.physical }
    : { outcome: "other_project", physical: proof.identity.physical };
}

export type LegacyDeclineTally = Record<LegacyDeclineReason, number>;

export function newLegacyDeclineTally(): LegacyDeclineTally {
  return { "legacy-unresolved": 0, "legacy-alias-unprovable": 0 };
}

export function countLegacyDecline(tally: LegacyDeclineTally, reason: LegacyDeclineReason): void {
  tally[reason] += 1;
}

export function legacyDeclineTotal(tally: LegacyDeclineTally): number {
  return tally["legacy-unresolved"] + tally["legacy-alias-unprovable"];
}

/** Operator-facing summary, or null when there is nothing to report. Names both
 *  codes with their counts so the reader can tell "the directory is gone" from
 *  "the spelling went through a link we cannot vouch for". */
export function describeLegacyDeclines(tally: LegacyDeclineTally): string | null {
  const parts = (Object.keys(tally) as LegacyDeclineReason[])
    .filter((reason) => tally[reason] > 0)
    .map((reason) => `${tally[reason]} ${reason}`);
  return parts.length > 0 ? parts.join(", ") : null;
}
