import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// design-revise — for iterating on existing .pen files rather than starting cold.
// Input shape (passed via --brief at `forge new`): a description of the changes wanted
// plus paths to the existing .pen files (relative to /project or absolute on the host).
// The designer drives `pencil interactive --in <existing>.pen --out <new>.pen` (one
// heredoc per screen), reads existing nodes via batch_get, applies edits via
// batch_design, and exports updated .png files via export_nodes.
export const workflow: Workflow = {
  name: "design-revise",
  description: "Revise existing Pencil designs. Revise → human-review → export.",
  phases: [
    {
      name: "revise",
      agents: [agent("designer", "spec-writer", "agent-designer-worker")],
      gate: "human",
      workflowAdditions:
        "inputs.brief contains the revision request and paths to existing .pen files. Drive `pencil interactive --in <existing>.pen --out <new>.pen` via stdin heredoc (see the pencil-design skill). CRITICAL: ONE Bash call = ONE complete screen, with all tool calls inline in the heredoc. DO NOT use `pencil --prompt`, do NOT look for `mcp__pencil__*` tools. Write revised .pen and .png files into /task/. If multiple screens are being revised, keep them coherent by chaining --in. Output {status, screens: [{name, penFile, pngFile, rationale}], openQuestions, notes}.",
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
