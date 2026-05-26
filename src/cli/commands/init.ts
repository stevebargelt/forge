import type { Command } from "commander";
import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Set up forge in the current project: install orchestrator block into CLAUDE.md and create .forge/ dir")
    .option("--project <dir>", "project root to initialize (default: cwd)")
    .option("--dry-run", "show what would change without writing files")
    .option("--no-install-hooks", "skip installing the commit-msg git hook")
    .action(async (options: { project?: string; dryRun?: boolean; installHooks?: boolean }) => {
      const projectDir = resolve(options.project ?? process.cwd());
      if (!existsSync(projectDir)) {
        throw new Error(`project directory does not exist: ${projectDir}`);
      }
      const claudeMdPath = join(projectDir, "CLAUDE.md");
      const forgeProjectDir = join(projectDir, ".forge");

      const templateBody = readTemplate();

      const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";
      const next = applyOrchestratorBlock(existing, templateBody);

      const willWrite = next !== existing;
      const willCreateForgeDir = !existsSync(forgeProjectDir);

      // Hook install plan (commit-msg).
      const installHooks = options.installHooks !== false;
      const hookPlan = installHooks ? planCommitMsgHook(projectDir) : { action: "skipped" as const };

      if (options.dryRun) {
        console.log(`forge init (dry-run) in ${projectDir}`);
        console.log(`  CLAUDE.md:        ${existing ? "exists" : "missing"} → ${willWrite ? "WOULD update" : "no change"}`);
        console.log(`  .forge/ dir:      ${willCreateForgeDir ? "WOULD create" : "exists"}`);
        console.log(`  commit-msg hook:  ${describeHookPlan(hookPlan)}`);
        return;
      }

      if (willWrite) {
        writeFileSync(claudeMdPath, next);
      }
      if (willCreateForgeDir) {
        mkdirSync(forgeProjectDir, { recursive: true });
      }
      const hookResult = installHooks ? executeHookPlan(hookPlan) : "skipped (--no-install-hooks)";

      console.log(`forge init complete in ${projectDir}`);
      console.log(`  CLAUDE.md:        ${willWrite ? (existing ? "updated orchestrator block" : "created with orchestrator block") : "already current (no change)"}`);
      console.log(`  .forge/:          ${willCreateForgeDir ? "created" : "already exists"}`);
      console.log(`  commit-msg hook:  ${hookResult}`);
      console.log(``);
      console.log(`Next: run 'claude' from this directory to talk to the forge orchestrator.`);
    });
}

type HookPlan =
  | { action: "install"; target: string; source: string }
  | { action: "already-linked"; target: string }
  | { action: "exists-other"; target: string; details: string }
  | { action: "not-a-git-repo" }
  | { action: "skipped" };

// Decides what to do for the commit-msg hook without writing anything.
// Exported for testing.
export function planCommitMsgHook(projectDir: string): HookPlan {
  const hooksDir = join(projectDir, ".git", "hooks");
  if (!existsSync(hooksDir)) return { action: "not-a-git-repo" };
  const target = join(hooksDir, "commit-msg");
  const source = resolveHookSource();
  if (!existsSync(target)) return { action: "install", target, source };
  // Existing entry. If it's a symlink to our source, no-op.
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      const linkTarget = readlinkSync(target);
      if (linkTarget === source || resolve(dirname(target), linkTarget) === source) {
        return { action: "already-linked", target };
      }
      return { action: "exists-other", target, details: `symlink → ${linkTarget}` };
    }
    return { action: "exists-other", target, details: "regular file (some other hook)" };
  } catch {
    return { action: "exists-other", target, details: "unreadable" };
  }
}

function executeHookPlan(plan: HookPlan): string {
  switch (plan.action) {
    case "install":
      symlinkSync(plan.source, plan.target);
      return `installed → ${plan.source}`;
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

function describeHookPlan(plan: HookPlan): string {
  switch (plan.action) {
    case "install":          return `WOULD install symlink → ${plan.source}`;
    case "already-linked":   return "already current (no change)";
    case "exists-other":     return `WOULD SKIP — existing hook (${plan.details})`;
    case "not-a-git-repo":   return "skipped (not a git repo)";
    case "skipped":          return "skipped (--no-install-hooks)";
  }
}

// Resolve the bundled commit-msg hook script. Same fileURLToPath walk-up
// pattern as readTemplate.
function resolveHookSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "scripts", "git-hooks", "commit-msg-no-ai-attribution"),
    join(here, "..", "..", "..", "..", "scripts", "git-hooks", "commit-msg-no-ai-attribution"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `commit-msg hook source not found. Looked at:\n  ${candidates.join("\n  ")}`
  );
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

// Exported for testing.
export function applyOrchestratorBlock(existing: string, template: string): string {
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx >= 0 && endIdx > startIdx) {
    // Replace existing block in place. End at the end-marker line (include
    // the marker itself plus its trailing newline if present).
    const endLineEnd = existing.indexOf("\n", endIdx + END_MARKER.length);
    const tail = endLineEnd >= 0 ? existing.slice(endLineEnd + 1) : "";
    const head = existing.slice(0, startIdx);
    // Ensure exactly one blank line on each side of the block when there's
    // surrounding content. If head/tail is empty, no blank line needed.
    const headJoin = head && !head.endsWith("\n\n") ? (head.endsWith("\n") ? "\n" : "\n\n") : "";
    const tailJoin = tail ? (tail.startsWith("\n") ? "" : "\n") : "";
    return head + headJoin + ensureTrailingNewline(template) + tailJoin + tail;
  }

  if (startIdx >= 0 || endIdx >= 0) {
    // Corrupted: one marker without the other. Refuse to touch.
    throw new Error(
      `CLAUDE.md has an unbalanced forge orchestrator block (one marker present, other missing). ` +
      `Fix manually or remove both markers and re-run 'forge init'.`
    );
  }

  // No existing block. Append (with a separator if there's existing content).
  if (existing.length === 0) {
    return ensureTrailingNewline(template);
  }
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + ensureTrailingNewline(template);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
