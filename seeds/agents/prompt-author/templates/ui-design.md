⚠️ READ THIS FIRST (the human running the prompt, not the model):

**Run this PROMPT.md in a fresh Claude Code session.** Type `/clear` or open a new terminal — do NOT paste it into a session that's already mid-task. Multi-screen Pencil prompts are long-running and benefit from full context budget at the start. If the session compacts mid-run with stale context, the model can silently drop later screens and end-of-prompt actions (verified empirically, 2026-05-08).

If a run does fall short (screens missing, end-actions skipped), do not re-paste fragments into the same session — start a new session and re-run from the missing point with explicit "we already designed N-M, continue with the rest" framing.

---

{{brief}}

WORKFLOW REQUIREMENTS (must follow):

PRECONDITION 0 — VERIFY PENCIL MCP TOOLS ARE AVAILABLE BEFORE DOING ANYTHING ELSE.

This prompt requires the Pencil MCP server. The tools you need (`mcp__pencil__open_document`, `mcp__pencil__find_empty_space_on_canvas`, `mcp__pencil__export_nodes`, etc.) come from a Pencil MCP server that must be connected before you start. If those tools are NOT in your tool list:

1. **STOP.** Do not start designing. Do not write HTML files as a fallback — the human asked for Pencil designs (.pen + PNG), not arbitrary HTML.
2. Tell the human, in your own words: "The Pencil MCP server is not connected — I don't see `mcp__pencil__*` tools in this session. Reconnect Pencil's MCP and tell me to retry, or rerun this prompt in a session where it's connected." If you can list the MCP servers you DO see, mention them so the human knows what's connected vs missing.
3. Wait for the human to fix it. Re-check tool availability when they tell you to retry.

This is non-negotiable. Producing HTML-only output here is a failure mode — it pollutes `{{output_dir}}` with the wrong artifact type and the run can't be submitted (forge submit validates both .pen and PNG presence). Refuse and wait, don't improvise.

PRECONDITION 1 — before any MCP tool call, run this Bash:

    mkdir -p {{output_dir_parent}}
    if [ ! -s "{{target_pen_file}}" ]; then
      touch "{{target_pen_file}}"
      echo "Created empty {{target_pen_file}}"
    else
      echo "Reusing existing {{target_pen_file}} ($(stat -f%z "{{target_pen_file}}") bytes) — DO NOT touch, you'd zero it out"
    fi

This guarantees the target file exists on disk so open_document can route to it. **Critical:** skip the `touch` when the file already exists with content — `touch` doesn't zero a file, but a misplaced `> {{target_pen_file}}` or stale shell template would. The `-s` check (file exists AND non-empty) is the guard.

PRECONDITION 2 — count existing PNGs and pick a starting screen number (#83). Some runs reuse a shared design corpus (#67) where prior runs already produced PNGs 01-N; if you start numbering at 01 you'll clobber them. Run this Bash next:

    EXISTING_COUNT=$(ls {{output_dir}}/*.png 2>/dev/null | wc -l | tr -d ' ')
    START_NUM=$((EXISTING_COUNT + 1))
    echo "Existing PNGs in {{output_dir}}: $EXISTING_COUNT. Starting new screens at $START_NUM."

Use `$START_NUM` (and `$((START_NUM + 1))`, `$((START_NUM + 2))`, etc.) as the numeric prefix when renaming PNGs in step 6. Format with `printf "%02d"` for two-digit zero-padded names, e.g. `$(printf "%02d" $START_NUM)-<screen-name>.png`.

If `{{output_dir}}` is empty or doesn't exist yet, START_NUM = 1 and numbering starts at `01-` as before.

1. Target file: {{target_pen_file}}
2. FIRST MCP call (after the touch): mcp__pencil__open_document({ path: "{{target_pen_file}}" }). Then call mcp__pencil__get_editor_state and confirm the active editor is the right file — NOT pencil-new.pen. If it's wrong, STOP and report the issue rather than proceeding.
3. Pass filePath: "{{target_pen_file}}" explicitly on every MCP call. Do not rely on the active-editor fallback.
4. CANVAS LAYOUT: Place each top-level screen frame in its own region of the canvas — do NOT stack them at (0,0). Before inserting a new top-level screen frame, call mcp__pencil__find_empty_space_on_canvas to find a non-overlapping position, and use the returned x/y on the frame. Same for the component library frame. Screens and components should sit side-by-side or in a grid, all visible simultaneously when the user opens the .pen.
5. After completing each screen, export it: mcp__pencil__export_nodes({ filePath: "{{target_pen_file}}", nodeIds: ["<screen-root-node-id>"], outputDir: "{{output_dir}}" }). A screen is not complete until BOTH the .pen entry exists AND the PNG export has run.
6. PNG NAMING: export_nodes derives filenames from node IDs (e.g. "bxvfa.png"), which is unhelpful. Immediately after each export, rename the PNG with Bash to a descriptive ordered name using the START_NUM you computed in PRECONDITION 2.

   For each screen in order, use:
   - 1st new screen: `$(printf "%02d" $START_NUM)-<screen-name>.png`
   - 2nd new screen: `$(printf "%02d" $((START_NUM + 1)))-<screen-name>.png`
   - 3rd new screen: `$(printf "%02d" $((START_NUM + 2)))-<screen-name>.png`
   - …continue incrementing.

   Suggested screen names (in order):
{{file_naming_list}}
   Example: if START_NUM=21, the first new screen rename is `mv {{output_dir}}/<returned-id>.png {{output_dir}}/21-<screen-name>.png` (or `01-<screen-name>.png` if the corpus is empty and START_NUM=1).

6a. PER-SCREEN HANDLING (#86/#87) — for each screen above, follow the rule below. Do NOT redraw an existing component just to add an annotation to it; do NOT add a new screen if modifying in place is honest.

{{per_screen_handling}}

   Quick reference for the three modes:
   - **NEW** — full mockup as today. Place the frame in empty canvas space via `find_empty_space_on_canvas`.
   - **ADDITION** — the named existing component (e.g. `05-task-detail-gate`) is the canonical version; design ONLY the addition (annotation, callout, single new element) as a small focused frame. When picking canvas position, call `find_empty_space_on_canvas` with hints that put the new frame NEAR the existing one (so anyone opening the .pen reads "23-X is the evolved version of 05-X" from spatial proximity, not from filename archeology). Do not redraw the full component.
   - **MODIFY-IN-PLACE** — open the existing screen's frame on the canvas, edit it directly, re-export with the SAME numeric prefix (overwriting the old PNG). Git history (the corpus is in the project repo) is the audit trail; modify-in-place keeps the corpus to one canonical version per component.
7. CRITICAL — TARGET .PEN PERSISTENCE: Pencil's MCP tools update an in-memory document keyed by the filePath, but `.pen` files are NOT auto-saved to disk. The PNG exports DO write to disk reliably. The `.pen` source file ONLY persists when the human presses Cmd+S in VS Code.

   **Mid-run saves (#80).** End-of-run save reminders alone are too late — Pencil sessions are known to crash mid-design (verified 2026-05-08, crash between screens 24 and 26 of a 26-screen run). After EVERY TWO screens you complete and export, pause and tell the human, in your output: "💾 SAVE: please switch to VS Code and press Cmd+S on `{{target_pen_basename}}` — I'll wait for confirmation before continuing." Then literally stop and wait for the human to reply "saved" (or equivalent) before doing the next pair. This is friction by design — losing 5 screens to a crash costs vastly more than 5 save pauses.

   Verify the file is non-empty at the end by running `stat -f%z {{target_pen_file}}` — if it returns 0, the file is empty and the design source is unsaved.

8. FINAL SUMMARY — your last message must include this exact block, formatted as bold/highlighted so the user cannot miss it:

   ⚠️ CRITICAL: SAVE {{target_pen_basename}} NOW

   I cannot save the .pen file from MCP — only you can.
   - In VS Code: switch to the {{target_pen_basename}} tab (it may show as unsaved/dirty)
   - Press Cmd+S
   - If you don't see a {{target_pen_basename}} tab, open it: Cmd+P → type "{{target_pen_basename}}" → enter, then Cmd+S
   - Verify on disk: `stat -f%z {{target_pen_file}}` should return a number > 100000, NOT 0

   If you skip this step, the design source is lost when you close VS Code. The PNG exports survive (they're already on disk), but you won't be able to revise the design without re-running the whole prompt.

9. After your work and BEFORE writing the final summary, run this verification yourself:
   stat -f%z {{target_pen_file}}
   ls {{output_dir}}/
   Include both outputs in your summary so the user can see exactly what's on disk vs in-memory.

10. OPTIONAL — HTML/CSS code export. After all screens are designed and PNGs exported, also produce HTML+CSS reference snapshots — one .html (and a sibling .css if it makes sense) per top-level screen frame. Write the files into `{{code_export_dir}}` (a peer of `{{output_dir}}`, NOT a subdirectory of it). Default convention: if PNGs go to `<project>/designs/`, HTML goes to `<project>/code/`. Match the same numeric-prefix naming as the PNGs (`01-<screen-name>.html`, `02-<screen-name>.html`, etc).

   This step is OPTIONAL — skip the entire section if `{{include_code_export}}` is false, or if the human indicated they don't want code export.

   What we want from the output:
   - **Pure HTML + CSS, no frameworks.** No Tailwind, no Bootstrap, no React/JSX, no preprocessor — just `.html` and `.css`. The point is to read spacing, palette, and structure directly, not chase a framework's classes.
   - **Self-contained.** Each .html should open in a browser and render correctly with no external runtime dependencies beyond webfonts.
   - **Design tokens preserved as CSS variables.** The .pen file's `variables` block (`--accent`, `--background`, `--foreground`, etc.) is the most valuable artifact here. The HTML should declare those names in `:root { ... }` and reference them via `var(--name)`, not hardcoded hex values. If the default export hardcodes hex, fix it before writing.
   - **Semantic where reasonable.** Prefer `<header>`, `<aside>`, `<section>`, `<button>`, `<input>` over walls of `<div class="frame">`. Flexbox/grid layout, not `position: absolute` everywhere.
   - **One file per screen.** Don't bundle multiple screens into a single mega-document.

   After the first screen is exported, smoke-test it: `cat` the file, check it's roughly 200-1000 lines (not a stub or an absolute-positioning blob), confirm the CSS variables survived, and report a short excerpt in your progress notes before continuing with the rest. If the first export is unusable, stop and report — don't generate the others.

   If the available tooling can't produce something matching the spec above, skip cleanly: write `{{code_export_dir}}/SKIPPED.md` with the reason and continue without blocking the rest of the work.

   Treat the HTML files as REFERENCE, not implementation. State this in your final summary: "These HTML files are static reference exports — they show exact spacing, palette, DOM hierarchy. They are not wired to data, won't match the target stack's idioms, and aren't meant to be served. Useful as high-fidelity ground truth when implementing the screens in the real codebase later."

{{constraints_section}}
