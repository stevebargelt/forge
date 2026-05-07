import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// Single-task design phase (no fanout) — coherence across screens depends on the
// designer chaining `pencil --in <prior>.pen` calls within one task. Fanout-per-screen
// would produce visually inconsistent screens (independent palette / typography / density
// per call), which is why we don't use it here.
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
        "Generate all screens in this single task by driving `pencil interactive` (the MCP-tools REPL mode — see the pencil-design skill). DO NOT use `pencil --prompt` one-shot mode; it stalls on inner-Claude permission prompts in containers. Anchor on the most representative screen first (no --in), then chain every subsequent screen with `--in <anchor>.pen` so the visual language is consistent. Write all .pen and .png files into /task/. Output {status, screens: [{name, penFile, pngFile, rationale}], openQuestions, notes}.",
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
