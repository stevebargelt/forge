// `forge claude` — launcher wrapper around `claude` that pre-fills the session
// name (and a few other quality-of-life adjustments) for forge-init'd projects.
//
// Three things happen before `claude` actually starts:
//
// 1. **Walk up to find the project root.** If the user is in a subdir, chdir
//    to the directory holding CLAUDE.md with the orchestrator marker. No more
//    "wait, am I in the right place" surprises.
//
// 2. **Pre-flight init check.** Detect projects that haven't been bootstrapped
//    on this machine (missing .claude/settings.local.json, stale forge symlinks
//    in .claude/commands/, no orchestrator block in CLAUDE.md). Warn but don't
//    block — the user can still launch into a half-configured session if they
//    explicitly want.
//
// 3. **Status banner.** One line with project / branch / commits ahead / active
//    ticket count. Cold-context orientation the agent reads as the session
//    boots.
//
// All args after `forge claude` are passed through to `claude` verbatim
// (--continue, --resume, --model, --add-dir, etc.). If the user passes
// -n / --name themselves, that wins over the auto-resolved name.

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { resolveProjectMeta, readProjectAuth } from "../../util/project-meta.js";
import {
  awsConfigDir,
  describeExpiredSsoSession,
  detectStaleStsCache,
  exportCredsOverridesStaleness,
  hasFreshProfileSsoCache,
  resolveProfileSsoIdentity,
} from "../../util/creds.js";
import { startSsoWatchdog } from "../../util/sso-watchdog.js";
import { insertRun, updateRunStatus } from "../../store/runs.js";
import { insertTask, markTaskComplete } from "../../store/tasks.js";
import { extractUsageFromTranscript, insertUsageRows } from "../../store/model-calls.js";
import { newRunId, newTaskId, nowIso } from "../../util/ids.js";

const ORCHESTRATOR_MARKER = "<!-- forge:orchestrator-start -->";

export function buildClaudeChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  bedrockProfile?: string,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    // Forge-owned sessions put durable work in tmux via `forge launch`.
    // Claude's background-task registry is vulnerable to harness-wide reaping.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    ...(bedrockProfile
      ? {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: bedrockProfile,
        }
      : {}),
  };
}

export function registerClaude(program: Command): void {
  program
    .command("claude")
    .description("Launch `claude` with the project's display name auto-set + pre-flight checks. Passes all extra args through to claude.")
    .allowUnknownOption()           // don't complain about claude's flags
    .passThroughOptions()           // collect them as positional args for forward
    .argument("[args...]", "passed through to `claude`")
    .action((args: string[]) => {
      // 1. Find project root by walking up for the orchestrator marker in
      //    CLAUDE.md. Falls back to cwd if no marker exists (non-forge project,
      //    or forge project that hasn't run `forge init` yet).
      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd) ?? cwd;
      if (projectRoot !== cwd) {
        console.log(`forge claude: chdir to project root: ${projectRoot}`);
      }

      // 2. Extract forge-specific flags from args before passing through to claude.
      const bedrockFlag = extractBedrockFromArgs(args);
      const awsProfileFlag = extractAwsProfileFromArgs(args);
      const argsWithoutBedrockFlags = stripBedrockFlagsFromArgs(args);

      // 3. Read project auth config from .forge/project.json.
      const projectAuth = readProjectAuth(projectRoot);

      // 4. Determine auth mode and build child env.
      //    Bedrock is active when: --bedrock flag, project.json auth:bedrock, or env already arms it.
      const envBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === "1";
      const bedrockActive = bedrockFlag || projectAuth?.auth === "bedrock" || envBedrock;

      // Fail fast for apikey mode when the key is missing.
      if (projectAuth?.auth === "apikey" && !process.env.ANTHROPIC_API_KEY) {
        console.error(`forge claude: project.json auth=apikey requires ANTHROPIC_API_KEY to be set`);
        process.exit(1);
      }

      let resolvedProfile: string | undefined;

      if (bedrockActive) {
        // Profile resolution order: --aws-profile flag > project.json.awsProfile > AWS_PROFILE env > "default"
        resolvedProfile = awsProfileFlag ?? projectAuth?.awsProfile ?? process.env.AWS_PROFILE ?? "default";

        // STS pre-flight: detect stale STS credentials before spending a session on
        // them. Scoped to resolvedProfile only (FG-435) — this must never fire
        // because some OTHER profile on the host looks fresh or stale. A stale
        // finding here is just a coarse mtime heuristic; `aws configure
        // export-credentials` (the same credential path forge injects into the
        // container) is authoritative, so we confirm against it before warning.
        //
        // FG-499: this is advisory only. An interactive `claude` session
        // handles its own auth failure natively, so forge must never exit
        // non-zero here — only warn and proceed to launch. (Contrast
        // validateCredsForNewRun in util/creds.ts, which still hard-blocks —
        // container dispatch has no interactive fallback if creds are bad.)
        const staleness = detectStaleStsCache({ profile: resolvedProfile });
        if (staleness?.stale) {
          if (exportCredsOverridesStaleness(resolvedProfile)) {
            console.log(
              `forge claude: ⚠ ${staleness.reason} (advisory — \`aws configure export-credentials\` succeeded for '${resolvedProfile}', continuing)`
            );
          } else {
            console.error(
              `forge claude: ⚠ ${staleness.reason}\n` +
              `  Credential export also failed for '${resolvedProfile}' — its SSO session likely needs a fresh login.\n` +
              `  Run: aws sso login --profile ${resolvedProfile}\n` +
              `  (advisory only — continuing; \`claude\` will handle any auth failure itself)`
            );
          }
        }

        // FG-435 round 2: detectStaleStsCache only fires when this profile has
        // its own ~/.aws/cli/cache STS entry to compare against its SSO token's
        // mtime. A profile authenticating SSO-direct (FORGE-DEC-013 — bedrock
        // reads ~/.aws/sso/cache directly and never populates cli/cache) has no
        // such entry, so a genuinely expired SSO session sails through the
        // check above as {stale: false}. Check this profile's own SSO token
        // freshness directly; export-credentials remains authoritative over a
        // stale/missing finding for the same reason as above.
        //
        // Gate on resolveProfileSsoIdentity first: it returns null when the
        // profile has no sso_session / sso_start_url at all (e.g. a plain
        // aws_access_key_id/aws_secret_access_key bedrock profile), which is
        // "SSO not applicable," not "SSO expired" — hasFreshProfileSsoCache
        // can't tell those apart on its own, so a non-SSO profile must never
        // reach the export-credentials call or the warning below.
        //
        // FG-499: advisory only, same rationale as the staleness check above —
        // warn and proceed, never exit non-zero.
        if (
          resolveProfileSsoIdentity(awsConfigDir(), resolvedProfile) &&
          !hasFreshProfileSsoCache(awsConfigDir(), resolvedProfile)
        ) {
          if (exportCredsOverridesStaleness(resolvedProfile)) {
            console.log(
              `forge claude: ⚠ SSO session for '${resolvedProfile}' looks expired or missing ` +
              `(advisory — \`aws configure export-credentials\` succeeded, continuing)`
            );
          } else {
            console.error(
              `forge claude: ⚠ ${describeExpiredSsoSession(awsConfigDir(), resolvedProfile)}\n` +
              `  (advisory only — continuing; \`claude\` will handle any auth failure itself)`
            );
          }
        }
      }

      // Disable Claude's harness-owned background tasks for every Forge
      // orchestrator session. Long-running work must use the durable tmux
      // launcher instead. The parent shell remains unchanged.
      const childEnv = buildClaudeChildEnv(process.env, resolvedProfile);

      // 5. Resolve the display name. Honor user-supplied -n / --name override.
      const userSuppliedName = extractNameFromArgs(argsWithoutBedrockFlags);
      const resolvedName = userSuppliedName ?? resolveProjectMeta(projectRoot)?.label ?? basename(projectRoot);

      // 6. Pre-flight warnings (non-blocking).
      const warnings = preflightChecks(projectRoot);
      for (const w of warnings) console.log(`forge claude: ⚠ ${w}`);

      // 7. Status banner.
      console.log(statusBanner(projectRoot, resolvedName, resolvedProfile));
      console.log("");

      // 8. Create an orchestrator run + task so model_calls captured at session
      //    end show up in the dashboard usage view with proper project grouping.
      const runId = newRunId("orchestrator");
      const taskId = newTaskId("session");
      const startedAt = nowIso();
      try {
        insertRun({
          id: runId,
          workflow: "orchestrator",
          title: `${resolvedName} orchestrator`,
          status: "active",
          createdAt: startedAt,
          projectDir: projectRoot,
        });
        insertTask({
          id: taskId,
          runId,
          phase: "session",
          agentRole: "orchestrator",
          status: "running",
          taskPackage: {
            taskId, runId, phase: "session", role: "orchestrator",
            inputs: { projectDir: projectRoot },
            composedSystemPrompt: "",
          },
          createdAt: startedAt,
          startedAt,
        });
      } catch {
        // Best-effort — don't block the session if DB writes fail.
      }

      // 9. Ensure the SSO watchdog is running when bedrock is active so the
      //    SSO token stays fresh for the duration of the session.
      if (bedrockActive) {
        startSsoWatchdog(runId);
      }

      // 10. Build the final argv. Strip user-supplied -n / --name (we set ours);
      //     insert our --name first so flags-after can still reference it.
      const passthrough = stripNameFromArgs(argsWithoutBedrockFlags);
      const finalArgs: string[] = ["-n", resolvedName, ...passthrough];

      // 11. Exec claude with stdio inherited so the user gets a real interactive
      //     session. Child env has background tasks disabled and bedrock vars
      //     injected when active (parent shell is never mutated).
      const child = spawn("claude", finalArgs, {
        cwd: projectRoot,
        stdio: "inherit",
        env: childEnv,
      });
      child.on("exit", (code, signal) => {
        captureOrchestratorUsage(projectRoot, taskId, runId);
        if (signal) process.exit(128);
        process.exit(code ?? 0);
      });
      child.on("error", (err) => {
        console.error(`forge claude: failed to spawn claude — ${err.message}`);
        console.error(`  Is the \`claude\` binary in your PATH?`);
        process.exit(1);
      });
    });
}

// Walk up from `start` looking for CLAUDE.md with the orchestrator marker.
// Returns the dir containing it, or null if not found before reaching the
// filesystem root.
export function findProjectRoot(start: string): string | null {
  let dir = pathResolve(start);
  while (true) {
    const claudeMd = join(dir, "CLAUDE.md");
    if (existsSync(claudeMd)) {
      try {
        if (readFileSync(claudeMd, "utf8").includes(ORCHESTRATOR_MARKER)) {
          return dir;
        }
      } catch { /* unreadable; continue up */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;  // reached filesystem root
    dir = parent;
  }
}

// Extract -n / --name <value> from a passthrough arg list. Returns the value
// if present (so we honor the user's explicit choice over our auto-resolution),
// undefined otherwise. Doesn't mutate the array — see stripNameFromArgs.
export function extractNameFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === "-n" || args[i] === "--name") && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i]?.startsWith("--name=")) {
      return args[i]!.slice("--name=".length);
    }
  }
  return undefined;
}

// Remove -n / --name (and its value) from the arg list so we can re-insert our
// own without duplicates. Handles both `-n foo` / `--name foo` (two tokens)
// and `--name=foo` (one token).
export function stripNameFromArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-n" || args[i] === "--name") {
      i += 1;  // skip the value too
      continue;
    }
    if (args[i]?.startsWith("--name=")) continue;
    out.push(args[i]!);
  }
  return out;
}

// Return true when --bedrock appears anywhere in the passthrough arg list.
export function extractBedrockFromArgs(args: string[]): boolean {
  return args.includes("--bedrock");
}

// Extract --aws-profile <value> or --aws-profile=<value> from the arg list.
export function extractAwsProfileFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--aws-profile" && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i]?.startsWith("--aws-profile=")) {
      return args[i]!.slice("--aws-profile=".length);
    }
  }
  return undefined;
}

// Remove --bedrock and --aws-profile (plus its value) from the arg list so
// forge-specific flags don't leak through to claude.
export function stripBedrockFlagsFromArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--bedrock") continue;
    if (args[i] === "--aws-profile") {
      i += 1;  // skip the value too
      continue;
    }
    if (args[i]?.startsWith("--aws-profile=")) continue;
    out.push(args[i]!);
  }
  return out;
}

function preflightChecks(projectRoot: string): string[] {
  const warnings: string[] = [];

  // Is this even a forge-init'd project?
  const claudeMd = join(projectRoot, "CLAUDE.md");
  const hasOrchestrator =
    existsSync(claudeMd) && readFileSync(claudeMd, "utf8").includes(ORCHESTRATOR_MARKER);
  if (!hasOrchestrator) {
    warnings.push(`CLAUDE.md has no forge orchestrator block. Run \`forge init\` to bootstrap.`);
    return warnings;  // skip remaining checks; nothing else applies
  }

  // Per-developer config in place?
  const settingsLocal = join(projectRoot, ".claude", "settings.local.json");
  if (!existsSync(settingsLocal)) {
    warnings.push(`.claude/settings.local.json missing (heartbeats won't fire). Run \`forge init\`.`);
  }

  // Stale forge symlinks in .claude/commands/?
  const commandsDir = join(projectRoot, ".claude", "commands");
  if (existsSync(commandsDir)) {
    for (const name of ["orient.md", "handoff.md"]) {
      const target = join(commandsDir, name);
      try {
        const st = lstatSync(target);
        if (st.isSymbolicLink()) {
          const linkTarget = readlinkSync(target);
          // Expect: <forge-clone>/scripts/claude-commands/<name>
          if (linkTarget.endsWith(`/scripts/claude-commands/${name}`) && !existsSync(target)) {
            warnings.push(`.claude/commands/${name} → ${linkTarget} (target missing). Run \`forge upgrade\` to repoint.`);
          }
        }
      } catch { /* skip */ }
    }
  } else {
    warnings.push(`.claude/commands/ missing (/orient, /handoff unavailable). Run \`forge init\`.`);
  }

  return warnings;
}

function statusBanner(projectRoot: string, name: string, bedrockProfile?: string): string {
  const parts: string[] = [`Launching as '${name}' orchestrator`];
  if (bedrockProfile) parts.push(`bedrock:${bedrockProfile}`);
  const branch = gitInfo(projectRoot, "rev-parse --abbrev-ref HEAD");
  if (branch) parts.push(`branch: ${branch}`);
  const ahead = gitInfo(projectRoot, "rev-list --count origin/HEAD..HEAD") ?? gitInfo(projectRoot, "rev-list --count @{u}..HEAD");
  if (ahead && ahead !== "0") parts.push(`${ahead} commit(s) ahead of origin`);
  return parts.join(" · ");
}

function gitInfo(cwd: string, cmd: string): string | undefined {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
}

// #163: after claude exits, find its transcript and extract token usage into
// model_calls. Best-effort — never throws, never blocks exit.
function captureOrchestratorUsage(projectRoot: string, taskId: string, runId: string): void {
  try {
    const transcriptPath = findSessionTranscript(projectRoot);
    if (!transcriptPath) return;

    const rows = extractUsageFromTranscript(transcriptPath, { taskId, alias: "orchestrator" });
    if (rows.length > 0) insertUsageRows(rows);

    markTaskComplete(taskId, { rowCount: rows.length });
    updateRunStatus(runId, "complete");
  } catch {
    // Telemetry failure must never alter exit behavior.
    try { updateRunStatus(runId, "complete"); } catch { /* give up */ }
  }
}

// Claude Code transcripts live at ~/.claude/projects/<path-hash>/<session-id>.jsonl.
// The path hash is the absolute project dir with / replaced by -.
// We find the most recently modified .jsonl in the project's transcript dir.
export function findSessionTranscript(projectRoot: string): string | undefined {
  const pathHash = projectRoot.replace(/\//g, "-");
  const transcriptDir = join(homedir(), ".claude", "projects", pathHash);
  if (!existsSync(transcriptDir)) return undefined;

  let newest: { path: string; mtime: number } | undefined;
  try {
    for (const name of readdirSync(transcriptDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const full = join(transcriptDir, name);
      try {
        const mt = statSync(full).mtimeMs;
        if (!newest || mt > newest.mtime) newest = { path: full, mtime: mt };
      } catch { continue; }
    }
  } catch { return undefined; }

  return newest?.path;
}
