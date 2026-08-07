// FG-576 — the provider-neutral orchestrator capability/parity matrix, as DATA.
//
// Forge has exactly one interactive launcher today (`forge claude`) and it is
// provider-specific by construction, so there is no second in-repo adapter to
// mirror. This file is the explicit contract instead: nine capabilities, one row
// each, every row naming what BOTH adapters actually do. AC9's binding rule is
// that a capability a provider cannot supply is NAMED, never silently omitted
// and never manufactured — so every cell whose support is not "supported" must
// carry a `limitation` string, and the invariant is asserted in
// fg576-capability-matrix.test.ts rather than left to review.
//
// This module is DATA + adapter identity only. It performs no I/O, spawns
// nothing, and knows nothing about argv — src/v2/orchestrator-resolve.ts (the
// launch boundary) and the adapters under src/orchestrator/ consume it.

/** The interactive adapters this ticket ships. A closed set on purpose: an
 *  unsupported runtime must fail before spawn (AC5), never fall through to some
 *  generic adapter. */
export type OrchestratorAdapterId = "claude-code" | "codex";

export const ORCHESTRATOR_ADAPTER_IDS = ["claude-code", "codex"] as const satisfies readonly OrchestratorAdapterId[];

/** The nine capabilities AC9 enumerates. */
export type OrchestratorCapabilityId =
  | "instruction-source"
  | "skills-commands"
  | "permission-mode"
  | "auth"
  | "session-operations"
  | "heartbeat"
  | "usage-capture"
  | "remote-control"
  | "shutdown";

export const ORCHESTRATOR_CAPABILITY_IDS = [
  "instruction-source",
  "skills-commands",
  "permission-mode",
  "auth",
  "session-operations",
  "heartbeat",
  "usage-capture",
  "remote-control",
  "shutdown",
] as const satisfies readonly OrchestratorCapabilityId[];

/** How completely an adapter supplies a capability.
 *
 *  - `supported`      — the adapter supplies it; nothing is missing.
 *  - `partial`        — supplied, but with a named gap versus the other adapter.
 *  - `evidence-gated` — claimed ONLY on positive evidence gathered at launch;
 *                       constructing a flag is never evidence it was honored.
 *  - `unsupported`    — the provider cannot supply it and Forge does not fake it.
 *
 *  Anything other than `supported` MUST name its gap in `limitation`. */
export type CapabilitySupport = "supported" | "partial" | "evidence-gated" | "unsupported";

export type CapabilityCell = {
  support: CapabilitySupport;
  /** What THIS adapter actually does. Present for every cell, including
   *  unsupported ones (where it says what happens instead). */
  behavior: string;
  /** The named gap. Required whenever support !== "supported". */
  limitation?: string;
};

export type CapabilityRow = {
  capability: OrchestratorCapabilityId;
  /** Operator-facing title — the docs-parity surface (step 12). */
  title: string;
  adapters: Record<OrchestratorAdapterId, CapabilityCell>;
};

export const ORCHESTRATOR_CAPABILITIES: readonly CapabilityRow[] = [
  {
    capability: "instruction-source",
    title: "Instruction source",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior:
          "Forge's orchestrator policy is APPENDED to Claude Code's own base instructions " +
          "via --append-system-prompt-file; operator-owned CLAUDE.md is never spliced.",
      },
      codex: {
        support: "evidence-gated",
        behavior:
          "A Forge-owned instruction carrier, rendered from seeds/orchestrator-template.md into the " +
          "Forge seed generation, is bound PER LAUNCH through a Codex config override. Nothing is " +
          "written into the operator's Codex config root and CODEX_HOME is never redirected.",
        limitation:
          "Codex's instructions file SUBSTITUTES the base instruction surface where Claude's appends to it, " +
          "so the carrier must supply the scaffolding Codex would otherwise provide itself. The config key is " +
          "version-coupled and a per-launch override is not covered by --strict-config, so CONSTRUCTING the flag " +
          "is not evidence it was honored: registration as a fully initialized Forge orchestrator requires a " +
          "positive pre-spawn capability probe of the installed build (AC8).",
      },
    },
  },
  {
    capability: "skills-commands",
    title: "Skills and slash commands",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior: "Forge-installed skills and slash commands are available in the session (`forge init` publishes them).",
      },
      codex: {
        support: "unsupported",
        behavior: "The session runs with whatever the operator's own Codex configuration provides; Forge adds nothing.",
        limitation:
          "Codex has no equivalent to Claude skills or slash commands. This gap is NAMED rather than synthesized — " +
          "Forge does not translate Claude commands into guessed Codex equivalents.",
      },
    },
  },
  {
    capability: "permission-mode",
    title: "Permission / approval mode",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior:
          "Operator-owned. Claude Code's own permission mode and .claude/settings*.json decide; " +
          "Forge reads them for preflight and never overwrites them.",
      },
      codex: {
        support: "supported",
        behavior:
          "Operator-owned. Codex's own approval/sandbox mode decides; Forge never writes into the operator's " +
          "Codex config root and never sets an approval mode on the operator's behalf (D8).",
      },
    },
  },
  {
    capability: "auth",
    title: "Authentication",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior:
          "anthropic only: OAuth subscription, ANTHROPIC_API_KEY, or Bedrock, with the matching credential " +
          "preflight. The child environment is composed from the parent independently of any other adapter.",
      },
      codex: {
        support: "partial",
        behavior:
          "openai only: the ChatGPT subscription credential (~/.codex/auth.json, FORGE_CODEX_DIR seam). " +
          "No Claude preflight, no Claude auth variable, and no SSO watchdog ever runs on this path.",
        limitation:
          "openai/api (codex-apikey) is not wired, so an API-key Codex profile has no availability probe and " +
          "resolves as unknown rather than available. A Codex credential is never evidence that Claude may " +
          "launch, and the inverse also holds.",
      },
    },
  },
  {
    capability: "session-operations",
    title: "New / continue / resume",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior:
          "New sessions carry a Forge-ASSERTED session id (--session-id), so the receipt owns the identity " +
          "before spawn; --continue and --resume <id> map directly.",
      },
      codex: {
        support: "partial",
        behavior:
          "New, resume-by-id and resume-most-recent all map onto Codex's own operations.",
        limitation:
          "Codex cannot be told its session id, so identity is CORRELATED after spawn rather than asserted. Two " +
          "sessions started in one project inside the correlation window record strength 'ambiguous' rather than a " +
          "guessed binding. Cross-provider resume is refused from the durable receipt that minted the identifier, " +
          "never from its format — both providers use bare UUIDs (AC10).",
      },
    },
  },
  {
    capability: "heartbeat",
    title: "Heartbeat / liveness",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior:
          "Launcher-owned PROCESS liveness (pid plus a process-start identity token) is the live/not-live answer; " +
          "Claude's Stop hook additionally supplies INTERACTION evidence.",
      },
      codex: {
        support: "partial",
        behavior:
          "Launcher-owned PROCESS liveness in the same ~/.forge/orchestrators namespace, with the same " +
          "process-identity fence.",
        limitation:
          "Codex supplies no hook, so interaction evidence is absent and renders as `unknown`. Absence of a " +
          "provider hook is NEVER reported as healthy liveness and can never upgrade anything (AC7).",
      },
    },
  },
  {
    capability: "usage-capture",
    title: "Post-session usage capture",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior:
          "Usage rows are read from the session transcript identified by the receipt's ASSERTED session id and " +
          "bound to that receipt; a provider/receipt model mismatch is surfaced, never rewritten.",
      },
      codex: {
        support: "unsupported",
        behavior: "The receipt records the limitation explicitly and carries no usage rows.",
        limitation:
          "Codex exposes no equivalent authoritative usage evidence for an interactive session. The limitation is " +
          "a RECORDED VALUE on the receipt; no token counts or costs are fabricated (AC12).",
      },
    },
  },
  {
    capability: "remote-control",
    title: "Remote-control link",
    adapters: {
      "claude-code": {
        support: "evidence-gated",
        behavior:
          "When the live adapter exposes a remote-control URL, Forge captures it and holds it against the receipt " +
          "for the life of the session only. It is a LIVE CONTROL CREDENTIAL: served only from a project-scoped " +
          "read on a loopback bind, never in a cross-project projection, never durable project metadata.",
        limitation:
          "Absence, a disabled startup or unreadable provider state yields no link and NO failure — the URL is " +
          "never inferred from an unrelated or ended session (FG-448, D13).",
      },
      codex: {
        support: "unsupported",
        behavior: "No remote-control link is captured, offered, or implied for a Codex orchestrator.",
        limitation:
          "The installed codex build ships its own experimental remote-control surface, but FG-576 claims NO Codex " +
          "remote control: the capability is evidence-gated, and no independently supported evidence exists here.",
      },
    },
  },
  {
    capability: "shutdown",
    title: "Shutdown / close-out",
    adapters: {
      "claude-code": {
        support: "supported",
        behavior:
          "Child exit, signal and spawn failure each close the SAME receipt honestly (exited / spawn_failed). " +
          "Launcher loss records `orphaned`, which asserts lost launcher ownership only.",
      },
      codex: {
        support: "supported",
        behavior:
          "Identical launcher-owned close-out through the shared primitive — the two adapters cannot drift, " +
          "because neither owns the lifecycle.",
      },
    },
  },
];

/** A named gap for one adapter, in the shape a receipt records it. AC12's
 *  "no equivalent usage evidence" is one of these — a recorded value, never a
 *  fabricated number. */
export type CapabilityLimitation = {
  capability: OrchestratorCapabilityId;
  support: CapabilitySupport;
  note: string;
};

export function capabilityRow(capability: OrchestratorCapabilityId): CapabilityRow {
  const row = ORCHESTRATOR_CAPABILITIES.find((r) => r.capability === capability);
  if (!row) throw new Error(`no capability row for '${capability}' (matrix is incomplete)`);
  return row;
}

export function capabilityCell(
  capability: OrchestratorCapabilityId,
  adapter: OrchestratorAdapterId,
): CapabilityCell {
  return capabilityRow(capability).adapters[adapter];
}

/** Every capability this adapter does NOT fully supply, in matrix order. What the
 *  launcher copies onto the receipt so the gap is explained where the operator
 *  looks (AC9, AC11, AC12). */
export function limitationsForAdapter(adapter: OrchestratorAdapterId): CapabilityLimitation[] {
  const out: CapabilityLimitation[] = [];
  for (const row of ORCHESTRATOR_CAPABILITIES) {
    const cell = row.adapters[adapter];
    if (cell.support === "supported") continue;
    out.push({ capability: row.capability, support: cell.support, note: cell.limitation ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adapter identity + the model vocabulary an explicit --model is validated against
// ---------------------------------------------------------------------------

/** How strongly the provider lets Forge bind the session identity recorded on the
 *  receipt. Claude accepts an ASSERTED id pre-spawn; Codex does not, so its
 *  identity is CORRELATED after spawn (and degrades to `ambiguous` when two
 *  sessions in one project overlap — recorded by the Codex adapter, not here). */
export type SessionIdentityStrength = "asserted" | "correlated";

export type OrchestratorAdapterDescriptor = {
  id: OrchestratorAdapterId;
  /** Operator-facing name. */
  displayName: string;
  /** The provider whose credentials THIS adapter's CLI needs. The auth probe is
   *  run for this provider and no other (AC2 isolation). */
  provider: string;
  /** The host executable the adapter spawns. */
  executable: string;
  sessionIdentity: SessionIdentityStrength;
  /** Short aliases the provider CLI accepts for --model, verbatim. */
  modelAliases: readonly string[];
  /** Concrete model ids this provider's CLI accepts. */
  modelIdPattern: RegExp;
  /** Human description of the accepted vocabulary, used in the refusal text. */
  modelVocabularyDescription: string;
};

export const ORCHESTRATOR_ADAPTERS: Record<OrchestratorAdapterId, OrchestratorAdapterDescriptor> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    provider: "anthropic",
    executable: "claude",
    sessionIdentity: "asserted",
    // AC14 guard: `forge claude --model opus` predates this ticket and must keep
    // working, so the vocabulary is the ADAPTER's (aliases included) — NOT the
    // policy's concrete-id set, which contains no aliases at all.
    modelAliases: ["default", "sonnet", "opus", "haiku", "opusplan", "sonnet[1m]"],
    modelIdPattern: /^(claude-[a-z0-9._-]+|(?:us|eu|apac|global)\.anthropic\.[a-z0-9._:-]+|anthropic\.[a-z0-9._:-]+)$/i,
    modelVocabularyDescription:
      "a Claude Code alias (default, sonnet, opus, haiku, opusplan, sonnet[1m]) or a concrete anthropic model id " +
      "(claude-…, or a Bedrock id such as us.anthropic.…)",
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    provider: "openai",
    executable: "codex",
    sessionIdentity: "correlated",
    modelAliases: [],
    modelIdPattern: /^(gpt-[a-z0-9._-]+|o[0-9][a-z0-9._-]*|codex-[a-z0-9._-]+)$/i,
    modelVocabularyDescription: "a concrete OpenAI model slug (gpt-…, o3…, codex-…)",
  },
};

export function adapterDescriptor(adapter: OrchestratorAdapterId): OrchestratorAdapterDescriptor {
  return ORCHESTRATOR_ADAPTERS[adapter];
}

export type ModelVocabularyCheck = { ok: true } | { ok: false; reason: string };

/** Validate an explicit `--model` against the SELECTED adapter's vocabulary
 *  (AC4). Deliberately closed: a value that is neither a known alias nor a
 *  provider-shaped id is refused rather than passed through, which is also what
 *  keeps `--model opus` off a Codex command line and `--model gpt-5` off a Claude
 *  one. A leading dash cannot match either pattern, so an operand cannot be
 *  smuggled into argv through this flag. */
export function checkModelVocabulary(
  adapter: OrchestratorAdapterId,
  model: string,
): ModelVocabularyCheck {
  const d = adapterDescriptor(adapter);
  const value = model.trim();
  if (value === "" || value !== model) {
    return { ok: false, reason: `--model must be a non-empty value with no surrounding whitespace` };
  }
  if (d.modelAliases.includes(value)) return { ok: true };
  if (d.modelIdPattern.test(value)) return { ok: true };
  return {
    ok: false,
    reason:
      `--model '${model}' is not accepted by the ${d.displayName} adapter, which accepts ` +
      `${d.modelVocabularyDescription}`,
  };
}
