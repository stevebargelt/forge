---
id: FG-592
type: story
status: done
title: "forge launch show: R4 human output overstates unknowable runtime resolution as fact"
created: 2026-07-19
closed: 2026-07-20
closed_commit: 2d54330
---

## Problem

FG-555 correctly stores R4 as `unknowable` when Forge cannot prove whether a non-Node command performs later runtime resolution. The human `forge launch show <id>` renderer overstates that evidence: for every non-Node command—including a native command such as `true`—it says the command “resolves node/npm/forge at runtime.” Forge only knows that later runtime resolution may occur; it does not know that it does occur.

The JSON/durable provenance remains conservative. The defect is limited to operator-facing wording and its existing assertion.

## Expected Behavior

Human R4 output must distinguish known fact from possibility. For an `unknowable` record, say that the command may perform later runtime resolution and that Forge cannot determine it at launch time. Do not state that a native command resolves Node as fact.

## Acceptance Criteria

- `forge launch show` renders R4 `unknowable` using evidence-honest modal wording such as “may resolve another runtime; not knowable at launch.”
- The renderer may use the stored R4 reason, but must not turn “may select” into “does resolve.”
- Existing JSON and persisted R3/R4 shapes are unchanged.
- Existing human-output assertion is updated to lock in the honest wording for a native `true` command and a caller-supplied shell/launcher.
- Focused tests pass, followed by the normal required CI checks.

## Scope

Small output-only correction plus its focused assertion. No runtime/toolchain behavior, schema, architecture pass, agent campaign, or red/review loop is required.

## Relation

Directly follows FG-555 / merged commit `21af80c`; it corrects the human rendering at `src/cli/commands/launch.ts` without reopening FG-555’s pinned-PATH-trust decision.
