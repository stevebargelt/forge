---
id: FG-297
type: story
status: done
title: Route resolution preflight for dispatch commands
---

**Closed:** 2026-06-06.

Guidance now requires `forge route explain` before `forge invoke` / `forge new` (#287), but the CLI still allows raw dispatch from memory. Add a mechanical guard or explicit route-bound dispatch path so orchestrators cannot silently bypass the compiled routing policy. This is the mechanical-enforcement half deliberately left out of #287 (which closed as the adherence/guidance slice).

**Acceptance:**
- A dispatch path can carry a resolved route key / route token from `forge route explain`.
- Raw role dispatch either warns loudly or requires an explicit override when no same-turn route was resolved.
- The warning names the route-before-dispatch rule and suggests the exact route command.
- Tests cover allowed routed dispatch, warned/unrouted dispatch, and explicit override.

**Design sketch (for whoever picks this up):**
- Candidate shapes: `forge invoke --route <route-key>` (carry the resolved key; forge can cross-check it against the compiled policy for the agent), or a one-path `forge route invoke <work-type> ...` that resolves + dispatches together (the longer-term affordance #287 flagged).
- "Same-turn route resolved" detection: a `forge route explain` could drop a short-lived route token / marker the dispatch reads; raw dispatch with no recent token → warn (default) or fail (with `--no-route`/override). Keep the warning actionable (print the route command to run).
- Keep it provider-adapter-generation-free (not #283).

Relations: #287 (adherence slice, closed), #273 (RACI epic), #280 (project overrides), `seeds/orchestrator-template.md`, `src/cli/commands/invoke.ts`, `src/cli/commands/route.ts`.