import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

export const workflow: Workflow = {
  name: "feature-design-needed",
  description: "PRD exists but design does not. Architect → plan → build → verify.",
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
        "Produce the architecture document. Output {decisions, components, interfaces, openQuestions}.",
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
