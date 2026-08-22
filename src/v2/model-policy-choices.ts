// FG-346: turn provider-doctor's AuthProbe[] into the offerable profile choice set
// for `forge setup`. THREE-VALUED status is preserved:
//
//   available    → offered
//   unknown      → offered, tagged with the probe's next-action detail VERBATIM
//                  (e.g. "no ~/.codex/auth.json — run `codex login`") so the wizard
//                  can present it honestly rather than hiding a probably-fine option
//   unavailable  → hidden (the ONLY status that removes a choice)
//
// Each offered (provider, auth) expands to concrete profile choices named
// `<provider>-<auth>-<family>` via the catalog. This is a PURE function over the
// injected probes — provider-doctor is the sole availability authority; we never
// re-probe or invent providers.

import type { AuthProbe } from "./provider-doctor.js";
import type { EffectiveAuth } from "./model-resolution.js";
import { familiesFor, modelIdForFamily } from "./model-policy-catalog.js";

export type ChoiceStatus = "available" | "unknown";

export type ProfileChoice = {
  /** `<provider>-<auth>-<family>`, e.g. "anthropic-subscription-sonnet". */
  profileName: string;
  provider: string;
  auth: EffectiveAuth;
  family: string;
  /** Concrete model id from the catalog (seed-derived). */
  model: string;
  status: ChoiceStatus;
  /** For `unknown` choices: the probe's next-action detail, VERBATIM. */
  nextAction?: string;
};

/** Expand the probe report into the offerable concrete profile choices. Hides only
 *  `unavailable` probes; carries `unknown` through tagged with its next-action. */
export function offerableChoices(probes: AuthProbe[]): ProfileChoice[] {
  const out: ProfileChoice[] = [];
  for (const probe of probes) {
    if (probe.status === "unavailable") continue; // the one status that hides a choice
    const status: ChoiceStatus = probe.status === "available" ? "available" : "unknown";
    for (const family of familiesFor(probe.provider, probe.mode)) {
      const model = modelIdForFamily(probe.provider, probe.mode, family);
      if (!model) continue; // family with no seed-derived id — never emit free text
      out.push({
        profileName: `${probe.provider}-${probe.mode}-${family}`,
        provider: probe.provider,
        auth: probe.mode,
        family,
        model,
        status,
        ...(status === "unknown" ? { nextAction: probe.detail } : {}),
      });
    }
  }
  return out;
}

/** Look up a choice by its profile name. */
export function findChoice(choices: ProfileChoice[], profileName: string): ProfileChoice | undefined {
  return choices.find((c) => c.profileName === profileName);
}
