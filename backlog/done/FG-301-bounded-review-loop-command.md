---
id: FG-301
type: story
status: done
title: Bounded review-loop command
---

**Closed:** 2026-06-07.

**Shipped + in active use.** The full MVP + guardrails landed (`forge review-loop <ticket> --max-rounds <n> [--since <sha>] [--review-profile <name>]`: deterministic verification-first, reviewer→fixer rounds, structured pass/needs_fix/blocked verdict, durable run note, never auto-closes unless reviewer pass + verification green, route preflight per dispatch). Adopted as the standard post-implementation review path (#302) with the adjacent-surface reviewer rubric (#305), and exercised across #265/#267/#198/#200/#229/#252 — including live Codex-reviewer runs via `--review-profile codex-subscription`. Closed during the release-0.x triage (it was shipped but left open).

Build a bounded review/fix loop so the user is not the relay between implementer and reviewer.

**MVP:**
- Add `forge review-loop <ticket-id> --max-rounds <n>`; default max rounds 2.
- Accept `--since <sha>` or infer a commit range for the ticket.
- Run deterministic verification first: typecheck + relevant tests when discoverable.
- Spawn a reviewer agent with ticket acceptance, commit range/diff, relevant files, and verification output.
- Reviewer returns structured verdict: `pass | needs_fix | blocked`.
- If `needs_fix`, spawn a fixer agent with only the anchored findings.
- Repeat until pass, blocked, or max rounds reached.
- Write a durable artifact/run note with commit range, verdicts, fixes, tests, and stop reason.

**Guardrails:**
- Never auto-run live spend, credential creation, live DB migration, destructive commands, or ambiguous product decisions.
- Never auto-close tickets unless reviewer passes and deterministic verification passes.
- Findings must be file/line anchored or explicitly marked unanchored. (MVP contract as first shipped; since FG-493 the loop COERCES a finding missing either anchor half to unanchored:true instead of rejecting the reviewer result — red-wide's native contract omits file/line for non-line-tied concerns.)
- Route resolution preflight applies before every dispatch.
- Orchestrator may initiate the loop only after presenting ticket, route, commit range, max rounds, and stop conditions.

**Optional MVP flags:**
- `--implement-profile <name>`
- `--review-profile <name>`
- `--route <key>`

**Non-goals:**
- Do not bake this into model policy yet.
- Do not require multi-provider review to ship.
- Do not implement full provider adapter generation; #283 owns that.

**Future:**
- Promote observed defaults into policy after several real uses.
- Allow low-risk routes to auto-start loops by policy.