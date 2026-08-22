// FG-349 [C] (FG-401 absorbed): the Provider/Runtime Capability panel of the
// Control-Plane graph. Composes the EXISTING capability + auth resolvers and
// projects each native verdict into the shared vocabulary (config-graph-types),
// carrying the verdict verbatim.
//
// CRITICAL SEAM: a fact witnessed in THIS host process (auth env presence, an
// installed agent protocol) is `host-observed`. A fact about the would-be run
// CONTAINER (adapter capability behavior, campaign-runner runtime readiness) is
// `inferred` — never asserted as witnessed availability. Cheap reads only: no
// docker/git/model subprocess, no billed probe. Anything that would need one is
// marked deferred/unknown with a reason. Every string is redacted.

import {
  ORCHESTRATOR_CAPABILITIES,
  type CapabilitySupport,
} from "./orchestrator-capabilities.js";
import { probeAuth } from "./provider-doctor.js";
import { detectAuthMode } from "./model-resolution.js";
import { knownApiKeyProviders } from "../util/creds.js";
import { inspectAgentProtocols } from "./agent-protocol.js";
import { redactSecrets } from "./host-readiness.js";
import {
  project,
  type CapabilitiesSection,
  type CapabilityProvenance,
  type CapabilityRow,
  type PrerequisiteRow,
  type ProviderRow,
  type Readiness,
} from "./config-graph-types.js";

const clean = (s: string): string => redactSecrets(s);

export type CapabilitiesInput = { projectDir: string; forgeHome: string };

function providerRows(): ProviderRow[] {
  const hostMode = detectAuthMode();
  // Deterministic, cheap: probe every provider forge has an API-key binding for,
  // by env-var PRESENCE (never value). Host-observed.
  const rows: ProviderRow[] = knownApiKeyProviders().map((provider) => {
    const probe = probeAuth(provider, "api");
    const readiness: Readiness =
      probe.status === "available" ? "available" : probe.status === "unavailable" ? "unavailable" : "unknown";
    const provenance: CapabilityProvenance =
      probe.status === "available" ? "detected" : probe.status === "unavailable" ? "unavailable" : "unknown";
    return project(probe, {
      provider: clean(provider),
      mode: clean(probe.mode),
      readiness,
      provenance,
      detail: clean(probe.detail),
      observedBy: "host-observed" as const,
    });
  });
  // The host's own effective auth mode — host-observed, presence only.
  rows.push(
    project({ hostMode }, {
      provider: "(host effective auth)",
      mode: clean(hostMode),
      readiness: "available" as const,
      provenance: "detected" as const,
      detail: clean(`host process resolved auth mode: ${hostMode}`),
      observedBy: "host-observed" as const,
    }),
  );
  return rows;
}

function capabilityProvenance(support: CapabilitySupport): CapabilityProvenance {
  switch (support) {
    case "unsupported":
      return "unavailable";
    case "supported":
      return "configured";
    default:
      // partial | evidence-gated — known but not a witnessed guarantee here
      return "inferred";
  }
}

function capabilityRows(): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const cap of ORCHESTRATOR_CAPABILITIES) {
    for (const [adapter, cell] of Object.entries(cap.adapters)) {
      rows.push(
        project(cell, {
          capability: clean(cap.capability),
          adapter: clean(adapter),
          title: clean(cap.title),
          support: clean(cell.support),
          provenance: capabilityProvenance(cell.support),
          limitation: cell.limitation ? clean(cell.limitation) : undefined,
          // Adapter capability behavior describes the would-be run container.
          observedBy: "inferred" as const,
        }),
      );
    }
  }
  return rows;
}

function prerequisiteRows(forgeHome: string): PrerequisiteRow[] {
  const rows: PrerequisiteRow[] = [];

  // Shipping Reviewer — host-observed via the installed agent protocol set.
  try {
    const protocols = inspectAgentProtocols({ forgeHome });
    const sr = protocols.find((p) => p.role === "shipping-reviewer");
    if (sr && sr.ok) {
      rows.push(
        project(sr, {
          name: "Shipping Reviewer",
          readiness: "available" as const,
          reason: clean(`shipping-reviewer agent protocol installed — ${sr.detail}`),
          observedBy: "host-observed" as const,
        }),
      );
    } else {
      rows.push(
        project(sr ?? { role: "shipping-reviewer", ok: false, detail: "no protocol row" }, {
          name: "Shipping Reviewer",
          readiness: "unavailable" as const,
          reason: clean(
            sr ? `shipping-reviewer protocol not ready: ${sr.detail}` : "shipping-reviewer agent protocol not installed — run: forge upgrade",
          ),
          observedBy: "host-observed" as const,
        }),
      );
    }
  } catch (e) {
    rows.push(
      project({ error: (e as Error).message }, {
        name: "Shipping Reviewer",
        readiness: "unknown" as const,
        reason: clean(`could not inspect agent protocols: ${(e as Error).message}`),
        observedBy: "host-observed" as const,
      }),
    );
  }

  // Campaign Runner — its readiness depends on a would-be container runtime we do
  // NOT probe on this read path (no docker subprocess, no billed call). Deferred,
  // inferred — never asserted as witnessed availability.
  rows.push(
    project({ requiresContainerRuntimeProbe: true }, {
      name: "Campaign Runner",
      readiness: "deferred" as const,
      reason: clean(
        "requires a container-runtime readiness probe not performed on the read path — inferred, not witnessed. Run a campaign or `forge doctor` for a live check.",
      ),
      observedBy: "inferred" as const,
    }),
  );

  return rows;
}

/** Build the Capabilities section (FG-401): providers/runtimes + auth
 *  availability, the adapter capability matrix, and Shipping Reviewer / Campaign
 *  Runner prerequisites. Never throws; cheap reads only. */
export function buildConfigGraphCapabilities({ forgeHome }: CapabilitiesInput): CapabilitiesSection {
  return {
    providers: providerRows(),
    capabilities: capabilityRows(),
    prerequisites: prerequisiteRows(forgeHome),
  };
}
