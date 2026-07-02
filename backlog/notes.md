**Last session ended 2026-06-30.**

**Where we left off:** Just merged FG-423 (PR #2 — campaign items now execute real workflows, not a hardcoded engineer invoke). Offered the user three loose-end follow-ups and was awaiting their pick when the session ended.

**Picked up next:**
1. **Abandon the stale planned campaign `campaign-35b6361975ec`** (non-ticket cleanup, not a backlog item). It bundled FG-421 (now shipped) + FG-357/FG-376, and FG-357's readiness was never resolved. Run `forge campaign abandon campaign-35b6361975ec` (terminal — confirm with user first; abandon is irreversible).
2. **Re-plan the FG-357 + FG-376 sequential campaign** — now VIABLE because FG-423 makes campaign items run the full feature workflow (architect/planning/reds/Shipping-Reviewer). BLOCKER first: FG-357's body uses `**Scope**`/`**Acceptance**` bold markers, so the readiness gate flags it `needs_refinement`; reformat it to `## Problem` / `## Goal` / `## Acceptance Criteria` (content already maps; no AC change) before it will dispatch. Then `forge campaign plan --tickets FG-357,FG-376 --mode sequential` -> approve -> start. Do NOT parallelize; FG-376 strictly after FG-357.
3. **FG-422** (forge workflow skills: campaign / deep-review / backlog / deep-research) — filed this session, unstarted.

**External state to remember:**
- **Workflow reversed to branch+PR (2026-06-30):** forge-on-forge now lands on a feature branch + PR, NEVER direct-to-main; user merges; still no CI/squash unless asked. (Memory feedback_no_ci_pr_direct_to_main updated.) OPEN QUESTION for the user: backlog-only ticket-filing commits were still made direct-to-main as a judgment call — confirm whether even those should go through a PR.
- **Campaigns now pause at human gates per item.** A campaign of feature-workflow items pauses on every gate:human (architect, tech-lead) and on blocked_by_red — it is a resumable stepper, not fire-and-forget. Expect manual gate-advances when running the FG-357/FG-376 campaign unattended.
- `.forge-scratch/` accumulated brief files this session (untracked, not gitignored) — safe to delete.

**Decisions worth not relitigating:**
- FG-423 outcome gating: `shipped` requires a passing authoritative verdict AND a passing done-audit (real evaluateDoneAudit); failing/unknown done-audit, abandoned/failed run, or empty/inconclusive verdicts -> `blocked`. This was a user-caught P1 (AC required "plus done-audit"); do not revert to verdict-only.
- FG-423 drive loop distinguishes GATE TYPE: auto-advance gate:auto and gate:verdict-all-pass; park ONLY on gate:human and blocked_by_red; campaign-item lifecycleStatus=awaiting_gate is reserved for a real human decision. Do not reintroduce "park on any awaiting_gate".
- Single-agent invoke is the EXPLICIT, plan/report-visible escape hatch (executionMode:invoke); workflow:feature is the default.
- Build-fanout test-step trap: a dedicated build step that tests the other steps' code idles in isolation (FG-423 step 4 idle-timeout) — fold tests into their impl step or leave integration tests to the verify-phase test-engineer. (Memory updated.)
- Skipped an independent red pass on FG-423 by design — the user's own deep production-path review WAS the adversarial pass (caught 3 findings, 2 P1).

**Shipped (for reference):**
- FG-421 — shipping-reviewer operator-contract enforcement rubric + seed guard (PR #1).
- FG-423 — campaign items execute configured workflows; gate-type auto-advance, done-audit-gated outcome, report traceability, brief-supplied startRun with clean failure containment (PR #2).
- Filed FG-422 (workflow skills) — still active, not started.
