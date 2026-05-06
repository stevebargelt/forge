import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

export const workflow: Workflow = {
  name: "codebase-assessment",
  description: "Read-only multi-lens review of an existing codebase, ending in a structured report.",
  phases: [
    {
      name: "scope",
      agents: [agent("framer", "fast-orchestrator")],
      gate: "human",
      workflowAdditions:
        "Define the assessment lenses (security, performance, testability, etc.). Output {lenses: string[], priorities: string[]}.",
    },
    {
      name: "assess",
      agents: [agent("assessor", "spec-writer")],
      reds: {
        wide: agent("red-wide", "fast-orchestrator"),
        parallel: true,
        authority: "specialist",
        gateOnVerdict: false,
      },
      fanout: { maxConcurrency: 4, failureMode: "continue" },
      fanoutFromUpstream: { arrayKey: "lenses", inputKey: "lens" },
      gate: "human",
      workflowAdditions:
        "You receive ONE lens in inputs.lens. Produce {lens, findings: [{severity, area, summary, evidence, recommendation}]} for that lens only.",
    },
    {
      name: "report",
      agents: [agent("reporter", "spec-writer")],
      gate: "auto",
      workflowAdditions:
        "Aggregate the per-lens assessments into a single report. Output {report: markdown, prioritizedFindings}.",
    },
  ],
};
