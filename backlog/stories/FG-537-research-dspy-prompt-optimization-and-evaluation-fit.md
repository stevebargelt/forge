---
id: FG-537
type: story
status: deferred
title: "Research: DSPy prompt optimization and evaluation fit for Forge"
created: 2026-07-12
---

**Disposition (2026-07-19):** Deferred until Forge has a representative evaluation corpus with independently adjudicated labels. Prompt optimization before that substrate exists would optimize an unreliable target.

## Problem

Forge has accumulated a substantial corpus of agent prompts, task packages, review findings, acceptance evidence, CI results, lifecycle incidents, and operator dispositions. Prompt changes are still primarily made by hand, however, and Forge has no controlled way to determine whether a revised agent seed actually improves correctness on representative historical work.

DSPy offers declarative LM programs, executable metrics, evaluation, and optimizers such as GEPA that can rewrite instructions from scored examples and textual feedback. It may help Forge improve reviewer and specialist-agent instructions systematically. A direct integration could also be a poor architectural fit: DSPy is Python/API-provider oriented while Forge is a TypeScript control plane around Claude Code, Codex, and Pi subscription CLIs; unsafe or circular metrics could optimize reviewer agreement, verbosity, or finding count instead of software correctness.

The initial assessment recommends an isolated offline prompt laboratory rather than placing DSPy in Forge's production orchestration or merge trust path. That recommendation needs a focused research and prototype pass before Forge commits to a dependency or product direction.

Primary internal reference: `notes/dspy-integration-assessment-2026-07-11.md`.

## Goal

Determine whether DSPy can measurably improve a bounded Forge agent role using Forge's real historical evidence and runtime, without introducing a second production orchestration plane or weakening any trust gate. Produce a go/no-go recommendation and a reproducible pilot design.

## Acceptance Criteria

- The research explicitly reviews and references `notes/dspy-integration-assessment-2026-07-11.md`, preserving its central distinction between an offline prompt laboratory and production runtime integration.
- The output lives in an appropriate durable research path, such as `docs/research/dspy-forge-prompt-optimization.md`, and clearly separates sourced facts, Forge-specific inference, experimental results, and recommendations.
- Compare at least these options:
  - Forge-native TypeScript evaluation/replay only;
  - Forge-native evaluation with DSPy/GEPA as an isolated optimizer;
  - Promptfoo or another local evaluation runner where it materially reduces implementation cost;
  - direct DSPy runtime integration, including an explicit analysis of why it should or should not be rejected.
- Analyze the integration boundary with Forge's actual execution model:
  - Claude Code, Codex, and Pi subscription/runtime CLIs versus DSPy's API-key/LiteLLM boundary;
  - TypeScript control plane versus Python experiment dependency;
  - read-only historical replay versus live repository mutation;
  - task/result/verdict/CI/token evidence already persisted by Forge;
  - prompt and task-input sensitivity, consistent with bundles stripping them by default.
- Define the minimum evaluation substrate required before optimization:
  - historical repository snapshots in disposable worktrees;
  - sanitized example export;
  - independently adjudicated labels;
  - train/validation/test splits by PR or time rather than review round;
  - prompt, seed, constraint, model, runtime, dataset, metric-code, and optimizer provenance;
  - repeated runs or another explicit treatment of model nondeterminism.
- Design one bounded, shadow-only pilot. Prefer `red-wide` unless evidence supports a safer or more measurable role. The pilot must not modify repositories, authorize merges, affect closeability, or replace the production reviewer.
- Define a metric contract that rewards independently substantiated critical/high findings, precision, clean-change false-positive control, acceptance-criteria miss detection, valid file/line anchors, and structured-output validity. Explicitly reject raw finding count, reviewer agreement alone, merge rate, and self-reported completion as optimization targets.
- Define candidate-prompt promotion stages: generated candidate, held-out evaluation, advisory shadow run, human-readable seed diff, normal PR/review/CI, and rollback. Generated optimizer output must never silently overwrite an approved seed.
- Evaluate stable DSPy 3.2.x first rather than a beta release, record dependency and optimizer versions, and assess save/load version behavior. Any production-facing load path must fail closed on incompatible artifacts rather than merely warn.
- Estimate rollout cost, latency, provider/API credential requirements, data-handling risk, and ongoing maintenance burden. Compare those costs with continued manual seed maintenance and with a Forge-native benchmark that uses no optimizer.
- Produce a concrete go/no-go decision with predeclared success criteria for a pilot. A no-go result is acceptable and must leave Forge with a useful evaluation/replay design rather than a stranded Python subsystem.

## Non-Goals

- No production DSPy dependency in Forge during this ticket.
- No replacement of Forge workflows, model policy, runtime resolution, agent CLIs, review-loop, or merge authorization.
- No optimization against live repositories or unreviewed production tasks.
- No automatic deployment of generated prompts.
- No use of historical reviewer verdicts as unquestioned ground truth.
- No fine-tuning work unless a later ticket is justified by prompt-only results.

## References

- Internal assessment: `notes/dspy-integration-assessment-2026-07-11.md`
- Forge strategic review: `notes/forge-strategic-review-2026-07-10.md`
- DSPy documentation: https://dspy.ai/
- DSPy repository: https://github.com/stanfordnlp/dspy
- DSPy paper: https://arxiv.org/abs/2310.03714
- GEPA paper: https://arxiv.org/abs/2507.19457
- Promptfoo evaluation documentation: https://www.promptfoo.dev/docs/intro/
