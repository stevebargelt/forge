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
        "Generate all screens in this single task by driving `pencil interactive` via stdin heredoc — see the pencil-design skill. CRITICAL: ONE Bash call = ONE complete screen (one heredoc with all tool calls inline). Each `pencil interactive` invocation pays a 3-5s boot cost; running one call per tool-invocation makes the agent fail with idle timeouts. DO NOT use `pencil --prompt`, do NOT look for `mcp__pencil__*` tools (the MCP server needs a Pencil app we don't have). Anchor screen first (no --in), then chain every subsequent screen with `--in <anchor>.pen` for visual consistency. All .pen and .png files go in /task/. Output {status, screens: [{name, penFile, pngFile, rationale}], openQuestions, notes}.",
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
