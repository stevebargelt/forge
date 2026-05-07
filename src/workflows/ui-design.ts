import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// Single-task design phase (no fanout) — coherence across screens depends on the
// designer chaining `pencil interactive --in <prior>.pen --out <new>.pen` calls,
// one per screen, each as a complete heredoc. Fanout-per-screen would produce
// visually inconsistent screens (independent palette / typography / density per
// call), which is why we don't use it here.
export const workflow: Workflow = {
  name: "ui-design",
  description: "Design a UI from a brief. Discover screens → design (single task, all screens) → export to HTML+Tailwind.",
  phases: [
    {
      name: "discover",
      agents: [agent("designer", "spec-writer", "agent-designer-worker")],
      gate: "human",
      workflowAdditions:
        "Read inputs.brief and (if present) /project to ground the redesign. Propose the screen list and surface any missing context as openQuestions. Output {status, proposedScreens: [{name, purpose, key}], styleConstraints: string[], openQuestions: string[]}. Do NOT generate designs in this phase — that's the next phase.",
    },
    {
      name: "design",
      agents: [agent("designer", "spec-writer", "agent-designer-worker")],
      gate: "human",
      workflowAdditions:
        "Generate all screens in this single task by driving `pencil interactive` via stdin heredoc — see the pencil-design skill. CRITICAL rules: (1) ONE Bash call = ONE complete screen, all tool calls in one heredoc. (2) `batch_design` BINDINGS are per-batch only — never reuse a binding name across batches, never use a node's `name` field as a parent reference. Across batches, use `batch_get` to discover real IDs and reference parents by id. Prefer fitting a screen's structure into ONE 25-op batch_design (Pattern A) over many small batches. (3) DO NOT use `pencil --prompt`, do NOT look for `mcp__pencil__*` tools. Anchor screen first (no --in), then chain every subsequent screen with `--in <anchor>.pen` for visual consistency. All .pen and .png files go in /task/. Output {status, screens: [{name, penFile, pngFile, rationale}], openQuestions, notes}.",
    },
    {
      name: "export",
      agents: [agent("designer-export", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Convert each approved .pen file from the prior phase into a semantic HTML file styled with Tailwind (CDN). Write /task/<screen>.html per screen. Output {status, exports: [{screen, htmlFile, notes}], openQuestions, notes}.",
    },
  ],
};
