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
import { hasAwsSsoConfigured, readOauthHint } from "../util/creds.js";
import type { EffectiveAuth, ModelResolution } from "./model-resolution.js";

export type ProbeStatus = "available" | "unavailable" | "unknown";

export type AuthProbe = {
  mode: EffectiveAuth;
  status: ProbeStatus;
  detail: string;
};

export function probeAuth(mode: EffectiveAuth): AuthProbe {
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

// All anthropic auth modes, in the order doctor displays them.
export function doctorReport(): AuthProbe[] {
  return (["subscription", "api", "bedrock"] as const).map(probeAuth);
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
  const probe = probeAuth(res.auth);
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
