---
id: FG-339
type: story
status: done
title: "runtime: capability-aware routing — refuse tool-requiring roles on non-tool-capable models (profile capability flag)"
created: 2026-06-21
closed: 2026-06-21
---

The complementary half of FG-337 (inferred-result fallback, shipped). FG-337 handled the *clean-completion-no-result.json* failure mode. This handles the *other* pi/Groq dogfooding failure: a weak model asked to do a tool-requiring job emits a malformed tool call (`llama-3.3-70b` produced `bash{...}` as the tool name) → pi rejects it ("not in request.tools") → the run dies mid-stream with a cryptic error. FG-337 does nothing for this case.

**The discriminator is the EXISTING `requiresStructuredResult` axis — not a new `requiresTools` flag.** Nearly every role uses tools, so "requires tools" is vacuous. What matters: a structured role on a weak tool-caller has no safety net (fumbles the protocol AND can't produce its result), while a narrative role now has FG-337 as a backstop. So the gate is:

    requiresStructuredResult(role) && !toolCapable(model) → refuse at dispatch

Narrative roles pass through; FG-337 catches them. One role axis drives both features (reuse `role-capabilities.ts` as-is).

**Plan / seam:**
1. Policy YAML schema (Zod, additive — no SQLite migration): add optional `tool_capable?: boolean` to the per-capability model entry in `model_profiles[*].map[*]`.
2. `resolveModel()` (model-resolution.ts) stays PURE — read `toolCapable` onto `ModelResolution`, do NOT throw. `forge model resolve` must be able to *report* an incompatibility without crashing.
3. Enforce at the dispatch sites (the `resolveModel` callers in invoke.ts / runNext.ts that spawn): a small `assertDispatchable(role, resolution)` that refuses with a clear message naming role, profile, model, and the fix.
4. `forge model resolve` surfaces the capability + dispatchability so it's visible before dispatch.
5. Refuse, not reroute — fail-fast-and-explain. No silent model swap.

**DECIDED — default when `tool_capable` is unset = option (C):** default capable, EXCEPT models on the `pi` runtime, which are guilty-until-`tool_capable: true`. Anthropic/OpenAI subscription runtimes are known-good and need zero policy changes; the pi runtime fronts arbitrary upstreams of unknown quality, so pi models must opt in. Targets the real failure surface without breaking existing working policies.

Operator-visible: a tool-requiring role on a non-tool-capable (pi) model now refuses at dispatch with a clear message instead of dying mid-run. New optional `tool_capable` policy field.

Relates: FG-337 (shipped sibling), FG-258 (epic), FG-268 (local models — same failure surface).
