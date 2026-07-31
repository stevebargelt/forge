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
import { assertAgentProtocolCurrent, type AgentProtocolStamp, type ProtocolPaths } from "./agent-protocol.js";
import type { Workflow, Step } from "./schema.js";

const FRAMING = `## Output contract

Write a single JSON object to /task/result.json with at minimum the fields {"status": "complete"|"failed", ...role-specific output}. For red agents, the role-specific output must match the Verdict schema (verdict, confidence, findings).

Optionally, for long-running work, you MAY append progress records to /task/progress.jsonl — one JSON object per line — and forge will surface them on the run timeline. Shapes: {"type":"progress","message":"...","percent":0-100}, {"type":"artifact","kind":"screenshot","path":"/task/..."}, {"type":"decision","summary":"..."}. This is purely optional; never put secrets in it, and result.json is still the required deliverable.`;

export type ComposeArgs = {
  role: string;
  workflow: Workflow;
  step: Step;
  runTags?: string[];
  // Override defaults for tests.
  agentDir?: string;
  constraintsDir?: string;
  /** FG-654: override the two roots the protocol check reads (installed seed under
   *  $FORGE_HOME, required seed in the executing release). Tests only. */
  protocolPaths?: ProtocolPaths;
};

/** FG-654: composing is no longer unconditionally possible. THIS is the one seam every
 *  dispatch entry funnels through — invoke (the whole coordinator family plus the legacy
 *  review-loop's red-wide), runNext's primary / workflow-red / fanout-child sites, and
 *  retry — so the refusal lives here rather than being re-implemented, and forgotten,
 *  at five dispatchers. Same call FG-583 made when it put its refusal in the loader. */
export type ComposeResult =
  | { ok: true; prompt: string; protocol?: AgentProtocolStamp }
  | { ok: false; refusal: string; role: string };

function defaultAgentDir(role: string): string {
  const root = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  return join(root, "agents", role);
}

function defaultConstraintsDir(): string {
  const root = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  return join(root, "constraints");
}

export function composeSystemPrompt(args: ComposeArgs): ComposeResult {
  const sections: string[] = [];

  // FG-654: the protocol check and the prompt MUST read the same installed file, so both
  // resolve from one home. An explicit agentDir is that file's home by definition; a
  // protocolPaths.forgeHome override steers both halves; otherwise it is $FORGE_HOME.
  const forgeHome = args.protocolPaths?.forgeHome;
  const agentDir = args.agentDir ?? (forgeHome !== undefined ? join(forgeHome, "agents", args.role) : defaultAgentDir(args.role));
  const baseFile = join(agentDir, "CLAUDE.md");

  // For a role the review lifecycle dispatches, the Forge-owned protocol region must be
  // present AND current before anything is composed. An ABSENT seed and a STALE one are
  // the same class of unmet precondition: the placeholder below used to fail OPEN,
  // dispatching a reviewer with no role contract at all.
  const protocol = assertAgentProtocolCurrent(args.role, {
    ...(args.protocolPaths ?? {}),
    forgeHome: forgeHome ?? join(agentDir, "..", ".."),
  });
  if (!protocol.ok) return { ok: false, refusal: protocol.refusal, role: args.role };

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
    runTags: args.runTags,
  });
  if (suggest.length > 0) {
    const body = suggest.map((c) => `## Constraint: ${c.id}\n\n${c.body}`).join("\n\n");
    sections.push(`# Constraints\n\n${body}`);
  }

  sections.push(FRAMING);

  return {
    ok: true,
    prompt: sections.join("\n\n---\n\n") + "\n",
    ...(protocol.stamp ? { protocol: protocol.stamp } : {}),
  };
}
