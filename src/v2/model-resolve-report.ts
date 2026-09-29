// FG-827: the report `forge model resolve <agent> [--activity <a>] --json` prints, built
// in ONE place so the dashboard's Roles Harness tab shows each activity's row from the
// same resolveModel call and the same runtime/effort/dispatchability reads as the CLI,
// rather than a second derivation that could drift from it.

import { resolveModel, isActivityUnmapped, activityUnmappedMessage, type ModelResolution } from "./model-resolution.js";
import { mappingPathSummary, buildActivityUnmappedDetail, type ActivityUnmappedDetail } from "./model-provenance.js";
import { probeAuth, type AuthProbe } from "./provider-doctor.js";
import { loadRuntime, loadModelPolicyWithSource, type LoadContext } from "./loader.js";
import { effortRecord, resolveRuntimeEffort, resolveRuntimeMetadata } from "./schema.js";
import { requiresStructuredResult } from "./role-capabilities.js";

export type ModelResolveReport = {
  ok: true;
  resolution: ModelResolution;
  legacy: boolean;
  mappingSummary: string | undefined;
  unmapped: ActivityUnmappedDetail | undefined;
  probe: AuthProbe | undefined;
  effort: string | undefined;
  effectiveToolCapable: boolean | undefined;
  dispatchable: boolean | undefined;
  toolCapabilityNote: string | undefined;
  /** Exactly the object `forge model resolve --json` prints. */
  json: Record<string, unknown>;
};

export function modelResolveReport(
  agent: string,
  opts: {
    activity?: string;
    profile?: string;
    check?: boolean;
    /** The load context resolveModel and the refusal's policy read use (the CLI: `{projectDir}`). */
    ctx: LoadContext;
    /** The load context the resolved runtime is read under (the CLI: `{}`, the live generation). */
    runtimeCtx?: LoadContext;
  },
): ModelResolveReport | { ok: false; error: string } {
  let resolution: ModelResolution;
  try {
    resolution = resolveModel({
      agentRole: agent,
      stepAlias: opts.activity,
      cliProfile: opts.profile,
      runtimeName: "claude",
      ctx: opts.ctx,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const probe: AuthProbe | undefined =
    opts.check && resolution.auth ? probeAuth(resolution.provider, resolution.auth) : undefined;

  const legacy = resolution.resolvedBy === "legacy";

  // FG-560: the mapping-path axis (exact vs default-fallback) is SEPARATE
  // from resolvedBy (profile selection). When the resolution is the
  // activity_unmapped refusal, build the full machine-readable detail — the
  // available mappings and the policy path come from the SAME policy load the
  // resolver used, so a script can read the refusal without re-resolving.
  const mappingSummary = legacy ? undefined : mappingPathSummary(resolution.mappingPath, resolution.capabilitySource);
  let unmapped: ActivityUnmappedDetail | undefined;
  if (!legacy && isActivityUnmapped(resolution)) {
    let availableMappings: string[] = [];
    let policyPath: string | null = null;
    try {
      const loaded = loadModelPolicyWithSource(opts.ctx);
      if (loaded.policy && resolution.profile) {
        availableMappings = Object.keys(loaded.policy.model_profiles[resolution.profile]?.map ?? {});
      }
      if (loaded.policy) policyPath = loaded.path;
    } catch {
      // A policy that fails to load is reported by the resolution path itself;
      // the refusal detail simply omits the mappings/path it could not read.
    }
    unmapped = buildActivityUnmappedDetail({
      agent,
      activity: resolution.alias ?? opts.activity ?? "",
      profile: resolution.profile ?? "",
      resolutionSource: resolution.resolvedBy,
      availableMappings,
      diagnosticDefaultModel: resolution.model,
      policyPath,
      message: activityUnmappedMessage(resolution) ?? "",
    });
  }

  // FG-339: compute tool capability and dispatchability for policy-mode resolutions.
  let effectiveToolCapable: boolean | undefined;
  let dispatchable: boolean | undefined;
  let toolCapabilityNote: string | undefined;
  let effort: string | undefined;
  if (!legacy) {
    try {
      const rt = loadRuntime(resolution.runtime, opts.runtimeCtx ?? {});
      effort = effortRecord(resolveRuntimeEffort(rt, resolution.effort));
      const runtimeMeta = resolveRuntimeMetadata(rt);
      effectiveToolCapable = resolution.toolCapable ?? (runtimeMeta.runtimeKind !== "pi");
      // FG-827: dispatch fails closed on an activity_unmapped refusal (invoke/runNext),
      // so the report must not call that resolution dispatchable.
      dispatchable = !unmapped && (!requiresStructuredResult(agent) || effectiveToolCapable);
    } catch {
      toolCapabilityNote = `(could not resolve runtime '${resolution.runtime}' — tool capability unknown)`;
      if (unmapped) dispatchable = false;
    }
  }

  const json = {
    // `resolution` already carries mappingPath / capabilitySource / outcome
    // (the two provenance axes + the refusal outcome); spread verbatim.
    ...resolution,
    ...(probe ? { availability: probe } : {}),
    ...(effort ? { effectiveEffort: effort } : {}),
    ...(!legacy && effectiveToolCapable !== undefined ? { toolCapable: resolution.toolCapable, effectiveToolCapable, dispatchable } : {}),
    ...(effectiveToolCapable === undefined && dispatchable !== undefined ? { dispatchable } : {}),
    // FG-560: the activity_unmapped refusal as a structured block a script
    // can branch on — present ONLY when the resolution is that refusal.
    ...(unmapped ? { activityUnmapped: unmapped } : {}),
  };

  return { ok: true, resolution, legacy, mappingSummary, unmapped, probe, effort, effectiveToolCapable, dispatchable, toolCapabilityNote, json };
}
