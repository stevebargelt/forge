import type { Command } from "commander";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
// Resolves the forge repo location via FORGE_REPO_DIR env override, falling
// back to ~/code/forge (Steven's setup, sole user as of v2 build).

const DEFAULT_FORGE_REPO_DIR = join(homedir(), "code", "forge");

export function registerUpgrade(program: Command): void {
  program
    .command("upgrade")
    .description("Refresh forge: git pull the forge repo, npm install, refresh seeds in ~/.forge/, and re-init the current project's CLAUDE.md")
    .option("--dry-run", "show what would change without doing anything")
    .option("--skip-git", "skip the git pull step (useful when testing local-only changes)")
    .option("--skip-npm", "skip the npm install step (useful when deps haven't changed and you want a fast loop)")
    .option("--skip-project", "skip re-initing the current project's CLAUDE.md")
    .option("--forge-repo <dir>", "path to the forge source repo (default: $FORGE_REPO_DIR or ~/code/forge)")
    .action((options: {
      dryRun?: boolean;
      skipGit?: boolean;
      skipNpm?: boolean;
      skipProject?: boolean;
      forgeRepo?: string;
    }) => {
      const forgeRepoDir = resolveForgeRepo(options.forgeRepo);
      if (!existsSync(forgeRepoDir)) {
        throw new Error(
          `forge repo not found at ${forgeRepoDir}\n` +
          `Set FORGE_REPO_DIR or pass --forge-repo to point at your local forge checkout.`
        );
      }

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

      console.log(`${prefix}forge upgrade`);
      console.log(`  Forge repo:    ${forgeRepoDir}`);
      console.log(`  Project (cwd): ${isForgeProject ? cwd : (options.skipProject ? "(skipped)" : "(not a forge project here — no orchestrator block/heading; run `forge init` to set one up)")}`);
      console.log("");

      // Step 1: git pull
      if (options.skipGit) {
        console.log(`[1/4] git pull: skipped (--skip-git)`);
      } else {
        const pullResult = tryGitPull(forgeRepoDir, dryRun);
        switch (pullResult.kind) {
          case "ok":
            console.log(`[1/4] git pull: ${pullResult.message}`);
            break;
          case "no-remote":
            console.log(`[1/4] git pull: skipped (no remote configured — set up upstream when ready)`);
            break;
          case "dirty":
            console.log(`[1/4] git pull: SKIPPED (working tree has uncommitted changes in forge repo)`);
            console.log(`        Commit or stash in ${forgeRepoDir}, then re-run.`);
            // Don't return — let the user still refresh seeds + project if they want.
            break;
          case "error":
            console.log(`[1/4] git pull: FAILED — ${pullResult.message}`);
            // Don't return — seeds + project may still work.
            break;
        }
      }

      // Step 2: npm install (picks up new deps + workspace symlinks)
      if (options.skipNpm) {
        console.log(`[2/4] npm install: skipped (--skip-npm)`);
      } else {
        const npmResult = tryNpmInstall(forgeRepoDir, dryRun);
        switch (npmResult.kind) {
          case "ok":
            console.log(`[2/4] npm install: ${npmResult.message}`);
            break;
          case "no-package-json":
            console.log(`[2/4] npm install: SKIPPED (no package.json at ${forgeRepoDir})`);
            break;
          case "error":
            console.log(`[2/4] npm install: FAILED — ${npmResult.message}`);
            // Don't return — seeds + project may still work; user can re-run npm install manually.
            break;
        }
      }

      // Step 3: install-seeds.sh FORCE=1
      const installScript = join(forgeRepoDir, "scripts", "install-seeds.sh");
      if (!existsSync(installScript)) {
        console.log(`[3/4] install-seeds.sh: NOT FOUND at ${installScript}`);
      } else if (dryRun) {
        console.log(`[3/4] install-seeds.sh: would run with FORCE=1`);
      } else {
        try {
          const out = execFileSync("bash", [installScript], {
            env: { ...process.env, FORCE: "1" },
            encoding: "utf8",
          });
          // Emit a compact summary, not the full output
          const lines = out.trim().split("\n");
          const installedLines = lines.filter((l) => l.startsWith("Installing"));
          console.log(`[3/4] install-seeds.sh: ${installedLines.length} component(s) refreshed`);
          for (const line of installedLines) {
            console.log(`        ${line.replace("Installing ", "")}`);
          }
          // Surface orphan-warning if present (the existing install-seeds.sh
          // emits a "Note: pre-rename agent dirs detected" block).
          const noteIdx = lines.findIndex((l) => l.startsWith("Note:"));
          if (noteIdx >= 0) {
            console.log("");
            for (const line of lines.slice(noteIdx)) {
              if (line.startsWith("Done.")) break;
              console.log(`        ${line}`);
            }
          }
        } catch (e) {
          console.log(`[3/4] install-seeds.sh: FAILED — ${(e as Error).message}`);
        }
      }

      // Step 4: re-init current project — CLAUDE.md orchestrator block + all
      // hook installs (commit-msg, claude session hooks, slash commands).
      // Re-running the install plans is idempotent: already-current entries
      // no-op; updates apply when the template/source has moved.
      if (!isForgeProject) {
        console.log(`[4/4] project init: skipped`);
      } else {
        // #231: provisioning (commands/hooks/gitignore) runs UNCONDITIONALLY —
        // it's machine-local setup independent of the CLAUDE.md block state, and
        // is what makes /orient + /handoff available. The block refresh is a
        // separate best-effort step that never blocks provisioning.
        const projForgeDir = join(cwd, ".forge");
        if (!dryRun && !existsSync(projForgeDir)) mkdirSync(projForgeDir, { recursive: true });

        // Block refresh (best-effort): replace / repair / append / or ask for
        // manual markers — never silently skip, never duplicate.
        const templatePath = join(forgeRepoDir, "seeds", "orchestrator-template.md");
        if (!existsSync(templatePath)) {
          console.log(`[4/4] project init: block SKIPPED — template not found at ${templatePath}`);
        } else {
          const template = readFileSync(templatePath, "utf8");
          const existing = readFileSync(projectClaudeMd, "utf8");
          const result = applyOrchestratorBlock(existing, template);
          if (result.action === "needs-markers") {
            console.log(`[4/4] project init: orchestrator block needs manual markers`);
            console.warn(`        ⚠ ${result.message}`);
          } else if (result.content === existing) {
            console.log(`[4/4] project init: orchestrator block already current`);
          } else if (dryRun) {
            console.log(`[4/4] project init: would ${result.action} orchestrator block in ${projectClaudeMd}`);
          } else {
            writeFileSync(projectClaudeMd, result.content);
            console.log(`[4/4] project init: ${result.action} orchestrator block`);
          }
        }

        // Hook / command / gitignore plans — idempotent (already-linked → no-op).
        const commitMsg = planCommitMsgHook(cwd);
        const claudeHooks = planClaudeHooks(cwd);
        const slashCmds = planClaudeCommands(cwd);
        const gitignore = planGitignoreEntries(cwd);
        if (dryRun) {
          console.log(`        commit-msg hook: ${commitMsg.action}`);
          console.log(`        claude hooks:    ${claudeHooks.action}`);
          console.log(`        slash commands:  ${slashCmds.action}`);
          console.log(`        .gitignore:      ${gitignore.action}`);
        } else {
          console.log(`        commit-msg hook: ${executeHookPlan(commitMsg)}`);
          console.log(`        claude hooks:    ${executeClaudeHooksPlan(claudeHooks)}`);
          console.log(`        slash commands:  ${executeClaudeCommandsPlan(slashCmds)}`);
          warnSkippedClaudeCommands(slashCmds);
          console.log(`        .gitignore:      ${executeGitignoreEntriesPlan(gitignore)}`);
        }
      }

      console.log("");
      console.log(dryRun ? "Dry run complete. Re-run without --dry-run to apply." : "Upgrade complete.");
    });
}

function resolveForgeRepo(explicit: string | undefined): string {
  if (explicit) return resolve(explicit);
  if (process.env.FORGE_REPO_DIR) return resolve(process.env.FORGE_REPO_DIR);
  return DEFAULT_FORGE_REPO_DIR;
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
