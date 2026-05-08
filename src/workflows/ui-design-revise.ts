import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// ui-design-revise: revise an existing UI design (per-app design corpus per
// BACKLOG #67). Same two-phase shape as `ui-design`:
//   brief    — prompt-author writes a revision PROMPT.md that opens the
//              prior .pen file and applies requested changes (reads
//              inputs.brief = revision brief).
//   ui-review — manual phase. Human runs PROMPT.md against Pencil + Claude
//              Code, exports updated PNGs / HTML, then `forge submit`.
//              Submit validates the same conventional artifacts as ui-design
//              (designDir/<dir>.pen non-zero, designs/*.png ≥ 1, code/*.html ≥ 1).
//
// Reuses --design-dir from the prior ui-design run; the revision overwrites
// or extends in place. No new directory.
export const workflow: Workflow = {
  name: "ui-design-revise",
  description:
    "Revise a prior UI design. prompt-author writes a revision PROMPT.md targeting the existing .pen file; you run it against Pencil + Claude Code; submit updated artifacts.",
  phases: [
    {
      name: "brief",
      agents: [agent("prompt-author", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "inputs.brief contains the revision brief. The prior design corpus lives at inputs.designDir (always set by `forge new --design-dir`). Use the ui-design-revise template at templates/ui-design-revise.md if present (falls back to ui-design.md framed as a revision otherwise). Verify the prior <designDir>/<basename>.pen is non-zero before generating — if it's missing or 0 bytes, fail with status='failed' and surface a clear error in result.notes (the prior design source was lost). Write the produced PROMPT.md to /task/PROMPT.md. Output {status, promptPath: '/task/PROMPT.md', brief, template: 'ui-design-revise', parameters, openQuestions, notes}.",
    },
    {
      name: "ui-review",
      agents: [], // manual phase per FORGE-DEC-016
      gate: "human",
      onReject: "brief",
    },
  ],
};
