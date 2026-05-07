import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// Single-task design phase (no fanout) — coherence across screens depends on the
// designer copying the anchor .pen and opening the copy for each subsequent screen
// (via Pencil's MCP tools). Fanout-per-screen would produce visually inconsistent
// screens (independent palette / typography / density per call), which is why we
// don't use it here.
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
        "Generate all screens in this single task by calling Pencil's MCP tools directly (mcp__pencil__open_document, mcp__pencil__batch_design, mcp__pencil__get_screenshot, mcp__pencil__export_nodes — see the pencil-design skill). DO NOT use the `pencil` CLI's `--prompt` or `interactive` modes. Anchor on the most representative screen first (open with an empty path), then chain every subsequent screen by `cp anchor.pen <new>.pen` and opening the copy so the visual language is consistent. Write all .pen and .png files into /task/. Output {status, screens: [{name, penFile, pngFile, rationale}], openQuestions, notes}.",
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
