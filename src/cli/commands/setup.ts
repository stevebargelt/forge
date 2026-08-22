// #252: `forge setup` — get a new/work-laptop host ready for forge-on-forge
// without hand-writing YAML. Guided-creates the active host config from the
// installed seed when absent (the one safe, host-local, never-committed
// mutation), ensures the routing policy is compiled, then runs the #229 read-only
// release check and reports whether the Codex review-loop path is configured. No
// live agent run; the DB is never touched. `--dry-run` previews without writing.

import type { Command } from "commander";
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { FORGE_HOME, RACI_PATH, ROUTING_POLICY_PATH } from "../../util/paths.js";
import { compilePolicyFile } from "../../raci/host-policy.js";
import { gatherReleaseInputs } from "./doctor.js";
import { buildReleaseReport } from "../../v2/release-doctor.js";
import {
  planConfigProvision,
  modelPolicyStep,
  modelPolicyVersionStep,
  routingPolicyStep,
  reviewLoopReadiness,
  buildSetupReport,
  renderSetupReport,
  type SetupStep,
} from "../../v2/setup.js";
import { buildModelPolicyStatus } from "../../v2/model-policy-status.js";
import { doctorReport } from "../../v2/provider-doctor.js";
import { loadModelPolicy } from "../../v2/loader.js";
import {
  runHostModelPolicySetup,
  type Prompt,
  type HeadlessSelection,
  type HostModelPolicyResult,
} from "../../v2/setup-model-policy.js";

const MODEL_POLICY_PATH = join(FORGE_HOME, "model-policy.yml");
const MODEL_POLICY_SEED = join(FORGE_HOME, "model-policy.example.yml");

// Create the active model policy from the installed example when absent. Never
// overwrites an existing host policy (preserves personal edits). Returns the step
// for the report; performs the copy unless dryRun.
//
// FG-346: retained as the deterministic seed-copy fallback the interactive/flags
// authoring path (provisionModelPolicyInteractive) delegates to when there is
// nothing to ASK — non-interactive with no selection flags. Its behavior and tests
// are unchanged.
export function provisionModelPolicy(dryRun: boolean): SetupStep {
  const action = planConfigProvision({
    activePresent: existsSync(MODEL_POLICY_PATH),
    seedPresent: existsSync(MODEL_POLICY_SEED),
    dryRun,
  });
  if (action === "created") copyFileSync(MODEL_POLICY_SEED, MODEL_POLICY_PATH);
  return modelPolicyStep(action);
}

// A node:readline-backed prompt (backlog-migrate.ts pattern). No prompt library is
// in the dependency tree, so interactive Q&A is built directly on readline.
function makeReadlinePrompt(): Prompt {
  return {
    ask: (question, defaultValue) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${question} `, (answer) => {
          rl.close();
          resolve(answer.trim().length > 0 ? answer : (defaultValue ?? answer));
        });
      }),
    confirm: (question, defaultYes) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (answer) => {
          rl.close();
          const a = answer.trim().toLowerCase();
          if (a === "") return resolve(defaultYes);
          resolve(a === "y" || a === "yes");
        });
      }),
  };
}

// FG-346: the ASK-and-GENERATE host model-policy authoring path. Supplies the
// concrete IO (readline prompt, process.stdin.isTTY, doctorReport(), the fs writer,
// and the production loader for reload/summary) to the injectable orchestrator, so
// all decision logic stays unit-testable. Returns the orchestrator result — the CLI
// action folds result.step into the report and prints result.summaryText.
export async function provisionModelPolicyInteractive(opts: {
  dryRun: boolean;
  yes: boolean;
  reconfigure: boolean;
  selection?: HeadlessSelection;
}): Promise<HostModelPolicyResult> {
  return runHostModelPolicySetup({
    isTTY: !!process.stdin.isTTY,
    reconfigure: opts.reconfigure,
    dryRun: opts.dryRun,
    yes: opts.yes,
    selection: opts.selection,
    policyPresent: existsSync(MODEL_POLICY_PATH),
    probes: doctorReport(),
    prompt: makeReadlinePrompt(),
    writePolicy: (yaml) => writeFileSync(MODEL_POLICY_PATH, yaml),
    copySeed: () => {
      if (existsSync(MODEL_POLICY_SEED)) copyFileSync(MODEL_POLICY_SEED, MODEL_POLICY_PATH);
    },
    reload: () => safeLoadHostPolicy(),
    summaryCtx: {},
    loadExisting: () => safeLoadHostPolicy(),
    log: (m) => console.log(m),
  });
}

// Load the host policy tolerantly — a legacy/absent policy must not throw here (it
// only seeds reconfigure defaults / confirms a just-written file). The production
// loader still runs (version gate + Zod); we simply treat a refusal as "no policy".
function safeLoadHostPolicy() {
  try {
    return loadModelPolicy({});
  } catch {
    return undefined;
  }
}

// Ensure routing-policy.yml exists/compiled from the host RACI. routing-policy is
// derived (never hand-maintained), so setup recompiles it like upgrade does.
export function provisionRoutingPolicy(dryRun: boolean): SetupStep {
  const presentBefore = existsSync(ROUTING_POLICY_PATH);
  if (!existsSync(RACI_PATH)) {
    return routingPolicyStep({
      presentBefore,
      ensuredOk: presentBefore,
      detail: presentBefore
        ? "present (no host RACI to recompile from)"
        : "no routing-policy and no host RACI — run `forge upgrade` to install seeds",
    });
  }
  const res = compilePolicyFile(RACI_PATH, ROUTING_POLICY_PATH, { write: !dryRun });
  return routingPolicyStep({ presentBefore, ensuredOk: res.ok, detail: res.ok ? "" : res.error });
}

// Collect repeatable `--pin role=profile` flags into a role -> profile map.
function collectPin(value: string, prev: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new Error(`--pin expects role=profile, got '${value}'`);
  return { ...prev, [value.slice(0, eq).trim()]: value.slice(eq + 1).trim() };
}

type SetupOpts = {
  dryRun?: boolean;
  reviewProfile?: string;
  yes?: boolean;
  reconfigure?: boolean;
  defaultProfile?: string;
  reasoning?: string;
  review?: string;
  fast?: string;
  specWriter?: string;
  fastOrchestrator?: string;
  pin?: Record<string, string>;
};

// Assemble a HeadlessSelection from CLI flags, or undefined if none were given
// (which keeps the non-interactive path on the seed-default fallback).
function selectionFromOpts(opts: SetupOpts): HeadlessSelection | undefined {
  const rolePins = opts.pin && Object.keys(opts.pin).length > 0 ? opts.pin : undefined;
  const any =
    opts.defaultProfile || opts.reasoning || opts.review || opts.fast || opts.specWriter || opts.fastOrchestrator || rolePins;
  if (!any) return undefined;
  return {
    defaultProfile: opts.defaultProfile,
    reasoning: opts.reasoning,
    review: opts.review,
    fast: opts.fast,
    specWriter: opts.specWriter,
    fastOrchestrator: opts.fastOrchestrator,
    rolePins,
  };
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Get this host ready for forge: interactively author the model-policy from detected providers (or seed it), then run the read-only release check (#252, FG-346)")
    .option("--dry-run", "report/preview what setup would create/change without writing")
    .option("--review-profile <name>", "review-loop reviewer profile to verify (default: codex-subscription)")
    .option("--yes", "non-interactive: generate deterministically from selection flags, else retain the seed default (no prompts)")
    .option("--reconfigure", "re-author an existing host model-policy (preview + preserve unmodified choices); without it an existing policy is never overwritten")
    .option("--default-profile <name>", "headless: the defaults.profile / default-work profile")
    .option("--reasoning <name>", "headless: profile for reasoning-heavy work")
    .option("--review <name>", "headless: profile for review work")
    .option("--fast <name>", "headless: profile for fast/cheap work")
    .option("--spec-writer <name>", "headless: profile for spec-writer capability")
    .option("--fast-orchestrator <name>", "headless: profile for fast-orchestrator capability")
    .option("--pin <role=profile>", "headless: pin an agent role to a profile (repeatable)", collectPin, {})
    .action(async (opts: SetupOpts) => {
      const dryRun = opts.dryRun ?? false;
      // Provision FIRST so the release check below sees the just-created policy.
      // FG-346: the model-policy step now ASKS (interactive) or GENERATES (flags)
      // instead of copying the seed verbatim; the seed copy remains the
      // non-interactive/no-flags fallback inside runHostModelPolicySetup.
      const modelPolicy = await provisionModelPolicyInteractive({
        dryRun,
        yes: opts.yes ?? false,
        reconfigure: opts.reconfigure ?? false,
        selection: selectionFromOpts(opts),
      });
      // FG-560: after provisioning, classify the (now-present) host policy's schema
      // version so setup reflects schema_version 2 — read-only, `forge upgrade` owns
      // any migration.
      const provisioning: SetupStep[] = [
        modelPolicy.step,
        modelPolicyVersionStep(buildModelPolicyStatus({ forgeHome: FORGE_HOME })),
        provisionRoutingPolicy(dryRun),
      ];
      const inputs = gatherReleaseInputs(undefined, { projectDir: process.cwd() });
      const release = buildReleaseReport(inputs);
      const reviewLoop = reviewLoopReadiness(inputs, opts.reviewProfile ?? "codex-subscription");
      const report = buildSetupReport(provisioning, release, reviewLoop);
      console.log(renderSetupReport(report));
      if (modelPolicy.summaryText) {
        console.log("");
        console.log(modelPolicy.summaryText);
      }
      if (modelPolicy.advisory && !modelPolicy.summaryText) {
        // Surface the model-policy advisory (preserved / seed-retained / cancelled)
        // once, so headless runs name why no routing summary was produced.
        console.log(`\nmodel-policy: ${modelPolicy.advisory}`);
      }
      if (dryRun) console.log("\n(dry run — no files written)");
      process.exitCode = report.ready ? 0 : 1;
    });
}
