---
id: FG-518
type: story
status: active
title: "notify: resume-probe workflow-load-failure park pushes stale gate context — update blockerKind/action + real-path regression (FG-516 fail-safe deferral)"
created: 2026-07-10
---

Fail-safe follow-up from FG-516's review-loop (run run-review-loop-fg-516-ea61aa): the resume liveness probe's workflow-load-failure park (src/campaign/executor.ts:~1099) fires its FG-516 milestone WITHOUT updating the item's blockerKind/requestedHumanAction to describe the new failure. The path is entered for an awaiting_gate item with no blockerKind, so the pushed notification retains the item's OLD gate action instead of explaining the YAML/load failure.

Why deferred rather than fixed in FG-516 (disposition per the review-disposition policy): the notification FIRES — the operator learns of the park, with campaign+ticket in the title and a dedupe-stable key — but its guidance text is imprecise for this one park shape. No wrong-ship, data-loss, or trust surface; pure message-precision friction. FG-516's core deliverable (no silent unattended wedge) holds on this path.

Acceptance:
- [ ] the resume-probe workflow-load-failure park updates the item (or composes at notify time) with a blockerKind and requestedHumanAction that name the workflow-load failure (workflow name + reason + "fix the workflow YAML, then forge campaign resume"), consistent with how the other load-failure park (driveWorkflowItem's YAML-missing site) reports it
- [ ] regression test through the REAL resume path (liveness probe entering the load-failure branch) asserting the pushed milestone carries the load-failure context, not a stale gate action

**Scope note (2026-07-10, FG-516 fixer audit):** this ticket covers BOTH structurally-identical workflow-load-failure parks — the resume liveness-probe site (executor.ts:~1056) AND its reattach-path twin (executor.ts:~1192). Both are marked `{ exemption: "known-gap", ticket: "FG-518" }` in the typed ParkContext at the call site; fixing one without the other would reintroduce the stale-context complaint on the twin.
