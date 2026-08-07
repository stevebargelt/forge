// FG-576 step 5 — the Claude Code adapter for the provider-neutral launcher.
//
// It implements src/orchestrator/adapter.ts and owns NOTHING durable: the receipt,
// the liveness record and the lifecycle all belong to src/orchestrator/launch.ts,
// which is what keeps `forge orchestrator` and `forge claude` from drifting apart.
//
// FOUR THINGS THAT ARE SPECIFIC TO THIS PROVIDER AND ARE NOT MANUFACTURED ELSEWHERE:
//
//   1. FORGE-ASSERTED SESSION IDENTITY. Claude Code accepts `--session-id`, so a NEW
//      session's identity is minted by Forge BEFORE spawn and the receipt owns it.
//      That is also what keeps the launcher's liveness record and Claude's own Stop
//      hook file on ONE canonical key, so a session counts once (D12). `--continue`
//      cannot do this — Claude picks the conversation itself and its id is not
//      knowable before spawn — so that path records strength `unknown` rather than
//      guessing. Honest gaps are the point (AC9).
//
//   2. AN APPENDED INSTRUCTION CARRIER, NOT A SUBSTITUTED ONE. Claude's
//      --append-system-prompt* ADDS to its own base instructions, so the carrier is
//      the canonical seeds/orchestrator-template.md verbatim. Operator-owned
//      CLAUDE.md is never read, spliced or overwritten (D8).
//
//   3. EVIDENCE, NOT ASSUMPTION, ABOUT WHICH FLAG THE INSTALLED BUILD TAKES. The
//      readiness probe asks the installed `claude` what it accepts (`--help`) and the
//      carrier binds the flag that build actually advertises. Constructing a flag is
//      never evidence it was honored (AC8's rule, applied here even though Claude —
//      unlike Codex — rejects an unknown flag itself). When the probe establishes
//      nothing, the carrier records `unproven` and names the gap.
//
//   4. THE CHILD ENVIRONMENT IS COMPOSED FROM THE PARENT, INDEPENDENTLY. Bedrock
//      variables are injected into the CHILD only; the parent shell is never mutated,
//      and no other adapter's environment is ever extended (AC2). A credential-
//      selection variable the RESOLVED auth mode does not call for is withheld rather
//      than inherited, so the session cannot run under credentials its own receipt
//      contradicts (see buildClaudeChildEnv).
//
// The readiness probe is deliberately NOT a gate here. A missing `claude` binary must
// reach the spawn path and close the receipt as `spawn_failed` — turning it into a
// pre-spawn policy refusal would report an environment problem as a policy one.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assetRoot, executionMode } from "../v2/asset-root.js";
import {
  awsConfigDir,
  describeExpiredSsoSession,
  detectStaleStsCache,
  exportCredsOverridesStaleness,
  hasFreshProfileSsoCache,
  resolveProfileSsoIdentity,
} from "../util/creds.js";
import { readProjectAuth } from "../util/project-meta.js";
import type { EffectiveAuth } from "../v2/model-resolution.js";
import { startSsoWatchdog } from "../util/sso-watchdog.js";
import { findOrchestratorReceiptBySessionIdentity } from "../store/orchestrator-receipts.js";
import type { CapabilityLimitation, SessionIdentityStrength } from "../store/orchestrator-receipts.js";
import { markTaskComplete, markTaskFailed } from "../store/tasks.js";
import {
  captureClaudeOrchestratorUsage,
  clearRemoteControlLink,
  startRemoteControlCapture,
  type ClaudeSessionBinding,
  type RemoteControlCapture,
} from "./claude-session-state.js";
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

const ORCHESTRATOR_MARKER = "<!-- forge:orchestrator-start -->";

/** The flag forms this adapter will bind the carrier to, in preference order. The
 *  file form keeps an 80KB instruction surface out of argv; the inline form is the
 *  documented fallback the container path already uses (src/v2/spawn.ts). */
const CARRIER_FILE_FLAG = "--append-system-prompt-file";
const CARRIER_INLINE_FLAG = "--append-system-prompt";

/** Linux caps a SINGLE argv string at 128KB (MAX_ARG_STRLEN). The inline fallback
 *  stays well under it; a carrier that would not fit is dropped with a named
 *  limitation rather than truncated into a silently different instruction surface. */
const MAX_INLINE_CARRIER_BYTES = 100_000;

/** Every flag this adapter may itself emit. The argument-closure surface (step 9). */
export const CLAUDE_FORGE_OWNED_FLAGS = [
  "-n",
  "--model",
  "--session-id",
  "--resume",
  "--continue",
  CARRIER_FILE_FLAG,
  CARRIER_INLINE_FLAG,
] as const;

/** D6: the argv dimensions Forge owns, which provider passthrough may never set.
 *
 *  Model and session identity are Forge's by AC4/AC6. The instruction flags are here
 *  because a second instruction source would make the receipt's carrier provenance
 *  untrue. `-p/--print` is here for the same reason from the other direction: a
 *  non-interactive print run under a receipt claiming a live interactive orchestrator
 *  is a false receipt. `--settings` can carry environment and permission state that
 *  would move auth out from under the recorded decision. */
export const CLAUDE_RESERVED_PASSTHROUGH_FLAGS = [
  "-n",
  "--name",
  "-m",
  "--model",
  "--session-id",
  "-r",
  "--resume",
  "-c",
  "--continue",
  "--fork-session",
  CARRIER_FILE_FLAG,
  CARRIER_INLINE_FLAG,
  "--system-prompt",
  "--system-prompt-file",
  "--settings",
  "-p",
  "--print",
] as const;

export type ClaudeHelpProbe = (executable: string, env: NodeJS.ProcessEnv) => string | null;

/** The default probe: ask the INSTALLED build what it accepts. Bounded and
 *  non-fatal — a probe that cannot run establishes nothing, which is recorded as
 *  nothing rather than as a failure. */
export const systemClaudeHelpProbe: ClaudeHelpProbe = (executable, env) => {
  try {
    return execFileSync(executable, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
  } catch {
    return null;
  }
};

export type ClaudeAdapterOptions = {
  helpProbe?: ClaudeHelpProbe;
  /** The tree release-owned assets are read from. Defaults to assetRoot(). */
  assetRoot?: string;
  /** Resolved lazily so a test that sets FORGE_HOME after import is still isolated. */
  forgeHome?: string;
  // ---- FG-576 step 8. Every one of these DEFAULTS to the documented env seam, so a
  // real launch reads Claude's state root exactly where Claude wrote it; they exist so
  // a test can point the reader at a FAKE root instead of the operator's (AC13). ----
  /** Overrides claudeStateDir() — Claude Code's own state root. READ-only, always. */
  claudeStateDir?: string;
  /** Overrides orchestratorRemoteControlDir() — where the live credential is held. */
  remoteControlDir?: string;
  /** How often the session's transcript is checked for a remote-control URL. */
  remoteControlPollMs?: number;
  /** Where an AC12 mismatch or a close-out problem is surfaced. */
  report?: (line: string) => void;
};

// ---------------------------------------------------------------------------
// Child environment (AC2)
// ---------------------------------------------------------------------------

/** The variables that decide WHICH CREDENTIAL Claude Code talks to. Forge sets every
 *  one of them from the auth mode the receipt records, so an inherited value is
 *  withheld rather than passed through: a shell that armed `CLAUDE_CODE_USE_BEDROCK=1`
 *  for something else must not move a policy-selected subscription session onto
 *  Bedrock while its durable receipt says `subscription` (AC2).
 *
 *  Named exactly, not by prefix — unlike the Codex adapter's family denylist. This
 *  child IS Claude, so `CLAUDE_`/`ANTHROPIC_` here are its own behavior controls
 *  (output style, telemetry, config root) and withholding the family wholesale would
 *  strip settings the operator chose for the session they are about to sit in. What
 *  Forge owns on this path is the credential SELECTION, and that is what it withholds.
 *
 *  `CLAUDE_CODE_USE_VERTEX` is withheld in every mode: Forge resolves no Vertex auth
 *  mode at all, so no receipt could truthfully describe such a session.
 *  `AWS_PROFILE` is here because on a Claude launch it is the Bedrock credential
 *  selector (FORGE-DEC-007/013); the rest of the `AWS_` family stays, since without
 *  an activation flag it cannot move Claude's credentials and it is the operator's
 *  own toolchain state inside an interactive session. */
const CLAUDE_CREDENTIAL_SELECTION_ENV: Record<string, EffectiveAuth | null> = {
  CLAUDE_CODE_USE_BEDROCK: "bedrock",
  AWS_PROFILE: "bedrock",
  CLAUDE_CODE_USE_VERTEX: null,
  ANTHROPIC_API_KEY: "api",
  ANTHROPIC_AUTH_TOKEN: "api",
};

/**
 * The Claude child environment, COMPOSED from the parent — built up entry by entry
 * and returned as a NEW object, so the parent is never mutated and no other adapter's
 * environment is ever extended. Semantics preserved from `forge claude` (FG-158):
 * background tasks off for every Forge-owned session, bedrock variables injected only
 * when a bedrock profile was resolved.
 *
 * WHAT IT WITHHOLDS: every credential-selection variable that the RESOLVED auth mode
 * does not call for (see CLAUDE_CREDENTIAL_SELECTION_ENV). Inheriting one is how a
 * session ends up running under credentials its own receipt contradicts — the same
 * defect the Codex adapter carried, in its sibling.
 */
export function buildClaudeChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  auth: EffectiveAuth | undefined,
  bedrockProfile?: string,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (name in CLAUDE_CREDENTIAL_SELECTION_ENV && CLAUDE_CREDENTIAL_SELECTION_ENV[name] !== auth) continue;
    child[name] = value;
  }

  // Forge-owned sessions put durable work in tmux via `forge launch`.
  // Claude's background-task registry is vulnerable to harness-wide reaping.
  child["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] = "1";

  if (bedrockProfile) {
    child["CLAUDE_CODE_USE_BEDROCK"] = "1";
    child["AWS_PROFILE"] = bedrockProfile;
  }
  return child;
}

/** The AWS profile a bedrock-auth launch uses, in the order `forge claude` has
 *  always resolved it, minus the two flags that belong to that command's own
 *  surface (step 6 supplies them). Returns undefined when auth is not bedrock —
 *  which is what keeps AWS variables off a subscription or api-key launch. */
export function resolveClaudeBedrockProfile(ctx: AdapterLaunchContext): string | undefined {
  if (ctx.decision.auth !== "bedrock") return undefined;
  const projectAuth = readProjectAuth(ctx.projectDir);
  return projectAuth?.awsProfile ?? ctx.parentEnv["AWS_PROFILE"] ?? "default";
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The session identity THIS launch asserted, or null.
 *
 * Claude Code takes `--session-id`, so a new session's identity is Forge's own and a
 * resume acts on an identifier the operator named — both are asserted. `--continue`
 * lets Claude pick the conversation, so Forge asserts nothing and this is null. That
 * null is load-bearing: it is what stops post-session usage and the remote-control
 * credential from being attributed to whichever transcript happens to be newest.
 */
export function claudeAssertedSessionIdentity(
  ctx: AdapterLaunchContext,
): { sessionId: string | null; strength: SessionIdentityStrength } {
  const op = ctx.operation;
  if (op.kind === "new") return { sessionId: ctx.sessionKey, strength: "asserted" };
  if (op.kind === "resume" && isSafeSessionIdentifier(op.sessionId)) {
    return { sessionId: op.sessionId, strength: "asserted" };
  }
  return { sessionId: null, strength: "unknown" };
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): OrchestratorAdapter {
  const helpProbe = opts.helpProbe ?? systemClaudeHelpProbe;
  const report = opts.report ?? ((line: string) => console.error(line));

  const carrierSourcePath = (): string => join(opts.assetRoot ?? assetRoot(), "seeds", "orchestrator-template.md");
  const forgeHome = (): string => opts.forgeHome ?? process.env["FORGE_HOME"] ?? join(homedir(), ".forge");

  /** Roots passed to every provider-state read, so one launch reads one tree. */
  const stateOptions = (): { stateDir?: string; remoteControlDir?: string } => ({
    ...(opts.claudeStateDir !== undefined ? { stateDir: opts.claudeStateDir } : {}),
    ...(opts.remoteControlDir !== undefined ? { remoteControlDir: opts.remoteControlDir } : {}),
  });

  const bindingFor = (ctx: AdapterLaunchContext): ClaudeSessionBinding => {
    const identity = claudeAssertedSessionIdentity(ctx);
    return {
      projectDir: ctx.projectDir,
      sessionKey: ctx.sessionKey,
      receiptId: ctx.receiptId,
      providerSessionId: identity.sessionId,
      identityStrength: identity.strength,
    };
  };

  /** Live for the duration of ONE session. Held in the adapter's closure rather than
   *  a module map: the launcher builds one adapter per launch, so there is nothing to
   *  key and nothing to leak. */
  let remoteControl: RemoteControlCapture | null = null;

  return {
    id: "claude-code",
    displayName: "Claude Code",
    executable: "claude",
    forgeOwnedFlags: CLAUDE_FORGE_OWNED_FLAGS,
    reservedPassthroughFlags: CLAUDE_RESERVED_PASSTHROUGH_FLAGS,

    probeReadiness(ctx: AdapterLaunchContext): AdapterReadinessResult {
      // Probed with the CHILD's environment so PATH resolution matches the spawn
      // that follows — a probe that found a different binary would be evidence
      // about the wrong build.
      const env = buildClaudeChildEnv(ctx.parentEnv, ctx.decision.auth, resolveClaudeBedrockProfile(ctx));
      const help = helpProbe("claude", env);
      const evidence: Record<string, string> = {};
      const advisories: string[] = [];
      const limitations: CapabilityLimitation[] = [];

      if (help === null) {
        // Deliberately NOT a refusal: an absent or unrunnable `claude` must reach
        // the spawn path so the receipt closes as `spawn_failed` with the real
        // error, rather than being reported as a policy decision.
        limitations.push({
          capability: "instruction-source",
          note:
            "`claude --help` could not be run before launch, so this build gave no evidence about which " +
            "instruction flag it accepts. The Forge-owned orchestrator policy was not bound to this session; " +
            "the project's own CLAUDE.md orchestrator block still applies.",
        });
      } else if (help.includes(CARRIER_FILE_FLAG)) {
        evidence["carrierFlag"] = CARRIER_FILE_FLAG;
        evidence["carrierProbe"] = `claude --help advertises ${CARRIER_FILE_FLAG}`;
      } else if (help.includes(CARRIER_INLINE_FLAG)) {
        evidence["carrierFlag"] = CARRIER_INLINE_FLAG;
        evidence["carrierProbe"] = `claude --help advertises ${CARRIER_INLINE_FLAG} (no file form on this build)`;
      } else {
        limitations.push({
          capability: "instruction-source",
          note:
            `the installed claude build advertises neither ${CARRIER_FILE_FLAG} nor ${CARRIER_INLINE_FLAG}, so the ` +
            "Forge-owned orchestrator policy was not bound to this session; the project's own CLAUDE.md " +
            "orchestrator block still applies.",
        });
      }

      return { ok: true, readiness: { evidence, advisories, limitations } };
    },

    declareInstructionCarrier(ctx: AdapterLaunchContext, readiness: AdapterReadiness): AdapterCarrier {
      const none = (note: string): AdapterCarrier => ({
        path: null,
        content: null,
        generation: null,
        acceptance: "unproven",
        evidence: null,
        argv: [],
        limitations: [{ capability: "instruction-source", note }],
      });

      const flag = readiness.evidence["carrierFlag"];
      if (!flag) {
        // The gap was already named by probeReadiness; do not double-record it.
        return { path: null, content: null, generation: null, acceptance: "unproven", evidence: null, argv: [], limitations: [] };
      }

      const source = carrierSourcePath();
      let content: string;
      try {
        content = readFileSync(source, "utf8");
      } catch (e) {
        return none(
          `the canonical orchestrator policy at ${source} could not be read (${(e as Error).message}), so no ` +
            "Forge-owned instruction carrier was bound to this session.",
        );
      }

      const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const generation = `${executionMode()}@${digest}`;

      if (flag === CARRIER_INLINE_FLAG) {
        if (Buffer.byteLength(content, "utf8") > MAX_INLINE_CARRIER_BYTES) {
          return none(
            `this claude build accepts only ${CARRIER_INLINE_FLAG}, and the canonical orchestrator policy ` +
              `(${Buffer.byteLength(content, "utf8")} bytes) is too large to pass through argv safely, so no ` +
              "Forge-owned instruction carrier was bound to this session.",
          );
        }
        return {
          path: null,
          content: null,
          generation,
          acceptance: "accepted",
          evidence: `${readiness.evidence["carrierProbe"]}; policy rendered from ${source} (sha256:${digest})`,
          argv: [CARRIER_INLINE_FLAG, content],
          limitations: [],
        };
      }

      return {
        // Launcher-owned, under Forge's own root. Nothing is written into the
        // operator's Claude config root and CLAUDE.md is never touched (D8).
        path: join(forgeHome(), "orchestrators", "prompts", `${ctx.sessionKey}.md`),
        content,
        generation,
        acceptance: "accepted",
        evidence: `${readiness.evidence["carrierProbe"]}; policy rendered from ${source} (sha256:${digest})`,
        argv: [CARRIER_FILE_FLAG, join(forgeHome(), "orchestrators", "prompts", `${ctx.sessionKey}.md`)],
        limitations: [],
      };
    },

    declareSessionIdentityStrength() {
      return "asserted";
    },

    mapSessionOperation(ctx: AdapterLaunchContext): AdapterOperationResult {
      const op = ctx.operation;

      if (op.kind === "new") {
        // ctx.sessionKey IS the id Forge minted for this launch (see mintClaudeSessionKey),
        // so the receipt, the liveness record and Claude's own transcript agree.
        return {
          ok: true,
          mapping: {
            argv: ["--session-id", ctx.sessionKey],
            identity: {
              providerSessionId: ctx.sessionKey,
              strength: "asserted",
              basis: "Forge minted the session id and passed it to Claude Code via --session-id before spawn",
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
            argv: ["--continue"],
            identity: {
              providerSessionId: null,
              strength: "unknown",
              basis:
                "Claude Code selects the conversation for --continue itself, so its session id is not knowable " +
                "before spawn and Forge asserts none",
            },
            sessionTarget: null,
            notes: [
              "--continue lets Claude Code choose the conversation, so this session's provider identity is not " +
                "recorded. Use `forge orchestrator --resume <id>` to launch against an identity Forge owns.",
            ],
            limitations: [
              {
                capability: "session-operations",
                note:
                  "a --continue launch has no Forge-asserted session identity, so post-session usage cannot be " +
                  "bound to it by identity and its provider hook record is not joinable to the launcher record.",
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

      // AC10: cross-provider resume is refused from the DURABLE RECEIPT that minted
      // the identifier, never from its format — both providers use bare UUIDs, so a
      // format check cannot tell them apart and must never be used.
      let owning: ReturnType<typeof findOrchestratorReceiptBySessionIdentity>;
      try {
        owning = findOrchestratorReceiptBySessionIdentity(target);
      } catch {
        owning = undefined;
      }
      if (owning && owning.adapter !== "claude-code") {
        return {
          ok: false,
          refusal: launchRefusal(
            "cross-provider-resume",
            `session '${target}' was launched by Forge under the ${owning.adapter} adapter (provider ` +
              `'${owning.provider}', runtime '${owning.runtime}'), so it cannot be resumed in Claude Code. Resume is ` +
              `provider-bound: the identifier was looked up in the Forge receipt that minted it, not guessed from ` +
              `its format.`,
            [
              `resume it with its own provider: \`forge orchestrator --resume ${target}\` under a policy that ` +
                `resolves the orchestrator to '${owning.runtime}'`,
              "or start a fresh Claude session with `forge orchestrator`",
            ],
          ),
        };
      }

      return {
        ok: true,
        mapping: {
          argv: ["--resume", target],
          identity: {
            providerSessionId: target,
            strength: "asserted",
            basis: owning
              ? `operator-supplied identifier, matched to the Forge receipt ${owning.receiptId} that minted it`
              : "operator-supplied identifier passed to Claude Code via --resume; no Forge receipt recorded it",
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
    },

    buildArgv(ctx: AdapterLaunchContext, parts: AdapterArgvParts): AdapterArgvResult {
      const d = ctx.decision;
      const argv: string[] = ["-n", ctx.projectName];

      // AC2/AC4: the concrete model reaches argv exactly once and is never Claude
      // Code's ambient default. It is omitted only in legacy mode (no policy file and
      // no --model), where recording a model would be a fabricated selection — and
      // the decision carries a note saying exactly that.
      if (d.modelExplicit && d.model !== "") argv.push("--model", d.model);

      argv.push(...parts.operation.argv, ...parts.carrier.argv, ...ctx.passthrough);
      return { ok: true, argv };
    },

    buildChildEnv(ctx: AdapterLaunchContext): NodeJS.ProcessEnv {
      return buildClaudeChildEnv(ctx.parentEnv, ctx.decision.auth, resolveClaudeBedrockProfile(ctx));
    },

    preflight(ctx: AdapterLaunchContext): string[] {
      const warnings = claudeProjectPreflight(ctx.projectDir);
      const bedrockProfile = resolveClaudeBedrockProfile(ctx);
      if (bedrockProfile) warnings.push(...claudeBedrockAdvisories(bedrockProfile));
      return warnings;
    },

    onSpawnConfirmed(ctx: AdapterLaunchContext): AdapterSpawnObservation {
      // Identity was asserted before spawn, so there is nothing to correlate. The
      // SSO watchdog keeps the bedrock credential fresh for the life of the session;
      // it is a no-op unless FORGE_SSO_WATCHDOG names an installed script.
      if (ctx.decision.auth === "bedrock" && ctx.runId) startSsoWatchdog(ctx.runId);

      // FG-448: capture is REQUIRED behavior, not a nicety — a live session whose
      // remote-control URL is available and is not captured is a defect. It cannot be
      // read once at spawn (the URL does not exist yet: `remoteControlAtStartup` may
      // be off and the operator may run `/remote-control` at any point), so the
      // session's own transcript is watched for the life of the session. Absence, a
      // disabled startup and unreadable provider state all yield no link and NO
      // failure — see startRemoteControlCapture, which never throws.
      try {
        remoteControl = startRemoteControlCapture(bindingFor(ctx), {
          ...stateOptions(),
          ...(opts.remoteControlPollMs !== undefined ? { pollMs: opts.remoteControlPollMs } : {}),
        });
      } catch {
        remoteControl = null;
      }
      return {};
    },

    closeOut(ctx: AdapterLaunchContext, outcome: AdapterCloseOutcome): void {
      // Never throws: close-out runs on the exit path, and a telemetry failure must
      // not change the exit code the operator sees.
      try {
        remoteControl?.stop();
      } catch {
        /* the timer is already gone */
      }
      remoteControl = null;

      // The credential dies with the session, ALWAYS — on a clean exit, on a crash,
      // and on a spawn that never happened. It is a live control credential, never
      // durable metadata, so its removal is unconditional and comes first.
      try {
        clearRemoteControlLink(ctx.sessionKey, stateOptions());
      } catch {
        /* nothing to remove */
      }

      if (outcome.state !== "exited") {
        // Nothing ran, so there is no usage and no session to account for. The task
        // is settled as failed rather than left `running` forever — an orchestrator
        // task with no process behind it is the same lie as a `running` receipt with
        // no process behind it.
        settleTask(ctx.taskId, { failed: outcome.reason ?? "the interactive orchestrator never started" });
        return;
      }

      let summary: Record<string, unknown> = {};
      try {
        const capture = captureClaudeOrchestratorUsage(
          {
            ...bindingFor(ctx),
            taskId: ctx.taskId,
            expectedModel: ctx.decision.modelExplicit ? ctx.decision.model : null,
            alias: ctx.decision.profile ?? null,
          },
          stateOptions(),
        );
        summary = {
          usageRows: capture.rowCount,
          transcript: capture.transcriptPath,
          ...(capture.skipped ? { usageSkipped: capture.skipped } : {}),
          ...(capture.error ? { usageError: capture.error } : {}),
          ...(capture.mismatches.length > 0 ? { modelMismatches: capture.mismatches } : {}),
        };

        // AC12: SURFACE the disagreement, never rewrite it. The rows keep the
        // provider's own model value and the receipt keeps the decision it recorded;
        // what the operator gets is the fact that the two disagree.
        for (const mismatch of capture.mismatches) {
          report(
            `forge: ⚠ usage for request ${mismatch.requestId} reports model '${mismatch.providerModel}', but this ` +
              `orchestrator receipt recorded '${mismatch.receiptModel}'. The provider's value is kept as-is; ` +
              `neither the usage row nor the receipt was rewritten.`,
          );
        }
        if (capture.error) {
          report(`forge: ⚠ post-session usage capture failed: ${capture.error}`);
        }
      } catch (e) {
        summary = { usageError: (e as Error).message };
      }

      settleTask(ctx.taskId, { complete: summary, exitCode: outcome.exitCode, signal: outcome.signal });
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
    } catch {
      /* telemetry only */
    }
  }
}

// ---------------------------------------------------------------------------
// Preflight (advisory only — FG-499)
// ---------------------------------------------------------------------------

/** The project-shape warnings `forge claude` has always printed. Non-blocking: the
 *  operator can still launch into a half-configured session on purpose. */
export function claudeProjectPreflight(projectRoot: string): string[] {
  const warnings: string[] = [];

  const claudeMd = join(projectRoot, "CLAUDE.md");
  let hasOrchestrator = false;
  try {
    hasOrchestrator = existsSync(claudeMd) && readFileSync(claudeMd, "utf8").includes(ORCHESTRATOR_MARKER);
  } catch {
    hasOrchestrator = false;
  }
  if (!hasOrchestrator) {
    warnings.push(`CLAUDE.md has no forge orchestrator block. Run \`forge init\` to bootstrap.`);
    return warnings; // skip remaining checks; nothing else applies
  }

  if (!existsSync(join(projectRoot, ".claude", "settings.local.json"))) {
    warnings.push(`.claude/settings.local.json missing (heartbeats won't fire). Run \`forge init\`.`);
  }

  const commandsDir = join(projectRoot, ".claude", "commands");
  if (existsSync(commandsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(commandsDir);
    } catch {
      names = [];
    }
    for (const name of ["orient.md", "handoff.md"]) {
      if (!names.includes(name)) continue;
      const target = join(commandsDir, name);
      try {
        if (!lstatSync(target).isSymbolicLink()) continue;
        const linkTarget = readlinkSync(target);
        if (linkTarget.endsWith(`/scripts/claude-commands/${name}`) && !existsSync(target)) {
          warnings.push(`.claude/commands/${name} → ${linkTarget} (target missing). Run \`forge upgrade\` to repoint.`);
        }
      } catch {
        /* skip */
      }
    }
  } else {
    warnings.push(`.claude/commands/ missing (/orient, /handoff unavailable). Run \`forge init\`.`);
  }

  return warnings;
}

/** The STS / SSO findings `forge claude` reports for a bedrock launch. ADVISORY ONLY
 *  and scoped to the resolved profile (FG-435, FG-499): an interactive session
 *  handles its own auth failure natively, so forge must never exit non-zero here. */
export function claudeBedrockAdvisories(profile: string): string[] {
  const out: string[] = [];

  const staleness = detectStaleStsCache({ profile });
  if (staleness?.stale) {
    out.push(
      exportCredsOverridesStaleness(profile)
        ? `${staleness.reason} (advisory — \`aws configure export-credentials\` succeeded for '${profile}', continuing)`
        : `${staleness.reason}\n` +
            `  Credential export also failed for '${profile}' — its SSO session likely needs a fresh login.\n` +
            `  Run: aws sso login --profile ${profile}\n` +
            `  (advisory only — continuing; \`claude\` will handle any auth failure itself)`,
    );
  }

  // detectStaleStsCache only fires when the profile has its own ~/.aws/cli/cache
  // entry. A profile authenticating SSO-direct (FORGE-DEC-013) has none, so an
  // expired SSO session sails through the check above. resolveProfileSsoIdentity
  // gates it: null means "SSO not applicable", not "SSO expired".
  try {
    if (resolveProfileSsoIdentity(awsConfigDir(), profile) && !hasFreshProfileSsoCache(awsConfigDir(), profile)) {
      out.push(
        exportCredsOverridesStaleness(profile)
          ? `SSO session for '${profile}' looks expired or missing (advisory — \`aws configure export-credentials\` succeeded, continuing)`
          : `${describeExpiredSsoSession(awsConfigDir(), profile)}\n` +
              `  (advisory only — continuing; \`claude\` will handle any auth failure itself)`,
      );
    }
  } catch {
    /* an unreadable AWS config is not a launch failure */
  }

  return out;
}
