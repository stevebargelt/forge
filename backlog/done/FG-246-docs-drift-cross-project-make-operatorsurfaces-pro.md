---
id: FG-246
type: story
status: done
title: "Docs drift — cross-project: make OPERATOR_SURFACES project-configurable (inference is forge-path-hardcoded)"
---

**Closed:** 2026-06-02. Commit `cb7ecf9`.

src/v2/contract.ts OPERATOR_SURFACES is hardcoded to forge's own layout (src/cli/, seeds/, src/notify/, ...). On any non-forge project the path inference matches nothing, so forge show's docs-impact auto-suggest and the #242 shipped advisory's 'impacted' detection never fire automatically — they only work if the orchestrator explicitly sets operator_behavior_changed:true in the task contract.

The documenter agent, the docs_drift red category, and the advisory's resolution-detection (docs_updated / deferral) all work generically — only the path INFERENCE is forge-specific.

Fix options: per-project .forge config (e.g. docs-surfaces: [globs]) that overrides/extends the defaults, and/or project-type defaults (a React app's operator surfaces differ from a CLI's). Until this lands, docs-impact inference is forge-on-forge only; document that limitation where operator_behavior_changed is described.