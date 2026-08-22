// FG-346: orchestrate `forge setup`'s host model-policy authoring. ALL IO is
// injected (prompt, provider probes, policy-present check, file writer, loader
// reload) so every branch below is unit-testable without a TTY, a real FS, or a
// live provider. Behavior is decided from an EXPLICIT isTTY + flags check up front,
// never inferred from a prompt failure.
//
// Branch matrix (the acceptance boundary):
//   (i)   existing host policy + not --reconfigure → NEVER overwrite; advisory.
//   (ii)  no offerable provider                    → advisory; no write.
//   (iii) interactive + absent policy              → Q&A, preview, write on confirm,
//                                                     reload + summarize.
//   (iv)  cancellation (declined at confirm)        → no write.
//   (v)   invalid selection                         → no write (advisory).
//   (vi)  --reconfigure (interactive)               → explicit preview mode, current
//                                                     policy seeds the defaults.
//   (vii) non-interactive + complete flags          → deterministic generate.
//   (viii) non-interactive + incomplete input       → retain the seed default with a
//                                                      NAMED advisory; never block.
//
// This is initial-authoring / explicit-reconfigure only. `forge upgrade` remains the
// sole migration authority; setup never migrates and is not a general setup wizard.

import type { ModelPolicy } from "./schema.js";
import type { LoadContext } from "./loader.js";
import type { AuthProbe } from "./provider-doctor.js";
import type { SetupStep } from "./setup.js";
import { offerableChoices, type ProfileChoice } from "./model-policy-choices.js";
import { generateModelPolicy, InvalidSelectionError } from "./model-policy-generator.js";
import { computeRoutingSummary, renderRoutingSummary, type RoutingLine } from "./model-policy-routing-summary.js";

// ── Injected IO ──────────────────────────────────────────────────────────────

export type Prompt = {
  /** Ask a free-form question; resolves to the raw answer (implementations trim). */
  ask: (question: string, defaultValue?: string) => Promise<string>;
  /** Yes/no confirmation. */
  confirm: (question: string, defaultYes: boolean) => Promise<boolean>;
};

/** Headless selection (from CLI flags) for deterministic non-interactive generation. */
export type HeadlessSelection = {
  defaultProfile?: string;
  reasoning?: string;
  review?: string;
  fast?: string;
  specWriter?: string;
  fastOrchestrator?: string;
  /** role -> profileName. */
  rolePins?: Record<string, string>;
};

export type HostModelPolicyDeps = {
  isTTY: boolean;
  reconfigure: boolean;
  dryRun: boolean;
  yes: boolean;
  selection?: HeadlessSelection;
  /** Whether an active host model-policy.yml already exists. */
  policyPresent: boolean;
  /** provider-doctor's report — the SOLE availability authority. */
  probes: AuthProbe[];
  prompt: Prompt;
  /** Write the generated YAML to the active host policy path. */
  writePolicy: (yaml: string) => void;
  /** Fallback: copy the seed to the active path (non-interactive, no flags). */
  copySeed?: () => void;
  /** Reload the just-written policy through the PRODUCTION loader (version gate + Zod). */
  reload: () => ModelPolicy | undefined;
  /** LoadContext for the summary resolver — must resolve to the SAME written policy. */
  summaryCtx?: LoadContext;
  /** For --reconfigure: the current policy, used to seed sensible defaults. */
  loadExisting?: () => ModelPolicy | undefined;
  log: (msg: string) => void;
};

export type HostModelPolicyAction =
  | "generated"
  | "generated-dry-run"
  | "preserved"
  | "seed-retained"
  | "no-provider"
  | "cancelled"
  | "invalid-selection";

export type HostModelPolicyResult = {
  action: HostModelPolicyAction;
  step: SetupStep;
  wrote: boolean;
  advisory?: string;
  summaryLines?: RoutingLine[];
  summaryText?: string;
  yamlPreview?: string;
};

// ── Answer shape ───────────────────────────────────────────────────────────

type Answers = {
  defaultProfile: string;
  activity: Record<string, string>;
  rolePins: Record<string, string>;
};

// ── Sensible defaults ─────────────────────────────────────────────────────

function pickPreferred(
  choices: ProfileChoice[],
  prefs: Array<[string, string]>,
  fallback: ProfileChoice,
): ProfileChoice {
  for (const [provider, family] of prefs) {
    const c = choices.find((x) => x.provider === provider && x.family === family);
    if (c) return c;
  }
  return fallback;
}

/** Sensible pre-selected defaults over the offered choices. `existing` (reconfigure)
 *  overrides where it names still-offered profiles. Guaranteed valid for non-empty
 *  choices. */
export function defaultAnswers(choices: ProfileChoice[], existing?: ModelPolicy): Answers {
  const fallback = choices[0];
  if (!fallback) throw new Error("defaultAnswers requires at least one offered choice");
  const names = new Set(choices.map((c) => c.profileName));

  const sonnet = pickPreferred(choices, [["anthropic", "sonnet"]], fallback);
  const opus = pickPreferred(choices, [["anthropic", "opus"], ["anthropic", "sonnet"]], fallback);
  const haiku = pickPreferred(choices, [["anthropic", "haiku"], ["anthropic", "sonnet"]], fallback);
  const main = sonnet;
  const codex = choices.find((c) => c.provider === "openai" && c.family === "codex");
  const skeptic = codex ?? choices.find((c) => c.profileName !== main.profileName) ?? main;

  let answers: Answers = {
    defaultProfile: main.profileName,
    activity: {
      default: main.profileName,
      reasoning: opus.profileName,
      review: haiku.profileName,
      fast: haiku.profileName,
    },
    rolePins: {
      "research-primary": main.profileName,
      "research-skeptic": skeptic.profileName,
    },
  };

  // Reconfigure: keep the operator's still-valid choices as the defaults.
  if (existing) {
    if (names.has(existing.defaults.profile)) answers.defaultProfile = existing.defaults.profile;
    for (const [cap, prof] of Object.entries(existing.defaults.activity)) {
      if (names.has(prof)) answers.activity[cap] = prof;
    }
    for (const [role, prof] of Object.entries(existing.overrides.agents)) {
      if (names.has(prof)) answers.rolePins[role] = prof;
    }
  }

  return answers;
}

// ── Answer resolution helpers ──────────────────────────────────────────────

/** Resolve a raw prompt/flag answer to a profile name. Accepts a 1-based index or a
 *  literal profile name; empty falls back to `fallback`. undefined = invalid. */
function resolveAnswer(raw: string, choices: ProfileChoice[], fallback: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  if (/^\d+$/.test(trimmed)) {
    const c = choices[Number(trimmed) - 1];
    return c ? c.profileName : undefined;
  }
  return choices.some((c) => c.profileName === trimmed) ? trimmed : undefined;
}

/** Deterministic answers from headless flags, filling gaps from `defaults`. Throws
 *  InvalidSelectionError if a named profile is not among the offered choices. */
export function buildAnswersFromSelection(
  choices: ProfileChoice[],
  selection: HeadlessSelection,
  defaults: Answers,
): Answers {
  const names = new Set(choices.map((c) => c.profileName));
  const require = (name: string | undefined, where: string): string | undefined => {
    if (name === undefined) return undefined;
    if (!names.has(name)) {
      throw new InvalidSelectionError(
        `${where} '${name}' is not among the offered choices (offered: ${[...names].join(", ") || "none"})`,
      );
    }
    return name;
  };

  const activity: Record<string, string> = { ...defaults.activity };
  activity.default = require(selection.defaultProfile, "--default-profile") ?? defaults.defaultProfile;
  if (selection.reasoning !== undefined) activity.reasoning = require(selection.reasoning, "--reasoning")!;
  if (selection.review !== undefined) activity.review = require(selection.review, "--review")!;
  if (selection.fast !== undefined) activity.fast = require(selection.fast, "--fast")!;
  if (selection.specWriter !== undefined) activity["spec-writer"] = require(selection.specWriter, "--spec-writer")!;
  if (selection.fastOrchestrator !== undefined) {
    activity["fast-orchestrator"] = require(selection.fastOrchestrator, "--fast-orchestrator")!;
  }

  const rolePins: Record<string, string> = { ...defaults.rolePins };
  for (const [role, prof] of Object.entries(selection.rolePins ?? {})) {
    rolePins[role] = require(prof, `--pin ${role}`)!;
  }

  return {
    defaultProfile: require(selection.defaultProfile, "--default-profile") ?? defaults.defaultProfile,
    activity,
    rolePins,
  };
}

/** A headless selection is COMPLETE enough to generate deterministically when it
 *  names at least the default profile — everything else falls back to defaults. */
export function hasCompleteSelection(selection?: HeadlessSelection): boolean {
  return !!selection && typeof selection.defaultProfile === "string" && selection.defaultProfile.length > 0;
}

// ── Interactive gather ──────────────────────────────────────────────────────

const CAPABILITY_PROMPTS: Array<[string, string]> = [
  ["default", "default work"],
  ["reasoning", "reasoning-heavy work"],
  ["review", "review work"],
  ["fast", "fast/cheap work"],
];

const ROLE_PROMPTS: Array<[string, string]> = [
  ["research-primary", "research primary (dual-research branch A)"],
  ["research-skeptic", "research skeptic (dual-research branch B — a different vendor keeps the branches independent)"],
];

function logChoices(log: (m: string) => void, choices: ProfileChoice[]): void {
  log("Available model profiles (from `forge providers doctor`):");
  choices.forEach((c, i) => {
    const tag = c.status === "unknown" ? `  [unverified: ${c.nextAction ?? "availability unknown"}]` : "";
    log(`  ${i + 1}. ${c.profileName}  (${c.model})${tag}`);
  });
}

async function askProfile(
  prompt: Prompt,
  log: (m: string) => void,
  choices: ProfileChoice[],
  label: string,
  defaultProfile: string,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await prompt.ask(`  ${label} [${defaultProfile}]`, defaultProfile);
    const resolved = resolveAnswer(raw, choices, defaultProfile);
    if (resolved) return resolved;
    log(`  '${raw.trim()}' is not a valid choice — enter a list number or a profile name.`);
  }
  throw new InvalidSelectionError(`no valid selection for '${label}' after 3 attempts`);
}

async function gatherAnswersInteractive(
  prompt: Prompt,
  log: (m: string) => void,
  choices: ProfileChoice[],
  defaults: Answers,
): Promise<Answers> {
  const activity: Record<string, string> = {};
  log("Map each capability to a profile (Enter accepts the default):");
  for (const [cap, label] of CAPABILITY_PROMPTS) {
    activity[cap] = await askProfile(prompt, log, choices, label, defaults.activity[cap] ?? defaults.defaultProfile);
  }
  const rolePins: Record<string, string> = {};
  log("Notable role pins:");
  for (const [role, label] of ROLE_PROMPTS) {
    rolePins[role] = await askProfile(prompt, log, choices, label, defaults.rolePins[role] ?? defaults.defaultProfile);
  }
  return { defaultProfile: activity["default"] ?? defaults.defaultProfile, activity, rolePins };
}

// ── Result builders ────────────────────────────────────────────────────────

function invalidResult(err: unknown): HostModelPolicyResult {
  const advisory = `invalid selection — nothing written: ${(err as Error).message}`;
  return {
    action: "invalid-selection",
    wrote: false,
    advisory,
    step: { name: "model-policy.yml", status: "warn", detail: advisory, next: "re-run `forge setup` and pick an offered profile" },
  };
}

function writeAndSummarize(deps: HostModelPolicyDeps, yaml: string): HostModelPolicyResult {
  deps.writePolicy(yaml);
  const reloaded = deps.reload();
  if (!reloaded) {
    const advisory = "wrote the model policy, but could not reload it via the loader to confirm routing.";
    return {
      action: "generated",
      wrote: true,
      advisory,
      yamlPreview: yaml,
      step: { name: "model-policy.yml", status: "warn", detail: advisory },
    };
  }
  const summaryLines = computeRoutingSummary(reloaded, deps.summaryCtx ?? {});
  const summaryText = renderRoutingSummary(summaryLines);
  return {
    action: "generated",
    wrote: true,
    summaryLines,
    summaryText,
    yamlPreview: yaml,
    step: {
      name: "model-policy.yml",
      status: "created",
      detail: "authored active host policy from your answers (schema_version 2, seed-derived model ids)",
    },
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function runHostModelPolicySetup(deps: HostModelPolicyDeps): Promise<HostModelPolicyResult> {
  // (i) existing policy + not reconfigure → preserve, never overwrite.
  if (deps.policyPresent && !deps.reconfigure) {
    const advisory = "active host model-policy.yml present — preserved (not overwritten). Re-author with `forge setup --reconfigure`.";
    return {
      action: "preserved",
      wrote: false,
      advisory,
      step: { name: "model-policy.yml", status: "ok", detail: advisory },
    };
  }

  // (ii) nothing offerable → advisory, no write.
  const choices = offerableChoices(deps.probes);
  if (choices.length === 0) {
    const advisory =
      "no usable provider detected (provider-doctor reports none available or unknown) — cannot author a model policy. " +
      "Configure a provider (e.g. `forge auth login`, `codex login`) then re-run `forge setup`.";
    return {
      action: "no-provider",
      wrote: false,
      advisory,
      step: { name: "model-policy.yml", status: "warn", detail: advisory, next: "configure a provider, then re-run `forge setup`" },
    };
  }

  const existing = deps.reconfigure ? deps.loadExisting?.() : undefined;
  const defaults = defaultAnswers(choices, existing);

  // Non-interactive.
  if (!deps.isTTY) {
    if (hasCompleteSelection(deps.selection)) {
      let answers: Answers;
      try {
        answers = buildAnswersFromSelection(choices, deps.selection!, defaults);
      } catch (e) {
        return invalidResult(e);
      }
      let gen;
      try {
        gen = generateModelPolicy({ choices, ...answers });
      } catch (e) {
        return invalidResult(e);
      }
      if (deps.dryRun) {
        deps.log(gen.yaml);
        return {
          action: "generated-dry-run",
          wrote: false,
          yamlPreview: gen.yaml,
          advisory: "dry run — previewed the generated policy, nothing written.",
          step: { name: "model-policy.yml", status: "would-create", detail: "would generate active host policy from flags", next: "run `forge setup` (without --dry-run) to write it" },
        };
      }
      return writeAndSummarize(deps, gen.yaml);
    }

    // (viii) non-interactive + incomplete input → retain seed default, never block.
    if (deps.reconfigure) {
      const advisory =
        "--reconfigure requires a TTY or complete selection flags — no interactive prompt is possible non-interactively, " +
        "so the existing policy is left unchanged (no seed copy).";
      return {
        action: "seed-retained",
        wrote: false,
        advisory,
        step: { name: "model-policy.yml", status: "warn", detail: advisory },
      };
    }
    if (!deps.dryRun) deps.copySeed?.();
    const advisory =
      "non-interactive with no selection flags — retained the seed default model policy (no Q&A). " +
      "Run `forge setup` in a TTY, or pass selection flags, to author routing.";
    return {
      action: "seed-retained",
      wrote: !deps.dryRun && !!deps.copySeed,
      advisory,
      step: { name: "model-policy.yml", status: deps.dryRun ? "would-create" : "created", detail: advisory },
    };
  }

  // Interactive (absent policy, or --reconfigure).
  if (deps.reconfigure) {
    deps.log("Reconfiguring host model routing — your current choices are pre-selected; Enter keeps them.");
  }
  logChoices(deps.log, choices);

  let answers: Answers;
  try {
    answers = await gatherAnswersInteractive(deps.prompt, deps.log, choices, defaults);
  } catch (e) {
    if (e instanceof InvalidSelectionError) return invalidResult(e);
    throw e;
  }

  let gen;
  try {
    gen = generateModelPolicy({ choices, ...answers });
  } catch (e) {
    return invalidResult(e);
  }

  deps.log("\nProposed ~/.forge/model-policy.yml:\n");
  deps.log(gen.yaml);

  if (deps.dryRun) {
    return {
      action: "generated-dry-run",
      wrote: false,
      yamlPreview: gen.yaml,
      advisory: "dry run — previewed the generated policy, nothing written.",
      step: { name: "model-policy.yml", status: "would-create", detail: "would generate active host policy from your answers", next: "run `forge setup` (without --dry-run) to write it" },
    };
  }

  const confirmed = await deps.prompt.confirm("Write this model policy to ~/.forge/model-policy.yml?", true);
  if (!confirmed) {
    const advisory = "cancelled — no model policy written.";
    return {
      action: "cancelled",
      wrote: false,
      advisory,
      step: { name: "model-policy.yml", status: "skip", detail: advisory },
    };
  }

  return writeAndSummarize(deps, gen.yaml);
}
