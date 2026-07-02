---
id: FG-422
type: story
status: done
title: Forge workflow skills for campaign, deep review, backlog, and deep research
epic: FG-291
created: 2026-06-30
closed: 2026-07-02
closed_commit: 53784a4
---

## Problem

Forge repeatedly rediscovers stable operating procedures during agent runs. Examples:

- campaign runs start with "let me check the campaign CLI surface";
- landed-work review depends on the operator asking for a deep production-path review rather than a quick code skim;
- backlog reopen/follow-up discipline is repeated in prompts and easy to miss;
- pure research work needs a different output shape than implementation work.

This wastes agent time and leaves rigor dependent on ad hoc prompt wording.

## Goal

Create reusable Forge workflow skills that encode stable operating procedures, so the operator can say "use the campaign skill" or "use deep review" and get the expected workflow without re-explaining the process each time.

## Initial Skills

- **campaign** — ordered backlog campaign planning/execution with the current `forge campaign ...` command surface, plan inspection, approval, start/resume/report flow, stop conditions, and sequential/pilot guidance.
- **deep-review** — AC-first landed-work review that traces production paths, persistence, operator surfaces, and focused tests; this is not a quick diff skim.
- **backlog** — structured backlog conventions, reopen vs follow-up discipline, AC movement rules, closure evidence, and safe ticket edits.
- **deep-research** — source-grounded research and synthesis, with explicit Forge implications, alternatives, risks, and recommended backlog actions; no implementation unless explicitly requested.

## Acceptance Criteria

- Each skill has a clear trigger, scope, non-goals, and expected output.
- The campaign skill documents the current campaign CLI workflow and standard stop conditions:
  - resolve and show the plan before execution;
  - prefer sequential mode when items touch shared verification, worktree, reviewer, or campaign semantics;
  - stop/hold on stale plan, dependency ambiguity, or verification-policy ambiguity.
- The deep-review skill requires:
  - read ticket/problem/AC first;
  - inspect changed production paths, not only docs or tests;
  - trace end-to-end behavior such as collector → evaluator → persistence → renderer/operator surface;
  - verify command/API/operator paths enforce claimed decisions;
  - check tests cover the production path, not only mapper/helper logic;
  - report findings first, severity ordered, with file/line references.
- The backlog skill documents:
  - reopen vs follow-up rules;
  - do not defer acceptance criteria by closing and filing a vague follow-up;
  - if scope changes, create/move explicit AC to a named item;
  - preserve unrelated user/agent changes.
- The deep-research skill requires:
  - define the research question and decision needed;
  - use primary sources where practical;
  - compare alternatives and extract Forge-specific design implications;
  - distinguish fact from inference;
  - end with recommended backlog items or "no action."
- `CLAUDE.md` references the skills without duplicating their full procedures.
- Skills include freshness guidance: do not rediscover stable commands unless a command fails, the ticket is changing that surface, or local evidence contradicts the skill.

## Non-Goals

- Do not make every Forge workflow a skill in the first pass.
- Do not replace ticket-specific architect/tech-lead planning.
- Do not hide uncertainty; skills should name when fresh local inspection is still required.
- Do not duplicate the full contents of skills into `CLAUDE.md`.

## Relations

- Related to FG-421: Shipping Reviewer operator-contract review quality.
- Related to FG-417: production-path consistency tracing.
- Related to FG-370: Campaign Runner.
- Related to FG-372: Shipping Reviewer / done gate.
