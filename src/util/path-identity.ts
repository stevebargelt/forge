// FG-693: THE CANONICAL FILESYSTEM-IDENTITY CONTRACT.
//
// This module header is the AUTHORITATIVE documentation for how forge decides
// whether two spellings of a project directory name the same tree. Every
// boundary that PERSISTS, LOOKS UP, COMPARES, FILTERS, or DECIDES OWNERSHIP
// from a project path calls this module and nothing else. Subsystem-local
// canonicalizers are removed or delegate here; there is exactly one.
//
// WHY THIS EXISTS. An operating system routinely gives one directory many
// names: a symlinked parent anywhere in the chain, a system directory exposed
// under two prefixes, a relative spelling, a trailing separator, a `.`/`..`
// segment. Forge created runs under one spelling and queried them under
// another, and every raw-string comparison misclassified the result. Three
// earlier repairs (FG-575, FG-576, FG-253) each fixed one consumer and left
// the invariant unsettled — which is why this is a contract and not another
// local helper.
//
// ── THE TWO CASES ──────────────────────────────────────────────────────────
//
// A PathIdentity is one of exactly two things, and never a blend:
//
//   RESOLVED    the filesystem answered. Carries `physical` — the realpath, the
//               one name for that object this contract recognises — plus
//               `asWritten`, the caller's spelling, VERBATIM.
//
//   UNRESOLVED  the filesystem did not answer (the path is gone, or was never
//               there, or could not be traversed). Carries `asWritten` and a
//               `reason`, BOTH FOR DISPLAY AND DIAGNOSTICS ONLY. Neither is an
//               identity and neither may decide anything.
//
// The defect this shape exists to make unrepresentable: the old helpers caught
// the realpath failure and returned a LEXICALLY resolved path in the resolved
// position, so a proven identity and a guess were the same type and the same
// bytes. A guard comparing two guesses looked like it was working. Here, an
// unproven path cannot be handed to a comparison as though it were proven —
// there is no `physical` on the unresolved case to read.
//
// Missing paths are ROUTINE here, not exceptional: disposable clones and
// per-task worktrees are captured while they exist and read after they are
// gone. So UNRESOLVED must be deterministic (it is: same input, same case,
// same reason) AND must never claim two unproven spellings name one object (it
// does not: see below). Those two requirements pull against each other, and
// the resolution is that determinism is spent on the SHAPE of the answer, not
// on manufacturing an identity nobody proved.
//
// ── COMPARISON IS THREE-VALUED ─────────────────────────────────────────────
//
//   compareIdentity(a, b) -> "same" | "different" | "indeterminate"
//
//   "same"           both resolved, and their physical paths are byte-equal.
//   "different"      both resolved, and their physical paths differ.
//   "indeterminate"  EITHER side is unresolved. Nothing is claimed.
//
// An unresolved side is ALWAYS indeterminate, including when the two spellings
// are byte-identical strings. Byte equality of an unproven spelling proves
// nothing: two identical relative spellings resolved from different working
// directories are different objects, and an absolute spelling that no longer
// resolves cannot say what it used to name. "It looks the same" is exactly the
// reasoning this ticket exists to delete.
//
// THIS MODULE EXPORTS NO PLAIN BOOLEAN EQUALITY. Collapsing three values to
// two is a SAFETY DECISION, and it is made at the call site, by name:
//
//   matchesOrIndeterminate()  the GUARD / AUTHORITY class. Indeterminate counts
//                             as a match, so the guard FIRES. Use where the
//                             failure of the guard is the expensive outcome:
//                             self-host dispatch refusal, host-readiness
//                             refusal, any "is this the tree I am running
//                             from" question. A guard that cannot prove the
//                             paths are distinct must assume they are not.
//
//   provenSameOnly()          the ACTING / DESTRUCTIVE class. Indeterminate
//                             counts as no-match, so the actor REFUSES TO ACT.
//                             Use where acting on the wrong tree is the
//                             expensive outcome: deletes, reclaims, lane and
//                             mutex ownership, lifecycle transitions, cleanup,
//                             gate-evidence attribution, scope filtering.
//                             An unproven identity never authorizes an
//                             irreversible or gate-skipping step.
//
// Both projections read as English at the call site and both state the
// direction they fail in, so choosing a bias is a visible act, reviewable in a
// diff. A consumer that wants "just a boolean" must pick one of these two and
// therefore must say which way it fails.
//
// ── STANDING PROHIBITIONS ──────────────────────────────────────────────────
//
// The implementation below contains, and must forever contain:
//
//   * NO enumerated alias prefixes. Not one. Naming the aliases of today's
//     operating systems is a list that goes stale and covers nothing else;
//     realpath covers the whole class, including symlinked parents nobody
//     anticipated.
//   * NO platform branching of any kind. A contract whose answer depends on
//     which host it runs on cannot be tested on one host and trusted on
//     another — which is the precise reason this defect was CI-green and
//     host-red for three tickets running.
//   * NO string rewriting of paths. `asWritten` is preserved byte-for-byte and
//     is never edited, normalized, or converged.
//
// A test asserts these mechanically against this file's source
// (path-identity.test.ts).
//
// ── NAMED RESIDUALS (not closed, not hidden) ───────────────────────────────
//
//   PATH RECREATION. One absolute physical path can name different trees over
//   time (move the directory away, create a new one at the same name).
//   realpath cannot see through time, so a physical path recorded earlier and
//   compared later can be wrong about which tree it meant. This residual is
//   identical for every proven identity, is not an aliasing phenomenon, and is
//   out of scope for FG-693 rather than fixed by it.
//
//   BIND MOUNTS / MULTIPLE MOUNTS OF ONE DEVICE. Two physical paths can reach
//   one tree without either being a symlink. realpath reports them as
//   different, so this contract reports "different". That is the conservative
//   direction for the ACTING class and the unsafe direction for the GUARD
//   class; guards that must cover it need containment reasoning over `physical`
//   in addition to this comparison.
//
//   CASE-INSENSITIVE FILESYSTEMS. Whether realpath returns the on-disk casing
//   is an OS detail this contract does not paper over.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The filesystem answered: `physical` is a PROVEN identity. */
export type ResolvedPathIdentity = {
  readonly kind: "resolved";
  /** The realpath. The only value in this module that may decide anything. */
  readonly physical: string;
  /** The caller's spelling, VERBATIM. Display and audit evidence only. */
  readonly asWritten: string;
};

/** The filesystem did not answer. Nothing here is an identity. */
export type UnresolvedPathIdentity = {
  readonly kind: "unresolved";
  /** The caller's spelling, VERBATIM. DISPLAY AND DIAGNOSTICS ONLY. */
  readonly asWritten: string;
  /** Why resolution failed — an errno code where the filesystem gave one.
   *  DISPLAY AND DIAGNOSTICS ONLY; never an input to a decision. */
  readonly reason: string;
};

export type PathIdentity = ResolvedPathIdentity | UnresolvedPathIdentity;

/** Three-valued, by construction. There is no fourth answer and no boolean. */
export type IdentityComparison = "same" | "different" | "indeterminate";

/** Callers hold either a raw spelling or an already-computed identity. Every
 *  entry point takes both so nobody is tempted to keep a second canonicalizer
 *  around for the raw-string case. */
export type PathIdentityInput = PathIdentity | string;

function unresolvedReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 0 ? message : "unknown";
}

/** Ask the filesystem what this spelling names. The ONE canonicalization in
 *  forge: every other module reaches the filesystem's answer through here.
 *
 *  Never throws — an unresolvable path is a VALUE (UNRESOLVED), not an
 *  exception, because it is an ordinary condition on a substrate where
 *  workspaces are disposable, and because a throw on the publication or
 *  cleanup path is what pushed the earlier helpers into faking a resolution. */
export function identify(path: string): PathIdentity {
  try {
    return { kind: "resolved", physical: realpathSync(path), asWritten: path };
  } catch (err) {
    return { kind: "unresolved", asWritten: path, reason: unresolvedReason(err) };
  }
}

/** Normalize either input form to an identity. A string costs one filesystem
 *  call here; pre-identify when comparing one path against many. */
export function asIdentity(input: PathIdentityInput): PathIdentity {
  return typeof input === "string" ? identify(input) : input;
}

/** The comparison. Read the header before changing any arm of it. */
export function compareIdentity(a: PathIdentityInput, b: PathIdentityInput): IdentityComparison {
  const left = asIdentity(a);
  const right = asIdentity(b);
  // Either side unproven ⇒ nothing is claimed. Deliberately checked BEFORE any
  // look at the spellings: comparing `asWritten` here is the whole defect.
  if (left.kind !== "resolved" || right.kind !== "resolved") return "indeterminate";
  return left.physical === right.physical ? "same" : "different";
}

/** GUARD / AUTHORITY projection — indeterminate counts as a MATCH, so the
 *  guard FIRES. Take this where failing to fire is the expensive outcome. */
export function matchesOrIndeterminate(a: PathIdentityInput, b: PathIdentityInput): boolean {
  return compareIdentity(a, b) !== "different";
}

/** ACTING / DESTRUCTIVE projection — indeterminate counts as NO MATCH, so the
 *  actor REFUSES TO ACT. Take this where acting on the wrong tree is the
 *  expensive outcome. */
export function provenSameOnly(a: PathIdentityInput, b: PathIdentityInput): boolean {
  return compareIdentity(a, b) === "same";
}

/** The value a durable canonical-identity column may hold: a PROVEN physical
 *  path, or null. Never a lexical fallback — a column that mixes proven and
 *  guessed values under one name is the ambiguity FG-693 removes, and null is
 *  the only honest answer for a spelling the filesystem would not confirm. */
export function provenPhysical(input: PathIdentityInput): string | null {
  const id = asIdentity(input);
  return id.kind === "resolved" ? id.physical : null;
}

/** Operator-facing rendering. An unresolved spelling MAY be shown — presentation
 *  fidelity is useful — but it is LABELLED, so no reader mistakes it for a
 *  proven path and no message implies an identity nobody established. */
export function describeIdentity(input: PathIdentityInput): string {
  const id = asIdentity(input);
  return id.kind === "resolved" ? id.physical : `${id.asWritten} (UNRESOLVED: ${id.reason})`;
}

/** The purely LEXICAL resolution of a spelling — NOT an identity, and never a
 *  substitute for one.
 *
 *  Exists for exactly one sanctioned derivation: FG-693's retarget-proof test
 *  for a legacy row that predates canonical identity. A stored spelling whose
 *  proven physical path byte-equals its own lexical resolution traversed no
 *  symlink, so no link under it can have been repointed since the row was
 *  written. Any other use is a lexical guess wearing an identity's clothes.
 *
 *  Relative spellings resolve against the CURRENT working directory, which is
 *  another reason this is not identity. */
export function lexicalResolutionOf(input: PathIdentityInput): string {
  return resolve(typeof input === "string" ? input : input.asWritten);
}
