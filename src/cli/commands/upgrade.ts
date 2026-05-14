import type { Command } from "commander";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOrchestratorBlock } from "./init.js";

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
    .description("Refresh forge: git pull the forge repo, refresh seeds in ~/.forge/, and re-init the current project's CLAUDE.md")
    .option("--dry-run", "show what would change without doing anything")
    .option("--skip-git", "skip the git pull step (useful when testing local-only changes)")
    .option("--skip-project", "skip re-initing the current project's CLAUDE.md")
    .option("--forge-repo <dir>", "path to the forge source repo (default: $FORGE_REPO_DIR or ~/code/forge)")
    .action((options: {
      dryRun?: boolean;
      skipGit?: boolean;
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
      const willReinitProject = !options.skipProject &&
        existsSync(projectClaudeMd) &&
        readFileSync(projectClaudeMd, "utf8").includes("<!-- forge:orchestrator-start -->");

      const dryRun = options.dryRun ?? false;
      const prefix = dryRun ? "(dry-run) " : "";

      console.log(`${prefix}forge upgrade`);
      console.log(`  Forge repo:    ${forgeRepoDir}`);
      console.log(`  Project (cwd): ${willReinitProject ? cwd : (options.skipProject ? "(skipped)" : "(no orchestrator block found in CLAUDE.md; skipping)")}`);
      console.log("");

      // Step 1: git pull
      if (options.skipGit) {
        console.log(`[1/3] git pull: skipped (--skip-git)`);
      } else {
        const pullResult = tryGitPull(forgeRepoDir, dryRun);
        switch (pullResult.kind) {
          case "ok":
            console.log(`[1/3] git pull: ${pullResult.message}`);
            break;
          case "no-remote":
            console.log(`[1/3] git pull: skipped (no remote configured — set up upstream when ready)`);
            break;
          case "dirty":
            console.log(`[1/3] git pull: SKIPPED (working tree has uncommitted changes in forge repo)`);
            console.log(`        Commit or stash in ${forgeRepoDir}, then re-run.`);
            // Don't return — let the user still refresh seeds + project if they want.
            break;
          case "error":
            console.log(`[1/3] git pull: FAILED — ${pullResult.message}`);
            // Don't return — seeds + project may still work.
            break;
        }
      }

      // Step 2: install-seeds.sh FORCE=1
      const installScript = join(forgeRepoDir, "scripts", "install-seeds.sh");
      if (!existsSync(installScript)) {
        console.log(`[2/3] install-seeds.sh: NOT FOUND at ${installScript}`);
      } else if (dryRun) {
        console.log(`[2/3] install-seeds.sh: would run with FORCE=1`);
      } else {
        try {
          const out = execFileSync("bash", [installScript], {
            env: { ...process.env, FORCE: "1" },
            encoding: "utf8",
          });
          // Emit a compact summary, not the full output
          const lines = out.trim().split("\n");
          const installedLines = lines.filter((l) => l.startsWith("Installing"));
          console.log(`[2/3] install-seeds.sh: ${installedLines.length} component(s) refreshed`);
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
          console.log(`[2/3] install-seeds.sh: FAILED — ${(e as Error).message}`);
        }
      }

      // Step 3: re-init current project's CLAUDE.md
      if (!willReinitProject) {
        console.log(`[3/3] project init: skipped`);
      } else {
        const templatePath = join(forgeRepoDir, "seeds", "orchestrator-template.md");
        if (!existsSync(templatePath)) {
          console.log(`[3/3] project init: FAILED — template not found at ${templatePath}`);
        } else {
          const template = readFileSync(templatePath, "utf8");
          const existing = readFileSync(projectClaudeMd, "utf8");
          const next = applyOrchestratorBlock(existing, template);
          if (next === existing) {
            console.log(`[3/3] project init: already current (no change)`);
          } else if (dryRun) {
            console.log(`[3/3] project init: would update orchestrator block in ${projectClaudeMd}`);
          } else {
            writeFileSync(projectClaudeMd, next);
            console.log(`[3/3] project init: updated orchestrator block`);
            // Ensure .forge/ exists for project overrides (init does this too).
            const projForgeDir = join(cwd, ".forge");
            if (!existsSync(projForgeDir)) {
              mkdirSync(projForgeDir, { recursive: true });
            }
          }
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
