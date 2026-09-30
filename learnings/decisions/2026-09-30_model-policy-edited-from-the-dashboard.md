# Decision: model policy edited from the dashboard through the CLI gate

**ID**: FORGE-DEC-038
**Date**: 2026-09-30
**Status**: Decided
**Decided by**: forge (FG-835 part 2b)
**Supersedes**: N/A — EXTENDS FORGE-DEC-037 (dashboard-confirmed governance writes) from the project RACI to `model-policy.yml`
**Scope**: forge
**Elevated from**: N/A

---

## Context

FG-835 part 1 gave `model-policy.yml` its first write path: `forge model policy propose|apply`, a gate that validates a candidate, resolves every installed role × activity against the policy in force and the candidate, and on `apply --confirm` replaces the file atomically with a backup and a JSONL audit line. Part 2a added the dashboard's two registry rows (`POST /api/model-policy/propose|apply`) and the read (`GET /api/model-policy`), with the same server-side pre-spawn preconditions FORGE-DEC-037 set for RACI. Part 2b puts an editor in front of them.

## Decision

1. **A new Setup › Models page (`#models`), not an editable Config.** Config stays the read-only control-plane panel; its Model policy row links to Models. The editor is `#models?mode=edit`, and `?target=host|project` picks the file an apply replaces (omitted: the scoped project's override when it has one, else the host file). Nothing is stored in the browser; a reload reopens the editor on the policy in force.
2. **The FG-834 machine, reused, not a second one.** `raci-editor-state.js` gained a gate adapter (`settleDryRun`/`settlePropose` take the gate's verdict/findings/green shape) and a key noun for `applyReadiness`; `raci-editor-view.js` exports its code editor, findings list, pill and typed-confirmation APPLY card. `models-editor-state.js` holds only what differs: the model-policy findings (placed by line from the gate's own messages, a schema failure split per Zod issue), the target, the resolution tables, and quick edit.
3. **Quick edit is a one-line text edit, never a re-serialisation.** A small indentation scanner reads the draft's profiles, map entries and role overrides and rewrites one scalar or line in place, so comments, key order and keys the client does not know survive. A shape it cannot place (a non-empty flow `agents: {…}`) is reported and left to the editor. The YAML in the editor stays the source of truth.
4. **Restore… is a propose, never a file copy.** `GET /api/model-policy` now returns each backup's bytes (when no larger than a candidate may be) and the model ids the current generation's runtime seeds name (the picker); no route was added. Restore loads a backup as the candidate and proposes it; applying it is the ordinary typed-target apply.
5. **The CLI gate and the dashboard's preconditions are stated separately** (invariants 7 and 15): a terminal `apply --confirm` re-runs the gate in one invocation with an optional `--rationale`; the dashboard additionally requires a green propose of identical bytes for the same target, the typed target and a rationale, and never passes `--allow-undispatchable`.

## Consequences

- An operator can change a profile's model or pin a role from the browser and see every role × activity's resolution change before anything is written; the refusal of an undispatchable candidate is shown as the CLI words it, and accepting one remains a terminal decision.
- The GET payload grows by the backups' text (bounded: at most 50 backups × 64 KiB). It is read on page open and after an apply, never polled.
- A second editor shares the FG-834 classes and machine; a change to that machine now has two callers, pinned by `dashboard/src/fg834-raci-editor.test.ts` and `dashboard/src/fg835-models-editor.test.ts`.

## Revisit Conditions

- The policy grows a shape the outline scanner cannot place often enough that quick edit is routinely unavailable — then parse with a vendored YAML CST library rather than widening the scanner.
- Backups routinely approach the size bound — then serve a backup's bytes on demand instead of in the read.
