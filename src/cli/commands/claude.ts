// `forge claude` — THE EXPLICIT CLAUDE CODE SHORTCUT around the shared
// interactive-orchestrator launcher (FG-576 step 6; D1, D5, D16).
//
// It keeps its name and its ergonomics, and it stops being an unresolved
// passthrough. Before this step the command handed its whole tail to `claude`
// verbatim, never resolved a model, and recorded no launch decision — which is
// precisely the "manual shadow path" FG-576 exists to remove. Now it resolves the
// SAME orchestrator profile through the SAME model-policy stack as `forge
// orchestrator` and routes through the SAME receipt / liveness / resume / failure
// primitive in src/orchestrator/launch.ts. Neither command owns any part of the
// lifecycle, so the two cannot drift: a fix to one is a fix to both.
//
// WHAT MAKES IT A SHORTCUT RATHER THAN A SECOND LAUNCHER: one line —
// `providerPin: "claude-code"`. The pin is evaluated against the resolution policy
// ACTUALLY produced (D5). When policy resolves the orchestrator to Codex, this
// command REFUSES before spawn and names the resolved profile/runtime/provider plus
// two concrete remedies (D16). It never re-resolves to some other Claude profile the
// operator did not choose, and it never launches Codex because policy changed
// underneath an existing alias (AC14).
//
// WHAT IS PRESERVED, DELIBERATELY AND WITH TESTS:
//
//   * `-n` / `--name`            the operator's display-name override still wins.
//   * `--model <alias>`          `--model opus` still works — validated against the
//                                ADAPTER's vocabulary (aliases included), not the
//                                policy's concrete-id set, and recorded verbatim
//                                with its own `resolved_by` (AC14, AC4).
//   * `--continue` / `--resume`  mapped onto the shared session operation.
//   * `--bedrock` / `--aws-profile`   Forge-owned flags, extracted here and never
//                                forwarded to `claude`.
//   * the SSO/STS preflight      advisory only, never exit non-zero (FG-499).
//   * provider-native passthrough    anything Forge does not own still reaches
//                                `claude`, subject to the D6 closure.
//
// WHAT CHANGES, AND WHY IT SHIPS WITH ITS DOCUMENTATION (FG-689 D11): a command
// that worked yesterday can now REFUSE — under a Codex-resolving policy, and when
// a passthrough token would set a dimension Forge owns and records (D6). Both
// refusals name their remedies, and docs/how-to-orchestrator-launcher.md ships in
// this same step rather than later.

import type { Command } from "commander";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { readProjectAuth } from "../../util/project-meta.js";
import { runOrchestratorLaunch } from "../../orchestrator/launch.js";
import {
  buildClaudeChildEnv,
  claudeBedrockAdvisories,
  claudeProjectPreflight,
  createClaudeAdapter,
  resolveClaudeBedrockProfile,
} from "../../orchestrator/claude-adapter.js";
import {
  launchRefusal,
  type AdapterLaunchContext,
  type AdapterReadinessResult,
  type OrchestratorAdapter,
} from "../../orchestrator/adapter.js";

const ORCHESTRATOR_MARKER = "<!-- forge:orchestrator-start -->";

/** Re-exported from the adapter that now owns it. The Claude child environment is
 *  composed from the parent by ONE function, so the shortcut and the generic
 *  command cannot compose it differently (AC2). */
export { buildClaudeChildEnv } from "../../orchestrator/claude-adapter.js";

// ---------------------------------------------------------------------------
// The shortcut's own argument surface
// ---------------------------------------------------------------------------

/** What `forge claude` owns on its command line. Everything else is passthrough.
 *
 *  These are parsed HERE rather than declared as commander options because the
 *  command keeps `allowUnknownOption()` + `passThroughOptions()`: an operator's
 *  existing `forge claude --model opus --continue` must keep working WITHOUT an
 *  explicit `--` separator, which is the whole point of it being a shortcut. */
export type ClaudeShortcutInvocation = {
  profile: string | undefined;
  model: string | undefined;
  continueSession: boolean;
  resume: string | undefined;
  explain: boolean;
  /** Operator's `-n` / `--name` display-name override. */
  name: string | undefined;
  /** `--bedrock`: an explicit assertion that this launch is a Bedrock launch. */
  bedrock: boolean;
  awsProfile: string | undefined;
  /** Provider-native tokens forwarded to `claude`, subject to the D6 closure. */
  passthrough: string[];
};

/** Read `--flag value` and `--flag=value` for any of `flags`.
 *
 *  A flag whose value is missing or looks like another flag is NOT consumed: it
 *  falls through to passthrough, where the D6 guard refuses it by name. Guessing a
 *  value would launch a session the operator did not ask for, which is the same
 *  failure mode as sanitizing a resume identifier. */
function readFlagValue(
  flags: readonly string[],
  args: readonly string[],
  i: number,
): { value: string; next: number } | undefined {
  const token = args[i]!;
  for (const flag of flags) {
    if (token === flag) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      return { value, next: i + 1 };
    }
    if (flag.startsWith("--") && token.startsWith(`${flag}=`)) {
      return { value: token.slice(flag.length + 1), next: i };
    }
  }
  return undefined;
}

export function parseClaudeShortcutArgs(args: readonly string[]): ClaudeShortcutInvocation {
  const invocation: ClaudeShortcutInvocation = {
    profile: undefined,
    model: undefined,
    continueSession: false,
    resume: undefined,
    explain: false,
    name: undefined,
    bedrock: false,
    awsProfile: undefined,
    passthrough: [],
  };

  let afterSeparator = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (afterSeparator) {
      invocation.passthrough.push(token);
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }

    const profile = readFlagValue(["--profile"], args, i);
    if (profile) {
      invocation.profile = profile.value;
      i = profile.next;
      continue;
    }
    const model = readFlagValue(["--model", "-m"], args, i);
    if (model) {
      invocation.model = model.value;
      i = model.next;
      continue;
    }
    const resume = readFlagValue(["--resume", "-r"], args, i);
    if (resume) {
      invocation.resume = resume.value;
      i = resume.next;
      continue;
    }
    const name = readFlagValue(["--name", "-n"], args, i);
    if (name) {
      invocation.name = name.value;
      i = name.next;
      continue;
    }
    const awsProfile = readFlagValue(["--aws-profile"], args, i);
    if (awsProfile) {
      invocation.awsProfile = awsProfile.value;
      i = awsProfile.next;
      continue;
    }

    if (token === "--continue" || token === "-c") {
      invocation.continueSession = true;
      continue;
    }
    if (token === "--explain") {
      invocation.explain = true;
      continue;
    }
    if (token === "--bedrock") {
      invocation.bedrock = true;
      continue;
    }

    invocation.passthrough.push(token);
  }

  return invocation;
}

// ---------------------------------------------------------------------------
// The shortcut's adapter
// ---------------------------------------------------------------------------

export type ClaudeShortcutAdapterOptions = {
  /** `--bedrock` was passed, or `.forge/project.json` declares `auth: bedrock`.
   *  Either way this is an EXPLICIT assertion about the launch's auth mode. */
  bedrockAsserted: boolean;
  /** How the assertion was made, for the refusal text. */
  bedrockAssertedBy: string | undefined;
  /** `--aws-profile <p>`: highest-precedence AWS profile for a bedrock launch. */
  awsProfile: string | undefined;
  /** Test seam. Defaults to the shipped Claude adapter. */
  base?: OrchestratorAdapter | undefined;
};

/**
 * The Claude adapter, plus the two flags that belong to THIS command's surface
 * rather than to the provider-neutral one.
 *
 * It is a wrapper rather than a fork on purpose: argv construction, the instruction
 * carrier, session-operation mapping and identity all stay in the one Claude
 * adapter, so `forge claude` and `forge orchestrator` produce receipts of the same
 * shape by construction. Only the two members the flags actually affect are
 * overridden — the child environment (which AWS profile) and preflight (which
 * profile the advisory SSO/STS findings are scoped to).
 *
 * `--bedrock` is treated as an ASSERTION, not a hint. When the resolved profile
 * declares a different auth mode, this refuses before spawn rather than launching
 * one auth mode under a receipt recording another — a receipt that describes a
 * session other than the one running is the failure class this ticket exists to
 * close.
 */
export function claudeShortcutAdapter(opts: ClaudeShortcutAdapterOptions): OrchestratorAdapter {
  const base = opts.base ?? createClaudeAdapter();

  /** The AWS profile for THIS launch, in the order `forge claude` has always
   *  resolved it: --aws-profile > project.json.awsProfile > AWS_PROFILE > default.
   *  Undefined when the resolved auth is not bedrock, which is what keeps AWS
   *  variables off a subscription or api-key launch (AC2). */
  const bedrockProfileFor = (ctx: AdapterLaunchContext): string | undefined => {
    if (ctx.decision.auth !== "bedrock") return undefined;
    return opts.awsProfile ?? resolveClaudeBedrockProfile(ctx);
  };

  return {
    ...base,

    probeReadiness(ctx: AdapterLaunchContext): AdapterReadinessResult {
      if (opts.bedrockAsserted && ctx.decision.auth !== "bedrock") {
        return {
          ok: false,
          refusal: launchRefusal(
            "adapter-not-ready",
            `${opts.bedrockAssertedBy ?? "--bedrock"} asserts a Bedrock launch, but the orchestrator resolution ` +
              (ctx.decision.profile ? `selects profile '${ctx.decision.profile}', which ` : `for this project `) +
              `declares auth '${ctx.decision.auth}' (provider '${ctx.decision.provider}', runtime ` +
              `'${ctx.decision.runtime}'). Refusing rather than launching one credential mode under a receipt ` +
              `recording another.`,
            [
              `select a Bedrock profile for this launch: \`forge claude --profile <profile>\``,
              `or point \`overrides.agents.orchestrator\` at a Bedrock profile in the effective model-policy.yml`,
              `or drop the Bedrock assertion and launch what policy selected: \`forge claude\``,
            ],
          ),
        };
      }

      const probed = base.probeReadiness(ctx);
      if (!probed.ok) return probed;

      const advisories = [...probed.readiness.advisories];
      if (opts.awsProfile !== undefined && ctx.decision.auth !== "bedrock") {
        advisories.push(
          `--aws-profile '${opts.awsProfile}' was not applied: the orchestrator resolution declares auth ` +
            `'${ctx.decision.auth}', so this launch uses no AWS credentials.`,
        );
      }
      if (ctx.decision.auth !== "bedrock" && ctx.parentEnv["CLAUDE_CODE_USE_BEDROCK"] === "1") {
        // Inherited from the operator's shell, not asserted through Forge. The child
        // does NOT get it (buildClaudeChildEnv withholds it), so the session matches
        // its receipt — but say plainly that the shell and the recorded decision
        // disagree, because the operator asked for Bedrock somewhere and is not
        // getting it here.
        advisories.push(
          `CLAUDE_CODE_USE_BEDROCK=1 is set in this shell, but the orchestrator resolution declares auth ` +
            `'${ctx.decision.auth}'. The variable is withheld from the session so it runs as the receipt ` +
            `records it; select a Bedrock profile if you meant to launch on Bedrock.`,
        );
      }
      return { ok: true, readiness: { ...probed.readiness, advisories } };
    },

    buildChildEnv(ctx: AdapterLaunchContext): NodeJS.ProcessEnv {
      return buildClaudeChildEnv(ctx.parentEnv, ctx.decision.auth, bedrockProfileFor(ctx));
    },

    preflight(ctx: AdapterLaunchContext): string[] {
      const warnings = claudeProjectPreflight(ctx.projectDir);
      const profile = bedrockProfileFor(ctx);
      if (profile) warnings.push(...claudeBedrockAdvisories(profile));
      return warnings;
    },
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export function registerClaude(program: Command): void {
  program
    .command("claude")
    .description(
      "Launch the interactive orchestrator as Claude Code explicitly. Resolves the same orchestrator profile as " +
        "`forge orchestrator` and refuses before spawn if policy selects another provider. Extra args pass through to `claude`.",
    )
    .allowUnknownOption()           // don't complain about claude's flags
    .passThroughOptions()           // collect them as positional args for forward
    .argument("[args...]", "forge-owned flags (--profile, --model, --continue, --resume, --explain, --bedrock, --aws-profile, -n) then passthrough to `claude`")
    .action(async (args: string[]) => {
      const invocation = parseClaudeShortcutArgs(args);

      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd) ?? cwd;
      const projectAuth = readProjectAuth(projectRoot);

      // Fail fast for apikey mode when the key is missing. Kept ahead of
      // resolution because it is a statement about THIS project's declared auth,
      // not about what policy selected — and its message is the one operators
      // already know.
      if (projectAuth?.auth === "apikey" && !process.env.ANTHROPIC_API_KEY) {
        console.error(`forge claude: project.json auth=apikey requires ANTHROPIC_API_KEY to be set`);
        process.exit(1);
      }

      // `--bedrock` and `.forge/project.json auth: bedrock` are explicit Bedrock
      // assertions. Arming Forge's OWN auth detection with them (rather than
      // injecting the variable into the child behind the resolver's back) is what
      // keeps the recorded decision, the preflight and the child environment
      // describing one launch: with no model policy in effect the resolution reads
      // this variable and records `bedrock`. The operator's shell is a separate
      // process and is never modified — this is forge's own environment, and forge
      // exits with the session.
      const bedrockAssertedBy = invocation.bedrock
        ? "--bedrock"
        : projectAuth?.auth === "bedrock"
          ? ".forge/project.json auth=bedrock"
          : undefined;
      if (bedrockAssertedBy !== undefined && process.env.CLAUDE_CODE_USE_BEDROCK !== "1") {
        process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      }

      // Cold-context orientation, plus the AWS profile a Bedrock launch will use —
      // the two things `forge claude`'s old banner carried that the shared,
      // decision-derived banner does not. Printed by the shortcut rather than moved
      // into the shared launcher, because neither is part of the recorded launch
      // decision: one is git state, the other is which credential file gets read.
      const context = projectContextLine(
        projectRoot,
        bedrockAssertedBy !== undefined || process.env.CLAUDE_CODE_USE_BEDROCK === "1"
          ? (invocation.awsProfile ?? projectAuth?.awsProfile ?? process.env["AWS_PROFILE"] ?? "default")
          : undefined,
      );
      if (context) console.log(`forge claude: ${context}`);

      const outcome = await runOrchestratorLaunch({
        commandName: "forge claude",
        // D5/D16: the pin refuses the resolution it actually got. It never feeds
        // into resolution, so policy still decides which profile is selected.
        providerPin: "claude-code",
        adapter: claudeShortcutAdapter({
          bedrockAsserted: bedrockAssertedBy !== undefined,
          bedrockAssertedBy,
          awsProfile: invocation.awsProfile,
        }),
        cliProfile: invocation.profile,
        cliModel: invocation.model,
        continueSession: invocation.continueSession,
        resumeSessionId: invocation.resume,
        explain: invocation.explain,
        passthrough: invocation.passthrough,
        projectName: invocation.name,
        cwd,
      });

      // D16 completeness. A resolution refusal carries the resolved facts
      // structurally, and its prose names the profile and the provider — but not
      // always the RUNTIME, which is the token the operator's own model-policy.yml
      // and `forge model resolve` use. Naming it here closes the gap for the
      // shortcut without duplicating anything the message already said.
      const refusal = outcome.refusal;
      if (refusal !== null && "runtime" in refusal && refusal.runtime && !refusal.message.includes(refusal.runtime)) {
        console.error(
          `  Resolved runtime: '${refusal.runtime}'. Inspect the full effective choice with ` +
            `\`forge orchestrator --explain\` or \`forge model resolve --agent orchestrator\`.`,
        );
      }

      process.exit(outcome.exitCode);
    });
}

// ---------------------------------------------------------------------------
// Project root + git context
// ---------------------------------------------------------------------------

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

function projectContextLine(projectRoot: string, bedrockProfile?: string): string | undefined {
  const parts: string[] = [];
  if (bedrockProfile) parts.push(`bedrock:${bedrockProfile}`);
  const branch = gitInfo(projectRoot, "rev-parse --abbrev-ref HEAD");
  if (branch) parts.push(`branch: ${branch}`);
  const ahead =
    gitInfo(projectRoot, "rev-list --count origin/HEAD..HEAD") ??
    gitInfo(projectRoot, "rev-list --count @{u}..HEAD");
  if (ahead && ahead !== "0") parts.push(`${ahead} commit(s) ahead of origin`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function gitInfo(cwd: string, cmd: string): string | undefined {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
}

// Claude Code transcripts live at ~/.claude/projects/<path-hash>/<session-id>.jsonl.
// The path hash is the absolute project dir with / replaced by -.
// We find the most recently modified .jsonl in the project's transcript dir.
//
// FG-576 step 6 removed this file's post-exit usage capture: the launcher now owns
// close-out, and binding usage to the receipt's ASSERTED session id is step 8's —
// which also replaces "newest transcript wins" (with two sessions open on one
// project, that attributes work to whichever wrote last) and the hardcoded
// homedir() below with an env seam. This remains only because `forge design` still
// consumes it; nothing in the orchestrator launch path reads it.
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
