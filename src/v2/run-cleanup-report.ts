// FG-677: THE ONE DISPOSITION VOCABULARY for the terminal-run closeout.
//
// This module is DELIBERATELY PURE — no fs, no git, no docker, no store, no tmux.
// It only names the resource classes the closeout reconciles, the disposition each
// per-resource decision carries, and how a decision RENDERS for an operator. Every
// convergence model that ACTS (the git-workspace reaper in reconcile.ts, the
// publication-worktree sweep in integration-publisher.ts, the readiness prune in
// host-readiness-store.ts) stays independently guarded and keeps its own crash-safety
// proof; this module never merges them. It is the single reporting seam they share.
//
// It reuses, rather than duplicates, two existing label sets:
//   * the retain-reason labels the workspace reaper already emits
//     (WorkspaceRetainReason / WorkspaceDeferReason, imported as TYPES so no runtime
//     dependency on the impure worktree-lifecycle module is created), and
//   * the RetentionDisposition surface labels from retention-policy.ts (the pure
//     retention authority), for the "kept inside its diagnostic window" case.
// It EXTENDS them only with the named reasons this ticket requires and no others:
// active_process_cwd, active_mount, ownership_ambiguous, publication_in_flight,
// readiness_live_reader.

import type { RetentionDisposition } from "./retention-policy.js";
import type { WorkspaceRetainReason, WorkspaceDeferReason } from "./worktree-lifecycle.js";

/** The four disposable-artifact families the closeout reconciles. FG-590's tmux
 *  launch sessions and retained task containers are NOT here — they are owned by a
 *  separate closeout and only REPORTED alongside this one (see reportedElsewhere). */
export type ResourceClass =
  | "git_workspace"
  | "generated_branch"
  | "publication_worktree"
  | "readiness_record";

/** What happened (or, on a dry run, what WOULD happen) to one artifact. Deliberately
 *  two values: an artifact is either retired or kept. The dry-run flag on the record
 *  marks the action as a PROPOSAL rather than a performed mutation. */
export type CleanupAction = "removed" | "retained";

/** The reason an artifact was RETAINED. Reuses the reaper's own labels and the
 *  retention-policy surface labels, extended with the ticket's named reasons. Every
 *  value here has an operator-facing recovery action in recoveryForReason(). */
export type CleanupReason =
  // ── reused verbatim from the workspace reaper (worktree-lifecycle.ts) ──
  | WorkspaceRetainReason // uncommitted_work | unmerged_commits | submodules_present |
  //                          private_clone_substrate | unknown_substrate |
  //                          workspace_not_owned | remote_target_uncaptured | removal_failed
  | WorkspaceDeferReason // parent_repacking
  // ── reused from the retention-policy surface vocabulary ──
  | RetentionDisposition // within_retention_for_investigation | expired_eligible | leaked
  // ── the ticket's named retention reasons (the extension) ──
  | "active_process_cwd"
  | "active_mount"
  | "ownership_ambiguous"
  | "publication_in_flight"
  | "readiness_live_reader"
  // ── closeout-local reasons that are not a workspace reaper verdict ──
  | "retained_failure_kind" // the task's failure kind preserves its workspace as evidence
  | "run_not_terminal" // the run is not durably terminal — closeout does not act yet
  | "branch_uncaptured"; // a generated branch whose tip is not proven captured

/** One per-resource disposition record. The shape the ticket specifies —
 *  {path, disposition, reason?, recovery?} — plus the fields the report needs to name
 *  the concrete holder of an active artifact and to distinguish a real pass from a
 *  proposal. */
export type CleanupDisposition = {
  resourceClass: ResourceClass;
  /** The artifact's path (a workspace dir, a publication worktree dir, a readiness
   *  record file) or, for a generated_branch, its ref name. */
  path: string;
  action: CleanupAction;
  /** True when this record is a PROPOSAL from a dry run, not a performed mutation. */
  dryRun?: boolean;
  /** Required when action === "retained": WHY it was kept. */
  reason?: CleanupReason;
  /** For active_process_cwd / active_mount: the live process or container that holds
   *  the artifact, named so the operator can act on the exact holder. */
  holder?: string;
  /** The concrete recovery/archive action for a retained artifact. Filled in by the
   *  record constructors from recoveryForReason(); an operator never has to guess. */
  recovery?: string;
  /** Extra context — a branch name, a substrate, a failure kind — for the timeline. */
  detail?: string;
};

/** The combined report the orchestrator assembles. Each per-resource section is a flat
 *  list of dispositions; sectionErrors carries a per-section failure (a section that
 *  threw is reported, never allowed to abort the others). reportedElsewhere carries the
 *  FG-590 tmux/container summary VERBATIM — it is reported, not re-derived or
 *  re-authorized here. */
export type RunCleanupReport = {
  runId?: string;
  dryRun: boolean;
  gitWorkspaces: CleanupDisposition[];
  generatedBranches: CleanupDisposition[];
  publicationWorktrees: CleanupDisposition[];
  readinessRecords: CleanupDisposition[];
  /** FG-590's disposition, REPORTED not owned: a one-line summary per resource. */
  reportedElsewhere: { launches?: string; containers?: string };
  /** section name → error message, for a section that could not run. */
  sectionErrors: Record<string, string>;
};

/** The concrete recovery/archive action for each retention reason. Pure — a total map
 *  over CleanupReason so no retained artifact is ever rendered without a next step. */
export function recoveryForReason(reason: CleanupReason): string {
  switch (reason) {
    case "uncommitted_work":
      return "Commit, stash, or copy the uncommitted/untracked/ignored files out, then re-run cleanup.";
    case "unmerged_commits":
      return "Merge or publish the branch, or archive its commits (git bundle create), then re-run cleanup.";
    case "remote_target_uncaptured":
      return "Confirm the work reached its remote publish target, then re-run cleanup.";
    case "submodules_present":
      return "The workspace has checked-out submodules holding possibly-unique work; inspect them, then re-run cleanup.";
    case "workspace_not_owned":
      return "Left untouched — forge could not prove it owns this tree. Remove it by hand if you are certain it is disposable.";
    case "unknown_substrate":
      return "forge cannot classify this directory as one of its workspace shapes; inspect it manually.";
    case "private_clone_substrate":
      return "Retained as a private-clone substrate; inspect it manually before removing.";
    case "removal_failed":
      return "Retry cleanup; if it persists, remove the workspace by hand (git worktree remove / rm).";
    case "parent_repacking":
      return "Transient — the parent repository is running git gc; the next cleanup pass retries automatically.";
    case "active_process_cwd":
      return "A live process holds this directory as its working directory; stop it (or cd it elsewhere) before cleanup can remove it.";
    case "active_mount":
      return "A live container has this workspace mounted; stop the container before cleanup can remove it.";
    case "ownership_ambiguous":
      return "No registry row attests forge owns this directory; remove it by hand only if you are certain it is disposable.";
    case "publication_in_flight":
      return "A publication attempt is still in flight or its liveness is ambiguous; retry after it terminalizes.";
    case "readiness_live_reader":
      return "A live dispatch may still consume this readiness record; retry after that dispatch completes.";
    case "within_retention_for_investigation":
      return "Retained inside its diagnostic window for investigation; it retires automatically once the window elapses.";
    case "expired_eligible":
      return "Eligible for routine retirement; the next real cleanup pass removes it.";
    case "leaked":
      return "A successful resource lingering past its prompt window; the next real cleanup pass removes it.";
    case "retained_failure_kind":
      return "Retained because the task's failure kind preserves its workspace as evidence; archive the work, then re-run cleanup.";
    case "run_not_terminal":
      return "The run is not durably terminal yet; cleanup acts only at the terminal boundary.";
    case "branch_uncaptured":
      return "The branch tip is not provably captured by published/merged state; publish or merge it, then re-run cleanup.";
    default:
      // Exhaustiveness guard: a new reason with no recovery action is a compile error.
      return assertNever(reason);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled cleanup reason: ${String(x)}`);
}

/** Construct a REMOVED (or, under dryRun, would-remove) disposition. */
export function removedDisposition(
  resourceClass: ResourceClass,
  path: string,
  opts: { dryRun?: boolean; detail?: string } = {},
): CleanupDisposition {
  return {
    resourceClass,
    path,
    action: "removed",
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  };
}

/** Construct a RETAINED disposition, auto-filling the recovery action from the reason. */
export function retainedDisposition(
  resourceClass: ResourceClass,
  path: string,
  reason: CleanupReason,
  opts: { dryRun?: boolean; holder?: string; detail?: string } = {},
): CleanupDisposition {
  return {
    resourceClass,
    path,
    action: "retained",
    reason,
    recovery: recoveryForReason(reason),
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.holder !== undefined ? { holder: opts.holder } : {}),
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  };
}

/** An empty report skeleton the orchestrator fills in section by section. */
export function emptyRunCleanupReport(opts: { runId?: string; dryRun?: boolean } = {}): RunCleanupReport {
  return {
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    dryRun: !!opts.dryRun,
    gitWorkspaces: [],
    generatedBranches: [],
    publicationWorktrees: [],
    readinessRecords: [],
    reportedElsewhere: {},
    sectionErrors: {},
  };
}

/** All per-resource dispositions across the four owned sections, flattened. */
export function allDispositions(report: RunCleanupReport): CleanupDisposition[] {
  return [
    ...report.gitWorkspaces,
    ...report.generatedBranches,
    ...report.publicationWorktrees,
    ...report.readinessRecords,
  ];
}

/** Render ONE retained artifact as a single operator-facing line: its concrete reason,
 *  exact path, named holder (when any), and recovery action. This is the line the
 *  acceptance criteria require — "the report names the exact reason and path". */
export function formatRetainedDisposition(d: CleanupDisposition): string {
  const verb = d.dryRun ? "would retain" : "retained";
  const holder = d.holder ? ` [held by ${d.holder}]` : "";
  const recovery = d.recovery ?? (d.reason ? recoveryForReason(d.reason) : "");
  const reason = d.reason ?? "unspecified";
  return `  ${verb} ${d.resourceClass} ${d.path} — ${reason}${holder}\n      recover: ${recovery}`;
}

/** Render ONE removed artifact as a single line. */
export function formatRemovedDisposition(d: CleanupDisposition): string {
  const verb = d.dryRun ? "would remove" : "removed";
  const detail = d.detail ? ` (${d.detail})` : "";
  return `  ${verb} ${d.resourceClass} ${d.path}${detail}`;
}

function formatSection(title: string, records: CleanupDisposition[]): string[] {
  if (records.length === 0) return [`${title}: none`];
  const removed = records.filter((r) => r.action === "removed");
  const retained = records.filter((r) => r.action === "retained");
  const lines = [`${title}: ${removed.length} removed, ${retained.length} retained`];
  for (const r of removed) lines.push(formatRemovedDisposition(r));
  for (const r of retained) lines.push(formatRetainedDisposition(r));
  return lines;
}

/** The whole combined report, rendered. Retained artifacts always carry their reason,
 *  path, and recovery; the FG-590 tmux/container disposition is shown as a reported
 *  line, never re-run. */
export function formatRunCleanupReport(report: RunCleanupReport): string {
  const header = report.dryRun
    ? `terminal-run cleanup — DRY RUN (proposal only, no mutation)${report.runId ? ` — run ${report.runId}` : ""}`
    : `terminal-run cleanup${report.runId ? ` — run ${report.runId}` : ""}`;
  const lines: string[] = [header];
  lines.push(...formatSection("git workspaces", report.gitWorkspaces));
  lines.push(...formatSection("generated branches", report.generatedBranches));
  lines.push(...formatSection("publication worktrees", report.publicationWorktrees));
  lines.push(...formatSection("readiness records", report.readinessRecords));
  // FG-590 sections are reported, not owned — one line each, no re-derivation.
  if (report.reportedElsewhere.launches !== undefined) {
    lines.push(`tmux launches (FG-590, reported): ${report.reportedElsewhere.launches}`);
  }
  if (report.reportedElsewhere.containers !== undefined) {
    lines.push(`task containers (FG-590, reported): ${report.reportedElsewhere.containers}`);
  }
  for (const [section, err] of Object.entries(report.sectionErrors)) {
    lines.push(`  section ${section} failed: ${err}`);
  }
  return lines.join("\n");
}
