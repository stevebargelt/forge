// forge v2 — provider availability probing (AWN-7 Crawl).
//
// Backs `forge providers doctor` (which auth modes have working credentials in
// this environment?) and `forge model resolve --check` (is the resolved auth
// actually available?). Probes are host-side and cheap — no docker calls. The
// subscription (OAuth) probe reads the host-side hint file written by
// `forge auth login`; bedrock/api are pure env checks.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasAwsSsoConfigured, readOauthHint, codexAuthFile } from "../util/creds.js";
import type { EffectiveAuth, ModelResolution } from "./model-resolution.js";

export type ProbeStatus = "available" | "unavailable" | "unknown";

export type AuthProbe = {
  provider: string;
  mode: EffectiveAuth;
  status: ProbeStatus;
  detail: string;
};

// Which (provider, auth) pairs forge can probe today. Walk adds an `openai` row
// (OPENAI_API_KEY for api; codex subscription) when the Codex provider lands.
const PROBEABLE_AUTH_BY_PROVIDER: Record<string, readonly EffectiveAuth[]> = {
  anthropic: ["subscription", "api", "bedrock"],
  openai: ["subscription"], // Codex; api (codex-apikey) is the deferred second mode
};

// Provider-aware availability probe. The auth vocabulary (subscription/api/
// bedrock) is shared, but what makes a mode "available" is provider-specific —
// `api` means ANTHROPIC_API_KEY for anthropic, OPENAI_API_KEY for openai (Walk).
// An unprobeable provider returns "unknown" (never blocks). NOTE (#303): since
// #265 an explicit-runtime profile (e.g. pi-apikey + provider: groq) SKIPS the
// bindRuntime table, so an unprobeable upstream provider no longer fails loud
// there — it resolves silently with no probe and no key injection. Adding probe
// rows + cross-provider key injection so doctor can surface this is #303.
export function probeAuth(provider: string | undefined, mode: EffectiveAuth): AuthProbe {
  if (provider === "anthropic") return { provider, ...probeAnthropic(mode) };
  if (provider === "openai") return { provider, ...probeOpenai(mode) };
  return {
    provider: provider ?? "(none)",
    mode,
    status: "unknown",
    detail: `no availability probe for provider '${provider ?? "(none)"}' yet (AWN-7 Walk)`,
  };
}

// Codex auth (AWN-7 Walk). subscription availability = the host credential
// (~/.codex/auth.json) is present — host-side check, no docker call, mirroring
// the bedrock/api env probes. api (codex-apikey) is the deferred second mode.
function probeOpenai(mode: EffectiveAuth): Omit<AuthProbe, "provider"> {
  if (mode === "subscription") {
    const file = codexAuthFile();
    return existsSync(file)
      ? { mode, status: "available", detail: `Codex subscription credential present (${file})` }
      : { mode, status: "unavailable", detail: "no ~/.codex/auth.json — run `codex login`" };
  }
  return { mode, status: "unknown", detail: `openai/${mode} probe not implemented (Walk: subscription only)` };
}

function probeAnthropic(mode: EffectiveAuth): Omit<AuthProbe, "provider"> {
  switch (mode) {
    case "bedrock": {
      // Availability is about AWS CREDENTIALS, not the CLAUDE_CODE_USE_BEDROCK
      // env var. That var is the auto-SELECTION signal (auth: auto picks bedrock
      // from it) — but a PINNED bedrock profile works regardless, because the
      // claude-bedrock runtime sets CLAUDE_CODE_USE_BEDROCK=1 itself. So report on
      // AWS profile/config presence; surface the selection var as info only.
      const aws =
        !!process.env.AWS_PROFILE ||
        hasAwsSsoConfigured() ||
        existsSync(join(homedir(), ".aws", "config"));
      const sel = process.env.CLAUDE_CODE_USE_BEDROCK === "1" ? "; CLAUDE_CODE_USE_BEDROCK=1" : "";
      return aws
        ? { mode, status: "available", detail: `AWS profile/config present${sel}` }
        : { mode, status: "unavailable", detail: "no AWS_PROFILE / ~/.aws config" };
    }
    case "api":
      return process.env.ANTHROPIC_API_KEY
        ? { mode, status: "available", detail: "ANTHROPIC_API_KEY set" }
        : { mode, status: "unavailable", detail: "ANTHROPIC_API_KEY not set" };
    case "subscription": {
      // OAuth lives in a docker volume; we read the host-side hint cached by
      // `forge auth login` rather than spawning a docker probe.
      const hint = readOauthHint();
      if (!hint) {
        return { mode, status: "unknown", detail: "no OAuth hint cached — run `forge auth login` / `forge auth status`" };
      }
      return hint.credsPresent
        ? { mode, status: "available", detail: `OAuth volume has credentials${hint.email ? ` (${hint.email})` : ""}` }
        : { mode, status: "unavailable", detail: "OAuth volume present but no credentials — run `forge auth login`" };
    }
  }
}

// Every probeable (provider, auth) pair, in display order. Iterates the provider
// table so a new provider's rows appear automatically once it's added there.
export function doctorReport(): AuthProbe[] {
  return Object.entries(PROBEABLE_AUTH_BY_PROVIDER).flatMap(([provider, modes]) =>
    modes.map((mode) => probeAuth(provider, mode)),
  );
}

export type AvailabilityCheck = { ok: true } | { ok: false; reason: string };

// Dispatch-time fail-loud gate (ADR §6). Runs only in policy mode. CONSERVATIVE:
// blocks only on a DEFINITIVE "unavailable" probe — "unknown" always proceeds, so
// uncertainty (e.g. an uncached OAuth hint) never blocks a legitimate run.
//
// on_unavailable=fallback does NOT silently proceed: Crawl has no fallback ACTION
// (same-capability lower-cost substitution lands in Walk/Run). Proceeding would
// run the container straight into a broken auth — exactly the "silently runs on
// the wrong model" outcome the ADR forbids. So an unavailable+fallback profile
// fails loud too, with a message that names fallback as not-yet-implemented.
export function checkResolvedAvailability(res: ModelResolution): AvailabilityCheck {
  if (res.resolvedBy === "legacy" || !res.auth) return { ok: true };
  const probe = probeAuth(res.provider, res.auth);
  if (probe.status !== "unavailable") return { ok: true };
  const base =
    `profile '${res.profile}' requires provider '${res.provider}' auth '${res.auth}', ` +
    `which is unavailable in this environment: ${probe.detail}`;
  if (res.onUnavailable === "fallback") {
    return {
      ok: false,
      reason:
        `${base}. on_unavailable=fallback is not implemented until AWN-7 Walk/Run — ` +
        `failing rather than running on a different model than policy specified.`,
    };
  }
  return { ok: false, reason: base };
}
