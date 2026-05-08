{{brief}}

WORKFLOW REQUIREMENTS (must follow):

PRECONDITION — before any MCP tool call, run this Bash:
mkdir -p {{output_dir_parent}} && touch {{target_pen_file}}
This guarantees the target file exists on disk so open_document can route to it.

1. Target file: {{target_pen_file}}
2. FIRST MCP call (after the touch): mcp__pencil__open_document({ path: "{{target_pen_file}}" }). Then call mcp__pencil__get_editor_state and confirm the active editor is the right file — NOT pencil-new.pen. If it's wrong, STOP and report the issue rather than proceeding.
3. Pass filePath: "{{target_pen_file}}" explicitly on every MCP call. Do not rely on the active-editor fallback.
4. CANVAS LAYOUT: Place each top-level screen frame in its own region of the canvas — do NOT stack them at (0,0). Before inserting a new top-level screen frame, call mcp__pencil__find_empty_space_on_canvas to find a non-overlapping position, and use the returned x/y on the frame. Same for the component library frame. Screens and components should sit side-by-side or in a grid, all visible simultaneously when the user opens the .pen.
5. After completing each screen, export it: mcp__pencil__export_nodes({ filePath: "{{target_pen_file}}", nodeIds: ["<screen-root-node-id>"], outputDir: "{{output_dir}}" }). A screen is not complete until BOTH the .pen entry exists AND the PNG export has run.
6. PNG NAMING: export_nodes derives filenames from node IDs (e.g. "bxvfa.png"), which is unhelpful. Immediately after each export, rename the PNG with Bash to a descriptive ordered name. Use these exact filenames:
{{file_naming_list}}
   The numeric prefix keeps them sorted by screen order. Example: `mv {{output_dir}}/<returned-id>.png {{output_dir}}/01-<screen-name>.png`
7. CRITICAL — TARGET .PEN PERSISTENCE: Pencil's MCP tools update an in-memory document keyed by the filePath, but `.pen` files are NOT auto-saved to disk. The PNG exports DO write to disk reliably. The `.pen` source file ONLY persists when the human presses Cmd+S in VS Code. Verify this yourself at the end by running `stat -f%z {{target_pen_file}}` — if it returns 0, the file is empty and the design source is unsaved.

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

10. OPTIONAL — HTML/CSS code export. After all screens are designed and PNGs exported, also produce HTML+CSS reference snapshots — one .html (and a sibling .css if it makes sense) per top-level screen frame. Output to `{{output_dir}}/code/`, matching the same numeric-prefix naming as the PNGs (`01-<screen-name>.html`, etc).

   This step is OPTIONAL — skip the entire section if `{{include_code_export}}` is false, or if the human indicated they don't want code export.

   What we want from the output:
   - **Pure HTML + CSS, no frameworks.** No Tailwind, no Bootstrap, no React/JSX, no preprocessor — just `.html` and `.css`. The point is to read spacing, palette, and structure directly, not chase a framework's classes.
   - **Self-contained.** Each .html should open in a browser and render correctly with no external runtime dependencies beyond webfonts.
   - **Design tokens preserved as CSS variables.** The .pen file's `variables` block (`--accent`, `--background`, `--foreground`, etc.) is the most valuable artifact here. The HTML should declare those names in `:root { ... }` and reference them via `var(--name)`, not hardcoded hex values. If the default export hardcodes hex, fix it before writing.
   - **Semantic where reasonable.** Prefer `<header>`, `<aside>`, `<section>`, `<button>`, `<input>` over walls of `<div class="frame">`. Flexbox/grid layout, not `position: absolute` everywhere.
   - **One file per screen.** Don't bundle multiple screens into a single mega-document.

   After the first screen is exported, smoke-test it: `cat` the file, check it's roughly 200-1000 lines (not a stub or an absolute-positioning blob), confirm the CSS variables survived, and report a short excerpt in your progress notes before continuing with the rest. If the first export is unusable, stop and report — don't generate the others.

   If the available tooling can't produce something matching the spec above, skip cleanly: write `{{output_dir}}/code/SKIPPED.md` with the reason and continue without blocking the rest of the work.

   Treat the HTML files as REFERENCE, not implementation. State this in your final summary: "These HTML files are static reference exports — they show exact spacing, palette, DOM hierarchy. They are not wired to data, won't match the target stack's idioms, and aren't meant to be served. Useful as high-fidelity ground truth when implementing the screens in the real codebase later."

{{constraints_section}}
