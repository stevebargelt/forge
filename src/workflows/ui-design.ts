import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// Minimal stub per FORGE-DEC-014. The full shape from BACKLOG #54 is brief
// (prompt-author, gate=human) → review (no agent, gate=human). Today this
// stub is only the brief phase: it's enough to validate the prompt-author
// primitive (#53) end-to-end via the dashboard.
//
// The "review" phase (human runs PROMPT.md outside forge, comes back, gates
// with artifact paths) needs either a human-placeholder agent or a manual-
// phase concept that doesn't dispatch a container — neither exists yet.
// When that lands, append the second phase here.
//
// Inputs the prompt-author reads from inputs.brief (passed via
// `forge new ui-design "<title>" --brief "..."`).
export const workflow: Workflow = {
  name: "ui-design",
  description:
    "Design a UI from a brief. The prompt-author interviews + writes a PROMPT.md; the human runs that PROMPT.md in their own Claude Code + Pencil session and gates back with artifact paths.",
  phases: [
    {
      name: "brief",
      agents: [agent("prompt-author", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "inputs.brief contains the design brief. Use the ui-design template at templates/ui-design.md (already in your seed). Interview the human to fill any missing parameters (target_pen_file, output_dir, file_naming, style, screens). Write the produced PROMPT.md to /task/PROMPT.md. Output {status, promptPath: '/task/PROMPT.md', brief, template: 'ui-design', parameters, openQuestions, notes}.",
    },
  ],
};
