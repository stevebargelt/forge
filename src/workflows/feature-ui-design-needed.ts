import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// `feature-ui-design-needed`: composed workflow for feature work that needs UI
// design first. Six phases mixing manual + agent + reds:
//
//   brief      — prompt-author writes PROMPT.md for the design step
//                (gate=human; the human reviews the prompt, then advances)
//   ui-review  — manual phase. Human runs PROMPT.md against Pencil + Claude
//                Code on the host, exports artifacts, then `forge submit`.
//                onReject loops to brief (revise the prompt).
//                FORGE-DEC-016 + #54 mechanics, identical to ui-design.
//   architect  — reads upstream design artifacts (HTML/PNGs from ui-review)
//                AND the brief, produces decisions/components/interfaces
//                grounded in what's drawn. Specialist reds review.
//                onReject loops to brief (the design needs revising — note
//                this skips ui-review; brief produces a fresh PROMPT.md and
//                the human runs Pencil again. This matches Steven's call
//                2026-05-08 Q2: architect's reject means "revise the design
//                first, then re-architect.")
//   plan       — implementation plan from the architecture
//   build      — implementer with reds (gate=verdict, authoritative)
//   verify     — verifier runs the test plan
//                Failure ends the run (Steven 2026-05-08 Q3: simple v1, no
//                remediation phase)
//
// This is forge's most complex workflow shape today. The architect's seed
// (seeds/agents/architect/CLAUDE.md) reads `inputs.upstream[*].result.htmlFiles`
// + `inputs.upstream[*].result.pngFiles` when present.
export const workflow: Workflow = {
  name: "feature-ui-design-needed",
  description:
    "Build a feature that needs UI design. brief → ui-review → architect → plan → build → verify. The design and implementation share a designDir.",
  phases: [
    {
      name: "brief",
      agents: [agent("prompt-author", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "inputs.brief contains the feature + UI brief. Use the ui-design template at templates/ui-design.md. Interview the human to fill any missing parameters (target_pen_file, output_dir, file_naming, style, screens). Write the produced PROMPT.md to /task/PROMPT.md. Output {status, promptPath: '/task/PROMPT.md', brief, template: 'ui-design', parameters, openQuestions, notes}.",
    },
    {
      name: "ui-review",
      agents: [], // manual phase per FORGE-DEC-016
      gate: "human",
      onReject: "brief",
    },
    {
      name: "architect",
      agents: [agent("architect", "spec-writer")],
      reds: {
        wide: agent("red-wide", "fast-orchestrator"),
        narrow: agent("red-narrow", "fast-orchestrator"),
        parallel: true,
        authority: "specialist",
        gateOnVerdict: false,
      },
      gate: "human",
      onReject: "brief",
      workflowAdditions:
        "Read the upstream design artifacts: inputs.upstream[*].result.htmlFiles (HTML/CSS reference exports) and inputs.upstream[*].result.pngFiles (canonical Pencil renders). Treat the design as the canonical UI — your architecture must support what's drawn. Your decisions/components/interfaces should reference the design's screens and states. Output {decisions, components, interfaces, openQuestions}.",
    },
    {
      name: "plan",
      agents: [agent("planner", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Translate the architecture document into a step-by-step plan. The plan should reference design artifact paths where relevant. Output {steps: [{id, summary, files, acceptance}]}.",
    },
    {
      name: "build",
      agents: [agent("implementer", "spec-writer")],
      reds: {
        wide: agent("red-wide", "fast-orchestrator"),
        narrow: agent("red-narrow", "fast-orchestrator"),
        parallel: true,
        authority: "authoritative",
        gateOnVerdict: true,
      },
      gate: "verdict",
      workflowAdditions:
        "Implement the plan. The HTML files in upstream design artifacts are reference, not implementation — match the design's spacing, palette, and DOM hierarchy where reasonable, but use the project's actual stack idioms. Output {steps_completed, diff_summary, files_modified}.",
    },
    {
      name: "verify",
      agents: [agent("verifier", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Run the test plan against the build. Output {tests_run, tests_passed, tests_failed, evidence}.",
    },
  ],
};
