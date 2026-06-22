---
id: FG-346
type: story
status: active
title: "forge setup/init: interactively ask which providers+models to use and GENERATE the model-policy, instead of copying the seed default"
created: 2026-06-22
---

**Origin:** surfaced 2026-06-22 while setting up mixed-provider routing for the FG-345 worktrees research (research-primary on Claude, research-skeptic on Codex). Getting that required hand-crafting a project-level `.forge/model-policy.yml` override — a hand-authored YAML band-aid, which is exactly the smell FG-252 set out to kill. The clean fix was promoting the pins to the host policy, but the deeper gap is that nothing ever ASKED what routing this machine should use.

## The gap

`forge setup` today is `copyFileSync(MODEL_POLICY_SEED → ~/.forge/model-policy.yml)` when absent (src/cli/commands/setup.ts) — it copies the seed default and asks nothing. The seed ships `overrides.agents: {}`, so every machine starts with no provider/role routing and the user must hand-edit YAML (or hand-copy per-project) to get anything non-default like mixed-provider research.

FG-252 (done) explicitly called for the interactive half — "on forge init/upgrade, detect missing/partial config and ASK concise setup questions," "generated files should be authored from choices," "preserve direct YAML editing as an expert escape hatch, not the primary setup path." But what shipped under FG-252/FG-308 was the host bootstrap (seed-copy) + release/doctor check. The ASK-and-GENERATE part never landed. This ticket is that unbuilt half, scoped to model/provider routing specifically.

## Requirement

`forge setup` / `forge init` (or a `forge config setup model-policy`-style surface) should:
- **Detect available providers** — `forge providers doctor` already reports exactly this (anthropic/subscription, openai/subscription, anthropic/bedrock, groq/api, etc. with availability). Use it as the input set; don't ask about providers the host can't use.
- **Ask which models map to which capabilities** — for the standard capabilities (reasoning / review / fast / default) and for notable role pins, including the mixed-provider research case (research-primary vs research-skeptic on different vendors). Concise, with sensible defaults pre-selected.
- **Generate `~/.forge/model-policy.yml` from the answers** — model_profiles, defaults.activity, overrides.agents — instead of copying the seed verbatim. Output is explicit, reviewable YAML.
- **Preserve direct YAML editing as the expert escape hatch**, not the primary path (FG-252 principle).

## Notes / scope

- Host-level model-policy generation is the core. Project-level overrides can reuse the same Q&A flow (a project may specialize routing) but project policy is FILE-LEVEL REPLACEMENT today, so a generated project policy is a full file, not a delta — see the related drift problem below.
- Related drift problem worth considering here: a project `.forge/model-policy.yml` fully REPLACES the host policy (not a merge), so a hand-copied project override is a frozen snapshot that drifts from host. An ADDITIVE project override (just the `overrides.agents` delta merged onto host) would remove the reason to copy whole policies. Either fold that into this ticket or file separately.
- This is orchestrator-mediated config authoring per FG-252's model — the orchestrator/CLI asks and writes; the user does not hand-author.

**Relations:** FG-252 (shipped the seed-copy host bootstrap, NOT this Q&A), FG-308 (host-doctor report + forge-new advisory), FG-332 (project-local init), FG-345 (the research run whose setup exposed this), the `forge providers doctor` provider-detection surface (the natural input for the questions).
