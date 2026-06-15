---
id: FG-150
type: story
status: active
title: "Reds: forge gate --feedback to capture ground-truth labels on findings"
---

Filed 2026-05-26. Research technique #3 from /tmp/red-false-positives-research.md, deferred during #147 implementation.

**Why filed.** All the other FP-mitigation techniques (validator, self-consistency, rubric anchoring) get tuned by vibes — chosen thresholds, hand-picked window sizes, intuited prompts. A ground-truth dataset of "the user actually said this finding was real / a nit / wrong" makes every other technique tunable by data instead of guesswork.

The forge user is also the reviewer. The labels they already form in their head when reading gate output can be captured trivially.

**Fix shape.** A new CLI flow during gate review:

\`\`\`bash
forge gate <task-id> advance --feedback
\`\`\`

The flow walks each finding from the verdicts under review, prompting for a label per finding:
- \`real\` — actual defect worth addressing
- \`nit\` — true but trivial; not worth blocking on
- \`false\` — wrong / hallucinated / misunderstanding

Labels write to a new table: \`finding_feedback (verdict_id, finding_index, label, created_at, rationale TEXT)\`.

The flag is opt-in. Gate without \`--feedback\` works exactly as today. Adoption is voluntary, paid back over time as the dataset enables auto-tuning.

**What the data unlocks (over time):**
- Per-red FP rate: identify reds that consistently fail to produce real findings. Retire or rework.
- Per-rubric-tier rate: calibrate the rubric (if/when one ships).
- Per-rule-pattern FP rate: identify finding shapes that are unreliable.
- Confidence calibration: empirical mapping from self-reported confidence to actual real-rate.
- Auto-thresholding: drop authoritative-block authority from reds whose FP rate exceeds N%.

**Where it slots in.**
- New table in src/store/schema.ts: \`finding_feedback\`. No new col on existing tables.
- New CLI command surface: \`forge gate <id> advance|reject|request-changes --feedback\` adds the prompt loop after the action lands.
- New store accessor: \`insertFeedback(verdict_id, finding_index, label, rationale?)\`.
- The dashboard (read-only) could surface per-red FP rates once enough data accumulates. Not in scope for this ticket.

**Out of scope.**
- Building any of the downstream auto-tuning. This ticket only ships the data-capture surface. Tuning is downstream tickets that read from \`finding_feedback\`.
- Forced labeling (mandatory \`--feedback\` on every gate). Voluntary only.
- Backfilling historical verdicts.

**Sizing.** Small-medium. ~80 LoC including new table + accessor + CLI flow + tests. The value is in accumulating the dataset over weeks/months, not in the day-1 implementation.

**Composite with:** #147 (validator) — once feedback labels exist, we can validate whether the validator's drops match the user's \`false\` labels. Gives a way to measure the validator's precision and recall.

**Sequencing.** No urgent dependency. Can ship anytime — but most useful AFTER #147 has stabilized so the validator's drops + user feedback can be cross-referenced for tuning.

**Caught:** 2026-05-26 cross-track research session.