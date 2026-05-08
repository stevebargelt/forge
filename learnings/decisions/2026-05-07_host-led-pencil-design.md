# Decision: Host-led human-driven design phase, with forge as the prompt-author

**ID**: FORGE-DEC-014
**Date**: 2026-05-07
**Status**: Decided
**Decided by**: Steven (after a full day of failing to put a designer agent in a container)
**Supersedes**: The container-designer plan in BACKLOG #46 (commits `d560b7b`, `37f63fa`, etc.)
**Scope**: forge

---

## Context

#46 set out to build a `designer` blue agent that runs in a container, drives Pencil's CLI, and produces UI designs. We spent a full day trying to make it work and confirmed empirically that **Pencil cannot be driven autonomously in a headless container**. Multiple architectures were tried and each failed for a different, real reason. The container-based v1 plan is dead.

What's NOT dead is forge's value proposition for design work — it just lives one layer higher. The agent's job becomes **authoring the prompt + capturing the brief**, not running Pencil itself. The human runs Pencil on the host, where they already have it. Forge orchestrates the brief, gates the result, and renders the artifacts in the dashboard.

This is a meaningful architectural pivot, hence the ADR.

---

## Problem

How does forge support the `ui-design` workflow given that Pencil's design model assumes a human-in-the-loop GUI editor and provides no headless persistence path?

Sub-problems answered along the way:

1. Can we run Pencil in a container? **No.**
2. Can we use Pencil's MCP server in a container? **No** — it's a bridge to a running Pencil app (VS Code extension or desktop), not a standalone server.
3. Can we drive `pencil interactive` REPL from inside a container? **Yes, but the `save()` command is a no-op** — Pencil 0.2.5 has no auto-save and no programmatic save. Persistence requires the human pressing Cmd+S in the editor. (Documented at https://docs.pencil.dev/troubleshooting: "Auto-save is not yet available. Planned for future release.")
4. Can we use Pencil's MCP server on the *host*, where the editor is running? **Yes.** And it works very well — produces full design systems with reusable components in one prompt.
5. So who runs Pencil? **The human, on their host machine, in VS Code.**

---

## Options Considered

### Option A: container designer with Pencil CLI (the abandoned v1 plan)

Designer agent runs in `agent-designer-worker`, drives `pencil --prompt` or `pencil interactive` over stdin from a Bash tool call, exports PNGs to a bind-mounted task dir.

**Pros**:
- Matches forge's existing "agents in containers" rule.
- No new architecture; standard blue-agent shape.

**Cons** (all hit empirically):
- `pencil --prompt` spawns an inner Claude that asks for permission and stalls. No way to skip permissions for the inner Claude. Documented in [pencil-cli-modes.md](#).
- `pencil interactive`'s `save()` is a no-op (writes "Saved /path" but the file is 0 bytes). Confirmed on host AND container — it's a Pencil bug/limitation, not a containerization issue.
- Pencil's MCP server binary (`mcp-server-linux-arm64`, ships in the npm package) requires `--app <name>` pointing at a running Pencil GUI; without it, immediate exit with "app connection is required."
- The 5-minute idle watchdog kills containers because Claude streams nothing during long thinking turns (fixed with `--include-partial-messages`, but that's papering over the deeper problem that nothing useful was happening anyway).
- Even when the agent did write a `.pen` file path explicitly, the file stayed 0 bytes because no save mechanism exists outside the editor.

---

### Option B: host-side designer agent that talks to Pencil's MCP server ✅

Forge doesn't run Pencil at all. Instead:

1. A **brief-author** agent (running in a normal forge container) interrogates the human and produces a `PROMPT.md` file containing all the workflow rules we discovered today (touch the target file, pass `filePath` everywhere, use `find_empty_space_on_canvas`, export and rename PNGs, save dashboard.pen via Cmd+S in VS Code).
2. The human takes that `PROMPT.md`, opens Claude Code in the design directory with VS Code as the editor host, and pastes it. Pencil runs there, with the human's existing toolchain.
3. The human Cmd+Ses the result in VS Code (only path to .pen persistence given Pencil 0.2.5).
4. The human reports back to forge by gating the brief-author's task and providing artifact paths. Forge renders the PNGs in the dashboard.

**Pros**:
- The dead ends from Option A all evaporate — Pencil is used in the configuration it's designed for.
- Forge gains a reusable primitive (prompt elicitation) that applies beyond design (marketing copy, code review, architecture review, etc.).
- The brief-author agent is a normal blue agent in a normal container — no new infrastructure.
- The "agents always run in containers" invariant survives. The *human* runs Pencil, not an agent.
- Quality of output is high: the third probe we ran on host produced 5 coherent screens, full component library, three valid reusable badges/rows/sidebars, all in Lunaris/Saturated-Code-Bridge style.

**Cons / Trade-offs**:
- The design phase happens *outside* forge's container model. Forge can't see the design happening; it only sees the inputs (brief) and outputs (PNG paths reported back).
- The human has to Cmd+S manually. PROMPT.md must remind them; forge can't enforce.
- For organizations where the human + machine + editor combination isn't available (no VS Code, no Pencil license), the workflow doesn't apply. Forge's design workflow is gated on a specific desktop toolchain.
- Forge can't fully automate "design from brief"; the human is in the loop by design.

---

### Option C: defer the design workflow entirely

Drop #46 from the roadmap. Don't try to support design at all.

**Pros**:
- Zero work.

**Cons**:
- Loses the workflow scaffolding we already have (run/task/gate model fits design beautifully).
- Doesn't capture the prompt-engineering patterns we just discovered.
- The use case (forge designs forge's own dashboard, then iterates) is real and valuable — the dashboard rebuild (#34/#35/#48) directly benefits.

---

## Decision

**Chose**: Option B — host-led design with forge as the prompt-author.

**Rationale**:
- Option A is empirically blocked by Pencil's architecture in three independent ways. Each block was a real day's work to confirm.
- Option B aligns with how Pencil is actually designed to be used — a human-in-the-loop editor, not a headless renderer.
- The pivot makes forge MORE general, not less: prompt-author is the right primitive for many future workflows where forge's value is "capture institutional knowledge about how to drive AI tools well, then apply it consistently."
- The handoff (forge produces PROMPT.md, human runs it, forge renders results) maps cleanly onto forge's existing gate model. No new state-machine primitives needed.

---

## Consequences

**Positive**:
- The container-based designer code can be deleted. ~600 LOC of Dockerfile + spawn-image-overrides + designer seed go away. Container infrastructure becomes simpler.
- The brief-author seed is reusable — `prompt-author` agent works for non-design prompts too.
- The dashboard becomes the natural review surface for design output (PNGs + the saved `.pen`); this aligns with #34/#35/#48 plans.
- We have working evidence: today's design output in `~/code/forge-design/designs/` is high-quality and replicable.

**Negative / Trade-offs**:
- A run is "complete" in forge only after the human finishes work outside forge and gates back. That breaks the "forge knows everything that happened in this run" invariant slightly. Mitigation: capture artifact paths in the gate rationale; dashboard renders from those paths.
- For Pencil-less environments, the workflow doesn't apply. Acceptable — forge is a personal-Mac tool today (per BACKLOG context).
- Cmd+S is load-bearing and unenforceable. PROMPT.md will warn loudly. If Pencil ships auto-save, simplify.

**Risks**:
- The human forgets to Cmd+S → design source is lost. Mitigated by loud PROMPT.md warning + `stat` verification step in the prompt's final summary.
- The brief-author seed drifts away from Pencil's actual capabilities if Pencil updates. Mitigated by tracking Pencil version (#NN) and re-validating periodically.

---

## Implementation Notes

### What to build

1. **`prompt-author` agent seed** at `seeds/agents/prompt-author/`. Generic prompt-elicitation agent with an interview structure: brief / screens / style / paths / constraints. Output is a `PROMPT.md` file path.
2. **A `PROMPT.md` template specific to ui-design** — parameterized version of `~/code/forge-design/PROMPT.md` (the working version we validated tonight). Keys to fill: `{{target_pen_file}}`, `{{output_dir}}`, `{{screens}}`, `{{style_guidance}}`, `{{brief}}`. The template encodes everything we learned today (touch, filePath, find_empty_space_on_canvas, export+rename, Cmd+S warning).
3. **Rewrite `src/workflows/ui-design.ts`**: `brief` (prompt-author, gate=human) → `review` (gate=human, captures artifact paths). Drop the old `discover` / `design` / `export` shape — there is no agent-led design phase.
4. **Rewrite `src/workflows/design-revise.ts`** in the same shape: input is a prior `.pen` file path; brief-author writes a revision PROMPT.md.
5. **Tear down container designer code** — `docker/agent-designer-worker.Dockerfile`, `docker/build-designer.sh`, `seeds/agents/designer/`, `seeds/agents/designer-export/`, the AgentRef.image plumbing in `spawn.ts`. Tracked as a separate cleanup task in BACKLOG.
6. **Dashboard renders PNGs from artifact paths** captured in gate rationale. Aligns with #48.

### What NOT to build

- **No designer agent that touches Pencil.** Ever. Pencil's tools are GUI-bound; the agent's job is the prompt, not the pixels.
- **No save-Pencil-from-the-CLI workaround.** Confirmed broken; Pencil's roadmap will fix it. Don't reinvent.
- **No Pencil-MCP-server-in-container architecture.** The MCP binary requires a running Pencil GUI app; the container has none.

### Workflow rules captured in the PROMPT.md template

These are the load-bearing details forge's prompt-author seed must encode. All confirmed empirically tonight:

1. **`touch <target.pen>` before any MCP call** — `open_document` won't create the file otherwise.
2. **`open_document` then `get_editor_state`** — verify the active editor is the target file, not `pencil-new.pen` (Pencil's untitled fallback).
3. **Pass `filePath: "<absolute path>"` on every MCP call** — operations route by `filePath`, not by active editor.
4. **`find_empty_space_on_canvas` before each top-level frame** — otherwise screens stack at (0,0).
5. **`export_nodes` after each screen + Bash `mv`** — Pencil names exports by node ID; rename to ordered descriptive names.
6. **End with a loud Cmd+S warning** — `.pen` only persists when the human saves in VS Code. PNGs persist automatically.
7. **No SKILL.md needed** — Pencil's skill biases toward broken `--prompt` mode; without it the agent picks MCP correctly. Confirmed in two runs.

---

## Revisit Conditions

- **Pencil ships auto-save** (`docs.pencil.dev/troubleshooting` says it's planned). When that lands: simplify PROMPT.md template (drop the loud Cmd+S warning), test that `.pen` files persist without human intervention.
- **Pencil ships a headless mode that actually persists.** Then we can revisit container-based designer agents.
- **Forge becomes multi-user / non-Mac / no-VS-Code.** Then this design needs a fallback — probably "design phase is just unsupported; use a different workflow."
- **The brief-author primitive is used for 3+ workflows.** Promote it from seed to a first-class forge concept; consider extracting common interview structure.
