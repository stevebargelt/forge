// forge v2 — system prompt + task package composition.
//
// Adapted from src/spine/composeSystemPrompt.ts. Same three-tier shape:
//   1. Agent base CLAUDE.md from ~/.forge/agents/<role>/CLAUDE.md
//   2. step.workflow_additions (if present)
//   3. suggest-level constraints filtered by role + workflow + step
//      (force-level constraints feed reds via anti-prompts; out of scope here)
// Output schema framing appended at end.
//
// The v2 difference is the *inputs*: this function takes the parsed YAML
// Step instead of the TS Phase. Everything else (constraints filtering,
// agent dir resolution) reuses the existing src/spine/constraints.ts.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterConstraints, loadAllConstraints } from "./constraints.js";
import type { Workflow, Step } from "./schema.js";

const FRAMING = `## Output contract

Write a single JSON object to /task/result.json with at minimum the fields {"status": "complete"|"failed", ...role-specific output}. For red agents, the role-specific output must match the Verdict schema (verdict, confidence, findings).

Optionally, for long-running work, you MAY append progress records to /task/progress.jsonl — one JSON object per line — and forge will surface them on the run timeline. Shapes: {"type":"progress","message":"...","percent":0-100}, {"type":"artifact","kind":"screenshot","path":"/task/..."}, {"type":"decision","summary":"..."}. This is purely optional; never put secrets in it, and result.json is still the required deliverable.`;

export type ComposeArgs = {
  role: string;
  workflow: Workflow;
  step: Step;
  // Override defaults for tests.
  agentDir?: string;
  constraintsDir?: string;
};

function defaultAgentDir(role: string): string {
  const root = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  return join(root, "agents", role);
}

function defaultConstraintsDir(): string {
  const root = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  return join(root, "constraints");
}

export function composeSystemPrompt(args: ComposeArgs): string {
  const sections: string[] = [];

  const agentDir = args.agentDir ?? defaultAgentDir(args.role);
  const baseFile = join(agentDir, "CLAUDE.md");
  if (existsSync(baseFile)) {
    sections.push(readFileSync(baseFile, "utf8").trim());
  } else {
    sections.push(`# ${args.role}\n\n(Agent base CLAUDE.md not found at ${baseFile})`);
  }

  const wa = args.step.workflow_additions?.trim();
  if (wa && wa.length > 0) {
    sections.push(`# Workflow additions (step: ${args.step.id})\n\n${wa}`);
  }

  const all = loadAllConstraints(args.constraintsDir ?? defaultConstraintsDir());
  const suggest = filterConstraints(all, {
    role: args.role,
    workflow: args.workflow.name,
    phase: args.step.id,  // v1's "phase" maps 1:1 to v2's "step.id"
    level: "suggest",
  });
  if (suggest.length > 0) {
    const body = suggest.map((c) => `## Constraint: ${c.id}\n\n${c.body}`).join("\n\n");
    sections.push(`# Constraints\n\n${body}`);
  }

  sections.push(FRAMING);

  return sections.join("\n\n---\n\n") + "\n";
}
