import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

export const workflow: Workflow = {
  name: "feature-design-provided",
  description: "PRD/design exists. Skip architecture; go straight to plan, build, verify.",
  phases: [
    {
      name: "plan",
      agents: [agent("planner", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Produce a step-by-step implementation plan tied to the provided PRD. Output {steps: [{id, summary, files: string[], acceptance}]}.",
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
        "Implement the plan. Each completed step writes diffs and updates result.steps_completed. result.diff_summary should describe high-impact edits.",
    },
    {
      name: "verify",
      agents: [agent("verifier", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Run the test plan and report. Output {tests_run, tests_passed, tests_failed, evidence}.",
    },
  ],
};
