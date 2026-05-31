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
      const on = process.env.CLAUDE_CODE_USE_BEDROCK === "1";
      const aws =
        !!process.env.AWS_PROFILE ||
        hasAwsSsoConfigured() ||
        existsSync(join(homedir(), ".aws", "config"));
      if (on && aws) return { mode, status: "available", detail: "CLAUDE_CODE_USE_BEDROCK=1, AWS config present" };
      if (on) return { mode, status: "unavailable", detail: "CLAUDE_CODE_USE_BEDROCK=1 but no AWS_PROFILE / ~/.aws/config" };
      if (aws) return { mode, status: "unknown", detail: "AWS config present but CLAUDE_CODE_USE_BEDROCK not set" };
      return { mode, status: "unavailable", detail: "CLAUDE_CODE_USE_BEDROCK not set, no AWS config" };
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
// uncertainty (e.g. an uncached OAuth hint) never blocks a legitimate run. A
// profile that opted into on_unavailable=fallback proceeds too: Crawl has no
// fallback ACTION yet (that lands in Walk/Run), so we don't fail it loud here.
export function checkResolvedAvailability(res: ModelResolution): AvailabilityCheck {
  if (res.resolvedBy === "legacy" || !res.auth) return { ok: true };
  const probe = probeAuth(res.auth);
  if (probe.status !== "unavailable") return { ok: true };
  if (res.onUnavailable === "fallback") return { ok: true };
  return {
    ok: false,
    reason:
      `profile '${res.profile}' requires provider '${res.provider}' auth '${res.auth}', ` +
      `which is unavailable in this environment: ${probe.detail}`,
  };
}
