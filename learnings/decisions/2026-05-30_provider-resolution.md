# FORGE-DEC: Provider resolution (model policy, drivers, auth modes)

**Status:** accepted
**Date:** 2026-05-30
**Ticket:** AWN-7 (#220, "Provider Runtime Abstraction"). Supersedes #106.
**Supersedes (graduates) the two exploration docs:**
`learnings/decisions/provider-abstraction-design.md` and `learnings/decisions/provider-agnostic-models.md`.
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

| Concept | Lives in | Decided by | Owns |
|---|---|---|---|
| **Capability alias** (`review`, `design`, `reasoning`, `fast`) | workflow YAML step | workflow author | *what the task needs* — task intent |
| **Profile** — a named policy bundle | `model-policy.yml` | forge default / user / project | *who runs it* — **provider + auth mode + a capability→model map + per-model cost tier** |
| **Driver / runtime** — how a provider is *run* | `seeds/runtimes/*.yml` | forge (data, not workflow concern) | the container invocation |

**A profile does NOT pin one concrete model.** It owns the provider, the auth mode,
a **capability→model map**, and cost tiers. The concrete model is resolved *through*
the profile by the task's capability alias:

```
concrete model = profile.map[ capability alias ]
```

e.g. profile `claude-bedrock` = `{ provider: anthropic, auth: bedrock,
map: { review: sonnet, reasoning: opus, fast: haiku } }`. A task with
`activity: review` resolved to that profile runs `sonnet` on Bedrock. The same
alias against a `codex-subscription` profile resolves whatever *that* provider maps
`review` to. This is the hybrid of the two explorations: the **named profile** (from
the other doc) owns provider/auth/cost/map; the **capability alias** (from mine)
keeps workflow YAML provider- and version-neutral. Workflows never name a concrete
model; forge defaults are `activity → profile`, so they survive model-version bumps.

One profile per (provider, auth-mode) — `claude-subscription`, `claude-bedrock`,
`codex-subscription` — each carrying the full alias map. This avoids a
combinatorial profile-per-activity explosion.

### 2. Auth mode is a transport choice — auto-detected by default, **pinnable** in policy

bedrock / api-key / subscription are auth/transport modes under a profile, not
separate workflow or agent types. The profile's `auth:` field is an explicit enum
that reconciles "profile owns auth" with "auto-detected by default":

```yaml
auth: auto        # resolve to one of subscription | api | bedrock by env detection
                  #   (FORGE-DEC-007/013) — the default when auth: is omitted
auth: bedrock     # PIN bedrock; fail loud (§6) if bedrock auth isn't available
auth: api         # pin api-key
auth: subscription
```

So `auth: auto` is the default behavior (the profile *owns* the field; its value
just delegates to env detection), and `auth: bedrock` is a hard pin — goal 2's
"`red-security` → **Bedrock** specifically." A pinned mode never silently falls
back to another auth mode; if its credentials are absent, resolution fails loud
(§6) unless the profile opts into fallback. There is no contradiction: the profile
always owns `auth:`; `auto` is one of the values it can own.

### 3. Execution layer: runtime YAML stays; add only a usage-parser hook

Forge already abstracts ~80% of execution via runtime YAML (command, args, prompt
delivery, mounts, auth mode, result contract are **data**). We do **not** build a
full typed `ModelDriver` interface yet. The one genuine code gap is **usage
capture**: `extractUsageFromStdoutLog` parses Claude's stream-json; a second
provider emits a different stream, so we add a usage-parser hook.

> **Superseded by #292 (runtime metadata seam):** the usage-parser hook is keyed
> off the runtime's declared `log_format` (`claude-stream-json` / `codex-jsonl` /
> `pi-jsonl`) — an EXECUTION fact — NOT the upstream provider. AWN-7 Walk's
> original `provider === "openai"` dispatch survives only as a legacy fallback in
> `captureUsageForTask` for runtimes that predate the metadata. `runtime_kind`,
> `log_format`, `prompt_strategy`, and `auth_strategy` are now first-class runtime
> YAML fields (`resolveRuntimeMetadata` infers them for pre-#292 runtimes). This
> is what lets a third runtime (Pi) be added without an `if (provider === …)`
> branch. See `docs/prds/provider-agnostic-runtime-pi.md`.

Everything else (`result.json`, `progress.jsonl`, bounded logs, lifecycle events)
is already provider-neutral. The typed driver interface is revisited only if
runtime YAML proves insufficient — not on spec.

### 4. Resolution: two independent passes (don't conflate intent with provider)

Capability (task intent) and profile (who runs it) are resolved **separately**.
Workflow `activity:`/`model:` is *intent*, not a profile override — it must not
compete in the same precedence list as `--profile`.

**Pass 1 — capability (what the task needs):** highest wins
1. Workflow step `model:` alias (explicit task intent).
2. Agent default activity (e.g. `red-security` → `review`).
→ yields a **capability alias**.

**Pass 2 — profile (who runs it):** highest wins
1. **CLI / run override** — `forge invoke <agent> --profile <name>` (one agent),
   or `forge new <workflow> --profile <name>` (pins every task in the run —
   primary, red, fanout — stored as `metadata.modelProfile`, recorded as
   `resolvedBy: run.profile`).
2. **Project policy** — `<project>/.forge/model-policy.yml`.
3. **User policy** — `~/.forge/model-policy.yml`.
4. **Forge default** — built-in `activity → profile` map.
5. **Availability fallback** — only when policy explicitly allows it (see §6).
→ yields a **profile** (hence provider + auth).

**Then:** `concrete model = profile.map[ capability alias ]`.

User/project policy strictly beats forge default. **Orchestrator choice is allowed
only *inside* the bounds set by user/project policy** (§5) — it is not a
precedence level that can exceed policy.

**Policy *loading* is file-level replacement, not key-by-key merge (Crawl).** The
Pass-2 "project > user" precedence is realized at *file* granularity, not by
merging the two documents:

```
project  <project>/.forge/model-policy.yml  — if present, IS the entire policy
else     ~/.forge/model-policy.yml           — the workspace policy
else     legacy resolution                   — runtime.models[alias] (forge's built-in default; behavior unchanged)
```

This matches forge's existing "project file wins" override pattern for workflows
and runtimes, keeps the resolver deterministic and easy to explain, and avoids
inventing merge semantics for profile catalogs / defaults / fallback / allowed
lists before a real use case demands them. It also avoids a project policy
silently inheriting a user/global `allowed_profiles`. Key-by-key merge can be
added later behind `loadModelPolicy` if ergonomics demand it (a project wanting
to retarget *one* agent while inheriting the rest).

*Future note (Run, not Crawl):* when bounded orchestrator choice lands, a
global/admin `allowed_profiles` may become a **ceiling** over project policy, so
a project can't silently expand orchestrator autonomy. Off by default today, so
not solved in Crawl.

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

**Tool-capability gate (FG-339, 2026-06-21):** a second fail-loud gate runs at
dispatch time for pi-runtime profiles. Pi fronts arbitrary upstream models of
unknown tool-calling quality; a structured role (engineer, red-*, etc.) on a
non-capable model dies mid-stream with a cryptic rejection. The gate refuses
early with a clear message naming the role, profile, model, and the fix. The
discriminator is the existing `requiresStructuredResult(role)` axis
(`src/v2/role-capabilities.ts`), NOT a new `requiresTools` flag — nearly every
role uses tools, so the meaningful distinction is "must produce structured
result.json" (no FG-337 backstop) vs. "narrative output" (FG-337 catches it).
Default: non-pi runtimes are CAPABLE; pi runtimes are NOT CAPABLE unless the
capability entry sets `tool_capable: true`. This targets the real failure surface
(Groq/Ollama via pi) without touching any existing working policy.

### 7. Staging — Crawl / Walk / Run (same vocabulary as the observability roadmap)

> **Status — Crawl SHIPPED (2026-05-31, #220).** Landed: opt-in `model-policy.yml`
> schema + loader; the two-pass resolver (`src/v2/model-resolution.ts`) with the
> precedence in §3; resolution record persisted on the task row + `manifest.json`;
> lifecycle events `model.profile_resolved` / `model.profile_unavailable`; the
> fail-loud availability gate; `forge model resolve` + `forge providers doctor`;
> and the profile-pin surface — `forge invoke --profile` (one agent) and
> `forge new --profile` (whole run, `resolvedBy: run.profile`). Control-plane
> metadata (`designDir`/`authProfile`/`modelProfile`/`workspace`) is stripped from
> task inputs and rejected from `--meta`. Claude-only across bedrock/api/
> subscription; no second provider, no usage-parser yet. **Walk (#224)** and
> **Run (#225)** remain as planned below.

**Crawl — resolution engine + Claude auth modes.** Build `model_profiles` schema,
deterministic resolution with the precedence above, per-agent/activity overrides,
auth-mode pinning, fail-loud default, and the observability surface (§8). Ship with
**Claude only**, across bedrock/api/subscription as pinnable profiles. Proves the
policy model and auth-pinning with **zero new-provider risk** and no usage-parser
work yet. Realizes **goal 2** (user override per agent/activity), **goal 3**
(single-provider mapping), and the **mechanism** for goal 1 — including
*within-provider* per-activity defaults (e.g. `review → sonnet`, `reasoning →
opus`). Goal 1's motivating *cross-provider* case (design agents default to Codex)
is only realizable once a second provider exists — that lands in **Walk**.

**Walk — Codex/OpenAI as a real second provider.** Add a `codex-*` runtime YAML +
the Codex **usage-parser hook**, and a smoke task running a red through Codex
without touching workflow YAML. Proves the interface is real, not theoretical.
This is where the Layer-1 usage work actually lands. (Inherits the #220
acceptance criterion "a smoke task runs through a second provider without
changing workflow definitions" — that was always Walk, not Crawl.)

**The Claude-coupling seams Walk must generalize** (mapped post-Crawl, against the
shipped code — this is the work list, not aspiration):

1. **`captureUsageForTask`** (`src/store/model-calls.ts`) hard-parses claude-code
   `--output-format=stream-json`; called from `runNext.ts` and `invoke.ts`. This
   IS the per-provider **usage-parser hook** — route parsing by the resolved
   provider. Largest Walk item; the Layer-1 usage work, and the first real proof
   the hook is provider-shaped rather than claude-shaped.

**Codex execution model (decided 2026-05-31).** Codex runs as a **container CLI**,
not via the OpenAI API. The runtime invokes `codex exec --json -m <model> --cd
/project -` and parses the **Codex CLI event stream**. Forge must NOT assume the
claude-code `--output-format stream-json` event shape — the codex parser is a
distinct hook implementation keyed on provider. **OpenAI-API-direct is rejected
for Walk**: it would make forge own the agent loop (tool execution, approvals,
streaming, result discipline, sandboxing), which cuts against forge's model where
the *containerized agent runtime* owns the loop and forge owns lifecycle/
scoping/mounting. A much larger architectural step, off the table for Walk.

**Walk W1 plan (revised 2026-05-31, against the local CLI).** Local Codex auth is
**ChatGPT subscription**, not API key (`codex doctor`: `~/.codex/auth.json`, mode
`chatgpt`, stored API key false). And `agent-dev-worker:latest` does **not** ship
Codex (`command -v codex` → 127; the Dockerfile installs `@anthropic-ai/claude-code`
only). So W1 leads with **subscription**, not apikey:

1. Add the Codex CLI to `docker/agent-dev-worker.Dockerfile` (image rebuild).
2. Add `seeds/runtimes/codex-subscription.yml` invoking
   `codex exec --json -m ${MODEL} --cd /project -`.
3. `RUNTIME_BINDING`: `openai/subscription → codex-subscription`.
   `openai/api → codex-apikey` is a **later** second mode, not first.
4. **Auth handling (hard constraint):** never pass `~/.codex/auth.json` through
   prompts or logs. Either a forge-managed auth volume (the claude-oauth model) or
   a read-only mounted auth file copied into a writable container `CODEX_HOME`
   (the bedrock model — codex refreshes tokens, so the in-container copy must be
   writable). Decision pending; mirrors the AWN-6/AWN-8 secret discipline.
5. **Keep `claude-bedrock` as the regression path** — the user runs Bedrock at
   work. Walk must prove **mixed** policy (codex + claude coexisting), not replace
   work auth. Target shape:

   ```yaml
   overrides:
     agents:
       red-security: claude-bedrock
       red-wide: codex-subscription
   ```
2. **`RUNTIME_BINDING`** (`src/v2/model-resolution.ts`) has only an `anthropic`
   row and fails loud otherwise. Add `openai → { api: codex-apikey, subscription:
   codex-subscription }` + the two `seeds/runtimes/codex-*.yml`.
3. **`detectAuthMode`** (`src/v2/model-resolution.ts`) maps Claude env
   (`CLAUDE_CODE_USE_BEDROCK`/`ANTHROPIC_API_KEY`/AWS) for `auth: auto`. openai
   auto-detection differs (`OPENAI_API_KEY`, codex subscription; no bedrock) —
   make it provider-aware.
4. **`failure_kind` classify** — review against Codex's error/exit surface; a
   provider whose errors don't map into the existing taxonomy violates #220's
   "failures map into the same failure_kind taxonomy" acceptance.

What is NOT a seam (already provider-neutral, confirmed): the `model-policy.yml`
schema (`provider` is an open string, fails loud at the binding table — no schema
bump for a new provider); workflow YAML + task contracts; the resolution
precedence; the lifecycle/event surface.

**Walk-prep / hardening (do FIRST, no Codex code, no behavior change today):** the
availability path is provider-blind — `probeAuth(mode)` checks `ANTHROPIC_API_KEY`
for *any* `api` auth, and `checkResolvedAvailability` / `doctorReport` ignore
`provider`. Today only `anthropic` resolves (unknown providers die at
`bindRuntime`), so it's latent — but threading `provider` through the probe NOW
makes Walk's Codex addition a localized extension instead of a mid-Walk signature
retrofit. This is the first prep slice.

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
  static by default, `--check` runs availability probes; also reports
  `tool_capable` / `dispatchable` verdict for pi profiles so incompatibilities
  are visible before any container starts — FG-339);
- be diagnosable via **`forge providers doctor`** (which providers have working
  auth in this env).

Lifecycle events: `model.profile_resolved`, `model.profile_unavailable`,
`model.fallback_applied`. (failure_kind taxonomy stays a payload field, per the
event-stream invariant — not a new column.)

### 9. Cost tier is a coarse, hand-maintained label

`cheap | standard | premium` per **model in a profile's map** (not per profile —
a profile spanning `fast`/`reasoning` mixes tiers), **not** a computed dollar
figure. Prices drift and OAuth/subscription has no per-token cost (why
`model_calls` dropped its cost column). Guardrails reason over the qualitative tier
of the *resolved* `(profile, model)`.

## Resolved open questions

- **Capability-alias vs explicit model in workflows** → **alias.** Version-proof,
  provider-neutral; the indirection is the point.
- **`on_unavailable` default** → **fail loud**, per-profile opt-in to fallback.
- **First second provider** → **Claude across auth modes first** (Crawl), then
  **Codex** (Walk). Sequenced.
- **Cost tier qualitative vs numeric** → **qualitative first.**
- **`activity` on steps** → inferred from agent role by default; explicit override
  allowed via the step's capability field (Pass 1 item 1) — e.g. `activity: review`.
  **Crawl shipped this on the existing step `model:` alias; #227 (post-Walk) renamed
  the field to `activity:`** to match this vocabulary (`defaults.activity`) and stop
  it reading as a concrete-model hint. The legacy `model:` spelling is still accepted
  as a deprecated alias (Zod preprocess, warns once) so existing workflows don't
  break. There is still ONE capability field per step — not a separate
  capability-plus-model-hint pair; nothing needs that yet.
- **Project policy defining new profiles** → allowed; but `allowed_profiles`
  (admin/global) bounds *orchestrator* autonomy regardless.
- **Full broker / control plane** → **rejected as first implementation.** Revisit
  only if Crawl/Walk/Run prove insufficient.

## Consequences

- New file: `model-policy.yml` (global + per-project), Zod-validated.
- New schema: `model_profiles` (each: `provider`, `auth: auto|bedrock|api|subscription`,
  capability→model `map`, per-model `cost_tier`), `defaults.activity`,
  `overrides.agents`, `allowed_profiles`, `on_unavailable`. **Touches `~/.forge/forge.db` only if the
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
