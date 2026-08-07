// FG-576 (D1) — `forge orchestrator`: the PROVIDER-NEUTRAL interactive launcher.
//
// It owns no resolution, no receipt and no lifecycle of its own. Every one of those
// lives in src/orchestrator/launch.ts, which `forge claude` also runs through (step
// 6) — so the generic command and the provider shortcut cannot drift apart, and a
// fix to one is a fix to both.
//
// WHY THE FLAGS ARE PARSED HERE RATHER THAN PASSED THROUGH. `forge claude` is an
// unresolved passthrough today: it hands the whole tail to `claude` verbatim. This
// command deliberately is not. Forge OWNS `--profile` and `--model` (AC4), so it
// parses them, validates them against the selected adapter's vocabulary, and records
// each with its own `resolved_by`. Provider-native flags still reach the child, but
// only after an explicit `--` separator and only after the D6 guard has refused any
// token that would set the provider, model, auth, project root, instruction surface
// or session identity a second, unrecorded time.
//
//   forge orchestrator                       policy decides the provider
//   forge orchestrator --profile codex-subscription
//   forge orchestrator --model opus --continue
//   forge orchestrator --resume <id>
//   forge orchestrator --explain             print the choice; spawn NOTHING (AC15)
//   forge orchestrator -- --add-dir ../lib   provider-native passthrough

import type { Command } from "commander";
import { runOrchestratorLaunch } from "../../orchestrator/launch.js";

export function registerOrchestrator(program: Command): void {
  program
    .command("orchestrator")
    .description(
      "Launch the interactive orchestrator the effective model policy selects (Claude Code or Codex CLI), " +
        "with a durable launch receipt and liveness record.",
    )
    .option("--profile <name>", "model-policy profile to launch (highest precedence)")
    .option("--model <model>", "concrete model override, validated against the selected adapter")
    .option("-c, --continue", "continue the provider's most recent session in this project")
    .option("--resume <id>", "resume a specific session by identifier")
    .option("--explain", "print the resolved profile/runtime/provider/model/auth/adapter/resolved_by and exit without launching")
    .argument("[passthrough...]", "after `--`, provider-native flags forwarded verbatim to the selected CLI")
    .action(async (passthrough: string[], opts: Record<string, unknown>) => {
      const outcome = await runOrchestratorLaunch({
        commandName: "forge orchestrator",
        cliProfile: typeof opts["profile"] === "string" ? opts["profile"] : undefined,
        cliModel: typeof opts["model"] === "string" ? opts["model"] : undefined,
        continueSession: opts["continue"] === true,
        resumeSessionId: typeof opts["resume"] === "string" ? opts["resume"] : undefined,
        explain: opts["explain"] === true,
        passthrough,
      });
      process.exit(outcome.exitCode);
    });
}
