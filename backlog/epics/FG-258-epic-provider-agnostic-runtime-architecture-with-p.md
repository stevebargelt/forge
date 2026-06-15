---
id: FG-258
type: epic
status: active
title: "[EPIC] Provider-agnostic runtime architecture, with Pi as the pilot/default candidate"
---

**PRD:** `docs/prds/provider-agnostic-runtime-pi.md`.

**Goal:** Build Forge's provider-agnostic runtime architecture, using pi (pi.dev, npm `@earendil-works/pi-coding-agent`) as the pilot and possible default runtime where it proves reliable. This is not merely "add Pi as a third runtime." The architecture must separate the runtime Forge launches (`pi`, `claude-code`, `codex`) from the upstream provider/model the runtime uses (`anthropic`, `openai`, `groq`, `ollama`, etc.).

Pi is the forcing function because one headless CLI (`pi -p --mode json`) can front many upstream providers and local models. If Forge models that as "provider = pi," the provider seam stays confused. If Forge models it as "runtime = pi, upstream_provider = X, model = Y, log_format = pi-jsonl," the same shape makes Claude Code and Codex compatibility runtimes instead of architectural centers.

**Why:** Multi-provider + local-model access in one integration; cheap/fast reds & triage (Groq/Cerebras/Ollama) fitting the cost-conscious pre-launch stance; reuses Pi-ecosystem browser-tools/skills; makes provider agnosticism real instead of adapter-shaped prose.

**Required architecture corrections:**
- Runtime policy names the executable/runtime mechanics.
- Model policy resolves capability/profile plus upstream provider/model.
- Usage parsing dispatches by `log_format`, not upstream provider.
- Prompt/context injection is explicit and testable: Forge context exactly once.
- Auth strategy separates runtime auth mechanics from upstream provider credentials.

**Pilot integration surface:**
- Docker image: `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` in `agent-dev-worker.Dockerfile`.
- Runtime YAML: `seeds/runtimes/pi-*.yml` carrying runtime/log-format/prompt/auth metadata.
- Invocation: `pi -p "<prompt>" --mode json --no-context-files --provider X --model Y`.
- Auth: env-var API keys per provider (ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY…); OAuth via pre-seeded `~/.pi/agent/auth.json` (like the forge-claude-oauth volume).
- Usage parser: parse `pi-jsonl`; `agent_end` = completion; usage fields mapped in #259 and confirmed by a required live capture before parser acceptance.
- Model mapping: model-policy resolves runtime + upstream provider + model, then passes Pi `--provider/--model`; needs alias translation.
- System prompt: `composeSystemPrompt` -> Pi prompt/context path (the novel mapping; relates to #253 adapter surfaces).
- Errors: pi `auto_retry`/`errorMessage` events -> `model_error` (#228).

**Phasing:** Spike (de-risk usage fields) -> Crawl (minimal pi-apikey runtime, one role end-to-end) -> Walk (model-policy, OAuth, error classification) -> Run (local models).

**Sub-stories:** filed as children that reference this epic (search backlog for "pi runtime" / "pi:").

**Related:** #220 #224 #226 #228 #229 #253 (provider seam + adapter surfaces), #129 (pi-skills).

**Sources:** pi.dev; github.com/badlogic/pi-mono packages/coding-agent (README, docs/providers.md, docs/json.md).