---
id: FG-83
type: story
status: done
title: "PROMPT.md template: count existing PNGs, use max+1 as starting number"
---

**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — seed-only change, no test deltas).
- `seeds/agents/prompt-author/templates/ui-design.md`: new PRECONDITION 2 step counts existing PNGs in `{{output_dir}}` (using `ls *.png | wc -l`), sets `START_NUM` accordingly. Step 6 (PNG NAMING) updated to use `$(printf "%02d" $START_NUM)` etc. instead of hardcoded 01/02. Empty/non-existent directory → `START_NUM=1` → numbering starts at `01-` as before.
- `{{file_naming_list}}` is now a list of suggested screen names, not a list of literal filenames — the prefix is computed at run time from the corpus state.
- Reinstalled via `FORCE=1 scripts/install-seeds.sh`. Active in `~/.forge/agents/prompt-author/templates/`.
- Unblocks shared-corpus reuse (#67) where prior runs already produced PNGs 01-N. Without this, the template hardcoded 01 and would clobber.
- Long-term fix (#80) still pending — prompt-author should mount designDir read-only and bake the start number into PROMPT.md at author time. Different code path; this template-level fix ships value now.