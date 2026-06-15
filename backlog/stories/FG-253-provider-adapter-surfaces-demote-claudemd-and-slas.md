---
id: FG-253
type: story
status: active
title: Provider adapter surfaces — demote CLAUDE.md and slash commands from Forge truth to generated adapters
---

**Captured from user direction 2026-06-02.** Provider-agnostic Forge has a discrepancy problem: some important operator surfaces are inherently provider-specific. `CLAUDE.md`, `.claude/commands/orient.md`, `.claude/commands/handoff.md`, and `.claude/settings.local.json` are Claude Code adapter surfaces, not provider-neutral Forge primitives. Treating them as Forge truth will keep causing drift as Codex / other provider surfaces come online.

**Principle:** Forge should have a provider-agnostic core and provider-specific operator adapters.

**Provider-agnostic core:** durable semantics and machine-readable primitives owned by Forge, e.g. `forge ops check --json`, `forge backlog ...`, workflow YAML, model-policy/profile resolution, project config under `.forge/`, and future orientation/handoff state commands if needed.

**Provider-specific adapters:** render the core semantics into the affordances of one tool:
- Claude Code: `CLAUDE.md`, `.claude/commands/orient.md`, `.claude/commands/handoff.md`, `.claude/settings.local.json` hooks.
- Codex / other tools: equivalent instruction files, command surfaces, session hooks, or no-op/CLI-only fallback depending on what the tool supports.
- Generic fallback: Forge CLI commands + docs, no provider-local slash-command assumptions.

**Design rule:** provider-specific files may exist, but they must be thin renderings of Forge-owned semantics. `/orient` should not be the canonical implementation of orientation; it should be a Claude adapter that runs Forge primitives and synthesizes them. `/handoff` should similarly render a Forge-owned handoff/update protocol rather than becoming the only place that protocol lives. `CLAUDE.md` should be treated as the Claude Code rendering of an orchestrator contract, not the contract itself.

**Practical direction:**
- Define an adapter compatibility matrix, e.g. `claude-code: full`, `codex: partial`, `generic: CLI-only`.
- Teach `forge init` / `forge upgrade` to install/update adapters based on configured provider/tooling rather than assuming Claude-only surfaces forever.
- Move heavy logic out of provider-specific prose and into Forge CLI JSON/state commands where possible.
- Keep provider-specific docs honest: Claude supports slash commands today; other providers may consume the same Forge core through different affordances.
- Avoid duplicating behavior across adapters. If `/orient` and a future Codex adapter disagree, the bug is that the behavior is not in the provider-neutral core.

**Why this matters:** #252 says setup/config should be collaborative and generated rather than hand-authored YAML. The same applies to provider-specific operator surfaces: they should be generated adapters over a Forge-owned contract. Otherwise every provider adds another hand-maintained prompt/doc surface and provider-agnostic routing becomes performative.

**Relations:** #252 (collaborative setup / generated config), #250 (`forge ops check --json` is the right kind of provider-neutral primitive), #248 (`/orient` + `/handoff` reconciliation lives today in Claude slash-command prose), #225 (bounded provider/profile choice), provider-agnostic model work / AWN-7.