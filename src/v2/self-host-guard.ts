// FG-612: forge-on-forge dispatch guard.
//
// Hit live 2026-07-24: `forge new feature --project <the forge checkout>` with
// FORGE_WORKTREES unset. Agents write into the shared bind-mount when worktree
// mode is off, and bin/forge execs node with tsx loaded in-process over src/
// (FG-569) — there is no meaningful dist/. So every half-written engineer file
// was IMMEDIATELY live for every forge process on the host, in every project.
// A concurrent orchestrator in another repo found `forge new` broken mid-write.
//
// The guard: refuse, pre-container and pre-row, when the project being
// dispatched against overlaps the source root of the forge that is executing
// and THIS dispatch provisions no isolated workspace. "This dispatch" is the
// load-bearing word — see DispatchIsolation.

// FG-693: this file no longer canonicalizes anything itself. Its private
// canonical() caught realpath's failure and returned a LEXICALLY resolved path
// in the resolved position, so an unproven spelling and a proven one were the
// same type and the same bytes — the guard compared two guesses and looked like
// it was working. Identity now comes from the one contract
// (src/util/path-identity.ts), where UNRESOLVED is its own case and cannot be
// handed to a comparison dressed as a proven path. The bias this guard takes on
// that third value is the contract's GUARD/AUTHORITY projection, by name:
// indeterminate counts as a match, so the guard FIRES.

import { sep } from "node:path";
import {
  asIdentity,
  describeIdentity,
  matchesOrIndeterminate,
  type PathIdentity,
  type PathIdentityInput,
  type ResolvedPathIdentity,
} from "../util/path-identity.js";
import { assetRoot } from "./asset-root.js";

let sourceRootForTest: string | null = null;

/** Test-only: resolve the source root to a fixture tree, so an integration test
 *  can own BOTH sides of the comparison (a writable root AND a writable
 *  prefix-colliding sibling) while still driving the real dispatch path. A
 *  function and deliberately not an env carrier: an ambient one would let the
 *  environment make the guard inert, which is the failure mode the whole file
 *  exists to prevent. */
export function _setSourceRootForTest(root: string | null): void {
  sourceRootForTest = root;
}

/** The source root of the forge that is currently executing, as an IDENTITY —
 *  which may be UNRESOLVED, and that is a real condition rather than a
 *  theoretical one: assetRoot() can name a release tree that a concurrent
 *  `forge release` promote has already replaced. Callers that decide anything
 *  take this; forgeSourceRoot() below is the display/compat projection. */
export function forgeSourceRootIdentity(): PathIdentity {
  return asIdentity(sourceRootForTest ?? assetRoot());
}

/** The source root as a string. Under a release that is the release tree; under
 *  a live checkout it is the checkout — the same answer assetRoot() gives for
 *  release-owned bytes, which is exactly the tree a dispatch must not be allowed
 *  to mutate underneath itself.
 *
 *  When the root does not resolve this returns the SPELLING, and a spelling is
 *  not an identity: everything that compares re-derives identity from it (an
 *  unresolvable spelling identifies as UNRESOLVED again, so the guard still
 *  fires). Nothing here ever manufactures a proven-looking path. */
export function forgeSourceRoot(): string {
  const id = forgeSourceRootIdentity();
  return id.kind === "resolved" ? id.physical : id.asWritten;
}

/** Containment over PROVEN physical paths only — never over a spelling. */
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Which side the filesystem would not answer for. Diagnostics only. */
export type UnresolvedSide = "project" | "source-root" | "both";

/** The three-valued answer to "does this dispatch land in the tree this forge is
 *  executing from". `distinct` is the ONLY arm that permits the dispatch, and it
 *  is reachable only when BOTH sides are proven. */
export type SelfHostRelation =
  | {
      kind: "overlap";
      /** Which way round, for the message — all three are equally hazardous. */
      direction: "same-tree" | "project-inside-source" | "source-inside-project";
      project: ResolvedPathIdentity;
      sourceRoot: ResolvedPathIdentity;
    }
  | { kind: "distinct"; project: ResolvedPathIdentity; sourceRoot: ResolvedPathIdentity }
  | { kind: "unproven"; project: PathIdentity; sourceRoot: PathIdentity; unresolved: UnresolvedSide };

/** Classify the dispatch. Self-host means the mount and the executing forge's
 *  source tree overlap in EITHER direction: the project IS the source root,
 *  contains it (a parent-dir mount), or is a subdir of it (--allow-subproject).
 *  All three put agent writes inside the tree this process is running from.
 *
 *  Containment reasoning lives here rather than in the identity contract because
 *  the contract compares OBJECTS and this guard asks about TREES — the contract's
 *  own header names containment over `physical` as what a guard of this class
 *  needs in addition to the comparison. The equality/indeterminate half is still
 *  the contract's, called by name below. */
export function classifySelfHostDispatch(
  projectDir: PathIdentityInput,
  sourceRoot: PathIdentityInput = forgeSourceRootIdentity()
): SelfHostRelation {
  const project = asIdentity(projectDir);
  const root = asIdentity(sourceRoot);

  // The indeterminate half of matchesOrIndeterminate, made explicit so the two
  // sides can be NAMED in the refusal. Deliberately first: no spelling of an
  // unresolved path may reach the containment compare below, because comparing
  // spellings is the entire defect this ticket exists to delete.
  if (project.kind !== "resolved" || root.kind !== "resolved") {
    const unresolved: UnresolvedSide =
      project.kind !== "resolved" && root.kind !== "resolved"
        ? "both"
        : project.kind !== "resolved"
          ? "project"
          : "source-root";
    return { kind: "unproven", project, sourceRoot: root, unresolved };
  }

  // Both sides proven from here on. The contract's GUARD-class projection, by
  // name — for two resolved identities it is exactly "same physical object".
  if (matchesOrIndeterminate(project, root)) {
    return { kind: "overlap", direction: "same-tree", project, sourceRoot: root };
  }
  if (contains(root.physical, project.physical)) {
    return { kind: "overlap", direction: "project-inside-source", project, sourceRoot: root };
  }
  if (contains(project.physical, root.physical)) {
    return { kind: "overlap", direction: "source-inside-project", project, sourceRoot: root };
  }
  return { kind: "distinct", project, sourceRoot: root };
}

/** The guard-class boolean: TRUE unless both paths are proven and proven
 *  separate. An unproven identity is not evidence of a separate tree, so it
 *  counts as self-host — the same direction matchesOrIndeterminate fails in, for
 *  the same reason: a guard that cannot prove distinctness must assume overlap.
 *
 *  Consumers that must TELL the two apart (to say WHY they refused) take
 *  classifySelfHostDispatch instead. */
export function isSelfHostDispatch(
  projectDir: PathIdentityInput,
  sourceRoot: PathIdentityInput = forgeSourceRootIdentity()
): boolean {
  return classifySelfHostDispatch(projectDir, sourceRoot).kind !== "distinct";
}

/** What THIS dispatch does about isolation, stated by the caller. The guard must
 *  never derive it from isWorktreeModeEnabled(): since FG-345 that flag answers
 *  "is isolation the default on this host", which is a different question from
 *  "does this code path provision a workspace". Reading the first as the second
 *  is what let a self-host `forge invoke` onto the live checkout unrefused. */
export type DispatchIsolation =
  /** This dispatch provisions a task-scoped workspace; the agent never touches the live tree. */
  | "isolated"
  /** This path provisions one when worktree mode is armed — and it is not armed here. */
  | "not-armed"
  /** This path mounts the live project dir unconditionally, whatever the flag says. */
  | "never-isolated";

/** FG-345 made isolation default-on, which makes the remediation platform-specific:
 *  "set FORGE_WORKTREES=1" is only ever the fix on a host where the platform
 *  default is OFF and the worktree preflight would actually pass. */
function remediation(): string {
  if (process.platform === "darwin") {
    return (
      `Isolation is ON by default on this host (FG-345), so reaching this refusal means\n` +
      `FORGE_WORKTREES is explicitly set to a non-"1" value.\n` +
      `\n` +
      `  unset FORGE_WORKTREES  restore the default so agents work in a task-scoped workspace (the fix)\n` +
      `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
    );
  }
  if (process.platform === "linux") {
    return (
      `Isolation is off by default on a Linux host, and FORGE_WORKTREES=1 will NOT arm it here —\n` +
      `the worktree preflight hard-fails on Linux, permanently by design (forge's orchestrator is\n` +
      `macOS-only; "Linux" in those gates means the agent container).\n` +
      `\n` +
      `  dispatch against a CLONE of the forge checkout instead (the fix)\n` +
      `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
    );
  }
  return (
    `Isolation is off by default on this ${process.platform} host — the platform default is darwin-only.\n` +
    `\n` +
    `  FORGE_WORKTREES=1      arm worktree isolation so agents work in a task-scoped workspace (the fix)\n` +
    `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
  );
}

/** The no-isolation-on-this-path refusal. Naming FORGE_WORKTREES here would be
 *  actively wrong: arming it does not isolate an invoke, so an operator who
 *  followed that advice would land back on the live checkout believing they had
 *  fixed it. The token is deliberately absent from this message. */
function sharedCheckoutRemediation(): string {
  return (
    `\`forge invoke\` dispatches straight at the project mount — it provisions no task-scoped\n` +
    `workspace, so FG-345's default-on isolation does NOT cover this path (that guarantee is a\n` +
    `workflow-dispatch property). This refusal is structural, not a missing flag: arming worktree\n` +
    `isolation would not change what this dispatch mounts.\n` +
    `\n` +
    `  dispatch against a disposable CLONE of the forge checkout instead (the fix)\n` +
    `  FORGE_NO_WORKTREES=1   proceed anyway on the shared checkout (explicit, acknowledged override)`
  );
}

/** Why the identity could not be established, named per side. An unresolvable
 *  SOURCE ROOT is its own loud condition and is stated first: it means the tree
 *  this process is executing from cannot be located, which is a strictly worse
 *  situation than a project path that is merely absent. */
function unprovenDetail(relation: Extract<SelfHostRelation, { kind: "unproven" }>): string {
  const parts: string[] = [];
  if (relation.sourceRoot.kind === "unresolved") {
    parts.push(
      `THE FORGE SOURCE ROOT ITSELF DID NOT RESOLVE (${relation.sourceRoot.reason}).\n` +
        `That is not the ordinary case and it is not this dispatch's fault: assetRoot() names the tree\n` +
        `THIS process is executing from, so an unresolvable answer means the installation moved or was\n` +
        `replaced underneath a running forge — a concurrent \`forge release\` promote swapping the release\n` +
        `tree is the known way to reach it. Nothing can be shown to be outside a tree forge cannot locate.\n` +
        `Re-run once the promote has settled, or reinstall the forge this shell resolves.`
    );
  }
  if (relation.project.kind === "unresolved") {
    parts.push(
      `THE PROJECT PATH DID NOT RESOLVE (${relation.project.reason}).\n` +
        `Check it first: a mistyped path, an already-deleted disposable clone or worktree, and a project\n` +
        `on an unmounted volume all land here. This refusal is about IDENTITY, not existence — but an\n` +
        `existing, readable path is what makes identity provable, so fixing the path clears both.`
    );
  }
  return parts.join(`\n\n`);
}

function refusalMessage(relation: SelfHostRelation, isolation: DispatchIsolation): string {
  const project = describeIdentity(relation.project);
  const sourceRoot = describeIdentity(relation.sourceRoot);
  const paths =
    `  project:            ${project}\n` +
    `  forge source root:  ${sourceRoot}  (the tree this forge is executing)\n`;

  if (relation.kind === "unproven") {
    return (
      `forge: REFUSING to dispatch — self-host overlap could not be RULED OUT: filesystem identity is\n` +
      `unproven (FG-693).\n` +
      paths +
      `\n` +
      `An UNRESOLVED spelling above is printed for diagnosis only; it is not an identity and it decided\n` +
      `nothing here beyond "unproven". An unproven path is NOT evidence of a separate tree, and this guard\n` +
      `fires on it deliberately: what it prevents is agent writes landing in the source tree every forge\n` +
      `process on this host is executing (FG-569), which is not recoverable, and what it costs when it is\n` +
      `wrong is one refused dispatch.\n` +
      `\n` +
      unprovenDetail(relation) +
      `\n` +
      `\n` +
      `  FORGE_NO_WORKTREES=1   proceed anyway, acknowledging the unproven identity (explicit override)`
    );
  }

  const headline =
    isolation === "never-isolated"
      ? `self-host dispatch on a path that provisions no isolated workspace (FG-612)`
      : `self-host dispatch with worktree isolation off (FG-612)`;
  const overlap =
    relation.kind === "overlap" && relation.direction !== "same-tree"
      ? relation.direction === "project-inside-source"
        ? `The project mount is INSIDE the forge source tree.\n`
        : `The project mount CONTAINS the forge source tree.\n`
      : ``;
  return (
    `forge: REFUSING to dispatch — ${headline}.\n` +
    paths +
    overlap +
    `\n` +
    `Agents write into the shared project mount, and forge runs src/ in-process (FG-569) —\n` +
    `a half-written file is immediately live for every forge process on this host.\n` +
    `\n` +
    (isolation === "never-isolated" ? sharedCheckoutRemediation() : remediation())
  );
}

const warned = new Set<string>();

/** Refuse a self-host dispatch unless THIS dispatch actually provisions an
 *  isolated workspace, or the operator has explicitly acknowledged the shared
 *  checkout. Throws — callers must invoke this BEFORE any container starts and
 *  before any run/task row is written; after the first agent file lands the
 *  damage is already done.
 *
 *  `isolation` is the caller's, never inferred: workflow dispatch passes
 *  isWorktreeModeEnabled(), the invoke path passes "never-isolated" because it
 *  mounts args.projectDir whatever the flag resolves to.
 *
 *  Ordering note: the caller's isolation is "not-armed" under
 *  FORGE_NO_WORKTREES=1, so the kill switch is checked on its own AFTER it — the
 *  override proceeds loudly rather than tripping the refusal it exists to
 *  bypass. */
export function assertSelfHostDispatchAllowed(
  projectDir: PathIdentityInput,
  isolation: DispatchIsolation,
  sourceRoot: PathIdentityInput = forgeSourceRootIdentity()
): void {
  const relation = classifySelfHostDispatch(projectDir, sourceRoot);
  if (relation.kind === "distinct") return;
  if (isolation === "isolated") return;

  if (process.env.FORGE_NO_WORKTREES === "1") {
    // The latch key is the IDENTITY's rendering, so one tree spelled two ways
    // warns once — and an unresolved spelling keys on itself, labelled, rather
    // than collapsing into some other unresolved path's slot.
    const key = describeIdentity(relation.project);
    if (!warned.has(key)) {
      warned.add(key);
      process.stderr.write(
        (relation.kind === "unproven"
          ? `forge: WARNING — dispatching against ${key}, whose filesystem identity could not be proven, so ` +
            `forge cannot show it is outside the live forge source (FG-693). Proceeding only because ` +
            `FORGE_NO_WORKTREES=1 acknowledges it. `
          : `forge: WARNING — dispatching against the live forge source at ${key} with worktree isolation ` +
            `disabled (FORGE_NO_WORKTREES=1). `) +
          `Agents are writing to the source tree this forge is executing; ` +
          `partial writes are live for every forge process on this host. ` +
          (isolation === "never-isolated"
            ? `This path provisions no task-scoped workspace at all, so no worktree flag isolates it — ` +
              `dispatch against a disposable CLONE of the forge checkout instead.\n`
            : `On a host where isolation is supported, unset FORGE_NO_WORKTREES (and any explicit ` +
              `FORGE_WORKTREES=0) to isolate instead.\n`)
      );
    }
    return;
  }

  throw new Error(refusalMessage(relation, isolation));
}

/** Test-only: the once-per-project warning latch is process-global. */
export function _resetSelfHostWarnings(): void {
  warned.clear();
}
