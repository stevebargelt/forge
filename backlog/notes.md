**Last session ended 2026-07-07.**

**Where we left off:** Overnight autonomous batch fully landed (campaign-6cc65ccc6519 `complete`/`all_shipped`) and the operator's post-batch review findings were fixed same-session (FG-486 shipped, FG-487 filed). Everything pushed, tree clean. Operator's last signal before the batch: queue work deliberately, don't sprawl.

**Picked up next:**
1. **File + work the campaign-autonomy set: review F2b/F6/F7/F9 + FG-485.** NOT yet ticketed except FG-485: F2b (driveWorkflowItem no-progress bound), F6 (campaign transient-failure retry verb), F7 (catch-and-park on drive-path throws), F9 (notifications on task failure/campaign pause — pairs with FG-487's visibility ask). With FG-485 (active, repro'd live) this set makes campaigns genuinely unattended — tonight's flow needed hand-driving after every human gate. The review's section 4 is the spec source (notes/forge-engineering-review-2026-07-06.md).
2. **FG-477 slice 1 — the task-lineage classifier.** The full slice plan/decision table now lives IN the ticket body (durable, pasted from the architecture artifact). File slice 1 as its own ticket off that plan; do not start the whole evaluator.
3. **Ticket the FG-377 persistence false positive** — hit twice tonight (in-run fixers task-engineer-7bc36b and task-engineer-889edb: result claimed complete, watchdog said nothing persisted, git showed the full diff). 3+ occurrences; the settle-window fix has a real gap. Evidence in the task rows + notes/autonomous-decisions-2026-07-07.md.
4. **FG-474 (CI)** keeps rising in value — every review-loop burns ~8 min of local suite per round; tonight ran the suite 10+ times.

**External state to remember:** the pre-existing stuck run `run-fg-425-e1dd27` still wants `forge ops repair` (autonomy: ask — operator call). Two failed-but-false-positive fixer task rows sit in shipped runs as preserved evidence — do not mutate or "clean up".

**Decisions worth not relitigating:**
- **invoke_chain classification (FG-486):** task-level recovery treats invoke_chain like invoke (no finalize — v2/run-kind.ts owns the predicate); run-level reconcile completion stays LITERALLY invoke-only (chain progression is executor knowledge, pinned by test); auxiliary invoke tasks inside pipeline runs stay conservatively refused until FG-477's classifier can identify them.
- **All-invoke-lane parking (FG-483) is intended:** campaign items park at awaiting_gate until merge-to-base + reconcile; drive-time finalize evaluates evidence only, never executes host commands, never auto-merges.
- **abandoned→complete guard is store-universal (FG-484):** updateRunStatus itself refuses it; completeRun CAS is active-only; #201 reactivation deliberately preserved; blanket once-terminal-refuse-all was rejected.
- **FG-480 was filed in error and closed by the operator** — don't refile noise-caliber cosmetic tickets; same for the review-loop's retry-policy <id>-threading nit (journal-deferred).
- **Do NOT touch the repo (even backlog commits) while a review-loop is in flight** — bit twice: an untracked ticket file got deleted by the loop's tree restore (number reused → recover-continue ticket is FG-481-era history, see PR #53 stale refs), and a mid-loop backlog commit rode into PR #59.
- Review-loop quiet startup is ~8 min of silent host verification — normal, don't kill it (FG-487 tracks making it visible).

**Shipped (for reference):** FG-479 (PR #53/#54 — reconcile pipeline-task guard + retry-command wording), FG-481 (PR #55 — recover --continue pipeline refusal), FG-482 (PR #56 — atomic blocked_by_red + unconditional gate re-check), FG-483 (PR #57 — campaign lane evidence gate), FG-484 (PR #58 — abandoned→complete store CAS + shared finalize helper), FG-486 (PR #59 — invoke_chain reclassification). Campaign campaign-6cc65ccc6519 all_shipped. FG-477 architecture artifact delivered (in-ticket). Filed: FG-485, FG-487. Decision journal: notes/autonomous-decisions-2026-07-07.md (host-local).
