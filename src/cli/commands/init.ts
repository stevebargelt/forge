import type { Command } from "commander";
import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// Slash-command templates that ship with forge and get symlinked into each
// project's .claude/commands/ so /orient + /handoff are available everywhere.
// Symlink (not copy) so `forge upgrade` propagates template improvements to
// all projects without per-project re-install.
const FORGE_SLASH_COMMANDS: ReadonlyArray<string> = ["orient.md", "handoff.md"];

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

      // Hook install plans (--no-install-hooks bypasses all of them).
      const installHooks = options.installHooks !== false;
      const hookPlan = installHooks ? planCommitMsgHook(projectDir) : { action: "skipped" as const };
      const claudeHooksPlan = installHooks ? planClaudeHooks(projectDir) : { action: "skipped" as const };
      const slashCommandsPlan = installHooks ? planClaudeCommands(projectDir) : { action: "skipped" as const };

      if (options.dryRun) {
        console.log(`forge init (dry-run) in ${projectDir}`);
        console.log(`  CLAUDE.md:        ${existing ? "exists" : "missing"} → ${willWrite ? "WOULD update" : "no change"}`);
        console.log(`  .forge/ dir:      ${willCreateForgeDir ? "WOULD create" : "exists"}`);
        console.log(`  commit-msg hook:  ${describeHookPlan(hookPlan)}`);
        console.log(`  claude hooks:     ${describeClaudeHooksPlan(claudeHooksPlan)}`);
        console.log(`  slash commands:   ${describeClaudeCommandsPlan(slashCommandsPlan)}`);
        return;
      }

      if (willWrite) {
        writeFileSync(claudeMdPath, next);
      }
      if (willCreateForgeDir) {
        mkdirSync(forgeProjectDir, { recursive: true });
      }
      const hookResult = installHooks ? executeHookPlan(hookPlan) : "skipped (--no-install-hooks)";
      const claudeHooksResult = installHooks ? executeClaudeHooksPlan(claudeHooksPlan) : "skipped (--no-install-hooks)";
      const slashCommandsResult = installHooks ? executeClaudeCommandsPlan(slashCommandsPlan) : "skipped (--no-install-hooks)";

      console.log(`forge init complete in ${projectDir}`);
      console.log(`  CLAUDE.md:        ${willWrite ? (existing ? "updated orchestrator block" : "created with orchestrator block") : "already current (no change)"}`);
      console.log(`  .forge/:          ${willCreateForgeDir ? "created" : "already exists"}`);
      console.log(`  commit-msg hook:  ${hookResult}`);
      console.log(`  claude hooks:     ${claudeHooksResult}`);
      console.log(`  slash commands:   ${slashCommandsResult}`);
      console.log(``);
      console.log(`Next: run 'claude' from this directory to talk to the forge orchestrator.`);
      console.log(`Try /orient to load session state and /handoff before you stop.`);
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

export function executeHookPlan(plan: HookPlan): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// #153: Claude Code session hooks (heartbeats for orchestrator liveness).
// ─────────────────────────────────────────────────────────────────────────────

export type ClaudeHooksPlan =
  | { action: "install"; settingsPath: string; source: string; details: string }
  | { action: "already-current"; settingsPath: string }
  | { action: "corrupt-json"; settingsPath: string; details: string }
  | { action: "skipped" };

// Decides what to do for the Claude Code session hooks without writing.
// Exported for testing.
export function planClaudeHooks(projectDir: string): ClaudeHooksPlan {
  const settingsPath = join(projectDir, ".claude", "settings.json");
  const source = resolveHeartbeatSource();
  if (!existsSync(settingsPath)) {
    return { action: "install", settingsPath, source, details: "create new .claude/settings.json" };
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
  if (needs.length === 0) {
    return { action: "already-current", settingsPath };
  }
  return { action: "install", settingsPath, source, details: `merge into existing settings.json (events: ${needs.join(", ")})` };
}

export function executeClaudeHooksPlan(plan: ClaudeHooksPlan): string {
  if (plan.action === "skipped")         return "skipped (--no-install-hooks)";
  if (plan.action === "already-current") return "already current (no change)";
  if (plan.action === "corrupt-json")    return `SKIPPED — settings.json not valid JSON (${plan.details})`;

  const { settingsPath, source } = plan;
  const settingsDir = dirname(settingsPath);
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });

  let parsed: Record<string, unknown> = {};
  const fileExisted = existsSync(settingsPath);
  if (fileExisted) {
    const raw = readFileSync(settingsPath, "utf8");
    const decoded = JSON.parse(raw);
    if (isObject(decoded)) parsed = decoded;
  }

  const hooksRoot: Record<string, unknown> =
    isObject(parsed["hooks"]) ? parsed["hooks"] : {};

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
  return fileExisted ? "merged into existing .claude/settings.json" : "created .claude/settings.json";
}

function describeClaudeHooksPlan(plan: ClaudeHooksPlan): string {
  switch (plan.action) {
    case "install":         return `WOULD install (${plan.details})`;
    case "already-current": return "already current (no change)";
    case "corrupt-json":    return `WOULD SKIP — settings.json not valid JSON (${plan.details})`;
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
// Slash commands (/orient + /handoff). Symlinked into <project>/.claude/commands
// so `forge upgrade` propagates template edits without per-project re-copy.
// Each entry is a Claude Code custom command — markdown file at
// `<project>/.claude/commands/<name>.md`, invoked as `/<name>` in the session.
// ─────────────────────────────────────────────────────────────────────────────

export type ClaudeCommandsPlan =
  | { action: "install"; commandsDir: string; entries: ClaudeCommandEntry[] }
  | { action: "already-current"; commandsDir: string }
  | { action: "skipped" };

export type ClaudeCommandEntry = {
  name: string;             // e.g. "orient.md"
  target: string;           // <commandsDir>/<name>
  source: string;           // absolute path in the forge repo
  status: "install" | "already-linked" | "exists-other";
  details?: string;         // for exists-other: what's blocking
};

export function planClaudeCommands(projectDir: string): ClaudeCommandsPlan {
  const commandsDir = join(projectDir, ".claude", "commands");
  const entries: ClaudeCommandEntry[] = [];
  let anyWork = false;
  for (const name of FORGE_SLASH_COMMANDS) {
    const source = resolveSlashCommandSource(name);
    const target = join(commandsDir, name);
    if (!existsSync(target)) {
      entries.push({ name, target, source, status: "install" });
      anyWork = true;
      continue;
    }
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) {
        const linkTarget = readlinkSync(target);
        const resolved = resolve(dirname(target), linkTarget);
        if (linkTarget === source || resolved === source) {
          entries.push({ name, target, source, status: "already-linked" });
          continue;
        }
        entries.push({ name, target, source, status: "exists-other", details: `symlink → ${linkTarget}` });
        continue;
      }
      entries.push({ name, target, source, status: "exists-other", details: "regular file (project-local override)" });
    } catch {
      entries.push({ name, target, source, status: "exists-other", details: "unreadable" });
    }
  }
  if (!anyWork && entries.every((e) => e.status === "already-linked")) {
    return { action: "already-current", commandsDir };
  }
  return { action: "install", commandsDir, entries };
}

export function executeClaudeCommandsPlan(plan: ClaudeCommandsPlan): string {
  if (plan.action === "skipped")         return "skipped (--no-install-hooks)";
  if (plan.action === "already-current") return "already current (no change)";

  mkdirSync(plan.commandsDir, { recursive: true });
  let installed = 0;
  let alreadyLinked = 0;
  const skipped: string[] = [];
  for (const e of plan.entries) {
    if (e.status === "install") {
      symlinkSync(e.source, e.target);
      installed += 1;
    } else if (e.status === "already-linked") {
      alreadyLinked += 1;
    } else {
      skipped.push(`${e.name} (${e.details ?? "exists"})`);
    }
  }
  const parts: string[] = [];
  if (installed > 0)     parts.push(`installed ${installed} (${plan.entries.filter((e) => e.status === "install").map((e) => "/" + e.name.replace(/\.md$/, "")).join(", ")})`);
  if (alreadyLinked > 0) parts.push(`${alreadyLinked} already current`);
  if (skipped.length)    parts.push(`SKIPPED ${skipped.length}: ${skipped.join(", ")}`);
  return parts.join("; ") || "no-op";
}

function describeClaudeCommandsPlan(plan: ClaudeCommandsPlan): string {
  if (plan.action === "skipped")         return "skipped (--no-install-hooks)";
  if (plan.action === "already-current") return "already current (no change)";
  const installs = plan.entries.filter((e) => e.status === "install").map((e) => "/" + e.name.replace(/\.md$/, ""));
  const others = plan.entries.filter((e) => e.status === "exists-other");
  const parts: string[] = [];
  if (installs.length > 0) parts.push(`WOULD install ${installs.join(", ")}`);
  if (others.length > 0)   parts.push(`WOULD SKIP ${others.map((e) => e.name).join(", ")} (exists)`);
  return parts.join("; ") || "no-op";
}

function resolveSlashCommandSource(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "scripts", "claude-commands", name),
    join(here, "..", "..", "..", "..", "scripts", "claude-commands", name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `slash-command source not found for ${name}. Looked at:\n  ${candidates.join("\n  ")}`
  );
}

// Exposed for tests/upgrade so they can introspect the canonical list without
// reaching into the module-private constant.
export function forgeSlashCommands(): readonly string[] {
  return FORGE_SLASH_COMMANDS;
}
