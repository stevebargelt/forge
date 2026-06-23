---
id: FG-372
type: story
status: active
title: "Shipping Reviewer: acceptance-criteria preflight and operational done gate"
epic: FG-291
created: 2026-06-23
---

## Problem

Forge can report work as finished even when the operator would not consider it done. Recent examples include code passing tests while backlog close state was not committed, follow-up instructions from the conversation were missed, and a story was considered runnable even though the backlog item itself lacked meaningful acceptance criteria.

The current pipeline is good at proving "the code passes the tests that were written." It is weaker at proving "the work satisfies the backlog item, the latest operator instruction, and the operational definition of done."

Red agents and test engineers do not reliably catch this class of issue because they mostly review code behavior and tests. The missing perspective is closer to a product owner plus tech lead: does this satisfy the promised scope, is the work actually shippable, and is the closeout truthful?

The goal is not to add a slow generic reviewer everywhere. The goal is to add the right quality gate at the right points, with a cheap mechanical checklist for normal work and heavier review only when risk signals justify it.

## Design Status

This item needs more design before implementation. Do not treat it as shovel-ready.

The likely implementation should be split after design into smaller stories, because this affects workflow semantics, orchestrator instructions, dashboard/operator expectations, and possibly red/test-engineer role boundaries.

Dependency note: the Shipping Reviewer must be able to run required verification commands in its own environment. FG-376 captures the prerequisite that reviewer/agent containers need real project dependencies in disposable worktrees; otherwise reviewer validation is only advisory and host/orchestrator verification remains the only authoritative gate.

## Goal

Define and implement a **Shipping Reviewer** quality gate with two responsibilities:

1. **Readiness preflight:** refuse or pause before starting implementation when the backlog item is not ready.
2. **Operational done gate:** refuse to report "shipped/done" until code, tests, backlog state, git state, pushed state, deferred scope, and latest operator intent have all been checked.

This should make "finished" mean operationally done, not merely "an agent produced a passing diff."

Success metric: after Forge says a normal item is shipped, a later human/Codex review should be clean most of the time. A useful target is 80-90% clean post-ship reviews for routine items.

## Proposed Workflow Shape

1. **Readiness preflight before implementation**
   - Check whether the backlog item is runnable.
   - If not runnable, stop and produce a refinement proposal.
   - Do not spend implementation tokens on vague or contradictory work.

2. **Implementation and focused validation**
   - Engineer/test-engineer remain responsible for code and tests.
   - Reds should be risk-triggered or narrowly scoped, not generic review theater.

3. **Shipping Reviewer at closeout**
   - Runs once before "done/shipped."
   - Checks acceptance criteria, latest operator instructions, git state, backlog state, pushed state, test results, and deferred scope.
   - Blocks closeout if the operational contract is not satisfied.

4. **Risk-triggered deeper review**
   - Invoke heavier red/security/architecture review only when risk signals fire.
   - Examples: lifecycle state machine, auth, git/worktree/merge, database schema, runtime/provider behavior, routing policy, dashboard data contracts, or broad multi-surface changes.

## Shipping Reviewer Role

The Shipping Reviewer is not a red agent and not a test engineer.

It should act like a combined product owner and tech lead:

- Product-owner view: does the work satisfy the backlog item and the latest human intent?
- Tech-lead view: is the change coherent, scoped, committed, tested, and shippable?
- Operator view: is the final report truthful about what happened, what was pushed, and what remains?

The reviewer should be checklist-driven and evidence-based. It should cite the acceptance criterion or operator instruction being checked. It should not re-solve the whole implementation unless the checklist exposes a risk.

Authority decision:

- The Shipping Reviewer is mandatory for all mutating work before Forge may report "shipped" or "done."
- Engineers may report implementation complete, test engineers may report validation passed, and reds may report no blocking findings; only the Shipping Reviewer can approve the operational "shipped/done" claim.
- Non-mutating research/advisory work may use a lighter closeout, but the final response must not imply code was shipped.

## Readiness Preflight Requirements

Before the orchestrator starts a backlog item, it must inspect the item and classify readiness.

Minimum runnable backlog item requirements:

- Clear problem statement.
- Clear goal or expected behavior.
- Concrete acceptance criteria.
- Known non-goals or explicit scope limits when the surrounding context is broad.
- Dependencies or blockers named when obvious.
- Latest operator instructions reconciled with the backlog text when the work was triggered from a conversation.

If the item is missing acceptance criteria or has contradictory scope, the orchestrator must pause and produce a refinement proposal instead of starting implementation.

Readiness outcomes:

- `ready`: implementation can start.
- `needs_refinement`: pause and propose backlog edits or questions.
- `blocked`: cannot proceed without human/external input.
- `exploratory`: allowed to start with lighter criteria because the item is explicitly a spike/research/idea.

## Operational Done Gate Requirements

Before reporting a task as shipped/done, the Shipping Reviewer must check:

- The implementation satisfies the backlog acceptance criteria.
- The implementation satisfies the latest operator handoff/instructions, not only the persisted backlog text.
- Required host verification commands pass. A mutating Forge run cannot report shipped/done if the required host verification command fails.
- Backlog state is correct and committed when the item is being closed.
- `git status` is clean except explicitly named unrelated files.
- All intended source, test, docs, and backlog changes are committed.
- Pushed status is reported when the orchestrator claims work was pushed.
- Any intentionally deferred scope is named and, when appropriate, linked to a follow-up backlog item.

Default verification contract:

- Run repo typecheck, if present.
- Run repo test suite, if present.
- Run package/workspace-specific tests for touched packages when the repo has a workspace/package split.
- For docs/backlog-only mutating work, verify git status, changed files, and any relevant lint/format/docs checks if present.
- If required verification is skipped, unavailable, or failing, the outcome is `needs_fix` unless the backlog item or human explicitly accepted the exception before closeout.

Done outcomes:

- `ship`: all required checks passed.
- `ship_with_named_deferrals`: allowed only when deferrals are explicit and accepted or filed.
- `needs_fix`: implementation or closeout is not done.
- `needs_human`: product/scope decision required.

## Red/Test Engineer Repositioning

This story should revisit how Forge uses test engineers and reds:

- Test engineer should prove behavior and regressions, not own product completeness.
- Test engineer output must be validated against the real project dependency graph; fake package shims, fake source modules, or dependency/tsconfig surgery to make tests pass are closeout blockers unless explicitly requested by the backlog item.
- Reds should be narrower and risk-triggered when possible.
- Generic red review should not be the main quality mechanism if it rarely finds useful issues.
- The Shipping Reviewer can decide whether heavier review is needed based on risk signals and changed surfaces.
- Findings should cite file/line and the violated acceptance criterion, operator instruction, or risk contract.

Open design question: should the Shipping Reviewer replace some low-value red passes for low-risk work, or simply run after them?

## Suggested Final Response Contract

When Forge says work is shipped, the response should include:

- ticket id and title;
- commit SHA(s);
- pushed/not-pushed status;
- test/typecheck summary;
- backlog status;
- explicit deferred scope, if any;
- whether the done audit passed.

## Risk Signals For Heavier Review

The Shipping Reviewer should escalate to deeper review when a change touches:

- task/run lifecycle or reconciliation;
- git/worktree/branch/merge/PR behavior;
- auth profiles, credential handling, or secret mounts;
- routing policy, RACI, model policy, runtime YAML, or provider selection;
- database schema or durable state;
- dashboard state that affects operator decisions;
- docs/operator surfaces for changed behavior;
- broad file surfaces or cross-module contracts;
- anything explicitly marked high-risk by the operator.

## Non-Goals

- Do not require every idea/backlog note to have full acceptance criteria.
- Do not block research/spike work from starting when it is explicitly marked as exploratory.
- Do not blindly add a heavyweight review agent to every phase.
- Do not require perfect acceptance criteria; require enough specificity to audit completion.
- Do not force humans to run CLI commands; missing readiness should be surfaced in orchestrator output and, later, the dashboard.
- Do not make the Shipping Reviewer a generic code reviewer without an operational checklist.

## Open Design Questions

- Is Shipping Reviewer a new workflow role, an orchestrator closeout mode, or a reusable command such as `forge done-audit`?
- How does it receive the latest operator instruction, especially when that instruction was conversational and not yet in the backlog item?
- Should it be mandatory for all mutating work, or only backlog-driven work?
- How should Forge distinguish mutating work from pure research/advisory work in mixed workflows?
- Which checks should be mechanical code, and which require an LLM reviewer?
- How does the reviewer distinguish accepted deferrals from missed scope?
- Should it be allowed to edit/refine the backlog item before implementation starts?
- How does this interact with future work queues/campaigns, where one blocked item should not stop unrelated queued work?
- What is the minimum useful dashboard surface for readiness/done audit results?

## Acceptance Criteria

Design acceptance for this story:

- Define the Shipping Reviewer role, authority, and boundaries.
- Define readiness preflight inputs, outputs, and failure modes.
- Define operational done gate inputs, outputs, and blocking checks.
- Decide which checks are mechanical and which require an LLM reviewer.
- Decide how latest operator instructions are captured or supplied to the reviewer.
- Decide how Shipping Reviewer interacts with test engineer and red agents.
- Decide whether implementation should be split into smaller follow-up stories.
- Include examples of "passes tests but not done" cases, including uncommitted backlog close state and missed conversational scope.
- Include examples of "tests were not valid" cases, including fake dependency shims and a full-suite failure hidden behind narrower green tests.

Future implementation acceptance should include:

- Orchestrator/start path detects a backlog item with no meaningful acceptance criteria and pauses with a refinement proposal.
- Orchestrator/start path can proceed when a backlog item has sufficient acceptance criteria.
- Final closeout checks git status and reports uncommitted intended changes as a blocker to "shipped."
- Final closeout blocks "shipped" when required host verification fails.
- Final closeout checks that backlog close/move state is committed when a ticket is being closed.
- Final closeout compares latest operator instructions against backlog acceptance criteria and flags unreconciled differences.
- Final response for a shipped item includes commit SHA, pushed status, test summary, backlog status, deferred scope, and audit outcome.
- Tests cover at least one "passes tests but not done" case, such as uncommitted backlog close state.
- Tests cover at least one "cannot ship because required host verification failed" case.
