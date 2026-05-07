import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// design-revise — for iterating on existing .pen files rather than starting cold.
// Input shape (passed via --brief at `forge new`): a description of the changes wanted
// plus paths to the existing .pen files (relative to /project or absolute on the host).
// The designer reads those files, runs `pencil --in <existing>.pen` with the revision
// prompt, and writes new .pen/.png files to /task/.
export const workflow: Workflow = {
  name: "design-revise",
  description: "Revise existing Pencil designs. Revise → human-review → export.",
  phases: [
    {
      name: "revise",
      agents: [agent("designer", "spec-writer", "agent-designer-worker")],
      gate: "human",
      workflowAdditions:
        "inputs.brief contains the revision request and paths to existing .pen files. Use `pencil --in <existing>.pen` to apply the changes. Write the revised .pen and .png files into /task/. If multiple screens are being revised, keep them coherent by chaining --in. Output {status, screens: [{name, penFile, pngFile, rationale}], openQuestions, notes}.",
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
