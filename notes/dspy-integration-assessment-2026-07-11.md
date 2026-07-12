# DSPy Integration Assessment

Date: 2026-07-11

## Executive recommendation

Assuming "dSpy" means Stanford's DSPy, adopt it experimentally as an offline prompt optimizer for Forge, but do not integrate it into Forge's production orchestration or agent runtime.

DSPy could materially improve Forge's reviewer and specialist-agent instructions. The prerequisite is a trustworthy evaluation corpus. Forge currently possesses substantial raw evidence, but not yet the independent labels, prompt provenance, and replay harness required to optimize safely.

The recommended sequence is:

1. Build a Forge-native evaluation and replay substrate.
2. Establish trustworthy baselines for one agent role.
3. Attach DSPy/GEPA as an optional optimizer.
4. Shadow-test generated prompts without gate authority.
5. Promote successful prompts through Forge's existing source-control and review gates.

DSPy should not write production prompts directly, decide merges, or become a second orchestration layer.

## What DSPy provides

DSPy separates an LM application into:

- Signatures: typed input/output declarations.
- Modules: strategies such as prediction, chain-of-thought, and ReAct.
- Metrics: executable definitions of "better."
- Optimizers: algorithms that rewrite instructions, select demonstrations, or fine-tune models to maximize the metric.

Its GEPA optimizer reflects on failed trajectories and textual feedback, proposes new instructions, and evaluates them against validation examples. The GEPA paper reports stronger results than GRPO across six research tasks with substantially fewer rollouts, but those tasks are not equivalent to autonomous repository modification.

DSPy is credible enough to investigate: it is MIT licensed, Python 3.10+, actively developed, and reportedly used in production by several substantial companies. The current stable release observed during this review was 3.2.1. Version 3.3.0b1 was a beta introducing a new LM boundary and ReAct implementation, so any experiment should pin stable 3.2.x rather than the beta.

Primary references:

- https://dspy.ai/
- https://github.com/stanfordnlp/dspy
- https://arxiv.org/abs/2310.03714
- https://arxiv.org/abs/2507.19457
- https://dspy.ai/diving-deeper/choosing-an-optimizer/

## Why it fits Forge

Forge already records much of what an optimizer needs:

- The exact composed prompt is stored in each task package and written as `CLAUDE.md` (`src/v2/compose.ts`, `src/v2/invoke.ts`, and `src/v2/runNext.ts`).
- Task inputs, results, errors, model resolution, timestamps, verdicts, findings, gates, events, CI evidence, and token usage are durable (`src/store/schema.ts`).
- Shipping reviewers receive rich acceptance context through `reviewerContextPacket`.
- Closed tickets, review findings, invariant tests, corrected audit findings, and AC evidence walks form the beginnings of a quality corpus.
- The Forge strategic review already identifies the accumulated ticket/review/ADR corpus as an underused asset (`notes/forge-strategic-review-2026-07-10.md`).

DSPy's strongest potential contribution is not more agents. It is systematically improving the instructions used by Forge's existing agents.

## Where it does not fit

A direct runtime integration would be architecturally harmful.

Forge is a TypeScript control plane around Claude Code, Codex, and Pi subscription/runtime CLIs. DSPy is Python-first and currently connects through API-key-backed LiteLLM providers. Replacing Forge dispatch with DSPy would introduce a second provider-routing, authentication, tool-loop, caching, and observability system.

More importantly, optimizers repeatedly execute candidate programs. Running candidate engineer prompts against live repositories would be expensive, difficult to reproduce, unsafe without disposable historical worktrees, confounded by model and environment changes, and vulnerable to optimizing reviewer agreement instead of software correctness.

Forge's current metrics measure operational reliability: completion, duration, retries, idle kills, and red blocks (`src/v2/metrics.ts`). Those are useful signals, but they are not quality labels. DSPy explicitly requires a metric and baseline before optimization; it cannot manufacture a trustworthy objective for Forge.

There is also real optimizer risk. Recent research has demonstrated that reflective prompt optimization can degrade a defective seed and can produce difficult-to-interpret search trajectories. This does not invalidate GEPA, but it reinforces the need for held-out tests and human review: https://arxiv.org/abs/2603.18388.

## Recommended pilot

Use DSPy to optimize `red-wide` instructions in shadow mode against historical PR snapshots.

This is preferable to starting with the engineer or shipping reviewer. Engineer tasks have a large, mutation-heavy search space. Shipping reviewer is directly inside the merge trust perimeter. Red-wide is read-only, produces structured findings, and has substantial historical evidence. A candidate red-wide prompt can run as an additional advisory reviewer without affecting closeability.

Construct approximately 60-100 cases containing:

- Known defective PR heads before reviewer fixes.
- Their corrected heads.
- Clean PRs where no substantive finding should be emitted.
- Findings from the engineering review document, review loops, and ticket corrections.
- Historical cases split by PR and time, never by individual review round, to prevent leakage.

Gold labels must be independently adjudicated. A finding counts as substantiated when it resulted in a real fix, invariant test, demonstrated failure, or explicit operator disposition. A historical reviewer verdict alone is not ground truth.

Optimize instructions only at first. Avoid demonstration selection because examples increase context cost and are more prone to overfitting. Use GEPA because Forge can return both a scalar score and textual feedback describing missed invariants or false findings.

## Evaluation contract

Primary metrics should be:

- Recall of independently confirmed critical/high findings.
- Precision of substantive findings.
- False-block rate on clean changes.
- Acceptance-criteria miss detection.
- Valid file/line anchors.
- Structured-output validity.

Hard failures should include fabricated file or line references, weakening a trust gate, treating tests alone as proof of semantics, recommending merge authorization from insufficient evidence, and emitting invalid result JSON.

Do not optimize raw finding count, agreement with the original reviewer, merge rate, number of review-loop rounds in isolation, or agent self-reported completion. Tokens, latency, and rounds-to-close are useful secondary measurements, but quality must dominate speed.

## Promotion process

A generated prompt should move through these states:

1. Candidate: a DSPy-generated artifact, never used by normal dispatch.
2. Held-out evaluation: tested against untouched historical cases with repeated runs.
3. Shadow: runs alongside production red-wide with no gate authority.
4. Reviewed seed patch: a human-readable diff against the current seed.
5. Production: normal PR, CI, reviewer, and rollback path.

The threshold must be established before optimization. At minimum, require no regression on critical trust/lifecycle cases, improved substantive-finding performance, no increased clean-change false-positive rate, and acceptable cost across both preferred and fallback reviewer models.

## Required Forge foundations

Before trusting optimization results, Forge needs:

- A stable prompt artifact identifier: seed commit, composed-prompt hash, constraint hashes, and optimizer provenance.
- Historical snapshot replay using disposable worktrees and the actual Forge runtime.
- A sanitized JSONL exporter.
- Dataset, metric-code, model, optimizer-config, and result hashes.
- A distinction between generated prompt artifacts and approved production seeds.
- Fail-closed version checks when loading optimized state.

DSPy supports state-only JSON persistence, but its loader warns rather than blocks on version mismatch. Forge should reject mismatches. See https://dspy.ai/diving-deeper/saving-and-loading/.

Prompt data also needs explicit handling. Forge strips prompts and task inputs from bundles by default because they may be sensitive (`src/v2/bundle.ts`). The evaluation exporter should use an allowlist/redaction policy rather than blindly exporting the database.

## Alternatives

DSPy is the stronger choice when the objective is automatic prompt improvement.

For the evaluation substrate alone, Promptfoo is a closer immediate fit: it is local, CLI-oriented, language-agnostic, supports custom providers, caching, matrix comparisons, CI output, assertions, and prompt optimization. It still does not solve Forge's labeling or historical-replay problem. See https://www.promptfoo.dev/docs/intro/.

LangSmith provides polished datasets, annotation queues, offline/online evaluation, human feedback, and experiment comparison. It would add an external service and another prompt/trace control plane, which is disproportionate for Forge now. See https://docs.langchain.com/langsmith/evaluation.

The preferred architecture is therefore to build the benchmark and replay layer in Forge-native TypeScript, use DSPy/GEPA from an isolated Python experiment for optimization, and borrow evaluation patterns from Promptfoo rather than adopting another production platform.

## Final assessment

DSPy is worth a controlled pilot. Forge has enough accumulated review experience that systematic prompt optimization may outperform continued manual seed accretion.

The valuable integration is a prompt laboratory beside Forge, not DSPy inside Forge's execution engine. The main investment is not installing DSPy; it is converting Forge's history into an honest benchmark. Without that benchmark, DSPy will optimize whichever proxy is easiest to measure, potentially making reviewers more confident, verbose, or agreeable without making Forge more correct.
