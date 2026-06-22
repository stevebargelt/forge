# Refactor: workflow + phase naming for clarity

**Status:** proposed
**Date:** 2026-05-08
**Author:** Steven (with Claude Opus 4.7)
**Scope:** workflow names, phase names, modal copy, BACKLOG references
**Branch:** `new-run-modal-66` (continues; this refactor merges in the same branch)

---

## Problem

Two distinct concepts collapse into the word "design" today, and one phase name is genuinely ambiguous:

1. **"design" means two things.** "System/architecture design" (decisions, components, interfaces — produced by the `architect` agent) AND "UX/visual design" (screens, components, .pen + PNG — produced via the `prompt-author`-led Pencil flow). Same word, completely different artifacts. Workflow names like `feature-design-needed` and `feature-design-provided` don't disambiguate, so the modal forces the user to read descriptions to figure out which "design" each handles.
2. **`frame` is too generic.** The phase name `frame` (in the `investigation` workflow) reads ambiguously in the dashboard — UI frame? Container frame? Time frame? Without upstream context the user has to guess.
3. **Architecture review is universal but the workflow names imply it's optional.** Steven's expectation (2026-05-08): every feature flow goes through architecture review, regardless of whether UI design is involved. Today's `feature-design-provided` skips the architect phase, which is wrong by that model.

## Goals

- Workflow names disambiguate "ui-design" vs "system architecture" by qualifier.
- New `feature` workflow for non-UI work (CLI features, APIs, libraries, internal refactors). This is what most of today's `feature-design-needed` actually is.
- All `feature*` workflows include the architecture phase.
- One phase name disambiguation: `frame` → `frame-question`.
- Existing runs in the DB continue to work (backward-compatible migration).
- BACKLOG / docs / ADRs reference the new names; old refs in commit messages stay (history doesn't get rewritten).

## Non-goals

- Renaming agents (`framer`, `architect`, `planner`, `implementer`, `verifier`, etc. — these are fine).
- Renaming other phases (`investigate`, `synthesize`, `recommend`, `scope`, `assess`, `report`, `architect`, `plan`, `build`, `verify`, `brief`, `review` — all clear in context).
- Composing the new `feature-ui-design-needed` workflow with a real ui-design phase chained into architect → plan → build → verify. **That's a separate task** (call it #71 or whatever's next). This refactor establishes the *names* and does light shape adjustments; the composed workflow is a follow-up.

## New taxonomy

| Workflow | Today | New |
|---|---|---|
| Feature work, no UI | `feature-design-needed` | `feature` |
| Feature work, UI to be designed | (doesn't exist; conflated with above) | `feature-ui-design-needed` (composed; deferred to follow-up — for v1 this name is registered but the workflow file points at the same shape as `feature` until the compose work lands) |
| Feature work, UI already designed | `feature-design-provided` | `feature-ui-design-provided` |
| Standalone UI design | `ui-design` | `ui-design` (unchanged) |
| Revise an existing UI design | `design-revise` | `ui-design-revise` |
| Investigate a question | `investigation` | `investigation` (unchanged) |
| Codebase assessment | `codebase-assessment` | `codebase-assessment` (unchanged) |

**Architecture phase becomes universal across `feature*`.** Today's `feature-design-provided` skips `architect` directly into `plan`. New behavior: `feature-ui-design-provided` adds an `architect` phase at the start (taking the supplied PRD as input), then `plan` → `build` → `verify`.

| Phase rename | From | To |
|---|---|---|
| Investigation question-framing phase | `frame` | `frame-question` |

## Migration

### What stays compatible

- Existing runs in `forge.db` reference workflow names + phase names as TEXT columns. They keep working as long as the workflow files keep registering their old names somewhere reachable.
- Commit messages, ADRs, and BACKLOG entries that reference old names stay readable in history; new refs use new names.

### What changes

- **`WorkflowName` union** in `src/types/index.ts` — add `feature`, `feature-ui-design-needed`, `feature-ui-design-provided`, `ui-design-revise`. Keep `feature-design-needed`, `feature-design-provided`, `design-revise` for one release as **deprecated aliases** (the workflow loader resolves them to the new names) so existing runs don't crash.
- **Workflow files** — rename `feature-design-needed.ts` → `feature.ts`. Rename `feature-design-provided.ts` → `feature-ui-design-provided.ts`. Rename `design-revise.ts` → `ui-design-revise.ts`. Add new file `feature-ui-design-needed.ts` (initially registers the workflow at the same shape as `feature.ts`; composed shape lands in the follow-up task).
- **Workflow loader** (`src/v2/loader.ts`) — `loadWorkflow(name)` looks up the new name first; if not found, checks an alias map (`feature-design-needed` → `feature`, `feature-design-provided` → `feature-ui-design-provided`, `design-revise` → `ui-design-revise`). Existing run rows resolve through the alias map without breaking.
- **`feature-ui-design-provided` adds the architect phase.** Today the workflow goes plan → build → verify. New: architect → plan → build → verify. Existing runs still in the old plan-first shape are preserved by the alias resolution (they used the old workflow file's shape; the loader resolves the alias to a *frozen-historical* file or just keeps the old shape under the old name).
  - **Decision needed**: do existing `feature-design-provided` runs migrate to the new architect-first shape on next dispatch (breaking — phases don't match), or stay on the legacy shape forever (compatible but means we maintain two files)? Lean toward **stay on legacy shape for in-flight runs only**; brand-new runs of the new name get the architect phase. We delete the legacy `feature-design-provided.ts` file once no active runs reference it. (BACKLOG item to track its deletion.)
- **Phase rename `frame` → `frame-question`.** This is harder than workflow rename — phase names live in `tasks.phase` rows. Two options:
  1. **In-place data migration**: SQL UPDATE existing rows. Cheap (one statement), irreversible.
  2. **Alias in code**: workflow's `findPhase` looks up new name first, falls back to old. Less invasive but the dashboard then renders historical rows with the old name and new rows with the new name — confusing.
  - Option 1 wins. Migration runs at next forge process startup; idempotent.
- **Modal copy** — `src/dashboard/workflowSchema.ts`: descriptions updated to use the new names + accurate phase descriptions.
- **Tests** — anywhere that hardcodes old workflow names gets updated.
- **BACKLOG.md** — rewritten references where they refer to the new taxonomy. Old commit messages in git history stay as-is.
- **CLAUDE.md** — workflow list updated.
- **ADRs that reference old names** — leave history alone; add a one-line "see refactor-2026-05-08-workflow-naming.md" pointer if the reference is load-bearing.

### Migration timeline

- This refactor lands as one commit on `new-run-modal-66`.
- Next branch (or same branch, separate commit): the composed `feature-ui-design-needed` workflow shape (real chained phases). That's the follow-up.
- Old workflow names work as aliases for one further release after this one. Then they get removed and the legacy workflow files deleted.

## Implementation order (concrete)

1. **Types**: extend `WorkflowName` union with new names; keep old names for now.
2. **Workflow files**: rename + add new file. Update internal `name:` fields. Verify each loads.
3. **Workflow loader**: `loadWorkflow` accepts old + new names via the alias map.
4. **Phase rename**: in `investigation.ts` change `name: "frame"` → `name: "frame-question"`. Update `_agentRefs.ts` if it references the phase by name (probably doesn't).
5. **Phase data migration**: add a small migration step that runs on first forge process startup after the rename: `UPDATE tasks SET phase = 'frame-question' WHERE phase = 'frame' AND ... `. Idempotent; runs once.
6. **`feature-ui-design-provided` architect phase**: add the new phase at the front of the workflow file. Existing runs stay on the legacy file via alias resolution.
7. **Dashboard schema**: `workflowSchema.ts` descriptions updated; field maps unchanged (the new workflows take the same set of fields as the old).
8. **Modal grouping (optional)**: group workflows in the picker — "Build features" and "Design UI" and "Investigate / Audit" — with a small header. Cheap once the names are right.
9. **Tests**: any test referencing `feature-design-needed` / `feature-design-provided` / `design-revise` / `frame` updates.
10. **BACKLOG + CLAUDE.md** edits.

## Open questions

1. **Should the composed `feature-ui-design-needed` workflow be a single run with phases [`brief`, `review`, `architect`, `plan`, `build`, `verify`], or two linked runs (one ui-design, one feature)?** Single run is more cohesive; two runs gives clean separation but creates orchestration friction (humans gating across runs). Lean toward single run. (Decision deferred to the follow-up task.)
2. **Does `feature-ui-design-provided` accept a `.pen` path *or* a PNG path *or* a PRD?** Today's `--prd` flag is generic. The architect agent should accept whatever's in `inputs.prd` and adapt — no schema change needed at this layer. (Decision: leave `--prd` as-is; it's a path to whatever the design doc is, .pen or PRD or PNG dir.)
3. **Should the rename break in-flight runs?** No — that's the whole point of the alias map. Verify with a real test (a `forge next` against an existing investigation run after the rename should resolve `frame` via alias and still work).

## Risks

- **Breaking existing runs.** Mitigated by alias map + phase data migration. Test with a real existing run.
- **Confusion during the transition.** Both names appear briefly in code (old workflow files still imported by the alias map). One commit, clearly labeled, minimizes the window.
- **The `--prd` flag name doesn't match the new taxonomy.** It says "PRD" but the new workflows accept design artifacts too. Fine for now; rename to `--design-doc` or similar in a future cleanup if it becomes confusing.

## Validation

- All 199 existing tests pass after the refactor.
- `forge new feature "test" --project /tmp` creates a run with the new workflow name.
- `forge new feature-design-needed "test" --project /tmp` works (alias-resolves to `feature`) and prints a deprecation note.
- An existing `investigation` run with a `frame` phase task still loads in `forge status` after the migration runs.
- Dashboard modal shows the new workflow names with correct descriptions.

## Out-of-scope cleanups (capture as BACKLOG items)

- Compose `feature-ui-design-needed` to actually chain ui-design + feature phases (#71? — pending number).
- Delete legacy workflow files once no active runs reference them (#72? — pending; tracked in this doc's "Migration timeline").
- Phase grouping in the dashboard modal (#73? — small UX polish, optional).
