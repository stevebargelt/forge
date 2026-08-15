import type { Command } from "commander";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBacklogConfig } from "../../backlog/config.js";
import { ensureHostRoutingPolicy } from "../../raci/host-policy.js";
import { FORGE_HOME, RACI_PATH, ROUTING_POLICY_PATH, currentLinkIn } from "../../util/paths.js";
// FG-253: the project-scoped operator adapters. The BYTES come from the two
// renderers, which derive everything they say from the single provider-neutral
// definition; this module owns only where they land on disk and who is allowed
// to overwrite what.
import {
  isDocumentedAbsence,
  parseAdapterMarker,
  OPERATOR_SURFACES,
  operatorSurface,
  type AdapterStamp,
  type OperatorSurface,
  type OperatorWorkflowId,
} from "../../v2/operator-workflows.js";
import { currentAdapterStamp } from "../../v2/adapter-stamp.js";
// FG-546: the four-way docs-surfaces classifier is the SINGLE decision point that
// init, upgrade, doctor, and dry-run all consume. The provisioning side-effect
// keys off the verdict, never off bare file existence — so a customized file
// (valid OR invalid) is never mistaken for the known generated template and never
// auto-overwritten.
import { classifyDocsSurfaces } from "../../v2/contract.js";
// One predicate, not two: the drift detector already owns "is this link forge's own
// pre-FG-253 artifact?", and an installer that answered it differently would migrate
// what doctor calls the operator's — or leave standing a remedy that converges nothing.
import { isLegacyForgeSlashCommandLink } from "../../v2/seed-drift.js";
import { renderClaudeCommands } from "../../v2/render-claude-commands.js";
import {
  CODEX_DEPRECATED_PROMPT_DIRS,
  CODEX_SKILLS_ROOT,
  FORGE_OWNED_CODEX_SKILL_DIRS,
  renderCodexSkills,
} from "../../v2/render-codex-skills.js";
// FG-685: the bundled-hook source resolution moved to src/util so the clone
// substrate (src/v2/worktree-lifecycle.ts) and this installer answer "where are
// the hook bytes" the same way. What the operator's primary checkout installs is
// unchanged — still the symlink through $FORGE_HOME/current planned below.
import { resolveHookSource, tryResolveHookSource } from "../../util/commit-msg-hook.js";
import { describeIdentity, identify } from "../../util/path-identity.js";

// #153: Claude Code session lifecycle hooks (SessionStart / Stop / SessionEnd)
// write heartbeat files into ~/.forge/orchestrators/<session-id>.json so forge
// can report which orchestrator sessions are live. Marker substring used to
// detect/upgrade an existing forge-installed hook entry on re-runs.
const HEARTBEAT_MARKER = "orchestrator-heartbeat";
const CLAUDE_HOOK_EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["SessionStart", "start"],
  ["Stop", "tick"],
  ["SessionEnd", "end"],
];

// Per-developer claude-code config lives in settings.local.json (claude-code's
// convention for machine-local overrides — not committed). Project-shared
// settings.json stays untouched by forge so it remains available for project-
// owned config like permissions. This split was added after a portability bug
// surfaced: an earlier version of forge wrote hooks into committed
// settings.json with absolute paths in the hook commands, breaking any
// developer who cloned the project at a different forge path. Per-developer
// config + gitignored + bootstrapped via `forge init` resolves that cleanly.
const LOCAL_SETTINGS_FILENAME = "settings.local.json";
const LEGACY_SETTINGS_FILENAME = "settings.json";

// Gitignore entries forge ensures are present in each project's .gitignore so
// the per-developer artifacts forge writes don't get accidentally committed.
//
// FG-253: the Codex skill entries are PER-DIRECTORY, derived from the set the
// renderer owns — never the `.agents/skills/` parent, which belongs to the
// operator and may hold skills forge knows nothing about. Ignoring the parent
// would silently un-commit somebody else's work.
const FORGE_GITIGNORE_ENTRIES = [
  ".claude/settings.local.json",
  ".claude/commands/",
  ...FORGE_OWNED_CODEX_SKILL_DIRS.map((d) => `${CODEX_SKILLS_ROOT}/${d}/`),
];

// Wraps the project's CLAUDE.md with the forge orchestrator block. Idempotent:
// if the fenced markers already exist, replaces the block in place; if they
// don't, appends. Creates CLAUDE.md if missing. Adds .forge/ dir for project
// overrides (workflows/, runtimes/ — populated lazily by the user).
//
// Markers are HTML comments so they survive markdown rendering invisibly:
//   <!-- forge:orchestrator-start -->
//   ...template body...
//   <!-- forge:orchestrator-end -->

const START_MARKER = "<!-- forge:orchestrator-start -->";
const END_MARKER = "<!-- forge:orchestrator-end -->";
// The orchestrator block's leading heading — used to anchor block repair (#231)
// when a marker is missing.
const ORCH_HEADING = "# forge orchestrator";

// True when a CLAUDE.md looks like a forge orchestrator project: it has either
// fence marker or the orchestrator heading. `forge upgrade` uses this to decide
// whether to provision a project (commands/hooks) — independent of whether the
// block markers are balanced (#231).
export function looksLikeForgeProject(claudeMd: string): boolean {
  return claudeMd.includes(START_MARKER) || claudeMd.includes(END_MARKER) || claudeMd.includes(ORCH_HEADING);
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Set up forge in the current project: install orchestrator block into CLAUDE.md and create .forge/ dir")
    .option("--project <dir>", "project root to initialize (default: cwd)")
    .option("--dry-run", "show what would change without writing files")
    .option("--no-install-hooks", "skip installing the commit-msg git hook")
    .option("--prefix <string>", "backlog item prefix (e.g. FG) — written to .forge/config.yml")
    .action(async (options: { project?: string; dryRun?: boolean; installHooks?: boolean; prefix?: string }) => {
      const projectDir = resolve(options.project ?? process.cwd());
      if (!existsSync(projectDir)) {
        throw new Error(`project directory does not exist: ${projectDir}`);
      }
      const claudeMdPath = join(projectDir, "CLAUDE.md");
      const forgeProjectDir = join(projectDir, ".forge");

      const templateBody = readTemplate();

      const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";
      const blockResult = applyOrchestratorBlock(existing, templateBody);
      const next = blockResult.content;

      const willWrite = next !== existing;
      const willCreateForgeDir = !existsSync(forgeProjectDir);

      // Hook install plans (--no-install-hooks bypasses all of them).
      const installHooks = options.installHooks !== false;
      const hookPlan = installHooks ? planCommitMsgHook(projectDir, FORGE_HOME) : { action: "skipped" as const };
      const claudeHooksPlan = installHooks ? planClaudeHooks(projectDir) : { action: "skipped" as const };
      const adaptersPlan: OperatorAdaptersPlan = installHooks ? planOperatorAdapters(projectDir) : { action: "skipped" as const };
      const gitignorePlan = installHooks ? planGitignoreEntries(projectDir) : { action: "skipped" as const };

      if (options.dryRun) {
        console.log(`forge init (dry-run) in ${projectDir}`);
        console.log(`  CLAUDE.md:        ${existing ? "exists" : "missing"} → ${blockStatus(blockResult.action, !!existing)}`);
        console.log(`  .forge/ dir:      ${willCreateForgeDir ? "WOULD create" : "exists"}`);
        console.log(`  backlog/:         ${describeBacklogScaffoldPlan(projectDir)}`);
        console.log(`  config.yml:       ${options.prefix ? `WOULD write prefix = ${options.prefix}` : "skipped (no --prefix)"}`);
        console.log(`  model-policy.yml: ${describeSeedProvisionPlan(forgeProjectDir, "model-policy.yml")}`);
        console.log(`  docs-surfaces.yml:${describeDocsSurfacesProvisionPlan(projectDir)}`);
        console.log(`  commit-msg hook:  ${describeHookPlan(hookPlan)}`);
        console.log(`  claude hooks:     ${describeClaudeHooksPlan(claudeHooksPlan)}`);
        console.log(`  operator adapters: ${describeClaudeCommandsPlan(adaptersPlan)}`);
        // Per-FILE decisions, from the same list the real run executes — a dry
        // run that summarized instead of enumerating could not be checked
        // against what the run then did.
        for (const line of adapterReportLines(adaptersPlan)) console.log(line);
        console.log(`  .gitignore:       ${describeGitignorePlan(gitignorePlan)}`);
        const hostPolicyDry = ensureHostRoutingPolicy({ raciPath: RACI_PATH, policyPath: ROUTING_POLICY_PATH, seedRaciPath: seedRaciPath(), dryRun: true });
        console.log(`  routing policy:   ${hostPolicyDry.status}`);
        if (blockResult.action === "needs-markers") console.warn(`  ⚠ orchestrator block: ${blockResult.message}`);
        return;
      }

      if (willWrite) {
        writeFileSync(claudeMdPath, next);
      }
      if (willCreateForgeDir) {
        mkdirSync(forgeProjectDir, { recursive: true });
      }
      const backlogScaffoldResult = scaffoldBacklogDirs(projectDir);
      if (options.prefix) {
        writeBacklogConfig(projectDir, { prefix: options.prefix });
      }
      const modelPolicyResult = provisionSeedFile(forgeProjectDir, "model-policy.yml", "model-policy.example.yml");
      const docsSurfacesOutcome = provisionDocsSurfaces(projectDir);
      const hookResult = installHooks ? executeHookPlan(hookPlan) : "skipped (--no-install-hooks)";
      const claudeHooksResult = installHooks ? executeClaudeHooksPlan(claudeHooksPlan) : "skipped (--no-install-hooks)";
      const adaptersResult = installHooks ? executeOperatorAdapters(adaptersPlan) : { summary: "skipped (--no-install-hooks)", outcomes: [] };
      const gitignoreResult = installHooks ? executeGitignoreEntriesPlan(gitignorePlan) : "skipped (--no-install-hooks)";

      console.log(`forge init complete in ${projectDir}`);
      console.log(`  CLAUDE.md:        ${blockStatus(blockResult.action, !!existing)}`);
      if (blockResult.action === "needs-markers") console.warn(`  ⚠ orchestrator block: ${blockResult.message}`);
      console.log(`  .forge/:          ${willCreateForgeDir ? "created" : "already exists"}`);
      console.log(`  backlog/:         ${backlogScaffoldResult}`);
      console.log(`  config.yml:       ${options.prefix ? `wrote prefix = ${options.prefix}` : "skipped (no --prefix)"}`);
      console.log(`  model-policy.yml: ${modelPolicyResult}`);
      console.log(`  docs-surfaces.yml:${docsSurfacesStatusLine(docsSurfacesOutcome)}`);
      if (docsSurfacesOutcome.action === "requires-operator-repair") {
        console.warn(`        ${docsSurfacesRepairWarning(docsSurfacesOutcome.path, docsSurfacesOutcome.detail)}`);
      }
      console.log(`  commit-msg hook:  ${hookResult}`);
      console.log(`  claude hooks:     ${claudeHooksResult}`);
      console.log(`  operator adapters: ${adaptersResult.summary}`);
      for (const line of adapterOutcomeLines(adaptersPlan, adaptersResult.outcomes)) console.log(line);
      console.log(`  .gitignore:       ${gitignoreResult}`);
      // #286: keep the derived host routing policy compiled from the RACI seed so
      // a fresh project is immediately routable without a separate compile step.
      const hostPolicy = ensureHostRoutingPolicy({ raciPath: RACI_PATH, policyPath: ROUTING_POLICY_PATH, seedRaciPath: seedRaciPath() });
      console.log(`  routing policy:   ${hostPolicy.status}`);
      if (!hostPolicy.ok) console.warn(`        ⚠ routing policy not generated — ${hostPolicy.status}`);
      if (installHooks) warnExecutedAdapterOverrides(adaptersResult.outcomes);
      console.log(``);
      console.log(`Note: .claude/settings.local.json, .claude/commands/ and the forge skill dirs under`);
      console.log(`      ${CODEX_SKILLS_ROOT}/ are per-developer (gitignored).`);
      console.log(`      Other contributors run \`forge init\` after cloning to bootstrap their local copies.`);
      console.log(``);
      console.log(`Next: run 'forge claude' from this directory to talk to the forge orchestrator.`);
      console.log(`Try /orient to load session state and /handoff before you stop.`);
    });
}

// FG-582 (AC-5): the identity the planner classified at `target`, carried into
// executeHookPlan so it can re-verify nothing changed before it mutates —
// either the target was absent (a fresh install) or it was a specific
// Forge-owned symlink (safe to re-point only while it still points where the
// planner saw it).
type OwnedTargetState =
  | { kind: "absent" }
  | { kind: "owned-link"; linkTarget: string };

type HookPlan =
  | { action: "install"; target: string; source: string; expect: OwnedTargetState }
  | { action: "already-linked"; target: string }
  | { action: "exists-other"; target: string; details: string }
  | { action: "not-a-git-repo" }
  | { action: "skipped" };

// Decides what to do for the commit-msg hook without writing anything.
// Exported for testing.
//
// FG-582: the install target follows the promoted release. When a `current`
// pointer exists under `home`, install a symlink THROUGH the bundled hook under
// $FORGE_HOME/current/ (scripts/git-hooks/commit-msg-no-ai-attribution) — git
// re-resolves it at every invocation, so a NEW commit picks up
// the currently promoted release's bytes (an already-running invocation stays
// anchored to whatever it started under; the OS resolves the interpreter path at
// process start). With no `current` pointer (a live dev checkout), fall back to
// today's absolute dev-checkout source so the dev loop is preserved.
//
// Ownership decisions are made by lstat/readlink of the LINK ITSELF (never
// existsSync, which follows a dangling link into a false positive). A hook is
// provably Forge-owned — and therefore safe to re-point on a stale target — IFF
// its link resolves at the promoted-arm target
// ($FORGE_HOME/current/scripts/git-hooks/commit-msg-no-ai-attribution)
// OR at this checkout's own hook source (the legacy absolute-dev-path form the
// pre-FG-582 code installed). Anything else — a regular file, a foreign symlink,
// a link we can't attribute — is left untouched. Bare containment in
// $FORGE_HOME/releases/* is NEVER ownership evidence (that namespace is
// attacker-addressable, paths.ts:75).
export function planCommitMsgHook(projectDir: string, home: string = FORGE_HOME): HookPlan {
  const hooksDir = join(projectDir, ".git", "hooks");
  if (!existsSync(hooksDir)) return { action: "not-a-git-repo" };
  const target = join(hooksDir, "commit-msg");
  const source = hookInstallTarget(home);
  const owned = forgeOwnedHookTargets(home);

  let st;
  try { st = lstatSync(target); }
  catch { return { action: "install", target, source, expect: { kind: "absent" } }; }

  if (!st.isSymbolicLink()) {
    return { action: "exists-other", target, details: "regular file (some other hook)" };
  }
  let linkTarget = "";
  try { linkTarget = readlinkSync(target); }
  catch { return { action: "exists-other", target, details: "unreadable" }; }
  const resolved = resolve(dirname(target), linkTarget);
  const pointsAt = (t: string) => linkTarget === t || resolved === t;
  if (pointsAt(source)) return { action: "already-linked", target };
  if (owned.some(pointsAt)) return { action: "install", target, source, expect: { kind: "owned-link", linkTarget } };
  return { action: "exists-other", target, details: `symlink → ${linkTarget}` };
}

// The bundled commit-msg hook's path RELATIVE to a release root. A release
// copies the whole source tree (release.ts), so the hook a promotion ships lives
// at $FORGE_HOME/current/scripts/git-hooks/commit-msg-no-ai-attribution — NOT a
// root-level `current/commit-msg`, which no real release ever contains.
const PROMOTED_HOOK_REL = join("scripts", "git-hooks", "commit-msg-no-ai-attribution");

// The promoted-arm install target: the bundled hook reached THROUGH
// $FORGE_HOME/current, so git re-resolves it to the currently promoted release
// on every invocation.
function promotedHookTarget(home: string): string {
  return join(currentLinkIn(home), PROMOTED_HOOK_REL);
}

// The arm-selected install target: the promoted arm (through $FORGE_HOME/current)
// when the current pointer RESOLVES to a usable hook target, else the
// dev-checkout source.
function hookInstallTarget(home: string): string {
  return promotedArmResolves(home)
    ? promotedHookTarget(home)
    : resolveHookSource();
}

// FG-582 (AC-3): choose the promoted arm on RESOLVABILITY, not link existence.
// existsSync follows the link, so a DANGLING `current` (its release dir absent,
// or a release with no bundled hook) reads false and we fall back to the dev
// checkout — never install an unresolvable promoted-arm hook that would make the
// commit-msg guard silently never run.
function promotedArmResolves(home: string): boolean {
  return existsSync(promotedHookTarget(home));
}

// The set of link targets that prove a hook is Forge-owned: the promoted-arm
// target and this checkout's own hook source (the legacy absolute-dev-path). A
// stale link pointing at either — but not at the currently selected arm — is
// re-pointed (migrating already-onboarded repos onto `current`); a link at
// neither is foreign and left alone.
function forgeOwnedHookTargets(home: string): string[] {
  // FG-582 (FIX 4): the dev-checkout source is only an OPTIONAL ownership
  // signal here (migrating legacy dev-path links). Tolerate its absence rather
  // than throwing — a missing bundled hook must not abort the promoted arm.
  const targets = [promotedHookTarget(home)];
  const devSource = tryResolveHookSource();
  if (devSource) targets.push(devSource);
  return targets;
}

export function executeHookPlan(plan: HookPlan): string {
  switch (plan.action) {
    case "install": {
      // FG-582 (AC-5): between planning and here the target could have been
      // swapped for a foreign hook. Re-read its identity and refuse to mutate
      // unless it STILL matches what the planner classified (still absent, or
      // still the same owned link) — never unlink something we no longer own.
      if (!ownedStateMatches(readOwnedTargetState(plan.target), plan.expect)) {
        return "skipped — changed since plan";
      }
      atomicRepoint(plan.source, plan.target);
      return `installed → ${plan.source}`;
    }
    case "already-linked":
      return "already current (no change)";
    case "exists-other":
      return `SKIPPED — existing hook (${plan.details}); leave it alone`;
    case "not-a-git-repo":
      return "skipped (not a git repo)";
    case "skipped":
      return "skipped (--no-install-hooks)";
  }
}

// Re-read the current on-disk identity of a hook target for the AC-5
// changed-since-plan check. Anything that isn't "absent" or a readable symlink
// is "other" — which never matches an install plan's expectation, so we skip.
function readOwnedTargetState(target: string): OwnedTargetState | { kind: "other" } {
  let st;
  try { st = lstatSync(target); }
  catch { return { kind: "absent" }; }
  if (!st.isSymbolicLink()) return { kind: "other" };
  try { return { kind: "owned-link", linkTarget: readlinkSync(target) }; }
  catch { return { kind: "other" }; }
}

function ownedStateMatches(now: OwnedTargetState | { kind: "other" }, expect: OwnedTargetState): boolean {
  if (expect.kind === "absent") return now.kind === "absent";
  return now.kind === "owned-link" && now.linkTarget === expect.linkTarget;
}

// FG-582 (FIX 3): repoint atomically. Create the new link at a temp name in the
// same dir and rename() it over the target — an atomic replace on the same
// filesystem — so .git/hooks/commit-msg is never momentarily absent (a
// concurrent commit can't slip through an unguarded window).
function atomicRepoint(source: string, target: string): void {
  const tmp = join(dirname(target), `.commit-msg.forge-${process.pid}.tmp`);
  try { unlinkSync(tmp); } catch { /* no stale temp to clear */ }
  symlinkSync(source, tmp);
  renameSync(tmp, target);
}

function describeHookPlan(plan: HookPlan): string {
  switch (plan.action) {
    case "install":          return `WOULD install symlink → ${plan.source}`;
    case "already-linked":   return "already current (no change)";
    case "exists-other":     return `WOULD SKIP — existing hook (${plan.details})`;
    case "not-a-git-repo":   return "skipped (not a git repo)";
    case "skipped":          return "skipped (--no-install-hooks)";
  }
}

const BACKLOG_SUBDIRS = ["stories", "epics", "ideas", "done"] as const;

// Scaffold the structured backlog layout under <projectDir>/backlog/. Idempotent
// — skips any path that already exists. Returns a summary string.
export function scaffoldBacklogDirs(projectDir: string): string {
  const backlogDir = join(projectDir, "backlog");
  const created: string[] = [];
  for (const sub of BACKLOG_SUBDIRS) {
    const p = join(backlogDir, sub);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      created.push(sub + "/");
    }
  }
  const notesPath = join(backlogDir, "notes.md");
  if (!existsSync(notesPath)) {
    writeFileSync(notesPath, "# Notes\n");
    created.push("notes.md");
  }
  return created.length > 0 ? `created ${created.join(", ")}` : "already exists (no-op)";
}

function describeBacklogScaffoldPlan(projectDir: string): string {
  const backlogDir = join(projectDir, "backlog");
  const missing: string[] = [];
  for (const sub of BACKLOG_SUBDIRS) {
    if (!existsSync(join(backlogDir, sub))) missing.push(sub + "/");
  }
  if (!existsSync(join(backlogDir, "notes.md"))) missing.push("notes.md");
  return missing.length > 0 ? `WOULD create ${missing.join(", ")}` : "already exists (no-op)";
}

// Copy a seed file into the .forge/ dir when the target doesn't exist yet.
// Never overwrites. Returns a one-line status string.
export function provisionSeedFile(forgeDir: string, targetName: string, seedName: string): string {
  const targetPath = join(forgeDir, targetName);
  if (existsSync(targetPath)) return "already exists (no-op)";
  const seedPath = resolveSeedPath(seedName);
  if (!seedPath) return `skipped (seed ${seedName} not found)`;
  copyFileSync(seedPath, targetPath);
  return "created";
}

function describeSeedProvisionPlan(forgeDir: string, targetName: string): string {
  return existsSync(join(forgeDir, targetName)) ? "already exists" : "WOULD create";
}

// ─────────────────────────────────────────────────────────────────────────────
// FG-546: docs-surfaces provisioning — detect / create / migrate / preserve /
// requires-operator-repair, driven by the shared classifier rather than a bare
// existsSync short-circuit.
//
// WHY THIS IS NOT provisionSeedFile. provisionSeedFile copies only when the
// target is absent and never touches an existing file. That was the bug FG-546
// fixes: the old seed emitted a schema-INVALID object shape, so every project
// initialized before this change holds a file forge's own loader rejects — and
// "preserve whatever exists" left them broken forever. The classifier lets us
// tell forge's own known-legacy generated template (safe to regenerate to the
// corrected bytes) apart from an operator-authored file (valid OR invalid — never
// auto-overwritten). The write side-effect keys off the VERDICT, never off file
// existence.
// ─────────────────────────────────────────────────────────────────────────────

export type DocsSurfacesProvisionOutcome =
  | { action: "created"; path: string }
  | { action: "migrated"; path: string }
  | { action: "preserved"; path: string }
  | { action: "requires-operator-repair"; path: string; detail: string }
  | { action: "seed-missing"; path: string };

// Provision <projectDir>/.forge/docs-surfaces.yml from the four-way verdict.
// Shared by `forge init` and `forge upgrade` (step 5) so the two paths cannot
// drift. Pure with respect to console output: the caller reports/warns from the
// returned outcome (init and upgrade have different reporting conventions).
export function provisionDocsSurfaces(projectDir: string): DocsSurfacesProvisionOutcome {
  const { verdict, path, detail } = classifyDocsSurfaces(projectDir);
  switch (verdict) {
    case "valid-project":
      // Includes the corrected generated form — so a rerun is a clean no-op.
      return { action: "preserved", path };
    case "customized-invalid":
      // Neither valid nor the known template ⇒ treated as operator-authored.
      // NEVER written over; the caller emits an actionable warning/failure.
      return { action: "requires-operator-repair", path, detail: detail ?? "invalid docs-surfaces config" };
    case "missing": {
      const seedPath = resolveSeedPath("docs-surfaces.example.yml");
      if (!seedPath) return { action: "seed-missing", path };
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(seedPath, path);
      return { action: "created", path };
    }
    case "known-legacy-generated": {
      // The exact frozen legacy object template forge's own seed produced.
      // Migrate by REGENERATING to the corrected seed bytes — there is nothing
      // meaningful to transform out of the placeholder legacy entries.
      const seedPath = resolveSeedPath("docs-surfaces.example.yml");
      if (!seedPath) return { action: "seed-missing", path };
      copyFileSync(seedPath, path);
      return { action: "migrated", path };
    }
  }
}

// One-line status for the real-run report. No leading space: the label
// "docs-surfaces.yml:" is one column wider than the sibling labels, so the value
// column already lines up (see the console.log block above).
export function docsSurfacesStatusLine(outcome: DocsSurfacesProvisionOutcome): string {
  switch (outcome.action) {
    case "created":                   return "created";
    case "migrated":                  return "migrated legacy template → corrected form";
    case "preserved":                 return "already exists (no-op)";
    case "requires-operator-repair":  return "INVALID — left untouched, operator repair required";
    case "seed-missing":              return "skipped (seed docs-surfaces.example.yml not found)";
  }
}

// Dry-run forecast (AC8): which of create / migrate / preserve /
// requires-operator-repair the real run would do — from the SAME classifier, so
// the forecast cannot disagree with what the run then does.
export function describeDocsSurfacesProvisionPlan(projectDir: string): string {
  const { verdict } = classifyDocsSurfaces(projectDir);
  switch (verdict) {
    case "missing":                 return "WOULD create";
    case "known-legacy-generated":  return "WOULD migrate (legacy template → corrected form)";
    case "valid-project":           return "would preserve (already valid, no-op)";
    case "customized-invalid":      return "WOULD SKIP — invalid, requires operator repair (left untouched)";
  }
}

// The actionable warning emitted (never a silent clobber) when a project holds a
// customized-invalid docs-surfaces file. Names the file, the validation error,
// and the repair action. Shared so init and upgrade word it identically.
export function docsSurfacesRepairWarning(path: string, detail: string): string {
  return (
    `⚠ docs-surfaces config at ${path} is invalid (${detail}) and does not match forge's known ` +
    `generated template, so it looks operator-authored — forge left it untouched. Repair: edit it to the ` +
    `{ surfaces: [<path-prefix>, ...] } shape (see seeds/docs-surfaces.example.yml), or delete it and re-run ` +
    `\`forge init\` / \`forge upgrade\` to regenerate the corrected default.`
  );
}

function resolveSeedPath(seedName: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "seeds", seedName),
    join(here, "..", "..", "..", "..", "seeds", seedName),
  ];
  return candidates.find((c) => existsSync(c));
}

// The RACI seed bundled with forge, resolved relative to this source file the
// same way readTemplate() finds the orchestrator template (works under tsx and
// the built dist). Undefined if not found.
function seedRaciPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "seeds", "forge-raci.md"),
    join(here, "..", "..", "..", "..", "seeds", "forge-raci.md"),
  ];
  return candidates.find((c) => existsSync(c));
}

function readTemplate(): string {
  // Resolve the template relative to the source file. After `npm run build`
  // this maps to dist/cli/commands/init.js → ../../../seeds/orchestrator-template.md.
  // Under tsx (`forge` script), the source path is src/cli/commands/init.ts →
  // ../../../seeds/orchestrator-template.md. Same relative offset either way.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "seeds", "orchestrator-template.md"),
    join(here, "..", "..", "..", "..", "seeds", "orchestrator-template.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, "utf8");
  }
  throw new Error(
    `orchestrator template not found. Looked at:\n  ${candidates.join("\n  ")}`
  );
}

export type BlockAction = "replaced" | "repaired" | "appended" | "unchanged" | "needs-markers";
export type BlockResult = { content: string; action: BlockAction; message?: string };

// Human-readable status line for a block action.
function blockStatus(action: BlockAction, hadFile: boolean): string {
  switch (action) {
    case "replaced": return "updated orchestrator block";
    case "repaired": return "repaired + updated orchestrator block (inserted missing marker)";
    case "appended": return hadFile ? "appended orchestrator block" : "created with orchestrator block";
    case "unchanged": return "already current (no change)";
    case "needs-markers": return "block left untouched — needs manual markers (see warning)";
  }
}

// Splice the template's orchestrator block (the region between the template's
// own markers) into `existing`, replacing the region between its start/end
// markers. Head (before start) and tail (after end — e.g. project-specific
// "Stack + project context") are preserved verbatim.
function spliceBlock(existing: string, template: string, startIdx: number, endIdx: number): string {
  const endLineEnd = existing.indexOf("\n", endIdx + END_MARKER.length);
  const tail = endLineEnd >= 0 ? existing.slice(endLineEnd + 1) : "";
  const head = existing.slice(0, startIdx);

  const tmplStartIdx = template.indexOf(START_MARKER);
  const tmplEndIdx = template.indexOf(END_MARKER);
  let block: string;
  if (tmplStartIdx >= 0 && tmplEndIdx > tmplStartIdx) {
    const tmplEndLineEnd = template.indexOf("\n", tmplEndIdx + END_MARKER.length);
    block = tmplEndLineEnd >= 0
      ? template.slice(tmplStartIdx, tmplEndLineEnd + 1)
      : template.slice(tmplStartIdx);
  } else {
    block = template;
  }

  const headJoin = head && !head.endsWith("\n\n") ? (head.endsWith("\n") ? "\n" : "\n\n") : "";
  const tailJoin = tail ? (tail.startsWith("\n") ? "" : "\n") : "";
  return head + headJoin + ensureTrailingNewline(block) + tailJoin + tail;
}

// Index of the `# forge orchestrator` heading at a line start, at or before
// `before`. -1 if absent.
function headingIdxBefore(existing: string, before: number): number {
  let idx = existing.lastIndexOf(ORCH_HEADING, before);
  while (idx > 0) {
    if (existing[idx - 1] === "\n") return idx;
    idx = existing.lastIndexOf(ORCH_HEADING, idx - 1);
  }
  return idx === 0 ? 0 : -1;
}

function lineOf(s: string, idx: number): number {
  return s.slice(0, idx).split("\n").length;
}

// Decide how to apply the orchestrator block. NEVER throws (#231) — returns an
// action so callers can message and, crucially, still provision commands/hooks.
//   - balanced markers        → replace in place
//   - lone END + heading      → repair: insert the missing start before the
//                               heading, then replace (the Pixtron case)
//   - lone START, or unfenced  → "needs-markers": the end boundary can't be
//     legacy block (no markers) inferred without risking the project-specific
//                               tail, so ask for manual markers (don't guess /
//                               duplicate)
//   - genuinely no block      → append a fresh fenced block
// Exported for testing.
export function applyOrchestratorBlock(existing: string, template: string): BlockResult {
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  // Balanced markers → replace in place.
  if (startIdx >= 0 && endIdx > startIdx) {
    const content = spliceBlock(existing, template, startIdx, endIdx);
    return { content, action: content === existing ? "unchanged" : "replaced" };
  }

  // Lone END marker → repair if a heading anchors the missing start.
  if (startIdx < 0 && endIdx >= 0) {
    const hIdx = headingIdxBefore(existing, endIdx);
    if (hIdx >= 0) {
      const repaired = existing.slice(0, hIdx) + START_MARKER + "\n\n" + existing.slice(hIdx);
      return {
        content: spliceBlock(repaired, template, repaired.indexOf(START_MARKER), repaired.indexOf(END_MARKER)),
        action: "repaired",
      };
    }
    return {
      content: existing,
      action: "needs-markers",
      message: `'${END_MARKER}' present with no matching start marker and no '${ORCH_HEADING}' heading to anchor it — add '${START_MARKER}' where the block begins, then re-run.`,
    };
  }

  // Lone START marker → end boundary unknown; don't guess.
  if (startIdx >= 0 && endIdx < 0) {
    return {
      content: existing,
      action: "needs-markers",
      message: `'${START_MARKER}' present with no matching '${END_MARKER}' — add the end marker after the orchestrator block (before any project-specific content), then re-run.`,
    };
  }

  // No markers at all.
  const hIdx = headingIdxBefore(existing, existing.length);
  if (hIdx >= 0) {
    // Unfenced legacy block: the end boundary is ambiguous (block vs your
    // project-specific tail), so repairing it automatically could swallow or
    // duplicate content. Manual markers only.
    return {
      content: existing,
      action: "needs-markers",
      message: `unfenced '${ORCH_HEADING}' block at line ${lineOf(existing, hIdx)} with no markers — add '${START_MARKER}' before it and '${END_MARKER}' after the block (before your project-specific sections), then re-run. forge can't infer the block's end safely.`,
    };
  }

  // Genuinely no block → append a fresh fenced one.
  if (existing.length === 0) {
    return { content: ensureTrailingNewline(template), action: "appended" };
  }
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: existing + sep + ensureTrailingNewline(template), action: "appended" };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// #153: Claude Code session hooks (heartbeats for orchestrator liveness).
// ─────────────────────────────────────────────────────────────────────────────

export type ClaudeHooksPlan =
  | { action: "install"; settingsPath: string; source: string; details: string; legacyCleanup: boolean }
  | { action: "already-current"; settingsPath: string; legacyCleanup: boolean }
  | { action: "corrupt-json"; settingsPath: string; details: string }
  | { action: "skipped" };

// Decides what to do for the Claude Code session hooks without writing.
// Targets settings.local.json (per-developer, gitignored) — NOT settings.json
// (project-shared, committed). Detects legacy installs that wrote into
// settings.json and flags them for cleanup so the absolute-path hook commands
// don't poison committed config.
// Exported for testing.
export function planClaudeHooks(projectDir: string): ClaudeHooksPlan {
  const claudeDir = join(projectDir, ".claude");
  const settingsPath = join(claudeDir, LOCAL_SETTINGS_FILENAME);
  const legacyPath = join(claudeDir, LEGACY_SETTINGS_FILENAME);
  const legacyCleanup = legacySettingsHasForgeHooks(legacyPath);
  const source = resolveHeartbeatSource();
  if (!existsSync(settingsPath)) {
    const details = legacyCleanup
      ? `create new .claude/${LOCAL_SETTINGS_FILENAME} + cleanup legacy ${LEGACY_SETTINGS_FILENAME}`
      : `create new .claude/${LOCAL_SETTINGS_FILENAME}`;
    return { action: "install", settingsPath, source, details, legacyCleanup };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    return { action: "corrupt-json", settingsPath, details: (e as Error).message };
  }
  const hooks = (isObject(parsed) && isObject(parsed["hooks"])) ? parsed["hooks"] : {};
  const needs: string[] = [];
  for (const [event, action] of CLAUDE_HOOK_EVENTS) {
    if (!hasCurrentForgeHook(hooks[event], source, action)) needs.push(event);
  }
  if (needs.length === 0 && !legacyCleanup) {
    return { action: "already-current", settingsPath, legacyCleanup: false };
  }
  const installDetails = needs.length === 0
    ? `migrate legacy ${LEGACY_SETTINGS_FILENAME} hooks → ${LOCAL_SETTINGS_FILENAME}`
    : `merge into existing ${LOCAL_SETTINGS_FILENAME} (events: ${needs.join(", ")})${legacyCleanup ? ` + cleanup legacy ${LEGACY_SETTINGS_FILENAME}` : ""}`;
  return { action: "install", settingsPath, source, details: installDetails, legacyCleanup };
}

// True when the legacy committed settings.json contains forge heartbeat hook
// entries (detected by the orchestrator-heartbeat command substring). Used to
// trigger one-time migration on init/upgrade for projects installed before
// the per-developer convention shipped.
function legacySettingsHasForgeHooks(legacyPath: string): boolean {
  if (!existsSync(legacyPath)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(legacyPath, "utf8")); }
  catch { return false; }
  if (!isObject(parsed) || !isObject(parsed["hooks"])) return false;
  const hooks = parsed["hooks"];
  for (const [event] of CLAUDE_HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isObject(entry) || !Array.isArray(entry["hooks"])) continue;
      for (const h of entry["hooks"]) {
        if (isObject(h) && typeof h["command"] === "string" && h["command"].includes(HEARTBEAT_MARKER)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function executeClaudeHooksPlan(plan: ClaudeHooksPlan): string {
  if (plan.action === "skipped")         return "skipped (--no-install-hooks)";
  if (plan.action === "corrupt-json")    return `SKIPPED — ${LOCAL_SETTINGS_FILENAME} not valid JSON (${plan.details})`;
  if (plan.action === "already-current") return "already current (no change)";

  const { settingsPath, source, legacyCleanup } = plan;
  const settingsDir = dirname(settingsPath);
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });

  // 1. Install/merge into .claude/settings.local.json (per-developer).
  let parsed: Record<string, unknown> = {};
  const fileExisted = existsSync(settingsPath);
  if (fileExisted) {
    const raw = readFileSync(settingsPath, "utf8");
    const decoded = JSON.parse(raw);
    if (isObject(decoded)) parsed = decoded;
  }
  const hooksRoot: Record<string, unknown> = isObject(parsed["hooks"]) ? parsed["hooks"] : {};
  for (const [event, action] of CLAUDE_HOOK_EVENTS) {
    const command = `${source} ${action}`;
    const entries = Array.isArray(hooksRoot[event]) ? hooksRoot[event] as unknown[] : [];
    let replaced = false;
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const innerHooks = entry["hooks"];
      if (!Array.isArray(innerHooks)) continue;
      for (const h of innerHooks) {
        if (!isObject(h)) continue;
        const cmd = h["command"];
        if (typeof cmd === "string" && cmd.includes(HEARTBEAT_MARKER)) {
          h["command"] = command;
          if (h["type"] === undefined) h["type"] = "command";
          replaced = true;
        }
      }
    }
    if (!replaced) {
      entries.push({ matcher: "", hooks: [{ type: "command", command }] });
    }
    hooksRoot[event] = entries;
  }
  parsed["hooks"] = hooksRoot;
  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");

  // 2. Legacy cleanup: strip forge heartbeat entries from .claude/settings.json
  // so the committed file doesn't keep the absolute-path commands. Preserve
  // user's other hooks + non-hook config.
  let cleanupMsg = "";
  if (legacyCleanup) {
    cleanupMsg = stripForgeHooksFromLegacy(join(settingsDir, LEGACY_SETTINGS_FILENAME));
  }

  const installMsg = fileExisted
    ? `merged into existing .claude/${LOCAL_SETTINGS_FILENAME}`
    : `created .claude/${LOCAL_SETTINGS_FILENAME}`;
  return cleanupMsg ? `${installMsg}; ${cleanupMsg}` : installMsg;
}

// Remove the forge heartbeat hook entries from .claude/settings.json (legacy
// install location). Preserves user's other hook entries (matchers with
// commands that don't contain HEARTBEAT_MARKER) and every other key. Removes
// now-empty event arrays. Removes the hooks key entirely if it ends up empty.
// If the resulting file would be `{}`, deletes the file.
function stripForgeHooksFromLegacy(legacyPath: string): string {
  if (!existsSync(legacyPath)) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(legacyPath, "utf8")); }
  catch { return ""; }
  if (!isObject(parsed) || !isObject(parsed["hooks"])) return "";

  const hooks = parsed["hooks"];
  let removed = 0;
  for (const [event] of CLAUDE_HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (!isObject(entry) || !Array.isArray(entry["hooks"])) { kept.push(entry); continue; }
      const innerKept = entry["hooks"].filter((h) => {
        const isForge = isObject(h) && typeof h["command"] === "string" && h["command"].includes(HEARTBEAT_MARKER);
        if (isForge) removed += 1;
        return !isForge;
      });
      if (innerKept.length > 0) kept.push({ ...entry, hooks: innerKept });
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete parsed["hooks"];

  if (Object.keys(parsed).length === 0) {
    // File reduces to empty object — delete it rather than leave a dangling {}.
    unlinkSyncSafe(legacyPath);
    return `removed empty legacy ${LEGACY_SETTINGS_FILENAME}`;
  }
  writeFileSync(legacyPath, JSON.stringify(parsed, null, 2) + "\n");
  return `stripped ${removed} forge hook entry/entries from legacy ${LEGACY_SETTINGS_FILENAME}`;
}

function unlinkSyncSafe(path: string): void {
  try { unlinkSync(path); } catch { /* best-effort */ }
}

function describeClaudeHooksPlan(plan: ClaudeHooksPlan): string {
  switch (plan.action) {
    case "install":         return `WOULD install (${plan.details})`;
    case "already-current": return plan.legacyCleanup ? `WOULD migrate legacy ${LEGACY_SETTINGS_FILENAME} hooks` : "already current (no change)";
    case "corrupt-json":    return `WOULD SKIP — ${LOCAL_SETTINGS_FILENAME} not valid JSON (${plan.details})`;
    case "skipped":         return "skipped (--no-install-hooks)";
  }
}

function hasCurrentForgeHook(entries: unknown, source: string, action: string): boolean {
  if (!Array.isArray(entries)) return false;
  const expected = `${source} ${action}`;
  return entries.some((e) => {
    if (!isObject(e)) return false;
    const inner = e["hooks"];
    if (!Array.isArray(inner)) return false;
    return inner.some((h) => isObject(h) && typeof h["command"] === "string" && h["command"] === expected);
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveHeartbeatSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "scripts", "claude-hooks", "orchestrator-heartbeat"),
    join(here, "..", "..", "..", "..", "scripts", "claude-hooks", "orchestrator-heartbeat"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `claude-hooks heartbeat source not found. Looked at:\n  ${candidates.join("\n  ")}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FG-253: project-scoped operator adapters (/orient + /handoff, on every
// provider surface that has one).
//
// WHAT CHANGED, AND WHY. These files used to be SYMLINKS into the forge
// checkout's scripts/claude-commands/*.md. A symlink cannot carry a release
// stamp, and a committed absolute link is dead in every other clone — so a
// project could neither be told which release its guidance came from nor be
// checked for drift. They are now MATERIALIZED BYTES rendered from the
// provider-neutral definition, one file per (surface, workflow).
//
// OWNERSHIP IS DECIDED FROM THE BYTES ON DISK. Never from a record of what
// forge previously wrote: projects get cloned, forge gets reinstalled at a new
// path, and any install-time memory mis-fires on the copy. A file carrying the
// forge ownership marker is forge's and is freely refreshed; a legacy symlink
// into `scripts/claude-commands/<name>.md` is forge's own prior artifact and is
// migrated to bytes; ANYTHING ELSE at a target path is FOREIGN — reported,
// never written over, and RESOLVED rather than a failure, because a project
// that deliberately owns its own /orient is not a broken project.
//
// WHAT IS OUT OF THE WRITE SET ENTIRELY. AGENTS.md, CLAUDE.md prose outside the
// orchestrator marker block, any Codex config or CODEX_HOME, and every
// `.agents/skills/<name>` directory outside FORGE_OWNED_CODEX_SKILL_DIRS. None
// of them is read for splicing, written, or deleted here — the installer's
// whole write set is the rendered target list below.
//
// DEPRECATED CODEX CUSTOM PROMPTS ARE NOT USED. The target list is asserted
// disjoint from CODEX_DEPRECATED_PROMPT_DIRS.
// ─────────────────────────────────────────────────────────────────────────────

/** Which provider surface a target belongs to. Reported, not inferred from the
 *  path, so a future surface cannot be mistaken for an existing one. */
export type AdapterSurfaceKind = "claude-command" | "codex-skill";

/** What the planner found at a target path. `foreign` carries its reason so the
 *  operator is told WHY forge declined, not merely that it did. */
export type AdapterOnDisk =
  | { kind: "absent" }
  | { kind: "forge-owned"; stamp: AdapterStamp; bytes: string }
  | { kind: "legacy-symlink"; linkTarget: string }
  | { kind: "foreign"; reason: string };

/** The decision for one target. `override` is the operator-owns-this outcome:
 *  reported and resolved, never an error. */
export type AdapterDecision = "install" | "refresh" | "migrate" | "already-current" | "override";

export type AdapterEntry = {
  workflow: OperatorWorkflowId;
  surface: AdapterSurfaceKind;
  /** How an operator names this thing: `/orient`, or `forge-orient`. */
  label: string;
  /** Legacy display name, kept so the pre-FG-253 `forge upgrade` reporting path
   *  keeps rendering the Claude half exactly as it did. Step 5 replaces it. */
  name: string;
  /** Repo-relative, POSIX — the identity that appears in reports and --json. */
  relPath: string;
  /** Absolute path under the project dir. */
  target: string;
  decision: AdapterDecision;
  details?: string;
  /** The bytes this release renders for the target. */
  bytes: string;
  /** What the planner saw, re-verified before execute mutates anything. */
  observed: AdapterOnDisk;
};

/** Kept as `ClaudeCommandsPlan` too (below) so `forge upgrade` compiles and
 *  behaves unchanged until step 5 gives adapters their own upgrade step. */
export type OperatorAdaptersPlan =
  | { action: "install"; projectDir: string; stamp: AdapterStamp; entries: AdapterEntry[]; absentSurfaces: readonly OperatorSurface[] }
  | { action: "already-current"; projectDir: string; stamp: AdapterStamp; entries: AdapterEntry[]; absentSurfaces: readonly OperatorSurface[] }
  | { action: "skipped" };

// ── The release stamp embedded in every rendered adapter ─────────────────────

/** The identity of the forge that rendered a project's adapters. Re-exported from
 *  the one resolver rather than computed here: the drift detector (step 6) and the
 *  launch-boundary check (step 8) must answer "which forge rendered this?" the same
 *  way this installer does, and for a while they did not — see ./adapter-stamp.ts.
 *
 *  A stamp does NOT change when only the checkout's content changes under a
 *  release, which is why already-current is decided by comparing BYTES (below) and
 *  not stamps: editing the definition and re-running `forge init` still refreshes
 *  the files, the way the old symlink propagated an edit. */
export { currentAdapterStamp };

// ── Rendering → targets ──────────────────────────────────────────────────────

type RenderedTarget = {
  workflow: OperatorWorkflowId;
  surface: AdapterSurfaceKind;
  label: string;
  name: string;
  relPath: string;
  bytes: string;
};

/** Every file forge would write for `stamp`, derived from OPERATOR_SURFACES so a
 *  surface that renders nothing (the generic fallback) contributes nothing — the
 *  documented absence is structural here, not a special case someone remembers. */
export function renderedAdapterTargets(stamp: AdapterStamp): readonly RenderedTarget[] {
  const out: RenderedTarget[] = [];
  for (const surface of OPERATOR_SURFACES) {
    if (isDocumentedAbsence(surface)) continue;
    const renders = new Set<OperatorWorkflowId>(surface.renders);
    if (surface.id === "claude-code") {
      for (const r of renderClaudeCommands(stamp)) {
        if (!renders.has(r.workflow)) continue;
        out.push({
          workflow: r.workflow,
          surface: "claude-command",
          label: r.slashCommand,
          name: `${r.workflow}.md`,
          relPath: r.path,
          bytes: r.bytes,
        });
      }
    } else if (surface.id === "codex") {
      for (const r of renderCodexSkills(stamp)) {
        if (!renders.has(r.workflow)) continue;
        out.push({
          workflow: r.workflow,
          surface: "codex-skill",
          label: r.skillName,
          name: `${r.skillName}/SKILL.md`,
          relPath: r.path,
          bytes: r.contents,
        });
      }
    }
    // A surface forge has no renderer for contributes nothing rather than
    // guessing a layout — an unwritten file is recoverable; a file written into
    // a guessed location in somebody's repo is not.
  }
  return out;
}

/** The surfaces that deliberately render no files. Reported so `forge init`'s
 *  answer for a generic provider is the honest one — the CLI is the interface —
 *  rather than a silence that reads like a missing feature. */
export function documentedAbsenceSurfaces(): readonly OperatorSurface[] {
  return OPERATOR_SURFACES.filter(isDocumentedAbsence);
}

// ── Planning ─────────────────────────────────────────────────────────────────

export function planOperatorAdapters(projectDir: string, stamp: AdapterStamp = currentAdapterStamp()): OperatorAdaptersPlan {
  const entries: AdapterEntry[] = [];
  for (const t of renderedAdapterTargets(stamp)) {
    const target = join(projectDir, ...t.relPath.split("/"));
    const observed = classifyAdapterTarget(target, projectDir, t.surface);
    entries.push({ ...t, target, observed, ...decide(observed, t.bytes) });
  }
  const absentSurfaces = documentedAbsenceSurfaces();
  const anyWork = entries.some((e) => e.decision === "install" || e.decision === "refresh" || e.decision === "migrate");
  return anyWork
    ? { action: "install", projectDir, stamp, entries, absentSurfaces }
    : { action: "already-current", projectDir, stamp, entries, absentSurfaces };
}

function decide(observed: AdapterOnDisk, rendered: string): { decision: AdapterDecision; details?: string } {
  switch (observed.kind) {
    case "absent":
      return { decision: "install" };
    case "forge-owned":
      // Byte comparison, not stamp comparison: it converges on a stamp refresh
      // AND on a definition edit under an unchanged dev stamp, and it cannot
      // report "current" for a file whose content someone changed by hand.
      return observed.bytes === rendered
        ? { decision: "already-current" }
        : { decision: "refresh", details: `forge-owned, stamp ${observed.stamp} → rewrite` };
    case "legacy-symlink":
      return { decision: "migrate", details: `legacy forge symlink → ${observed.linkTarget}` };
    case "foreign":
      return { decision: "override", details: observed.reason };
  }
}

/** Read the identity of a target path from the FILESYSTEM.
 *
 *  Two refusals matter more than the rest:
 *   - lstat, never stat: a symlink is classified as a symlink, so bytes are only
 *     ever read from — and written to — a REGULAR FILE. Writing through a link
 *     would let a link planted at an adapter path redirect forge's write
 *     anywhere the user can write.
 *   - containment: the deepest existing ancestor of the target must resolve
 *     inside the project. A `.claude/commands` symlinked out of the tree is
 *     foreign, not a write target. */
function classifyAdapterTarget(target: string, projectDir: string, surface: AdapterSurfaceKind): AdapterOnDisk {
  const escape = containmentProblem(target, projectDir);
  if (escape) return { kind: "foreign", reason: escape };

  let st;
  try { st = lstatSync(target); }
  catch { return { kind: "absent" }; }

  if (st.isSymbolicLink()) {
    let linkTarget = "";
    try { linkTarget = readlinkSync(target); }
    catch { return { kind: "foreign", reason: "unreadable symlink" }; }
    if (surface === "claude-command" && isLegacyForgeSlashCommandLink(linkTarget, basename(target))) {
      return { kind: "legacy-symlink", linkTarget };
    }
    return { kind: "foreign", reason: `symlink → ${linkTarget} (project override)` };
  }
  if (!st.isFile()) {
    return { kind: "foreign", reason: st.isDirectory() ? "a directory is at this path" : "not a regular file" };
  }
  let bytes: string;
  try { bytes = readFileSync(target, "utf8"); }
  catch (e) { return { kind: "foreign", reason: `unreadable (${(e as Error).message})` }; }
  const stamp = parseAdapterMarker(bytes);
  if (stamp === null) {
    return { kind: "foreign", reason: "regular file with no forge ownership marker (project override)" };
  }
  return { kind: "forge-owned", stamp, bytes };
}

/** Non-null when the directory forge would write into is not a real directory
 *  inside the project.
 *
 *  The walk uses lstat, never existsSync: existsSync FOLLOWS links, so a dangling
 *  `.claude/commands` symlink would read as "not there", we would try to mkdir it,
 *  and node throws EEXIST — `forge init` dying on a symlink somebody left behind.
 *  A directory entry that exists as a link is a thing to classify, not a hole to
 *  fill. Refusals returned here surface as project overrides: reported, not
 *  written over, not fatal. */
function containmentProblem(target: string, projectDir: string): string | null {
  // FG-693: the containment root is a PROVEN physical path or the write is
  // refused. The old local realpath-with-lexical-fallback handed a guessed root
  // to a prefix comparison that reads as though it proved containment; a root
  // nobody could resolve proves nothing, and this walk decides whether forge
  // writes into a directory.
  const rootIdentity = identify(projectDir);
  if (rootIdentity.kind !== "resolved") {
    return `refusing to write: the project dir ${describeIdentity(rootIdentity)} does not resolve, so containment cannot be established`;
  }
  const root = rootIdentity.physical;
  let probe = dirname(target);
  while (!entryExists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return `no existing ancestor directory under ${projectDir}`;
    probe = parent;
  }
  const probeIdentity = identify(probe);
  if (probeIdentity.kind !== "resolved") {
    return `refusing to write: ${probe} does not resolve (dangling symlink)`;
  }
  const real = probeIdentity.physical;
  if (!(real === root || real.startsWith(root + sep))) {
    return `refusing to write: ${probe} resolves to ${real}, outside the project at ${root}`;
  }
  try {
    if (!statSync(real).isDirectory()) return `refusing to write: ${probe} is not a directory`;
  } catch {
    return `refusing to write: ${probe} is unreadable`;
  }
  return null;
}

/** Does a directory ENTRY exist here — link or not? lstat, so a dangling symlink
 *  answers yes. */
function entryExists(p: string): boolean {
  try { lstatSync(p); return true; }
  catch { return false; }
}

// ── Execution ────────────────────────────────────────────────────────────────

export type AdapterApplied = "written" | "unchanged" | "left-alone" | "skipped-changed";

export type AdapterOutcome = {
  relPath: string;
  /** Absolute path, so a report can name the file the operator would go look at. */
  target: string;
  surface: AdapterSurfaceKind;
  label: string;
  name: string;
  decision: AdapterDecision;
  applied: AdapterApplied;
  details?: string;
};

export type AdapterExecution = { summary: string; outcomes: readonly AdapterOutcome[] };

export function executeOperatorAdapters(plan: OperatorAdaptersPlan): AdapterExecution {
  if (plan.action === "skipped") return { summary: "skipped (--no-install-hooks)", outcomes: [] };

  const outcomes: AdapterOutcome[] = [];
  for (const e of plan.entries) {
    const outcome = (applied: AdapterApplied, details?: string): AdapterOutcome => ({
      relPath: e.relPath,
      target: e.target,
      surface: e.surface,
      label: e.label,
      name: e.name,
      decision: e.decision,
      applied,
      ...(details ? { details } : {}),
    });

    if (e.decision === "override") {
      // The one outcome that needs no re-read: it is a claim about what forge DID
      // (nothing), not about what is on disk now.
      outcomes.push(outcome("left-alone", e.details));
      continue;
    }
    // Between planning and now the target could have been replaced — including by a
    // symlink aimed somewhere sensitive. Re-read its identity, and report a state
    // only if it still is what the planner classified. `already-current` is in here
    // too: "already current (no change)" is an assertion about the bytes on disk, so
    // a run that skipped the re-read for it would be reporting the plan's reading of
    // a file it never looked at again.
    const now = classifyAdapterTarget(e.target, plan.projectDir, e.surface);
    if (!observedMatches(now, e.observed)) {
      outcomes.push(outcome("skipped-changed", `target changed since the plan was made (now: ${describeObserved(now)})`));
      continue;
    }
    if (e.decision === "already-current") {
      outcomes.push(outcome("unchanged"));
      continue;
    }
    mkdirSync(dirname(e.target), { recursive: true });
    atomicWrite(e.target, e.bytes);
    outcomes.push(outcome("written", e.details));
  }
  return { summary: summarizeAdapterOutcomes(outcomes), outcomes };
}

function observedMatches(now: AdapterOnDisk, expected: AdapterOnDisk): boolean {
  if (now.kind !== expected.kind) return false;
  if (now.kind === "forge-owned" && expected.kind === "forge-owned") return now.bytes === expected.bytes;
  if (now.kind === "legacy-symlink" && expected.kind === "legacy-symlink") return now.linkTarget === expected.linkTarget;
  // `absent` matches `absent`; a `foreign` re-read never reaches here (foreign
  // is decided as `override` and never mutated).
  return now.kind === "absent";
}

function describeObserved(o: AdapterOnDisk): string {
  switch (o.kind) {
    case "absent":         return "absent";
    case "forge-owned":    return `forge-owned (stamp ${o.stamp})`;
    case "legacy-symlink": return `legacy symlink → ${o.linkTarget}`;
    case "foreign":        return o.reason;
  }
}

/** Write via a same-directory temp + rename(2): the target is never a truncated
 *  half-file a session could read, and the rename REPLACES a legacy symlink's
 *  directory entry rather than writing through it.
 *
 *  The temp name is UNPREDICTABLE and the create is EXCLUSIVE (`wx` → O_CREAT|
 *  O_EXCL, which also refuses to follow a symlink at that name). It used to be a
 *  deterministic PID-derived name that was unlinked and then opened: both halves
 *  of that are the same defect — the name can be computed by anyone who can read
 *  the process table, and unlink-then-open is a window in which a link planted at
 *  that name redirects the write to any file the operator can write. Random name
 *  plus O_EXCL means this call CREATES the file it writes or it fails.
 *
 *  Residual, stated rather than hidden: classification and write are two syscall
 *  sequences, so a racing local process could still swap a component between
 *  them. Closing that needs openat/O_NOFOLLOW, which node does not expose. What
 *  IS closed is the durable version — a link or file planted BEFORE the run,
 *  which is the realistic shape here (a repo checked out with someone else's
 *  content at an adapter path), because the re-read happens after the plan the
 *  operator saw. */
function atomicWrite(target: string, bytes: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.forge-${randomBytes(12).toString("hex")}.tmp`);
  writeFileSync(tmp, bytes, { flag: "wx" });
  try {
    renameSync(tmp, target);
  } catch (e) {
    // An unpredictable name is not self-cleaning the way the PID-derived one was,
    // so the only run that can remove a temp this call leaked is this one.
    try { unlinkSync(tmp); } catch { /* nothing left to clear */ }
    throw e;
  }
}

function summarizeAdapterOutcomes(outcomes: readonly AdapterOutcome[]): string {
  const written = outcomes.filter((o) => o.applied === "written");
  const unchanged = outcomes.filter((o) => o.applied === "unchanged");
  const overrides = outcomes.filter((o) => o.applied === "left-alone");
  const stale = outcomes.filter((o) => o.applied === "skipped-changed");
  const parts: string[] = [];
  if (written.length)    parts.push(`wrote ${written.length} (${written.map((o) => o.label).join(", ")})`);
  if (unchanged.length)  parts.push(`${unchanged.length} already current`);
  if (overrides.length)  parts.push(`SKIPPED ${overrides.length} project override(s): ${overrides.map((o) => `${o.relPath} (${o.details ?? "exists"})`).join(", ")}`);
  if (stale.length)      parts.push(`SKIPPED ${stale.length} changed-since-plan: ${stale.map((o) => o.relPath).join(", ")}`);
  return parts.join("; ") || "no-op";
}

// ── Reporting: one decision list, rendered by both --dry-run and the real run ─

export type AdapterPlannedDecision = { relPath: string; label: string; decision: AdapterDecision; details?: string };

/** The per-file decisions a plan carries. `--dry-run` prints THIS and the real
 *  run executes THIS, so "the dry run predicts the real run" is a property of
 *  there being one list, not of two code paths agreeing by inspection. */
export function adapterDecisions(plan: OperatorAdaptersPlan): readonly AdapterPlannedDecision[] {
  if (plan.action === "skipped") return [];
  return plan.entries.map((e) => ({ relPath: e.relPath, label: e.label, decision: e.decision, details: e.details }));
}

function decisionVerb(d: AdapterDecision, mode: "would" | "did"): string {
  switch (d) {
    case "install":         return mode === "would" ? "WOULD install" : "installed";
    case "refresh":         return mode === "would" ? "WOULD refresh" : "refreshed";
    case "migrate":         return mode === "would" ? "WOULD migrate legacy symlink → bytes" : "migrated legacy symlink → bytes";
    case "already-current": return "already current (no change)";
    case "override":        return "project override — LEFT ALONE";
  }
}

/** What `--dry-run` prints: one line per planned decision, plus the documented
 *  absences. */
export function adapterReportLines(plan: OperatorAdaptersPlan): string[] {
  if (plan.action === "skipped") return ["    skipped (--no-install-hooks)"];
  const lines = adapterDecisions(plan).map(
    (d) => `    ${d.relPath}: ${decisionVerb(d.decision, "would")}${d.details ? ` (${d.details})` : ""}`,
  );
  return lines.concat(absenceLines(plan));
}

/** What the REAL run prints: one line per OUTCOME, not per planned decision.
 *
 *  These must not be the same function reading the plan twice. A target that
 *  changed between plan and execute is skipped — and a report generated from the
 *  plan would print "installed" for a file forge deliberately did not write,
 *  which is exactly the false claim this ticket's threat model puts first. */
export function adapterOutcomeLines(plan: OperatorAdaptersPlan, outcomes: readonly AdapterOutcome[]): string[] {
  if (plan.action === "skipped") return ["    skipped (--no-install-hooks)"];
  const lines = outcomes.map((o) => `    ${o.relPath}: ${outcomeVerb(o)}${o.details ? ` (${o.details})` : ""}`);
  return lines.concat(absenceLines(plan));
}

function outcomeVerb(o: AdapterOutcome): string {
  switch (o.applied) {
    case "written":         return decisionVerb(o.decision, "did");
    case "unchanged":       return decisionVerb("already-current", "did");
    case "left-alone":      return decisionVerb("override", "did");
    case "skipped-changed": return "SKIPPED — target changed since the plan";
  }
}

function absenceLines(plan: Exclude<OperatorAdaptersPlan, { action: "skipped" }>): string[] {
  return plan.absentSurfaces.map((s) => `    ${s.id}: no files — ${s.operatorAnswer}`);
}

/** The targets a project already owns, so forge leaves them alone. Plan-derived,
 *  which is what a `--dry-run` has and all it can honestly report: nothing ran. */
export function operatorAdapterOverrides(plan: OperatorAdaptersPlan): AdapterEntry[] {
  if (plan.action === "skipped") return [];
  return plan.entries.filter((e) => e.decision === "override");
}

/** The same list for a run that ACTUALLY EXECUTED, derived from outcomes.
 *
 *  Not the same set as the plan's, and that is the point. A target the plan meant to
 *  install, that someone owned between the plan and the write, is skipped by the
 *  re-read — forge did not install it and did not clobber it, which is exactly the
 *  fact this list exists to carry. Read off the plan, that file would be reported as
 *  installed and would appear in no override list at all. */
export function executedAdapterOverrides(outcomes: readonly AdapterOutcome[]): readonly AdapterOutcome[] {
  return outcomes.filter((o) => o.applied === "left-alone" || o.applied === "skipped-changed");
}

/** Why forge did not install this target, in the operator's terms. `left-alone` is a
 *  file that was already theirs when the plan was made; `skipped-changed` became
 *  somebody's between the plan and the write. */
export function adapterNotInstalledReason(o: AdapterOutcome): string {
  return o.applied === "skipped-changed"
    ? (o.details ?? "the target changed after the plan was made")
    : `already exists (${o.details ?? "unknown reason"})`;
}

export function warnExecutedAdapterOverrides(outcomes: readonly AdapterOutcome[]): void {
  for (const o of executedAdapterOverrides(outcomes)) {
    console.warn(`  ⚠  ${o.label} was NOT installed — ${o.target} ${adapterNotInstalledReason(o)}.`);
    console.warn(`     forge does not own that file and will not overwrite it. To use forge's version: remove it and re-run.`);
  }
}

export function warnOperatorAdapterOverrides(plan: OperatorAdaptersPlan): void {
  for (const e of operatorAdapterOverrides(plan)) {
    console.warn(`  ⚠  ${e.label} was NOT installed — ${e.target} already exists (${e.details ?? "unknown reason"}).`);
    console.warn(`     forge does not own that file and will not overwrite it. To use forge's version: remove it and re-run.`);
  }
}

// ── Names kept for `forge upgrade` until step 5 rewires it ───────────────────
//
// `forge upgrade` (src/cli/commands/upgrade.ts) calls the four names below.
// They now drive the full adapter set — Claude AND Codex — so an upgrade
// installs and refreshes everything. Only the *reporting* helpers stay
// Claude-scoped: `skippedClaudeCommands` feeds an upgrade --json field named
// `slashCommandOverrides`, and reporting a Codex skill there would put a claim
// about slash commands into a field that means something else. Step 5 adds the
// `adapterSurfaces` step that names both halves properly.

export type ClaudeCommandsPlan = OperatorAdaptersPlan;
export type ClaudeCommandEntry = AdapterEntry;

export function planClaudeCommands(projectDir: string): OperatorAdaptersPlan {
  return planOperatorAdapters(projectDir);
}

export function executeClaudeCommandsPlan(plan: OperatorAdaptersPlan): string {
  return executeOperatorAdapters(plan).summary;
}

/** Claude-surface overrides only — see the note above. */
export function skippedClaudeCommands(plan: OperatorAdaptersPlan): AdapterEntry[] {
  return operatorAdapterOverrides(plan).filter((e) => e.surface === "claude-command");
}

/** Claude-surface overrides only, from what the run actually did. */
export function skippedClaudeCommandOutcomes(outcomes: readonly AdapterOutcome[]): readonly AdapterOutcome[] {
  return executedAdapterOverrides(outcomes).filter((o) => o.surface === "claude-command");
}

export function warnSkippedClaudeCommands(plan: OperatorAdaptersPlan): void {
  warnOperatorAdapterOverrides(plan);
}

function describeClaudeCommandsPlan(plan: OperatorAdaptersPlan): string {
  if (plan.action === "skipped") return "skipped (--no-install-hooks)";
  const d = adapterDecisions(plan);
  const counts = new Map<AdapterDecision, number>();
  for (const x of d) counts.set(x.decision, (counts.get(x.decision) ?? 0) + 1);
  const parts: string[] = [];
  for (const kind of ["install", "refresh", "migrate", "already-current", "override"] as const) {
    const n = counts.get(kind);
    if (n) parts.push(`${n} ${kind}`);
  }
  return parts.join(", ") || "no-op";
}

/** The Claude slash-command file names forge renders. Derived from the renderer,
 *  so it cannot name a file the installer does not write. */
export function forgeSlashCommands(): readonly string[] {
  return renderedAdapterTargets("probe")
    .filter((t) => t.surface === "claude-command")
    .map((t) => basename(t.relPath));
}

/** Every repo-relative path forge writes. Exported so a test — and the worktree
 *  exemption in step 10 — can name the whole write set without re-deriving it. */
export function forgeAdapterPaths(): readonly string[] {
  return renderedAdapterTargets("probe").map((t) => t.relPath);
}

/** No rendered path is under a deprecated Codex custom-prompt directory. Checked
 *  rather than asserted in a comment. */
export function adapterPathsAvoidDeprecatedCodexPrompts(): boolean {
  return forgeAdapterPaths().every(
    (p) => !CODEX_DEPRECATED_PROMPT_DIRS.some((d) => p === d || p.startsWith(`${d}/`)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Gitignore management: ensure per-developer artifacts forge writes into
// .claude/ are gitignored so they don't accidentally land in the project's
// committed history. Idempotent; never reorders or removes existing entries.
// ─────────────────────────────────────────────────────────────────────────────

export type GitignorePlan =
  | { action: "install"; gitignorePath: string; missing: string[] }
  | { action: "already-current"; gitignorePath: string }
  | { action: "skipped" };

export function planGitignoreEntries(projectDir: string): GitignorePlan {
  const gitignorePath = join(projectDir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = new Set(
    existing.split("\n").map((l) => l.trim()).filter(Boolean),
  );
  const missing = FORGE_GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (missing.length === 0) {
    return { action: "already-current", gitignorePath };
  }
  return { action: "install", gitignorePath, missing };
}

export function executeGitignoreEntriesPlan(plan: GitignorePlan): string {
  if (plan.action === "skipped")         return "skipped (--no-install-hooks)";
  if (plan.action === "already-current") return "already current (no change)";
  const { gitignorePath, missing } = plan;
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const trailingNewline = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const block = (existing.length > 0 ? "\n# forge — per-developer claude-code config (machine-local, not committed)\n" : "# forge — per-developer claude-code config (machine-local, not committed)\n")
    + missing.join("\n") + "\n";
  writeFileSync(gitignorePath, existing + trailingNewline + block);
  return `added ${missing.length} entry/entries (${missing.join(", ")})`;
}

function describeGitignorePlan(plan: GitignorePlan): string {
  switch (plan.action) {
    case "install":         return `WOULD add ${plan.missing.length} entry/entries (${plan.missing.join(", ")})`;
    case "already-current": return "already current (no change)";
    case "skipped":         return "skipped (--no-install-hooks)";
  }
}
