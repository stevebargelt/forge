---
id: FG-340
type: story
status: done
title: "test-engineer seed: 'committed test files' wording makes the agent run git commit (partial/broken commits)"
created: 2026-06-21
closed: 2026-07-06
closed_commit: cc18d4f6f31fe4dadbe834171865ecdecb336c58
---

**Found:** 2026-06-21. Surfaced by the recurring "agents self-commit broken partial commits" pattern.

## Problem

The test-engineer seed's wording about "committed test files" (phrasing that implies the agent should produce *committed* test files) makes the containerized test-engineer run `git commit` itself. That is the wrong boundary: writing durable test files to the worktree is the agent's job, but committing/merging is orchestrator closeout that happens AFTER host verification and review. When the agent commits, it produces partial or broken commits — e.g. committing only the new test files, or committing against an unexpected index/worktree state — which the orchestrator then has to detect and unwind before it can commit cleanly. Implementers and fixers must not commit/close their own work; the seed wording nudges the test-engineer to violate that.

## Goal

Reword the test-engineer seed so the agent writes durable test files to the project/worktree and RETURNS them (reported in `test_files_written`) WITHOUT running `git commit`. Preserve the original intent that the tests are real, durable files committed to the repo — but by the orchestrator during closeout, not by the agent. Remove any wording the agent can read as an instruction (or license) to run git.

## Acceptance Criteria

- The test-engineer seed no longer contains "committed test files" or any wording that instructs or implies the agent should run `git commit`/`git add` or otherwise author a commit.
- The seed explicitly states the agent writes test files to the project/worktree and returns them (`test_files_written`); commit and merge are orchestrator closeout, not the agent's job.
- The anti-"one-shot report" intent of the original wording is preserved: the seed still requires real, durable test FILES on disk (not an ephemeral in-result report) that the orchestrator will commit.
- Verification: a test-engineer invoke leaves no git commit authored by the agent in the worktree (the working tree has the new/changed test files, but HEAD is unchanged by the agent).

## Notes

- Relates to the "agents may self-commit" pattern (container agents sometimes run `git commit`, producing broken partial commits — verify git status/log after every invoke) and the orchestrator-closeout rule (engineers/fixers must not close/move or commit their own implementation backlog item).
- Scope: small, isolated to the test-engineer seed prose (`seeds/agents/test-engineer/`). Docs/seed-prose change (documentation-maintainer lane); no source code.
