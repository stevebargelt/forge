---
id: FG-106
type: story
status: done
title: Provider abstraction (OpenAI/Codex + future) — NEEDS ARCHITECTURE WORK
---

**Closed:** 2026-05-30. Commit `superseded-by-219... AWN-7`.

**Why:** Today forge's three auth modes (bedrock, anthropic-oauth, anthropic-apikey) all happen to call `claude` against Anthropic models — provider is implicit, not a concept. To support OpenAI/Codex (and future providers like Anthropic-via-Vertex), forge needs **provider** as a first-class abstraction across the spine, the agent container, and the credential layer. This is the architectural prep work that *makes* #97's hierarchical-ready UI meaningful and unblocks future provider additions.

**Scope (high-level — needs design):**
- A `Provider` interface in `src/types` or `src/spine`: identity, model vocabulary, credential detection, container env shape, CLI invocation pattern.
- Refactor `spawn.ts` to ask the provider how to invoke the agent (not hardcode `claude --model`).
- Refactor `creds.ts` to be provider-aware (today's three-mode detector becomes one provider's three credential flavors).
- Container image (#75 territory): may need to host multiple provider CLIs side-by-side, or build per-provider images.
- Workflow/agent declarations: `AgentRef.model` becomes provider-scoped (e.g., `provider: 'openai', model: 'gpt-5'`).

**Not designed yet — this is a placeholder.** When forge actually needs OpenAI/Codex, this gets a real architecture-work session: read the spawn/creds/image code paths, sketch the Provider interface, decide whether providers share containers or get separate ones, plan migration of existing Claude-only code.

**Caught:** 2026-05-11 — surfaced while talking through #97. Steven's call: leave room for OpenAI/Codex without designing it now.