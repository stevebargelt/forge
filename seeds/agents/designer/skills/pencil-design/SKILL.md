---
name: pencil-design
description: >
  Drive Pencil's interactive shell to create high-quality visual designs — websites, app screens, dashboards, slides, marketing materials. Use this skill whenever the user wants to create, generate, or visualize any kind of UI design, mockup, wireframe, layout, webpage, app screen, presentation slide, poster, banner, or marketing asset. Even if the user doesn't mention "Pencil" explicitly — if they want something visual created, this is the skill to use. This skill teaches the MCP-tools-via-stdin mode (`pencil interactive`), NOT the one-shot `pencil --prompt` mode (which uses an internal Claude that asks for permissions and stalls in automated environments).
---

# Pencil Design (interactive / MCP mode)

Drive Pencil's MCP tools directly through its interactive shell. **You** are the AI agent designing — Pencil exposes a programmatic tool surface (`batch_design`, `batch_get`, `get_screenshot`, `export_nodes`, etc.); your job is to call those tools to construct the design.

## Why interactive mode, not `--prompt`

The Pencil CLI ships two ways to invoke it:

- ❌ **One-shot mode** (`pencil --prompt "design a login form" --out form.pen`) — Pencil's CLI internally spawns its own Claude session that interprets the prompt in natural language and runs MCP tools internally. **Do not use this in agent contexts.** That inner Claude has its own permission state and will stall waiting for permission prompts that the surrounding agent harness can't see.
- ✅ **Interactive mode** (`pencil interactive --out form.pen`) — drops into a stdin-driven REPL where you call MCP tools directly as `tool_name({key: value})` expressions. No nested AI. You decide every operation.

Always use interactive mode. Same MCP tool surface as Pencil's native MCP server — just delivered through stdin/stdout.

## Setup

Verify the CLI is installed and authenticated. (Forge's designer image bakes both in.)

```bash
which pencil      # /usr/bin/pencil
echo "${PENCIL_CLI_KEY:0:6}..."   # should be non-empty; forge spawn passes it through
```

If `PENCIL_CLI_KEY` isn't set in your environment, stop and surface the issue — do not try `pencil login` (interactive auth doesn't work in headless containers).

## The basic invocation

```bash
pencil interactive --out /path/to/output.pen <<'EOF'
get_editor_state({ include_schema: true })
... (more tool calls)
save()
exit()
EOF
```

To iterate on an existing design, also pass `--in`:

```bash
pencil interactive --in prior.pen --out new.pen <<'EOF'
get_editor_state({ include_schema: true })
batch_get()
... (modify or extend)
save()
exit()
EOF
```

**Important details:**
- `--out` is required. `--in` is optional (omit for empty canvas).
- One `pencil interactive` invocation per `.pen` file. Always end with `save()` then `exit()`.
- The REPL prompt is `pencil > `. Each line of stdin is a tool call.
- Don't pipe stdout through `tee` or similar — the REPL is interactive. To capture logs, redirect stderr instead: `pencil interactive ... 2>file.log <<'EOF' ... EOF`.

## The recommended workflow per screen

1. **`get_editor_state({ include_schema: true })`** — see the current document tree and the type schema for nodes you can create. Always do this first.
2. **`get_guidelines()`** — list the design-system guides available (Lunaris and others). Then narrow with `get_guidelines({ category: "style", name: "Lunaris" })` to read the specifics.
3. **`get_variables()`** — see the design tokens (colors, typography, spacing) defined in the document. Reuse these instead of hardcoding values.
4. **`batch_get()` / `batch_get({ patterns: [{ reusable: true }] })`** — only when you opened with `--in`; finds existing nodes and reusable components to build on.
5. **`find_empty_space_on_canvas({ width, height, padding, direction })`** — when adding a new artboard alongside existing ones.
6. **`batch_design({ operations: '...' })`** — make changes. **Maximum 25 operations per call.** Split larger work into multiple calls organized by logical section (e.g. structure first, then header content, then main content).
7. **`get_screenshot({ nodeId: "..." })`** — verify visually before exporting. You're a multimodal model; reading the screenshot tells you whether the design actually looks right.
8. **`export_nodes({ nodeIds: [...], outputDir: "..." })`** — produce a PNG. The output filename is derived from the node name; rename with `mv` after if you want a different filename.
9. **`save()`** — write the `.pen` file to the path you passed via `--out`.
10. **`exit()`** — terminate the REPL.

## `batch_design` operations — quick reference

Operations are a single string with newline-separated commands. Each command is one of:

- **Insert:** `binding=I(parent,{type:"frame",name:"Header",x:0,y:0,width:1440,height:48,fill:"#16161B"})`
- **Update:** `U(node_id,{content:"new label",fill:"#FFFFFF"})`
- **Delete:** `D(node_id)`
- **Move:** `M(node_id,new_parent)`
- **Replace:** `R(node_id,new_node_spec)`
- **Image:** `IMG(node_id,"path/to/image.png")`

Bindings (the `frame=`, `header=` etc.) name a node so later operations in the same `batch_design` can reference it. **Always create new binding names per `batch_design` call** — do not reuse across calls.

If an operation fails, the whole batch rolls back. The response includes a list of issues; address them in the next `batch_design` call.

## Multi-screen designs — coherence

When producing multiple screens for one product, the second through Nth screens should chain off the first via `--in`:

```bash
# Screen 1 — anchor screen, empty canvas
pencil interactive --out /task/runs.pen <<'EOF'
get_editor_state({ include_schema: true })
get_guidelines()
batch_design({ operations: '...' })
get_screenshot({ nodeId: "anchor" })
export_nodes({ nodeIds: ["anchor"], outputDir: "/task" })
save()
exit()
EOF

# Screen 2 — chains off anchor; inherits palette, typography, components
pencil interactive --in /task/runs.pen --out /task/tasks.pen <<'EOF'
get_editor_state({ include_schema: true })
batch_get()
batch_get({ patterns: [{ reusable: true }], readDepth: 2 })
batch_design({ operations: '...' })
get_screenshot({ nodeId: "..." })
export_nodes({ nodeIds: ["..."], outputDir: "/task" })
save()
exit()
EOF
```

The `batch_get({ patterns: [{ reusable: true }] })` call is the key — it surfaces components/styles the anchor screen established so the new screen can reuse them via `R(...)` or `I(parent,{type:"ref",ref:"ButtonComp",...})`.

## Output paths

Write all artifacts into the agent's task directory (the harness will tell you where — typically `/task` in forge containers). **Do not** write to `/tmp` or other ephemeral paths — outputs disappear when the container exits.

## When the design is wrong

If `get_screenshot` shows the design isn't right:
- **Don't restart from scratch.** Use `batch_get` to find the broken nodes and `U(...)` or `D(...)` to fix them.
- If structurally broken, `D(root_node)` to clear and start over within the same session — cheaper than killing the REPL.

## What you should NOT do

- Do not run `pencil --prompt` in any form. (One-shot mode delegates to a nested Claude that fails in containers.)
- Do not write to `/tmp/designs/` or any ephemeral container path.
- Do not pipe `pencil interactive` through `tee` — it's an interactive REPL and `tee` interferes with stdin/stdout.
- Do not skip `get_editor_state` and `get_guidelines` at the start — designing blind produces poor results.
- Do not skip `get_screenshot` before `export_nodes` — verify the visual before claiming the screen is done.
- Do not run more than 25 operations in one `batch_design` — it'll error.

## Reference: the canonical example session

```
pencil > get_editor_state({ include_schema: true })
pencil > get_guidelines()
pencil > get_guidelines({ category: "style", name: "Lunaris" })
pencil > find_empty_space_on_canvas({ width: 1440, height: 900, padding: 100, direction: "right" })
pencil > batch_design({ operations: 'frame=I(document,{type:"frame",name:"Hero",x:0,y:0,width:1440,height:900,fill:"#0A0A0A",layout:"vertical",clip:true})' })
pencil > batch_design({ operations: 'heading=I("frame",{type:"text",content:"Ship faster.",fontSize:72,fontWeight:"bold",fill:"#FFFFFF"})' })
pencil > get_screenshot({ nodeId: "frame" })
pencil > export_nodes({ nodeIds: ["frame"], outputDir: "/task" })
pencil > save()
pencil > exit()
```
