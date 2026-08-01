// forge v2 — system prompt + task package composition.
//
// Adapted from src/spine/composeSystemPrompt.ts. Tiers, in prompt order:
//   0. FG-654: for a covered role, the Forge-owned protocol from the published seed
//      generation — FIRST, so the contract the output is judged by is read before the
//      operator's customization of the role rather than after it
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
import { assertAgentProtocolCurrent, type AgentProtocolStamp } from "./agent-protocol.js";
import { resolveSeedGeneration, type SeedGeneration } from "./seed-generation.js";
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
  /** FG-654: the seed generation this invocation is anchored to, mirroring
   *  LoadContext — `undefined` resolves the live seed pointer, `null` means none
   *  anchored (and a covered role then refuses). */
  seedGeneration?: SeedGeneration | null;
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

  const agentDir = args.agentDir ?? defaultAgentDir(args.role);
  const baseFile = join(agentDir, "CLAUDE.md");
  // READ, never written. The operator's file is theirs under exactly the FG-578 rules.
  const installedSeedText = existsSync(baseFile) ? readFileSync(baseFile, "utf8") : null;

  // For a role the review lifecycle dispatches, the Forge-owned protocol must resolve
  // manifest-consistently out of the published generation before anything is composed,
  // and the operator's file must not still carry an embedded copy of it.
  const generation =
    args.seedGeneration !== undefined ? args.seedGeneration : resolveSeedGeneration();
  const protocol = assertAgentProtocolCurrent(
    args.role,
    generation,
    installedSeedText === null ? null : { path: baseFile, text: installedSeedText },
  );
  if (!protocol.ok) return { ok: false, refusal: protocol.refusal, role: args.role };

  // THE NON-DIVERGENCE PROPERTY. ONE local binding: the bytes pushed into `sections` and
  // the bytes `protocol.stamp.sha256` digests are the same value used twice. Nothing
  // re-reads the file after compose and nothing recomputes at manifest-write time, so
  // the recorded hash cannot describe a prompt the container never saw.
  const protocolText = protocol.text;
  if (protocolText !== undefined) sections.push(protocolText);

  // The operator seed is FAIL-OPEN when absent: it is operator-owned, and the contract
  // the reviewer is judged by is now guaranteed present from the generation above, so an
  // absent operator file is no longer a reason to refuse.
  if (installedSeedText !== null) {
    sections.push(installedSeedText.trim());
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
