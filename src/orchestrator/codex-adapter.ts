// FG-576 step 7 — the Codex CLI adapter for the provider-neutral launcher.
//
// It implements src/orchestrator/adapter.ts — the SAME seven members the Claude
// adapter implements — and owns nothing durable: the receipt, the liveness record and
// the lifecycle all belong to src/orchestrator/launch.ts. That is what keeps the two
// providers from drifting; neither adapter owns the lifecycle, so neither can invent
// its own version of it.
//
// FIVE THINGS THAT ARE TRUE OF CODEX AND NOT OF CLAUDE, and are handled here rather
// than manufactured into a false parity:
//
//   1. THE CARRIER IS BOUND PER LAUNCH, NEVER INSTALLED (D8). Codex reads its
//      instruction surface from a config key, and the operator's Codex config root is
//      theirs. So the Forge-owned carrier is bound with a per-invocation config
//      override pointing INSIDE the Forge seed generation that rendered it. Nothing is
//      written into ~/.codex, no AGENTS.md is read or spliced, and CODEX_HOME is never
//      set or redirected — not even to a test root (the read seam is FORGE_CODEX_DIR,
//      which moves only where FORGE reads).
//
//   2. THE CARRIER IS EVIDENCE-GATED (AC8). Codex's instructions-file key is
//      version-coupled and a bare `-c` override is NOT covered by --strict-config: an
//      unsupported build accepts the flag and silently ignores it. So CONSTRUCTING the
//      flag is not evidence it was honored, and this adapter will not claim a fully
//      initialized Forge orchestrator without a POSITIVE pre-spawn probe of the
//      INSTALLED build. No evidence means one of exactly two outcomes — a refusal
//      before spawn naming the remedy, or a receipt that says, in its own recorded
//      fields, that this session is NOT fully initialized. Never a bare-Codex session
//      under a receipt claiming otherwise.
//
//   3. SESSION IDENTITY IS CORRELATED, NOT ASSERTED (AC9). codex has no --session-id,
//      so the identity is correlated AFTER spawn by src/orchestrator/codex-session-
//      state.ts, and two sessions started in one project inside the window record
//      `ambiguous` rather than a guess.
//
//   4. TWO THINGS ARE CALLED `--profile` AND THEY ARE NOT THE SAME AUTHORITY. Forge's
//      `--profile` names a MODEL-POLICY profile: it decides provider, model and auth,
//      and is recorded on the receipt. Codex's own `-p/--profile` names a CODEX CONFIG
//      profile, which can move the model, the provider endpoint and the instruction
//      surface out from under that recorded decision. Forge therefore never emits
//      `-p`, and `-p/--profile` is reserved from passthrough (D6) so the token cannot
//      arrive from the other side either. One command line, one authority.
//
//   5. AUTH IS CODEX-ONLY. The openai/subscription probe from provider-doctor is the
//      one the resolver ran (src/v2/orchestrator-resolve.ts runs exactly one probe,
//      for the selected provider), the child environment is COMPOSED from the parent
//      with Forge's Claude credential and control families withheld (see
//      buildCodexChildEnv), no Claude credential preflight runs on this path, and no
//      SSO watchdog is ever started.
//
// No Codex remote-control capability is claimed anywhere here (the matrix row says
// why), and no usage rows are ever written for a Codex session — AC12's limitation is
// a RECORDED VALUE on the receipt, not a fabricated number.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GENERATION_CODEX_CARRIER,
  codexCarrierPath,
  generationCodexCarrierState,
  resolveSeedGeneration,
} from "../v2/seed-generation.js";
import { findOrchestratorReceiptBySessionIdentity } from "../store/orchestrator-receipts.js";
import type { CapabilityLimitation } from "../store/orchestrator-receipts.js";
import { markTaskComplete, markTaskFailed } from "../store/tasks.js";
import {
  startCodexSessionCorrelation,
  type CodexCorrelationOptions,
  type CodexCorrelationWatch,
} from "./codex-session-state.js";
import {
  isSafeSessionIdentifier,
  launchRefusal,
  type AdapterArgvParts,
  type AdapterArgvResult,
  type AdapterCarrier,
  type AdapterCloseOutcome,
  type AdapterLaunchContext,
  type AdapterOperationResult,
  type AdapterReadiness,
  type AdapterReadinessResult,
  type AdapterSpawnObservation,
  type OrchestratorAdapter,
} from "./adapter.js";

/** The Codex config key that REPLACES the base instruction surface with a file. It is
 *  version-coupled (the `experimental_` prefix is the provider's own statement about
 *  that), which is exactly why AC8 makes it evidence-gated rather than assumed. */
export const CODEX_INSTRUCTIONS_CONFIG_KEY = "experimental_instructions_file";

/** The per-invocation config override. Per-launch by construction: it lives on this
 *  command line only, so nothing about the operator's Codex config is changed by a
 *  Forge launch, and a launch cannot leave anything behind (D8). */
export const CODEX_CONFIG_FLAG = "-c";

/** The lowest codex build Forge has POSITIVE evidence honors
 *  `experimental_instructions_file`. Derived from the build FG-576 was developed
 *  against (codex-cli 0.144.1); a build below it is not assumed broken, it is
 *  UNPROVEN, and this adapter refuses to register an unproven build as a fully
 *  initialized Forge orchestrator. Raise it only alongside evidence. */
export const CODEX_CARRIER_MIN_VERSION = "0.144.0";

/** The escape hatch for an operator who wants the session anyway on a build Forge
 *  cannot prove honors the carrier. It does NOT make the launch initialized — it
 *  converts the pre-spawn refusal into a receipt that says, in its recorded carrier
 *  acceptance and its limitations, that this session is not a fully initialized Forge
 *  orchestrator. Both halves of AC8's "refuse or degrade honestly" ship. */
export const CODEX_ALLOW_UNINITIALIZED_ENV = "FORGE_CODEX_ALLOW_UNINITIALIZED";

/** Every flag this adapter may itself emit — the argument-closure surface (step 9).
 *  `resume` and `--last` are codex's own session verbs, not options. */
export const CODEX_FORGE_OWNED_FLAGS = ["resume", "--last", "--model", "--cd", CODEX_CONFIG_FLAG] as const;

/** D6: the argv dimensions Forge owns, which provider passthrough may never set.
 *
 *  Model, project root and session identity are Forge's by AC4/AC6/AC10. `-c/--config`
 *  is here because a second config override could rebind the instruction surface the
 *  receipt records as provenance. `-p/--profile` is here because a Codex config profile
 *  is a SECOND authority over model/provider/instructions on a command line that
 *  already carries Forge's recorded decision. `--oss` swaps the provider outright.
 *  `exec` would make the run non-interactive under a receipt claiming a live
 *  interactive orchestrator, and `login`/`logout` would mutate the operator's auth
 *  during a launch whose auth mode is already recorded. */
export const CODEX_RESERVED_PASSTHROUGH_FLAGS = [
  "-m",
  "--model",
  "-c",
  "--config",
  "-p",
  "--profile",
  "-C",
  "--cd",
  "--oss",
  "resume",
  "--last",
  "exec",
  "login",
  "logout",
] as const;

// ---------------------------------------------------------------------------
// The AC8 capability probe
// ---------------------------------------------------------------------------

export type CodexVersionProbe = (executable: string, env: NodeJS.ProcessEnv) => string | null;

/** The default probe: ask the INSTALLED build what it is. Bounded and non-fatal — a
 *  probe that cannot run establishes NOTHING, which is recorded as nothing rather than
 *  as a failure (an absent binary must still reach the spawn path, so the receipt
 *  closes as `spawn_failed` with the real error instead of as a policy refusal). */
export const systemCodexVersionProbe: CodexVersionProbe = (executable, env) => {
  try {
    return execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
  } catch {
    return null;
  }
};

export type CodexCarrierSupport =
  | { kind: "supported"; version: string; evidence: string }
  | { kind: "unsupported"; version: string; detail: string }
  | { kind: "unknown"; detail: string };

const VERSION_IN_TEXT = /(\d+)\.(\d+)\.(\d+)/;

function parseVersion(text: string): [number, number, number] | null {
  const m = VERSION_IN_TEXT.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * What the probe's output establishes about THIS build's instructions-file capability.
 *
 * Three answers, and the difference between the last two is the whole of AC8:
 * `unsupported` is evidence the carrier would be silently ignored (refusable), while
 * `unknown` is the absence of evidence (never refusable — it must reach the spawn path
 * — but never claimable either).
 */
export function evaluateCodexCarrierSupport(versionOutput: string | null): CodexCarrierSupport {
  if (versionOutput === null || versionOutput.trim() === "") {
    return {
      kind: "unknown",
      detail:
        "`codex --version` could not be run before launch, so this build gave no evidence about whether it honors " +
        `\`${CODEX_INSTRUCTIONS_CONFIG_KEY}\``,
    };
  }
  const found = parseVersion(versionOutput);
  if (!found) {
    return {
      kind: "unknown",
      detail:
        `\`codex --version\` printed '${versionOutput.trim().split("\n")[0]}', which carries no version Forge can ` +
        `compare against ${CODEX_CARRIER_MIN_VERSION}`,
    };
  }
  const min = parseVersion(CODEX_CARRIER_MIN_VERSION)!;
  const version = found.join(".");
  if (compareVersions(found, min) < 0) {
    return {
      kind: "unsupported",
      version,
      detail:
        `the installed codex build reports version ${version}, below ${CODEX_CARRIER_MIN_VERSION} — the lowest build ` +
        `Forge has evidence honors \`${CODEX_INSTRUCTIONS_CONFIG_KEY}\`. A bare \`-c\` override is not covered by ` +
        `--strict-config, so this build would ACCEPT the flag and silently ignore the Forge-owned instructions`,
    };
  }
  return {
    kind: "supported",
    version,
    evidence: `codex --version reports ${version}, at or above ${CODEX_CARRIER_MIN_VERSION}, the lowest build with evidence it honors ${CODEX_INSTRUCTIONS_CONFIG_KEY}`,
  };
}

// ---------------------------------------------------------------------------
// Child environment (AC2)
// ---------------------------------------------------------------------------

/** The variable FAMILIES that are Forge's Claude credential and control surface, by
 *  prefix rather than by name.
 *
 *  `CLAUDE_` and `ANTHROPIC_` are Claude Code's own controls and credentials.
 *  `AWS_` is here because bedrock IS a Claude auth mode in forge (FORGE-DEC-007/013):
 *  `AWS_PROFILE` alongside `CLAUDE_CODE_USE_BEDROCK` is how a Claude launch reaches
 *  Bedrock, so on this path it is a Claude credential, not neutral operator state.
 *
 *  Prefixes rather than an exact list because the list is not Forge's to close: a
 *  Claude control variable that ships tomorrow must be excluded from a Codex child
 *  WITHOUT this file being edited. */
export const CLAUDE_CONTROL_ENV_PREFIXES = ["CLAUDE_", "ANTHROPIC_", "AWS_"] as const;

export function isClaudeControlEnvVar(name: string): boolean {
  return CLAUDE_CONTROL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The Codex child environment, COMPOSED — built up entry by entry from the parent,
 * never handed the parent wholesale.
 *
 * WHAT IT ADDS: nothing. There is no parameter through which a Claude credential could
 * arrive (see adapter.ts), and `CODEX_HOME` is deliberately not set — pointing the
 * child at another Codex home would move the operator's sessions and credentials out
 * from under them, which D8 forbids.
 *
 * WHAT IT WITHHOLDS: Forge's Claude credential and control surface, by family. An
 * interactive Codex session must not receive `CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`,
 * `ANTHROPIC_API_KEY` or their relatives merely because the operator's shell had them
 * armed for `forge claude`. Two providers, two independently composed environments —
 * neither one's credentials are the other's.
 *
 * The rule is a family DENYLIST and not an allowlist on purpose. This child is an
 * interactive coding agent that then runs the operator's own toolchain, so an
 * allowlist would silently strip whatever their tools need (`GOPATH`, `PNPM_HOME`, a
 * private registry token) and break work Forge knows nothing about. What Forge can
 * enumerate is its OWN provider surface, so that is what it withholds.
 *
 * The parent object is never mutated.
 */
export function buildCodexChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (isClaudeControlEnvVar(name)) continue;
    child[name] = value;
  }
  return child;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type CodexAdapterOptions = {
  versionProbe?: CodexVersionProbe;
  /** Resolved lazily so a test that sets FORGE_HOME after import is still isolated. */
  forgeHome?: string;
  /** Codex's own state root, READ-ONLY. Defaults to the FORGE_CODEX_DIR seam. */
  codexDir?: string;
  correlationPollMs?: number;
  correlationWindowMs?: number;
  /** Overrides the AC8 escape hatch for a direct call. Defaults to the env seam. */
  allowUninitialized?: boolean;
  report?: (line: string) => void;
};

const NOT_INITIALIZED =
  "this session is NOT a fully initialized Forge orchestrator: it runs under Codex's own instruction surface, " +
  "not the Forge-owned orchestrator policy";

/** new / continue / resume onto Codex's own session verbs. A module-level function
 *  rather than a method, because onSpawnConfirmed needs the SAME mapping for a resume
 *  (the identity is known there and nowhere else) and two copies of it would be two
 *  chances for the argv and the recorded identity to disagree. */
function mapOperation(ctx: AdapterLaunchContext): AdapterOperationResult {
  const op = ctx.operation;

  if (op.kind === "new") {
    return {
      ok: true,
      mapping: {
        argv: [],
        identity: {
          providerSessionId: null,
          strength: "unknown",
          basis:
            "Codex CLI cannot be told its session id, so nothing is asserted before spawn; the identity is " +
            "correlated afterwards from the session Codex itself records",
        },
        sessionTarget: null,
        notes: [],
        limitations: [],
      },
    };
  }

  if (op.kind === "continue") {
    return {
      ok: true,
      mapping: {
        // Codex's own resume-most-recent. Codex picks the session, exactly as
        // Claude's --continue does.
        argv: ["resume", "--last"],
        identity: {
          providerSessionId: null,
          strength: "unknown",
          basis:
            "Codex CLI selects the session for `resume --last` itself and cannot be told a session id, so Forge " +
            "asserts none",
        },
        sessionTarget: null,
        notes: [
          "`--continue` lets Codex choose the session, and no NEW session appears for Forge to correlate, so this " +
            "session's provider identity is not recorded. Use `forge orchestrator --resume <id>` to launch " +
            "against an identity Forge records.",
        ],
        limitations: [
          {
            capability: "session-operations",
            note:
              "a Codex `--continue` launch resumes an existing session, so the post-spawn correlation has nothing " +
              "new to observe and no provider session identity is bound to this receipt.",
          },
        ],
      },
    };
  }

  const target = op.sessionId;
  if (!isSafeSessionIdentifier(target)) {
    return {
      ok: false,
      refusal: launchRefusal(
        "unsafe-session-identifier",
        `--resume '${target}' is not a usable session identifier: it must start with a letter or digit and ` +
          `contain only letters, digits, '.', '_' and '-'. Forge refuses rather than sanitizing it, because a ` +
          `sanitized identifier would resume a session you did not ask for.`,
        [
          "pass the identifier exactly as `forge show` records it on the receipt",
          "or start a fresh session with `forge orchestrator`",
        ],
      ),
    };
  }

  // AC10 / D9: cross-provider resume is refused from the DURABLE RECEIPT that
  // minted the identifier, never from its format — both providers use bare UUIDs,
  // so a format check cannot tell them apart and must never be used.
  let owning: ReturnType<typeof findOrchestratorReceiptBySessionIdentity>;
  try {
    owning = findOrchestratorReceiptBySessionIdentity(target);
  } catch {
    owning = undefined;
  }
  if (owning && owning.adapter !== "codex") {
    return {
      ok: false,
      refusal: launchRefusal(
        "cross-provider-resume",
        `session '${target}' was launched by Forge under the ${owning.adapter} adapter (provider ` +
          `'${owning.provider}', runtime '${owning.runtime}'), so it cannot be resumed in Codex CLI. Resume is ` +
          `provider-bound: the identifier was looked up in the Forge receipt that minted it, not guessed from ` +
          `its format — both providers use bare UUIDs.`,
        [
          `resume it with its own provider: \`forge orchestrator --resume ${target}\` under a policy that ` +
            `resolves the orchestrator to '${owning.runtime}'`,
          "or start a fresh Codex session with `forge orchestrator`",
        ],
      ),
    };
  }

  return {
    ok: true,
    mapping: {
      argv: ["resume", target],
      identity: {
        providerSessionId: target,
        // Never `asserted`, even though the operator named it: codex is not told
        // this id as an identity, it is told which session to open, and it reports
        // nothing back. The binding is as strong as `correlated` and no stronger.
        strength: "correlated",
        basis: owning
          ? `operator-supplied identifier passed to \`codex resume\`, matched to the Forge receipt ${owning.receiptId} that recorded it`
          : `operator-supplied identifier passed to \`codex resume\`; no Forge receipt records it`,
      },
      sessionTarget: target,
      notes: owning
        ? []
        : [
            `no Forge receipt records session '${target}', so this resume is taken on the operator's word. ` +
              "The new receipt records the identifier and the fact that Forge did not mint it.",
          ],
      limitations: [],
    },
  };
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): OrchestratorAdapter {
  const versionProbe = opts.versionProbe ?? systemCodexVersionProbe;
  const report = opts.report ?? ((line: string) => console.error(line));
  const forgeHome = (): string => opts.forgeHome ?? process.env["FORGE_HOME"] ?? join(homedir(), ".forge");
  const allowUninitialized = (): boolean =>
    opts.allowUninitialized ?? ["1", "true", "yes"].includes((process.env[CODEX_ALLOW_UNINITIALIZED_ENV] ?? "").toLowerCase());

  const correlationOptions = (): CodexCorrelationOptions => ({
    ...(opts.codexDir !== undefined ? { codexDir: opts.codexDir } : {}),
    ...(opts.correlationPollMs !== undefined ? { pollMs: opts.correlationPollMs } : {}),
    ...(opts.correlationWindowMs !== undefined ? { windowMs: opts.correlationWindowMs } : {}),
  });

  /** Live for the duration of ONE session, in the adapter's closure — the launcher
   *  builds one adapter per launch, so there is nothing to key and nothing to leak. */
  let correlation: CodexCorrelationWatch | null = null;

  return {
    id: "codex",
    displayName: "Codex CLI",
    executable: "codex",
    forgeOwnedFlags: CODEX_FORGE_OWNED_FLAGS,
    reservedPassthroughFlags: CODEX_RESERVED_PASSTHROUGH_FLAGS,

    probeReadiness(ctx: AdapterLaunchContext): AdapterReadinessResult {
      // Probed with the CHILD's environment so PATH resolution matches the spawn that
      // follows — a probe that found a different binary would be evidence about the
      // wrong build.
      const support = evaluateCodexCarrierSupport(versionProbe("codex", buildCodexChildEnv(ctx.parentEnv)));
      const evidence: Record<string, string> = { carrierConfigKey: CODEX_INSTRUCTIONS_CONFIG_KEY };
      const advisories: string[] = [];
      const limitations: CapabilityLimitation[] = [];

      // Where the Forge-owned carrier for THIS launch comes from: the published seed
      // generation, pinned by that generation's own provenance manifest.
      const generation = resolveSeedGeneration(forgeHome());
      const carrierState = generation ? generationCodexCarrierState(generation) : ({ kind: "absent" } as const);

      if (carrierState.kind === "tampered") {
        // Not a degradation: these are bytes no release rendered. Binding them would
        // hand an interactive agent on the operator's machine an instruction surface
        // of unknown provenance, which is worse than not launching.
        return {
          ok: false,
          refusal: launchRefusal(
            "adapter-not-ready",
            `the Forge-owned Codex instruction carrier in the published seed generation does not match that ` +
              `generation's provenance manifest: ${carrierState.reason}. Forge refuses to bind an instruction ` +
              `surface no release rendered, so nothing was spawned.`,
            [
              "run `forge upgrade` to republish the seed generation from the executing release",
              "or launch a Claude-resolving profile while the generation is repaired: `forge orchestrator --profile <profile>`",
            ],
          ),
        };
      }

      if (support.kind === "supported") {
        evidence["codexVersion"] = support.version;
        evidence["carrierProbe"] = support.evidence;
      } else if (support.kind === "unsupported" && !allowUninitialized()) {
        // AC8's gate. Positive evidence that the carrier would be IGNORED, so the
        // launch refuses BEFORE spawn rather than registering a bare Codex session.
        return {
          ok: false,
          refusal: launchRefusal(
            "adapter-not-ready",
            `${support.detail}. Forge will not register a Codex session as a fully initialized Forge orchestrator ` +
              `without evidence that this build accepted the Forge-owned instruction carrier, so nothing was spawned.`,
            [
              `upgrade the codex CLI to ${CODEX_CARRIER_MIN_VERSION} or newer, then retry the same command`,
              `or set ${CODEX_ALLOW_UNINITIALIZED_ENV}=1 to launch anyway — the receipt will record this session as ` +
                `NOT fully initialized, and the Forge orchestrator policy will not be loaded`,
              `or select a Claude-resolving profile: \`forge orchestrator --profile <profile>\``,
            ],
          ),
        };
      } else {
        // Either no evidence at all (`unknown` — an absent or unrunnable binary must
        // reach the spawn path) or the operator's explicit degrade. Both bind NO
        // carrier and both say so on the receipt.
        limitations.push({
          capability: "instruction-source",
          note:
            `${support.kind === "unknown" ? support.detail : support.detail} — so no Forge-owned instruction carrier ` +
            `was bound to this session and ${NOT_INITIALIZED}.`,
        });
      }

      if (support.kind === "supported") {
        if (carrierState.kind === "present" && generation) {
          evidence["carrierPath"] = carrierState.path;
          evidence["carrierSha256"] = generation.manifest.files[GENERATION_CODEX_CARRIER] ?? "";
          evidence["carrierGeneration"] = generation.root;
          evidence["carrierRelease"] = generation.manifest.sourceAssetRoot;
        } else {
          limitations.push({
            capability: "instruction-source",
            note:
              `the published Forge seed generation carries no Codex instruction carrier ` +
              `(${generation ? `${codexCarrierPath(generation)} is absent` : "no seed generation is published"}), so ` +
              `none was bound and ${NOT_INITIALIZED}. Run \`forge upgrade\` to publish one.`,
          });
        }
      }

      return { ok: true, readiness: { evidence, advisories, limitations } };
    },

    declareInstructionCarrier(_ctx: AdapterLaunchContext, readiness: AdapterReadiness): AdapterCarrier {
      const path = readiness.evidence["carrierPath"];
      if (!path) {
        // The gap was already named by probeReadiness; do not double-record it.
        return { path: null, content: null, generation: null, acceptance: "unproven", evidence: null, argv: [], limitations: [] };
      }

      // `path` is null and `content` is null DELIBERATELY: the carrier already exists,
      // inside the immutable seed generation that rendered it and pinned its sha256.
      // The launcher materializes (and, on exit, removes) only what it wrote — so a
      // path here would delete the published generation's own artifact at close-out.
      // The bound file is recorded in `evidence` instead.
      return {
        path: null,
        content: null,
        generation: readiness.evidence["carrierGeneration"] ?? null,
        acceptance: "accepted",
        evidence:
          `${readiness.evidence["carrierProbe"]}; carrier bound per launch as ` +
          `\`${CODEX_CONFIG_FLAG} ${CODEX_INSTRUCTIONS_CONFIG_KEY}=${path}\` (sha256:${readiness.evidence["carrierSha256"]}, ` +
          `rendered by release ${readiness.evidence["carrierRelease"]}). Nothing was written to the operator's Codex ` +
          `config root and CODEX_HOME was not set.`,
        argv: [CODEX_CONFIG_FLAG, `${CODEX_INSTRUCTIONS_CONFIG_KEY}=${path}`],
        limitations: [],
      };
    },

    declareSessionIdentityStrength() {
      return "correlated";
    },

    mapSessionOperation(ctx: AdapterLaunchContext): AdapterOperationResult {
      return mapOperation(ctx);
    },

    buildArgv(ctx: AdapterLaunchContext, parts: AdapterArgvParts): AdapterArgvResult {
      const d = ctx.decision;
      // codex's session verbs are SUBCOMMANDS, so they lead; options follow.
      const argv: string[] = [...parts.operation.argv];

      // AC2/AC4: the concrete model reaches argv exactly once and is never Codex's
      // ambient default. Omitted only in legacy mode (no policy file and no --model),
      // where recording a model would be a fabricated selection.
      if (d.modelExplicit && d.model !== "") argv.push("--model", d.model);

      // AC6: the resolved project root, explicitly. The launcher also sets it as the
      // child's cwd; passing it as well means the recorded root and the one Codex acts
      // on are the same value rather than two things that happen to agree.
      argv.push("--cd", ctx.projectDir);

      // Deliberately NO `-p`: Forge's --profile is a model-policy profile, and Codex's
      // is a config profile. Emitting one for the other would put two authorities over
      // model/provider/instructions on one command line.
      argv.push(...parts.carrier.argv, ...ctx.passthrough);
      return { ok: true, argv };
    },

    buildChildEnv(ctx: AdapterLaunchContext): NodeJS.ProcessEnv {
      return buildCodexChildEnv(ctx.parentEnv);
    },

    preflight(ctx: AdapterLaunchContext): string[] {
      const warnings: string[] = [];
      // The openai/subscription probe the RESOLVER ran — one probe, for the selected
      // provider only. No Claude credential is read on this path, no Claude preflight
      // runs, and no SSO watchdog is started.
      const probe = ctx.decision.authProbe;
      if (probe.status !== "available") {
        warnings.push(
          `Codex auth (${probe.provider}/${probe.mode}) is ${probe.status}: ${probe.detail}. ` +
            `Run \`codex login\` if the session cannot authenticate (advisory only — continuing; \`codex\` handles ` +
            `its own auth failure).`,
        );
      }
      return warnings;
    },

    onSpawnConfirmed(ctx: AdapterLaunchContext): AdapterSpawnObservation {
      if (ctx.operation.kind === "resume") {
        // The operator named the session, so there is nothing to correlate: the
        // identity is known and recorded now, at its honest strength.
        const mapped = mapOperation(ctx);
        return mapped.ok ? { identity: mapped.mapping.identity } : {};
      }
      if (ctx.operation.kind === "continue") {
        // Codex resumed a session that already existed, so no new session appears for
        // the correlation to observe. The receipt already carries the limitation.
        return {};
      }

      try {
        correlation = startCodexSessionCorrelation(
          { receiptId: ctx.receiptId, projectDir: ctx.projectDir },
          correlationOptions(),
        );
      } catch {
        correlation = null;
      }
      return {};
    },

    closeOut(ctx: AdapterLaunchContext, outcome: AdapterCloseOutcome): void {
      // Never throws: close-out runs on the exit path, and a telemetry failure must not
      // change the exit code the operator sees.
      try {
        correlation?.stop();
      } catch {
        /* the timer is already gone */
      }
      correlation = null;

      if (outcome.state !== "exited") {
        settleTask(ctx.taskId, { failed: outcome.reason ?? "the interactive orchestrator never started" });
        return;
      }

      // AC12: the limitation is a RECORDED VALUE, and the absence of usage rows is the
      // honest consequence of it. Codex exposes no authoritative per-session usage
      // evidence, so nothing is written — not a zero row, not an estimate.
      settleTask(ctx.taskId, {
        complete: {
          usageRows: 0,
          usageLimitation:
            "Codex CLI exposes no authoritative per-session usage evidence, so no usage rows were captured for this " +
            "orchestrator session and no token counts or costs were inferred.",
        },
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      });
    },
  };

  /** The orchestrator instrumentation task the launcher opened (#163). Best-effort,
   *  exactly like the write that created it: telemetry ABOUT the session must not be
   *  able to fail the session. */
  function settleTask(
    taskId: string | null,
    outcome: { complete?: Record<string, unknown>; failed?: string; exitCode?: number | null; signal?: string | null },
  ): void {
    if (!taskId) return;
    try {
      if (outcome.failed !== undefined) {
        markTaskFailed(taskId, outcome.failed);
        return;
      }
      markTaskComplete(taskId, {
        ...outcome.complete,
        exitCode: outcome.exitCode ?? null,
        signal: outcome.signal ?? null,
      });
    } catch (e) {
      report(`forge: ⚠ could not settle the orchestrator task ${taskId}: ${(e as Error).message}`);
    }
  }
}
