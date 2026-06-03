# Provider abstraction — design exploration

> **Superseded (graduated) 2026-05-30** by
> `learnings/decisions/2026-05-30_provider-resolution.md`. Kept as provenance for
> the accepted decision; not a live spec.

**Status:** exploring (pre-ADR). Ties to AWN-7 (#220, "Provider Runtime
Abstraction"; supersedes #106). This captures the options and open questions
*before* any hot-path code, so the architecture is reviewable. It graduates to
`learnings/decisions/<date>_provider-resolution.md` once the open questions below
are settled.

## Goals (the four that motivate this)

1. **Forge decides** some providers/models are better for certain activities —
   e.g. forge defaults all *design* agents to Codex/gpt-5.5.
2. **The user overrides** forge's defaults per agent/activity — e.g. a user routes
   all *red & review* agents to Codex/gpt-5.5.
3. **A user has only one provider** — only Codex, or only Claude.
4. **Forge (orchestrator / tech-lead) chooses** a provider/model itself — bounded
   by an **approved list** and cost guardrails, so it can't go rogue and always
   pick the most expensive model.

Plus the cross-cutting auth axis: **bedrock vs API key vs subscription.**

---

## The key reframe: this is two layers, very different in size

The work usually gets posed as "abstract the provider," which hides where the
difficulty (and the four goals) actually live.

### Layer 1 — Execution adapter (how a provider is *run*)

This is what the AWN-7 doc calls "the provider interface." Forge already
abstracted **~80% of this** via the runtime YAML (`seeds/runtimes/claude-*.yml`):
the CLI command, args, prompt delivery (`--append-system-prompt`), mounts, auth
mode, and result file are all **data**, not Claude-specific code. To run Codex you
mostly write a `codex-apikey.yml` with `command: codex` and its flags.

What is genuinely Claude-specific *in code* and not yet abstracted:

- **Usage capture** — `extractUsageFromStdoutLog` parses Claude's stream-json.
  Codex emits a different stream, so this needs a **per-provider parser hook**.
  *(This is the one real execution-interface gap.)*
- **Error classification** — mostly provider-neutral already (exit codes +
  result-file state); maybe a few provider-specific auth-error signals.
- Everything else — the `result.json` contract, `progress.jsonl`, bounded logs,
  lifecycle events — is already a forge-owned, provider-neutral contract.

So the execution interface is **thin**: roughly a `Provider.captureUsage(log)` hook
plus the runtime YAML you already have. The scary-sounding part is small.

### Layer 2 — Policy / resolution (which provider+model+auth for *this* task)

**This is where all four goals live, and it is basically not built yet.** This is
what "land it well" actually means.

---

## The three axes (keeping them separate is the whole trick)

| Axis | Answers | Who decides | How |
|---|---|---|---|
| **Capability** | what the task *needs* (reasoning / fast / design / review) | the workflow author | a capability **alias** in workflow YAML — provider-neutral |
| **Provider** | who *runs* it (claude / openai) | policy (goals 1–4) | a resolution chain |
| **Auth mode** | *how* we reach that provider (bedrock / api / subscription) | the environment | auto-detected by env, per provider — same as today |

The move that makes "workflow YAML stays provider-neutral" real: **workflows
declare a capability alias, not a model.** `model: review` means "the model this
provider uses for review work." Each provider's runtime maps `review → gpt-5.5` or
`review → opus`. Policy picks the *provider*; the provider's map resolves the
*model*. Forge defaults (goal 1) become "design → provider `openai`", not a
specific model string — so the default survives model-version bumps.

Critically: **auth mode (bedrock/api/subscription) is orthogonal.** Saying "use
Codex for reds" should never require thinking about whether Codex is reached via
API key or ChatGPT subscription — that is env-detected, exactly like
claude-oauth/apikey/bedrock is today. That keeps the user-facing config simple.

---

## The resolution chain — satisfies all four goals at once

For each task `(role, activity)`, resolve `provider`, then
`model = provider.map[alias]`:

1. **Forge default** (goal 1): a built-in `activity/role → provider` map shipped in
   forge. e.g. "design → openai, red → claude."
2. **User override** (goal 2): `~/.forge/providers.yml` (and per-project
   `.forge/`) overrides by role/activity — `overrides: { "red-*": openai }`. Wins
   over forge defaults.
3. **Orchestrator choice** (goal 4): the orchestrator *may* request a
   provider/model — but **only from an approved list, downgrading (cheaper) freely
   and upgrading only within an explicit per-activity allowlist.** Every choice is
   logged. (Guardrail below.)
4. **Availability fallback** (goal 3): if the resolved provider has no working auth
   in this env, either fall back to whatever *is* available (loud warning) or fail
   clearly — **user config decides which** (`on_unavailable: fallback | fail`).

Goal 3 ("only Codex / only Claude") then isn't a special case — it's just "every
override resolves to an unavailable provider, so fallback kicks in" (or the user
sets their default provider to the one they have).

---

## The cost guardrail (the "don't let Claude go rogue" part)

The part to be most careful with. The rule that makes goal 4 safe:

- Forge resolves a **default model** for every task from policy (steps 1–2) — the
  baseline.
- The orchestrator may deviate only **within an approved set**, where each
  `(provider, model)` carries a **cost tier**. Downgrades (cheaper) always allowed;
  upgrades require the activity to be on a `premium_allowed` list.
- Optional **per-run budget ceiling** — once spent, no upgrades.
- **Every orchestrator-initiated model choice emits an event** (auditable in
  `forge show` / metrics), so a rogue pattern is visible even if a guardrail is
  missed.

"Always picks the most expensive" becomes structurally impossible: the expensive
models aren't in the orchestrator's reach unless explicitly placed there for that
activity.

---

## Three shaping options (how far to go)

**Option A — Resolution-first, single provider still.** Build the capability-alias
+ resolution-chain + user `providers.yml` (goals 1, 2, 3) and the per-provider
usage hook, but ship with only Claude runtimes. No Codex yet. *Proves the policy
model end-to-end with zero new-provider risk; goal 4 deferred. Lowest risk,
highest "did we model it right" value.*

**Option B — A + one real second provider.** Everything in A, plus an actual
`codex-apikey.yml` + Codex usage parser, and a smoke task that runs a red through
Codex without touching workflow YAML. *Proves the interface is real, not
theoretical. The usage-parser + a second auth story is the bulk of the new code.*

**Option C — A/B + orchestrator-bounded-choice (goal 4).** Add the approved-list +
cost-tier + budget guardrail so the orchestrator can pick within bounds. *Highest
leverage but also the part most likely to need iteration once you see it behave —
A/B should be solid first.*

### Recommendation

**A first, as a written ADR + the resolution engine, then B, then C as a separate
pass.** Goals 1–3 are felt immediately; the resolution model is the thing that's
expensive to get wrong; goal 4 (orchestrator autonomy) is the one you'll want to
*watch* before trusting it — so it should land on top of a proven resolution layer
rather than be designed in the abstract.

---

## Open questions (settle these before the ADR)

1. **Capability-alias vs. explicit `provider: openai, model: gpt-5.5` in
   workflows.** Aliases are version-proof and provider-neutral but add a layer of
   indirection. Clean, or prefer explicit coupling?
2. **Default `on_unavailable`** — fallback-with-warning (friendlier) or fail-loud
   (reproducible)? Sets the tone for goal 3.
3. **Is OpenAI/Codex actually the second provider wanted first**, or is the more
   pressing axis *Claude across auth modes* (bedrock vs subscription for
   cost/quota)? Changes whether Layer 1's usage-parser work is even near-path.
4. **Cost-tier source of truth.** Prices drift and OAuth has no per-token cost
   (why `model_calls` dropped its cost column). The "tier" is likely a coarse,
   hand-maintained `cheap | standard | premium` label per model, not a computed
   dollar figure. Comfortable with that?

---

## Relevant existing architecture

- Runtime YAMLs: `seeds/runtimes/claude-{oauth,apikey,bedrock}.yml` — the current
  (implicit) provider seam; selected by env detection (`detect.env`).
- Auth modes: FORGE-DEC-007 / FORGE-DEC-013 (bedrock / anthropic-oauth /
  anthropic-apikey, env-auto-selected).
- Step/red model selection: `model:` alias + `runtime:` name in workflow YAML
  (`src/v2/schema.ts`); `resolveModelForTask` maps alias → model id within a
  runtime's `models:` map (`src/v2/loader.ts`).
- Usage capture: `extractUsageFromStdoutLog` (`src/store/model-calls.ts`) — the
  Claude-stream-json parser that becomes the per-provider hook.
