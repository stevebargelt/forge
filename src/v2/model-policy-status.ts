// FG-560 (step 11): READ-ONLY model-policy migration status for `forge doctor`
// and `forge setup`.
//
// This surface COMPOSES the two FG-560 modules and adds NOTHING to their logic:
//   - discovery (model-policy-discovery.ts) enumerates the host policy plus every
//     project Forge has a durable evidence row for, classified into four states.
//   - the classifier (model-policy-migration.ts) reads ONE policy file's bytes and
//     returns the per-file migration verdict.
// For every discovered policy that HAS a file, we read it and run the classifier;
// the verdict + the discovery state become one reportable row. Doctor/setup NEVER
// migrate — `forge upgrade` is the sole authority. This module reads bytes and
// classifies; it writes nothing.
//
// Honesty carried through from discovery: the enumeration is HISTORICAL and
// BEST-EFFORT (a project Forge never ran against is invisible), and this module
// re-exports that marker rather than implying fleet completeness.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  discoverModelPolicies,
  classifyHost,
  type DiscoverOptions,
  type DiscoveredPolicy,
  type PolicyDiscovery,
} from "./model-policy-discovery.js";
import {
  classifyModelPolicyContent,
  type MigrationVerdict,
} from "./model-policy-migration.js";

/** The action an operator should take for one policy, derived from its verdict.
 *  `forge upgrade` is the only migration path; `upgrade-forge` means this binary
 *  is too old to touch a newer file. */
export type PolicyAction = "none" | "forge-upgrade" | "upgrade-forge" | "resolve-then-upgrade";

export type ModelPolicyStatusRow = {
  scope: "host" | "project";
  /** The discovery state (has-policy / reachable-no-policy / unreachable-deleted /
   *  known-but-no-path) — carried verbatim so nothing is lost. */
  state: DiscoveredPolicy["state"];
  projectDir: string | null;
  policyPath: string | null;
  /** The classifier verdict, or null when there was no file to classify
   *  (reachable-no-policy / unreachable-deleted / known-but-no-path) or the file
   *  could not be read/parsed (`error` names why). */
  verdict: MigrationVerdict | null;
  /** schema_version found in the file (null = a v1/legacy file with no version). */
  schemaVersionFound: number | null;
  action: PolicyAction;
  /** A one-line, human-readable state description. */
  detail: string;
  /** Present only when the file existed but could not be read or parsed. */
  error?: string;
};

export type ModelPolicyStatus = {
  host: ModelPolicyStatusRow;
  projects: ModelPolicyStatusRow[];
  /** Carried through from discovery — NEVER a claim of fleet completeness. */
  completeness: PolicyDiscovery["completeness"];
  registeredInspected: number;
  registeredUnreachable: number;
  registeredNoPath: number;
  /** True when the HOST policy needs `forge upgrade` (v1 or has pending additions)
   *  or a human decision — the doctor readiness/prompt keys off this. */
  hostNeedsUpgrade: boolean;
  /** True when ANY discovered policy is newer-unsupported (this Forge is too old). */
  anyNewerUnsupported: boolean;
};

type FileReader = (path: string) => string;

function actionFor(verdict: MigrationVerdict): PolicyAction {
  switch (verdict) {
    case "current":
      return "none";
    case "migratable":
    case "changed-if-applied":
      return "forge-upgrade";
    case "needs-human-decision":
      return "resolve-then-upgrade";
    case "newer-unsupported":
      return "upgrade-forge";
  }
}

function detailFor(verdict: MigrationVerdict, schemaVersionFound: number | null): string {
  switch (verdict) {
    case "current":
      return "current (schema_version 2) — no migration needed";
    case "migratable":
      return schemaVersionFound === null
        ? "legacy v1 (no schema_version) — needs `forge upgrade` to migrate to schema_version 2"
        : `schema_version ${schemaVersionFound} — needs \`forge upgrade\` to migrate to schema_version 2`;
    case "changed-if-applied":
      return "schema_version 2, but new capability aliases are available — `forge upgrade` adds them";
    case "needs-human-decision":
      return "needs a human decision — an alias source is absent; resolve it, then `forge upgrade` (the file is left unchanged)";
    case "newer-unsupported":
      return `schema_version ${schemaVersionFound} is NEWER than this Forge supports — upgrade Forge`;
  }
}

/** Classify one discovered policy into a status row. Reads the file ONLY when the
 *  discovery state says one is present; never writes. A read/parse failure is
 *  reported as an `error` row rather than thrown — a single unreadable project
 *  policy must not blank the whole status. */
function statusRowFor(p: DiscoveredPolicy, readFile: FileReader): ModelPolicyStatusRow {
  const base = { scope: p.scope, state: p.state, projectDir: p.projectDir, policyPath: p.policyPath };
  if (p.state === "reachable-no-policy") {
    return { ...base, verdict: null, schemaVersionFound: null, action: "none", detail: "no policy file — legacy mode (runtime.models)" };
  }
  if (p.state === "unreachable-deleted") {
    return { ...base, verdict: null, schemaVersionFound: null, action: "none", detail: "checkout no longer resolves — cannot inspect (evidence is historical)" };
  }
  if (p.state === "known-but-no-path") {
    return { ...base, verdict: null, schemaVersionFound: null, action: "none", detail: "registered project with no recorded path — nowhere to look for a policy" };
  }
  // has-policy: read + classify.
  if (!p.policyPath) {
    return { ...base, verdict: null, schemaVersionFound: null, action: "none", detail: "policy reported present but no path resolved", error: "no policy path" };
  }
  let raw: string;
  try {
    raw = readFile(p.policyPath);
  } catch (e) {
    return { ...base, verdict: null, schemaVersionFound: null, action: "none", detail: "policy file present but unreadable", error: (e as Error).message };
  }
  try {
    const m = classifyModelPolicyContent(raw);
    return {
      ...base,
      verdict: m.verdict,
      schemaVersionFound: m.schemaVersionFound,
      action: actionFor(m.verdict),
      detail: detailFor(m.verdict, m.schemaVersionFound),
    };
  } catch (e) {
    return { ...base, verdict: null, schemaVersionFound: null, action: "none", detail: "policy file could not be classified", error: (e as Error).message };
  }
}

/** Compute the read-only model-policy migration status. Composes discovery with
 *  the per-file classifier; writes NOTHING. `discover`/`readFile` are injectable
 *  for tests; production uses the real discovery + fs read. */
export function buildModelPolicyStatus(
  opts: DiscoverOptions = {},
  deps: { discover?: (o: DiscoverOptions) => PolicyDiscovery; readFile?: FileReader } = {},
): ModelPolicyStatus {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const forgeHome = opts.forgeHome ?? process.env.FORGE_HOME ?? join(homedir(), ".forge");
  // Discovery reads the store; if it is unavailable, still classify the HOST policy
  // alone (a pure filesystem read) so the section never blanks — the host state is
  // exactly the one an operator most needs from doctor/setup.
  const hostOnly = (): PolicyDiscovery => ({
    host: classifyHost(forgeHome),
    projects: [],
    completeness: "historical-best-effort",
    registeredInspected: 0,
    registeredUnreachable: 0,
    registeredNoPath: 0,
  });
  let d: PolicyDiscovery;
  if (deps.discover) {
    d = deps.discover(opts);
  } else {
    try {
      d = discoverModelPolicies(opts);
    } catch {
      d = hostOnly();
    }
  }

  const host = statusRowFor(d.host, readFile);
  const projects = d.projects.map((p) => statusRowFor(p, readFile));

  const hostNeedsUpgrade = host.action === "forge-upgrade" || host.action === "resolve-then-upgrade";
  const anyNewerUnsupported = [host, ...projects].some((r) => r.verdict === "newer-unsupported");

  return {
    host,
    projects,
    completeness: d.completeness,
    registeredInspected: d.registeredInspected,
    registeredUnreachable: d.registeredUnreachable,
    registeredNoPath: d.registeredNoPath,
    hostNeedsUpgrade,
    anyNewerUnsupported,
  };
}

/** Render the model-policy status as a human doctor section. Read-only wording:
 *  a v1/needs-human host is directed at `forge upgrade`; a newer-unsupported policy
 *  is flagged 'upgrade Forge'. Never claims to have changed anything. */
export function renderModelPolicyStatus(s: ModelPolicyStatus): string {
  const lines: string[] = ["Model-policy status (read-only — `forge upgrade` is the sole migration authority):"];
  const rowLine = (label: string, r: ModelPolicyStatusRow): string => {
    const where = r.policyPath ?? r.projectDir ?? "(no path)";
    return `  ${label}: ${r.detail}\n    ${where}`;
  };
  lines.push(rowLine("host", s.host));
  if (s.host.action === "forge-upgrade") {
    lines.push("    → run `forge upgrade` to migrate the host policy.");
  } else if (s.host.action === "resolve-then-upgrade") {
    lines.push("    → resolve the flagged alias, then run `forge upgrade`.");
  } else if (s.host.action === "upgrade-forge") {
    lines.push("    → upgrade Forge: this binary is too old to read this policy.");
  }

  if (s.projects.length === 0) {
    lines.push("  projects: none discovered (historical, best-effort — a project Forge never ran against is invisible).");
  } else {
    lines.push(`  projects (${s.projects.length}, historical/best-effort — not a fleet inventory):`);
    for (const r of s.projects) {
      lines.push(rowLine("  ·", r));
      if (r.action === "forge-upgrade") lines.push("      → `forge upgrade` (run against that checkout).");
      else if (r.action === "resolve-then-upgrade") lines.push("      → resolve the flagged alias, then `forge upgrade`.");
      else if (r.action === "upgrade-forge") lines.push("      → upgrade Forge to read this newer policy.");
    }
  }
  return lines.join("\n");
}
