import type { Workflow } from "../types/index.js";
import { agent } from "./_agentRefs.js";

export const workflow: Workflow = {
  name: "investigation",
  description:
    "Multi-phase research: frame the question, fan out per-claim investigators, synthesize, recommend.",
  phases: [
    {
      name: "frame",
      agents: [agent("framer", "spec-writer")],
      gate: "human",
      workflowAdditions:
        "Output JSON with `claims: string[]` and `experiments: string[]`. Each claim becomes one investigator task in the next phase.",
    },
    {
      name: "investigate",
      agents: [agent("investigator", "spec-writer")],
      reds: {
        wide: agent("red-wide", "fast-orchestrator"),
        narrow: agent("red-narrow", "fast-orchestrator"),
        parallel: true,
        authority: "specialist",
        gateOnVerdict: false,
      },
      fanout: { maxConcurrency: 4, failureMode: "continue" },
      fanoutFromUpstream: { arrayKey: "claims", inputKey: "claim" },
      gate: "human",
      workflowAdditions:
        "You receive ONE claim in inputs.claim. Validate it with concrete evidence. Output {claim, evidence, conclusion: 'supported'|'refuted'|'inconclusive', notes}.",
    },
    {
      name: "synthesize",
      agents: [agent("synthesizer", "spec-writer")],
      reds: {
        wide: agent("red-wide", "fast-orchestrator"),
        narrow: agent("red-narrow", "fast-orchestrator"),
        parallel: true,
        authority: "specialist",
        gateOnVerdict: false,
      },
      gate: "human",
      workflowAdditions:
        "Aggregate all investigate outputs and the original question into a synthesis. Output {architecturalImplications, antiFindings, openQuestions}.",
    },
    {
      name: "recommend",
      agents: [agent("recommender", "spec-writer")],
      gate: "auto",
      workflowAdditions:
        "Produce the final verdict document as Markdown in result.recommendation. Include rationale tied to specific evidence.",
    },
  ],
};
