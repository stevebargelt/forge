import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// `feature` workflow: feature work with no UI/UX design step. Architecture
// review is always part of feature work (Steven's call 2026-05-08), so this
// always starts with `architect`. For features that need UI design, see
// `feature-ui-design-needed`. For features that already have UI design done,
// see `feature-ui-design-provided`.
export const workflow: Workflow = {
  name: "feature",
  description: "Feature work without UI/UX design. Architect → plan → build → verify.",
  phases: [
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
      workflowAdditions:
        "Produce systems-level architectural assessment, NOT implementation guidance. Output {risks, constraints, boundaries, priorArt, openQuestions, notes}. Empty arrays are fine when a feature genuinely has no concerns at that level. Do not pick type names, function names, or file paths — that's the implementer's job with the code in front of them. See architect seed for the discipline.",
    },
    {
      name: "plan",
      agents: [agent("planner", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Translate the architecture document into a step-by-step plan. Output {steps: [{id, summary, files, acceptance}]}.",
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
        "Implement the plan. Output {steps_completed, diff_summary, files_modified}.",
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
