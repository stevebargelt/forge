---
id: FG-218
type: story
status: done
title: "AWN-5 review-protocol: standardize red/review result schema, evidence, and severity calibration"
---

**Closed:** 2026-05-30. Commit `a6e4e3e`.

docs/agentic-workflow-next-steps.md §5. Grounded, comparable, useful reviews.

UMBRELLA over #148 (red-narrow rework), #149 (K=3 self-consistency sampling), #150 (forge gate --feedback ground-truth labels), #113 (promote specialist reds authoritative). Those become sub-parts.

Scope:
- Review prompts standardized around invariants, evidence, severity, tests.
- Require file/line refs for code findings.
- Distinguish confirmed issues from residual risks.
- Merge duplicate findings across review agents.
- Calibrate severity against exploitability, blast radius, likelihood.

Acceptance:
- Red result schema includes finding_type, severity, confidence, evidence, affected_files, recommended_fix.
- Orchestrator can summarize convergent vs unique findings.
- Reviewers state which invariants they verified.
- Tests/fixtures reject or downgrade malformed/low-evidence review output.

References #148/#149/#150/#113. Second of the agent-quality pair.