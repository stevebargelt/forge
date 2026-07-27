**Last session ended 2026-07-27.**

**Where we left off:** FG-566 shipped and closed (`79fba76e`, PR #166), FG-627 closed with its AC
grid. FG-566 was the blocker, so **FG-621 AC 11 and FG-345 default-on are now unblocked.** The run
was driven end-to-end autonomously while the operator was away; five forge defects fell out of it.

**Picked up next:**

1. **FG-621 AC 11** — the only open criterion on FG-621. Re-run the dogfood **WITH isolation** now
   that FG-566 has landed, and verify from durable state: task workspace under
   `~/.forge/worktrees/clones/`, `tasks.base_sha` recorded, the agent's commit on
   `forge/<runId>/<taskId>`, parent unchanged apart from the capture fetch. Then the full AC walk +
   Acceptance Evidence grid and close. Remember `forge launch run` does NOT propagate caller env
   (FG-626) — use `forge launch run --name X -- env FORGE_WORKTREES=1 <cmd>`.
   Also per the operator's rule: re-run `./scripts/fg621-clone-boundary-smoke.sh` against the FINAL
   sha, not the superseded `09fd810c` capture.
2. **FG-345** — after AC 11, the aggregate walk. Note the standing constraint: Linux hard-fail is
   inherited, so FG-621's evidence is macOS-only and cannot alone justify a universal default-on
   flip. FG-345 closeout must choose macOS-first or lift the gate.
3. **FG-628** — the highest-value of today's new defects, because its second half silently degrades
   every pipeline: a red that crashes before starting its container ingests as non-blocking
   `inconclusive`, so a gate opens with zero adversarial review and looks normal.

**Operator behavior change that affects daily dogfooding (FG-566):**

`forge review-loop` defaults `--project` to cwd, and readiness now refuses **unconditionally** when
the target workspace overlaps the forge checkout the process is executing from. Run inside
`~/code/forge` it stops with a classified `self_host_workspace` refusal instead of reviewing. That is
correct — an install there would delete the running orchestrator's own `better-sqlite3` bindings —
but it means **Forge-on-Forge review-loop must pass `--project <clone>`**. The seed and its rendered
`CLAUDE.md` region say so now.

**New tickets filed today (7).** Five are forge defects found only by driving a real pipeline:

- **FG-628** — reviewer dispatch crashes on any project directory missing a *workspace-member*
  `node_modules`. The reviewer path mounts every planned member volume `:ro`; the non-isolated
  primary path uses the single legacy volume and never hits the multi-volume plan, so **only reds
  die**. FG-627's premise ("a main checkout has node_modules present") holds for the root member and
  fails for every other. Second half: the crashed reds ingested as `inconclusive (0.00)`.
- **FG-629** — `forge retry` on a failed RED re-dispatches the **step primary** under the red's role
  label. Two retry calls cost a duplicate architect artifact, an extra red wave, a third pending
  duplicate that had to be cancelled, and the original artifact still unreviewed.
- **FG-630** — `gate request-changes` does not pass the rejected artifact into the retry inputs
  (`upstream` carries only the prior phase; `rejectedTaskId` is null despite the seeds telling agents
  to check it). The agent revises a plan it has never seen. This caused round 2 of the FG-566 plan to
  silently drop four accepted items.
- **FG-635** — a run marked itself **complete with the guaranteed docs phase never dispatched**. An
  ad-hoc `forge invoke --run` task completing drove run-completion while `docs` sat undispatched.
  Ad-hoc tasks are the normal way to fix a `blocked_by_red` build, so this window is routinely open
  on exactly the runs that needed the most intervention.
- **FG-631 / FG-632 / FG-633 / FG-634** — FG-566 review findings deferred as lifecycle/hardening
  scope (publication `node_modules` retention; unbounded readiness keyspace with no prune surface; no
  warm reuse from `treeSha`+`workspace` keying; setup-command and unredacted stderr persistence plus
  `HOME` forwarding). **FG-625 was widened**, not duplicated: red-backend rediscovered the missing
  readiness preflight at `review-loop.ts:924`, which FG-566's architect deliberately fenced there, so
  FG-625 now owns two defects on one line and must not close having fixed only the naming half.

**Things worth not relitigating:**

- **The orchestrator was wrong about the trust boundary and the reds were right.** The reasoning
  "host verification already executes reviewed code via `npm test`, so restricting the bootstrap argv
  is theater" was withdrawn after five reds converged with concrete evidence
  (`review-loop.ts:561-571` passed `configDir: ctx.projectDir`). The killing argument was repo
  precedent: `dependency-provisioning.ts:74` already validates `package.json` `workspaces` entries
  *specifically* because a crafted entry must never reach a privileged sink. The fix removed
  `configDir` from the request type entirely rather than validating it.
- **The configurable bootstrap stays.** An earlier orchestrator direction to cut it wholesale
  contradicted the ticket's own design boundary. Provenance was the real issue, not configurability.
- **`forge next` dispatches ONE wave** and must be re-run to advance. Advancing a gate does not
  dispatch the next phase.
- **Don't run `forge-dev upgrade` to render a CLAUDE.md change on an unmerged branch** — its dry run
  publishes a new host-wide seed generation (routing policy, workflows, template) for every project
  from branch code. The FG-566 render was done by hand and verified byte-identical to the seed body.

**External state:**

- **ntfy delivery is failing** (`network: fetch failed`) — milestone events record fine but pushes are
  not arriving. Two milestones went undelivered today (`risk_found`, `shipped`).
- `~/code/forge-fg356` is reset to merged `main`, clean. Its `dashboard/node_modules` mountpoint was
  created by hand as the FG-628 workaround; leave it until FG-628 lands.
- WIP backup at `~/forge-wip-backup-20260727T093244/` (5 files) — still deletable.
- Two failed dogfood runs (`…-6c5400`, `…-dogfood-693dbc`) remain as the FG-626/FG-627 record.
- The FG-566 run (`…-0f7edc`) carries a messy task topology from FG-629: two duplicate architect
  artifacts and a cancelled third. Left as the evidence for that ticket.

**The pattern worth naming, because it was 6-for-6 today: silence read as success.** A crashed red
reading as "reviewed, undecided". A retry reading as "red re-run". A `request-changes` reading as
"agent saw the plan". A run reading as "complete" with a phase never dispatched. An ABI check
comparing a value to itself and returning ok forever. A self-host guard ordered behind an early
return so it never ran. Every one produced green output and a confident status. The two things that
actually caught them were **running the real pipeline** and **diffing artifacts field-by-field
instead of reading their summaries**.
