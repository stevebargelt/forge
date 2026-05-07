---
name: pencil-design
description: >
  Use Pencil's MCP tools (mcp__pencil__*) to create high-quality visual designs — websites, app screens, dashboards, slides, marketing materials. Use this skill whenever the user wants to create, generate, or visualize any kind of UI design, mockup, wireframe, layout, webpage, app screen, presentation slide, poster, banner, or marketing asset. Even if the user doesn't mention "Pencil" explicitly — if they want something visual created, this is the skill to use. This skill teaches the MCP-tool mode (mcp__pencil__*), NOT the `pencil --prompt` one-shot CLI mode (which uses an internal Claude that asks for permissions and stalls in automated environments) or `pencil interactive` (REPL mode, awkward to drive from agent harnesses).
---

# Pencil Design (MCP-tool mode)

Pencil is a headless design tool. In an agent context, **drive Pencil through its MCP tool surface**, not through the `pencil` CLI's natural-language `--prompt` mode and not through the `pencil interactive` REPL. The MCP server exposes the same primitives as `pencil interactive`, but as proper async tool calls — visible in your tool list as `mcp__pencil__*`.

## Why MCP-tool mode (not the CLI)

- `pencil --prompt "..."` (one-shot) — spawns an inner Claude that asks for permission to run Bash, stalling in automated containers. **Do not use.**
- `pencil interactive` (REPL) — booting a new Pencil process per Bash tool call has massive overhead and the REPL state is lost between calls. **Do not use.**
- `mcp__pencil__*` (MCP) — proper async tool calls, persistent state, no nested Claude. **Use this.**

## Available tools

Look in your tool list for these (the harness wires Pencil in as an MCP server; you don't need to start it):

### Document lifecycle
- **`mcp__pencil__open_document({ path })`** — open a `.pen` file. If the path doesn't exist, you start with an empty canvas. The document is auto-saved as you work; you do NOT need a separate save call.
- **(no explicit `save` tool needed)** — Pencil writes to the path you opened with as you make changes.

### Inspection
- **`mcp__pencil__get_editor_state({ include_schema: true })`** — see the document tree and the type schema for every node type. **Always call this first** so you know what's possible.
- **`mcp__pencil__get_guidelines()`** — list the design-system guides ("Lunaris", "Web App", etc.). Then narrow:
- **`mcp__pencil__get_guidelines({ category, name })`** — read the specifics of one guide.
- **`mcp__pencil__get_variables()`** — see design tokens (colors, typography, spacing) defined in the document. Reuse these instead of hardcoding hex values.
- **`mcp__pencil__batch_get()`** — list top-level nodes.
- **`mcp__pencil__batch_get({ patterns: [{ reusable: true }], readDepth: 2 })`** — find reusable components.
- **`mcp__pencil__batch_get({ nodeIds: [...], readDepth: 3 })`** — drill into specific nodes.
- **`mcp__pencil__find_empty_space_on_canvas({ width, height, padding, direction })`** — find a place to put a new artboard alongside existing ones.
- **`mcp__pencil__search_all_unique_properties({ ... })`** — scan for distinct property values across the doc.

### Mutation
- **`mcp__pencil__batch_design({ operations })`** — the workhorse. `operations` is a string with newline-separated commands:
  - **Insert:** `binding=I(parent,{type:"frame",name:"Header",x:0,y:0,width:1440,height:48,fill:"#16161B"})`
  - **Update:** `U(node_id,{content:"new label",fill:"#FFFFFF"})`
  - **Delete:** `D(node_id)`
  - **Move:** `M(node_id,new_parent)`
  - **Replace:** `R(node_id,new_node_spec)`
  - **Image:** `IMG(node_id,"path/to/image.png")`

  Bindings (`frame=`, `header=`, etc.) name a node so later operations *in the same batch* can reference it. **Always create new binding names per `batch_design` call** — do not reuse them across calls.

  **Maximum 25 operations per `batch_design` call.** Split larger work into multiple calls organized by logical section (structure, then headers, then content, etc.). If any operation in a batch fails, the whole batch rolls back and the response includes a list of issues — fix them in the next call.

- **`mcp__pencil__set_variables({ ... })`** — define / update design tokens.
- **`mcp__pencil__replace_all_matching_properties({ ... })`** — bulk-edit (e.g. swap a color across the whole document).

### Export & visual verification
- **`mcp__pencil__get_screenshot({ nodeId })`** — render a node and look at it. **Critical** before claiming a design is done — you're a multimodal model; reading the screenshot tells you whether the design actually looks right. Designing without this is designing blind.
- **`mcp__pencil__export_nodes({ nodeIds: [...], outputDir })`** — produce PNG files. Output filenames are derived from node names.
- **`mcp__pencil__snapshot_layout({ ... })`** — full layout dump for diagnostics.

## Recommended workflow per screen

1. `open_document({ path: "/task/<screen>.pen" })`
2. `get_editor_state({ include_schema: true })`
3. `get_guidelines()` then narrow with `get_guidelines({ category: "style", name: "..." })`
4. `get_variables()`
5. (When iterating: `batch_get({ patterns: [{ reusable: true }] })`)
6. Build with one or more `batch_design({ operations: ... })` calls (max 25 ops each, split by logical section)
7. `get_screenshot({ nodeId: "<root>" })` — **look at it**, decide if it's right
8. If wrong: `batch_design({ operations: ... })` with `U(...)` updates or `D(...)` deletes — don't restart, just fix
9. `export_nodes({ nodeIds: ["<root>"], outputDir: "/task" })`
10. (No save — auto-saved.)

## Multi-screen — coherence via copy-and-edit

Each `.pen` file is independent. To keep multiple screens visually consistent:

1. **Build screen 1 fully** as the "anchor." This screen establishes chrome, palette, typography, components.
2. **For each subsequent screen:** copy the anchor file (in Bash: `cp /task/anchor.pen /task/screen2.pen`), then `open_document({ path: "/task/screen2.pen" })`. The opened doc has all of the anchor's nodes already in place — modify what differs (swap content, change focus area), keep the rest.

This is conceptually like Pencil's `--in` flag in the CLI, just done via filesystem copy + open.

## When the design is wrong

After `get_screenshot`, if the result isn't right:
- **Don't restart.** Use `batch_get` to find the broken nodes and `U(...)` or `D(...)` to fix them.
- If structurally wrong, `D(root_node)` to clear and rebuild within the same session — cheaper than starting a new document.
- Iterate visually: change → screenshot → adjust → screenshot.

## What NOT to do

- Do not run `pencil --prompt` in any form. (Inner Claude stalls on permissions.)
- Do not run `pencil interactive` from Bash. (REPL state lost between calls; massive boot overhead.)
- Do not write to `/tmp` or any ephemeral container path.
- Do not skip `get_editor_state` and `get_guidelines` at the start — designing blind produces poor results.
- Do not skip `get_screenshot` before claiming a screen is done — you can't tell if it looks right without looking at it.
- Do not run more than 25 operations in one `batch_design` — it'll error.

## Reference: a canonical session

```
mcp__pencil__open_document({ path: "/task/runs.pen" })
mcp__pencil__get_editor_state({ include_schema: true })
mcp__pencil__get_guidelines()
mcp__pencil__get_guidelines({ category: "style", name: "Lunaris" })
mcp__pencil__get_variables()
mcp__pencil__find_empty_space_on_canvas({ width: 1440, height: 900, padding: 100, direction: "right" })
mcp__pencil__batch_design({
  operations: 'frame=I(document,{type:"frame",name:"Hero",x:0,y:0,width:1440,height:900,fill:"#0A0A0A",layout:"vertical",clip:true})\nheading=I("frame",{type:"text",content:"Ship faster.",fontSize:72,fontWeight:"bold",fill:"#FFFFFF"})'
})
mcp__pencil__get_screenshot({ nodeId: "frame" })
mcp__pencil__export_nodes({ nodeIds: ["frame"], outputDir: "/task" })
```
