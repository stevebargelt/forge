import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Phase, Run, Workflow } from "../types/index.js";
import { filterConstraints, loadAllConstraints } from "./constraints.js";

// Three-tier composition:
//   1. Agent base CLAUDE.md from <agentDir>/CLAUDE.md
//   2. phase.workflowAdditions (if present)
//   3. suggest-level constraints filtered by role + workflow + phase
//      (force-level constraints feed reds via anti-prompts; not included here)
// Final framing (the output schema) is appended by the caller via taskPackageFraming.
export function composeSystemPrompt(args: {
  role: string;
  agentDir: string;
  run: Run;
  workflow: Workflow;
  phase: Phase;
  taskPackageFraming?: string;
  constraintsDir?: string;     // overridable for tests; defaults to ~/.forge/constraints
}): string {
  const sections: string[] = [];

  const baseFile = join(args.agentDir, "CLAUDE.md");
  if (existsSync(baseFile)) {
    sections.push(readFileSync(baseFile, "utf8").trim());
  } else {
    sections.push(`# ${args.role}\n\n(Agent base CLAUDE.md not found at ${baseFile})`);
  }

  if (args.phase.workflowAdditions && args.phase.workflowAdditions.trim().length > 0) {
    sections.push(`# Workflow additions (phase: ${args.phase.name})\n\n${args.phase.workflowAdditions.trim()}`);
  }

  const all = loadAllConstraints(args.constraintsDir);
  const suggest = filterConstraints(all, {
    role: args.role,
    workflow: args.workflow.name,
    phase: args.phase.name,
    level: "suggest",
  });
  if (suggest.length > 0) {
    const body = suggest.map((c) => `## Constraint: ${c.id}\n\n${c.body}`).join("\n\n");
    sections.push(`# Constraints\n\n${body}`);
  }

  if (args.taskPackageFraming && args.taskPackageFraming.trim().length > 0) {
    sections.push(args.taskPackageFraming.trim());
  }

  return sections.join("\n\n---\n\n") + "\n";
}
