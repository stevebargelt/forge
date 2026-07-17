import type { Command } from "commander";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyOrchestratorBlock,
  looksLikeForgeProject,
  executeClaudeCommandsPlan,
  executeClaudeHooksPlan,
  executeGitignoreEntriesPlan,
  executeHookPlan,
  planClaudeCommands,
  planClaudeHooks,
  planCommitMsgHook,
  planGitignoreEntries,
  warnSkippedClaudeCommands,
} from "./init.js";
import { compilePolicyFile } from "../../raci/host-policy.js";
import { RACI_PATH, ROUTING_POLICY_PATH } from "../../util/paths.js";
import { buildReleaseReport, summarizeProblems, type ReleaseReport } from "../../v2/release-doctor.js";
import { gatherReleaseInputs } from "./doctor.js";
import { assetRoot, devCheckoutDir, executionMode, type ExecutionMode } from "../../v2/asset-root.js";

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
  exists: (p: string) => boolean = existsSync,
): DevAdvanceDecision {
  if (mode === "release") {
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
  devAdvancement: { kind: DevAdvanceDecision["kind"]; lines: string[] };
  assetInstall: "installed" | "failed" | "not-found" | "would-install";
  imageRebuild: "ran" | "refused" | "failed" | "skipped";
  unresolved: string[];
  releaseCheck: string[] | null;
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
      const advance = decideDevAdvancement(mode, assetsDir, devDir);

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
      if (advance.kind !== "proceed") {
        const label = advance.kind === "refused" ? "REFUSED" : "SKIPPED";
        say(`[1/4] git pull:    ${label}`);
        say(`[2/4] npm install: ${label}`);
        for (const line of advance.lines) warn(`        ${line}`);
        say("");
      } else if (options.skipGit) {
        say(`[1/4] git pull: skipped (--skip-git)`);
      } else {
        const pullResult = tryGitPull(devDir, dryRun);
        switch (pullResult.kind) {
          case "ok":
            say(`[1/4] git pull: ${pullResult.message}`);
            break;
          case "no-remote":
            say(`[1/4] git pull: skipped (no remote configured — set up upstream when ready)`);
            break;
          case "dirty":
            say(`[1/4] git pull: SKIPPED (working tree has uncommitted changes in forge repo)`);
            say(`        Commit or stash in ${devDir}, then re-run.`);
            // Don't return — let the user still refresh seeds + project if they want.
            break;
          case "error":
            say(`[1/4] git pull: FAILED — ${pullResult.message}`);
            // Don't return — seeds + project may still work.
            break;
        }
      }

      // Step 2: npm install (picks up new deps + workspace symlinks)
      if (advance.kind !== "proceed") {
        // already reported alongside step 1
      } else if (options.skipNpm) {
        say(`[2/4] npm install: skipped (--skip-npm)`);
      } else {
        const npmResult = tryNpmInstall(devDir, dryRun);
        switch (npmResult.kind) {
          case "ok":
            say(`[2/4] npm install: ${npmResult.message}`);
            break;
          case "no-package-json":
            say(`[2/4] npm install: SKIPPED (no package.json at ${devDir})`);
            break;
          case "error":
            say(`[2/4] npm install: FAILED — ${npmResult.message}`);
            // Don't return — seeds + project may still work; user can re-run npm install manually.
            break;
        }
      }

      // Step 3: install-seeds.sh FORCE=1 — the ASSET half. Reads from the
      // executing tree, writes only to $FORGE_HOME. Reached whether or not a dev
      // checkout exists (FG-577 / audit MEDIUM-5).
      const { installScript, templatePath } = upgradeAssetPaths(assetsDir);
      let assetInstall: UpgradeResult["assetInstall"] = "installed";
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
      {
        const res = compilePolicyFile(RACI_PATH, ROUTING_POLICY_PATH, { write: !dryRun });
        if (res.ok) {
          say(`        → routing-policy.yml: ${dryRun ? "would recompile" : "recompiled"} (${res.routes} routes)`);
        } else {
          warn(`        ⚠ routing-policy.yml NOT recompiled — ${res.error}`);
          warn(`          fix ~/.forge/forge-raci.md, then run: forge route compile`);
        }
      }

      // Step 4: re-init current project — CLAUDE.md orchestrator block + all
      // hook installs (commit-msg, claude session hooks, slash commands).
      // Re-running the install plans is idempotent: already-current entries
      // no-op; updates apply when the template/source has moved.
      if (!isForgeProject) {
        // #231 follow-up: flag the never-initialized case loudly + actionably,
        // instead of a terse "skipped". upgrade is for EXISTING projects; a
        // project with no forge block has never been `forge init`'d.
        if (options.skipProject) {
          say(`[4/4] project init: skipped (--skip-project)`);
        } else if (!existsSync(projectClaudeMd)) {
          say(`[4/4] project init: SKIPPED — no CLAUDE.md in ${cwd}`);
          warn(`        ⚠ this directory has never been initialized for forge. Run \`forge init\` here first (upgrade is for existing projects).`);
        } else {
          say(`[4/4] project init: SKIPPED — CLAUDE.md has no forge orchestrator block`);
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
          say(`[4/4] project init: block SKIPPED — template not found at ${templatePath}`);
        } else {
          const template = readFileSync(templatePath, "utf8");
          const existing = readFileSync(projectClaudeMd, "utf8");
          const result = applyOrchestratorBlock(existing, template);
          if (result.action === "needs-markers") {
            say(`[4/4] project init: orchestrator block needs manual markers`);
            warn(`        ⚠ ${result.message}`);
          } else if (result.content === existing) {
            say(`[4/4] project init: orchestrator block already current`);
          } else if (dryRun) {
            say(`[4/4] project init: would ${result.action} orchestrator block in ${projectClaudeMd}`);
          } else {
            writeFileSync(projectClaudeMd, result.content);
            say(`[4/4] project init: ${result.action} orchestrator block`);
          }
        }

        // Hook / command / gitignore plans — idempotent (already-linked → no-op).
        const commitMsg = planCommitMsgHook(cwd);
        const claudeHooks = planClaudeHooks(cwd);
        const slashCmds = planClaudeCommands(cwd);
        const gitignore = planGitignoreEntries(cwd);
        if (dryRun) {
          say(`        commit-msg hook: ${commitMsg.action}`);
          say(`        claude hooks:    ${claudeHooks.action}`);
          say(`        slash commands:  ${slashCmds.action}`);
          say(`        .gitignore:      ${gitignore.action}`);
        } else {
          say(`        commit-msg hook: ${executeHookPlan(commitMsg)}`);
          say(`        claude hooks:    ${executeClaudeHooksPlan(claudeHooks)}`);
          say(`        slash commands:  ${executeClaudeCommandsPlan(slashCmds)}`);
          warnSkippedClaudeCommands(slashCmds);
          say(`        .gitignore:      ${executeGitignoreEntriesPlan(gitignore)}`);
        }
      }

      // #229: rebuild the agent image only when explicitly asked (the one
      // mutating extra step), so a stale image can be fixed in the same command.
      const rebuild = maybeRebuildImage(options, devDir, mode, assetsDir);
      for (const line of rebuild.lines) say(line);
      if (rebuild.error) warn(rebuild.error);

      // A requested action that did not happen is a failed request, not a skipped
      // nicety. All THREE consumer surfaces — the exit code, the closing line, and
      // --json — are derived from ONE list, so they cannot disagree about whether
      // this upgrade did what was asked. A `missing` dev checkout is not on it:
      // nothing refused and nothing failed, the host simply has no checkout to
      // advance.
      const unresolved: string[] = [];
      if (advance.kind === "refused") unresolved.push("dev advancement refused (release)");
      if (assetInstall === "failed") unresolved.push("install-seeds.sh FAILED");
      if (rebuild.refused) unresolved.push("image rebuild refused (release)");
      // A dry run mutates nothing and is a report, not a request — it stays exit 0.
      if (!dryRun && unresolved.length > 0) process.exitCode = 1;

      say("");
      if (dryRun) say("Dry run complete. Re-run without --dry-run to apply.");
      else if (unresolved.length === 0) say("Upgrade complete.");
      else say(`Upgrade INCOMPLETE — ${unresolved.join("; ")}.`);

      // #229: read-only release check so a stale image / missing runtime CLI /
      // missing credential is surfaced NOW, not at the next dispatch. Never
      // mutates; skipped on a dry run.
      let releaseCheck: string[] | null = null;
      if (!dryRun) {
        try {
          // FG-577: the tail's image probe judges against the EXECUTING tree's
          // docker/, the same root doctor's standalone path now reads — so the
          // two cannot report different staleness for the same host.
          const report = buildReleaseReport(gatherReleaseInputs(undefined, { projectDir: cwd, forgeRepoDir: assetsDir }, {}, mode));
          releaseCheck = summarizeProblems(report);
          say("");
          for (const line of renderReleaseCheckLines(report)) say(line);
        } catch (e) {
          warn(`Release check skipped: ${(e as Error).message}`);
        }
      }

      const result: UpgradeResult = {
        ok: unresolved.length === 0,
        dryRun,
        mode,
        assetsDir,
        devDir,
        // The refusal REGISTER itself, not a boolean an operator would have to
        // re-derive the reason for: a --json consumer gets the same named,
        // actionable lines the human surface prints.
        devAdvancement: { kind: advance.kind, lines: advance.kind === "proceed" ? [] : advance.lines },
        assetInstall,
        imageRebuild: rebuild.refused ? "refused" : rebuild.error ? "failed" : rebuild.ran ? "ran" : "skipped",
        unresolved,
        releaseCheck,
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
 *  drift into letting a release rebuild. */
export function maybeRebuildImage(
  options: { rebuildImage?: boolean; dryRun?: boolean },
  devDir: string,
  mode: ExecutionMode,
  assetsDir: string = assetRoot(),
  exec: ImageRebuildExec = (cmd, opts) => { execSync(cmd, opts); },
): { ran: boolean; lines: string[]; error?: string; refused?: boolean } {
  if (!options.rebuildImage || options.dryRun) return { ran: false, lines: [] };
  // FG-577: rebuilding is dev-advancement — it runs a script from, and writes an
  // image built out of, the dev checkout. The read-only staleness PROBE follows
  // the release (doctor.ts); only this ACTION refuses.
  if (mode === "release") {
    return { ran: false, lines: [], refused: true, error: refuseDevAdvance("rebuild the agent image (--rebuild-image)", assetsDir, devDir).join("\n") };
  }
  const lines = ["", "[image] rebuilding agent image (docker/build.sh)…"];
  try {
    exec("bash ./build.sh", { cwd: join(devDir, "docker"), stdio: "inherit" });
    return { ran: true, lines };
  } catch {
    return { ran: true, lines, error: "forge upgrade: image rebuild failed — see output above." };
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
