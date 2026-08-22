// FG-349 [D]: the aggregator. buildConfigGraph is THE one function both the CLI
// (`forge config graph --json`) and the dashboard (`effectiveConfigGraph`)
// consume — byte-identity between them follows from both calling this and
// returning its output unreshaped.
//
// EFFECTIVE is computed LIVE from the filesystem + FORGE_HOME (+ in-memory RACI
// compile) — this module reads NO RECORDED dispatch task manifest. A
// missing/unreadable projectDir is a first-class missing graph, never a throw. A
// final whole-graph redaction sweep is defense-in-depth over the per-row
// redaction the section builders already do.

import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./host-readiness.js";
import { buildConfigGraphSources, resolveProjectIdentity } from "./config-graph-sources.js";
import { buildConfigGraphCapabilities } from "./config-graph-capabilities.js";
import { CONFIG_GRAPH_VERSION, type ConfigGraph } from "./config-graph-types.js";

export type ConfigGraphInput = { projectDir: string; forgeHome?: string };

function resolveForgeHome(forgeHome?: string): string {
  return forgeHome ?? process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(val);
    return out;
  }
  return v;
}

/** Defense-in-depth: blank any secret-looking string ANYWHERE in the graph,
 *  including inside verbatim `native` verdicts, before it leaves the process. */
export function redactGraph(graph: ConfigGraph): ConfigGraph {
  return redactValue(graph) as ConfigGraph;
}

function missingGraph(projectDir: string, home: string, reason: string): ConfigGraph {
  return {
    version: CONFIG_GRAPH_VERSION,
    project: { dir: projectDir, status: "missing", detail: reason, native: { error: reason } },
    forgeHome: home,
    sections: {
      sources: { rows: [] },
      capabilities: { providers: [], capabilities: [], prerequisites: [] },
    },
  };
}

/** Build the versioned, panel-partitioned Control-Plane graph for `projectDir`
 *  on this host. Never throws. */
export function buildConfigGraph({ projectDir, forgeHome }: ConfigGraphInput): ConfigGraph {
  const home = resolveForgeHome(forgeHome);
  let graph: ConfigGraph;
  try {
    graph = {
      version: CONFIG_GRAPH_VERSION,
      project: resolveProjectIdentity(projectDir),
      forgeHome: home,
      sections: {
        sources: buildConfigGraphSources({ projectDir, forgeHome: home }),
        capabilities: buildConfigGraphCapabilities({ projectDir, forgeHome: home }),
      },
    };
  } catch (e) {
    graph = missingGraph(projectDir, home, (e as Error).message);
  }
  return redactGraph(graph);
}
