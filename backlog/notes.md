**Last session ended 2026-07-23.**

**Shipped: FG-583** (FG-572 Child 5h — non-atomic host seed cp loop) — `8272e5b`, PR #154, closed with a full AC-evidence grid (all 7 AC met). Host seeds now publish as ONE atomic seed generation (FG-571 one-swap vocabulary), anchored once per invocation and threaded through every dispatch consumer; source trust (assetRoot-derived), destination trust (realpath containment), and generation-manifest integrity as a CLOSED set. The flat dispatch fallback is GONE — no complete generation → a named, repairable refusal (loader single point; doctor NOT INSTALLED + non-zero exit).

**FG-572 CLOSED** (umbrella) — all 7 installed-surface children shipped (FG-577/578/579/580/581/582/583). `77d5913`.

**FG-583 endgame lessons:**
- The review-loop drove an architecture decision: the interrupted-first-install / flat-fallback class kept recurring under guard-accretion. Operator chose to MOVE the invariant (remove the flat dispatch fallback; single refusal point) rather than accrete an installing/failed marker.
- The RACI route-preflight change regressed routingGovernance and is dispatch-ADJACENT, not FG-583's invariant. REVERTED to baseline; filed as FG-605 (standalone follow-up, NOT a child of FG-572/FG-561).
- Two CI-only failures that passed locally: (1) migrated integration tests LEAKED a shared FORGE_HOME (fixed: each isolates its own disposable home); (2) fg583-next-refusal auth-hard-blocked before the seed gate on CI (stripped auth → oauth mode; oauth volume has no creds on CI; only passed locally because this session logged in) — fixed to the standard sk-stub apikey pattern.
- Agent unreliability: several engineer invokes exited no_result_json (container-wait bug) but work was on disk — verify on disk before re-running. A batch agent falsely self-reported "integration green twice" from reused container FORGE_HOME state; CI (clean, sharded) is the gate.
- red-security caught a real medium: generation integrity fell through for a file with NO manifest entry (added/torn extra file dispatched unchecked). Fixed: a generation-resolved file absent from the manifest is REFUSED (closed set), workflows + runtimes, with a regression test.

**Follow-ups (non-blocking):** FG-604 (hook repoint sub-ms TOCTOU), FG-605 (route preflight consumes policy from the generation).

**NEXT — FG-553 + FG-561 structurally UNBLOCKED but NOT closed.** All FG-561 slices done EXCEPT FG-553 (Slice 1), whose six children (FG-567–572) are now all closed. FG-553 has SUBSTANTIVE aggregate AC (BD-14 control-plane availability; "machine-wide blast radius ELIMINATED — documenting it does not close this ticket"; R1+R2 provenance) needing an aggregate-evidence walk across the children — NOT a children-are-done rubber-stamp. Once FG-553 closes, FG-561 (epic) closes (all other slices already done). Deliberately not rushed at the tail of the FG-583 session — a dedicated reconciliation.

**External state:** Writer clone ~/code/forge-agent-work on main synced to origin (77d5913); branch feat/fg583-atomic-seed-generation merged + deleted. Control checkout ~/code/forge main has 4 UNPUSHED local commits (competitive-research docs + a working-plan backlog file) predating FG-583 — DIVERGED from origin (not fast-forwardable). Left untouched; operator should rebase them onto origin/main. forge runs npm-linked from the control checkout.
