import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// design-revise — for iterating on existing .pen files rather than starting cold.
// Input shape (passed via --brief at `forge new`): a description of the changes wanted
// plus paths to the existing .pen files (relative to /project or absolute on the host).
// The designer copies each existing .pen to /task/, opens it via Pencil's MCP tools
// (mcp__pencil__open_document), reads the existing nodes via batch_get, applies edits
// via batch_design, and exports updated .png files via export_nodes.
export const workflow: Workflow = {
  name: "design-revise",
  description: "Revise existing Pencil designs. Revise → human-review → export.",
  phases: [
    {
      name: "revise",
      agents: [agent("designer", "spec-writer", "agent-designer-worker")],
      gate: "human",
      workflowAdditions:
        "inputs.brief contains the revision request and paths to existing .pen files. Copy each existing .pen to /task/ then open via mcp__pencil__open_document; use mcp__pencil__batch_get to find existing nodes and mcp__pencil__batch_design to apply changes (see the pencil-design skill). DO NOT use the `pencil` CLI's `--prompt` or `interactive` modes. Write the revised .pen files (auto-saved by Pencil) and PNG exports (via mcp__pencil__export_nodes) into /task/. Output {status, screens: [{name, penFile, pngFile, rationale}], openQuestions, notes}.",
    },
    {
      name: "export",
      agents: [agent("designer-export", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Convert each approved revised .pen file into a semantic HTML file styled with Tailwind (CDN). Write /task/<screen>.html per screen. Output {status, exports: [{screen, htmlFile, notes}], openQuestions, notes}.",
    },
  ],
};
