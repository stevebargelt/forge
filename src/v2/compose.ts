// forge v2 — system prompt + task package composition.
//
// Adapted from src/spine/composeSystemPrompt.ts. Tiers, in prompt order:
//   0. FG-654: for a covered role, the Forge-owned protocol from the published seed
//      generation — FIRST, so the contract the output is judged by is read before the
//      operator's customization of the role rather than after it
//   1. Agent base CLAUDE.md from ~/.forge/agents/<role>/CLAUDE.md
//   1b. FG-774: PROJECT ADDENDUM from <project>/.forge/agents/<role>/CLAUDE.md (if present),
//      APPENDED as a labeled section — never a replacement of the host base
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
import { basename, join } from "node:path";
import { filterConstraints, loadEffectiveConstraints } from "./constraints.js";
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
  /** FG-773 (FG-767 T0): the project this dispatch resolves overrides against — where a
   *  later ticket reads a `<project>/.forge` agent (FG-774) / constraints (FG-775) layer
   *  on top of the host dirs. INERT here: it is carried through the resolveAgentDir /
   *  resolveConstraintsDir seam below but never consulted, so the host dirs are read
   *  exactly as before whether or not it is passed. Threaded distinct from the container's
   *  review/mount tree because a red must resolve against the OWNING project, not the
   *  ephemeral integration worktree it reviews (see runOneRed). */
  projectDir?: string;
  /** FG-654: the seed generation this invocation is anchored to, mirroring
   *  LoadContext — `undefined` resolves the live seed pointer, `null` means none
   *  anchored (and a covered role then refuses). */
  seedGeneration?: SeedGeneration | null;
  /** FG-654: the executing release's `seeds/`, the baseline a generation is measured
   *  STALE against. Defaults to the tree this forge runs from; a test that publishes a
   *  disposable release passes that release's seeds. */
  releaseSeedsDir?: string;
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

// FG-773 (FG-767 T0): the ONE resolution seam projectDir threads into. Today each is
// byte-identical to the inline `override ?? default` it replaced — projectDir is accepted
// and ignored. FG-774 (agents) / FG-775 (constraints) plug the `<project>/.forge` override
// layer in HERE, so the resolution has a single named site rather than five call sites.
function resolveAgentDir(role: string, _projectDir: string | undefined, override: string | undefined): string {
  return override ?? defaultAgentDir(role);
}

// FG-774 (FG-767 T1): the sibling to resolveAgentDir for the PROJECT ADDENDUM. The host
// base under resolveAgentDir is ALWAYS the identity; if this file exists it is APPENDED as
// a labeled section — never a replacement, and there is deliberately no full-rewrite escape
// hatch (that would be a separate explicit story). A red resolves this against the OWNING
// project (projectDir carries overrideProjectDir per FG-773), not the review/mount worktree.
// Returns undefined when no project is anchored, so the host-only prompt is byte-identical.
function resolveProjectAddendumFile(role: string, projectDir: string | undefined): string | undefined {
  if (projectDir === undefined) return undefined;
  return join(projectDir, ".forge", "agents", role, "CLAUDE.md");
}

// Resolves the HOST constraints dir (an operator override wins for tests). The PROJECT layer
// is no longer threaded here: FG-775 unions it in via loadEffectiveConstraints, which takes
// the owning-project projectDir directly, so this seam resolves the host dir only.
function resolveConstraintsDir(override: string | undefined): string {
  return override ?? defaultConstraintsDir();
}

export function composeSystemPrompt(args: ComposeArgs): ComposeResult {
  const sections: string[] = [];

  const agentDir = resolveAgentDir(args.role, args.projectDir, args.agentDir);
  const baseFile = join(agentDir, "CLAUDE.md");
  // READ, never written. The operator's file is theirs under exactly the FG-578 rules.
  const installedSeedText = existsSync(baseFile) ? readFileSync(baseFile, "utf8") : null;

  // For a role the review lifecycle dispatches, the Forge-owned protocol must resolve
  // manifest-consistently out of the published generation — and be the EXECUTING
  // release's, not an older one's — before anything is composed, and the operator's file
  // must not still carry an embedded copy of it.
  const generation =
    args.seedGeneration !== undefined ? args.seedGeneration : resolveSeedGeneration();
  const protocol = assertAgentProtocolCurrent(
    args.role,
    generation,
    installedSeedText === null ? null : { path: baseFile, text: installedSeedText },
    args.releaseSeedsDir,
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

  // FG-774: tier-1b PROJECT ADDENDUM. Sits IMMEDIATELY AFTER the host base (base+delta read
  // as one identity block) and BEFORE workflow_additions/constraints (those stay the more
  // specific, authoritative later layers). A labeled section, so the agent reads it as
  // authoritative project-specific context specializing — never replacing — the role base;
  // its later prose can countermand a ROLE-BASE default, never tier-0 or a force constraint.
  // A missing file is a clean no-op: the prompt is byte-identical to the host-only output.
  const addendumFile = resolveProjectAddendumFile(args.role, args.projectDir);
  const addendumText =
    addendumFile !== undefined && existsSync(addendumFile)
      ? readFileSync(addendumFile, "utf8").trim()
      : null;
  if (addendumText !== null && addendumText.length > 0) {
    const label = basename(args.projectDir!);
    sections.push(`## Project-specific instructions (${label})\n\n${addendumText}`);
  }

  const wa = args.step.workflow_additions?.trim();
  if (wa && wa.length > 0) {
    sections.push(`# Workflow additions (step: ${args.step.id})\n\n${wa}`);
  }

  // FG-775: tier-3 SUGGEST set draws from the HOST-UNION-PROJECT effective set. The host
  // suggest constraints always apply; <project>/.forge/constraints adds more (host-wins on id).
  const all = loadEffectiveConstraints({
    hostDir: resolveConstraintsDir(args.constraintsDir),
    projectDir: args.projectDir,
  });
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
