---
name: pencil-design
description: >
  Drive Pencil's interactive shell with multi-command stdin heredocs to create high-quality visual designs — websites, app screens, dashboards, slides, marketing materials. Use this skill whenever the user wants to create, generate, or visualize any kind of UI design, mockup, wireframe, layout, webpage, app screen, presentation slide, poster, banner, or marketing asset. Even if the user doesn't mention "Pencil" explicitly — if they want something visual created, this is the skill to use. This skill teaches `pencil interactive` REPL mode driven via heredoc — NOT the broken `pencil --prompt` one-shot mode and NOT the MCP-server mode (the binary requires a Pencil app to bridge to, which doesn't exist in agent containers).
---

# Pencil Design (interactive REPL via stdin heredoc)

Drive Pencil's MCP tools through `pencil interactive`'s stdin REPL. **You** are the AI agent designing — Pencil exposes a programmatic tool surface (`batch_design`, `batch_get`, `get_screenshot`, `export_nodes`, etc.); your job is to call those tools to construct the design.

## Why this mode (not the others)

- ❌ `pencil --prompt "..."` — spawns an inner Claude that asks for permission and stalls in automated containers.
- ❌ Pencil's native MCP server (`mcp-server-linux-*`) — requires `--app <name>` pointing at a running Pencil desktop/IDE app. No such app in agent containers; the server immediately exits with `app connection is required`.
- ✅ `pencil interactive --out file.pen <<EOF ... EOF` — boots a fresh Pencil REPL, pipes your tool calls in via stdin, exits on `exit()`. No nested Claude, no app dependency.

## THE critical rule: one heredoc = one complete screen

Each `pencil interactive` invocation pays a 3-5 second boot cost. **Bundle the entire screen's tool calls into one heredoc** so you pay that cost once per screen, not once per tool call.

**Wrong** (one tool call per Bash call — Pencil reboots between every step, dies of overhead):

```bash
pencil interactive --out /task/runs.pen <<'EOF'
get_editor_state({ include_schema: true })
EOF

pencil interactive --out /task/runs.pen <<'EOF'
get_guidelines()
EOF

# ... 30 more reboots
```

**Right** (one Bash call, one screen, all tool calls inline):

```bash
pencil interactive --out /task/runs.pen <<'EOF'
get_editor_state({ include_schema: true })
get_guidelines()
get_guidelines({ category: "style", name: "Lunaris" })
get_variables()
batch_design({ operations: 'frame=I(document,{type:"frame",name:"Root",x:0,y:0,width:1440,height:900,fill:"#0E0E10",layout:"vertical",clip:true})' })
batch_design({ operations: 'header=I("frame",{type:"frame",name:"Header",width:"fill_container",height:48,fill:"#16161B"})' })
... (dozens more batch_design calls — max 25 ops each, but as many calls as you need in this same heredoc)
get_screenshot({ nodeId: "frame" })
export_nodes({ nodeIds: ["frame"], outputDir: "/task" })
save()
exit()
EOF
```

**Plan the entire screen before writing the heredoc.** That includes which nodes you'll create, which design tokens you'll reuse, and the shape of the screenshot verification step. If you find yourself wanting to "see what's there before deciding what to do next," do that planning *outside* of Pencil first (read the brief, the project source, etc.), then commit to the full plan in one heredoc.

## The recommended sequence per screen

Fit all of this in one heredoc:

1. **`get_editor_state({ include_schema: true })`** — see the document tree and the type schema.
2. **`get_guidelines()`** — list the design-system guides ("Lunaris", "Web App", etc.).
3. **`get_guidelines({ category, name })`** — read the specifics of one guide (skip if you already know it from screen 1).
4. **`get_variables()`** — see design tokens (colors, typography, spacing). Reuse them; don't hardcode hex values.
5. **`batch_get()` / `batch_get({ patterns: [{ reusable: true }], readDepth: 2 })`** — only when iterating on an existing doc opened with `--in`; surfaces existing nodes and reusable components.
6. **Many `batch_design({ operations: ... })` calls** — make changes. **Maximum 25 operations per call**; split larger work into multiple calls in the same heredoc, organized by logical section (root frame → header → middle pane → right pane → modals).
7. **`get_screenshot({ nodeId: "<root>" })`** — verify visually. You're a multimodal model; the screenshot is how you check whether the design actually looks right.
8. **(if needed) more `batch_design` to fix what the screenshot reveals**, then another `get_screenshot`.
9. **`export_nodes({ nodeIds: ["<root>"], outputDir: "/task" })`** — produce the PNG.
10. **`save()`** — persists the `.pen` file.
11. **`exit()`** — terminates the REPL.

## `batch_design` operations — quick reference

Operations are a single string with newline-separated commands. Each command is one of:

- **Insert:** `binding=I(parent,{type:"frame",name:"Header",x:0,y:0,width:1440,height:48,fill:"#16161B"})`
- **Update:** `U(node_id,{content:"new label",fill:"#FFFFFF"})`
- **Delete:** `D(node_id)`
- **Move:** `M(node_id,new_parent)`
- **Replace:** `R(node_id,new_node_spec)`
- **Image:** `IMG(node_id,"path/to/image.png")`

Bindings (`frame=`, `header=`, etc.) name a node so later operations *in the same `batch_design` call* can reference it. **Always create new binding names per `batch_design` call** — do not reuse them across calls.

If any operation fails, the whole batch rolls back. The response includes a list of issues; address them in the next `batch_design` call.

## Multi-screen designs — coherence via `--in` chaining

When producing multiple screens for one product, the second through Nth screens chain off the first via `--in`:

```bash
# Screen 1 — anchor screen, empty canvas
pencil interactive --out /task/runs.pen <<'EOF'
get_editor_state({ include_schema: true })
get_guidelines()
get_guidelines({ category: "style", name: "Lunaris" })
get_variables()
batch_design({ operations: '...' })
batch_design({ operations: '...' })
get_screenshot({ nodeId: "frame" })
export_nodes({ nodeIds: ["frame"], outputDir: "/task" })
save()
exit()
EOF

# Screen 2 — chains off anchor; inherits palette, typography, components
pencil interactive --in /task/runs.pen --out /task/tasks.pen <<'EOF'
get_editor_state({ include_schema: true })
batch_get()
batch_get({ patterns: [{ reusable: true }], readDepth: 2 })
batch_design({ operations: '...' })
get_screenshot({ nodeId: "frame" })
export_nodes({ nodeIds: ["frame"], outputDir: "/task" })
save()
exit()
EOF
```

The `batch_get({ patterns: [{ reusable: true }] })` call is the key — it surfaces components/styles the anchor screen established so the new screen can reuse them via `R(...)` or `I(parent,{type:"ref",ref:"ButtonComp",...})`.

## Heredoc quoting — important

Use **`<<'EOF'`** (single-quoted) so Bash doesn't interpret `$variable` references inside your tool calls. Pencil's design-token references look like `$primary-color` and Bash would try to expand them.

To capture Pencil's stderr log without disturbing the REPL, redirect stderr (only) to a file:

```bash
pencil interactive --out /task/runs.pen 2>/task/runs.stderr.log <<'EOF'
... tool calls ...
EOF
```

**Do not** use `2>&1`, `tee`, or pipe stdout — the REPL needs a clean stdout/stdin pair.

## Output paths

Write all artifacts into `/task/` — that's the agent's working dir, persisted on the host. Do **not** write to `/tmp` or other paths under `/` — those are ephemeral and disappear when the container exits.

## When the design is wrong

After `get_screenshot`, if the result isn't right:
- **Don't restart the heredoc.** Use more `batch_design` calls (still in the same heredoc) with `U(...)` updates or `D(...)` deletes to fix.
- If structurally wrong, `D(root_node)` to clear and rebuild within the same session.
- Iterate visually in one session: change → screenshot → adjust → screenshot → export → save → exit.

## What you should NOT do

- Do NOT split a single screen across multiple `pencil interactive` calls. The boot cost makes this fail with idle timeouts.
- Do NOT run `pencil --prompt` in any form. (Inner Claude stalls on permissions.)
- Do NOT look for `mcp__pencil__*` tools. (The MCP server requires a Pencil app, which doesn't exist here.)
- Do NOT write to `/tmp/designs/` or any ephemeral container path.
- Do NOT skip `get_editor_state` / `get_guidelines` at the start of a screen — designing blind produces poor results.
- Do NOT skip `get_screenshot` before `export_nodes` — verify the visual.
- Do NOT run more than 25 operations in one `batch_design` — it'll error.
- Do NOT pipe `pencil interactive` through `tee` or `| something` — only stderr can be redirected (`2>file.log`).

## Reference: a canonical session

```bash
pencil interactive --out /task/hero.pen 2>/task/hero.stderr.log <<'EOF'
get_editor_state({ include_schema: true })
get_guidelines()
get_guidelines({ category: "style", name: "Lunaris" })
get_variables()
find_empty_space_on_canvas({ width: 1440, height: 900, padding: 100, direction: "right" })
batch_design({ operations: 'frame=I(document,{type:"frame",name:"Hero",x:0,y:0,width:1440,height:900,fill:"#0A0A0A",layout:"vertical",clip:true})' })
batch_design({ operations: 'heading=I("frame",{type:"text",content:"Ship faster.",fontSize:72,fontWeight:"bold",fill:"#FFFFFF"})' })
get_screenshot({ nodeId: "frame" })
export_nodes({ nodeIds: ["frame"], outputDir: "/task" })
save()
exit()
EOF
```
