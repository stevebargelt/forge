import type { Command } from "commander";
import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
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
// the per-developer config doesn't get accidentally committed.
const FORGE_GITIGNORE_ENTRIES = [
  ".claude/settings.local.json",
  ".claude/commands/",
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
      const gitignorePlan = installHooks ? planGitignoreEntries(projectDir) : { action: "skipped" as const };

      if (options.dryRun) {
        console.log(`forge init (dry-run) in ${projectDir}`);
        console.log(`  CLAUDE.md:        ${existing ? "exists" : "missing"} → ${willWrite ? "WOULD update" : "no change"}`);
        console.log(`  .forge/ dir:      ${willCreateForgeDir ? "WOULD create" : "exists"}`);
        console.log(`  commit-msg hook:  ${describeHookPlan(hookPlan)}`);
        console.log(`  claude hooks:     ${describeClaudeHooksPlan(claudeHooksPlan)}`);
        console.log(`  slash commands:   ${describeClaudeCommandsPlan(slashCommandsPlan)}`);
        console.log(`  .gitignore:       ${describeGitignorePlan(gitignorePlan)}`);
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
      const gitignoreResult = installHooks ? executeGitignoreEntriesPlan(gitignorePlan) : "skipped (--no-install-hooks)";

      console.log(`forge init complete in ${projectDir}`);
      console.log(`  CLAUDE.md:        ${willWrite ? (existing ? "updated orchestrator block" : "created with orchestrator block") : "already current (no change)"}`);
      console.log(`  .forge/:          ${willCreateForgeDir ? "created" : "already exists"}`);
      console.log(`  commit-msg hook:  ${hookResult}`);
      console.log(`  claude hooks:     ${claudeHooksResult}`);
      console.log(`  slash commands:   ${slashCommandsResult}`);
      console.log(`  .gitignore:       ${gitignoreResult}`);
      console.log(``);
      console.log(`Note: .claude/settings.local.json and .claude/commands/ are per-developer.`);
      console.log(`      Other contributors run \`forge init\` after cloning to bootstrap their local copies.`);
      console.log(``);
      console.log(`Next: run 'forge claude' from this directory to talk to the forge orchestrator.`);
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

    // Extract only the orchestrator block (between markers) from the
    // template. Content after the end marker (e.g. "Stack + project
    // context") is project-specific and must not be overwritten on upgrade.
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

    // Ensure exactly one blank line on each side of the block when there's
    // surrounding content. If head/tail is empty, no blank line needed.
    const headJoin = head && !head.endsWith("\n\n") ? (head.endsWith("\n") ? "\n" : "\n\n") : "";
    const tailJoin = tail ? (tail.startsWith("\n") ? "" : "\n") : "";
    return head + headJoin + ensureTrailingNewline(block) + tailJoin + tail;
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
    // Use lstatSync to detect symlinks (including broken ones pointing at a
    // stale forge path). existsSync follows symlinks → a broken link returns
    // false → install path would EEXIST when it tried to recreate the link.
    let st;
    try { st = lstatSync(target); }
    catch { st = null; }
    if (!st) {
      entries.push({ name, target, source, status: "install" });
      anyWork = true;
      continue;
    }
    if (st.isSymbolicLink()) {
      let linkTarget = "";
      try { linkTarget = readlinkSync(target); } catch { /* unreadable link */ }
      const resolved = linkTarget ? resolve(dirname(target), linkTarget) : "";
      if (linkTarget === source || resolved === source) {
        entries.push({ name, target, source, status: "already-linked" });
        continue;
      }
      // Stale forge symlink (points at a different forge path, possibly
      // broken). Treat as "upgrade in place" — replace the symlink.
      // Distinguish from a user's deliberate override: we recognize forge's
      // own targets by the "claude-commands/<name>.md" tail.
      const isStaleForge = linkTarget.endsWith(`/scripts/claude-commands/${name}`);
      if (isStaleForge) {
        entries.push({ name, target, source, status: "install", details: `replace stale symlink → ${linkTarget}` });
        anyWork = true;
      } else {
        entries.push({ name, target, source, status: "exists-other", details: `symlink → ${linkTarget}` });
      }
      continue;
    }
    entries.push({ name, target, source, status: "exists-other", details: "regular file (project-local override)" });
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
  let replaced = 0;
  let alreadyLinked = 0;
  const skipped: string[] = [];
  for (const e of plan.entries) {
    if (e.status === "install") {
      // If a stale forge symlink is in the way (planClaudeCommands flagged it
      // by setting `details`), unlink first. lstatSync inside a guarded block
      // so a missing file path still works.
      try {
        const st = lstatSync(e.target);
        if (st) { unlinkSync(e.target); replaced += 1; }
      } catch { /* nothing to remove */ }
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
