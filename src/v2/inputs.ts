// forge v2 — inputs.upstream[*] derivation.
//
// For a given step, walks its direct depends_on ancestors and collects each
// ancestor task's result.json. Returns an array of { phase, agentRole, result }
// to be folded into the next agent's inputs as `inputs.upstream`.
//
// Decision (per SCHEMA.md open question 3): "upstream" means direct
// depends_on ancestors only, one level back. NOT transitive. Mirrors today's
// "previous phase" semantics. If a workflow has architect → plan → build,
// the build step sees plan's result as upstream; it does NOT see architect's
// result directly. Plan's job is to encapsulate what's worth passing forward.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "./schema.js";
import type { Task } from "../types/index.js";
import { resolveCompletedPhasePrimary } from "./lifecycle-evaluator.js";

export type UpstreamEntry = {
  phase: string;          // the upstream step's id (== phase under v2)
  agentRole: string;      // the agent that produced this output
  taskId: string;         // for audit / cross-reference
  result: unknown;        // parsed result.json content; undefined if missing/unreadable
};

export function deriveUpstream(args: {
  step: Step;
  allTasks: Task[];
  runDir: string;     // ~/.forge/runs/<runId>
}): UpstreamEntry[] {
  const out: UpstreamEntry[] = [];
  for (const depId of args.step.depends_on) {
    // Find the "primary" (non-red, non-fanout-child) task for this dep step.
    // Reds are subordinate to their parent; we don't fold red verdicts into
    // upstream — those are accessed via the verdicts table.
    // Fanout child tasks have parent=primary; the runner pre-aggregates them
    // (today's spine pattern); for now collect the primary task's result.
    // FG-519: the latest COMPLETE parent-less primary — the canonical rule.
    // A status-blind pop() (the prior behavior) picked whatever row was newest
    // regardless of status: after a duplicate-primary heal ([complete older,
    // failed newer]) it selected the FAILED row and folded its missing result
    // (result: undefined, result.json never written) into the downstream agent's
    // inputs. Selecting the latest complete row fixes that. A phase whose only
    // primaries are non-complete now resolves to undefined and yields no upstream
    // entry — the existing `if (!primary) continue` path, unchanged.
    const primary = resolveCompletedPhasePrimary(args.allTasks, depId);

    if (!primary) continue;

    const resultPath = join(args.runDir, primary.id, "result.json");
    let result: unknown = undefined;
    if (existsSync(resultPath)) {
      try {
        const raw = readFileSync(resultPath, "utf8").trim();
        if (raw.length > 0) {
          result = JSON.parse(raw);
        }
      } catch {
        // Best-effort: malformed result.json yields undefined. Caller decides
        // whether absence of upstream blocks the dispatch.
      }
    }

    out.push({
      phase: depId,
      agentRole: primary.agentRole,
      taskId: primary.id,
      result,
    });
  }
  return out;
}
