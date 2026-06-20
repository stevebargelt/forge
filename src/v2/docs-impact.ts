// Docs-drift Run (#242) — advisory ship-time assessment.
//
// When a run is declared `shipped`, check whether it changed operator-visible
// behavior without resolving the docs impact. This is ADVISORY, not a gate: it
// warns, it never blocks the milestone. The true verdict-based hard gate (L1+L2
// mechanical clean + L3 semantic clean) waits on L2 precision (#243) and L3
// ship-time wiring — building a hard block on today's coarse signal would be the
// "docs task ran" rubber-stamp #242 explicitly warns against.
//
// SUPERSEDED-IN-PART (#257): the primary guarantee is now a docs PHASE in the
// feature pipelines — documentation-maintainer runs every pipeline run, so the
// hard-gate-on-coarse-signal plan above was not pursued. This advisory survives
// as a cheap pre-check and as the backstop for quick-invoke chains, which have
// no docs phase.
//
// Coarse signal: impact = a task touched an operator surface (inference). resolved = some task
// reported docs_updated, or recorded a deferral reason (docs_not_updated_reason).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import {
  inferOperatorBehaviorChanged,
  loadOperatorSurfaces,
  operatorSurfacesTouched,
  OPERATOR_SURFACES,
} from "./contract.js";

export interface TaskDocsSignals {
  filesModified: string[]; // result.files_modified
  docsUpdated: boolean; // result.docs_updated non-empty (documenter ran)
  deferred: boolean; // result.docs_not_updated_reason set
}

export interface RunDocsImpact {
  impacted: boolean; // some task changed operator behavior
  resolved: boolean; // docs updated, or deferred-with-reason
  surfaces: string[]; // distinct operator surfaces touched across the run
}

/** Pure assessment over per-task signals — no IO, so it unit-tests cleanly.
 *  `operatorSurfaces` defaults to forge's own set; assessRunDocsImpact passes the
 *  project-resolved list so cross-project inference fires (#246). */
export function assessDocsImpact(
  signals: readonly TaskDocsSignals[],
  operatorSurfaces: readonly string[] = OPERATOR_SURFACES
): RunDocsImpact {
  const surfaces = new Set<string>();
  let impacted = false;
  let resolved = false;
  for (const s of signals) {
    if (inferOperatorBehaviorChanged(s.filesModified, operatorSurfaces)) {
      impacted = true;
      for (const surf of operatorSurfacesTouched(s.filesModified, operatorSurfaces)) surfaces.add(surf);
    }
    if (s.docsUpdated || s.deferred) resolved = true;
  }
  return { impacted, resolved, surfaces: [...surfaces] };
}

/** The advisory warning for a ship-time docs impact, or null when there's
 *  nothing to warn about (no impact, or impact already resolved). */
export function formatDocsImpactWarning(impact: RunDocsImpact, runId: string): string | null {
  if (!impact.impacted || impact.resolved) return null;
  const surf = impact.surfaces.length ? ` (${impact.surfaces.join(", ")})` : "";
  return (
    `shipped with UNRESOLVED docs impact: operator surfaces changed${surf} but no run ` +
    `task updated docs and no deferral reason was recorded. Consider: ` +
    `forge invoke documentation-maintainer --run ${runId} — or record docs_not_updated_reason. ` +
    `(Advisory only — shipping was not blocked.)`
  );
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Gather per-task signals for a run from its manifests + results, then assess. */
export function assessRunDocsImpact(runId: string): RunDocsImpact {
  const signals: TaskDocsSignals[] = tasksForRun(runId).map((t) => {
    const dir = taskDir(runId, t.id);
    const result = readJson(join(dir, "result.json"));
    const filesModified = Array.isArray(result?.["files_modified"])
      ? (result!["files_modified"] as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    const docsUpdated =
      Array.isArray(result?.["docs_updated"]) && (result!["docs_updated"] as unknown[]).length > 0;
    const reason = result?.["docs_not_updated_reason"];
    return {
      filesModified,
      docsUpdated,
      deferred: typeof reason === "string" && reason.length > 0,
    };
  });
  // #246: resolve the run's project surfaces so inference works off-forge.
  const surfaces = loadOperatorSurfaces(getRun(runId)?.projectDir);
  return assessDocsImpact(signals, surfaces);
}
