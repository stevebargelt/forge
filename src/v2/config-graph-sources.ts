// FG-349 [B]: the Sources panel of the Control-Plane graph. Composes the
// EXISTING effective resolvers — it never re-derives a fact one of them already
// owns. Every row projects the resolver's native verdict into the ONE
// presentation vocabulary (config-graph-types) while carrying that verdict
// verbatim in `native`.
//
// EFFECTIVE is computed LIVE from the filesystem + FORGE_HOME (never from
// RECORDED dispatch manifests). Every resolver call that can throw is caught and
// mapped to a missing/warning row — a broken surface is a first-class row, never
// an uncaught throw. Every surfaced string is routed through redactSecrets.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadWorkflowWithSource,
  loadModelPolicyWithSource,
  WorkflowNotFoundError,
} from "./loader.js";
import { resolveDocsSurfacesReceipt } from "./contract.js";
import { governanceView } from "../raci/governance.js";
import { loadAllConstraints } from "./constraints.js";
import {
  inspectSeedInstall,
  generationCategoryDir,
  resolveSeedGeneration,
} from "./seed-generation.js";
import { detectSeedDrift } from "./seed-drift.js";
import { inspectAgentProtocols } from "./agent-protocol.js";
import { COVERED_ROLES } from "./review-contract.js";
import { identify } from "../util/path-identity.js";
import { redactSecrets } from "./host-readiness.js";
import { project, type ConfigRow, type ProjectIdentity, type SourcesSection } from "./config-graph-types.js";

const clean = (s: string): string => redactSecrets(s);

export type SourcesInput = { projectDir: string; forgeHome: string };

/** Project identity + reachability, projected from path-identity (never throws). */
export function resolveProjectIdentity(projectDir: string): ProjectIdentity {
  const id = identify(projectDir);
  if (id.kind === "resolved") {
    return { dir: clean(projectDir), status: "active", detail: clean(`resolved to ${id.physical}`), native: id };
  }
  return {
    dir: clean(projectDir),
    status: "missing",
    detail: clean(`unresolved: ${id.reason}`),
    native: id,
  };
}

// ── individual surface rows ────────────────────────────────────────────────
// Each returns exactly one ConfigRow and never throws.

function projectDirRow(projectDir: string): ConfigRow {
  const id = identify(projectDir);
  return project(id, {
    key: "project-dir",
    label: "Project directory / workspace identity",
    truth: "EFFECTIVE" as const,
    status: id.kind === "resolved" ? ("active" as const) : ("missing" as const),
    sourcePaths: [clean(projectDir)],
    effectivePath: id.kind === "resolved" ? clean(id.physical) : undefined,
    overrideSemantics: "none" as const,
    detail:
      id.kind === "resolved"
        ? clean(`physical: ${id.physical}`)
        : clean(`unresolved: ${id.reason}`),
  });
}

function forgeHomeRow(forgeHome: string): ConfigRow {
  const present = existsSync(forgeHome);
  return project({ forgeHome, present }, {
    key: "forge-home",
    label: "Forge home",
    truth: "EFFECTIVE" as const,
    status: present ? ("active" as const) : ("missing" as const),
    sourcePaths: [clean(forgeHome)],
    effectivePath: clean(forgeHome),
    overrideSemantics: "none" as const,
    detail: present ? undefined : clean("FORGE_HOME does not exist on disk"),
  });
}

function workflowRow(projectDir: string): ConfigRow {
  // Canonical workflow — its source tells us project-override vs host-default and
  // carries the full-replacement provenance. A missing host generation / missing
  // workflow becomes a warning row, never a throw.
  try {
    const wf = loadWorkflowWithSource("feature", { projectDir });
    if (wf.source === "project") {
      return project(wf, {
        key: "workflow",
        label: "Workflow (feature)",
        truth: "EFFECTIVE" as const,
        status: "overridden" as const,
        sourcePaths: [clean(wf.path)],
        effectivePath: clean(wf.path),
        overrideSemantics: "full-replacement" as const,
        overrideCallout: clean(`project ${wf.path} active — fully replaces the host workflow`),
      });
    }
    return project(wf, {
      key: "workflow",
      label: "Workflow (feature)",
      truth: "EFFECTIVE" as const,
      status: "active" as const,
      sourcePaths: [clean(wf.path)],
      effectivePath: clean(wf.path),
      overrideSemantics: "full-replacement" as const,
      detail: clean("host default (no project override)"),
    });
  } catch (e) {
    const missing = e instanceof WorkflowNotFoundError;
    return project({ error: (e as Error).message }, {
      key: "workflow",
      label: "Workflow (feature)",
      truth: "EFFECTIVE" as const,
      status: (missing ? "missing" : "warning") as ConfigRow["status"],
      sourcePaths: [],
      overrideSemantics: "full-replacement" as const,
      warning: clean((e as Error).message),
    });
  }
}

function runtimeRow(projectDir: string, forgeHome: string): ConfigRow {
  // Runtimes are per-name; the EFFECTIVE question the panel answers is "does this
  // project override the runtime definitions at all". Composes seed-generation
  // for the host install-source and reads the project override dir directly.
  try {
    const projRuntimeDir = join(projectDir, ".forge", "runtimes");
    const overrides = existsSync(projRuntimeDir)
      ? readdirSync(projRuntimeDir).filter((f) => f.endsWith(".yml"))
      : [];
    const gen = resolveSeedGeneration(forgeHome);
    const hostDir = gen ? generationCategoryDir(gen, "runtimes") : null;
    const native = { projectOverrides: overrides, hostGenerationDir: hostDir };
    if (overrides.length > 0) {
      return project(native, {
        key: "runtime",
        label: "Runtime definitions",
        truth: "EFFECTIVE" as const,
        status: "overridden" as const,
        sourcePaths: overrides.map((f) => clean(join(projRuntimeDir, f))),
        effectivePath: clean(projRuntimeDir),
        overrideSemantics: "full-replacement" as const,
        overrideCallout: clean(
          `project .forge/runtimes/ active (${overrides.length} file(s)) — each fully replaces the host runtime of the same name`,
        ),
      });
    }
    if (hostDir) {
      return project(native, {
        key: "runtime",
        label: "Runtime definitions",
        truth: "EFFECTIVE" as const,
        status: "active" as const,
        sourcePaths: [clean(hostDir)],
        effectivePath: clean(hostDir),
        overrideSemantics: "full-replacement" as const,
        detail: clean("host default (no project override)"),
      });
    }
    return project(native, {
      key: "runtime",
      label: "Runtime definitions",
      truth: "EFFECTIVE" as const,
      status: "missing" as const,
      sourcePaths: [],
      overrideSemantics: "full-replacement" as const,
      warning: clean("no published host seed generation — run: forge upgrade"),
    });
  } catch (e) {
    return project({ error: (e as Error).message }, {
      key: "runtime",
      label: "Runtime definitions",
      truth: "EFFECTIVE" as const,
      status: "warning" as const,
      sourcePaths: [],
      overrideSemantics: "full-replacement" as const,
      warning: clean((e as Error).message),
    });
  }
}

function modelPolicyRow(projectDir: string, forgeHome: string): ConfigRow {
  try {
    const mp = loadModelPolicyWithSource({ projectDir });
    if (mp.source === "absent") {
      return project(mp, {
        key: "model-policy",
        label: "Model policy",
        truth: "EFFECTIVE" as const,
        status: "absent" as const,
        sourcePaths: [],
        overrideSemantics: "full-replacement" as const,
        detail: clean("no model-policy.yml — legacy mode (runtime.models resolves models)"),
      });
    }
    if (mp.source === "project") {
      const hostPath = join(forgeHome, "model-policy.yml");
      return project(mp, {
        key: "model-policy",
        label: "Model policy",
        truth: "EFFECTIVE" as const,
        status: "overridden" as const,
        sourcePaths: [clean(mp.path)],
        effectivePath: clean(mp.path),
        overrideSemantics: "full-replacement" as const,
        overrideCallout: clean(`project ${mp.path} active — fully replaces host ${hostPath}`),
      });
    }
    return project(mp, {
      key: "model-policy",
      label: "Model policy",
      truth: "EFFECTIVE" as const,
      status: "active" as const,
      sourcePaths: [clean(mp.path)],
      effectivePath: clean(mp.path),
      overrideSemantics: "full-replacement" as const,
      detail: clean("host default (no project override)"),
    });
  } catch (e) {
    return project({ error: (e as Error).message }, {
      key: "model-policy",
      label: "Model policy",
      truth: "EFFECTIVE" as const,
      status: "warning" as const,
      sourcePaths: [],
      overrideSemantics: "full-replacement" as const,
      warning: clean((e as Error).message),
    });
  }
}

function docsSurfacesRow(projectDir: string, forgeHome: string): ConfigRow {
  const { receipt, warning } = resolveDocsSurfacesReceipt(projectDir);
  const native = { receipt, warning };
  if (receipt.source === "project" && receipt.path) {
    return project(native, {
      key: "docs-surfaces",
      label: "Docs surfaces",
      truth: "EFFECTIVE" as const,
      status: "overridden" as const,
      sourcePaths: [clean(receipt.path)],
      effectivePath: clean(receipt.path),
      overrideSemantics: "full-replacement" as const,
      overrideCallout: clean(`project ${receipt.path} active — fully replaces built-in defaults`),
    });
  }
  // built-in defaults — but distinguish an INVALID override (warning) from a
  // simple absence. An invalid override must be visible, not silently defaulted.
  if (warning) {
    return project(native, {
      key: "docs-surfaces",
      label: "Docs surfaces",
      truth: "EFFECTIVE" as const,
      status: "warning" as const,
      sourcePaths: [clean(join(projectDir, ".forge", "docs-surfaces.yml"))],
      effectivePath: clean(join(forgeHome, "built-in docs-surfaces defaults")),
      overrideSemantics: "full-replacement" as const,
      warning: clean("project override present but invalid; effective source: built-in defaults"),
      detail: clean(warning),
    });
  }
  return project(native, {
    key: "docs-surfaces",
    label: "Docs surfaces",
    truth: "EFFECTIVE" as const,
    status: "active" as const,
    sourcePaths: [],
    overrideSemantics: "full-replacement" as const,
    detail: clean("built-in defaults active (no project override)"),
  });
}

function routingRow(projectDir: string): ConfigRow {
  const view = governanceView({ projectDir });
  if (!view.ok) {
    const codes = view.findings.map((f) => f.code);
    const stale = codes.includes("override_not_compiled");
    return project(view, {
      key: "routing-policy",
      label: "Routing policy / RACI",
      truth: "DERIVED" as const,
      status: (stale ? "stale" : "warning") as ConfigRow["status"],
      sourcePaths: [clean(view.path)],
      overrideSemantics: "full-replacement" as const,
      warning: clean(view.findings.map((f) => `[${f.code}] ${f.message}`).join("; ")),
    });
  }
  const drifted = (view.drift?.length ?? 0) > 0;
  const overridden = view.source === "project";
  return project(view, {
    key: "routing-policy",
    label: "Routing policy / RACI",
    truth: "DERIVED" as const,
    status: (drifted ? "stale" : overridden ? "overridden" : "derived") as ConfigRow["status"],
    sourcePaths: [clean(view.path)],
    effectivePath: clean(view.path),
    overrideSemantics: "full-replacement" as const,
    overrideCallout: overridden
      ? clean(`project ${view.path} active — fully replaces the host routing policy`)
      : undefined,
    warning: drifted
      ? clean(`stale — compiled policy drifts from its RACI source: ${view.drift!.map((f) => f.code).join(", ")}`)
      : undefined,
    detail: clean(`compiled routing policy (source: ${view.source})`),
  });
}

function constraintsRow(forgeHome: string): ConfigRow {
  const dir = join(forgeHome, "constraints");
  const all = loadAllConstraints(dir);
  const force = all.filter((c) => c.level === "force").length;
  const suggest = all.filter((c) => c.level === "suggest").length;
  return project({ dir, count: all.length, force, suggest }, {
    key: "constraints",
    label: "Constraints",
    truth: "SOURCE" as const,
    status: (all.length > 0 ? "active" : "absent") as ConfigRow["status"],
    sourcePaths: [clean(dir)],
    effectivePath: clean(dir),
    overrideSemantics: "merge" as const,
    detail: clean(`${all.length} constraint(s): ${force} force, ${suggest} suggest (merge semantics — all apply)`),
  });
}

function agentsRow(forgeHome: string): ConfigRow {
  const protocols = inspectAgentProtocols({ forgeHome });
  const installed = protocols.filter((p) => p.ok).map((p) => p.role);
  const missing = protocols.filter((p) => !p.ok).map((p) => p.role);
  const expected = [...COVERED_ROLES];
  return project({ protocols, expected, installed, missing }, {
    key: "agents",
    label: "Installed agents (protocols)",
    truth: "DERIVED" as const,
    status: (missing.length === 0 && installed.length > 0
      ? "active"
      : installed.length === 0
        ? "missing"
        : "warning") as ConfigRow["status"],
    sourcePaths: [clean(join(forgeHome, "agents"))],
    overrideSemantics: "none" as const,
    detail: clean(
      `${installed.length}/${expected.length} expected agents installed${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    ),
    warning: missing.length ? clean(`missing expected agents: ${missing.join(", ")}`) : undefined,
  });
}

function workflowsRow(forgeHome: string): ConfigRow {
  const gen = resolveSeedGeneration(forgeHome);
  if (!gen) {
    return project({ generation: null }, {
      key: "workflows",
      label: "Installed workflows",
      truth: "DERIVED" as const,
      status: "missing" as const,
      sourcePaths: [],
      overrideSemantics: "none" as const,
      warning: clean("no published host seed generation — run: forge upgrade"),
    });
  }
  const dir = generationCategoryDir(gen, "workflows");
  const installed = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".yml")).map((f) => f.replace(/\.yml$/, ""))
    : [];
  return project({ dir, installed }, {
    key: "workflows",
    label: "Installed workflows",
    truth: "DERIVED" as const,
    status: (installed.length > 0 ? "derived" : "missing") as ConfigRow["status"],
    sourcePaths: [clean(dir)],
    effectivePath: clean(dir),
    overrideSemantics: "none" as const,
    detail: clean(`${installed.length} workflow(s) installed: ${installed.join(", ") || "(none)"}`),
  });
}

function seedDriftRow(forgeHome: string): ConfigRow {
  try {
    const report = detectSeedDrift(undefined, forgeHome);
    const staleCount = report.stale.length;
    return project(report, {
      key: "seed-drift",
      label: "Seed drift (templates / install sources)",
      truth: "SOURCE" as const,
      // Seeds are TEMPLATES, never active runtime config — the install-source axis.
      status: (staleCount > 0 ? "stale" : "template-only") as ConfigRow["status"],
      sourcePaths: [clean(join(forgeHome, "seeds"))],
      overrideSemantics: "none" as const,
      detail: clean(
        `seeds are install-source templates, never active config. ${report.entries.length} tracked, ${staleCount} stale.`,
      ),
      warning: staleCount > 0 ? clean(`${staleCount} seed(s) drifted from the release template`) : undefined,
    });
  } catch (e) {
    return project({ error: (e as Error).message }, {
      key: "seed-drift",
      label: "Seed drift (templates / install sources)",
      truth: "SOURCE" as const,
      status: "warning" as const,
      sourcePaths: [],
      overrideSemantics: "none" as const,
      warning: clean((e as Error).message),
    });
  }
}

function seedInstallRow(forgeHome: string): ConfigRow {
  const state = inspectSeedInstall(forgeHome);
  const status =
    state.kind === "healthy" ? "active" : state.kind === "no-generation" ? "missing" : "warning";
  return project(state, {
    key: "seed-install",
    label: "Seed generation (install source)",
    truth: "SOURCE" as const,
    status: status as ConfigRow["status"],
    sourcePaths: [clean(join(forgeHome, "generations"))],
    overrideSemantics: "none" as const,
    detail: clean(
      state.kind === "healthy"
        ? `published generation ${state.generation} (install source for host workflows/runtimes/agents)`
        : state.kind === "incomplete"
          ? `incomplete generation: ${state.reason}`
          : "no published generation — run: forge upgrade",
    ),
    warning: state.kind === "incomplete" ? clean(state.reason) : undefined,
  });
}

/** Build the Sources section: the EFFECTIVE config for `projectDir` on this
 *  host, one provenance row per surface. Never throws. */
export function buildConfigGraphSources({ projectDir, forgeHome }: SourcesInput): SourcesSection {
  const rows: ConfigRow[] = [
    projectDirRow(projectDir),
    forgeHomeRow(forgeHome),
    workflowRow(projectDir),
    runtimeRow(projectDir, forgeHome),
    modelPolicyRow(projectDir, forgeHome),
    routingRow(projectDir),
    docsSurfacesRow(projectDir, forgeHome),
    constraintsRow(forgeHome),
    agentsRow(forgeHome),
    workflowsRow(forgeHome),
    seedInstallRow(forgeHome),
    seedDriftRow(forgeHome),
  ];
  return { rows };
}
