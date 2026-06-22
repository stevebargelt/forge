---
id: FG-350
type: story
status: active
title: "Control-plane receipts: persist route, workflow, config, and constraint provenance per run/task"
epic: FG-291
created: 2026-06-22
---

## Problem

Forge can explain some task decisions today, especially model resolution, because task rows and manifests record model/runtime details. But other control-plane decisions are either recomputed from current host/project files or inferred.

That is unsafe for historical explanation. Host config, project overrides, routing policy, workflow YAML, constraints, and seeds can change after a task ran. A dashboard Run Map or Explain panel must not accidentally explain yesterday's run using today's config.

## Goal

Persist durable control-plane receipts at run/task dispatch time so dashboard Explain views and orchestrator JSON can answer: Why did Forge run this this way? using facts from the time of execution.

## MVP Scope

Extend the task manifest and/or run metadata to record:

- workflow source:
  - workflow name
  - source: host | project
  - path
- runtime source:
  - runtime name
  - source: host | project
  - path
- model-policy source:
  - source: host | project | absent
  - path when present
  - legacy mode marker when absent
- routing receipt when available:
  - route key
  - source: host | project
  - policy path
  - responsible
  - path type
  - required followups
- docs-surfaces source when evaluated:
  - source: project | built-in
  - path when present
  - invalid/fallback warning when relevant
- constraints receipt:
  - matching suggest constraints added to prompt
  - matching force constraints passed to reds
  - skipped tagged constraints, where cheap and useful
- project/workspace identity
- any warnings or inferred/unknown fields

## Design Requirements

- Prefer recorded receipts in dashboard/API explanations.
- For legacy runs without receipts, degrade gracefully with unknown, legacy, or inferred from current config labels.
- Do not store secrets, token material, auth file paths, or full prompt bodies in the receipt.
- Do not copy whole config files into every manifest unless explicitly justified. Store source/path/resolved decisions first.
- The receipt should be structured JSON with stable field names.
- The same receipt shape should support FG-348 Run Map and FG-349 Control-Plane Sources.

## Recorded vs Effective Vocabulary

Use consistent labels:

- SOURCE: human-authored config.
- DERIVED: Forge-compiled/generated config.
- EFFECTIVE: the config Forge would use now for this project after precedence
  and overrides.
- RECORDED: historical config/provenance captured when a run/task dispatched.

Receipts are RECORDED truth from dispatch time. Explain views must distinguish
recorded provenance from effective current config, because host/project config
may have changed after the run.

## Non-Goals

- No dashboard UI in this story.
- No config editing.
- No route classification changes.
- No policy semantics changes.
- No replay or rehydration of old config files.

## Acceptance Criteria

- New task manifests include a controlPlane or equivalent receipt block.
- Receipts are written for both forge invoke and forge new / forge next dispatched tasks.
- Red tasks record read-only/project snapshot provenance.
- Model/runtime data already present is either preserved or folded into the new shape without breaking existing consumers.
- Tests prove that explanation can distinguish recorded-time source from current changed config.
- Legacy manifests remain readable.
