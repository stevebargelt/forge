# Autonomous Run Prompt

Use this prompt when starting a long autonomous Forge session. Replace only the backlog item list unless the run has special constraints.

```text
Run this as an autonomous work session.

Backlog items to work, in priority order:
- <FG-###>
- <FG-###>
- <FG-###>

Work them in order. If a ticket is already closed, verify that fact and skip it rather than reopening or duplicating work. If a ticket depends on another active item, record the dependency and move to the next safe item.

Campaign Mode
- Use a Forge campaign as the default execution surface for this ordered backlog batch.
- Plan the campaign with the listed tickets in the listed order, using Forge's routing/sizing layer to assign each item an execution lane. Do not silently route every item through `full_feature`.
- The campaign plan must show each item lane and rationale before approval. If the plan has unclassified items, unsafe default lanes, stale tickets, missing dependencies, or ambiguous verification policy, stop only for a true hard-stop; otherwise choose the safest documented recommendation, record the decision in the journal, and continue.
- Approve and run the campaign autonomously after the plan is coherent. Record the campaign id, plan hash, item order, lanes, and any lane-escalation decisions in the journal and final handoff.
- If an item outgrows its lane, use the campaign's escalation/re-plan mechanism. Escalate automatically when the code/policy makes the correct lane clear; stop only if escalation requires a product-scope decision that cannot be inferred.
- If the campaign runner itself blocks, wedges, or cannot dispatch the batch correctly, do not silently work around it. Record the durable evidence, file or update the relevant campaign-runner backlog item, then continue with direct per-ticket execution only for safe independent work. The final handoff must clearly say which work ran inside the campaign and which work bypassed it, with the reason.

Default Behavior
- Default to your recommendation and do not stop for human intervention unless there is a true hard-stop condition.
- For routine engineering, review, routing, and low-risk disposition decisions, choose the recommended path, continue, and journal the decision.
- Keep a timestamped markdown decision journal under `notes/` with every decision you would normally ask me about. Each entry should include ticket/run/task, decision, alternatives considered, rationale, risk, and any follow-up.
- End with a handoff in `backlog/notes.md`: completed work, PRs opened/merged, tickets closed/left open, tests/reviews run, autonomous decisions recorded, blockers, and recommended next action.

Hard Stops
Stop and ask before:
- destructive action or data deletion;
- preserved-evidence mutation;
- credential/auth/payment/legal/security approval;
- force-push or history rewrite;
- irreversible trust-gate ambiguity;
- overriding legacy review control-plane state after the evidence-led checks are satisfied;
- an accepted_risk disposition that changes a stated threat model, invariant, or acceptance scope;
- product-scope decision that cannot be inferred from backlog, policy, or code.

Review (the evidence-led review — the DEFAULT; docs/prds/evidence-led-review-lifecycle.md)
- This is the standing policy for landed implementation work, not an interim one. Change 3 (FG-640) shipped, so the Change-0 interim policy that stood here is RETIRED: the finding ledger is durable rows (`reviews` / `review_findings`), not entries you keep in the journal, and the `review_disposition` gate reads it. It still supersedes the former repeated review-loop closeout path: do not rerun a review pass until it happens to come back clean, do not rely on fixer-per-round remediation, and never treat a reviewer pass as, by itself, evidence that earlier findings were resolved.
- Transport is `forge review`, not `review-loop`. `forge review start <ticket-id> --contract <file> --route <route>` opens the review and drives Stage 1; `forge review continue <review-id>` runs the next stage from persisted state (so a crash resumes rather than repeating discovery); `forge review show <review-id>` names what is open; `forge review disposition` records a decision with the evidence its value requires. `forge review-loop` is DEPRECATED (it prints a deprecation note naming `forge review`) — reach for it only when the coordinator cannot be used for a reason you can NAME, and journal that reason; its output is reviewer input, never a ledger, and its stop reason is never the completion signal.
- For any ticket producing code or operating-policy changes (campaign lane or direct execution), run this sequence after implementation. The coordinator enforces every step when you drive one through `forge review`:
  1. Deterministic verification BEFORE model review: confirm the change's deterministic gates are green at the exact sha (CI / evidence reuse per Testing And Verification) before dispatching any reviewer.
  2. Confirm the review contract against the final diff. You may ADD a lens with recorded diff evidence; you may not REMOVE one or change the threat model without the authority that approved it. Forge never infers lenses from file paths.
  3. ONE risk-targeted discovery pass over the selected lenses — not repeated open-ended sampling. Discovery is complete only when EVERY selected lens has a schema-valid, reviewer-authored outcome; an authored `inconclusive` IS an outcome and becomes a finding to disposition.
  4. Explicitly disposition EVERY finding before any fixing, exactly one each: fix_now; rejected_premise (requires candidate-bound disproving evidence); deferred (requires a durable destination — a filed ticket, cited by number); accepted_risk (requires the applicable authority — operator authority whenever it changes a stated threat model, invariant, or acceptance scope, which is a hard-stop in an autonomous run); duplicate (cites a canonical finding in the same review); architecture_question (operator conversation, never a fixer).
  5. Send ALL current fix_now findings to ONE fixer in ONE immutable, candidate-bound FixBatch naming each finding ID with its evidence. Not one fixer per round.
  6. Docs reconciliation, then deterministic verification AFTER the batch fix, at the post-fix sha. Docs runs first because it may itself move the candidate.
  7. Recheck the KNOWN finding IDs exactly (does each specific mechanism still exist), and run bounded discovery over ONLY the batch-fix delta. Not another open-ended pass.
  8. Resolution requires evidence PROPORTIONAL to the finding's original reachability. A demonstrated finding needs a named regression test or a replayed reproduction; model re-inspection never closes one. A skipped test is never evidence — a cited test must have EXECUTED at the candidate sha, verified per test rather than by a suite exiting green. Absence from a later reviewer's output is NEVER resolution.
  9. Record and disposition genuinely new findings from the delta review or the shipping review like any other; lateness confers no authority, neither to block nor to settle, and they do NOT automatically begin another discovery/fix loop — another cycle is a fresh, explicit decision (journal it).
  10. A selected reviewer that crashes, times out, or produces missing/malformed output leaves the review INCOMPLETE — not a clean result. An absent lens clears only by retrying it, amending the contract through its approving authority, or an authorized acceptance that NAMES the missing evidence (`forge review accept-lens <review-id> <lens> --operator --missing-evidence "..." --rationale "..."` — an operator decision, so a hard-stop in an autonomous run). Never synthesize a pass or an empty finding set.
- On a migrated workflow (`review_mode: evidence_led` — `feature` today) the reviewed step is settled by the `review_disposition` gate reading that ledger, not by verdict aggregation. It parks at `awaiting_gate` as before; `forge gate <task> advance` refuses while any blocking condition holds and names each. `--force --rationale "..."` remains the human override and is NOT the ordinary settlement path — settling the ledger is.
- All existing deterministic and authority gates are unchanged: the required CI merge gate (test AND test-extended), the acceptance-evidence closing gate, reviewed-tip equality, candidate-identity and publication rules, and human-authority gates.
- If legacy control-plane state (a review-loop stop reason or withheld closeable) blocks after every evidence-led check is satisfied, surface it as the existing explicit human decision — a hard-stop with the settled ledger as evidence. Do not manufacture a passing verdict through repeated sampling.
- Do not run this review sequence for pure backlog cleanup, ticket filing, notes-only updates, or clearly docs-only edits unless the change affects operating rules.
- On this host, launch long review passes detached using the known reliable detached/session-leader method rather than tracked background execution. Record how the pass was launched and where its log is.

Monitoring Detached Work
- Monitor Forge-launched work by durable Forge state first: task/run status, result artifacts, campaign item state, and explicit terminal markers in logs.
- Do not use `pgrep -f <role|ticket|command text>` or process-name matching as the wait condition. On this machine, long-lived Codex/Claude processes may carry conversation text in argv and can falsely match unrelated role names such as `documentation-maintainer`.
- If process liveness and Forge state disagree, trust the durable Forge state for completion, record the discrepancy, and run `forge show`, `forge ops check`, or reconcile before retrying or declaring failure.
- For non-Forge detached commands, monitor a unique artifact: an exact launched PID/pidfile, a wrapper-written terminal marker, a result file, or an explicit exit-code file. Process-name search is only a debugging aid, never the source of truth.

Container Diagnostics And Retention
- When a task container disappears, stops producing output, or a result is missing, do not describe it as "harness killed" or assume any other unproven cause. Run `forge show <id> --diagnostic` to see the causal evidence Forge captured (container id/name, startedAt/finishedAt, Docker exit code, signal, `OOMKilled`, Docker `State.Error`, and whether a `container.exited` event was observed) and the explicit list of what evidence is missing.
- `forge show`, `forge status`, and `forge ops check` each distinguish four states: confirmed container exit with code/signal/OOM evidence; container missing with no terminal event recorded ("container disappeared without terminal evidence"); a fanout parent's derived failure with no agent container of its own (never label this a killed agent); and a result missing after a clean container exit. Use the matching language in journals and handoffs instead of inferring a cause from symptoms.
- Failed task containers are retained after exit by default so they stay inspectable for this kind of investigation. Set `FORGE_CONTAINER_RETENTION=off` to disable retention entirely (e.g. on a disk-constrained host); otherwise containers are kept on failure and reaped automatically before `forge retry` relaunches the same task id, so retention does not block retries.
- A retained failed container may still hold injected secrets (auth tokens, API keys) in its environment or filesystem and there is no automatic time-bound reaper — it is the operator's responsibility to run `forge ops reap-containers` (or set `FORGE_CONTAINER_RETENTION=off`) once an investigation is complete, rather than leaving it inspectable indefinitely.
- Use `forge ops reap-containers` to clean up retained containers past their retention window once an investigation is complete, rather than removing them by hand.

Testing And Verification
- Use the repo's normal deterministic gates for the ticket.
- Do not pre-run the full host suite immediately before launching the discovery pass. The review's own Stage 1 verification (CI wait / evidence reuse — and the same for review-loop when it is the named fallback transport) IS the "deterministic verification before model review" step — do not duplicate it with a host run unless there is a specific reason to run a focused check first.
- Before claiming a ticket is shipped, ensure host verification appropriate to the change is green and durable. The required CI checks (`test` AND `test-extended`) are the merge gate; review-loop and campaign reconcile both reuse a passing host_verifications row or whole-workflow-green CI at the exact commit (every job of the project's CI workflow green — a green fast job with a red/pending sibling never covers) instead of re-running typecheck+test, so do not repeat the same root suite just to prove a fact CI or the loop already covered — only run missing coverage, such as a workspace suite not covered by either.
- Do not re-run `npm run test:all` on the host yourself once the required CI check is green for the commit — CI is the durable closeout evidence now (see CLAUDE.md's "Merge authorization"). Record why any extra suite run was necessary; otherwise avoid duplicate full-suite runs.
- Do not use bare `npx tsx --test`; it can write into the real `~/.forge`. Use the project test commands or the repo's test setup import explicitly when running focused node tests.
- If a command is interrupted or killed, inspect durable run/task state before assuming failure.

Merge And Close Policy
- Use feature branch -> PR -> evidence-led review + verification -> merge.
- If BOTH required CI checks (`test` and `test-extended` — FG-495) are green and required reviews pass (the evidence-led sequence complete, every finding settled with evidence), you may merge without human PR review. A green fast `test` job alone never authorizes merge or ship.
- Close the backlog item only after merge evidence is durable.
- Do not silently close a ticket whose acceptance criteria are only partially met.
- Engineers/fixers must not close/move their own implementation backlog item; backlog closeout is orchestrator closeout after merge and verification.

Backlog Growth Discipline
- The session should converge: do not open more backlog than necessary.
- Do not file active backlog tickets for low-severity pass-notes, hypothetical hardening, exhaustive-test requests, or maintainability polish unless at least one is true:
  - the issue is correctness, safety, trust-gate, data-loss, wrong-ship, or security relevant;
  - it is user-visible operator pain;
  - it blocks the review sequence from settling (a finding that cannot be dispositioned or closed without it);
  - it requires a product decision;
  - it is a repeated pattern across multiple runs.
- Low-severity review residue that does not meet that threshold belongs in the decision journal under "deferred review notes", not in active backlog.
- Batch related low-severity findings into at most one follow-up per subsystem, or fold them into an existing relevant backlog item.
- The final handoff must include backlog delta: tickets closed, tickets opened, why each opened ticket met the threshold, and any review notes intentionally not filed.

Scope Discipline
- Preserve unrelated user changes.
- Do not mutate preserved-evidence campaigns/runs unless the current prompt explicitly says to clean them up.
- Do not claim root causes that are not evidenced; distinguish evidence from inference.
- File follow-ups only for genuine new scope that meets the backlog-growth threshold above.
```
