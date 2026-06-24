---
id: FG-384
type: story
status: active
title: "LLM Shipping Reviewer role for acceptance review"
epic: FG-372
created: 2026-06-23
---

## Problem

Mechanical checks can prove the work is committed, tested, and not obviously dirty. They cannot reliably judge whether the implementation satisfies the accepted intent, latest operator instruction, and operational definition of done.

## Goal

Create the LLM Shipping Reviewer role: a product-owner plus tech-lead acceptance reviewer that uses the Reviewer Context Packet and done-audit evidence to approve or block shipped/done.

## Acceptance Criteria

- Define the Shipping Reviewer prompt/seed and role boundaries.
- Reviewer consumes the Reviewer Context Packet before inspecting the diff.
- Reviewer findings cite the violated acceptance criterion, operator instruction, design decision, or risk invariant.
- Reviewer checks the implementation against backlog acceptance criteria and latest operator intent.
- Reviewer inspects nearby production paths, not only touched lines, when acceptance depends on workflow behavior.
- Reviewer inspects tests for coverage of the ask and canonical production paths.
- Reviewer can return `ship`, `ship_with_named_deferrals`, `needs_fix`, or `needs_human`.
- Reviewer does not replace engineer or test-engineer responsibilities.
- Tests or golden fixtures cover "green tests but wrong canonical path" and "clean diff but missed operator instruction."

## Non-Goals

- Do not make the reviewer a generic style reviewer.
- Do not run expensive deep review for every low-risk change unless risk signals require it.
- Do not implement the red-selection planner here.

## Relations

- Child of FG-372.
- Depends on or should follow FG-381.
- Uses mechanical results from FG-383 when available.

