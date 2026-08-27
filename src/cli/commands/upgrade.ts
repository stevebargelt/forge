import type { Command } from "commander";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  adapterNotInstalledReason,
  adapterOutcomeLines,
  adapterReportLines,
  applyOrchestratorBlock,
  looksLikeForgeProject,
  executeClaudeHooksPlan,
  executeGitignoreEntriesPlan,
  executeHookPlan,
  executedAdapterOverrides,
  executeOperatorAdapters,
  operatorAdapterOverrides,
  planOperatorAdapters,
  skippedClaudeCommands,
  skippedClaudeCommandOutcomes,
  planClaudeHooks,
  planCommitMsgHook,
  planGitignoreEntries,
  warnExecutedAdapterOverrides,
  warnOperatorAdapterOverrides,
  // FG-546: the docs-surfaces detect/create/migrate/preserve/repair helper is
  // shared with `forge init` (step 4) so the two provisioning paths cannot drift.
  // upgrade REQUIRES it: it never re-runs seed provisioning, so correcting the
  // seed + migrating in init alone would leave already-initialized projects
  // (constellation, trakt-letterboxd, forge-scratch-workspace) holding the invalid
  // legacy template forever.
  provisionDocsSurfaces,
  describeDocsSurfacesProvisionPlan,
  docsSurfacesStatusLine,
  docsSurfacesRepairWarning,
  type AdapterDecision,
  type AdapterOutcome,
  type DocsSurfacesProvisionOutcome,
} from "./init.js";
// FG-546: the SINGLE four-way classifier init/upgrade/doctor/dry-run all consume.
// The dry-run forecast reads the verdict directly (no write) so it cannot disagree
// with the real run's provisioning decision.
import { classifyDocsSurfaces, type DocsSurfacesVerdict } from "../../v2/contract.js";
import { compilePolicyFile } from "../../raci/host-policy.js";
import { RACI_PATH, ROUTING_POLICY_PATH } from "../../util/paths.js";
import { buildReleaseReport, summarizeProblems, type ReleaseReport } from "../../v2/release-doctor.js";
import { gatherReleaseInputs } from "./doctor.js";
import { assetRoot, devCheckoutDir, executionMode, type ExecutionMode } from "../../v2/asset-root.js";
import { publishSeedGeneration } from "../../v2/seed-generation.js";
// FG-560: `forge upgrade` is the SOLE authority that migrates model-policy.yml.
// Step 7 COMPOSES evidence-based discovery (step 6) with the per-file
// classifier/writer (step 5): it enumerates the host policy plus every discovered
// project policy, migrates each safely-migratable file ATOMICALLY per-file, and
// leaves unresolved files (needs-human-decision / unreachable / newer-unsupported)
// UNCHANGED. It NEVER routes through loadModelPolicy — that dispatch read path
// refuses a v1 file, but the migrator must READ that same file to repair it.
import {
  discoverModelPolicies,
  type DiscoveredPolicy,
  type PolicyDiscovery,
  type PolicyState,
} from "../../v2/model-policy-discovery.js";
import {
  migrateModelPolicyFile,
  type MigrateIO,
  type MigrationVerdict,
} from "../../v2/model-policy-migration.js";
// FG-776 (FG-767 T3): the ONE-TIME pre-upgrade host-edit backup + completion latch.
// Runs BEFORE install-seeds (step 3) so that once FG-777 flips the operator-authored
// categories to always-FORCE, every operator-edited host seed is already copied to a
// timestamped backup dir before any overwrite is possible. This ticket only backs up
// + reports + latches; the overwrite (and the latch gate) is FG-777.
import {
  runHostEditMigration,
  hostEditMigrationStatusLine,
  type HostEditMigrationOutcome,
} from "../../v2/host-edit-migration.js";

// Wraps the manual upgrade dance: git pull on forge's own repo, refresh
// shared seeds at ~/.forge/, optionally re-init the current project's
// CLAUDE.md with the latest orchestrator template.
//
// Today's flow without this command is:
//   cd ~/code/forge && git pull
//   FORCE=1 scripts/install-seeds.sh
//   cd <each-project> && forge init
//
// With this command:
//   cd <project> && forge upgrade
//   # OR from anywhere with --skip-project
//   forge upgrade --skip-project
//
// FG-577: the command has TWO halves that used to share one predicate.
//   ASSET INSTALL     — reads release-owned bytes from assetRoot() (the tree
//                       this process executes from) and writes only to
//                       $FORGE_HOME / the project. Needs NO dev checkout, and is
//                       therefore reachable on a release host that has none.
//   DEV ADVANCEMENT   — git pull / npm install / image rebuild against
//                       devCheckoutDir(). Refuses in release mode.
// "Am I a release?" and "does a dev checkout exist?" are orthogonal questions;
// answering both with the checkout's existence made the remedy unavailable
// exactly in the state it exists to repair.

/** FG-577: every release-owned asset upgrade installs, resolved from ONE root.
 *  Re-pointing the seed installer while leaving the template on dev bytes is the
 *  named partial fix — both live here so they cannot drift apart. */
export function upgradeAssetPaths(assetsDir: string = assetRoot()): { installScript: string; templatePath: string } {
  return {
    installScript: join(assetsDir, "scripts", "install-seeds.sh"),
    templatePath: join(assetsDir, "seeds", "orchestrator-template.md"),
  };
}

/** FG-578: install-seeds.sh's machine-readable retention record — one
 *  `Retained: <path> (…)` line per file it declined to write because the operator
 *  owns it, with the path relative to $FORGE_HOME (the same key seed-drift.ts
 *  reports drift under). Returns null for every other line. The installer is the
 *  authority on what it retained; upgrade REPORTS that answer and never
 *  re-derives one, which is the whole reason the policy lives in the writer. */
export function parseRetainedLine(line: string): string | null {
  const m = /^Retained: (\S+) /.exec(line);
  return m ? m[1]! : null;
}

/** The refusal register: name what disagreed, name both sides, say why
 *  reconciliation is not offered, end actionable. The manual steps are spelled
 *  out because `forge-dev` may not exist as a runnable command on this host —
 *  naming a remedy the operator cannot run is the same availability defect in
 *  miniature. */
export function refuseDevAdvance(action: string, assetsDir: string, devDir: string): string[] {
  return [
    `forge upgrade: refusing to ${action} — this forge is executing from a promoted release.`,
    `  executing release: ${assetsDir}`,
    `  dev checkout:      ${devDir}`,
    `Reconciliation is not offered: a release carries no git history to pull into, and advancing`,
    `the checkout would mutate a tree this process is not executing from.`,
    `Host seeds and the project template are refreshed from the executing release regardless —`,
    `that half needs no checkout and runs in this same command (steps [3/4] and [4/4]).`,
    `To advance the dev checkout, drive it from the checkout itself:`,
    `  forge-dev upgrade --skip-project`,
    `  # or, directly:`,
    `  cd ${devDir} && git pull && npm install`,
  ];
}

export type DevAdvanceDecision =
  | { kind: "proceed" }
  | { kind: "not-requested" }
  | { kind: "refused"; lines: string[] }
  | { kind: "missing"; lines: string[] };

/** Decides ONLY whether the dev checkout may be advanced. Asset installation
 *  never consults this. In release mode the refusal is returned before any
 *  filesystem access, so the operator sees the named contract error rather than
 *  an EACCES from the release freeze or a stat of a checkout that isn't there. */
export function decideDevAdvancement(
  mode: ExecutionMode,
  assetsDir: string,
  devDir: string,
  skips: { skipGit?: boolean; skipNpm?: boolean } = {},
  exists: (p: string) => boolean = existsSync,
): DevAdvanceDecision {
  // FG-577 — skip → mode → filesystem, the same ordering `maybeRebuildImage`
  // obeys. An operator skip outranks BOTH: you cannot refuse, nor go looking for,
  // advancement that was never requested. This check sat INSIDE the release
  // branch, which got the refusal right and left dev reporting a missing checkout
  // for steps the operator had explicitly declined.
  if (skips.skipGit && skips.skipNpm) return { kind: "not-requested" };
  if (mode === "release") {
    // Still ahead of every filesystem access — a release that IS asked to advance
    // keeps the named contract error rather than an EACCES.
    return { kind: "refused", lines: refuseDevAdvance("advance the dev checkout (git pull / npm install)", assetsDir, devDir) };
  }
  if (!exists(devDir)) {
    return {
      kind: "missing",
      lines: [
        `forge repo not found at ${devDir}`,
        `Set FORGE_REPO_DIR or pass --forge-repo to point at your local forge checkout.`,
      ],
    };
  }
  return { kind: "proceed" };
}

// FG-577 (criterion 10): the default is INVERTED here. `unresolved` used to be
// built by three hand-enumerated pushes testing specific literals, so every state
// nobody thought to name defaulted to resolved = silent success — a fail-OPEN
// allowlist that two successive review rounds each patched by adding one more
// literal. Instead: every step reports a typed outcome, and ONE total function
// classifies EVERY variant. A new variant with no classification is a `tsc`
// error, not a silent exit 0.

export type GitPullOutcome =
  | "pulled"
  | "would-pull"
  | "no-remote"
  | "skipped"
  | "unavailable"
  | "refused"
  | "dirty"
  | "failed";

export type NpmInstallOutcome =
  | "installed"
  | "would-install"
  | "no-package-json"
  | "skipped"
  | "unavailable"
  | "refused"
  | "failed";

export type AssetInstallOutcome = "installed" | "would-install" | "not-found" | "failed";

// FG-583: the atomic seed-generation publication — the forge-owned, dispatch-coupled
// surface (workflows, runtimes, derived routing policy) committed as ONE generation
// by a single rename(2) over the seed pointer. `failed` is a NAMED, repairable
// partial-install state: the prior generation stays intact and selectable, but this
// upgrade did not publish a new complete one.
export type SeedGenerationOutcome = "published" | "would-publish" | "not-run" | "failed";

/** FG-578: what install-seeds.sh declined to write because the operator owns it.
 *  `not-run` is not "nothing was retained" — it is "the installer never ran, so
 *  nobody looked". Collapsing the two would report a clean ownership picture for
 *  a host this upgrade never touched. */
export type AuthoredRetentionOutcome = "none" | "retained" | "not-run";

// FG-560: the fleet-level model-policy migration outcome. Aggregated from the
// per-file reports below, but atomicity is PER-FILE (never a cross-fleet
// transaction): a fleet where some migrate and others are unreachable is the
// expected steady state, reported per-file, never rolled back as a unit.
//   none            no policy file discovered anywhere.
//   all-current     every discovered policy is already schema_version 2.
//   migrated        ≥1 file was migrated (real run); nothing needs a human.
//   would-migrate   dry-run forecast: ≥1 file WOULD migrate; nothing needs a human.
//   action-required ≥1 file needs a human / is unreachable / is newer-unsupported —
//                   left UNCHANGED, so the overall result is NON-SUCCESS.
//   failed          a discovered file could not be migrated (write/parse failure) —
//                   the original was left intact.
//   not-run         the migration step did not run.
export type ModelPolicyMigrationOutcome =
  | "none"
  | "all-current"
  | "migrated"
  | "would-migrate"
  | "action-required"
  | "failed"
  | "not-run";

/** The per-file action, derived from the discovery state + the ONE migration
 *  verdict. `migrated`/`would-migrate` differ ONLY on dry-run — both key off the
 *  same verdict, so the dry-run forecast matches the real run file-for-file. */
export type ModelPolicyFileAction =
  | "migrated"
  | "would-migrate"
  | "current"
  | "needs-human-decision"
  | "newer-unsupported"
  | "unreachable"
  | "no-policy"
  | "known-no-path"
  | "failed";

/** One discovered policy's migration report. This is the per-file classification a
 *  script reads from --json AND the human summary renders — one source, so they
 *  cannot disagree. */
export interface ModelPolicyFileReport {
  scope: "host" | "project";
  projectDir: string | null;
  policyPath: string | null;
  discoveryState: PolicyState;
  /** The step-5 verdict when the file was inspected (has-policy); null otherwise. */
  verdict: MigrationVerdict | null;
  action: ModelPolicyFileAction;
  detail: string | null;
}

// FG-581: `failed` and `failed-not-neutralized` are BOTH compile failures, split
// on whether the stale policy could be taken off disk. `failed` = neutralized
// (quarantined or removed) → routing is genuinely fail-closed. `failed-not-neutralized`
// = the double-failure path (rename AND unlink threw), so the stale policy is STILL
// authoritative under the promoted runtime and routing is NOT fail-closed until an
// operator removes it by hand. The two must not collapse to one reason string.
export type RoutingPolicyOutcome =
  | "recompiled"
  | "would-recompile"
  | "no-raci"
  | "failed"
  | "failed-not-neutralized";

export type ProjectInitOutcome =
  | "refreshed"
  | "already-current"
  | "would-refresh"
  | "skipped"
  | "no-claude-md"
  | "no-forge-block"
  | "template-not-found"
  | "needs-markers";

export type ImageRebuildOutcome = "ran" | "would-rebuild" | "skipped" | "refused" | "failed";

export type SlashCommandsOutcome =
  | "installed"
  | "already-current"
  | "would-install"
  | "user-override"
  | "not-run";

/** FG-253 step 5: the WHOLE project-scoped adapter file set — Claude commands AND
 *  Codex skills — as its own reported step, so an EXISTING project is updated by
 *  `forge upgrade` and not only by `forge init`. Same five states `slashCommands`
 *  has, because they are the same five facts about a file set; the two are
 *  computed from disjoint reads of one plan (see `classifyAdapterEntries`) rather
 *  than one being inferred from the other. */
export type AdapterSurfacesOutcome =
  | "installed"
  | "already-current"
  | "would-install"
  | "user-override"
  | "not-run";

export type ReleaseCheckOutcome = "ran" | "skipped-dry-run" | "skipped-asset-install" | "failed";

// FG-546: the docs-surfaces provisioning outcome, reported inside the [4/4]
// project-init block (NOT its own numbered step — it is project config, distinct
// from the host-seed cache at [3/4]). One variant per verdict-driven action, plus
// the dry-run forecasts and `not-run` (project init did not run at all). The write
// keys off the four-way verdict, never bare file existence, so a customized file
// (valid OR invalid) is never mistaken for the generated template and never
// clobbered.
//   created / migrated / preserved            — the real-run write outcomes
//   would-create / would-migrate              — dry-run forecasts of a real write
//   requires-operator-repair                  — customized-invalid: LEFT UNTOUCHED,
//                                                warned (dry + real share it: no
//                                                write happens on either path)
//   seed-missing                              — forge's own seed is absent, so it
//                                                could not provision (a forge-install
//                                                defect, like a missing template)
//   not-run                                   — the [4/4] block did not run
export type DocsSurfacesOutcome =
  | "created"
  | "migrated"
  | "preserved"
  | "would-create"
  | "would-migrate"
  | "requires-operator-repair"
  | "seed-missing"
  | "not-run";

/** Map the real-run provision outcome onto the reported step outcome. Total over
 *  DocsSurfacesProvisionOutcome, so a new provision action breaks this switch. */
function docsSurfacesOutcomeOf(o: DocsSurfacesProvisionOutcome): DocsSurfacesOutcome {
  switch (o.action) {
    case "created":                  return "created";
    case "migrated":                 return "migrated";
    case "preserved":                return "preserved";
    case "requires-operator-repair": return "requires-operator-repair";
    case "seed-missing":             return "seed-missing";
  }
}

/** The dry-run forecast, from the SAME verdict the real run keys off — so the
 *  forecast cannot disagree with what the run then does. A `valid-project` (incl.
 *  the corrected generated form) is a no-op ⇒ `preserved`; `customized-invalid`
 *  is left untouched on both paths ⇒ the shared repair outcome. */
function docsSurfacesDryRunOutcome(verdict: DocsSurfacesVerdict): DocsSurfacesOutcome {
  switch (verdict) {
    case "missing":                 return "would-create";
    case "known-legacy-generated":  return "would-migrate";
    case "valid-project":           return "preserved";
    case "customized-invalid":      return "requires-operator-repair";
  }
}

export type UpgradeStepOutcomes = {
  gitPull: GitPullOutcome;
  npmInstall: NpmInstallOutcome;
  assetInstall: AssetInstallOutcome;
  hostEditMigration: HostEditMigrationOutcome;
  seedGeneration: SeedGenerationOutcome;
  modelPolicy: ModelPolicyMigrationOutcome;
  authoredRetention: AuthoredRetentionOutcome;
  routingPolicy: RoutingPolicyOutcome;
  projectInit: ProjectInitOutcome;
  docsSurfaces: DocsSurfacesOutcome;
  slashCommands: SlashCommandsOutcome;
  adapterSurfaces: AdapterSurfacesOutcome;
  imageRebuild: ImageRebuildOutcome;
  releaseCheck: ReleaseCheckOutcome;
};

/** One `{ step, outcome }` variant per field above, derived rather than
 *  hand-written: a new step field widens this union, which breaks the `never`
 *  check in `classifyStep`. */
export type UpgradeStep = {
  [K in keyof UpgradeStepOutcomes]: { step: K; outcome: UpgradeStepOutcomes[K] };
}[keyof UpgradeStepOutcomes];

export type Resolution = { kind: "resolved" } | { kind: "unresolved"; reason: string };

const resolved: Resolution = { kind: "resolved" };
const unresolvedBecause = (reason: string): Resolution => ({ kind: "unresolved", reason });

// `Record<Union, Resolution>` is what inverts the default: an object literal must
// name EVERY variant, so adding one to an outcome union above stops this file
// compiling until it is classified. Omitting a key, or classifying a variant that
// does not exist, is equally a type error.

const GIT_PULL: Record<GitPullOutcome, Resolution> = {
  pulled: resolved,
  "would-pull": resolved,
  "no-remote": resolved,
  skipped: resolved,
  unavailable: resolved,
  refused: unresolvedBecause("git pull refused (release)"),
  // The operator asked for advancement and did not get it. A dirty tree is not
  // an operator-requested skip, and calling it one is how this read as success.
  dirty: unresolvedBecause("git pull did not run — the dev checkout has uncommitted changes"),
  failed: unresolvedBecause("git pull FAILED"),
};

const NPM_INSTALL: Record<NpmInstallOutcome, Resolution> = {
  installed: resolved,
  "would-install": resolved,
  "no-package-json": resolved,
  skipped: resolved,
  unavailable: resolved,
  refused: unresolvedBecause("npm install refused (release)"),
  failed: unresolvedBecause("npm install FAILED"),
};

const ASSET_INSTALL: Record<AssetInstallOutcome, Resolution> = {
  installed: resolved,
  "would-install": resolved,
  "not-found": unresolvedBecause("install-seeds.sh NOT FOUND — host seeds were not refreshed"),
  failed: unresolvedBecause("install-seeds.sh FAILED"),
};

// FG-776: the pre-upgrade host-edit backup. Every terminal state EXCEPT `failed`
// is the step working — a real run that backed up (or found nothing to back up),
// a dry-run forecast, or `not-run` when there are no release seeds to compare
// against (the asset-install not-found outcome already makes THAT run unresolved).
// `failed` is unresolved: operator-edited host seeds were NOT backed up, so the
// exit code / --json / closing line all say so and a forced seed refresh must not
// proceed until it succeeds. It never hard-blocks the rest of the upgrade (AC5).
const HOST_EDIT_MIGRATION: Record<HostEditMigrationOutcome, Resolution> = {
  "backed-up": resolved,
  "nothing-to-back-up": resolved,
  "would-back-up": resolved,
  "would-note": resolved,
  "not-run": resolved,
  failed: unresolvedBecause(
    "pre-upgrade host-edit backup FAILED — operator-edited host seeds were NOT backed up; a forced seed refresh (FG-777) must not proceed until this succeeds (re-run forge upgrade)",
  ),
};

// FG-583: a failed atomic publication is a NAMED, repairable partial-install state —
// unresolved, so the exit code / --json / closing line all report it and doctor +
// dispatch preflight refuse to run under it, rather than reporting healthy.
const SEED_GENERATION: Record<SeedGenerationOutcome, Resolution> = {
  published: resolved,
  "would-publish": resolved,
  "not-run": resolved,
  failed: unresolvedBecause("seed generation NOT PUBLISHED — the atomic host-seed publication failed; the prior generation is intact but this release's seeds are not the active generation (forge upgrade to retry)"),
};

// FG-578: forge declining to overwrite a file the operator AUTHORS is the
// command working — the identical reasoning SLASH_COMMANDS states below, applied
// to the same shape of fact. Classifying retention `unresolved` would fire exit 1
// forever on every host whose operator has ever run `forge raci apply`, i.e.
// punish the supported, audited workflow with a permanent red light — which is
// not a signal, it is noise that trains operators to ignore the exit code.
//
// It is still a state a script must be able to SEE. That is what this step plus
// the named `authoredRetentions` list are for; the human ⚠ says the same thing.
// Resolved means "forge did what it should", never "nothing to know".
const AUTHORED_RETENTION: Record<AuthoredRetentionOutcome, Resolution> = {
  none: resolved,
  retained: resolved,
  "not-run": resolved,
};

// FG-560: a migrated / would-migrate / already-current / nothing-found fleet is the
// command working — resolved. `action-required` is unresolved because a file was
// LEFT UNCHANGED that a human (or a newer forge) must resolve, and `failed` is
// unresolved because a discovered file could not be repaired (its original is
// intact, but the policy is still not current). Both flow into the exit code, the
// closing line, and --json from this ONE table. Mirrors the docs-surfaces split:
// the would-* forecasts are resolved exactly as their real-run counterparts are, so
// dry-run and real run agree.
const MODEL_POLICY: Record<ModelPolicyMigrationOutcome, Resolution> = {
  none: resolved,
  "all-current": resolved,
  migrated: resolved,
  "would-migrate": resolved,
  "action-required": unresolvedBecause(
    "model-policy migration: one or more policies were left unchanged and still need attention (needs-human-decision / newer-unsupported / unreachable) — resolve them and re-run forge upgrade",
  ),
  failed: unresolvedBecause(
    "model-policy migration: a discovered policy could not be migrated — its original was left intact; see the warning above",
  ),
  "not-run": resolved,
};

const ROUTING_POLICY: Record<RoutingPolicyOutcome, Resolution> = {
  recompiled: resolved,
  "would-recompile": resolved,
  "no-raci": resolved,
  // FG-581: fail-closed. The previous runtime's compiled routing-policy.yml is
  // NOT left silently authoritative when the promoted runtime rejects the host
  // RACI it derives from — it is invalidated (quarantined) at the failure site, so
  // routing falls back to fail-closed (lane 'manual' / `policy_not_found`) until
  // the RACI compiles. The named refusal, not a stale policy that keeps routing.
  failed: unresolvedBecause(`routing-policy.yml INVALIDATED — the promoted runtime rejected the host RACI; the stale policy was neutralized (quarantined or removed) and routing is fail-closed until the RACI compiles (fix ${RACI_PATH}, then run: forge route compile)`),
  // The double-failure path: the RACI was rejected AND neither rename nor unlink
  // could take the stale policy off disk. It is STILL authoritative under the
  // promoted runtime — routing is NOT fail-closed. Say that, not the opposite.
  "failed-not-neutralized": unresolvedBecause(`routing-policy.yml STILL AUTHORITATIVE — the promoted runtime rejected the host RACI but the stale policy could NOT be neutralized on disk; routing is NOT fail-closed. Remove it by hand (rm ${ROUTING_POLICY_PATH}), then fix ${RACI_PATH} and run: forge route compile`),
};

const PROJECT_INIT: Record<ProjectInitOutcome, Resolution> = {
  refreshed: resolved,
  "already-current": resolved,
  "would-refresh": resolved,
  skipped: resolved,
  "no-claude-md": unresolvedBecause("project init did not run — no CLAUDE.md here"),
  "no-forge-block": unresolvedBecause("project init did not run — CLAUDE.md has no forge orchestrator block"),
  "template-not-found": unresolvedBecause("orchestrator block NOT refreshed — template missing from the executing tree"),
  "needs-markers": unresolvedBecause("orchestrator block NOT refreshed — needs manual markers"),
};

// FG-546: create / migrate / preserve are the command working; the dry-run
// forecasts of a real write likewise. `requires-operator-repair` is RESOLVED for
// the same reason `user-override` (slash commands / adapters) is: forge declining
// to overwrite a file it does not own is the command working, and an exit code
// that fires forever on every project holding a hand-authored docs-surfaces file
// is noise, not signal — the never-clobber guarantee is upheld, and the actionable
// ⚠ (named file + validation error + repair) is where the operator SEES it. It is
// symmetric with `forge init`, which warns without failing. `seed-missing` IS
// unresolved: forge's own bundled seed is absent, so it could not provision —
// the same class of forge-install defect as `template-not-found`.
const DOCS_SURFACES: Record<DocsSurfacesOutcome, Resolution> = {
  created: resolved,
  migrated: resolved,
  preserved: resolved,
  "would-create": resolved,
  "would-migrate": resolved,
  "requires-operator-repair": resolved,
  "seed-missing": unresolvedBecause("docs-surfaces NOT provisioned — forge's bundled docs-surfaces.example.yml seed was not found in the executing tree"),
  "not-run": resolved,
};

// A project-local override is the PROJECT's standing answer, not a failed
// request: forge declining to clobber a file it does not own is the command
// working. So it is resolved — an exit code that fires forever on every project
// that deliberately owns its own /orient is not a signal. It is still a state a
// script must be able to SEE, which is what `slashCommands` + the named
// `slashCommandOverrides` list are for; the human ⚠ says the same thing.
const SLASH_COMMANDS: Record<SlashCommandsOutcome, Resolution> = {
  installed: resolved,
  "already-current": resolved,
  "would-install": resolved,
  "user-override": resolved,
  "not-run": resolved,
};

// FG-253 step 5: the same reasoning SLASH_COMMANDS states, applied to the whole
// adapter set. A project override is RESOLVED — forge declining to clobber a file
// it does not own is the command working, and an exit code that fires forever on
// every project that owns its own /orient is noise, not signal. Seeing it is what
// `adapterSurfaces` + the named `adapterOverrides` list are for.
const ADAPTER_SURFACES: Record<AdapterSurfacesOutcome, Resolution> = {
  installed: resolved,
  "already-current": resolved,
  "would-install": resolved,
  "user-override": resolved,
  "not-run": resolved,
};

const IMAGE_REBUILD: Record<ImageRebuildOutcome, Resolution> = {
  ran: resolved,
  "would-rebuild": resolved,
  skipped: resolved,
  refused: unresolvedBecause("image rebuild refused (release)"),
  failed: unresolvedBecause("image rebuild FAILED"),
};

const RELEASE_CHECK: Record<ReleaseCheckOutcome, Resolution> = {
  ran: resolved,
  "skipped-dry-run": resolved,
  // The asset install is already unresolved on this path; the tail not running is
  // the honest consequence, not a second failure.
  "skipped-asset-install": resolved,
  failed: unresolvedBecause("release check FAILED — this host's readiness is unverified"),
};

/** The ONE total function every consumer surface derives from. Total in both
 *  dimensions: over the steps (the `never` check) and over each step's variants
 *  (the `Record` tables). */
export function classifyStep(step: UpgradeStep): Resolution {
  switch (step.step) {
    case "gitPull": return GIT_PULL[step.outcome];
    case "npmInstall": return NPM_INSTALL[step.outcome];
    case "assetInstall": return ASSET_INSTALL[step.outcome];
    case "hostEditMigration": return HOST_EDIT_MIGRATION[step.outcome];
    case "seedGeneration": return SEED_GENERATION[step.outcome];
    case "modelPolicy": return MODEL_POLICY[step.outcome];
    case "authoredRetention": return AUTHORED_RETENTION[step.outcome];
    case "routingPolicy": return ROUTING_POLICY[step.outcome];
    case "projectInit": return PROJECT_INIT[step.outcome];
    case "docsSurfaces": return DOCS_SURFACES[step.outcome];
    case "slashCommands": return SLASH_COMMANDS[step.outcome];
    case "adapterSurfaces": return ADAPTER_SURFACES[step.outcome];
    case "imageRebuild": return IMAGE_REBUILD[step.outcome];
    case "releaseCheck": return RELEASE_CHECK[step.outcome];
    default: {
      const unhandled: never = step;
      return unhandled;
    }
  }
}

/** Enumerated from the object's own keys, so a newly added step is classified by
 *  construction rather than by remembering to list it here. */
export function unresolvedReasons(outcomes: UpgradeStepOutcomes): string[] {
  const reasons: string[] = [];
  for (const step of Object.keys(outcomes) as (keyof UpgradeStepOutcomes)[]) {
    const res = classifyStep({ step, outcome: outcomes[step] } as UpgradeStep);
    if (res.kind === "unresolved") reasons.push(res.reason);
  }
  return reasons;
}

/** FG-253 step 5: classify ONE surface's planned decisions.
 *
 *  Called once per reported surface over that surface's OWN entries, never over a
 *  superset: `slashCommands` reads the claude-command entries and
 *  `adapterSurfaces` reads all of them, so a Codex skill a project overrides can
 *  no longer make the slash-command step report an override that never touched a
 *  slash command — nor the reverse. Before this, `slashCommands` mixed the
 *  Claude-only override list with the WHOLE plan's action, which is exactly that
 *  cross-surface inference.
 *
 *  An empty entry list is `not-run`, not `already-current`: nobody looked. An
 *  override outranks the rest because it is the state an operator must SEE. */
export function classifyAdapterEntries(
  entries: readonly { decision: AdapterDecision }[],
  dryRun: boolean,
): AdapterSurfacesOutcome {
  if (entries.length === 0) return "not-run";
  if (entries.some((e) => e.decision === "override")) return "user-override";
  if (entries.every((e) => e.decision === "already-current")) return "already-current";
  return dryRun ? "would-install" : "installed";
}

/** The same classification for a run that EXECUTED, read off what it did rather than
 *  off the plan it started from.
 *
 *  A plan is a forecast, and this step is the operator's evidence that forge did not
 *  clobber their file — so on a real run it must come from the outcomes. The two
 *  disagree exactly where it matters: a target that became somebody's between the plan
 *  and the write is `skipped-changed`, which the plan still calls an install. Both
 *  not-installed shapes land on `user-override`, the state that outranks the rest
 *  because it is the one an operator must SEE. */
export function classifyAdapterOutcomes(outcomes: readonly AdapterOutcome[]): AdapterSurfacesOutcome {
  if (outcomes.length === 0) return "not-run";
  if (executedAdapterOverrides(outcomes).length > 0) return "user-override";
  if (outcomes.every((o) => o.applied === "unchanged")) return "already-current";
  return "installed";
}

// ── FG-560 (step 7): the discovery × per-file migration composition ──────────────

/** Map a single discovered policy to its migration report. The SAME verdict drives
 *  dry-run and real run — only `migrated` vs `would-migrate` differs — so the
 *  forecast matches the applied result file-for-file. A has-policy file is migrated
 *  ATOMICALLY (per the step-5 writer); every other discovery state is reported
 *  as-is and never written. */
function reportForDiscoveredPolicy(
  d: DiscoveredPolicy,
  dryRun: boolean,
  io?: MigrateIO,
): ModelPolicyFileReport {
  const base = {
    scope: d.scope,
    projectDir: d.projectDir,
    policyPath: d.policyPath,
    discoveryState: d.state,
    verdict: null as MigrationVerdict | null,
    detail: null as string | null,
  };
  switch (d.state) {
    case "reachable-no-policy":
      return { ...base, action: "no-policy" };
    case "known-but-no-path":
      return { ...base, action: "known-no-path" };
    case "unreachable-deleted":
      return {
        ...base,
        action: "unreachable",
        detail: "recorded checkout no longer resolves — cannot inspect or migrate its policy",
      };
    case "has-policy": {
      try {
        const res = migrateModelPolicyFile(d.policyPath!, { dryRun, io });
        const v = res.migration.verdict;
        let action: ModelPolicyFileAction;
        if (v === "current") action = "current";
        else if (v === "needs-human-decision") action = "needs-human-decision";
        else if (v === "newer-unsupported") action = "newer-unsupported";
        else action = dryRun ? "would-migrate" : "migrated"; // migratable | changed-if-applied
        return { ...base, verdict: v, action, detail: modelPolicyDetail(res.migration.verdict, res.migration) };
      } catch (e) {
        return { ...base, action: "failed", detail: (e as Error).message };
      }
    }
  }
}

/** A short, per-file human detail: which aliases were/would be added, or which
 *  mappings need a human. Null when there is nothing extra to say. */
function modelPolicyDetail(
  verdict: MigrationVerdict,
  m: { additions: { target: string; dest: string }[]; humanDecisions: { target: string; dest: string }[] },
): string | null {
  if (verdict === "needs-human-decision") {
    return `unresolved: ${m.humanDecisions.map((h) => `${h.target}.${h.dest}`).join(", ")}`;
  }
  if (verdict === "migratable" || verdict === "changed-if-applied") {
    if (m.additions.length === 0) return null;
    return `adds ${m.additions.map((a) => `${a.target}.${a.dest}`).join(", ")}`;
  }
  return null;
}

/** Aggregate the per-file reports into ONE fleet outcome, in priority order:
 *  failed > action-required > migrated > would-migrate > all-current > none. */
export function aggregateModelPolicyOutcome(files: ModelPolicyFileReport[]): ModelPolicyMigrationOutcome {
  if (files.some((f) => f.action === "failed")) return "failed";
  if (files.some((f) => f.action === "needs-human-decision" || f.action === "newer-unsupported")) {
    return "action-required";
  }
  if (files.some((f) => f.action === "migrated")) return "migrated";
  if (files.some((f) => f.action === "would-migrate")) return "would-migrate";
  if (files.some((f) => f.action === "current")) return "all-current";
  return "none";
}

/** Compose discovery with the per-file migration: enumerate the host + every
 *  discovered project policy, migrate each safely-migratable file atomically, leave
 *  the rest untouched. Discovery is best-effort/historical — this reports which
 *  policies were inspected and never mutates or prunes the registry. */
export function migrateDiscoveredPolicies(
  discovery: PolicyDiscovery,
  dryRun: boolean,
  io?: MigrateIO,
): { outcome: ModelPolicyMigrationOutcome; files: ModelPolicyFileReport[] } {
  const files = [discovery.host, ...discovery.projects].map((d) => reportForDiscoveredPolicy(d, dryRun, io));
  return { outcome: aggregateModelPolicyOutcome(files), files };
}

/** The one-line fleet summary — counts by action, honest that discovery is
 *  historical/best-effort (it never claims fleet-wide completeness). */
function summarizeModelPolicies(files: ModelPolicyFileReport[], dryRun: boolean): string {
  const n = (a: ModelPolicyFileAction) => files.filter((f) => f.action === a).length;
  const parts: string[] = [];
  const migrated = dryRun ? n("would-migrate") : n("migrated");
  if (migrated > 0) parts.push(`${migrated} ${dryRun ? "would migrate" : "migrated"}`);
  if (n("current") > 0) parts.push(`${n("current")} already current`);
  if (n("needs-human-decision") > 0) parts.push(`${n("needs-human-decision")} need human decision`);
  if (n("newer-unsupported") > 0) parts.push(`${n("newer-unsupported")} newer-unsupported`);
  if (n("unreachable") > 0) parts.push(`${n("unreachable")} unreachable`);
  if (n("failed") > 0) parts.push(`${n("failed")} failed`);
  if (n("no-policy") + n("known-no-path") > 0) parts.push(`${n("no-policy") + n("known-no-path")} no policy`);
  const body = parts.length > 0 ? parts.join(", ") : "nothing discovered";
  return `${body} (historical/best-effort discovery — not a fleet-completeness claim)`;
}

export type UpgradeOptions = {
  dryRun?: boolean;
  skipGit?: boolean;
  skipNpm?: boolean;
  skipProject?: boolean;
  forgeRepo?: string;
  rebuildImage?: boolean;
  json?: boolean;
};

/** FG-577: the machine-readable face of the SAME states the human output and the
 *  exit code are rendered from. A refusal an operator can read but a script
 *  cannot is a refusal half the consumers miss — `unresolved` is the one list all
 *  three surfaces derive from, so they cannot disagree about whether this upgrade
 *  did what was asked. */
export type UpgradeResult = {
  ok: boolean;
  dryRun: boolean;
  mode: ExecutionMode;
  assetsDir: string;
  devDir: string;
  devAdvancement: {
    kind: DevAdvanceDecision["kind"];
    lines: string[];
    gitPull: GitPullOutcome;
    npmInstall: NpmInstallOutcome;
  };
  assetInstall: AssetInstallOutcome;
  /** FG-776: the ONE-TIME pre-upgrade host-edit backup outcome — flows into
   *  `unresolved` only on `failed`. */
  hostEditMigration: HostEditMigrationOutcome;
  /** FG-776: the timestamped dir this run wrote every divergent host file to
   *  (null when nothing diverged, on dry-run, or when the step did not run). */
  hostEditBackupDir: string | null;
  /** FG-776: the host files (paths relative to $FORGE_HOME) backed up this run. */
  hostEditBackedUp: string[];
  /** FG-776: the loud two-case reinstate report (added vs edited) — the SAME lines
   *  the human warning prints, so a --json consumer reads the same guidance. */
  hostEditReport: string[];
  /** FG-776: the completion-latch path FG-777 gates on — written whenever this
   *  step runs (even with nothing to back up), so FG-777's always-upgrade may
   *  proceed only after this migration has had its chance to back edits up. */
  hostEditLatchPath: string;
  /** FG-583: the atomic seed-generation publication outcome. On `failed` the
   *  `seedGenerationError` names the exact reason; a partial install is never
   *  reported healthy — this outcome flows into `unresolved`, the exit code, and
   *  the doctor / dispatch preflight refusal. */
  seedGeneration: SeedGenerationOutcome;
  /** FG-583: the publication's verbatim failure reason, or null on any non-failure
   *  path. Threaded onto --json so a script reads the same named refusal the human
   *  warning prints. */
  seedGenerationError: string | null;
  /** FG-560: the fleet-level model-policy migration outcome — flows into
   *  `unresolved`, the exit code, and the closing line. */
  modelPolicy: ModelPolicyMigrationOutcome;
  /** FG-560: the per-file migration classification a script reads — the SAME
   *  reports the human summary renders, so the two cannot disagree. One entry per
   *  discovered policy (host + every discovered project). */
  modelPolicies: ModelPolicyFileReport[];
  authoredRetention: AuthoredRetentionOutcome;
  /** FG-578: the seed files forge did NOT overwrite because the OPERATOR authors
   *  them (forge-raci.md, agents/, constraints/) and their copy diverges from
   *  this release's seed — paths relative to $FORGE_HOME. Machine-readable for
   *  exactly the reason `slashCommandOverrides` is: a state only a human can read
   *  is a state half the consumers miss. Informational, never a failure — but it
   *  is the ONLY place this upgrade admits those files are running unrefreshed. */
  authoredRetentions: string[];
  routingPolicy: RoutingPolicyOutcome;
  /** FG-581: on a post-promotion compile FAILURE, the compiler's verbatim reason
   *  for the rejected RACI construct — the same string the human warning carries,
   *  so a --json consumer reads the exact named refusal rather than the generic
   *  classification reason. Null on every non-failure path. */
  routingPolicyError: string | null;
  projectInit: ProjectInitOutcome;
  /** FG-546: the docs-surfaces provisioning outcome for the project's own
   *  .forge/docs-surfaces.yml — created / migrated / preserved / (dry-run) would-*
   *  / requires-operator-repair / seed-missing / not-run. Reported alongside the
   *  [4/4] project init; distinct from the host-seed cache ([3/4]). */
  docsSurfaces: DocsSurfacesOutcome;
  /** FG-546: on `requires-operator-repair` (a customized-invalid file forge left
   *  untouched), the actionable warning naming the file + validation error +
   *  repair action — the SAME text the human ⚠ prints, so a --json consumer reads
   *  the same named guidance. Null on every other path. */
  docsSurfacesRepair: string | null;
  slashCommands: SlashCommandsOutcome;
  /** The commands forge did NOT install because the project already owns that
   *  path — the same set the human ⚠ names, so a script sees it too. */
  slashCommandOverrides: string[];
  /** FG-253 step 5: the same fact for the WHOLE adapter set, Codex skills
   *  included. Reported alongside `slashCommandOverrides` rather than inside it —
   *  a Codex skill reported under a field named for slash commands would put a
   *  claim about one surface into a field that means another. */
  adapterSurfaces: AdapterSurfacesOutcome;
  /** Every adapter target forge left alone, named by the label an operator types
   *  and the repo-relative path — the same set the human ⚠ names. */
  adapterOverrides: string[];
  imageRebuild: ImageRebuildOutcome;
  releaseCheck: ReleaseCheckOutcome;
  releaseProblems: string[] | null;
  unresolved: string[];
};

/** FG-577: the two roots this command works against, resolved SEPARATELY.
 *  `assetsDir` is where this process's own bytes live (read-only source of every
 *  release-owned asset); `devDir` is only ever a TARGET of advancement. Injected
 *  rather than re-derived inside the action so a test can drive the real command
 *  as a release without promoting the host. */
export type UpgradeEnv = { mode: ExecutionMode; assetsDir: string; devDir: string };

export function registerUpgrade(program: Command): void {
  program
    .command("upgrade")
    .description("Refresh forge: git pull the forge repo, npm install, refresh seeds in ~/.forge/, and re-init the current project's CLAUDE.md")
    .option("--dry-run", "show what would change without doing anything")
    .option("--skip-git", "skip the git pull step (useful when testing local-only changes)")
    .option("--skip-npm", "skip the npm install step (useful when deps haven't changed and you want a fast loop)")
    .option("--skip-project", "skip re-initing the current project's CLAUDE.md")
    .option("--forge-repo <dir>", "path to the forge source repo (default: $FORGE_REPO_DIR or ~/code/forge)")
    .option("--rebuild-image", "rebuild the agent image (runs docker/build.sh) — the one mutating extra step (#229)")
    .option("--json", "emit the structured result (including any refusal) instead of the human summary")
    .action((options: UpgradeOptions) => {
      runUpgrade(options, {
        mode: executionMode(),
        assetsDir: assetRoot(),
        devDir: devCheckoutDir(options.forgeRepo),
      });
    });
}

export function runUpgrade(options: UpgradeOptions, env: UpgradeEnv): UpgradeResult {
  {
    {
      const { mode, assetsDir, devDir } = env;
      const advance = decideDevAdvancement(mode, assetsDir, devDir, options);

      // --json makes stdout a single parseable document, so the human rendering
      // is suppressed rather than interleaved. Every line it would have printed
      // is reachable in the returned result.
      const json = options.json ?? false;
      const say = (line: string): void => { if (!json) console.log(line); };
      const warn = (line: string): void => { if (!json) console.warn(line); };

      const cwd = process.cwd();
      const projectClaudeMd = join(cwd, "CLAUDE.md");
      // #231: provision the project (slash commands + hooks + block) whenever the
      // cwd looks like a forge orchestrator project — a marker OR the heading.
      // The block markers no longer gate provisioning; commands/hooks are
      // machine-local setup that every machine needs even when CLAUDE.md is
      // committed and well-fenced. `forge init` remains for genuinely new projects.
      const isForgeProject = !options.skipProject &&
        existsSync(projectClaudeMd) &&
        looksLikeForgeProject(readFileSync(projectClaudeMd, "utf8"));

      const dryRun = options.dryRun ?? false;
      const prefix = dryRun ? "(dry-run) " : "";

      say(`${prefix}forge upgrade`);
      say(`  Assets:        ${assetsDir} (${mode === "release" ? "executing release" : "dev checkout, npm-linked"})`);
      say(`  Dev checkout:  ${devDir}${advance.kind === "proceed" ? "" : " (not advanced — see below)"}`);
      say(`  Project (cwd): ${isForgeProject ? cwd : (options.skipProject ? "(skipped)" : "(not a forge project here — no orchestrator block/heading; run `forge init` to set one up)")}`);
      say("");

      // Steps 1 & 2 are the ADVANCEMENT half: they may refuse or be unavailable
      // without ever blocking the asset repair in step 3.
      let gitPull: GitPullOutcome;
      let npmInstall: NpmInstallOutcome;
      if (advance.kind !== "proceed") {
        // Per step, not per decision: `--skip-git` on a release leaves git as the
        // operator's own resolved skip while npm is still genuinely refused.
        const label = advance.kind === "refused" ? "REFUSED" : "SKIPPED";
        const blocked = advance.kind === "refused" ? "refused" as const : "unavailable" as const;
        gitPull = options.skipGit ? "skipped" : blocked;
        npmInstall = options.skipNpm ? "skipped" : blocked;
        say(`[1/4] git pull: ${options.skipGit ? "skipped (--skip-git)" : label}`);
        say(`[2/4] npm install: ${options.skipNpm ? "skipped (--skip-npm)" : label}`);
        if (advance.kind === "refused" || advance.kind === "missing") {
          for (const line of advance.lines) warn(`        ${line}`);
        }
        say("");
      } else {
        if (options.skipGit) {
          gitPull = "skipped";
          say(`[1/4] git pull: skipped (--skip-git)`);
        } else {
          const pullResult = tryGitPull(devDir, dryRun);
          switch (pullResult.kind) {
            case "ok":
              gitPull = dryRun ? "would-pull" : "pulled";
              say(`[1/4] git pull: ${pullResult.message}`);
              break;
            case "no-remote":
              gitPull = "no-remote";
              say(`[1/4] git pull: skipped (no remote configured — set up upstream when ready)`);
              break;
            case "dirty":
              // NOT an operator skip: advancement was asked for and did not happen.
              gitPull = "dirty";
              say(`[1/4] git pull: DID NOT RUN (working tree has uncommitted changes in forge repo)`);
              say(`        Commit or stash in ${devDir}, then re-run.`);
              // Don't return — let the user still refresh seeds + project if they want.
              break;
            case "error":
              gitPull = "failed";
              say(`[1/4] git pull: FAILED — ${pullResult.message}`);
              // Don't return — seeds + project may still work.
              break;
          }
        }

        // Step 2: npm install (picks up new deps + workspace symlinks)
        if (options.skipNpm) {
          npmInstall = "skipped";
          say(`[2/4] npm install: skipped (--skip-npm)`);
        } else {
          const npmResult = tryNpmInstall(devDir, dryRun);
          switch (npmResult.kind) {
            case "ok":
              npmInstall = dryRun ? "would-install" : "installed";
              say(`[2/4] npm install: ${npmResult.message}`);
              break;
            case "no-package-json":
              npmInstall = "no-package-json";
              say(`[2/4] npm install: SKIPPED (no package.json at ${devDir})`);
              break;
            case "error":
              npmInstall = "failed";
              say(`[2/4] npm install: FAILED — ${npmResult.message}`);
              // Don't return — seeds + project may still work; user can re-run npm install manually.
              break;
          }
        }
      }

      // Step 3 (pre): FG-776 — the ONE-TIME host-edit backup. Runs BEFORE
      // install-seeds so that once FG-777 flips the operator-authored categories
      // (agents / constraints / raci) to always-FORCE, every operator-edited host
      // seed is already copied to a timestamped backup dir before any overwrite is
      // possible (AC1). This ticket only backs up + reports + latches — it never
      // overwrites. Non-blocking (AC5): a failure is surfaced and marks the run
      // unresolved, but never aborts the rest of the upgrade. Sourced strictly from
      // the executing release's seeds, the SAME root install-seeds writes from.
      const hostEdit = runHostEditMigration({ seedsDir: join(assetsDir, "seeds"), dryRun });
      const hostEditMigration: HostEditMigrationOutcome = hostEdit.outcome;
      say(`[3/4] pre-upgrade host-edit backup: ${hostEditMigrationStatusLine(hostEdit)}`);
      // REPORT (loud): the two-case reinstate guidance is narrated on stdout — it is
      // operator guidance about a successful backup, not a refusal, so it rides the
      // main narration (the warn stream is reserved for refusals/failures, which the
      // `warnings===""` acceptance tests assert against).
      for (const line of hostEdit.report) say(`        ${line}`);
      if (hostEdit.outcome === "failed") {
        warn(`        ⚠ pre-upgrade host-edit backup FAILED — ${hostEdit.error}`);
        warn(`          operator-edited host seeds were NOT backed up. Do NOT force a seed refresh until this succeeds.`);
      }

      // Step 3: install-seeds.sh FORCE=1 — the ASSET half. Reads from the
      // executing tree, writes only to $FORGE_HOME. Reached whether or not a dev
      // checkout exists (FG-577 / audit MEDIUM-5).
      const { installScript, templatePath } = upgradeAssetPaths(assetsDir);
      let assetInstall: AssetInstallOutcome = "installed";
      let authoredRetention: AuthoredRetentionOutcome = "not-run";
      let authoredRetentions: string[] = [];
      if (!existsSync(installScript)) {
        assetInstall = "not-found";
        say(`[3/4] install-seeds.sh: NOT FOUND at ${installScript}`);
      } else if (dryRun) {
        assetInstall = "would-install";
        say(`[3/4] install-seeds.sh: would run with FORCE=1`);
      } else {
        try {
          const out = execFileSync("bash", [installScript], {
            env: { ...process.env, FORCE: "1" },
            encoding: "utf8",
          });
          // Emit a compact summary, not the full output
          const lines = out.trim().split("\n");
          const installedLines = lines.filter((l) => l.startsWith("Installing"));
          say(`[3/4] install-seeds.sh: ${installedLines.length} component(s) refreshed`);
          for (const line of installedLines) {
            say(`        ${line.replace("Installing ", "")}`);
          }
          // FG-578: the count above is a COUNT OF "Installing" LINES. That string
          // seam is exactly where a false refresh claim gets manufactured without
          // anyone deciding to make one — so the installer only echoes
          // "Installing" for bytes it actually wrote, and reports what it
          // retained on its own, separate line. Parse that, and render it as what
          // forge did NOT do. Never re-derive it from the refresh count.
          authoredRetentions = lines.flatMap((l) => parseRetainedLine(l) ?? []);
          authoredRetention = authoredRetentions.length > 0 ? "retained" : "none";
          if (authoredRetentions.length > 0) {
            warn(`        ⚠ NOT refreshed — these are operator-authored and out of forge's control path:`);
            for (const p of authoredRetentions) warn(`            ${p} (your copy differs from this release's seed)`);
            warn(`          forge seeds these once and never writes over them, FORCE=1 included — your`);
            warn(`          \`forge raci apply\` changes and local edits survive every upgrade. The other`);
            warn(`          side of that: they are running against newer forge code than they were`);
            warn(`          written for. To take this release's defaults, diff ${join(assetsDir, "seeds")} and merge by hand.`);
          }
          // Surface orphan-warning if present (the existing install-seeds.sh
          // emits a "Note: pre-rename agent dirs detected" block).
          const noteIdx = lines.findIndex((l) => l.startsWith("Note:"));
          if (noteIdx >= 0) {
            say("");
            for (const line of lines.slice(noteIdx)) {
              if (line.startsWith("Done.")) break;
              say(`        ${line}`);
            }
          }
        } catch (e) {
          assetInstall = "failed";
          say(`[3/4] install-seeds.sh: FAILED — ${(e as Error).message}`);
        }
      }

      // Step 3 (cont.): recompile the DERIVED routing policy from the refreshed
      // RACI seed (#286). routing-policy.yml is generated, never hand-maintained,
      // so a normal upgrade must not leave it stale — otherwise `route validate`
      // and the dashboard governance panel would flag drift the instant upgrade
      // succeeds. Runs whenever a host RACI exists (independent of whether
      // install-seeds ran), and surfaces a compile failure loudly.
      let routingPolicy: RoutingPolicyOutcome;
      // FG-581: the compiler's own verbatim reason for the rejected RACI construct,
      // threaded onto the --json surface so a script sees the exact same named
      // refusal the human warning prints. Null on every non-failure path.
      let routingPolicyError: string | null = null;
      if (!existsSync(RACI_PATH)) {
        // No host RACI is not a compile failure: there is no derived artifact to
        // keep in lockstep. A RACI that exists and won't compile IS one.
        routingPolicy = "no-raci";
        say(`        → routing-policy.yml: nothing to recompile (no host RACI at ${RACI_PATH})`);
      } else {
        const res = compilePolicyFile(RACI_PATH, ROUTING_POLICY_PATH, { write: !dryRun });
        if (res.ok) {
          routingPolicy = dryRun ? "would-recompile" : "recompiled";
          // FG-583: the FLAT routing-policy.yml is NON-AUTHORITATIVE for dispatch —
          // kept only for the FG-579 drift detector / doctor registry (same status as
          // the flat workflows/runtimes). The EFFECTIVE host policy is the one compiled
          // INTO the seed generation below (publishSeedGeneration), which every dispatch
          // consumer resolves through. Say so, so the flat copy is never mistaken for live.
          say(`        → routing-policy.yml (flat, non-authoritative — drift/doctor only): ${dryRun ? "would recompile" : "recompiled"} (${res.routes} routes); effective policy is published in the seed generation`);
        } else {
          // FG-581 — fail closed. The promoted runtime cannot compile the installed
          // operator-authored RACI, so the routing-policy.yml the PREVIOUS runtime
          // compiled must NOT stay silently authoritative: a stale policy the
          // running runtime can no longer vouch for is exactly the invariant this
          // ticket forbids. Quarantine it (rename to a sibling name no policy loader
          // matches). Every consumer treats a missing host policy as fail-closed
          // (lane 'manual' / named `policy_not_found`), so removing it is the
          // smallest safe invalidation. `res.error` names the exact rejected
          // construct — thread it verbatim into the warning, the --json surface, and
          // the repair guidance; never re-derive a generic message.
          routingPolicy = "failed";
          routingPolicyError = res.error;
          warn(`        ⚠ routing-policy.yml NOT recompiled — ${res.error}`);
          if (existsSync(ROUTING_POLICY_PATH)) {
            const quarantinePath = `${ROUTING_POLICY_PATH}.quarantined`;
            if (dryRun) {
              // Forecast only — mirror the would-* pattern, touch no disk state, so
              // --json `ok` and the exit code still agree with a real run.
              warn(`          would invalidate the stale routing-policy.yml (→ ${quarantinePath}) so it cannot stay authoritative under the promoted runtime`);
            } else {
              // FAIL-CLOSED is the binding invariant: the stale policy MUST NOT stay
              // authoritative under the promoted runtime. Quarantine (rename) is the
              // preferred neutralization, but if it throws — a directory or file
              // already at the destination, cross-device, a permission wall — a bare
              // rename would let that exception escape the refusal render AND, the
              // real defect, leave the stale policy exactly where it was: fail-OPEN on
              // the one invariant this ticket closes. So fall back to removing the
              // stale policy outright; a missing host policy is itself fail-closed
              // (lane 'manual' / policy_not_found), so removal is a safe neutralization.
              // Only if BOTH rename and unlink fail is the policy genuinely stuck on
              // disk — then say so LOUDLY (it is STILL authoritative, remove it by
              // hand) and keep the refusal; never imply a quarantine that did not happen.
              try {
                renameSync(ROUTING_POLICY_PATH, quarantinePath);
                warn(`          invalidated the stale routing-policy.yml — quarantined to ${quarantinePath}; routing is now fail-closed until the RACI compiles`);
              } catch (quarantineErr) {
                try {
                  unlinkSync(ROUTING_POLICY_PATH);
                  warn(`          could not quarantine the stale routing-policy.yml (${(quarantineErr as Error).message}) — REMOVED it instead; routing is now fail-closed until the RACI compiles`);
                } catch (removeErr) {
                  // Neither rename nor unlink took it off disk: the stale policy is
                  // genuinely stuck and STILL authoritative. Reclassify so the derived
                  // `unresolved` reason stops claiming a fail-closed quarantine that
                  // did not happen — the routing outcome is the opposite here.
                  routingPolicy = "failed-not-neutralized";
                  const stuck = `the stale routing-policy.yml could NOT be neutralized (quarantine: ${(quarantineErr as Error).message}; remove: ${(removeErr as Error).message}) — it is STILL on disk at ${ROUTING_POLICY_PATH} and authoritative under the promoted runtime; remove it by hand: rm ${ROUTING_POLICY_PATH}`;
                  warn(`          ⚠ ${stuck}`);
                  routingPolicyError = `${res.error} — ${stuck}`;
                }
              }
            }
          }
          warn(`          fix ${RACI_PATH}, then run: forge route compile`);
        }
      }

      // Step 3 (cont.): FG-583 — publish the forge-owned, dispatch-coupled seed
      // surface (workflows, runtimes, derived routing policy) as ONE atomic
      // generation. Sourced strictly from the executing release (assetsDir), so a
      // divergent dev checkout can never leak into the promoted seeds. A concurrent
      // `forge next` therefore observes the prior complete generation until this
      // single rename(2) swaps in the new complete one — never a torn/mixed surface.
      // A failed publication is a NAMED, repairable state: the prior generation is
      // left intact, and the outcome flows into `unresolved` / the exit code / doctor.
      let seedGeneration: SeedGenerationOutcome = "not-run";
      let seedGenerationError: string | null = null;
      if (assetInstall === "not-found") {
        // No release seeds to publish from — the not-found asset install already
        // reports unresolved; the generation simply did not run.
        seedGeneration = "not-run";
      } else if (dryRun) {
        seedGeneration = "would-publish";
        say(`        → seed generation: would publish workflows + runtimes + derived routing policy atomically`);
      } else {
        try {
          const pub = publishSeedGeneration({
            assetsDir,
            // FG-583 source trust: the executing-release provenance is `env.assetsDir`
            // — the SAME root the whole command resolved its assets from (assetRoot()
            // in production; the injected release in a test). publishSeedGeneration
            // validates the source against this, so the divergent dev checkout (devDir)
            // can never be the seed source.
            trustedAssetRoot: () => assetsDir,
            raciPath: existsSync(RACI_PATH) ? RACI_PATH : undefined,
          });
          seedGeneration = "published";
          say(`        → seed generation: published ${pub.files} file(s) atomically${pub.routingPolicyCompiled ? " (with derived routing policy)" : ""}`);
        } catch (e) {
          seedGeneration = "failed";
          seedGenerationError = (e as Error).message;
          warn(`        ⚠ seed generation NOT published — ${seedGenerationError}`);
          // The publish is atomic: a thrown publish leaves the PRIOR generation pointer
          // intact and selectable (nothing partial is ever observable). Dispatch stays
          // anchored to the prior complete generation. If NO prior generation exists
          // (a failed FIRST install), the host has no complete generation and dispatch
          // refuses at the loader's single resolve point until a re-run succeeds.
          warn(`          the prior generation is intact; dispatch continues under it. Re-run: forge upgrade`);
        }
      }

      // Step 3 (cont.): FG-560 — model-policy.yml migration. `forge upgrade` is the
      // SOLE authority that rewrites an operator's model-policy.yml; ordinary loading
      // never writes. This enumerates the host policy plus every project Forge has a
      // durable evidence row for, migrates each safely-migratable file ATOMICALLY
      // per-file, and leaves unresolved files (needs-human-decision / unreachable /
      // newer-unsupported) UNCHANGED. Atomicity is PER-FILE, never a cross-fleet
      // transaction. Discovery is historical/best-effort: it reports which projects
      // were inspected and NEVER mutates or prunes the registry. Runs on BOTH the
      // dry-run and real branches; the dry-run forecast matches the real run
      // file-for-file because both key off the same per-file verdict.
      let modelPolicy: ModelPolicyMigrationOutcome = "not-run";
      let modelPolicies: ModelPolicyFileReport[] = [];
      {
        let discovery: PolicyDiscovery | null = null;
        try {
          discovery = discoverModelPolicies();
        } catch (e) {
          // Project enumeration reads the store; if that read fails we degrade to a
          // HOST-ONLY migration rather than crashing upgrade — the host policy needs
          // no store to find. The registry is never mutated either way.
          warn(`        ⚠ model-policy: project discovery unavailable (${(e as Error).message}) — migrating the host policy only`);
        }
        if (discovery) {
          const migrated = migrateDiscoveredPolicies(discovery, dryRun);
          modelPolicy = migrated.outcome;
          modelPolicies = migrated.files;
        } else {
          const forgeHome = process.env.FORGE_HOME ?? join(homedir(), ".forge");
          const hostPath = join(forgeHome, "model-policy.yml");
          const synthetic: DiscoveredPolicy = {
            scope: "host",
            state: existsSync(hostPath) ? "has-policy" : "reachable-no-policy",
            projectDir: forgeHome,
            canonicalDir: null,
            policyPath: existsSync(hostPath) ? hostPath : null,
            identityKey: "host",
            projectKey: null,
            evidenceSources: [],
            lastSeenAt: null,
          };
          modelPolicies = [reportForDiscoveredPolicy(synthetic, dryRun)];
          modelPolicy = aggregateModelPolicyOutcome(modelPolicies);
        }
        say(`        → model-policy: ${summarizeModelPolicies(modelPolicies, dryRun)}`);
        for (const f of modelPolicies) {
          const where = f.scope === "host" ? "host" : (f.projectDir ?? "(unknown project)");
          const suffix = f.detail ? ` — ${f.detail}` : "";
          if (f.action === "migrated") say(`            ${where}: migrated${suffix}`);
          else if (f.action === "would-migrate") say(`            ${where}: would migrate${suffix}`);
          else if (f.action === "needs-human-decision") warn(`            ⚠ ${where}: NEEDS HUMAN DECISION — left unchanged${suffix}`);
          else if (f.action === "newer-unsupported") warn(`            ⚠ ${where}: newer than this forge understands — left unchanged; upgrade Forge`);
          else if (f.action === "unreachable") warn(`            ⚠ ${where}: unreachable${suffix}`);
          else if (f.action === "failed") warn(`            ⚠ ${where}: migration FAILED — original left intact${suffix}`);
        }
      }

      // Step 4: re-init current project — CLAUDE.md orchestrator block + all
      // hook installs (commit-msg, claude session hooks, slash commands).
      // Re-running the install plans is idempotent: already-current entries
      // no-op; updates apply when the template/source has moved.
      let projectInit: ProjectInitOutcome;
      // FG-546: default `not-run` — a project the [4/4] block skips (not a forge
      // project, or --skip-project) never gets its docs-surfaces classified.
      let docsSurfaces: DocsSurfacesOutcome = "not-run";
      let docsSurfacesRepair: string | null = null;
      let slashCommands: SlashCommandsOutcome = "not-run";
      let slashCommandOverrides: string[] = [];
      let adapterSurfaces: AdapterSurfacesOutcome = "not-run";
      let adapterOverrides: string[] = [];
      if (!isForgeProject) {
        // #231 follow-up: flag the never-initialized case loudly + actionably,
        // instead of a terse "skipped". upgrade is for EXISTING projects; a
        // project with no forge block has never been `forge init`'d.
        if (options.skipProject) {
          projectInit = "skipped";
          say(`[4/4] project init: skipped (--skip-project)`);
        } else if (!existsSync(projectClaudeMd)) {
          projectInit = "no-claude-md";
          say(`[4/4] project init: DID NOT RUN — no CLAUDE.md in ${cwd}`);
          warn(`        ⚠ this directory has never been initialized for forge. Run \`forge init\` here first (upgrade is for existing projects).`);
        } else {
          projectInit = "no-forge-block";
          say(`[4/4] project init: DID NOT RUN — CLAUDE.md has no forge orchestrator block`);
          warn(`        ⚠ this project was never \`forge init\`'d (or you're not in the project root). Run \`forge init\` here to set it up.`);
        }
      } else {
        // #231: provisioning (commands/hooks/gitignore) runs UNCONDITIONALLY —
        // it's machine-local setup independent of the CLAUDE.md block state, and
        // is what makes /orient + /handoff available. The block refresh is a
        // separate best-effort step that never blocks provisioning.
        const projForgeDir = join(cwd, ".forge");
        if (!dryRun && !existsSync(projForgeDir)) mkdirSync(projForgeDir, { recursive: true });

        // Block refresh (best-effort): replace / repair / append / or ask for
        // manual markers — never silently skip, never duplicate.
        if (!existsSync(templatePath)) {
          projectInit = "template-not-found";
          say(`[4/4] project init: block NOT refreshed — template not found at ${templatePath}`);
        } else {
          const template = readFileSync(templatePath, "utf8");
          const existing = readFileSync(projectClaudeMd, "utf8");
          const result = applyOrchestratorBlock(existing, template);
          if (result.action === "needs-markers") {
            projectInit = "needs-markers";
            say(`[4/4] project init: orchestrator block needs manual markers`);
            warn(`        ⚠ ${result.message}`);
          } else if (result.content === existing) {
            projectInit = "already-current";
            say(`[4/4] project init: orchestrator block already current`);
          } else if (dryRun) {
            projectInit = "would-refresh";
            say(`[4/4] project init: would ${result.action} orchestrator block in ${projectClaudeMd}`);
          } else {
            projectInit = "refreshed";
            writeFileSync(projectClaudeMd, result.content);
            say(`[4/4] project init: ${result.action} orchestrator block`);
          }
        }

        // FG-546: docs-surfaces detect / create / migrate / preserve / repair —
        // the SAME classifier-driven helper `forge init` uses (step 4). upgrade
        // never re-runs seed provisioning, so this is the ONLY path that repairs a
        // project already holding the invalid legacy object template. Keyed off the
        // four-way verdict, never bare file existence: a customized file (valid OR
        // invalid) is never mistaken for the generated template and never
        // auto-overwritten. Distinct from the host-seed cache ([3/4]) — this is the
        // project's own .forge/ config. Runs on BOTH the dry-run and real branches.
        if (dryRun) {
          const { verdict, path, detail } = classifyDocsSurfaces(cwd);
          docsSurfaces = docsSurfacesDryRunOutcome(verdict);
          say(`        docs-surfaces:     ${describeDocsSurfacesProvisionPlan(cwd)}`);
          if (verdict === "customized-invalid") {
            docsSurfacesRepair = docsSurfacesRepairWarning(path, detail ?? "invalid docs-surfaces config");
            warn(`        ${docsSurfacesRepair}`);
          }
        } else {
          const outcome = provisionDocsSurfaces(cwd);
          docsSurfaces = docsSurfacesOutcomeOf(outcome);
          say(`        docs-surfaces:     ${docsSurfacesStatusLine(outcome)}`);
          if (outcome.action === "requires-operator-repair") {
            docsSurfacesRepair = docsSurfacesRepairWarning(outcome.path, outcome.detail);
            warn(`        ${docsSurfacesRepair}`);
          }
        }

        // Hook / adapter / gitignore plans — idempotent (already-current → no-op).
        const commitMsg = planCommitMsgHook(cwd);
        const claudeHooks = planClaudeHooks(cwd);
        // FG-253 step 5: the step-4 planner/executor, driven here so an EXISTING
        // project is UPDATED — the whole adapter set, Claude commands and Codex
        // skills alike, refreshed from this release's rendered bytes and migrated
        // off the pre-FG-253 symlinks. Planned ONCE: two plans would be two reads
        // of the filesystem, free to disagree about what is on disk.
        const adapters = planOperatorAdapters(cwd);
        const gitignore = planGitignoreEntries(cwd);
        const adapterEntries = adapters.action === "skipped" ? [] : adapters.entries;
        if (dryRun) {
          // A dry run has nothing but the plan, and says so by construction: every
          // state it reports is a forecast of what is already on disk, which is the
          // one thing a dry run predicts exactly.
          slashCommandOverrides = skippedClaudeCommands(adapters).map(
            (e) => `${"/" + e.name.replace(/\.md$/, "")} NOT installed — ${e.target} already exists (${e.details ?? "unknown reason"})`,
          );
          adapterOverrides = operatorAdapterOverrides(adapters).map(
            (e) => `${e.label} NOT installed — ${e.relPath} already exists (${e.details ?? "unknown reason"})`,
          );
          slashCommands = classifyAdapterEntries(adapterEntries.filter((e) => e.surface === "claude-command"), true);
          adapterSurfaces = classifyAdapterEntries(adapterEntries, true);

          say(`        commit-msg hook:   ${commitMsg.action}`);
          say(`        claude hooks:      ${claudeHooks.action}`);
          say(`        operator adapters: ${adapters.action}`);
          for (const line of adapterReportLines(adapters)) say(`    ${line}`);
          say(`        .gitignore:        ${gitignore.action}`);
          if (!json) warnOperatorAdapterOverrides(adapters);
        } else {
          say(`        commit-msg hook:   ${executeHookPlan(commitMsg)}`);
          say(`        claude hooks:      ${executeClaudeHooksPlan(claudeHooks)}`);
          // The REAL run reports per-OUTCOME, not per planned decision: a target
          // that changed between plan and execute is skipped, and a report read
          // back off the plan would claim an install forge deliberately did not do.
          const applied = executeOperatorAdapters(adapters);
          say(`        operator adapters: ${applied.summary}`);
          for (const line of adapterOutcomeLines(adapters, applied.outcomes)) say(`    ${line}`);
          say(`        .gitignore:        ${executeGitignoreEntriesPlan(gitignore)}`);

          // EVERY consumer of the adapter step — --json, the exit code's step
          // classification, and the human ⚠ — reads the same outcomes the run
          // produced. The override list is the operator's evidence that forge left
          // their file alone; derived from the plan it would be reporting a state
          // nothing observed, and would silently omit a file that became theirs
          // after the plan was made.
          slashCommandOverrides = skippedClaudeCommandOutcomes(applied.outcomes).map(
            (o) => `${"/" + o.name.replace(/\.md$/, "")} NOT installed — ${o.target} ${adapterNotInstalledReason(o)}`,
          );
          adapterOverrides = executedAdapterOverrides(applied.outcomes).map(
            (o) => `${o.label} NOT installed — ${o.relPath} ${adapterNotInstalledReason(o)}`,
          );
          slashCommands = classifyAdapterOutcomes(applied.outcomes.filter((o) => o.surface === "claude-command"));
          adapterSurfaces = classifyAdapterOutcomes(applied.outcomes);
          // Suppressed under --json rather than written straight to the console
          // beside a document that claims to be the whole answer.
          if (!json) warnExecutedAdapterOverrides(applied.outcomes);
        }
      }

      // #229: rebuild the agent image only when explicitly asked (the one
      // mutating extra step), so a stale image can be fixed in the same command.
      const rebuild = maybeRebuildImage(options, devDir, mode, assetsDir);
      for (const line of rebuild.lines) say(line);
      if (rebuild.error) warn(rebuild.error);
      const imageRebuild: ImageRebuildOutcome = rebuild.outcome;

      // #229: read-only release check so a stale image / missing runtime CLI /
      // missing credential is surfaced NOW, not at the next dispatch. Never
      // mutates.
      //
      // Gated on the asset install, not merely on !dryRun: when install-seeds
      // never ran, the tail reports on a ~/.forge this upgrade did not touch, and
      // a stale state presented as a fresh verdict is worse than no verdict.
      let releaseCheck: ReleaseCheckOutcome;
      let releaseProblems: string[] | null = null;
      let releaseCheckLines: string[] = [];
      if (dryRun) {
        releaseCheck = "skipped-dry-run";
      } else if (assetInstall !== "installed") {
        releaseCheck = "skipped-asset-install";
        releaseCheckLines = ["", `Release check: not run — host seeds were not refreshed (install-seeds.sh: ${assetInstall}), so any verdict would describe a host this upgrade never touched.`];
      } else {
        try {
          // FG-577: the tail's image probe judges against the EXECUTING tree's
          // docker/, the same root doctor's standalone path now reads — so the
          // two cannot report different staleness for the same host.
          const report = buildReleaseReport(gatherReleaseInputs(undefined, { projectDir: cwd, forgeRepoDir: assetsDir }, {}, mode));
          releaseCheck = "ran";
          releaseProblems = summarizeProblems(report);
          releaseCheckLines = ["", ...renderReleaseCheckLines(report)];
        } catch (e) {
          // The check is the only thing that would have told the operator whether
          // this host can actually run agents. It crashing is a state nobody
          // verified, not a nicety that was skipped.
          releaseCheck = "failed";
          releaseCheckLines = ["", `Release check FAILED — ${(e as Error).message}`];
        }
      }

      // A requested action that did not happen is a failed request, not a skipped
      // nicety. All THREE consumer surfaces — the exit code, the closing line, and
      // --json — derive from ONE list, built by a total classification over EVERY
      // step outcome. A `missing` dev checkout is not on it: nothing refused and
      // nothing failed, the host simply has no checkout to advance.
      const outcomes: UpgradeStepOutcomes = {
        gitPull,
        npmInstall,
        assetInstall,
        hostEditMigration,
        seedGeneration,
        modelPolicy,
        authoredRetention,
        routingPolicy,
        projectInit,
        docsSurfaces,
        slashCommands,
        adapterSurfaces,
        imageRebuild,
        releaseCheck,
      };
      const unresolved = unresolvedReasons(outcomes);
      // A dry run is a report, but it is a report an operator acts on: --json's
      // `ok` and the exit code must agree, or the two disagree about the same run.
      if (unresolved.length > 0) process.exitCode = 1;

      say("");
      if (dryRun) {
        if (unresolved.length === 0) say("Dry run: nothing refused, and nothing decidable without executing is missing.");
        else say(`Dry run: this upgrade would NOT complete — ${unresolved.join("; ")}.`);
        // Structural blindness, stated rather than implied by a clean-looking
        // forecast: nothing ran, so no execution-dependent state was observed.
        say("  NOT predicted: nothing was executed, so whether git pull, npm install, install-seeds.sh or an image rebuild would SUCCEED is unknown, and this host's release check was not run.");
        say("Re-run without --dry-run to apply.");
      } else if (unresolved.length === 0) say("Upgrade complete.");
      else say(`Upgrade INCOMPLETE — ${unresolved.join("; ")}.`);

      for (const line of releaseCheckLines) say(line);

      const result: UpgradeResult = {
        ok: unresolved.length === 0,
        dryRun,
        mode,
        assetsDir,
        devDir,
        // The refusal REGISTER itself, not a boolean an operator would have to
        // re-derive the reason for: a --json consumer gets the same named,
        // actionable lines the human surface prints.
        devAdvancement: {
          kind: advance.kind,
          lines: advance.kind === "refused" || advance.kind === "missing" ? advance.lines : [],
          gitPull,
          npmInstall,
        },
        assetInstall,
        hostEditMigration,
        hostEditBackupDir: hostEdit.backupDir,
        hostEditBackedUp: hostEdit.backedUp,
        hostEditReport: hostEdit.report,
        hostEditLatchPath: hostEdit.latchPath,
        seedGeneration,
        seedGenerationError,
        modelPolicy,
        modelPolicies,
        authoredRetention,
        authoredRetentions,
        routingPolicy,
        routingPolicyError,
        projectInit,
        docsSurfaces,
        docsSurfacesRepair,
        slashCommands,
        slashCommandOverrides,
        adapterSurfaces,
        adapterOverrides,
        imageRebuild,
        releaseCheck,
        releaseProblems,
        unresolved,
      };
      if (json) console.log(JSON.stringify(result, null, 2));
      return result;
    }
  }
}

// #229: the operator-facing upgrade-tail pieces, extracted so they're testable
// without driving the whole git/npm/seed action. The exec seam is injectable.
export type ImageRebuildExec = (cmd: string, opts: { cwd: string; stdio: "inherit" }) => void;

/** `mode` is deliberately REQUIRED and un-defaulted: it is the whole refusal
 *  predicate below, and the value a forgetful caller would have inherited from a
 *  default ("dev") is the permissive one. An explicit parameter cannot silently
 *  drift into letting a release rebuild.
 *
 *  Returns the step's OUTCOME, not the raw ingredients for the caller to
 *  re-derive one from: the caller re-testing `rebuildImage && dryRun` to reach
 *  `would-rebuild` was a second copy of the ordering below, free to disagree with
 *  it. One decision, decided once, here. */
export function maybeRebuildImage(
  options: { rebuildImage?: boolean; dryRun?: boolean },
  devDir: string,
  mode: ExecutionMode,
  assetsDir: string = assetRoot(),
  exec: ImageRebuildExec = (cmd, opts) => { execSync(cmd, opts); },
): { outcome: ImageRebuildOutcome; lines: string[]; error?: string } {
  // FG-577 — skip → mode → dryRun, the ordering rule this whole file obeys.
  //
  // A skip is a fact about what was REQUESTED, and outranks the refusal: no flag,
  // nothing to refuse.
  if (!options.rebuildImage) return { outcome: "skipped", lines: [] };
  // The mode is a fact about what CAN happen, and it outranks the forecast.
  // Rebuilding is dev-advancement — it runs a script from, and writes an image
  // built out of, the dev checkout. (The read-only staleness PROBE follows the
  // release, in doctor.ts; only this ACTION refuses.) `dryRun` used to be tested
  // ahead of this, so a release forecast a rebuild it would in fact refuse.
  if (mode === "release") {
    return { outcome: "refused", lines: [], error: refuseDevAdvance("rebuild the agent image (--rebuild-image)", assetsDir, devDir).join("\n") };
  }
  // Last: a dry run PREDICTS the decision the real run would make. Every fact
  // that decides that answer has now been consulted, so this cannot bypass one.
  if (options.dryRun) return { outcome: "would-rebuild", lines: [] };
  const lines = ["", "[image] rebuilding agent image (docker/build.sh)…"];
  try {
    exec("bash ./build.sh", { cwd: join(devDir, "docker"), stdio: "inherit" });
    return { outcome: "ran", lines };
  } catch {
    return { outcome: "failed", lines, error: "forge upgrade: image rebuild failed — see output above." };
  }
}

export function renderReleaseCheckLines(report: ReleaseReport): string[] {
  const problems = summarizeProblems(report);
  if (problems.length === 0) {
    return ["Release check: ✓ image, runtime CLIs, auth, and policies look ready."];
  }
  return [
    "Release check — action needed before agents run cleanly:",
    ...problems.map((p) => `  ${p}`),
    "  (run `forge doctor` for the full report)",
  ];
}

type PullResult =
  | { kind: "ok"; message: string }
  | { kind: "no-remote" }
  | { kind: "dirty" }
  | { kind: "error"; message: string };

// Exported for testing.
export function tryGitPull(repoDir: string, dryRun: boolean): PullResult {
  // Working tree clean? Refuse to pull if dirty — protects in-progress work.
  let statusOut: string;
  try {
    statusOut = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf8" });
  } catch (e) {
    return { kind: "error", message: `git status failed: ${(e as Error).message}` };
  }
  if (statusOut.trim().length > 0) return { kind: "dirty" };

  // Any remote configured? If not, skip without erroring.
  let remoteOut: string;
  try {
    remoteOut = execSync("git remote", { cwd: repoDir, encoding: "utf8" });
  } catch {
    return { kind: "no-remote" };
  }
  if (remoteOut.trim().length === 0) return { kind: "no-remote" };

  if (dryRun) return { kind: "ok", message: "would pull from remote" };

  try {
    const out = execSync("git pull --ff-only", { cwd: repoDir, encoding: "utf8" });
    const compact = out.trim().split("\n")[0] ?? "(no output)";
    return { kind: "ok", message: compact };
  } catch (e) {
    return { kind: "error", message: `git pull failed: ${(e as Error).message}` };
  }
}

type NpmInstallResult =
  | { kind: "ok"; message: string }
  | { kind: "no-package-json" }
  | { kind: "error"; message: string };

// Exported for testing. Runs `npm install` in the forge repo, picking up any
// new top-level deps + new workspace deps. Needed since #140 added the
// dashboard workspace + the `marked` dep; a user who only pulled would have
// a broken dashboard.
export function tryNpmInstall(repoDir: string, dryRun: boolean): NpmInstallResult {
  if (!existsSync(join(repoDir, "package.json"))) {
    return { kind: "no-package-json" };
  }
  if (dryRun) return { kind: "ok", message: "would run npm install" };
  try {
    const out = execSync("npm install --silent", { cwd: repoDir, encoding: "utf8" });
    // npm install's success output is typically one or two lines about packages
    // added/audited. Compact it down to the most informative line.
    const lines = out.trim().split("\n").filter((l) => l.trim().length > 0);
    const summary = lines.find((l) => /added|removed|changed|audited|up to date/.test(l))
      ?? lines[lines.length - 1]
      ?? "complete";
    return { kind: "ok", message: summary };
  } catch (e) {
    return { kind: "error", message: `npm install failed: ${(e as Error).message}` };
  }
}
