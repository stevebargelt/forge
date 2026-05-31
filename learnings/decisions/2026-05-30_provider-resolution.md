# FORGE-DEC: Provider resolution (model policy, drivers, auth modes)

**Status:** accepted
**Date:** 2026-05-30
**Ticket:** AWN-7 (#220, "Provider Runtime Abstraction"). Supersedes #106.
**Supersedes (graduates) the two exploration docs:**
`docs/provider-abstraction-design.md` and `docs/provider-agnostic-models.md`.
Those captured two independent designs; this ADR is the reconciled decision.

## Context

Forge hardcodes Claude as the execution provider. Four things motivate change:

1. **Forge picks stronger defaults per activity** — e.g. design agents default to
   Codex/gpt-5.5, review/synthesis stay on Claude.
2. **Users override per agent/activity** — e.g. route all reds to Codex; or pin
   *only* `red-security` to Claude Bedrock.
3. **Single-provider users** (only Codex, or only Claude) work without editing
   workflows.
4. **The orchestrator may choose a model** — but bounded by an approved list and
   cost guardrails, never free to pick the most expensive model.

Plus the cross-cutting auth axis: **bedrock vs API key vs subscription.**

Two design explorations converged ~85–90% independently. The shared core
invariant:

> **Workflows describe work. Policy chooses the provider. The runtime executes it.**

## Decision

### 1. Three concepts, kept separate

| Concept | Lives in | Decided by |
|---|---|---|
| **Capability alias** (`review`, `design`, `reasoning`, `fast`) | workflow YAML step | workflow author |
| **Profile** — a named policy bundle (provider + model + auth mode + capabilities + cost tier) | `model-policy.yml` | forge default / user / project |
| **Driver / runtime** — how a provider is *run* | `seeds/runtimes/*.yml` | forge (data, not workflow concern) |

Workflows declare a **capability alias**, never a concrete model. `activity: review`
+ `model: review` means "the model this provider uses for review work." Policy
selects a **profile** (hence provider + auth); the provider's runtime maps the
alias → concrete model id. Forge defaults are expressed as `activity → profile`,
so they survive model-version bumps.

This merges the two explorations: profiles (the named-bundle idea) carry auth
mode, cost tier, availability and the allowed-list; the capability alias keeps
workflow YAML provider- and version-neutral.

### 2. Auth mode is a transport choice — auto-detected by default, **pinnable** in policy

bedrock / api-key / subscription are auth/transport modes under a profile, not
separate workflow or agent types. Default behavior is env auto-detection (as
today, FORGE-DEC-007/013). **But policy may pin a specific auth mode** — goal 2's
"`red-security` → Claude **Bedrock** specifically" requires it. A pin in a
profile/override beats auto-detection.

### 3. Execution layer: runtime YAML stays; add only a usage-parser hook

Forge already abstracts ~80% of execution via runtime YAML (command, args, prompt
delivery, mounts, auth mode, result contract are **data**). We do **not** build a
full typed `ModelDriver` interface yet. The one genuine code gap is **usage
capture**: `extractUsageFromStdoutLog` parses Claude's stream-json; a second
provider emits a different stream, so we add a **per-provider usage-parser hook**.
Everything else (`result.json`, `progress.jsonl`, bounded logs, lifecycle events)
is already provider-neutral. The typed driver interface is revisited only if
runtime YAML proves insufficient — not on spec.

### 4. Resolution precedence (explicit rules, highest wins)

1. **CLI override** — `forge invoke <agent> --profile <name>`.
2. **Project policy** — `<project>/.forge/model-policy.yml`.
3. **User policy** — `~/.forge/model-policy.yml`.
4. **Workflow step** — `activity:` + capability alias.
5. **Forge default** — built-in `activity → profile` map.
6. **Availability fallback** — only when policy explicitly allows it (see §6).

User/project policy strictly beats forge default. **Orchestrator choice is allowed
only *inside* the bounds set by user/project policy** (§5) — it is not a
precedence level that can exceed policy.

### 5. Orchestrator choice: request intent, forge enforces

The orchestrator never names an arbitrary provider/model. It requests
**capability + quality + latency**; forge resolves that against `allowed_profiles`,
`max_cost_tier`, policy, available credentials, and capability requirements.
Downgrades (cheaper) always allowed; upgrades only within an explicit
`premium_allowed` activity list. Every orchestrator-initiated choice emits an
event. Bounded orchestrator choice is **off by default** and lands last (§7
Run) — until then the orchestrator gets the policy-resolved profile.

### 6. Fallback: fail loud by default

When a resolved provider has no working auth in the environment, forge **fails
loud** by default — a clear error naming the provider and the missing auth, so a
run never silently executes on a different model than policy specified. Policy may
opt into fallback per-profile (`on_unavailable: fallback`, `same_capability_lower_cost`,
bounded by `max_cost_tier` + `allowed_profiles`). Any fallback writes
`model.fallback_applied` to the manifest and lifecycle events. Single-provider
users (goal 3) set their default profile to the provider they have, or opt into
fallback — not a special case.

### 7. Staging — Crawl / Walk / Run (same vocabulary as the observability roadmap)

**Crawl — resolution engine + Claude auth modes.** Build `model_profiles` schema,
deterministic resolution with the precedence above, per-agent/activity overrides,
auth-mode pinning, fail-loud default, and the observability surface (§8). Ship with
**Claude only**, across bedrock/api/subscription as pinnable profiles. Proves the
policy model and auth-pinning with **zero new-provider risk** and no usage-parser
work yet. Goals 1–3 felt immediately.

**Walk — Codex/OpenAI as a real second provider.** Add a `codex-*` runtime YAML +
the Codex **usage-parser hook**, and a smoke task running a red through Codex
without touching workflow YAML. Proves the interface is real, not theoretical.
This is where the Layer-1 usage work actually lands.

**Run — bounded orchestrator choice + adaptive routing (goal 4).** Add
`allowed_profiles` + cost-tier + budget guardrail + capability-request resolution
so the orchestrator chooses within bounds. Lands on a proven resolution layer; the
part to *watch* before trusting.

Keeping AWN-7 staged this way is what stops it becoming a sprawling provider
rewrite: Crawl ships user-visible value (auth pinning, per-activity defaults) with
no new provider, and each stage is independently shippable.

### 8. Observability (acceptance criteria, not aspirations)

For every task, the resolved **provider + model + auth mode + `resolvedBy`** must:

- be written into `manifest.json` (the resolution record);
- be shown by `forge show` (answers "why did this task use this model?");
- be reproducible via a dry-run **`forge model resolve <agent> --activity <a> --project <dir>`**
  (explains selected profile, fallbacks considered, availability failures;
  static by default, `--check` runs availability probes);
- be diagnosable via **`forge providers doctor`** (which providers have working
  auth in this env).

Lifecycle events: `model.profile_resolved`, `model.profile_unavailable`,
`model.fallback_applied`. (failure_kind taxonomy stays a payload field, per the
event-stream invariant — not a new column.)

### 9. Cost tier is a coarse, hand-maintained label

`cheap | standard | premium` per profile, **not** a computed dollar figure. Prices
drift and OAuth/subscription has no per-token cost (why `model_calls` dropped its
cost column). Guardrails reason over the qualitative tier.

## Resolved open questions

- **Capability-alias vs explicit model in workflows** → **alias.** Version-proof,
  provider-neutral; the indirection is the point.
- **`on_unavailable` default** → **fail loud**, per-profile opt-in to fallback.
- **First second provider** → **Claude across auth modes first** (Crawl), then
  **Codex** (Walk). Sequenced.
- **Cost tier qualitative vs numeric** → **qualitative first.**
- **`activity` on steps** → inferred from agent role by default; explicit override
  allowed.
- **Project policy defining new profiles** → allowed; but `allowed_profiles`
  (admin/global) bounds *orchestrator* autonomy regardless.
- **Full broker / control plane** → **rejected as first implementation.** Revisit
  only if Phases 1–3 prove insufficient.

## Consequences

- New file: `model-policy.yml` (global + per-project), Zod-validated.
- New schema: `model_profiles`, `defaults.activity`, `overrides.agents`,
  `allowed_profiles`, `on_unavailable`. **Touches `~/.forge/forge.db` only if the
  resolution record is persisted beyond `manifest.json`** — flag before shipping
  (machine-wide migration blast radius).
- `resolveModelForTask` (`src/v2/loader.ts`) grows from alias→model into the full
  precedence resolver.
- `extractUsageFromStdoutLog` (`src/store/model-calls.ts`) becomes the first
  registered per-provider usage hook.
- Existing Claude workflows run unchanged with **no** policy file present.

## Relevant existing architecture

- Runtime YAMLs: `seeds/runtimes/claude-{oauth,apikey,bedrock}.yml` — the current
  implicit provider seam, env-selected (`detect.env`).
- Auth modes: FORGE-DEC-007 / FORGE-DEC-013.
- Step/red model selection: `model:` alias + `runtime:` name (`src/v2/schema.ts`);
  `resolveModelForTask` (`src/v2/loader.ts`).
- Usage capture: `extractUsageFromStdoutLog` (`src/store/model-calls.ts`).
