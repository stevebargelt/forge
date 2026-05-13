import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

// `feature-ui-design-provided`: feature work where the UI/UX design already
// exists (a .pen file, PRD-with-mocks, or earlier ui-design run). Architecture
// review is always part of feature work (Steven 2026-05-08) — even when design
// is provided, the architect phase reads the design as upstream context and
// produces a systems-level architectural assessment (risks, constraints,
// boundaries, prior art) grounded in what's been drawn. NOT implementation
// guidance — see architect seed for the discipline.
//
// For feature work without UI design, see `feature`.
// For feature work that needs UI design first, see `feature-ui-design-needed`.
export const workflow: Workflow = {
  name: "feature-ui-design-provided",
  description: "Feature work with UI design already in hand. Architect → plan → build → verify.",
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
        "Produce systems-level architectural assessment grounded in the provided UI design (inputs.prd or upstream design artifacts). Read the HTML files / PNGs if present. Output {risks, constraints, boundaries, priorArt, openQuestions, notes} — NOT implementation guidance (no type names, no function names). See architect seed.",
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
      // Discipline-specific reds (frontend, backend, security) alongside
      // wide/narrow. All five gate the task per the RedConfig — #96 sub-shift
      // 1 wiring, #113 gating semantics.
      reds: {
        wide: agent("red-wide", "fast-orchestrator"),
        narrow: agent("red-narrow", "fast-orchestrator"),
        additional: [
          agent("red-frontend", "fast-orchestrator"),
          agent("red-backend", "fast-orchestrator"),
          agent("red-security", "fast-orchestrator"),
        ],
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
