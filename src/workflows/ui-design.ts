import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// ui-design (FORGE-DEC-014, FORGE-DEC-016):
//   brief     — prompt-author interviews + writes /task/PROMPT.md. gate=human.
//               Human reviews the prompt body in the dashboard, then advances.
//   ui-review — manual phase (no agent). Human runs PROMPT.md against Pencil +
//               Claude Code on their host, iterates until happy, then runs
//               `forge submit <task-id>` (or hits the dashboard button).
//               `forge submit` validates the conventional artifacts under
//               run.metadata.designDir (.pen non-zero, designs/*.png ≥ 1,
//               code/*.html ≥ 1) and transitions to awaiting_gate. Human gates:
//               advance | reject. Reject loops back to `brief` via onReject —
//               prompt-author re-runs with inputs.rejectedRationale populated,
//               producing a revised PROMPT.md.
//
// Inputs the prompt-author reads from inputs.brief (passed via
// `forge new ui-design "<title>" --brief "..." --design-dir <path>`).
export const workflow: Workflow = {
  name: "ui-design",
  description:
    "Design a UI from a brief. The prompt-author interviews + writes a PROMPT.md; the human runs that PROMPT.md in their own Claude Code + Pencil session and submits artifacts back to forge.",
  phases: [
    {
      name: "brief",
      agents: [agent("prompt-author", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "inputs.brief contains the design brief. Use the ui-design template at templates/ui-design.md (already in your seed). Interview the human to fill any missing parameters (target_pen_file, output_dir, file_naming, style, screens). Write the produced PROMPT.md to /task/PROMPT.md. Output {status, promptPath: '/task/PROMPT.md', brief, template: 'ui-design', parameters, openQuestions, notes}.",
    },
    {
      name: "ui-review",
      agents: [], // manual phase per FORGE-DEC-016 — human produces artifacts off-forge
      gate: "human",
      onReject: "brief",
    },
  ],
};
