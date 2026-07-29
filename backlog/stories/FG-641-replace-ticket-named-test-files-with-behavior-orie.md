---
id: FG-641
type: story
status: active
title: Replace ticket-named test files with behavior-oriented test organization
created: 2026-07-29
---

## Problem

Forge has accumulated 199 ticket-named test files out of 406 test files (measured 2026-07-28), including names such as `fg425-publication-cas.worktree.test.ts`. This is an emergent convention from ticket-driven agent work, not an intentional TypeScript testing standard.

The ticket ID provides acceptance-evidence traceability, but at this scale the suite is organized by implementation history instead of behavior. Related coverage is scattered, fixture/setup code is duplicated, closed ticket numbers become permanent architecture vocabulary, and each change is encouraged to add another isolated file instead of strengthening a canonical subsystem suite.

This is test-architecture debt, not a request to delete behavioral coverage.

## Goal

Adopt behavior-oriented test organization and perform a bounded consolidation of the existing ticket-named suite without weakening coverage or acceptance-evidence traceability.

## Intended convention

- Test filenames describe the production subsystem or behavior, for example `integration-publisher.worktree.test.ts`.
- Individual test names describe the invariant or scenario.
- The originating FG ticket may remain in a test name or nearby comment when it adds useful provenance.
- Backlog acceptance evidence cites the durable test name/path; the filename does not need to equal the ticket ID.
- A ticket-named file is allowed only for a genuine cross-layer capstone/acceptance harness, with the reason recorded.
- New implementation work extends the appropriate canonical subsystem suite instead of creating a new `fgNNN-*` file by default.

## Scope

1. Document and enforce the naming/placement convention in the testing guidance and agent instructions that create implementation plans or tests.
2. Inventory all ticket-named test files by subsystem, identifying duplicate fixtures, overlapping scenarios, and genuine capstone exceptions.
3. Define a staged cleanup plan ordered by highest duplication and maintenance cost; do not attempt a blind mass rename.
4. Consolidate existing ticket-named files into behavior-oriented subsystem suites in bounded batches.
5. Preserve useful FG provenance in test names/comments and update durable references when paths change.
6. Keep test-tier placement and CI coverage unchanged unless a separately justified correction is required.

## Out of scope

- Deleting tests merely because they are old or ticket-named.
- Reducing behavioral, regression, mutation, platform, or acceptance coverage.
- Rewriting the test runner or CI topology.
- One enormous repository-wide rename with no subsystem review.

## Acceptance criteria

- A documented convention makes behavior-oriented filenames the default and defines the narrow capstone exception.
- The implementation/test-agent guidance no longer encourages one new test file per backlog ticket.
- An inventory accounts for every current `fgNNN-*` test file, assigning it to a subsystem consolidation batch or a justified capstone exception.
- At least the first high-value subsystem batch is consolidated, including shared fixture extraction where duplication is demonstrated.
- Pre/post test manifests demonstrate that no test cases silently disappear; intentional deduplication maps removed duplicates to the surviving invariant coverage.
- Backlog/docs references to moved tests are updated or replaced with stable behavior/test-name references.
- Unit, integration, worktree, and dashboard test tiers retain their required coverage and all required CI checks are green.
- The cleanup can continue incrementally in later bounded batches without requiring this ticket to absorb unrelated product changes.
