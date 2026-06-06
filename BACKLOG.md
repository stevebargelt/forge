# forge — backlog

Canonical task list for forge. Numbers are sticky across sessions and referenced from commit messages (e.g. `fixes #30`, `partial #25`). New items get the next available sticky ID and never get renumbered.

When you start a session, read this file. When you finish, update it: move closed tasks from "Active" / "In progress" to "Done (recent)" with their commit hash; rewrite "Notes for next session" with whatever the next session needs to know.

## Notes for next session
**Last session ended 2026-06-05.**

**Where we left off:** The RACI/routing-policy MVP and post-MVP visibility slices are shipped; #290 closed the Pixtron-surfaced stale-running dashboard gap; and the Pi runtime PRD is accepted/reconciled into the stable-baseline epic (#291). Pi Crawl is underway: #292 created the runtime metadata seam, #260 installed pi in the agent image, #261 added `pi-apikey` and proved spawn can invoke pi. The remaining Crawl work is prompt injection (#263), usage parsing (#262), then the first end-to-end role (#264).

**Picked up next:**
1. **#263 — pi: system-prompt / context injection mapping.** Settle and test "Forge context exactly once" for pi. `pi-apikey` currently uses `prompt_strategy: message-arg` (`--append-system-prompt` + positional task package); #263 should prove that this is correct, not just plausible.
2. **#262 — pi: usage-parser hook.** Add the real `pi-jsonl` parser using a live stream fixture. The #292/#261 state intentionally fails loud for `pi-jsonl` until this lands.
3. **#264 — pi: first role end-to-end through pi.** Close Crawl only after dispatch -> pi -> result.json -> usage captured -> gate works with output-schema parity.
4. **#287 — route-before-dispatch adherence.** Still useful if the orchestrator keeps bypassing `forge route explain`; consider a CLI-dispatch affordance after the prose/template check.
5. **#252 — collaborative setup/new-machine readiness.** Broad product spine: init/upgrade/doctor should generate and validate config rather than asking humans to hand-write YAML.
6. **#283 — provider adapter generation (#253 seam).** Render `CLAUDE.md` / `.claude/commands/*` / hooks / Codex equivalents FROM the routing policy. This becomes more important once Pi/Codex surfaces matter again.

**External state to remember:**
- **`docs/prds/provider-agnostic-runtime-pi.md` is accepted for backlog planning** — reconciled into #258/#262/#265 and included in #291's stable-baseline commitment set.
- **#290 is closed** — dashboard/Ops now surface read-only reconcile candidates instead of stale DB-running tasks as ordinary running.
- **#260/#261 are closed** — pi is installed in the agent image and `pi-apikey` can dispatch/capture stdout. Remaining gaps are expected: `pi-jsonl` parser is #262; result.json/schema parity is #264.
- Host adapter activation is still a host mutation: run `forge upgrade` when Steve wants the latest seeds/templates installed and `~/.forge/routing-policy.yml` auto-recompiled.

**Decisions worth not relitigating:**
- **#288:** the full-vs-quick discriminator is architectural novelty + plan-certainty, NOT file count. Precedent-driven multi-file/cross-cutting work with a concrete plan is `implementation_quick` (test-engineer + docs_impact still mandatory); the full pipeline is for novelty/unclear-boundaries/missing-plan/new-integration/high-risk decomposition.
- **#289:** `docs_impact` is a lifecycle (detect 6 categories → resolve as `updated | not_needed:<reason> | deferred:#ticket` → report a `Docs impact:` summary line); a deferral REQUIRES a filed ticket. It's a PROSE contract (orchestrator + seeds), deliberately NOT machine-enforced (ticket non-goal). A gate rejecting a `complete` implementation run that lacks a resolved `Docs impact:` line would be a separate enforcement story if Steve wants teeth.
- **#286:** init/upgrade auto-compile the derived policy. A standalone policy (no host RACI) is left untouched; an existing host RACI is never overwritten by the compile step (that stays install-seeds FORCE=1's call).
- **#281 governance** SURFACES drift (read-only) but does not enforce — enforcement stays `route validate`'s job. Clean split: validate enforces, governance shows.
- **#280:** project override = full replacement; an uncompiled project override FAILS (never falls back to host); the force-rule-weakening check is structurally enforced but dormant (empty baseline).
- **#279:** apply journals the audit entry write-ahead (WAL ordering) so a change is never applied-but-unaudited; audit = host-global JSONL log, not a git commit.

**Shipped (for reference — git log is canonical):**
- **#279** orchestrator-mediated RACI authoring: `forge raci propose/apply` gated propose→confirm→apply + JSONL audit (49b0e93; audit-first fix b1fb4e5).
- **#280** project override support: `<project>/.forge/` full-replacement resolution, `--project` on explain/validate/compile, force-rule non-weakening check (64b56e5; uncompiled-override fix 1822658).
- **#281** `forge route governance` read-only view + host-vs-project diff + drift surfacing (14ec5ce; drift fix c6c7d90).
- **#285** dashboard read-only routing/governance panel, backed by the shared `governanceView` core (817ed89; test-script glob fix 83ac1d1).
- **#286** init/upgrade auto-compile `routing-policy.yml` from the RACI seed (7f3b81b).
- **#288** routing guidance: novelty-vs-precedent discriminator (20bd191).
- **#289** explicit docs-impact lifecycle across orchestrator-template + implementer/test seeds (7999d11; RACI source alignment c04ef23).
- **#290** dashboard/Ops reconcile-candidate detection (281d060; backlog closeout 09ab063).

## Active

### #130 — Bedrock concurrent-request starvation silently kills a parallel red
**Why:** Caught 2026-05-13 during the #127 forge run's build phase. 5 reds dispatched in parallel (red-wide, red-narrow, red-frontend, red-backend, red-security) at 18:11. Four produced their first stdout within 30s of start. **red-security produced zero stdout for 5 full minutes**, hit forge's idle-watchdog kill at 18:16, container terminated. DB recorded the verdict as default-`inconclusive` (0.5 confidence, empty findings) because gate.ts handles "task failed without writing result.json" by inferring an inconclusive verdict.

**Likely root cause:** Bedrock concurrent-request quotas at the account tier. claude-code retries silently on 429/throttling within its stream-json output mode — no client-visible signal that the first request never went through. Other 4 reds got their slot; red-security got starved. The starved request kept retrying internally but produced no token output, so forge's idle watchdog (no-stdout-for-300s) killed the container before retries succeeded.

**Why this matters:** The gate semantics treat `inconclusive` as informational + advanceable-with-rationale. That's correct for legitimate inconclusive verdicts, but here it papers over an infra failure as if it were a content judgment. From the human's perspective, "one red went inconclusive" reads as "the red found something ambiguous"; the truth is "the red never actually ran."

**How to apply — three layers worth considering:**
1. **Detect zero-stdout idle-timeout kills + surface them differently from "agent reported inconclusive."** The reconcile / dispatch tail in spawn.ts knows the difference (idle-timeout exit code `137`, empty stdout, no result.json). Today it gets folded into `status='failed'` for the task and the gate aggregates it as default-inconclusive. Adding a `task.failed.reason='infra'` distinction would let the gate UI surface "this red didn't run; verdict not meaningful" instead of "this red was inconclusive."
2. **Stagger or limit parallel red dispatch.** Today gate.ts dispatches all reds simultaneously. A semaphore (max 3-4 concurrent) would avoid the rate-limit edge while still being parallel. Adds latency to the build phase but stops the starvation. Probably wrong if the issue is account-tier quota — the 5th still hits the limit when it eventually fires.
3. **Bedrock-side: request a quota increase** or move to a higher-tier model. Outside forge's control, but worth knowing as the architectural workaround.

Lean (1) first — surfacing the failure mode honestly is cheap and the right shape regardless of how the root cause is mitigated. (2) is a tactical fix; (3) is the actual root cause.

**Composite with #74** (reconcile + watchdog can't catch zero-stdout orphans). #74 caught the same shape of failure from a different angle — this is the same dataclass of bug.

**Caught:** 2026-05-13 — during the build phase of the #127 forge run.

### #129 — Shareable agent-skills pattern (future feature)
**Why:** While doing #126 (pair-coding side) on 2026-05-13, the pattern surfaced as something with reach beyond forge. The combination of Mario's Skills-format choice + the symlink-on-host / bind-mount-in-container duality is generally useful — any tool the human and an agent both want (screenshot, eval, search, transcript, calendar) wants both surfaces. The natural product is something like "use Mario's tools from this repo, with a small install dance for both surfaces."

**Not designed yet — this is a placeholder.** Open shape questions:
- Is the deliverable a new repo (`forge-skills`, `agent-browser-stack`), a documented section in forge README pointing at pi-skills, or something else?
- Provisioning model: `install.sh` that takes a list of skills + lays down host symlinks + npm-installs + emits a container mount manifest? A YAML config that forge v2's runtime YAML (#116) consumes? Both?
- What's forge-specific vs. general: `spawn.ts` mount injection and v2 runtime YAML wiring are forge-specific. The Skills-format choice, host-symlink/container-mount duality, and pi-skills install dance are general.

**Don't extract prematurely.** Ship #128 (forge container-side use) first. When a second consumer appears (another project, another team, someone else hitting the same Playwright-MCP token-tax pain), revisit and extract.

**Composes with #116 (forge v2):** runtime YAML may be the natural home for "this runtime gets these skills mounted." That's where to design provisioning if the answer becomes "config-driven."

**Caught:** 2026-05-13.

### #112 — Transactional dispatch + gate writes (reconcile-half landed as #109)
**Why:** Caught 2026-05-12 alongside #109. The reconcile-half of "wrap multi-write per-task sequences in a transaction" shipped on `951824e` (3 writes per task, fault-injection tests, full rollback semantics). The same shape exists in:

- **`src/spine/dispatch.ts:107-128`** — the happy-path tail after the agent container exits. Two writes (setTaskStatus + logEvent), or four if reds get spawned. Trickier than reconcile because the writes flank an async `spawnRed()` call; the transaction boundary has to wrap **only** the writes, not the docker work. Possible split: pre-spawn writes in one txn, post-spawn writes in another.
- **`src/spine/gate.ts:96-122` + `:166-178`** — advance + reject paths. `gate.ts:96-122` performs `insertGate` + `setTaskStatus` + `createPhaseTasks` (which calls insertTask N times) + maybe `updateRunStatus` for terminal phases. All synchronous, all should be one transaction so an advance that fails to create downstream tasks rolls back the gate decision too.

**Why this didn't ship with #109:** scope. #109 as originally filed listed three paths; the right thing in practice was to focus the fault-injection harness on the orphan-recovery path (where the failure mode is most visible — `reconcile` is what re-runs after a crash, so any non-atomicity there gets stuck on retry). Dispatch + gate are less commonly the recovery point: if dispatch fails mid-writes, the next `forge next` re-dispatches; if gate fails mid-writes, the human re-clicks. But the cleanliness argument still stands — these should be wrapped.

**Approach (mirrors #109):**
- Use `getDb().transaction(() => { ... })()` around each multi-write sequence.
- Sprinkle a `_fault(at)` test hook at named points so tests can inject failures without monkey-patching the store.
- Tests: fault-injection rollback + retry-pin (next call after a transient fault recovers cleanly).

**Acceptance:**
- Dispatch's post-spawn write block + (if applicable) its red-spawn-followup writes are each transactional.
- Gate's advance + reject paths are each one transaction covering all writes including createPhaseTasks.
- Each path has at least one fault-injection test asserting rollback + one retry test asserting subsequent recovery.

**Out of scope:**
- Wrapping the async spawn/spawnRed calls themselves (they take minutes; a sync better-sqlite3 transaction would hold the DB lock the whole time).
- Cross-task transactions (one big txn spanning many tasks). Per-task boundaries are the right granularity.

**Caught:** 2026-05-12 — scope-split from #109 at land-time.

### #60 — Use `pass` for host-side secret storage (was previously #47, kept here as it now applies to PROMPT.md design output)
**Why:** Same as the original #47 — secrets like `PENCIL_CLI_KEY` shouldn't sit in a `.env` file forever. With FORGE-DEC-014 the consumer of `PENCIL_CLI_KEY` moves *out* of forge entirely (it's used by the human's host-side Claude Code, not by a forge container). But forge still touches host-side env in `forge auth` and possibly in future host-side tools. Keeping the entry but renumbered to reflect the architectural pivot.
**How to apply:** When forge needs another host-side secret (e.g., for a future GitHub or Slack integration), build the `pass` wrapper then. Until then, this is dormant.
**Status of original #47:** content unchanged but no longer about PENCIL_CLI_KEY-in-container — it's about whatever host-side secrets forge accumulates next.

### #61 — Electron shell investigation (deferred)
**Why:** The dashboard is becoming forge's primary UX (see #57 + FORGE-DEC-014). At some point it should be a native app, not a localhost browser tab. Native menus, native shortcuts, OS notifications, no "is this exposed to the network?" question, no CORS dance.
**How to apply (when):** Don't rebuild the dashboard in Electron from scratch — wrap the existing thing. Once #57 ships and the SPA is mature:
- `BrowserWindow` loads `localhost:port` (or the bundled SPA HTML)
- Add native chrome (menubar, Cmd+G, Cmd+N, status indicator)
- Distribution is a separate problem (signing, auto-updater) — defer until forge has external users
**Revisit conditions:** the dashboard is doing 80%+ of forge's interaction surface, OR you want notifications/menubar/global shortcuts, OR you want to ship forge to anyone else. Until then, browser tab is fine.
Stays here so it's not forgotten.

### #88 — Corpus consistency: propagate new components into affected existing screens
**Why:** Caught 2026-05-08 reviewing phase-flow design output. The pill row (#71) is a new component that, once implemented, will appear above the task list in many existing dashboard screens — 02 (task-list), 03 (task-detail-generic), 05 (task-detail-gate), 08 (task-detail-blocked-by-red), 11, 17, 18, 19, 20, etc. The current design corpus shows those screens *without* pills (drawn pre-pill-row). After implementation: live dashboard shows pills everywhere, corpus shows pills in isolation only. Mismatch.

**The compounding problem:** when the design-reviewer agent (#51) runs comparing implementation screenshots against corpus PNGs, it'll see the pill row in production and not in the design — false-positive "regression" findings or, worse, calibration loss as it learns to ignore real differences. Every future cross-cutting component (notification toasts, status pills, search bars) creates the same drift.

**The right shape: a "corpus consistency pass" after any cross-cutting addition.**
- Different from `ui-design` (no new design) and `ui-design-revise` (revising one design).
- It's: "the new component X exists in screen Y; propagate it into every affected screen in the corpus." Pencil-Claude session that retrofits in place across N existing screens.
- Eventually maybe its own workflow primitive (`ui-design-propagate`?), or a documented post-design-run convention. For now, a manual pass after each cross-cutting design run.

**For the phase-flow run specifically (Steven's call 2026-05-08):** ship as-is; capture this as a real backlog item; do the propagate pass before #71 implementation lands so the corpus matches reality at implementation review time.

**Three implementation options when the time comes:**
1. **Full retrofit in Pencil** — update every affected screen in place. Honest corpus, real time cost. Right answer.
2. **Mark old screens explicitly stale** — annotate ("pre-pills version") to document the gap without fixing it. Cheap, keeps the gap visible. Stopgap.
3. **Versioned corpus** — tag the .pen at the pre-pills state in git, retrofit going forward, old version lives in git for archeology. Combines (1) with explicit version semantics.

Lean (1) when actually doing the work. (2) is a stopgap if the propagate session hasn't happened yet but you need to ship.

**Composite with #87:** the modify-in-place convention applies to propagation too — when the propagate pass updates screen 02 to show pills, screen 02 *becomes* the pills-version. The pre-pills version lives in git history, not as a parallel screen.

### #73 — Reds-on-investigators: category mismatch; redirect parallel scrutiny to peer-investigation
**Why this is the wrong shape today, not a prompt-fix problem.** Caught 2026-05-08 mid-investigation run on `task-investigate-f6ed49`. Both red-wide and red-narrow returned `verdict: "fail"` with high-severity findings that *restated the investigator's own findings about the topaz codebase*, not critiques of the investigator's work. Initial diagnosis was "reds drifted out of scope; tighten their seed prompts." That's wrong — the deeper bug is in the verdict vocabulary itself.

**The verdict vocabulary is the real bug.** Everywhere else in forge, `fail` means "the thing being checked is broken" (an architect's design has problems; a build's diff fails review). For investigate, `fail` collapses three distinct things:
1. The investigator's evidence is weak (work-product critique)
2. The investigator's conclusion is wrong (judgment critique)
3. The underlying subject has problems (subject critique — what reds actually did)

No prompt-tightening fix makes that ambiguity go away. Even with crisp instructions, the human reading "fail" in the dashboard will instinctively read it as "the investigation got it wrong" — because that's what `fail` means everywhere else in the app. Painting prompts onto a category mistake is the wrong move.

**What we don't want to lose: parallel scrutiny on claims.** Steven's call (2026-05-08): "If we aren't going to use reds to investigate the investigators we should use reds to do investigation on the codebase." The *capacity* for two AI agents to scrutinize a claim from different angles is valuable. We just had it pointed the wrong direction (review-after-the-fact instead of investigate-in-parallel).

**Three architectural options worth weighing:**

**(A) Peer-fanout pattern (counter-investigator).** Drop reds from `investigate`. Add a second blue agent type — `investigator-counter` (or `devils-advocate`) — that runs in parallel for each claim. Same `inputs.claim`, opposite framing: "find what would refute this claim; gather evidence the original investigator might have missed." Both outputs become first-class inputs to `synthesize`. The synthesizer is *already* designed to weigh investigator outputs; it now weighs two sides instead of one. Synthesizer's verdict vocabulary stays its own (`supported / refuted / inconclusive` per claim, matching the investigator's own conclusion vocabulary, not pass/fail).
- *Pros:* Honest vocabulary. Right shape: investigation doesn't have a verifiable artifact to review, so reviewer is the wrong primitive. Each claim gets two angles instead of one + a noisy "did the work" check.
- *Cons:* Doubles compute on the investigate phase (16 claims → 32 blues). New agent seed. New workflow primitive (two parallel blues per claim, not just blue + reds).
- *Open question:* Does the counter run literally the same input or does it get a slight prompt twist? E.g. `inputs.claim` plus a hint "your job is to find evidence this is wrong"?

**(B) Co-investigator pattern (different lenses, no opposition).** Like (A) but the second blue isn't framed as devil's advocate — it's just a second investigator with a different *lens* (e.g. one prioritizes code, one prioritizes documentation; one looks for happy path, one looks for edge cases). The synthesizer weighs both for completeness, not opposition.
- *Pros:* Less adversarial framing; less risk of artificial disagreement when both would naturally agree.
- *Cons:* More subtle to define lens distinctions; risk of two blues just doing the same work twice if their prompts don't actually diverge.

**(C) Drop reds from investigate, don't replace.** Cleanest if peer-fanout turns out not to be worth the compute cost. The synthesizer is currently the only layer that weighs evidence; let it do that job alone.
- *Pros:* Minimal change, immediately stops the confusion.
- *Cons:* Loses parallel scrutiny entirely. Single-investigator runs become single-point-of-failure for each claim's evidence quality.

**(D) Different verdict vocabulary per phase.** Reds on investigate use `corroborates / contradicts / inconclusive` instead of `pass / fail`. Verdict aggregation rules in `gate.ts` have to know what each vocabulary maps to (does "contradicts" block the gate? probably not the same way "fail" does). Bigger change; possibly the right long-term answer if forge accumulates more phase types where pass/fail doesn't fit.
- *Pros:* Solves the vocabulary problem head-on. Lets reds stay structurally similar to today.
- *Cons:* Schema change for `Verdict.verdict` (maybe a `kind` field). `gate.ts`'s aggregation rule fragments per kind. Multi-vocabulary makes the dashboard more complex.

**Lean toward (A)**, but worth thinking about (B) and (D) before deciding. (C) is the fallback if (A) doesn't work in practice.

**Things that need to be decided before implementing any of these:**
1. Does the workflow shape need a new primitive ("two parallel blues with shared input, both contribute to upstream"), or can we model peer-fanout with the existing fanout machinery (e.g. by spawning two blues from the same fanout input)?
2. Does the synthesizer's prompt need to know "you're reading two views of each claim now" explicitly, or can we just rename the input field?
3. For peer-fanout: does the counter run BEFORE the original investigator (giving the original a chance to address known counter-arguments), AFTER (so it can react to the original's evidence), or strictly in parallel (independent)? Strictly parallel is cleanest; the others introduce ordering coupling.
4. Cost-of-change: dropping reds from investigate touches the investigation workflow file + the dashboard's red-rendering paths. Not large, but worth catching `forge advise` and the verdict-aggregation paths in tests.
5. Does this same problem exist in `feature-ui-design-needed.architect`? Probably not — architect produces a verifiable artifact (decisions/components/interfaces) that reds can review against the brief. The pattern fits there. Validate by example.

**What to do for the in-flight run:** advance `task-investigate-f6ed49` with rationale ("reds restated investigator findings; advance"). Specialist reds with `gateOnVerdict: false` mean the fail is informational. Do this for every investigate task in this run. Don't change workflows mid-run.

**Side issue, separate fix already shipped:** verdict cards now render `red task: <id>` so the human can copy/reference reds for troubleshooting. Doesn't fix the vocabulary issue but helps debug confusing verdicts in the meantime.

### #28 — Per-run constraint scoping (forge new --tag, tags: in constraint frontmatter)
**Why:** The `atlas-stack-rn` constraint fires on every `feature-ui-design-needed` run regardless of project. Today the workaround is renaming the constraint file to `.disabled`, which is global. Real fix is per-run scoping.
**How to apply:** Add `--tag <tag>` to `forge new`. Add `tags: [...]` to constraint frontmatter. Constraints fire only when the run's tag matches one of the constraint's tags (or the constraint has no tags = global, current behavior).

### #33 — Resolve workflowAdditions vs base output schema conflict
**Why:** Hit a real failure: framer's base CLAUDE.md says output `{claims, experiments}` while `codebase-assessment.scope.workflowAdditions` says output `{lenses, priorities}`. The composed prompt had both schemas — the agent saw two contradictory contracts and asked for clarification instead of obeying either.
**How to apply:** Two design options to discuss before implementing:
1. `workflowAdditions` explicitly replaces the base schema. `composeSystemPrompt` emits a marker that overrides the base — agent obeys the most-specific schema.
2. Make workflows reference roles whose base CLAUDE.md already matches the workflow's schema (e.g. don't reuse `framer` for scoping if its schema is investigation-shaped).
Lean toward (1).


### #42 — Rewrite docs/how-to-new-workflow.md with a workflow we don't already have
**Why:** Current example is `code-review` which duplicates the existing `codebase-assessment` workflow. The doc reads as a paper exercise. Replace with a workflow forge actually doesn't have, ideally one that exercises a primitive we've built but not documented (`onReject` branching, gate=verdict + fanout combo, multi-authority red panels).
**How to apply:** Brainstorm the right new workflow first. Candidates: a workflow that uses `onReject` (also closes #25 validation); a workflow with both authoritative and specialist reds across phases; a workflow that genuinely needs a new role (forces also exercising `how-to-new-agent.md`).

### #141 — SQL schema single-source-of-truth (compile-time drift protection for dashboard + future readers)
Filed 2026-05-24 during the dashboard un-split follow-up (#140). Honest follow-on to a scope caveat called out in docs/SCHEMA-CONTRACT.md.

**Why filed.** After #140 merged the dashboard back as an npm workspace, dashboard/src/queries.ts now re-exports forge's Run/Task types via @forge/types. That cleaned up duplicate type *exports*, but the actual drift surface — the inline `as Array<{...}>` row casts inside each query function — still hardcodes snake_case SQL column names (project_dir, agent_role, run_id, started_at, completed_at, etc.). A column rename on forge's side is still a dashboard runtime failure, not a build error. The drift protection #140's spec promised is only half there.

**Same risk in forge itself, not just the dashboard.** src/store/runs.ts and src/store/tasks.ts have private RowToX functions that mirror SQL column names in their type definitions. Forge's own store layer breaks too if a column gets renamed — it just breaks closer to the change, so the bug is found faster. Dashboard is the canary because it lives across a workspace boundary.

**Fix shape — three options to consider:**

1. **Typed column-name constants.** Single TS file (probably src/store/schema.ts) exports const objects like `RUNS_COLS = { id: 'id', projectDir: 'project_dir', ... } as const`. Every SQL query string is built from these constants; every row cast type references them. Forge changes a column → update the constant → typecheck breaks everywhere wrong. Lowest-disruption shape — doesn't change the SQL strings, just typing what's in them.

2. **Schema-as-code via a library.** Drizzle, Kysely, sql-template-strings, etc. Generate types from a TS-declared schema; queries become typed at the call site. More invasive — rewrite the store layer — but gives compile-time guarantees on JOIN shapes, WHERE clauses, etc. Probably worth it if forge's store layer is going to grow.

3. **Code generation from CREATE TABLE.** Parse the SQL in src/store/db.ts, emit a TS module with column-name constants and row types. Compile-time hook (or a manual `npm run codegen`). No new runtime dep. Maintenance burden is the parser.

**Why option (1) first.** Lowest blast radius, smallest commit. Wraps the existing SQL in a thin type layer without rewriting any query logic. If #112 (transactional dispatch + gate writes) lands later and demands a heavier abstraction, (2) or (3) can build on top.

**Composite with #112** (transactional dispatch + gate writes — touches the same store layer). If both land in the same window, do (1) first; #112's writes also benefit from the typed column constants.

**Out of scope explicitly.** This isn't a runtime change. No DB migration. No new dependencies (for option 1). The dashboard's queries.ts and forge's store/*.ts get a typing pass; the SQL itself stays.

**Sizing.** Small for option (1) — probably one focused session. Medium-large for (2) or (3).

**Caught:** 2026-05-24 during #140 implementation, when the type-extraction work turned out to be cosmetic (dead exports) rather than functional (row-cast types). Documented in docs/SCHEMA-CONTRACT.md as a future ticket.


### #148 — red-narrow investigation: 6 of 7 verdicts are process-noise; rework or retire
Filed 2026-05-26 based on the same audit as #147.

**Why filed (data).** Of 7 red-narrow verdicts in the corpus:
- 6 are \"inconclusive with zero or one ungrounded findings\" — the red couldn't actually evaluate the artifact against its anti-prompt framing.
- 1 was a \`pass\` verdict with 8 ungrounded findings (no file:line citations).
- ZERO produced a confident actionable verdict.

red-narrow's design is to consume force-level constraints as anti-prompts and check whether the artifact violates them. The data suggests either:
1. The constraints rarely match what artifacts touch (so red-narrow has nothing to say most of the time → process noise).
2. The seed prompt doesn't translate constraint→finding effectively (so even when relevant, no actionable verdict emerges).
3. The narrow framing doesn't produce file:line citations the way other reds do.

**What to investigate:**
- Pull the force-level constraints currently in \`~/.forge/constraints/\`. How many are there? How specific are they?
- For each red-narrow verdict in the corpus, what constraint did it consume? Was the artifact even in the constraint's scope?
- Does the seed prompt require file:line citations? If not, that explains the lack of citations.
- Read red-narrow's seed (\`seeds/agents/red-narrow/CLAUDE.md\`) and compare to the other red seeds' structure.

**Possible outcomes:**
1. **Rework the seed** to be more permissive (still anti-prompt-driven, but more willing to flag concerns + emit citations). Most likely.
2. **Demote red-narrow to advisory authority by default** (specialist instead of authoritative). It can't BLOCK what it can't evaluate.
3. **Retire red-narrow entirely** if investigation shows the anti-prompt framing fundamentally doesn't fit how artifacts arrive at the gate.

**Composite with #147** (evidence-anchored output schema). After #147 ships, red-narrow's ungrounded findings will all be dropped automatically, and its verdicts will naturally land at inconclusive. That may be sufficient — the noise self-mitigates without needing a separate rework. If the data still looks bad post-#147, this ticket revives as a real investigation.

**Suggested sequencing:** do #147 first; revisit this ticket once we have 30+ post-#147 verdicts to see whether red-narrow's signal-to-noise actually improves.

**Caught:** 2026-05-26 audit of red verdicts.


### #149 — Reds: K=3 self-consistency sampling for authoritative verdicts
Filed 2026-05-26. Research technique #2 from /tmp/red-false-positives-research.md, deferred during #147 implementation.

**Why filed.** Even after #147 (evidence-anchored validator) drops hallucinated citations, reds can still produce confident-sounding `fail` verdicts on real-but-arguable findings. The model latches onto a spurious-but-real pattern, calls it severe, blocks the run. This is the next FP class to address.

**Fix shape.** Spawn each authoritative red K=3 times in parallel with temperature > 0. Aggregate the K verdicts:
- 3-of-3 `fail` → authoritative block (same as today)
- 2-of-3 `fail` (split vote) → downgrade to `inconclusive` with synthesized note (e.g. "2-of-3 reds returned fail; mixed signal — human review.")
- 1-of-3 `fail` (lone outlier) → drop the fail; treat as `inconclusive` or even `pass` depending on whether the other 2 agreed on pass
- 3-of-3 `pass` → confident pass
- 3-of-3 `inconclusive` → unchanged

This converts the unused `confidence` field (which models don't calibrate well) into vote-agreement, which is calibrated by construction.

**Where it slots in.**
- src/v2/runNext.ts already calls reds in parallel via Promise.all. Extend each red entry to spawn K containers instead of 1. The aggregator already exists in gate.ts; treating K samples of one red as K reds is natural.
- New schema field on the workflow YAML for K (default 1 for backward compat; explicit `samples: 3` opts in per-red).
- Per-finding aggregation: when 2-of-3 agree on a finding (same file:line, similar summary), keep it; lone-wolf findings get dropped.

**Cost.** 3× tokens and 3× container spawns per authoritative red on the steps that opt in. For a personal-Mac tool running occasionally this is acceptable; the prevention of 1 false block easily pays for many extra container spawns.

**Composite with:** #147 (the validator) — pairs naturally because hallucinations are usually non-reproducible across samples (different K runs invent different fake citations, so the agreement signal works even before #147's drop happens).

**Sequencing.** Wait until #147 has collected 30+ post-validation verdicts. Re-audit those — if the dominant remaining FP class is "real-but-overconfident findings" (not hallucinations), spec this. If the FP rate dropped so much that the remaining noise isn't worth the 3× cost to fix, skip.

**Out of scope.** Per-finding clustering beyond file:line + summary similarity. Don't implement semantic finding-dedup; trivial overlap is enough.

**Sizing.** Medium. ~50-100 LoC including the YAML schema extension + aggregation logic + tests.

**Caught:** 2026-05-26 cross-track research session.


### #150 — Reds: forge gate --feedback to capture ground-truth labels on findings
Filed 2026-05-26. Research technique #3 from /tmp/red-false-positives-research.md, deferred during #147 implementation.

**Why filed.** All the other FP-mitigation techniques (validator, self-consistency, rubric anchoring) get tuned by vibes — chosen thresholds, hand-picked window sizes, intuited prompts. A ground-truth dataset of "the user actually said this finding was real / a nit / wrong" makes every other technique tunable by data instead of guesswork.

The forge user is also the reviewer. The labels they already form in their head when reading gate output can be captured trivially.

**Fix shape.** A new CLI flow during gate review:

\`\`\`bash
forge gate <task-id> advance --feedback
\`\`\`

The flow walks each finding from the verdicts under review, prompting for a label per finding:
- \`real\` — actual defect worth addressing
- \`nit\` — true but trivial; not worth blocking on
- \`false\` — wrong / hallucinated / misunderstanding

Labels write to a new table: \`finding_feedback (verdict_id, finding_index, label, created_at, rationale TEXT)\`.

The flag is opt-in. Gate without \`--feedback\` works exactly as today. Adoption is voluntary, paid back over time as the dataset enables auto-tuning.

**What the data unlocks (over time):**
- Per-red FP rate: identify reds that consistently fail to produce real findings. Retire or rework.
- Per-rubric-tier rate: calibrate the rubric (if/when one ships).
- Per-rule-pattern FP rate: identify finding shapes that are unreliable.
- Confidence calibration: empirical mapping from self-reported confidence to actual real-rate.
- Auto-thresholding: drop authoritative-block authority from reds whose FP rate exceeds N%.

**Where it slots in.**
- New table in src/store/schema.ts: \`finding_feedback\`. No new col on existing tables.
- New CLI command surface: \`forge gate <id> advance|reject|request-changes --feedback\` adds the prompt loop after the action lands.
- New store accessor: \`insertFeedback(verdict_id, finding_index, label, rationale?)\`.
- The dashboard (read-only) could surface per-red FP rates once enough data accumulates. Not in scope for this ticket.

**Out of scope.**
- Building any of the downstream auto-tuning. This ticket only ships the data-capture surface. Tuning is downstream tickets that read from \`finding_feedback\`.
- Forced labeling (mandatory \`--feedback\` on every gate). Voluntary only.
- Backfilling historical verdicts.

**Sizing.** Small-medium. ~80 LoC including new table + accessor + CLI flow + tests. The value is in accumulating the dataset over weeks/months, not in the day-1 implementation.

**Composite with:** #147 (validator) — once feedback labels exist, we can validate whether the validator's drops match the user's \`false\` labels. Gives a way to measure the validator's precision and recall.

**Sequencing.** No urgent dependency. Can ship anytime — but most useful AFTER #147 has stabilized so the validator's drops + user feedback can be cross-referenced for tuning.

**Caught:** 2026-05-26 cross-track research session.


### #158 — forge claude --bedrock: spawn claude with bedrock env vars without sourcing scripts/use-bedrock.sh
**Caught:** 2026-05-26 conversation while shipping \`forge claude\` (#158).

**Problem.** Today's bedrock workflow requires \`. ./scripts/use-bedrock.sh\` first to set CLAUDE_CODE_USE_BEDROCK=1 + AWS_PROFILE in the user's shell, then \`claude\`. Two-step friction; the source-vs-run gotcha is a real onboarding wart (FORGE-DEC-013 notes it explicitly).

**Shape.** \`forge claude\` can spawn \`claude\` as a child with the right env without touching the parent shell. Two ways to opt in:

1. **Explicit flag:** \`forge claude --bedrock\` sets CLAUDE_CODE_USE_BEDROCK=1 and resolves AWS_PROFILE from a project-level default or env. Cheapest; user controls per-invocation.
2. **Project default:** new \`.forge/project.json\` field, e.g. \`"auth": "bedrock"\` (and optionally \`"awsProfile": "adx-dev"\`). \`forge claude\` reads it on launch and arms bedrock automatically when the project asks for it. Per-project sticky; no extra typing.

Lean (2) with (1) as override. Matches the .forge/project.json pattern from #151 (friendly name override) and #67 (design corpus override) — projects opt into per-project settings via that file.

**Design considerations:**
- AWS_PROFILE resolution order: --aws-profile flag > .forge/project.json > AWS_PROFILE env > default. Must be deterministic; surface in the banner.
- SSO watchdog: \`startSsoWatchdog\` already handles bootstrap. \`forge claude\` should ensure it's running for the project before exec'ing claude (currently dispatched only by \`forge new\` / \`forge next\` — orchestrator sessions skip it).
- Auth pre-flight: run \`detectStaleStsCache\` (#119) before launch; fail clearly if stale.
- Other auth modes: \`auth: "oauth"\` should be the no-op default; \`auth: "apikey"\` could verify ANTHROPIC_API_KEY is set.

**Composes with:**
- #158 (forge claude launcher — landed)
- FORGE-DEC-013 (bedrock SSO watchdog design)
- #119 (STS cache staleness detection)
- #151 (.forge/project.json convention)

**Out of scope:**
- AWS credential rotation. The watchdog handles SSO refresh; this ticket is only about env setup at launch.
- Multi-profile per-project. One profile per project for now; --aws-profile override is the escape hatch.


### #160 — Architecture-advisor agent: produce Mermaid architecture documents

### #167 — awaiting_human_input status is ~60% wired — incomplete state transitions, no CLI command

### #172 — Gate request-changes should apply the rationale's fix list in place, not re-run the phase/plan
**Caught 2026-05-28** on wnba-led-scoreboard (same review as the discipline-fanout gap, #171): when the human used request-changes at a build gate, it drove a re-run rather than a targeted application of the rationale's fix list.

**Current behavior (`gate.ts`).** request-changes marks the task failed and inserts a pending task in the SAME step, carrying the rationale as `inputs.requestedChanges`. So the implementer re-runs the whole step with the rationale as free text, rather than surgically applying the specific fixes the human listed against the existing diff. (Reject + `on_reject` is the other path — that loops to an upstream step, e.g. brief/plan, = a full re-plan.)

**Desired.** request-changes should feed the rationale's fix list to the implementer as a targeted change set: "apply these specific fixes to your existing diff," preserving work already done, not regenerating the step from scratch or re-planning upstream.

**Open question for whoever picks this up.** Pin down which path the wnba run actually hit — request-changes re-running the full build step, or a reject→on_reject upstream re-plan. The fix differs:
1. make the request-changes re-dispatch incremental (carry the prior diff + fix list, instruct surgical edits), vs
2. ensure UI-variant build gates expose request-changes (in-place) rather than only reject (upstream).

Same class of forge rough-edge as the browser/:9222 and forge-test/Jest gaps surfaced 2026-05-28.


### #173 — v2 has no idle-watchdog — hung agents run forever (re-files #74)
**v2-shaped re-file of #74**, which closed 2026-05-26 with "Re-file a fresh v2-shaped ticket if/when it bites." It bit on 2026-05-29.

**What happened:** `task-task-718ad0` (frontend-specialist, web-admin redesign screens, wnba-led-scoreboard workspace) hung for ~1 hour. The agent stalled during its initial file-reading research — last logged action was a `Glob` at `00:10:26`, 16s after start — then emitted *zero stdout for the next hour*. The agent process (`claude --model claude-sonnet-4-6`, PID 1) was alive the whole time at ~0.1% CPU: blocked waiting on a model stream response that never arrived. The container stayed `Up`, the DB task stayed `running`, and `result.json` was 0 bytes. Nothing killed it — the human noticed and stopped it manually.

**Root cause:** the #26 idle-stdout watchdog (kill container after N min of no stdout, `FORGE_AGENT_IDLE_TIMEOUT_MS`) was lost in the v1→v2 cutover and never re-added. `src/v2/DECISIONS.md` Decision 9 documented the gap verbatim: *"no idle-watchdog yet … The runner's exec stub doesn't implement it."* So v2 had *no liveness protection at all* for a hung-but-alive agent.

**Distinct from #74's original shape (matters for the fix):**
- #74 original: container *dead*, status stuck `running` → a reconcile gap (sniff dead containers, persist `container_id`).
- This incident: container *alive*, agent *hung*, stdout frozen → the idle-stdout watchdog case (#26), which v2 dropped. Detection rides the live stdout `data` events the host already receives — disk-write timing never gated it.

**Tier 0 + Tier 1 — SHIPPED (this session):** `src/v2/idle-watchdog.ts` (`startIdleWatchdog` measures the *gap between* stdout chunks, not total runtime, so a busy long task that streams steadily never trips; disabled when `idleMs <= 0`). Wired into a *single shared* `src/v2/docker-exec.ts` used by BOTH the invoke path (invoke.ts) and the pipeline path (runNext.ts) — they had diverged into two buffered executors, leaving `forge new`/`forge next` tasks unwatched; consolidating closed that gap. Each chunk both streams to disk live (observability + bounded memory; replaces buffer-until-close) and bumps the watchdog. On silence it runs `docker kill <name>` on the container itself (SIGKILLing only the docker CLI client leaves the container orphaned under the daemon; the client kill is just a backstop), then the task fails with `idle_timeout` via a `124` sentinel exit code. Timeout precedence: `FORGE_AGENT_IDLE_TIMEOUT_MS` env override > runtime YAML `container.idle_timeout_seconds` (seeds set 600s — this field existed in the schema but was orphaned/unread until now; bumped 300→600 this session for margin) > 15-min hardcoded fallback. So effective production timeout is **10 min** (from the seeds); revisit if a legit quiet tool call (big test suite / build) ever exceeds it. Host-side `forge design` is exempt by construction (no container, never enters this path). Tests: watchdog units + env/runtime precedence matrix, `containerNameFromArgs`/`killContainer` units, plus idle_timeout integration tests through both `invoke()` and `runNext()`.

**Tier 2 — REMAINING (separate, schema-gated):** dead-container detection for the parent-died orphan (the in-process timer dies with its parent). Persist `tasks.container_id` at spawn; a sweep marks `running` tasks `failed` when `docker inspect` shows the container gone. No `container_id` column exists today. Schema change → machine-wide blast radius, flag per shared-DB-migration rule.

**Possible refinement (only if 15 min feels slow):** tail the stream shape — a pending `tool_use` means the agent is inside a long tool (lenient); a `tool_result`/turn-end with nothing after is the awaiting-model hung signature (strict), letting the timeout drop to ~3–5 min safely.

**Diagnostic playbook:** `forge show` "running" and `docker ps` "Up" both mean *spawned*, not *progressing*. True liveness = `docker logs <c>` last-timestamp vs wall clock. Agent PID alive at ~0% CPU + frozen logs = blocked on I/O (usually a hung model stream). 0-byte `result.json` + age ≫ expected confirms.


### #174 — forge backlog has no edit-body verb; ## in a ticket body silently breaks the parser roundtrip
Two related rough edges, both hit 2026-05-29 while filing #173.

**No edit-body verb.** `forge backlog` exposes file/close/move/notes — there is no way to edit an existing ticket's body. A typo or malformed body can only be fixed by close+refile (burns the sticky number AND leaves the broken body relocated, not removed) or by hand-editing BACKLOG.md (which CLAUDE.md forbids). #173's body had to be fixed via a direct Edit because no CLI path existed. Add `forge backlog edit <id> --body <text|-\>` (replace body, keep heading + sticky).

**`##` in a ticket body silently breaks the byte-for-byte roundtrip.** The parser's SECTION_HEADING_RE = /^## (.+)$/ (src/backlog/parse.ts:24) treats any `## X` line as a top-level section boundary, even inside a ticket body. A ticket whose body uses `##` subheadings gets truncated at the first one and the remainder lands in unrecognized-section limbo, so parse(BACKLOG.md)→serialize() no longer roundtrips and parse.test.ts goes red. Convention is bold lead-ins (`**X:**`); `###`-without-`#NNN` is also body-safe (TICKET_HEADING_RE requires the `#<id> — ` shape). Harden: either have `forge backlog file` reject/escape `^## ` lines in a body, or make the parser only treat `## ` as a section when the name is in SECTION_ORDER. Related to #141 (parser as single-source-of-truth).


### #177 — test-engineer E2E should be Playwright (project-owned), kept strictly separate from agent verification (browser-tools)
**Decision (2026-05-29):** Playwright is the E2E stack for the *project's committed suite*. It must NOT be conflated with *agent testing* (forge's CDP browser-tools). Different layers, different owners, different lifecycles — the seed currently blurs them and that's the defect.

**The two layers — do not confuse:**
- **Project E2E suite — Playwright.** Durable, committed `*.spec.ts` with real assertions (locators, auto-wait, `expect`). Lives in the repo, runs via the project's own `npx playwright test` / CI, portable, independent of forge. The test-engineer *authors* these; the project *owns and re-runs* them. This is the durable regression coverage the test-engineer seed promises.
- **Agent verification — browser-tools (CDP, :9222).** Interactive and ephemeral: drive the browser, screenshot, eyeball. Runs ONLY inside the forge container. Output is *evidence* (screenshots in result.json), never a committed repo artifact. Belongs to engineer/frontend (build-phase visual check) and manual-qa — not to durable E2E.

**Why this is a defect today:** the test-engineer seed (seeds/agents/test-engineer/CLAUDE.md) tells the agent to write E2E "tests" using browser-tools scripts (browser-nav.js/click.js + screenshot + prose). That produces a one-shot scripted verification with no machine assertion, not runnable in the project's own CI (browser-tools + :9222 exist only in the forge container), and orphaned the moment it leaves forge — directly contradicting the seed's headline ("committed test files — durable regression coverage that lives in the repo"). It's really manual-qa work mislabeled as E2E.

**test-engineer seed change:**
- E2E section: detect the project's E2E framework (playwright.config / cypress.config / package.json). If the project is a web app and has none, scaffold Playwright (config + tests dir + npm script). Write committed, assertion-bearing specs.
- Stop describing browser-tools scenario scripts as "E2E tests." browser-tools is not in the test-engineer's E2E path; Playwright has its own headed/trace debugging.
- Reconcile the seed headline with the method: Playwright specs satisfy "durable committed regression"; browser-tools scripts do not.

**Anti-downgrade gate (REQUIRED — the audit's core finding).** Evidence (2026-05-29): across 6 test-engineer runs, E2E files written = 0 — including web-admin runs where E2E applies. The agent silently substitutes integration tests for E2E and the verify gate passes because `test_files_written` is non-empty (integration tests satisfy it). Fixing Playwright/auth alone won't *force* E2E. So: on a web app the test-engineer must EITHER commit an E2E spec OR return a structured `e2e_skipped_reason` (e.g. "needs auth profile #176", "no dev-auth path documented"). The orchestrator gate-check (CLAUDE.md) must reject a web-app `verify` result that has zero E2E specs AND no `e2e_skipped_reason` — i.e. silence on E2E is a hard reject, not a pass. This closes the "looks complete, isn't" failure mode that hid the missing E2E for this long.

**Infra question — RESOLVED (see #180):** running the Playwright suite in-container needs a browser. Decided to **bake Playwright's own chromium into the agent-dev-worker image** (not `connectOverCDP` to #128's Chrome — that loses Playwright's per-test isolation, `storageState`-per-context, and parallelism). Own browser keeps project-E2E (layer b) independent of agent-verification (layer a). Full spec + size/version-locking details in #180. #180 is auth-independent and can ship in parallel with #176.

**Auth (ties #176):** the captured storageState artifact serves BOTH layers from one file via different mechanisms — Playwright consumes `storageState:` natively (project E2E); browser-tools consumes via CDP injection (agent verification / manual-qa). Same file, two consumers, no shared code path — the layers stay separate even where they share the credential.

**Ties:** #176 (auth profiles — storageState feeds both layers), #128 (baked Chrome / retired Playwright MCP — applies to the AGENT layer only, NOT the project's E2E deps), #164 (test-engineer role definition).


### #178 — forge-test runs node:test and fails on Jest projects — agents must bypass with npx jest
**Bug:** the `forge-test` wrapper (mandated by every implementer + test-engineer seed) invokes Node's native test runner (`node:test`). On a project that uses Jest (e.g. web-admin, jest ^30) it fails outright — the agent can't validate via the sanctioned path.

**Evidence (2026-05-29):** test-engineer run `403d26` (run-add-sport-toggle-to-preview), notes verbatim: *"forge-test runs Node's native test runner which fails because the project uses Jest (jest ^30). Tests were verified by running 'npx jest --testPathPatterns=DisplayPreview.test --no-coverage' directly in web-admin/."* The agent bypassed forge-test to validate at all.

**Why it matters:** the seeds make forge-test the required validation gate ("use the forge-test wrapper, not npm test directly"). When forge-test breaks on Jest, a diligent agent bypasses it (as 403d26 did) but a less careful one reports a false `status: failed` or — worse — skips validation and returns `complete` unvalidated. Either way the gate is unreliable for the large class of Jest projects.

**Fix direction:** forge-test should detect the project's test runner (package.json `scripts.test` / devDeps: jest / vitest / node:test) and dispatch accordingly inside the container scratch copy, rather than hardcoding `node:test`. It already does the native-module rebuild + scratch-copy dance; it just needs runner detection. Keep the single `forge-test` entrypoint the seeds reference.

**Relation:** distinct from #125 (which is "implementer seeds don't *mention* forge-test"). Here forge-test IS used and picks the wrong runner. #125 is documentation; this is forge-test's runner assumption.


### #184 — Auth-profile polish (optional follow-ups from #176)
Optional refinements after the #176 auth-profile epic shipped (none blocking):

- **Upstream PR**: open a PR of `feat/preload-storage-state` from the fork (github.com/stevebargelt/pi-skills) to `badlogic/pi-skills`. The injector is generic now (keyed on BROWSER_TOOLS_STORAGE_STATE); if merged, forge could drop the fork and pin upstream instead (#181).
- **browser-content.js + --new-tab**: only `browser-nav.js` calls `maybeApplyAuth`. `browser-content.js` (and any other navigating script) doesn't, so auth doesn't apply there. New-tab navigation re-registers the init script per nav (harmless duplicate). Wire the helper into the other nav paths if those surfaces need auth.
- **Per-step auth flag**: pipeline scoping is a hardcoded role allowlist (`roleUsesBrowser`: engineer, frontend-specialist, test-engineer, manual-qa). A `needs_auth: true` step field in the workflow schema would be more precise if a non-listed role ever needs to browse authenticated, or to exclude an in-list role for a given workflow.
- **pi-skills whole-repo pin**: forking all of pi-skills pins every skill to the branch snapshot; if other skills need upstream updates, split browser-tools out or rebase periodically.


### #185 — Reaper for tasks orphaned when the parent forge process is killed (#173 Tier-2, hit live)
**Hit live 2026-05-29** running a parallel red panel wrapped in `timeout 600 bash -c "forge invoke ... & ... & wait"`. The wall-clock timeout killed the parent forge processes mid-review. The `docker run --rm` containers were torn down (verified: no forge-* container running or exited afterward), but the killed task stayed `status=running` forever — the dashboard/`forge status` showed it "running for an hour" when nothing was actually running.

**Root cause:** the idle-watchdog is in-process (#173 Tier 0+1). When the parent forge process dies (SIGKILL/SIGTERM from an external `timeout`, a crash, a closed terminal), the watchdog dies with it, so nothing transitions the in-flight task to a terminal state. `forge sweep` doesn't catch it (it only closes runs whose tasks are ALL terminal; a stuck `running` task isn't terminal). `forge retry` only resets `failed` tasks. There's no CLI to fail/reap a stuck-`running` task — had to mark it via the store accessors directly (markTaskFailed + updateRunStatus("abandoned")).

This is the #173 Tier-2 "dead-container / parent-died orphan" case that was explicitly deferred (schema-gated on tasks.container_id). The deferral reasoning holds, but this is a concrete recurrence worth a lightweight fix.

**Options:**
- A reaper pass (extend `forge sweep`): for runs that are `active` with a task `running` whose container (by name `forge-<taskId>`) is absent from `docker ps`, mark the task failed + run abandoned. Needs the container-name → docker-ps check (no schema change required — derive the name).
- Persist a heartbeat/PID per running task; sweep reaps tasks whose owning PID is dead.
- A `forge cancel <task-or-run>` / `forge sweep --running-orphans` CLI verb so this doesn't require poking the DB by hand.

**Operational note:** don't wrap `forge invoke` in an external `timeout` — rely on the per-agent idle-watchdog (10m) instead; an external timeout that kills the parent orphans the task. For parallel panels, launch and let the idle-watchdog bound each agent.

Relates to #173 (idle-watchdog, closed).


### #190 — Auth-profile review findings + expiry/refresh-token fix (consolidated)
Combined, code-verified findings from forge's red panel (red-security 0.78 / red-backend 0.88, both FAIL) + an independent external agent review of the #176 auth-profile code, PLUS the refresh-token expiry gap found in use. Verified against source 2026-05-29. Supersedes #189 (and #188).

**Priority is CORRECTNESS / CLEANUP, not security-urgent.** Per product owner (2026-05-29): zero users, security hardening deprioritized pre-launch; track these, fix genuine correctness bugs, revisit hardening before real users. Reviewers CONFIRMED the load-bearing invariants are sound: reds never receive the credential (runOneRed passes no profile), sanitizeProfileName blocks path traversal.

**HIGHEST VALUE — expiry logic is wrong, and it artificially kills usable sessions:**
1. Expiry is computed wrong in TWO ways, both in profileExpiry / profileStatus (src/util/auth-profiles.ts:118-136):
   (a) **Ignores the refresh_token.** A captured Supabase bundle contains access_token (~1h), expires_at, AND refresh_token. forge gates on the access token's 1h expires_at and hard-fails after that — but the injected bundle includes the refresh_token, and the app's Supabase client (autoRefreshToken on) silently mints new access tokens on load. So the agent's real session lives as long as the REFRESH token (days/weeks), not 1h. forge declaring the profile dead at 1h is the actual flaw — it makes "capture once" far less useful than it is. Fix the gate: access valid → OK; access expired BUT refresh_token present → proceed (browser refreshes on load), warn at most; access expired AND no refresh_token → fail.
   (b) **Over-broad min.** profileExpiry does Math.min over ALL cookie `expires` (line 133); an unrelated short-lived cookie (CSRF/analytics) marks a still-valid auth profile expired. Fix: derive expiry from the auth-token/JWT (and refresh_token presence), not arbitrary cookies.
   Caveat to document: Supabase rotates refresh tokens — if the human keeps actively using the same login after capture, rotation can invalidate the captured refresh_token. Cleanest capture = log in fresh in the forge window; long-term an app test-login endpoint sidesteps it (v2, #176). Don't build server-side refresh (needs the anon key, not captured) — rely on in-browser auto-refresh.

**Other correctness bugs (worth fixing):**
2. TOCTOU write-then-chmod — credential file briefly at umask default before chmod. writeProfile (auth-profiles.ts) + staged copy (auth-state.ts). Fix: writeFileSync(path, data, { mode: 0o600 }), ideally temp-file + rename.
3. [verified] IPv6 [::1] not reconciled. new URL("http://[::1]:3000").hostname === "[::1]" (brackets) but LOCALHOST_HOSTS has "::1" → ::1 origins skip the localhost→host.docker.internal rewrite. Fix: normalize brackets or include both. (Low impact.)
4. CdpSession.send has no timeout — `forge auth-profile login` hangs forever if Chrome/CDP stalls after Enter. Fix: per-call timeout that rejects + close the socket.
5. [verified] Wrong-tab capture. cdp-capture.ts:168 picks the FIRST page target. Mitigated by the dedicated-browser launch; fix: prefer the page whose origin matches --url.
6. Cookie leading-dot domain (.localhost) not reconciled (auth-profiles.ts). Zero impact for the localStorage-only app; real for cookie-based apps. Normalize domains before reconciliation.

**Cleanup:**
7. Staged auth-state.json persists in the run dir after the run. Stage outside taskDir and/or unlink after the container exits.
8. Network.getCookies captures cookies from ALL origins, not just the target (over-broad capture). Scope to the target origin (pairs with 1b).

**Documentation honesty (cheap, do it — NOT a code vuln):**
9. Correct overclaiming language. The injected token IS readable by the (trusted) primary agent inside its container (`cat /forge-auth/state.json`). Accurate guarantee: "never in prompts, logs, result.json, or the project mount" — NOT "the agent never holds/sees the credential." Fix the ADR + commit-summary phrasing. NOT a vuln within forge's trust model (container boundary = trust line; reds correctly excluded). A separate injector-process boundary is possible but NOT warranted now — out of scope.

**By-design (NOT defects — recorded so they aren't re-raised):**
- Pipeline auth scoping is a role allowlist incl engineer + frontend-specialist (UI visual verification). A workflow needs_auth: true flag is an optional refinement (#184), not a bug.

Provenance: forge red panel + independent external review + in-use refresh-token finding, merged and code-verified by the orchestrator.


### #191 — runNext.test.ts test 1 has a broken fixture — path.join(undefined) at line 91

### #198 — NO_NOTIFY kill-switch so forge's own test suite doesn't fire real notifications
A single explicit global env kill-switch, e.g. NO_NOTIFY=true, checked at the top of the notify dispatch path (src/notify/trigger.ts isAnyProviderEnabled / dispatch) that short-circuits ALL providers (ntfy + Twilio) regardless of FORGE_NOTIFY / NTFY_URL config.

**The ONLY problem this solves:** when forge runs its OWN test suite, tests transition runs to complete/failed -> updateRunStatus -> notifyOnRunTransition -> real push. #175 already fixed this narrowly by CLEARING FORGE_NOTIFY in src/test-setup.ts, but that's implicit (you have to know clearing the provider list disables notifications) and provider-specific. NO_NOTIFY=true is an explicit, provider-agnostic 'this context is not real work, stay silent' lever. test-setup.ts then just sets NO_NOTIFY=true.

**Explicitly NOT in scope — do not suppress real run notifications.** Real forge invoke / forge new runs completing are exactly what notifications are FOR: the human is away and the ping is their signal that agent work finished. An earlier version of this ticket (closed #192) wrongly framed orchestrator-internal invoke completions as 'noise' to suppress — that was a mistaken read. Per-run completion notifications for legit runs are the feature working correctly. This ticket is ONLY about silencing forge's automated test suite (and any other explicitly-flagged non-production context), never real work.

Relates to #175 (the narrow test-setup.ts precedent this generalizes). Deferred — not urgent.


### #200 — forge show: stdout/stderr tail dumps raw stream-json blobs — extract text deltas instead
#196's forge show task view tails the last ~5 lines of container.stdout.log. For Claude agent containers the log is stream-json — each 'line' is a huge JSON object, so the 'Last stdout' block renders 5 giant unreadable blobs instead of useful recent activity.

Polish: when the log looks like Claude stream-json (JSONL with type fields), extract the human-readable text — the assistant text deltas / the final result.result string — and show that as the tail, capped to a sane width/line count. Fall back to raw tail for non-JSON logs (plain CLI/test output). Keep it in show.ts's tailLines/last-output rendering. Pure-function-friendly so it stays unit-testable like the other #196 helpers. Low priority — cosmetic, not blocking.


### #203 — Orchestrator-done notifications: ping when forge-on-forge work finishes

### #222 — Session/orchestrator tasks stuck 'running' need a heartbeat-based reaper (not container-based)
Surfaced during AWN-1 (#214): the real DB has several task-session-* (phase=session, role=orchestrator) tasks stuck status='running' from orchestrator/design sessions that ended without finalizing. AWN-1's reconcile deliberately SKIPS them (no container.started — they're host-side), so they stay 'running' forever and inflate forge status / dashboard "in flight".

These need a DIFFERENT reaper keyed on the orchestrator-heartbeat files (~/.forge/orchestrators/<session>.json, written by scripts/claude-hooks/orchestrator-heartbeat): if a session task is 'running' but its heartbeat file is absent or its lastSeen is stale (> threshold), finalize it (complete with "session ended" note, mirroring design.ts:138, or a session.reconciled event).

Scope: a heartbeat-staleness reconcile pass for session/manual (non-containerized) tasks, complementing AWN-1's container-liveness pass. Wire into the same lifecycle commands. Idempotent + audited like AWN-1.

Note: 5 such tasks were briefly mis-orphaned by an early AWN-1 build and restored from backup (forge.db.bak-20260530-084522-reconcile-restore); they remain legitimately stale and this ticket cleans them up properly.


### #223 — AWN-4 phase 2: contract enforcement — record satisfied checks, workflow-YAML contracts, orchestrator prefers contracts
Follow-up to AWN-4 phase 1 (#217, which landed the TaskContract schema + manifest carry + forge show + forge invoke --contract). Phase 2 closes the doc's remaining §4 acceptance:

- Result manifest records which contract checks were satisfied: after a task with a contract completes, capture pass/fail per validation command + per expected_artifact (the agent runs validation and reports; or forge verifies artifact presence). Surface in forge show ("contract: 3/3 checks satisfied").
- Declare contracts in workflow YAML (per-step `contract:` block, loaded by loader.ts/schema.ts), so pipeline steps carry contracts, not just forge invoke.
- Orchestrator template prefers contracts when invoking agents (CLAUDE.md / forge-raci guidance: build a contract for implementation tasks).
- Agents instructed to report deviations explicitly — the renderContract note already tells them; phase 2 makes the result schema include a `contract_deviations` field and forge show flags it.

Builds directly on #217's TaskContract type + contract.ts.


### #225 — AWN-7 Run: bounded orchestrator choice + adaptive routing (allowed_profiles ceiling, cost-tier guardrail)

### #228 — Classify provider error events as model_error + surface the cause (not generic container_crash)
Observed during AWN-7 Walk W4 (Codex failure-path validation). A Codex run with an invalid model exits 1 with no result.json, so classify() returns container_crash — correct (it IS in the taxonomy, #220 acceptance met), but lossy. The actual cause is right there in the stdout JSONL:

  {"type":"error","message":"...status 400 ... The 'X' model is not supported when using Codex with a ChatGPT account."}
  {"type":"turn.failed","error":{"message":"..."}}

forge flattens this to `container_crash (exit 1)`; the precise reason is dropped. There's already a `model_error` FailureKind in the enum (failure-kind.ts) that fits, currently only settable via explicit ctx.source.

This is PROVIDER-AGNOSTIC, not codex-specific: claude model/quota errors also collapse to container_crash/result_missing today.

Proposal:
- On a failed task, scan the result/output stream for a provider error signal (codex: type:"error"/"turn.failed"; claude: stream error events) and pass source:"model_error" to classify, plus carry the human-readable message into the task.failed error.
- Keep it best-effort + provider-keyed (reuse the same provider dispatch as the usage parser); fall back to container_crash when no signal is found.

Ties to #200 (forge show should extract text from stream-json blobs rather than dump them) — same "surface the meaning, not the raw stream" theme. Small, isolated, improves failure diagnostics for all providers.


### #229 — forge upgrade doesn't rebuild the agent image or check provider auth — Codex upgrades silently incomplete
Surfaced while documenting the AWN-7 Walk upgrade path. `forge upgrade` does: git pull, npm install, FORCE=1 install-seeds, re-init CLAUDE.md. It does NOT rebuild the agent-dev-worker image or check provider auth.

The bite: install-seeds now ships seeds/runtimes/codex-subscription.yml, so after `forge upgrade` an openai/subscription profile RESOLVES fine — but the agent image still lacks the `codex` CLI until `docker/build.sh` runs. The container then fails at exec (codex: not found) with no hint that the image is stale. Same class of gap the first pipeline smoke hit (runtime seed present, but not wired).

Proposals (any subset):
- `forge upgrade` detects image staleness (e.g. compare a Dockerfile hash / label against the installed image) and warns, or runs docker/build.sh behind a --rebuild-image flag.
- `forge providers doctor` (or a new `forge doctor`) checks that each runtime referenced by RUNTIME_BINDING has its CLI present in the image, not just that host auth exists.
- Document the image-rebuild + `codex login` steps in how-to-upgrade.md (currently silent on both).

Low-risk, operability-only. Tie-in: AWN-7 Walk (#224, codex runtime), how-to-upgrade.md.


### #232 — forge invoke retry orphans the task when the failed attempt already auto-closed the run
Hit during the AWN-7 Pixtron regression Test 1. Sequence:
1. `forge invoke engineer` — attempt 1 idle_timeout'd (task failed).
2. A `forge invoke` run auto-closes when its lone top-level task terminates (closeRunIfIdle in invoke.ts fires on complete OR failed). So the failed attempt flipped the run to `complete`.
3. A subsequent `forge retry` created a PENDING task against that now-complete run, and `forge next` refused to dispatch it (run is terminal) → the retry task is orphaned (pending forever, never runs).
4. Workaround that worked: a fresh `forge invoke` (new run) succeeded in 50s — so the underlying hang was transient (typecheck), not the retry path.

Bug: retry must not strand a task. Either (a) `forge retry` should reactivate the run (run.status -> active) when it attaches a retry task to a terminal run — mirroring invoke.ts #201's reactivation on attach; or (b) `forge next` should reactivate a complete run that has a fresh pending task; or (c) retrying the sole task of an auto-closed invoke run is disallowed with a clear message pointing at re-invoke.

Likely interaction between the invoke auto-close (closeRunIfIdle) and AWN-3 retry (retry creates a primary task). Relates to AWN-2/AWN-3 run-state + #201 reactivation. Repro is reliable: idle_timeout (or any failure) a single-task invoke run, then `forge retry` it.


### #234 — Orchestrator milestones — Walk: per-run notification policy (quiet|normal|verbose) + --notify-policy
Builds on the Crawl slice (forge notify milestone + orchestrator.milestone events + default per-kind policy + dedupe, shipped e168fcc, #202/#203).

Add a per-run notification policy stored in run metadata:
- quiet: only interrupt-worthy kinds (decision_needed, blocked, risk_found).
- normal (default): the Crawl per-kind policy as-is.
- verbose: also push the suppressed-by-default kinds (plan_started, batch_complete regardless of elapsed).
- `forge new <wf> --notify-policy <p>` and `forge invoke <agent> --notify-policy <p>` set it (stored like modelProfile/authProfile in run metadata; CONTROL_PLANE_METADATA_KEYS so it never leaks into prompts — see #227).
- emitMilestone reads the run's policy and adjusts decideMilestone (the policy table becomes policy-aware: quiet drops normal-importance always-kinds to suppressed; verbose promotes suppressed).

Out of scope: the orchestrator-contract (when to emit) — that's the Run slice.


### #243 — Docs drift — L2 precision: discriminate added-vs-removed primitives before any enforcement

### #245 — node_modules corruption fix: container-local node_modules volume in spawn.ts (supersedes FORGE-DEC-011)
Root cause is grpcfuse xattr + CyberArk EDR (environmental, NOT arch — #187 does NOT fix it; orthogonal). Fix = container-local node_modules volume in spawn.ts (standard Docker shadow-volume pattern) so the container never writes native-module artifacts back through the grpcfuse project mount. Supersedes FORGE-DEC-011's 'no code fix yet' status.

VALIDATION CONSTRAINT: must be validated on the CyberArk-EDR corp Mac — the only place the silent SIGKILL triggers. A clean Mac won't prove it. Do NOT mark complete on clean-Mac testing alone.

spawn.ts is in CLAUDE.md's 'don't touch without a learnings entry' list (DEC-004/005/006/009) — write the learnings entry as part of this. Keep the change as a SEPARATE atomic commit from #187 (native arm64); they share an image-rebuild + validation sitting but are orthogonal. This is the real unblocker for forge-on-forge CODE agents (markdown-only agents like documentation-maintainer are already corruption-safe).


### #247 — Implementer seeds' mandatory validation misses tsc type-check + format-check — forge-clean changes fail CI
**Process finding (from Pixtron, 2026-06-02).** Pixtron #16 failed CI twice on changes the forge container reported `complete`/clean: a real `tsc` type error, and unformatted files. This will recur on every forge-authored web-admin change. Sibling to #178 (there: forge-test picks the wrong test *runner*; here: the sanctioned validation path is missing two mandatory *steps* — type-check and format-check).

**Root mechanic:** `forge-test` runs the test runner (node:test / jest), which **transpiles** TS — it strips types without checking them. "Tests pass" ≠ "`tsc --noEmit` clean." And neither implementer nor test-engineer seed runs a formatter check, so unformatted files sail through to CI's `prettier --check` gate.

**Ground truth in the seeds (verified 2026-06-02):**
- `seeds/agents/engineer/CLAUDE.md:70` — *does* mention type-check: `Run npm run typecheck (Node) or go vet ./... (Go) if applicable.` But it's weak two ways: (a) **soft** — "if applicable" lets a diligent-but-rushed agent skip it; the HARD rule (line 66) is forge-test only. (b) **name-brittle** — hardcodes the script name `typecheck`; a project whose script is `type-check` (Pixtron web-admin) won't match, so the agent runs nothing and reports clean.
- `seeds/agents/test-engineer/CLAUDE.md` — **no type-check at all.** Validation is entirely forge-test running the suite.
- **Neither seed mentions `prettier` / format-check.** Pure gap.

**Fix direction:** make type-check + format-check **mandatory** validation steps in the implementer seeds (engineer + the specialists) and test-engineer, gated like forge-test is. Make them **project-aware** (mirror the runner-detection approach #178 proposes), not a hardcoded script name:
- Type-check: discover from package.json `scripts` — try `type-check`, `typecheck`, `tsc`; else `npx tsc --noEmit` when a `tsconfig.json` exists. Only "n/a" when the project genuinely has no TS.
- Format-check: discover `format:check` / `lint` / a `prettier` devDep → `npx prettier --check` on touched files; "n/a" only when no formatter is configured.
- Tighten the seed language: a project that HAS these gates and the agent skipped one is `status: failed`, same hard-rule framing as the existing validation contract (engineer seed lines 66/86-90). "if applicable" should mean "the project has no such gate," not "optional."
- Consider surfacing `typecheck_run` / `format_checked` (or folding into the existing validation fields) so the orchestrator can reject a `complete` that skipped an available gate — same enforcement pattern as `tests_run`.

**Why it matters:** forge exists to make the container's `complete` trustworthy. A `complete` that fails CI on `tsc`/format is exactly the false-confidence failure the validation contract is meant to prevent — and it's systematic for any TS web project, not a one-off.

**Relation:** sibling to #178 (forge-test runner detection) and adjacent to #125 (seeds *mentioning* forge-test). Distinct axis: which validation *steps* are mandatory + how they're discovered.


### #249 — Handoff notes: derive 'Picked up next' from a backlog priority model instead of hand-listing (Fix B, gated)
**Follow-on to #248 (Fix A shipped in 5387cd8).** Fix A added reconciliation so /orient + /handoff catch stale ticket refs in the notes. This is the structural alternative discussed alongside it: stop hand-listing tickets in "Picked up next" at all — render them live from the backlog so they cannot drift ("derive, don't denormalize").

**Why it is gated, not done now:** the backlog has NO priority model today. The Active section is ordered by sticky number (filing order), not priority — the "Picked up next" prose is currently the only place priority ordering is expressed. So "render the list live" first requires INVENTING a priority signal (section position, a `priority:` field, or a tag) in a markdown format #174 already flags as fragile to parse/edit. And the notes' real value is the per-item next-move reasoning (e.g. "precondition for #242's verdict gate; re-measure before enforcing"), which `forge backlog list` can't produce — it returns titles only. So B necessarily becomes a HYBRID: derived ranked list + hand-written per-item reasoning + non-ticket threads, plus a cross-project notes-format migration and both skills co-evolving.

**Prerequisite (file/scope first):** a backlog priority model — a way to express + read ticket priority order independent of sticky number. Without it, B has nothing to derive from. Once it exists, the /orient + /handoff change to render-live is small.

**Decision (session 2026-06-02):** ship A (done), park B behind the priority-model prerequisite. A removes the status drift that was actually biting; B only removes ordering duplication. Revisit if drift persists despite A.

**Relation:** follow-on to #248; blocked-on a not-yet-filed backlog-priority-model ticket; touches #174 (fragile notes/backlog parser).


### #250 — Ops intelligence substrate — forge ops check: read-only incident detection with recommended-action metadata
**Reframe:** not an "Ops dashboard MVP" — an **Ops intelligence substrate**. One detection core off the SQLite blackboard, many consumers. Derived from two research lenses (run-ops-surface-lens-a-detection-surface-6fbb91 = detection surface: 15 surfaced / 24 latent-detectable / 7 schema-blocked; run-ops-surface-lens-b-operator-pain-e2645a = 8 ranked operator pains) + user direction 2026-06-02.

**Why the reframe:** the consumer is the ORCHESTRATOR, not a human at a terminal. The user never issues CLI; the orchestrator runs every command and the user converses with it. So the first deliverable is an orchestrator-facing primitive, not a web board.

### #291 — [EPIC] Stable, feature-rich Forge baseline
**Captured:** 2026-06-05. This is the commitment set for getting Forge from "powerful internal tool" to a stable, feature-rich baseline worth relying on across real projects and machines.

**Definition:** stable does not mean feature-frozen. It means the core loop is trustworthy, provider-agnostic enough to survive runtime/provider changes, easy to set up on a new machine, and documented well enough that both technical and less-technical stakeholders can understand what Forge is doing.

**Commit first:**
1. **Provider-agnostic runtime architecture / Pi PRD lands.** Accept `docs/prds/provider-agnostic-runtime-pi.md`, reconcile #258/#260-#268 to its framing, and pilot Pi as runtime + upstream-provider separation, not merely a third provider.
2. **Ops/dashboard truthfulness.** Close #290 so stale DB `running` is not shown as ordinary running when filesystem/Docker reality says "reconcile candidate."
3. **Routing control plane hardening.** Finish the RACI/routing follow-through: #287 route-before-dispatch adherence, #285 governance visibility, project overrides dogfooded, and provider adapters kept thin/generated per #253.
4. **Collaborative setup and new-machine readiness.** Advance #252 so `forge init`/`forge upgrade`/doctor flows generate and validate project config instead of asking humans to hand-write YAML.
5. **Docs impact becomes hard to forget.** Build on #289 with enough enforcement or structured checking that operator-facing behavior changes cannot silently ship with unresolved docs impact.
6. **One showcase workflow.** Advance #251 research-synthesis as the feature-rich demonstration: parallel researchers, synthesis, provider/model diversity, auditability, and dashboard visibility.

**Why these first:** they cover the reliability spine (truthful state, routing adherence), the provider future (Pi/runtime split), the onboarding spine (setup/doctor), the maintenance spine (docs impact), and one high-value feature that proves Forge's multi-agent value beyond direct coding.

**Acceptance for the baseline:**
- Pi PRD is tracked and #258's backlog language no longer contradicts it.
- Dashboard/Ops has a tested read-only reconcile-candidate signal.
- Orchestrator dispatch has evidence that routing policy is resolved before work starts, including project override dogfood.
- A new-machine/project setup path validates seeds, runtime image/tool availability, provider auth, model policy, docs surfaces, routing policy, and adapters.
- Implementation runs carry a resolved docs-impact outcome or a filed deferral ticket when operator-facing behavior changes.
- Research-synthesis can run as a coherent Forge workflow or explicitly chosen orchestrator-mediated equivalent with durable task/audit visibility.

Non-goals:
- Dropping Claude Code or Codex immediately.
- Building every future dashboard feature before stabilizing the core loop.
- Treating "feature-rich" as unbounded scope. This epic is about the first baseline, not the whole product roadmap.

Relations: #258, #290, #273, #287, #252, #289, #251, #253, #285.

### #251 — Dual-research workflow: v2-native replacement for old investigation
**Captured from user direction 2026-06-02.** We want the dual-research / synthesis shape as a v2-native replacement for the removed `investigation` pipeline. This is about the workflow semantics; the broader config/setup ergonomics are split to #252.

**Research workflow shape to preserve:** create a v2-native replacement for the old `investigation` pipeline, likely named `research-synthesis` rather than resurrecting `investigation`. Flow:
- Frame the user question into concrete research lanes / claims.
- Fan out independent dual researchers per lane: primary evidence and counter-evidence / skeptic.
- Keep those researchers independent; neither should read the other's output before synthesis.
- Synthesize both sides into `supported | refuted | inconclusive` judgments with cited evidence and disagreement notes.
- Avoid normal red `pass/fail` semantics on investigator outputs. #73 was right: research needs opposing evidence and synthesis, not red-verdict review vocabulary.

**Provider/model routing requirement:** support intentional mixed-provider research, e.g. `research-primary` on Claude model/profile X and `research-skeptic` on Codex/OpenAI model/profile Y. Current shipped model policy can do this through agent-role profile overrides, but that implies creating/distinguishing roles and writing policy YAML. Long-term ergonomic option: step-level profile overrides such as `overrides.steps[research-synthesis.research-primary]`, so two steps can share the same seed while using different providers.

**Open design point:** decide whether this is a first-class pipeline (`forge new research-synthesis ...`) or an orchestrator-driven invoke template that still records a coherent run. The workflow wants auditability, fanout, and dashboard state, so a YAML workflow is likely justified despite v2's current "pipelines are implementation" bias.

**Relations:** #73 (research category mistake), #225 (bounded provider/profile choice), #252 (collaborative setup should generate any needed policy/config), #42 (new workflow docs need a non-existing workflow example), stale `docs/how-to-new-analysis.md` still describes removed `investigation` pipeline.


### #252 — Collaborative project config setup — stop making humans hand-write Forge YAML
**Split from #251 per user direction 2026-06-02.** The product smell is setup friction: Forge is accumulating "write this YAML by hand" steps (`docs-surfaces.yml`, `model-policy.yml`, future workflow/provider routing). That is the wrong primary UX. The user does not want to hand-author config files; setup should happen collaboratively during `forge init`, `forge upgrade`, or the first run that needs the config.

**Config UX requirement:** Forge should guide configuration through an orchestrator-mediated flow:
- On `forge init` or `forge upgrade`, detect missing/partial project config and ask concise setup questions.
- On first run of a workflow that requires config, pause and offer to generate the needed project-local files.
- Generated files should be explicit and reviewable (`<project>/.forge/docs-surfaces.yml`, `<project>/.forge/model-policy.yml`, future workflow/provider config), but the orchestrator/CLI should author them from choices.
- Preserve direct YAML editing as an expert escape hatch, not the primary setup path.

**Possible command shapes:** `forge init --configure`, `forge config doctor`, `forge config setup <capability>`, or first-run prompts from commands like `forge new research-synthesis ...` when required config is missing. The exact surface is open; the principle is collaborative setup, not "read docs and write YAML."

**New-machine requirement:** make it easy to set up a new machine with Forge. The setup path should verify/install seeds, runtimes, auth/provider availability, project hooks/slash commands, model policy, docs surfaces, and any workflow-specific config needed for the project. This overlaps #229 but is broader than image rebuild/provider auth checks.

**Why this matters:** Forge's promise is conversational orchestration across projects and machines. Every hand-written YAML prerequisite erodes the first-run/new-machine experience. Config should remain declarative on disk for auditability, but discovered and generated through Forge.

**Relations:** #246 (docs-surfaces project config introduced the pattern), #225 (bounded provider/profile choice), #229 (new-machine upgrade/init completeness), #251 (research-synthesis will need provider/profile setup), #42 (workflow docs should not normalize hand-authored YAML as the default user path).


### #253 — Provider adapter surfaces — demote CLAUDE.md and slash commands from Forge truth to generated adapters
**Captured from user direction 2026-06-02.** Provider-agnostic Forge has a discrepancy problem: some important operator surfaces are inherently provider-specific. `CLAUDE.md`, `.claude/commands/orient.md`, `.claude/commands/handoff.md`, and `.claude/settings.local.json` are Claude Code adapter surfaces, not provider-neutral Forge primitives. Treating them as Forge truth will keep causing drift as Codex / other provider surfaces come online.

**Principle:** Forge should have a provider-agnostic core and provider-specific operator adapters.

**Provider-agnostic core:** durable semantics and machine-readable primitives owned by Forge, e.g. `forge ops check --json`, `forge backlog ...`, workflow YAML, model-policy/profile resolution, project config under `.forge/`, and future orientation/handoff state commands if needed.

**Provider-specific adapters:** render the core semantics into the affordances of one tool:
- Claude Code: `CLAUDE.md`, `.claude/commands/orient.md`, `.claude/commands/handoff.md`, `.claude/settings.local.json` hooks.
- Codex / other tools: equivalent instruction files, command surfaces, session hooks, or no-op/CLI-only fallback depending on what the tool supports.
- Generic fallback: Forge CLI commands + docs, no provider-local slash-command assumptions.

**Design rule:** provider-specific files may exist, but they must be thin renderings of Forge-owned semantics. `/orient` should not be the canonical implementation of orientation; it should be a Claude adapter that runs Forge primitives and synthesizes them. `/handoff` should similarly render a Forge-owned handoff/update protocol rather than becoming the only place that protocol lives. `CLAUDE.md` should be treated as the Claude Code rendering of an orchestrator contract, not the contract itself.

**Practical direction:**
- Define an adapter compatibility matrix, e.g. `claude-code: full`, `codex: partial`, `generic: CLI-only`.
- Teach `forge init` / `forge upgrade` to install/update adapters based on configured provider/tooling rather than assuming Claude-only surfaces forever.
- Move heavy logic out of provider-specific prose and into Forge CLI JSON/state commands where possible.
- Keep provider-specific docs honest: Claude supports slash commands today; other providers may consume the same Forge core through different affordances.
- Avoid duplicating behavior across adapters. If `/orient` and a future Codex adapter disagree, the bug is that the behavior is not in the provider-neutral core.

**Why this matters:** #252 says setup/config should be collaborative and generated rather than hand-authored YAML. The same applies to provider-specific operator surfaces: they should be generated adapters over a Forge-owned contract. Otherwise every provider adds another hand-maintained prompt/doc surface and provider-agnostic routing becomes performative.

**Relations:** #252 (collaborative setup / generated config), #250 (`forge ops check --json` is the right kind of provider-neutral primitive), #248 (`/orient` + `/handoff` reconciliation lives today in Claude slash-command prose), #225 (bounded provider/profile choice), provider-agnostic model work / AWN-7.


### #258 — [EPIC] Provider-agnostic runtime architecture, with Pi as the pilot/default candidate
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


### #265 — pi: model-policy integration + alias mapping
**Phase:** Walk. Part of #258.
Wire Pi into `model-policy.yml` resolution by separating runtime selection from upstream provider/model selection. Model policy should resolve capability/profile -> runtime (`pi-*`) + upstream provider (`groq`, `anthropic`, `ollama`, etc.) + concrete model, with alias translation where Pi provider/model names differ from Forge capability aliases.
**Acceptance:** a profile resolving to a Pi runtime plus upstream provider routes correctly; an unknown runtime/provider/model alias fails loud, not silently.
**Depends on:** end-to-end story.


### #268 — pi: local models via models.json (Ollama/LM Studio/vLLM)
**Phase:** Run. Part of #258.
Enable local/custom models through `~/.pi/agent/models.json` (any OpenAI/Anthropic/Google-compatible endpoint). Target cheap/free reds and triage on local hardware.
**Acceptance:** a forge red/triage task runs against a local Ollama model via pi; recorded cost ~0.
**Depends on:** end-to-end story, model-policy mapping.


### #270 — Reds: render the ## Spec section (architect intent + tech-lead plan) for cross-checking
**Follow-up from #269.** The red seeds reference a `## Spec` section — "compare against the architect's intent + the tech-lead's plan (both in `## Spec`)" — but `renderTaskPackage` never produces it. Reds still function (they audit the artifact + read /project read-only), so this is degraded context, not a hard failure (#269 fixed the hard failures: artifact + failureModes + fanout dispatch).

**Scope:** thread the upstream architect result + tech-lead plan into the red task package (dispatchReds has the run's tasks available) and render a `## Spec` section. Gives reds the intent to grade against, not just the diff. Small, isolated.


### #272 — Implementer seeds: tell agents node_modules is a fresh container-local volume — install before build (#245 companion)
**Companion to #245** (container-local node_modules shadow volume, commit 02ca0b9). With the shadow volume, the container's `/project/node_modules` starts EMPTY (the host's modules are intentionally hidden, and on darwin they're wrong-platform anyway). Build/test agents must run a clean install (npm/pnpm/yarn, per the project) before building/testing, instead of leaning on the mounted host modules.

Today agents muddle through (the forge-site run showed them hand-fetching `@esbuild/linux-x64`/rollup) — a clean `npm install` into the fresh volume is strictly better, but the implementer seeds should say so explicitly so it's reliable, not improvised.

**Scope:** add a short note to the implementer seeds (engineer, frontend-specialist, backend-specialist, agentic-platform-builder) — "the container's node_modules is a fresh volume, not the host's; run the project's install before building/testing." `forge-test` already rebuilds its own deps in scratch, so tests are covered; this is about dev-server/build steps. Markdown-only → documentation-maintainer.

Low priority until #245 is validated on the corp Mac (the shadow volume is darwin-only and agents already install in practice), but worth doing so the behavior is documented rather than emergent.


### #273 — EPIC: RACI-to-routing-policy system
**PRD:** `docs/prds/raci-routing-policy.md`.

Build a provider-neutral routing policy system from Forge's human-readable RACI, to an external-user robustness standard. The RACI stays the human-authored governance SOURCE; the derived routing policy becomes the orchestrator/provider-adapter operational source of truth; two validators keep every authoring path safe.

**Its own epic, not under #253.** Routing governance — a human safely shaping how work is routed — stands on its own whether or not provider adapters ever exist. #253 (provider adapters) is a downstream consumer that renders from the routing policy.

**Core decision:**
- RACI (constrained markdown) = human-authored SOURCE / governance view.
- `routing-policy.yml` = typed machine-readable DERIVED execution policy, compiled from the RACI. Direction is RACI -> policy, never the inverse.
- `forge raci validate` lints the authoring view (host-independent); `forge route validate` lints the operational policy (host-resolvable + drift).
- Provider adapters render FROM the routing policy, not from prose.

**Governance rule:** `Accountable` is always `human` — a policy-level invariant, not a per-row column. Agents and orchestrators execute; the human owns outcomes.

**Authoring:** humans never hand-edit loose prose. RACI-writing paths run `forge raci validate`; direct raw-policy edits are an unsupported expert escape hatch gated by `forge route validate`; the primary channel is orchestrator-mediated (conversation -> propose -> validate -> human-confirm diff -> commit), and a dedicated edit tool is deferred.

**Stories:** the PRD holds the authoritative breakdown; each story is a separate ticket tagged `Epic: #273`. This epic deliberately does NOT re-enumerate stories inline — that inline list is exactly what went stale.

**Relations:** #253 (provider adapter surfaces — downstream consumer), #252 (collaborative setup), #225 (provider/profile choice), #250 (provider-neutral ops primitive), #174 (backlog edit-body verb — needed to maintain these), `seeds/forge-raci.md`, `seeds/orchestrator-template.md`.


### #282 — RACI policy Story 9: dedicated edit tool (deferred convenience)
**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

A CLI wizard or dashboard form that writes the RACI within guardrails, sitting on top of `forge raci validate`. DEFERRED: the orchestrator-mediated channel (Story 6) already gives a non-technical operator a safe authoring loop with zero new UI, so the standalone tool is a later convenience for direct manipulation, not a foundation piece.

Acceptance:
- Tool writes only valid RACI (every write passes `raci validate`; structurally cannot emit an unknown agent, non-human accountable, or weakened force rule).
- Picks `responsible` / `consulted` / `informed` from known vocab rather than free text.
- Form/wizard shape decided at build time (CLI wizard vs dashboard form).
- Lower priority than Stories 1-8.

Relations: #273.


### #283 — RACI policy Story 10: provider adapter generation (#253 seam)
**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

After the routing policy is stable, use it as input to provider adapter GENERATION per #253 — rendering adapter surfaces FROM the policy. Distinct from #284 (Story 5b), which proves ONE surface consumes the policy by hand; this is the full generated-adapter lift. Downstream consumer; does NOT block the routing-policy MVP.

Acceptance:
- Define how Claude Code adapter surfaces (`CLAUDE.md`, `.claude/commands/*`, hooks) RENDER from routing policy.
- Define equivalent or fallback behavior for Codex / generic adapters (these may have only the compiled policy, no RACI — see Story 5 standalone validation).
- Adapter generation fails or warns when the routing policy is invalid.
- Shared behavior lives in provider-neutral primitives/policy, not duplicated per adapter.

Relations: #253, #273, #252, #284, `seeds/orchestrator-template.md`.


### #293 — Explore export of forge workflows to n8n format
**Spike / exploration.** Evaluate exporting forge workflows (and/or completed run DAGs) to n8n's workflow JSON format. Decide whether it's worth building, and if so, which direction.

**Why:** n8n's value is its visual canvas + connector catalog. A read-only export could give a familiar graph view and an interop seam without adopting n8n as a runtime.

**Format notes (n8n):** JSON with `nodes[]` (each: `name`, `type`, `typeVersion`, `position [x,y]`, `parameters{}`, optional `credentials{}`) and `connections{}` (adjacency keyed by source node name → `{ main: [[ { node, type, index } ]] }`), rooted at a trigger node. Execution is item-based: data flows along edges via expressions; branching is explicit IF/Switch/Merge nodes.

**Impedance mismatch to resolve in the spike (why this is explore, not just build):**
- Edge-passed data vs blackboard — n8n threads payloads node→node; forge uses SQLite as the blackboard (tasks read prior result.json + shared state, not edge payloads). Deepest mismatch.
- Arbitrary DAG vs phased pipeline + structured red fan-out + gates — n8n has no first-class gate (auto/human) or red verdict aggregation; those would become untyped node convention, which fights forge's Zod-validated schema.
- Node weight — a forge node is an agent role in a container under RACI routing; an n8n node is a typed integration call.

**Options ranked by fit (from session discussion):**
1. Interop at the boundary (forge triggered by / emitting to n8n webhooks) — best fit, but that's a different ticket than *export*.
2. Export forge run DAG → n8n JSON purely for visualization in n8n's canvas. The actual scope of THIS ticket. Earns its keep only if n8n's canvas is wanted over the existing dashboard.
3. n8n as forge's authoring/runtime format — poor fit; out of scope, do not pursue without a forcing reason.

**Deliverable of the spike:** a go/no-go on option 2 with a sketch of the node/connection mapping (forge phase/task → n8n node; dependency edges → connections; gates/reds → ??? — the open question) and an honest read on whether the lossy mapping is useful enough to maintain.

Relations: forge workflow model (`seeds/workflows/`, `src/v2/loader.ts`), #253 (provider adapter surfaces), dashboard run views.


### #294 — Explore export of forge run DAG to Excalidraw format
**Spike / exploration.** Export a forge run's task DAG (and/or a workflow definition) to Excalidraw's `.excalidraw` scene JSON for a sketchable, shareable diagram.

**Why this is a better-fit target than n8n (#293):** Excalidraw is purely presentational — a whiteboard scene, not an execution engine. So forge's gates, red fan-out, and phases map to *shapes and labels* with NO semantic loss; there's no blackboard-vs-edge-data or gate/verdict impedance mismatch to resolve. The only real work is layout.

**Format notes (Excalidraw):** JSON `{ type: "excalidraw", version, source, elements[], appState, files }`. Each element has `id`, `type` (`rectangle` / `diamond` / `text` / `arrow` / `ellipse`), `x`, `y`, `width`, `height`, `angle`, stroke/fill styling, and a `seed`. Arrows carry `points[]` plus `startBinding`/`endBinding` referencing element ids (with `focus`/`gap`) so connectors stay attached. Text can be a standalone element or bound to a container via `containerId` + the container's `boundElements`.

**Sketch of the mapping:**
- phase/task → rounded `rectangle` (or `diamond` for gate steps), labeled with role + status via bound text.
- dependency / next-phase edge → bound `arrow` between element ids.
- red children → smaller nodes fanned off the task they audit; verdict as label/color.
- color by status (complete / failed / running / reconcile_candidate) reusing the dashboard palette.
- layout: simple layered/topological left→right or top→down; assign x/y by phase depth.

**Open questions for the spike:**
- Layout quality — auto-layout a layered DAG well enough to be readable without manual nudging (acceptable since Excalidraw is editable after export).
- Static snapshot vs live — one-shot export of a finished run is the easy win; "live updating" is out of scope.
- Where it surfaces — a `forge export <run-id> --format excalidraw` CLI? a dashboard download button? (decide in spike).

**Deliverable:** go/no-go + a minimal proof export of one real run DAG opened in Excalidraw.

Relations: #293 (n8n export — sibling exploration, worse fit), forge workflow model (`seeds/workflows/`, `src/v2/loader.ts`), dashboard run views, reconcile_candidate status color (#290).


### #300 — [DEFERRED] pi: TRUE completing-run proof — status complete + usage row from a live pi task
**Status: DEFERRED — requires paid extra credits or an alternate free provider. Not scheduled.** This is the real end-to-end Crawl exit that #296 did NOT achieve. Until this is satisfied, do not describe the Pi Crawl as having a proven completing run.

**What's already proven (so this is narrow):** subscription OAuth auth, dispatch, and #264 provider-refusal attribution are all live (#296). The pi usage parser (#262) is unit-tested AND fed a live-captured non-zero pi stream (`src/store/__fixtures__/pi-usage-stream.jsonl`, via a streaming mock); result contract (#264) and dispatch (#261) are tested. The ONLY unobserved thing is a successfully-completing live pi call.

**What's still unobserved end-to-end:** status `complete` + a real agent-written `result.json` + a non-zero `model_calls` row from a live pi run, and that #264's attribution does NOT misfire on a healthy run.

**To satisfy (a no-cost path is preferred):**
- a free-tier provider key (Gemini / Groq / Cerebras) on a pi-apikey-style runtime — no spend; OR
- paid extra-usage credit at claude.ai/settings/usage, then re-run the #296 invoke on `pi-oauth`.
- Capture: run id, `result.json` status complete, and `forge usage` showing the pi row.

Relations: #296 (closed — auth/attribution only), #266, #262, #264, #261, seeds/runtimes/pi-oauth.yml.


### #301 — Bounded review-loop command
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
- Findings must be file/line anchored or explicitly marked unanchored.
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


## Done (recent)

### #267 — pi: error-event classification -> model_error
**Closed:** 2026-06-06.

**Phase:** Walk. Part of #258.
Map pi `auto_retry_*` / `errorMessage` events and provider errors to forge's `model_error` classification with the cause surfaced — extends #228.
**Acceptance:** a forced provider error on a pi task is classified `model_error` (not generic container_crash) with the cause string.
**Depends on:** usage-parser story.


### #302 — Orchestrator adoption of review-loop (#301 follow-up)
**Closed:** 2026-06-06.

Update orchestrator guidance so Forge-on-Forge work uses the bounded review-loop (#301) instead of manual reviewer/fixer relay.

**Scope:** (1) seeds/orchestrator-template.md source; (2) re-render this repo's live CLAUDE.md block; (3) regression guard over BOTH template + rendered live block.

**Behavior to encode:**
- Orchestrator owns route resolution + the initial implementation. review-loop is POST-IMPLEMENTATION only.
- After the initial implementation commit/range lands: `forge review-loop <ticket-id> --max-rounds 2 --route <resolved-route>` instead of manually relaying reviewer/fixer cycles.
- Present before starting the loop: ticket id, route key, commit range or --since, max rounds, reviewer/fixer roles, stop conditions.
- Do NOT use review-loop for initial implementation; do NOT manually relay reviewer/fixer when review-loop is available.
- Stop + ask the user on: blocked, max rounds reached, live spend, credential requirement, live DB migration, destructive op, product/acceptance ambiguity.
- Close a ticket only when review-loop reports closeable AND deterministic verification is green.
- If review-loop is unavailable or fails structurally, fall back to presenting the manual review result to the user.

**Acceptance:**
- Template contains the review-loop adoption rule.
- Live CLAUDE.md contains the same operational rule.
- Guard fails if either drops the rule or allows manual reviewer/fixer relay as the default.
- No model-policy integration, no multi-provider work.

Relations: #301, #287, #297, seeds/orchestrator-template.md.


### #296 — pi: subscription OAuth live auth + provider-refusal attribution (NOT the completing-run exit)
**Closed:** 2026-06-06.

**Correction — do NOT call this "the Crawl exit."** What actually landed and is proven LIVE: `forge invoke --runtime pi-oauth` authenticated via the subscription OAuth seam (#266), dispatched, reached the provider (api.anthropic.com), and the #264 failure attribution correctly surfaced a real `400 "out of extra usage"` (account pay-as-you-go balance was $0) — not a bare `no_result_json`. That is valuable and real. But the ORIGINAL acceptance below (a COMPLETING run: status `complete` + `result.json` + a usage row) was **NOT met** — the call was refused pre-generation, so nothing completed and no usage row was written. Renamed/reframed to match what shipped; the true completing-run proof is **deferred to #300** and intentionally unfunded for now.

**Original framing (the live half of #264 — superseded by the correction above).** #264 landed the deterministic result/completion contract (status + attributed failures) WITHOUT a live provider call. This ticket was the remaining end-to-end proof: route one real role through the pi runtime against a live credential and confirm a full forge task lifecycle.

**Why separate:** #264 was scoped to result-contract parity (deterministic, no live call). The "usage captured" + "gate" half needs (a) the pi-jsonl usage parser (#262) and (b) a real provider API key — neither available when #264 landed.

**Depends on:**
- #262 — pi-jsonl usage parser (so usage is captured, not failing loud as unsupported).
- a live provider credential for the pi runtime (a cheap provider — Groq/Cerebras/Gemini — or anthropic via ANTHROPIC_API_KEY).

**Acceptance:**
- A real `forge invoke --runtime pi-apikey <role> --task ...` (or a policy-bound pi profile once #265 lands) completes a genuine task end-to-end:
  - status `complete` with a real agent-written `result.json` (output-schema parity with claude/codex).
  - usage captured in `model_calls` (rows with input/output/cache tokens; pi pre-computes cost).
  - if the role is gated, the gate advances on the real result.
- Captured as a documented run (run id + result.json + `forge usage` showing the pi rows).
- Confirms the #264 attribution paths don't fire on a healthy run (no false "agent did not honor the contract").

**Already done (don't redo):** dispatch (#261), prompt-injection exactly-once (#263), result-contract + attributed failures (#264). This is purely the live e2e + usage capture wiring proof.

Relations: #258 (Pi epic), #262, #265, #261, #263, #264, seeds/runtimes/pi-apikey.yml.


### #266 — pi: OAuth auth mode (pre-seeded ~/.pi/agent/auth.json) + auth seam
**Closed:** 2026-06-06.

**Phase:** Walk. Part of #258.
Support pi OAuth providers (Claude Pro / ChatGPT / Copilot) via a pre-seeded `~/.pi/agent/auth.json` mounted into the container (mirror the forge-claude-oauth volume); integrate with the provider-availability/auth seam (#226).
**Acceptance:** a pi run authenticates via mounted auth.json without interactive login; expiry/refresh behavior documented.
**Depends on:** runtime story.


### #297 — Route resolution preflight for dispatch commands
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


### #262 — pi: usage-parser hook (parse JSONL events)
**Closed:** 2026-06-06.

**Phase:** Crawl. Part of #258.
Implement a `log_format`-keyed usage parser for Pi's JSONL (per the spike's field mapping), extracting tokens/model/upstream-provider metadata into Forge's usage record. This is the architectural correction: Pi may run Anthropic, OpenAI, Groq, Ollama, etc., so upstream provider cannot select the parser.
**Acceptance:** parser unit-tested against the spike's committed sample stream; at least one live Pi JSONL stream captured and folded into the fixture before acceptance; a usage row is recorded for a Pi task.
**Depends on:** spike, runtime story.


### #299 — forge-test in agent image must have tsx/test runner dependencies available
**Closed:** 2026-06-06.

Evidence from forge-site backlog #12: both invoked agents tried to use forge-test, but the container path failed because tsx was missing in the agent/container test environment. They fell back to running tests directly, and the host had to re-verify. This is recurring tax and weakens the validation contract.

Problem:
Engineer seeds require forge-test, but the agent image / wrapper does not reliably provide the runner dependencies needed for projects that use tsx/node test. Agents then improvise with direct test commands, which reintroduces the host/container native-module mismatch that forge-test exists to avoid.

Acceptance:
- Reproduce the failure from forge-site #12 in a container.
- forge-test succeeds for a representative tsx-based project without agents installing ad hoc globals.
- The wrapper fails loud with a useful diagnostic when a project genuinely lacks its test runner.
- Engineer/test seeds continue to require forge-test; no downgrade to direct test runs.
- Add a regression test or image smoke covering tsx availability.


### #298 — Make forge show read-only by default; reconcile must be explicit
**Closed:** 2026-06-05.

**Caught:** Pixtron dogfood, 2026-06-05. `task-engineer-b26b0f` showed `running` in the dashboard, but `forge show task-engineer-b26b0f --json` reconciled it to `complete` at the exact inspection timestamp (events 2049–2052 show `task.reconciled` firing precisely when `show` ran). **Second time today a diagnostic/read action changed task state** (the first: `forge usage` triggering the #295 migration on the live DB).

**Problem:** `forge show` calls `reconcileRun` before rendering, so an operator cannot inspect stale-`running` state without mutating it. A read command with a write side effect is surprising and unsafe, and it directly undermines #290's read-only reconcile-candidate surface — the whole point of #290 is to SEE a reconcile candidate without acting on it, but `forge show` reconciles it out from under you on inspection.

**Acceptance:**
- `forge show` does not mutate by default (no `reconcileRun`, no `task.reconciled`/`run.reconciled` events on the read path).
- If the target is a reconcile candidate, `forge show` SURFACES that clearly with the reason (`container_gone_result_present` / `container_gone_no_result`) — reuse the #290 read-only classifier (`findReconcileCandidates` / `src/ops/reconcile-candidate.ts`) rather than mutating to discover it.
- Provide an explicit mutating path: `forge show --reconcile <id>` or a dedicated `forge reconcile <id>`.
- Existing lifecycle commands that intentionally reconcile (`forge next`, `forge status`, `forge gate`) remain explicit and documented as the mutating path — this ticket narrows `show` specifically, it does not remove reconciliation from the lifecycle.
- Tests prove plain `forge show` emits no `task.reconciled` / `run.reconciled` events (the Pixtron `task-engineer-b26b0f` shape — running + container gone + valid result.json — is the regression fixture).

**Notes / design pointers:**
- The reconcile call site is `src/cli/commands/show.ts` (reads the run, calls `reconcileRun` before rendering). `reconcileRun` lives in `src/v2/reconcile.ts`; the read-only classifier is `src/ops/reconcile-candidate.ts` (#290).
- Decide whether `forge status` should also be read-only-by-default (it currently reconciles its workspace-filtered runs). Out of scope here unless trivial — `show` is the reported incident; note it for a possible follow-up.
- This is the read/write-separation companion to #290 (surface candidates) and #295 (a read command mutated the DB).

Relations: #290, #295, #250, `src/cli/commands/show.ts`, `src/v2/reconcile.ts`, `src/ops/reconcile-candidate.ts`.


### #287 — Orchestrator must resolve routing policy before dispatch
**Closed:** 2026-06-05.

**Epic:** #273. **Caught:** 2026-06-05 during first real-project routing test on Pixtron.

The RACI/routing substrate works, but the active orchestrator can still bypass it by habit: in the Pixtron test, the orchestrator initially jumped straight to `forge invoke engineer` from memory instead of resolving the work type through `forge route explain` first. That is a consumption/adherence bug, not a schema/compiler/dashboard bug.

Why this matters: #284 proved that the template can consume `routing-policy.yml`, but a real run showed that prose discipline is still skippable. If the orchestrator can dispatch from memory, project overrides and future routing-policy changes may not affect actual work even though the governance dashboard and `route explain` are correct.

Near-term scope:
- Strengthen the orchestrator template so every `forge invoke` / `forge run` decision is preceded by `forge route explain <work-type> --json` for the classified work type.
- Require the orchestrator to summarize the resolved route before dispatch: route key, path, responsible, required followups, and source (`host` or `project`).
- Explicitly mark direct shortcuts like `forge invoke engineer` invalid unless the route was just resolved from the compiled policy.
- Add a template/check test that the orchestrator block contains the routing-before-dispatch rule.

Longer-term follow-up to consider:
- Add a CLI affordance that makes the policy lookup and dispatch one path, e.g. `forge route invoke <work-type> ...` or `forge invoke --route <work-type> ...`, so the orchestrator is not asked to remember two separate commands forever.
- If feasible, make raw role dispatch warn or fail when called from an orchestrator context without a recent route resolution.

Acceptance:
- A fresh orchestrator prompt path tells the orchestrator to resolve the route immediately before dispatch.
- The resolved route is visible in the conversation before the task starts.
- Project override tests/dogfood can prove a changed project route affects the actual selected responsible/path, not only `forge route explain`.
- The direct-memory-dispatch failure seen in Pixtron is called out in the test or fixture as the regression case.
- No change to RACI schema or compiler semantics.

Relations: #273, #280, #284, #285, `seeds/orchestrator-template.md`.


### #264 — pi: first role end-to-end through pi (Crawl exit)
**Closed:** 2026-06-05.

**Phase:** Crawl exit criterion. Part of #258.
Route one role (e.g. a red on a cheap provider like Groq/Cerebras, or engineer on a chosen model) through the pi runtime and complete a real task end-to-end: dispatch -> pi -> result.json -> usage captured -> gate.
**Acceptance:** a full forge task completes via pi with correct status + usage and output-schema parity with claude/codex tasks.
**Depends on:** Docker image, runtime, usage parser, system-prompt mapping.


### #263 — pi: system-prompt / context injection mapping
**Closed:** 2026-06-05.

**Phase:** Crawl (the novel design work). Part of #258.
Map `composeSystemPrompt` + constraints into pi. pi loads context from `.pi/SYSTEM.md` / `AGENTS.md` / `CLAUDE.md` (cwd + parents). Decide the injection path: write the composed system prompt to `.pi/SYSTEM.md` in the container vs prepend to the `-p` prompt; use `--no-context-files` so pi does not double-load the project's CLAUDE.md.
**Acceptance:** a pi agent receives forge's seed + constraints exactly once; red read-only project mount still enforced.
**Note:** likely needs an architecture-advisor consult; relates to #253 (provider adapter surfaces — SYSTEM.md/AGENTS.md as a generated adapter).
**Depends on:** runtime story.


### #261 — pi: runtime YAML + spawn invocation (env-var API-key mode)
**Closed:** 2026-06-05.

**Phase:** Crawl. Part of #258.
Add `seeds/runtimes/pi-apikey.yml` mirroring `codex-subscription.yml`; wire spawn to run `pi -p "<prompt>" --mode json --no-context-files --provider X --model Y` and capture stdout JSONL. Auth: pass the provider API key as an env var into the container.
**Acceptance:** a `forge invoke` bound to the pi runtime dispatches a container that runs pi and returns captured output.
**Depends on:** #292 runtime metadata shape, Docker-image story.


### #260 — pi: add pi to the agent-dev-worker Docker image
**Closed:** 2026-06-05.

**Phase:** Crawl. Part of #258.
Install pi in `docker/agent-dev-worker.Dockerfile` (`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`, or `pi.dev/install.sh`).
**Acceptance:** image builds; `pi --version` runs as the agent UID (1000); image-size delta noted. Flag that `forge upgrade` does not auto-rebuild the image (#229), so rollout needs a manual rebuild.
**Depends on:** #292 for runtime metadata shape.


### #295 — Usage capture silently fails on fresh installs — insertUsageRows writes dropped legacy columns
**Closed:** 2026-06-05.

**Correctness bug, external-user-facing.** On a forge DB created fresh today, `model_calls` usage capture silently records nothing. Steve's host is unaffected only because his DB was migrated up from 0.1.x and still carries the legacy columns.

**Root cause:** `insertUsageRows` (src/store/model-calls.ts ~328) INSERTs into `prompt_tokens, completion_tokens, cost` (writing 0,0,0):
```
INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, prompt_tokens, completion_tokens, cost)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
```
But those three are the **0.1.x legacy columns**. The current `SCHEMA_SQL` (src/store/schema.ts) creates `model_calls` WITHOUT them, and the #155 reshape migration (src/store/db.ts ~58) only ADDs the new columns (`input_tokens` etc.) — it never adds `prompt_tokens/completion_tokens/cost`. So:
- **Migrated DB (0.1.x → now):** legacy columns still present → insert succeeds. (Steve.)
- **Fresh DB (install today):** legacy columns absent → `SqliteError: table model_calls has no column named prompt_tokens` → thrown → swallowed by `captureUsageForTask`'s try/catch → returns `{ rowCount: 0 }`. **No usage data is ever recorded; `forge usage` is empty forever, with no error surfaced.**

**Discovered:** during #292, writing a `captureUsageForTask` unit test against `makeInMemoryDb` (fresh schema). The pure parsers (`extractUsageFrom*`) are fine; only the insert is broken.

**Fix (small, isolated):** drop the three legacy columns from the INSERT — they only ever write 0 and serve nothing:
```
INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```
Verify against BOTH a fresh DB and a legacy-migrated DB (legacy columns are NOT NULL — confirm they have a DEFAULT so an insert omitting them still works on migrated DBs; if not, the migration must backfill a default or the columns be dropped).

**Related / why it stayed hidden:**
- `captureUsageForTask` swallows all errors by design (telemetry must never break task semantics) — correct, but it masks this. Consider logging the swallowed error at debug, or counting capture failures so they're observable.
- This is squarely #141 (SQL schema single-source-of-truth): the INSERT column list and `SCHEMA_SQL` drifted apart with no compile-time check. A fix here is a patch; #141 is the systemic guard.

**Acceptance:**
- A unit test inserts a usage row into a fresh-schema DB (e.g. `makeInMemoryDb`) and reads it back — proving capture works without a 0.1.x migration history.
- The same passes on a DB that DID migrate from 0.1.x (legacy columns present).
- `forge usage` shows non-empty data after a real run on a fresh install.

Relations: #141, #155, src/store/model-calls.ts, src/store/db.ts, src/store/schema.ts.


### #292 — Runtime metadata seam: separate runtime kind, log format, prompt strategy, auth strategy
**Closed:** 2026-06-05.

**Phase:** Crawl foundation. Part of #258 and #291.

**Why:** The Pi PRD's architectural correction cannot wait until after Pi is wired. Today Forge still leans on provider/profile names to infer execution behavior: model policy resolves `provider + auth -> runtime`, usage parsing is selected by provider in the runner path, and runtime YAML does not explicitly declare the log format, prompt injection strategy, or auth wiring strategy. If #260/#261 add Pi before this seam exists, Forge will be tempted to encode "provider = pi" or add another one-off branch, which is exactly the confusion the PRD rejects.

**Scope:**
- Extend the runtime YAML schema/loader with explicit metadata:
  - `runtime_kind`: `claude-code | codex | pi` (or equivalent open string if the implementation strongly prefers it).
  - `log_format`: `claude-stream-json | codex-jsonl | pi-jsonl`.
  - `prompt_strategy`: e.g. `claude-stdin-package | stdin-prepend | runtime-context-file`.
  - `auth_strategy`: e.g. `oauth-volume | codex-auth | env-provider-api-key | pi-auth-json | local-endpoint`.
- Backfill existing Claude/Codex runtime seeds with metadata, preserving current behavior.
- Thread the resolved runtime metadata into spawn/run task execution and task/run diagnostics so later code can choose parsers and prompt/auth behavior from runtime metadata instead of upstream provider names.
- Convert comments/diagnostic wording in the execution path from "provider selects parser/runtime behavior" to "runtime/log_format selects parser/runtime behavior; upstream provider/model are model-selection facts."
- Keep behavior unchanged for existing Claude Code and Codex runs.

**Acceptance:**
- Existing Claude Code and Codex runtime seeds validate with the new metadata and still resolve to the same command/auth behavior.
- A unit test proves usage-parser selection can be made from `log_format` independent of upstream provider.
- A unit test or resolver fixture proves a Pi-shaped runtime can declare `runtime_kind: pi`, `log_format: pi-jsonl`, `prompt_strategy: stdin-prepend`, and `auth_strategy: env-provider-api-key` without requiring a Pi binary yet.
- Task/run diagnostic output exposes both runtime metadata and upstream provider/model distinctly enough for `forge show --json` or equivalent orchestrator-facing JSON to tell them apart.
- No Pi Docker/image install is required in this story; #260 owns the binary.

**Relations:** #258, #260, #261, #262, #263, #265, #253, `docs/prds/provider-agnostic-runtime-pi.md`.


### #290 — Dashboard/Ops: surface reconcile candidates instead of ordinary stale running
**Closed:** 2026-06-05.

**Caught:** 2026-06-05 during Pixtron NBA dogfood. `task-engineer-de709d` wrote a valid `result.json` at 07:36 PDT, but the DB row stayed `running` until 09:24 PDT, when `forge show task-engineer-de709d --json` triggered `reconcileRun` and emitted `task.reconciled` with `reason: "container_gone_result_present"`. The live dashboard was not rendering incorrectly; it was faithfully showing stale DB state because the dashboard is read-only and does not reconcile.

**Why this matters:** a stale `running` task is operationally misleading in the exact surface meant to help the orchestrator understand live work. Forge already has a recovery primitive (`show/status/next` reconcile lifecycle state), but dashboard/ops currently cannot distinguish "actually running" from "DB says running, container is gone, result exists, needs reconciliation." That makes completed work look active for hours until some writable CLI lifecycle command happens to touch it.

**Read-only detection predicate:**
- DB task status is `running`.
- Task has a `container.started` event or manifest container name, proving it was containerized.
- Docker liveness probe for that container returns a clear "not found / no such container" result.
- `~/.forge/runs/<runId>/<taskId>/result.json` exists and parses as JSON.

**Required behavior:** dashboard and/or `forge ops check` should surface this as a reconcile candidate, not ordinary running. The dashboard must stay read-only: it should not call `reconcileRun` directly. The orchestrator can then run an authoritative lifecycle command (`forge show`, `forge status`, `forge next`, or a future explicit reconcile command) to perform the mutation.

**Conservative liveness rules:**
- Docker says running: keep showing ordinary running.
- Docker says no such container/object: classify as `reconcile_candidate`.
- Docker unavailable, daemon error, or ambiguous inspect failure: classify as `liveness_unknown`, not dead.
- Container gone + valid result: `container_gone_result_present` candidate, likely complete.
- Container gone + no valid result: `container_gone_no_result` candidate, likely orphan/failed.
- Container alive + result present: surface as anomalous, not terminal.

Acceptance:
- A synthetic dashboard/ops fixture with DB `running`, `container.started`, container gone, and valid `result.json` reports a reconcile candidate rather than healthy running.
- The Pixtron shape (`container_gone_result_present`) is encoded in the test name or fixture so this regression is recognizable.
- Ambiguous Docker failures do not produce dead/reconcile candidates.
- Detection is read-only: no task/run rows are mutated and no `task.reconciled` event is emitted by the dashboard/ops read path.
- The surfaced metadata includes the reason and an orchestrator-facing recommended action.

Relations: #214, #250, #285, `src/v2/reconcile.ts`, `dashboard/src/queries.ts`.

### #289 — Documentation impact must be explicitly resolved
**Closed:** 2026-06-05.

**Caught:** 2026-06-05 during Pixtron NBA routing test.

Documentation keeps getting missed or left to memory, and then goes stale. The routing policy already has `docs_impact:when=operator_behavior_changed` as an informed signal, but an informed signal is too passive: it can be noticed and then silently dropped. We need a structured docs-impact lifecycle so implementation routes close the docs question explicitly.

Proposed lifecycle:
- Detect docs impact as one of: `none`, `operator_behavior_changed`, `public_api_changed`, `workflow_changed`, `setup_changed`, `architecture_changed`.
- Resolve any non-`none` impact with exactly one outcome: `updated`, `not_needed_with_reason`, or `deferred_to_backlog`.
- Route to `documentation-maintainer` when durable docs are needed; do not force docs work for every tiny operator-visible tweak, but never skip without a stated reason.
- Verify during test/review that the claimed docs outcome matches the change.

Acceptance:
- Orchestrator guidance says `docs_impact` is not passive; it must be resolved before the run is called complete.
- Final user summary includes `Docs impact: updated / not needed: <reason> / deferred: #ticket`.
- If docs are deferred, a backlog ticket is required.
- Implementer seeds tell agents to flag docs-affecting changes in their result.
- Test/review guidance can call out missing or implausible docs-impact resolution.
- Pixtron NBA-style operator-visible changes either get a documentation-maintainer followup or an explicit "not needed" reason based on existing docs coverage.

Non-goals:
- No dashboard mutation/editing.
- No mandatory documentation-maintainer invoke for every implementation task.
- No schema change unless the implementation later needs durable tracking beyond prompts/backlog.

Relations: #273, #288, `seeds/orchestrator-template.md`, implementer seeds, reviewer/test seeds.


### #288 — RACI routing: distinguish architectural novelty from precedent-driven multi-file implementation
**Closed:** 2026-06-05.

**Epic:** #273. **Caught:** 2026-06-05 during Pixtron NBA routing test.

The global RACI currently nudges `implementation_full` for "multi-file" / "cross-cutting" work and `implementation_quick` for "small" / "targeted" work. Pixtron exposed a better discriminator: a task can be multi-file and cross-cutting, yet still not need architect + tech-lead if it is a direct precedent application with an existing concrete plan. The NBA work spans Go, migrations, and web-admin, but mirrors existing WNBA/MLB patterns and already has `NBA-PLAN.md`; forcing the full feature pipeline would add ceremony without reducing risk.

Decision to encode: full pipeline is for architectural novelty, unclear boundaries, missing implementation plan, new integration shape, or risk that needs architect/tech-lead decomposition. Quick chain can handle precedent-driven multi-file work when the pattern is established, the implementation plan is concrete, and mandatory test-engineer followup remains in force. Documentation followup still applies when operator behavior changes.

Scope:
- Update `seeds/forge-raci.md` routing guidance for `implementation_full` vs `implementation_quick` so "multi-file" alone does not force the full workflow.
- Refine `classification_hints` if useful: `implementation_full` should emphasize architectural novelty / unclear plan / high-risk decomposition; `implementation_quick` should include precedent-based implementation / existing plan / clear bounded change.
- Keep the compiled policy shape unchanged unless hint wording changes require recompile; this is primarily global routing guidance.
- Add or update a test/fixture if the orchestrator-template route examples encode full-vs-quick language.

Acceptance:
- A real-project case like Pixtron NBA (multi-file, precedent-based, existing plan) routes to `implementation_quick` unless the human explicitly wants the full pipeline.
- Full pipeline still clearly handles genuinely novel, ambiguous, high-risk, or architecture-affecting implementation.
- The guidance preserves mandatory `test-engineer` followup on quick implementation.
- Operator-visible changes still trigger `docs_impact` informed handling; quick does not mean "no docs."

Relations: #273, #287, `seeds/forge-raci.md`.


### #286 — Forge init/upgrade compile derived routing policy
**Closed:** 2026-06-05.


### #285 — Dashboard: read-only routing/governance panel
**Closed:** 2026-06-05.

**Epic:** #273. **Depends on:** #281.

Surface the active RACI-derived routing policy in the dashboard as observability, not control. The dashboard is currently an information-only surface and should stay that way for the near future; routing/governance visibility should show how Forge will route work for the current project without introducing a second RACI edit path.

Scope:
- Add a read-only dashboard panel/view backed by the same effective-governance data as `forge route governance --json`.
- Show the effective policy source (`host` vs `project`), policy path, validity/staleness state, and the accountable header.
- Render the route matrix: route key / work type, path, responsible target, command when applicable, consulted evidence or agents, required followups, informed targets, force rules, and classification hints.
- When a project override is active, show the host-vs-project route diff and clearly distinguish added, removed, and modified routes.
- Warn on uncompiled project overrides, missing policies, invalid policies, and policy/RACI drift instead of showing a clean-looking route table.
- Show recent RACI audit entries if available, so policy changes are visible without reading `~/.forge/raci-audit.log`.

Non-goals:
- No dashboard mutation, apply buttons, merge buttons, raw policy editing, or RACI editing in this story.
- No prompt classification by code; an "explain route" selector may look up an exact route key only, matching `forge route explain`.
- No full provider-adapter generation; #283 owns rendering provider-specific surfaces from the policy.

Acceptance:
- Dashboard displays the same effective route data as the route governance CLI/API for host-default routing.
- Dashboard displays project override source and host-vs-project diff when opened from a project with `<project>/.forge/routing-policy.yml`.
- Dashboard surfaces uncompiled override / missing policy / invalid policy / drift findings as warnings or errors, not as a normal healthy table.
- Tests cover host default, project override diff, and at least one unhealthy state.
- The dashboard remains read-only; there is no write endpoint and no UI control that mutates RACI or routing policy.

Relations: #273, #281, #280, #279, #284.


### #281 — RACI policy Story 8: effective governance view / diff preview
**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Render a READ-ONLY effective-governance view and change-preview diff FROM the RACI source plus its generated policy — surfacing what the current RACI compiles to (and what a proposed edit would change), so the table a human reads can't silently lie about what the policy does.

Acceptance:
- The view is generated from RACI + compiled policy; it NEVER writes back to the RACI. Direction stays RACI -> policy, never policy -> RACI.
- Shows the effective routes a human reads as a governance table.
- Powers the diff the orchestrator-mediated channel (Story 6) shows before a human confirms.
- Tests cover render-from-source and a representative proposed-edit diff.

Relations: #273.


### #280 — RACI policy Story 7: project override support
**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Support project-specific RACI/policy files under `<project>/.forge/`. A concrete near-term need: Forge already orchestrates real work across a portfolio, and different projects plausibly want different routing.

Acceptance:
- Project RACI override path (`<project>/.forge/forge-raci.md`) is real and wired into the prompt path, not merely documented (it currently is NOT — see PRD Problem).
- Project generated policy path (`<project>/.forge/routing-policy.yml`) is real.
- Validation makes clear whether project policy is full replacement or merge. Initial: full replacement.
- Project overrides may add/specialize routes but may NOT weaken force-level rules (validator-enforced).
- Tests cover host default, project override, invalid project override, and force-level weakening refusal.

Relations: #273, #252, #253.


### #279 — RACI policy Story 6: orchestrator-mediated authoring (primary edit channel)
**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Wire the conversation-driven edit loop as the PRIMARY way a human changes routing: the operator says what they want in plain language, the orchestrator translates it to a concrete RACI edit, gated by the validator. This is the channel that makes the non-technical-human-within-guardrails goal real with zero new UI.

Acceptance:
- Flow: propose -> `raci validate` -> compile -> `route validate` -> show the operator the rendered diff -> human confirms -> commit.
- Never a silent self-edit: changing governance always requires explicit human confirmation of the diff (the orchestrator would be editing the rules it operates by — a self-modification loop).
- Every change is audited (commit / logged entry), reviewable after the fact.
- The validator structurally prevents an invalid write (unknown agent, non-human accountable, weakened force rule).
- Tests/fixtures cover an accepted edit, a rejected (invalid) proposed edit, and the confirm-gate.

Relations: #273, `seeds/orchestrator-template.md`.


### #277 — RACI policy Story 4: add forge raci validate (authoring-view lint)
**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add `forge raci validate` — a host-INDEPENDENT lint of the human-authored RACI document. Makes no claim about what is installed on any host. (The host-resolvable half is `forge route validate`, Story 5.)

Acceptance:
- Reports parse failures against the Story 1 constrained format.
- Verifies `accountable` is `human` everywhere.
- Verifies `informed` values are from the fixed controlled vocabulary.
- Verifies `responsible` / `consulted` are well-formed SYMBOLIC names of the right kind (agent / workflow / CLI-action / evidence-source) — shape only; existence-on-a-host is route validate's job.
- Reports any force-level rule weakened by the file, checked against the static force-rule baseline shipped with Forge (built-in policy constraints + `seeds/constraints/`), NOT against host state.
- Supports JSON output.
- Tests cover clean RACI, parse error, bad accountable, off-vocab informed, malformed symbolic name, and force-rule weakening.

Relations: #273.


### #284 — RACI policy Story 5b: consumption proof — orchestrator routes from generated policy (MVP proving gate)
**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

The gate that CLOSES the inert-artifact risk — sequenced right after Story 5 (#278), part of the MVP, NOT deferred. A validated, compiled policy that no surface reads is still inert, just checkable; the MVP is not done until one surface routes from the generated policy.

Ship `forge route explain` (with `--json`) and point the orchestrator-template at the generated policy as its routing source for at least one work-type. The orchestrator classifies a prompt, calls `forge route explain`, and routes per the structured answer — a real code path consuming the policy, not prose in an LLM's context.

Acceptance:
- `forge route explain <work-type>` and `--json` return the FULL executable route: responsible, path, command (required for `path: cli`), consulted, required_followups, informed (with conditions), classification_hints, and force_rules. A CLI route without command is under-specified.
- Orchestrator-template instructs the orchestrator to consume `forge route explain` as the routing source (at least one work-type; ideally all).
- Proof of life: editing the RACI demonstrably CHANGES the route the orchestrator takes (test: change a route in the RACI, recompile, `route explain` reflects it, orchestrator routes differently).
- Distinct from #283 (Story 10, full provider-adapter generation), which stays deferred.

Relations: #273, #278 (depends on route validate), #283 (the full-generation successor), `seeds/orchestrator-template.md`.


### #278 — RACI policy Story 5: add forge route validate (operational-policy lint)
**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add `forge route validate` — validates the DERIVED policy as an executable policy in an environment. Runs at compile/deploy/resolve time and needs the host. Complements the host-independent `forge raci validate` (Story 4).

Acceptance:
- Reports schema errors against the Story 2 schema.
- Resolves against THIS host: the agent/workflow/CLI-action symbols raci validate shape-checked actually exist (responsible/consulted point at installed agents, known workflows, real CLI commands). Evidence-source consulted values (e.g. `affected_code`, `existing_tests`) resolve against the fixed evidence-source set, NOT host install state.
- (Project-override force-rule protection is NOT in this slice — route validate here takes one policy + optional RACI source, with no override input. That check is delivered with project override support, #280.)
- Drift check: when a RACI source is present, the policy still agrees with it.
- Runs STANDALONE where no RACI exists (e.g. a provider host shipped only the compiled policy — the #253 adapter case).
- Supports JSON output for orchestrator/provider-adapter use.
- Tests cover clean policy, schema-invalid, unresolved host name, override force-rule weakening, RACI/policy drift, and standalone (no-RACI) cases.

Relations: #273, #253.


### #276 — RACI policy Story 3: compile RACI to routing policy
**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add a compiler that reads the constrained RACI (Story 1 format) and emits `routing-policy.yml`.

Acceptance:
- Compiler parses the Story 1 constrained format deterministically; no dependence on loose prose.
- Generated policy validates against the Story 2 schema.
- Direction is strictly RACI -> policy; the compiler never writes back to the RACI.
- Tests cover representative rows: implementation full, implementation quick, documentation durable, review, ui-design/manual, ops repair, and orientation.

Relations: #273.


### #275 — RACI policy Story 2: define routing-policy schema
**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add a typed schema for the DERIVED `routing-policy.yml`.

Acceptance:
- Schema (`src/raci/policy-schema.ts`, Zod) for the DERIVED `routing-policy.yml`: top-level `version` + `governance.accountable` (literal `human`) + `routes` (record keyed by route-symbol). Per route: `classification_hints?` (non-empty strings), `responsible` (symbol = dispatch target; no separate target/workflow field), `path` (enum), `command` (required iff `path: cli`), `consulted` / `required_followups` / `force_rules` (symbol lists), `informed` (normalized objects `{name, when?}`).
- `accountable` is a policy-HEADER invariant fixed to `human` — NOT a per-route field. `.strict()` rejects a per-route `accountable`.
- `informed` is normalized object form in the policy (`{name, when?}`), never the source's `name:when=cond` string. `none` is a RACI-SOURCE sentinel only — the policy uses empty arrays, and `none` inside an array is rejected.
- `path` is a controlled enum; symbol fields use the #274 symbol grammar (SHAPE only). Semantic resolution — do force_rules / responsible / consulted resolve to baseline IDs / installed agents — is deferred to #277/#278.
- Tests cover: valid minimal policy; header accountable invariant; missing/non-human accountable rejected; per-route accountable rejected; valid CLI route with command; CLI route missing command rejected; non-CLI route with command rejected; empty arrays valid; `none` rejected in arrays; classification_hints shape (non-empty strings, spaces allowed); informed normalized-object shape (bare string + empty `when` rejected); malformed symbols + route keys rejected; unknown path rejected; version must be 1.

Relations: #273.


### #274 — RACI policy Story 1: implement the RACI record-block format + clean vocabulary
**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Implement the DECIDED RACI format and clean its vocabulary. Format is settled (see PRD "Constrained RACI Format"): one constrained record block per route — NOT a pipe table, NOT frontmatter, NOT embedded YAML. Record blocks stay visibly RACI-shaped for humans and parse deterministically. The compiler and both validators key off this.

Acceptance:
- Implement the record-block format + brutal parsing rules: one block per route headed by an h3 `route: <key>` marker; fixed lowercase field names; route keys unique; lists comma-separated symbols; `none` the only empty-list sentinel; conditionals as `name:when=condition`; no multiline values; free prose outside blocks ignored.
- Required fields per block: classification_hints, responsible, accountable, path, consulted, required_followups, informed, force_rules. `command` required iff `path: cli`, forbidden otherwise. No generic `target` field.
- `path` enum: in_session, invoke, invoke_chain, workflow, manual, cli. `responsible` is the dispatch target for non-cli paths; for cli, responsible is the action symbol and command is the literal invocation.
- `accountable` is `human` in every block (visible reminder); the compiler hoists it to `governance.accountable: human` and never emits per-route accountable in routing-policy.yml.
- classification_hints are advisory only — never code-dispatched (Forge does not keyword-match prompts into routes); the orchestrator and `forge route explain` may use/surface them.
- `force_rules` is required and parses as `none` or comma-separated symbols; semantic resolution against the static force-rule baseline is deferred to #277.
- `Informed` uses the controlled record/surface vocabulary; `Consulted` is agent roles or evidence sources.
- The file states plainly that the RACI is the human-authored SOURCE that compiles into routing policy (direction RACI -> policy), and removes language implying Markdown prose is the operational policy.

Relations: #273, #253, #252, `seeds/forge-raci.md`.


### #259 — pi: spike — headless --mode json run + usage-field discovery
**Closed:** 2026-06-04. Commit `1e5e019`.

**Phase:** Spike (de-risk). Part of #258.
De-risks the one hard unknown: pi's token-usage fields are undocumented.
Run pi with one API-key provider, `pi -p "<prompt>" --mode json`, capture the JSONL stream. Identify which event(s) carry input/output token counts, the model/provider actually used, and stop reason; confirm `agent_end` is the completion signal.
**Acceptance:** a documented mapping pi-JSON-event -> {input_tokens, output_tokens, model, stop_reason} sufficient to write the parser, plus a captured sample event stream committed as a test fixture. No production code.
**Blocks:** the usage-parser story.


### #187 — Native arm64 (multi-arch) agent image — drop the amd64 Rosetta tax on Apple Silicon
**Closed:** 2026-06-04. Commit `ad1126c`.

**Broad perf win.** docker/build.sh pins `--platform linux/amd64`, so on Apple Silicon EVERY agent container runs under Rosetta/qemu emulation (2-4x slower CPU). This taxes every run — builds, tests, browser work, the review panel that triggered this investigation (red-wide blew past a 10-min ceiling largely due to emulation + contention).

**Sole root cause:** the headless Chrome baked for the browser-tools skill (`:9222`) comes from `@puppeteer/browsers install chrome` (Chrome for Testing), which Google publishes for linux64 only — no official Linux/arm64 binary. build.sh pins amd64 for that one dependency; everything else pays the tax as collateral.

**Why it's achievable now (and the codebase contradicts itself):** build.sh claims Chromium-for-Testing has no arm64; the Dockerfile comment (lines 43-44) claims it "ships both arm64 and amd64" and that we "need multi-arch long-term." Chrome FOR TESTING is genuinely amd64-only on Linux, BUT:
- #180 already bakes Playwright's chromium into the image (project E2E). Playwright's chromium DOES ship linux-arm64.
- browser-tools uses puppeteer-core, which can drive any chromium via `executablePath`.
So: point browser-tools at Playwright's (already-present, arm64-capable) chromium, drop the @puppeteer/browsers Chrome-for-Testing dependency, and the amd64 pin's only justification is gone. The thing build.sh was avoiding ("dragging Playwright's arm64 chromium back in") is already done by #180.

**Proposed:**
- Repoint browser-tools' `:9222` Chrome to Playwright's chromium (executablePath), removing the @puppeteer/browsers chrome install. Verify browser-start/nav/screenshot + auth-inject all work against it.
- Build the image native arm64 on Apple Silicon; multi-arch (buildx) so amd64 hosts (CI/Linux servers) still get amd64.
- Reconcile/remove the contradictory amd64-vs-arm64 comments in build.sh + Dockerfile; update the #128 decision record.

**Verify:** agent-entrypoint.sh launches the right chromium binary on :9222; better-sqlite3/sharp/Go toolchain build native arm64 (all arch-agnostic or arm64-available); the browser-tools skill is host-mounted (pi-skills) so it's arch-neutral — only the in-container chromium binary path matters.

**Caveat:** quantify the actual win per step before committing effort — pure-reasoning agents are network-bound (Claude API) and gain less; CPU/browser/build/test-heavy steps gain most. But the review panel evidence suggests it's material.

Relates to #128 (container Chrome + retire Playwright MCP), #180 (Playwright chromium baked in).


### #271 — frontend-specialist seed: Playwright/E2E fallback when browser-tools unavailable (stop failing correct code)
**Closed:** 2026-06-04. Commit `ef51999`.

**From a forge-site run (Issue 3a).** task-build-0-caa1ac returned `status: failed, error: "visual-verification-blocked: Chrome not available"` on code that was actually correct. The container's browser-tools is broken (browser-start.js targets the macOS Chrome path; :9222 refused; browser-tools npm install fails on the read-only fs), and the frontend seed treats "no browser" as a HARD failure (CLAUDE.md line ~100) with no fallback — so correct UI work is reported failed. Meanwhile Playwright (`test:e2e`) DID run in-container against the built dist.

**Fix (seed prose):** add a visual-validation fallback chain to the frontend-specialist seed:
1. Primary: browser-tools (:9222) as today.
2. Fallback: if browser-tools/:9222 is genuinely unavailable, use the project's Playwright/E2E suite (real headless chromium in-container) and capture its artifacts in `screenshots`.
3. Only `status: failed` when NEITHER path is available.
When browser-tools is down but Playwright validated AND code/tests pass: return `status: complete` with an explicit caveat (browser-tools infra gap, see #187) — do NOT fail correct work. Preserve the anti-skip intent: must still attempt visual validation; never substitute type-check alone.

**Related infra (tracked, not this ticket):** #187 (point browser-tools at the baked Playwright arm64 chromium — fixes browser-tools in-container), #245 (container-local node_modules shadow volume — fixes the arch mismatch / Issue 3b). This seed change is the immediate stop-bleeding fix; #187/#245 fix the underlying container.


### #269 — Reds not fed the artifact; authoritative build (fanout) reds never dispatch
**Closed:** 2026-06-04. Commit `435a9e6`.

**Reported from a forge-site run.** The build phase's adversarial review silently did not run; a force-advance could ship an unreviewed diff.

**Three root causes in the v2 red-feed path (v1 src/spine deleted in #116; incompletely ported):**
1. **Fanout reds never dispatch (Symptom B):** `dispatchFanoutStep` aggregated children then jumped straight to `finalizePrimary` — it omitted the reds block that `dispatchSingleStep` has. So the build parent went to awaiting_gate with zero red task rows; the verdict gate had no verdicts to resolve.
2. **Artifact dropped (Symptom A / red-wide):** `renderTaskPackage` rendered only `## Inputs`; it never rendered `tp.artifact`. The red seeds read the artifact from a `## Artifact under review` section, so reds saw empty inputs and reported "no artifact provided."
3. **failureModes missing (Symptom A / red-narrow):** `runOneRed` set `inputs: {}`; force-level anti-prompts (which red-narrow requires as a `failureModes` input) were never populated. `compose.ts` left this "out of scope" and nothing else did it.

**Fix:** wire per-parent reds dispatch into the fanout path (mirror dispatchSingleStep); render `## Artifact under review` from `tp.artifact`; populate `inputs.failureModes` from force-level antiPrompts scoped to the reviewed (blue) role/workflow/phase. 4 regression tests added.

**Follow-up (separate):** reds also reference a `## Spec` section (architect intent + tech-lead plan) that the renderer doesn't produce — degraded context, not a hard failure. Filed separately.


### #257 — Docs as a pipeline phase — add a documentation-maintainer step to the feature workflows (supersedes the stalled hard-gate approach)
**Closed:** 2026-06-03. Commit `3d99ebe`.


### #179 — Cleanup: qa-engineer is an orphaned #164 leftover — remove seed + fix stale docs (pipeline verify is test-engineer now)
**Closed:** 2026-06-03. Commit `ebf919d`.

**Leftover from #164** (closed), which moved the pipeline verify phase from `qa-engineer` to `test-engineer` and intended to "rework qa-engineer -> manual-qa (rename or deprecate)" + "update workflow definitions referencing qa-engineer." The workflows were updated (all three `feature*.yml` now use `agent: test-engineer` for verify), but the deprecation tail was left:

- `seeds/agents/qa-engineer/` seed dir still exists (no current workflow references it; confirmed via grep).
- `docs/quick-start.md:147` still says the pipeline verify phase is `qa-engineer` — stale, should read `test-engineer`.
- `docs/SCHEMA-CONTRACT.md:109` still documents a `qa-engineer` role.
- (Historical PRD drafts under `docs/prds/yaml-orchestrator-116/` also mention it — those are frozen design docs, leave as-is.)

**Why it matters:** orphaned seeds + stale docs are exactly the contract-vs-behavior drift this session keeps surfacing — a future session reading quick-start would think verify is qa-engineer, contradicting the workflows + the orchestrator template. Old pipeline runs in the DB show `qa-engineer` verify tasks writing 0 test files; that role is dead in the current pipeline.

**Fix:** remove the `qa-engineer` seed dir (or, if any value remains, fold it into `manual-qa` per #164's intent), update `quick-start.md:147` and `SCHEMA-CONTRACT.md:109` to `test-engineer`. Small, isolated, docs + seed only.


### #256 — forge cancel <task> abandons a still-advanceable mid-pipeline run (no non-terminal tasks ≠ dead)
**Closed:** 2026-06-03. Commit `38d428e`.


### #254 — Post-task persistence assertion: fail tasks whose result.json claims files_modified but the /project bind mount is unchanged
**Closed:** 2026-06-03. Commit `5b2197e`.


### #255 — forge retry --force orphans a duplicate primary parent; no clean way to drop an orphaned pending primary on an ACTIVE run (cancel abandons, ops repair is terminal-only)
**Closed:** 2026-06-03. Commit `3bb0deb`.


### #248 — Handoff notes drift: /handoff + /orient never reconcile ticket refs against backlog Active/Done + git
**Closed:** 2026-06-02. Commit `5387cd8`.

**Recurring process bug (observed across projects — LiveBig, and live in the forge session 2026-06-02).** The handoff notes block lists tickets under "Picked up next" that have already merged and dropped off the active list (e.g. LiveBig #24 `c51b9dd`, #26 `ca5540c`). Because forge uses the notes block as start-of-session operating context, the orchestrator re-scopes or duplicates already-shipped work. Same class of bug as the docs-drift arc (#236–242): present-but-wrong prose vs. ground truth — except here the stale artifact is the handoff itself.

**Root cause: the notes are a hand-maintained denormalized cache of state that is authoritative elsewhere (backlog Active/Done + git merge commits), and nothing reconciles the cache.**

Neither end of the session loop does the join:
- **/handoff (write side)** fetches `forge backlog list --status done | head -30` — so it KNOWS what merged — but its instruction is "draft 2-3 starting moves," not "cross-check each ticket against Done + git merges and drop the ones that landed." No reconciliation step. The `head -30` cap can also hide an older merge.
- **Close→notes are two separate manual acts.** `forge backlog close` moves a ticket but does NOT touch the notes' priority list (reproduced this session: #246 closed via CLI but stayed in "Picked up next" until a reviewer caught it). /handoff is supposed to re-sync — but from the author's memory, not a mechanical diff.
- **/handoff explicitly defers correctness to /orient** ("If the synthesis is wrong, they'll catch it in the next session's /orient") — but **/orient's only staleness check is structural** ("notes block missing a 'Picked up next' section"), never semantic. It prints the active list AND the notes' priorities side-by-side but never JOINS them. The intended safety net has no check wired; it offloads to the human's eyeballs, which is exactly the reconciliation that gets skipped.
- **"Picked up next" conflates two content kinds**: tickets (status authoritative elsewhere → should be derived/validated, not hand-copied) and non-ticket threads (e.g. "LiveBig live-game hardware verification, which isn't a ticket" → the notes genuinely OWN these). They share one prose blob, so the load-bearing non-ticket thread hides among stale ticket refs.

**Ground truth (skills verified 2026-06-02):** source copies at `scripts/claude-commands/{handoff,orient}.md` install to `.claude/commands/`. A fix edits the source.

---

**Fix direction A — reconciliation at both ends (cheap, additive, kills the symptom directly).** Both skills already hold the needed data.
- /orient: extract `#\d+` from "Picked up next", join against `forge backlog list --status active` + recent merge commits; flag mismatches under **Needs attention** ("notes list #24 as next, but merged `c51b9dd` and off active"). Turns the toothless structural check into a real one.
- /handoff: before writing a ticket into "Picked up next", verify it's still Active with no merge commit; route landed ones to "Shipped" instead.
- No format change, no migration. Catches the actual failure (stale ticket STATUS).

**Fix direction B — structural "derive, don't denormalize" (correct in principle, but costs more than it looks).** Make "Picked up next" carry only a live-rendered pointer to the prioritized backlog + the non-ticket threads/narrative.
- **Hidden cost: the backlog has NO priority model today.** The Active section is ordered by sticky number (filing order), not priority — the "Picked up next" prose is currently the ONLY place priority ordering is expressed. Deriving the list means INVENTING a priority signal (section position, a `priority:` field, or a tag) in a markdown format #174 already flags as fragile to parse/edit.
- **Can't fully eliminate the prose.** The notes' real value is the per-item *next-move reasoning* ("precondition for #242's verdict gate; precision path in <ADR>; re-measure after") — not derivable from `forge backlog list`, which gives titles only. So B becomes a HYBRID: derived list + hand-written reasoning + non-ticket threads. More moving parts, plus a seam between derived and hand-written content.
- **Format change → cross-project migration** of every project's notes block + both skills co-evolving.

**Recommendation:** A first (directly addresses the drift symptom, zero migration). Treat B as a separate, larger effort gated on a real backlog priority model — and note B's "derive" only removes ordering duplication, while A removes the status drift that's actually biting. They're not lesser/greater versions of the same fix; they address different parts. Decision pending (see session discussion).

**Relation:** symptom-sibling to the docs-drift arc (stale prose vs ground truth). Touches #174 (fragile notes/backlog parser) as a headwind for any structured-field approach.


### #246 — Docs drift — cross-project: make OPERATOR_SURFACES project-configurable (inference is forge-path-hardcoded)
**Closed:** 2026-06-02. Commit `cb7ecf9`.

src/v2/contract.ts OPERATOR_SURFACES is hardcoded to forge's own layout (src/cli/, seeds/, src/notify/, ...). On any non-forge project the path inference matches nothing, so forge show's docs-impact auto-suggest and the #242 shipped advisory's 'impacted' detection never fire automatically — they only work if the orchestrator explicitly sets operator_behavior_changed:true in the task contract.

The documenter agent, the docs_drift red category, and the advisory's resolution-detection (docs_updated / deferral) all work generically — only the path INFERENCE is forge-specific.

Fix options: per-project .forge config (e.g. docs-surfaces: [globs]) that overrides/extends the defaults, and/or project-type defaults (a React app's operator surfaces differ from a CLI's). Until this lands, docs-impact inference is forge-on-forge only; document that limitation where operator_behavior_changed is described.


### #242 — Docs drift — Run: unresolved docs impact blocks 'shipped'
**Closed:** 2026-06-02. Commit `53f680c`.

Acceptance gate (final slice). A feature cannot be "shipped"/complete if operator_behavior_changed is true and docs impact is unresolved. Depends on Walk + the detection layers (Crawl 3/4/5).

- Gate on the drift VERDICT (mechanical L1/L2 clean + semantic L3 clean, OR stale-found-and-resolved) — NOT a "docs task ran" checkbox (that's the present-but-wrong rubber-stamp failure).
- Allow deferred-with-reason (docs_not_updated_reason) so it doesn't block when docs genuinely aren't needed.
- Fire on operator_behavior_changed, not "a doc-ish file was touched" — over-firing erodes the gate into ceremony.


### #241 — Docs drift — Walk: docs_impact / operator_behavior_changed on task contracts
**Closed:** 2026-06-02. Commit `e98b2d5`.

Add docs_impact (none|operator|architecture|migration|api|examples) and/or operator_behavior_changed:bool to AWN-4 task contracts. Depends on Crawl 1-3.

- Default-inferred from changed paths (src/cli, seeds, docs, learnings/decisions, runtimes, auth/model/notify code); orchestrator can override explicitly.
- Auto-suggest documenter (Crawl 1) invocation when those surfaces change.
- Start COARSE: operator_behavior_changed:bool is the gate input. Let the 6-way enum emerge from real usage rather than over-specifying up front (premature precision).


### #238 — Docs drift — Crawl 3: docs-drift finding category in red/review output
**Closed:** 2026-06-02. Commit `11fbab2`.

Add a docs-drift ("stale docs") finding category to red + review output (AWN-5 findings). The check is "do docs match SHIPPED BEHAVIOR," NOT "are docs present" — the latter passes on present-but-wrong docs, which is the actual failure mode.

Artifact-driven: the red/reviewer receives the diff + user-facing behavior summary + affected doc paths and flags docs that still describe the old behavior. Findings feed the result contract's stale_docs_found (Crawl 1). This is the semantic (L3) layer — it catches prose/status staleness ("Scope (Crawl)", "next slice", ADR contradictions) that the mechanical layers (Crawl 4/5) can't.


### #237 — Docs drift — Crawl 2: narrow orchestrator direct-edit allowlist; route docs-impact tasks
**Closed:** 2026-06-02. Commit `64aa226`.

The orchestrator routes durable/operator-facing doc changes to documentation-maintainer (Crawl 1) and stops casual direct edits — that's exactly where drift keeps happening (5x this session). Docs are an artifact, like code.

Update seeds/orchestrator-template.md (+ re-render forge's own CLAUDE.md via forge upgrade).

STAYS orchestrator-direct: BACKLOG.md (via forge backlog CLI), session notes, small handoff/status notes. (Not "orchestrator writes nothing durable" — it must keep working memory + backlog state.)

ROUTES through the documenter: docs/**, learnings/decisions/**, seeds/** prose/comments/templates, CLI how-tos, runtime/model/auth/notification examples, README-style guidance.

Also: add orchestrator guidance "when behavior changes, route a docs-impact task," and a "Docs impact: none/updated/deferred" line in PR/review output.


### #236 — Docs drift — Crawl 1: documentation-maintainer agent seed
**Closed:** 2026-06-02. Commit `b11d1c8`.

The authoring home for operator-facing docs — the docs analog of the engineer. NOT marketing copy: maintains operator docs, ADRs, examples, upgrade notes, seed prose/comments.

- Seed: seeds/agents/documentation-maintainer/CLAUDE.md.
- Artifact-driven inputs: changed files, relevant tickets, manifest/events (if any), a user-facing behavior summary, likely-affected doc paths.
- Returns a docs result contract: { docs_updated: [], docs_not_updated_reason: null|string, stale_docs_found: [], operator_behavior_changed: bool }.
- Markdown-only -> corruption-safe: FORGE-DEC-011 (grpcfuse xattr / native-module) does NOT apply (no node_modules touch), so it can run even forge-on-forge.

META (applies across the Docs Crawl set): the problem is DRIFT (present-but-wrong docs), not absence — hit 5x in one session, all caught by the user, none by the orchestrator. Build on existing machinery (AWN-4 contracts, AWN-5 reds, result schemas), NOT a new docs platform. Gate on a drift VERDICT, never a "docs task ran" checkbox. Fire on operator_behavior_changed, not "file touched". Allow deferred-with-reason. Models the #202/#203 Crawl/Walk/Run staging.


### #244 — __tmp
**Closed:** 2026-06-02.

x


### #240 — Docs drift — Crawl 5: prototype L2 changed-primitive grep; MEASURE noise before enforcement
**Closed:** 2026-06-02. Commit `c96296e`.

Prototype a check that, for primitives changed in a diff, greps docs/ seeds/ learnings/ for stale mentions and surfaces them as findings — the highest-leverage drift detector (literally what was done by hand 5x this session). Self-maintains the "likely-affected doc paths" (no static surface->docs map to rot).

HIGH-SIGNAL primitives ONLY (no giant keyword list):
- command names: `forge notify milestone`, `forge model resolve`, `forge providers doctor`
- flags: --profile, --auth-profile, --notify-policy
- schema fields: activity:, runtime:, model-policy.yml, allowed_profiles
- event names: orchestrator.milestone, model.profile_resolved
- runtime names: codex-subscription, claude-bedrock

AVOID broad terms (model, test, run, auth, workflow) unless paired with a known namespace / nearby token.

MEASURE the false-positive rate first. Do NOT wire it as an enforcing gate until precision is proven — prototype + report noise, then decide.


### #239 — Docs drift — Crawl 4: L1 parity tests for config/examples/runtime seeds
**Closed:** 2026-06-02. Commit `bd26b2b`.

Deterministic tests (no LLM) that seed examples + configs PARSE and MATCH the current schema/vocabulary:
- seeds/model-policy.example.yml (parses under ModelPolicySchema; uses current vocab e.g. activity: not model:)
- seeds/workflows/* (parse under WorkflowSchema)
- seeds/runtimes/* (parse under RuntimeSchema; e.g. codex-subscription.yml)

Cheapest drift layer (L1). Would have caught this session's model:->activity: example drift mechanically. Runs in the normal test suite. Catches the config/example class only; prose drift is Crawl 3/5.


### #235 — Orchestrator milestones — Run: orchestrator-contract to emit milestones only at checkpoint boundaries
**Closed:** 2026-06-01. Commit `b138af1`.

Final slice of #202/#203 (Crawl shipped e168fcc; Walk = per-run policy). This is a SEED/prompt contract, not enforceable code: teach the forge-orchestrator CLAUDE.md block to emit `forge notify milestone` at natural checkpoints and NEVER on ordinary conversational replies.

Checkpoints (from the design):
- "finished implementing the slice and tests pass" -> batch_complete / acceptance_green
- "finished reviewing the agent's changes; findings ready" -> ready_for_review
- "need your decision before continuing" -> decision_needed
- "long-running workflow complete" -> batch_complete (forge gates on elapsed)
- "found a security/correctness issue worth interrupting for" -> risk_found / blocked
- "shipped" -> shipped

Add to the orchestrator block: emit at checkpoint boundaries only; use a stable --dedupe-key per logical checkpoint; let forge's policy/dedupe handle throttling (don't self-censor — emit the milestone, forge decides delivery). Forge remains the backstop (policy/dedupe/audit) regardless of orchestrator discipline. Update CONTRIBUTING/orchestrator-template seed so all projects get it via forge init/upgrade.

Note: supersedes the interim "curl $NTFY_URL for blocker/decision/batch-landed" guidance (memory feedback_ntfy_when_needed) — the milestone command is the proper mechanism.


### #233 — forge usage has no per-run/per-task scoping; silently ignores a positional runId
**Closed:** 2026-06-01. Commit `0fb68bf`.

Hit during the AWN-7 Pixtron regression Test 2. `forge usage <runId>` returned the host-global aggregate (every role/run on the host) — the positional runId was silently ignored. usage.ts options are only --by / --since / --project / --json / --limit; there is no --run or --task filter and no positional, so an extra arg is dropped.

Two issues:
1. Silent-ignore is misleading — `forge usage <runId>` looks like it scoped but didn't. At minimum error on an unrecognized positional.
2. No way to get a single run's or task's token cost from the CLI. The model_calls rows carry task_id (and task->run_id), so the data is there; usageForTask() already reads per-task in code. The `forge usage` doc deliberately punts per-run UX to the dashboard, but a CLI/orchestrator session can't use the dashboard — a --run / --task filter is the cheap programmatic answer.

Proposal: add `--run <id>` and `--task <id>` filters to the usage WHERE clause (LEFT JOIN runs r is already there). Optionally `forge show <task> --usage` to fold the token row into the resolution view. Low-risk, additive.

Relevant to AWN-7 per-policy regression testing (wanting the engineer-vs-red per-provider cost in isolation).


### #230 — forge init/upgrade silently skips on unbalanced orchestrator markers (dangling end, missing start)
**Closed:** 2026-06-01. Commit `2819fe6`.

Hit live on the Pixtron project: its CLAUDE.md had `<!-- forge:orchestrator-end -->` but the matching start marker was gone (stray edit). `forge upgrade` checks only `includes("<!-- forge:orchestrator-start -->")` (upgrade.ts:67) and `forge init` keys the in-place replace on BOTH markers (init.ts:216-219, startIdx>=0 && endIdx>startIdx). With start absent:
- upgrade reports "no orchestrator block found; skipping" and skips step 4 — silently, forever, even though a (half-fenced) block is clearly present.
- init would APPEND a second fenced block rather than repair, producing a duplicate + a dangling end marker.

The user saw a block in CLAUDE.md and couldn't reconcile it with the "no block found" message.

Proposal:
- Detect an unbalanced marker pair (exactly one of start/end present, or end-before-start) and surface it: warn with the line number and the literal fix ("missing <!-- forge:orchestrator-start --> before your orchestrator section"), rather than silently treating it as "no block".
- Optionally offer `forge init --repair` (or auto-insert the missing marker) when exactly one marker is found and the heading `# forge orchestrator` is present.
- A lone/duplicate marker should never cause init to append a second block.

Low-risk, operability. Tie-in: how-to-upgrade.md (document the marker contract).


### #231 — forge upgrade must fully provision existing projects (commands+hooks unconditional, repair block) — init is new-project-only
**Closed:** 2026-06-01. Commit `2819fe6`.

Design intent (user, confirmed): `forge upgrade` is THE command for existing projects; `forge init` is for NEW projects only. Today upgrade violates this — its step 4 (project init) is gated on the orchestrator block marker, so a project missing/with-unbalanced markers gets ALL of step 4 skipped, including slash-command + hook installation. That left a freshly-`forge upgrade`d machine with no `/orient` command, and the only workaround was `forge init` — which is wrong (init appends a second fenced block on a malformed file -> duplicate).

Also note: `.claude/commands/` and `.claude/settings.local.json` are per-machine (gitignored), so even a git-synced project with a committed, well-fenced CLAUDE.md needs upgrade to (re)create the command symlinks + hooks on each new machine. Step 4 must do that.

Required behavior for `forge upgrade` on an existing project:
- ALWAYS install/refresh slash commands (orient.md, handoff.md symlinks) + Claude hooks + .gitignore entries — these are machine-local provisioning, independent of the CLAUDE.md block state. Never gate them on the block marker.
- Block handling: replace in place when fenced; REPAIR when unbalanced (lone end/start marker — folds in #230); APPEND when a `# forge orchestrator` heading exists but no markers; do nothing only when there's genuinely no block AND no heading. Never silently skip the whole step.
- `forge init` stays the new-project bootstrap (no CLAUDE.md / first run); it should also stop blindly appending when an unfenced block already exists (dedup with upgrade's repair path).

Acceptance: on a machine where a project's CLAUDE.md is committed+fenced but `.claude/` is fresh, a single `forge upgrade` from the project dir makes `/orient` available. A project with a dangling end-marker is repaired by upgrade, not skipped, and never duplicated.

Supersedes/絶includes #230 (unbalanced-marker detection is one case here).


### #224 — AWN-7 Walk: Codex/OpenAI as a real second provider (usage-parser hook)
**Closed:** 2026-06-01. Commit `b09bc79`.


### #227 — Workflow-step vocabulary is Claude/legacy-shaped: deprecate step runtime:, rename model: -> activity:/capability:
**Closed:** 2026-06-01. Commit `e0c3384`.

Surfaced by the AWN-7 Walk mixed-provider smoke: a workflow step that routes to Codex via policy still literally reads `runtime: claude`. The smoke proves policy wins, but the step YAML vocabulary is provider/legacy-shaped and confusing.

Two fields in StepSchema (src/v2/schema.ts) are the problem:

1. `runtime: NameSchema.default("claude")` — used ONLY in legacy mode (resolveModelForTask). In policy mode the resolver derives the runtime from the (provider, effective_auth) binding and IGNORES this field entirely. So `runtime: claude` on a step that runs on Codex is dead, misleading config.

2. `model: z.string().optional()` — despite the name it holds a CAPABILITY ALIAS (e.g. "review", "reasoning"), threaded as `stepAlias` (pass-1 capability intent), NOT a concrete model. The ADR's pass-1 vocabulary is "capability"/"activity" (cf. `defaults.activity`), so this should be `activity:` (or `capability:`).

Proposed direction (align to vocabulary forge already chose):
- Rename step `model:` -> `activity:` (matches `defaults.activity` and the ADR's capability pass).
- Deprecate step `runtime:`: meaningless in policy mode. Either drop it once legacy mode retires, or rename to `legacy_runtime:` and document it as the no-policy escape hatch only.

Back-compat is the real work (cross-cutting — every workflow YAML uses these):
- Loader accepts old names with a deprecation warning and maps old->new; do NOT hard-break existing seed/per-project/~/.forge workflows.
- Update all seed workflows (seeds/workflows/*) + docs (how-to-new-workflow, concepts, how-to-model-policy) in the same change.

Scope: schema + loader alias layer + seed workflows + docs. Medium, cross-cutting, reversible. No DB schema change. Tie-in: ADR learnings/decisions/2026-05-30_provider-resolution.md (capability vs profile vocabulary).


### #226 — AWN-7 Walk-prep: provider-aware availability/auth seam (no Codex yet)
**Closed:** 2026-06-01. Commit `579f895`.

First prep slice for AWN-7 Walk (#224). Closes the provider-blind availability seam BEFORE a second provider exists, so adding Codex is a localized extension, not a mid-Walk signature retrofit. No behavior change today — only `anthropic` resolves (unknown providers fail loud at `bindRuntime`).

Seam (shipped code):
- `probeAuth(mode)` (src/v2/provider-doctor.ts) checks ANTHROPIC_API_KEY for ANY `api` auth, AWS for bedrock, OAuth hint for subscription — provider is never consulted. An `openai/api` profile would wrongly probe ANTHROPIC_API_KEY.
- `checkResolvedAvailability(res)` calls `probeAuth(res.auth)` — drops `res.provider`.
- `doctorReport()` hard-lists the three anthropic modes.

Scope:
- Thread `provider` through: `probeAuth(provider, mode)`; `checkResolvedAvailability` passes `res.provider`; `doctorReport` iterates known providers (today: just anthropic).
- Unknown provider → `status: "unknown"` with a clear detail (defensive; unreachable until Walk adds the runtime+binding).
- Anthropic logic byte-identical. Update the two callers in src/cli/commands (model.ts `--check`, providers.ts doctor).

Acceptance:
- All existing provider-doctor / model-resolution tests pass unchanged.
- New test: an `openai/api` resolution does NOT report available off ANTHROPIC_API_KEY (proves provider is honored).
- `forge providers doctor` output unchanged for an anthropic-only environment.

Deferred to Walk proper (#224): detectAuthMode provider-awareness, RUNTIME_BINDING openai row + codex-*.yml runtimes, the captureUsageForTask per-provider hook, failure_kind review.


### #220 — AWN-7 provider-runtime: extract Claude execution behind a provider interface (supersedes #106)
**Closed:** 2026-06-01. Commit `8a4773e`.

docs/agentic-workflow-next-steps.md §7. Make Claude/Codex/future agents interchangeable behind one forge lifecycle.

SUPERSEDES #106 (provider abstraction — "NEEDS ARCHITECTURE WORK"). AWN-7 is the same work with a concrete interface spec.

Scope — runtime/provider interface covering:
- prompt composition, process launch, streaming output, result parsing, usage/cost capture, cancellation, error classification.
- Move Claude-specific assumptions behind a Claude provider.
- Add a Codex provider only AFTER the interface is explicit enough to preserve lifecycle semantics.
- Workflow YAML + task contracts stay provider-neutral.

Acceptance:
- Existing Claude behavior passes through the interface with no regression.
- Provider output streams into the same container logs + lifecycle events.
- Provider failures map into the same failure_kind taxonomy.
- A smoke task runs through a second provider without changing workflow definitions.

Note: runtime YAMLs already exist (seeds/runtimes/claude-*.yml) + loader; this formalizes the execution interface, not just config. Largest/most architectural item — sequence last per the doc. Second of the broadening trio.


### #221 — AWN-8 hygiene-hardening: complete secret exclusion across bundles/logs/manifests/exports + staged-auth cleanup
**Closed:** 2026-05-30. Commit `48eedf6`.

docs/agentic-workflow-next-steps.md §8. Useful debug artifacts that never preserve secrets/prompts/auth state.

PARTLY DONE this week: forge bundle uses an allowlist (never denylist); bundle.json strips composedSystemPrompt + inputs unless --include-prompts; manifest auth block is booleans-only; logs bounded. AWN-8 = the remainder.

Remaining scope:
- Explicit denylist for .env, auth state, browser profiles, prompt inputs, token-looking values, generated credential copies — across task packages, bundles, manifests, logs, dashboard payloads, AND exports (forge export jsonl/otel payloads).
- Stage-auth cleanup: remove auth-state.json after terminal task state where practical (ties to AWN-3's "no reuse of staged credentials").
- Document redaction behavior; surface it in forge show / bundle metadata.

Acceptance:
- forge bundle tests prove auth state, .env, and prompt inputs excluded by default. (composedSystemPrompt/inputs test already landed.)
- Staged auth files removed/marked for cleanup after terminal task.
- Manifest fields useful but never credential material.
- Redaction documented + visible in forge show or bundle metadata.

Smallest remaining item (allowlist + bundle work already done). Relates to #190 (auth-profile findings). Last of the broadening trio.


### #219 — AWN-6 project-command-auth: project-owned auth profile (runs project login command to produce storageState)
**Closed:** 2026-05-30. Commit `853b418`.

docs/agentic-workflow-next-steps.md §6. Authenticated browser work where the PROJECT owns credentials/login, forge owns scoping/mounting/redaction/freshness/lifecycle.

DIRECTLY SOLVES the gap surfaced 2026-05-30: a project with programmatic QA logins (e.g. Pixtron) has no way to declare its login to forge. Today programmatic login is the documented DEFAULT but is entirely project-side (Playwright globalSetup) with no forge-side declaration; the captured-session auth-profile (#176) is the only forge-owned path. AWN-6 adds the missing middle: a declared project-command profile.

Scope (new auth_profile kind):
  auth_profiles:
    qa:
      kind: project-command
      command: npm run e2e:auth
      storage_state: .playwright/.auth/qa.json
      required_env: [E2E_SUPABASE_EMAIL, E2E_SUPABASE_PASSWORD]
      roles: [test-engineer, manual-qa, frontend-specialist]
- Project owns credentials, login flow, token refresh, cleanup.
- Forge owns role scoping, read-only mount, redaction, freshness checks, lifecycle events.
- Keep the captured-session profile (#176) as the manual fallback.

Acceptance:
- Forge checks required_env var NAMES without printing values.
- Forge runs the auth command before browser-capable tasks that request the profile.
- Forge mounts the produced storage_state read-only into the container.
- Reds do NOT receive auth state by default.
- forge show reports auth setup success/failure without exposing secrets.

Relates to #184 (auth-profile polish). First of the broadening trio (AWN-6/7/8).


### #218 — AWN-5 review-protocol: standardize red/review result schema, evidence, and severity calibration
**Closed:** 2026-05-30. Commit `a6e4e3e`.

docs/agentic-workflow-next-steps.md §5. Grounded, comparable, useful reviews.

UMBRELLA over #148 (red-narrow rework), #149 (K=3 self-consistency sampling), #150 (forge gate --feedback ground-truth labels), #113 (promote specialist reds authoritative). Those become sub-parts.

Scope:
- Review prompts standardized around invariants, evidence, severity, tests.
- Require file/line refs for code findings.
- Distinguish confirmed issues from residual risks.
- Merge duplicate findings across review agents.
- Calibrate severity against exploitability, blast radius, likelihood.

Acceptance:
- Red result schema includes finding_type, severity, confidence, evidence, affected_files, recommended_fix.
- Orchestrator can summarize convergent vs unique findings.
- Reviewers state which invariants they verified.
- Tests/fixtures reject or downgrade malformed/low-evidence review output.

References #148/#149/#150/#113. Second of the agent-quality pair.


### #217 — AWN-4 task-contract (PHASE 1: schema + surfacing)
**Closed:** 2026-05-30. Commit `751cae7`. Phase-1 scope only ("schema + surfacing first"); the phase-2 acceptance below was moved to #223 — this item is NOT the full §4.

docs/agentic-workflow-next-steps.md §4. Sharper agent assignments + concrete review criteria.

Scope:
- Explicit task contract object in task packages: objective, allowed_paths, expected_artifacts, validation.commands, auth_profile, risk, review.{required,invariants}.
- Markdown-readable AND machine-readable (manifest/package metadata).
- Orchestrator template prefers contracts when invoking agents.

Example (from the doc):
  contract:
    objective: "Add cancel race tests"
    allowed_paths: [src/cli/commands/cancel.ts, src/v2/cancel.test.ts]
    expected_artifacts: [result.json, tests]
    validation: { commands: ["npm test -- src/v2/cancel.test.ts"] }
    auth_profile: null
    risk: medium
    review: { required: true, invariants: ["cancel remains idempotent", "reds never receive auth state"] }

Acceptance — PHASE 1 (met, this ticket):
- New tasks expose their contract in forge show. ✓
- forge invoke --contract carries it into manifest.contract + the agent's package.md (rendered, with a deviation instruction). ✓
- Strict Zod schema (YAML/JSON), typo-rejecting. ✓

Acceptance — PHASE 2 (NOT met here; moved to #223):
- Result manifests record which contract checks were satisfied.
- Agents' result schema includes contract_deviations; forge show flags it.
- >=1 WORKFLOW declares a contract (workflow-YAML integration; phase 1 is forge-invoke only).
- Orchestrator template prefers contracts when invoking agents.

Known phase-1 limitation: the contract lives in the manifest + rendered package.md, NOT in the persisted TaskPackage type (src/types/index.ts) — phase 2 can promote it if a persisted-package consumer needs it.

First of the agent-quality pair (AWN-4/5).


### #216 — AWN-3 retry-policy: define retry semantics per failure_kind + preserve lineage without leaking secrets
**Closed:** 2026-05-30. Commit `c0d6233`.

docs/agentic-workflow-next-steps.md §3. Predictable retry after every major failure kind. Builds on the Crawl failure taxonomy (failure_kind) and the existing forge retry command.

Scope:
- Retry policy per failure_kind: idle_timeout, container_crash, auth_*, result_missing, result_malformed, gate_rejected, red_blocked, cancelled, unknown.
- Define inherited context: upstream results, task package, auth profile, artifacts, previous-failure summary, logs.
- Retry creates a NEW task identity preserving lineage to the failed task.
- Prevent reuse of staged credential files / partial result files (ties to AWN-8).

Acceptance:
- forge retry shows why a task is retryable or not.
- Retried tasks carry previous-failure context, no secret leakage.
- forge show renders retry lineage clearly.
- Tests: retry after idle_timeout, auth failure, cancelled, malformed result, gate rejection.

Third of the lifecycle-foundation trio.


### #215 — AWN-2 concurrent-command-safety: run/task locking + idempotency under racing commands
**Closed:** 2026-05-30. Commit `1207822`.

docs/agentic-workflow-next-steps.md §2. Prevent two forge commands advancing/mutating the same run conflictingly.

Strong overlap with #112 (transactional dispatch + gate writes — the write-transaction half). AWN-2 adds the race-guard half.

Scope:
- Audit transitions for continue/next, cancel, retry, invoke --run, gate commands.
- Lightweight run/task locking or transactional guards where needed.
- Make cancel/retry/continue idempotent under races.
- Read-only commands (status/show/dashboard) tolerate in-progress transitions.

Acceptance:
- Two simultaneous advancement commands cannot dispatch the same task twice.
- cancel racing with normal completion → one coherent terminal state.
- retry cannot attach to stale/half-finalized task state.
- Tests exercise >=1 command-race path with controlled interleaving.

Builds on #112. Second of the lifecycle-foundation trio.


### #214 — AWN-1 lifecycle-recovery: reconcile active/running state after host crash, Docker races, interrupted commands
**Closed:** 2026-05-30. Commit `2d29b4e`.

docs/agentic-workflow-next-steps.md §1. Make active/running state trustworthy after crashes.

UMBRELLA over #185 (reaper for orphaned-running tasks — hit live 2026-05-29) and related to #173 (idle-watchdog), #112/#109 (transactional dispatch). The reaper becomes one case of a general reconciliation pass.

Scope:
- Reconciliation path on first lifecycle-touching command (status/show/next/cancel).
- Detect: runs active with no live runnable work; tasks running whose container is gone; tasks with result files but unfinalized DB state; active-run-with-no-work.
- Emit reconciliation EVENTS (new event type, e.g. task.reconciled / run.reconciled) — never silently rewrite state. Idempotent.

Acceptance:
- Simulated host crash with a running task reconciles into a truthful terminal/resumable state.
- forge show <run> explains what reconciliation changed and why.
- Re-running reconciliation emits no duplicate terminal transitions.
- Tests: container-gone, container-still-running, result-present-unfinalized, active-run-no-work.

Subsumes #185 when it lands. First of the lifecycle-foundation trio (AWN-1/2/3).


### #106 — Provider abstraction (OpenAI/Codex + future) — NEEDS ARCHITECTURE WORK
**Closed:** 2026-05-30. Commit `superseded-by-219... AWN-7`.

**Why:** Today forge's three auth modes (bedrock, anthropic-oauth, anthropic-apikey) all happen to call `claude` against Anthropic models — provider is implicit, not a concept. To support OpenAI/Codex (and future providers like Anthropic-via-Vertex), forge needs **provider** as a first-class abstraction across the spine, the agent container, and the credential layer. This is the architectural prep work that *makes* #97's hierarchical-ready UI meaningful and unblocks future provider additions.

**Scope (high-level — needs design):**
- A `Provider` interface in `src/types` or `src/spine`: identity, model vocabulary, credential detection, container env shape, CLI invocation pattern.
- Refactor `spawn.ts` to ask the provider how to invoke the agent (not hardcode `claude --model`).
- Refactor `creds.ts` to be provider-aware (today's three-mode detector becomes one provider's three credential flavors).
- Container image (#75 territory): may need to host multiple provider CLIs side-by-side, or build per-provider images.
- Workflow/agent declarations: `AgentRef.model` becomes provider-scoped (e.g., `provider: 'openai', model: 'gpt-5'`).

**Not designed yet — this is a placeholder.** When forge actually needs OpenAI/Codex, this gets a real architecture-work session: read the spawn/creds/image code paths, sketch the Provider interface, decide whether providers share containers or get separate ones, plan migration of existing Claude-only code.

**Caught:** 2026-05-11 — surfaced while talking through #97. Steven's call: leave room for OpenAI/Codex without designing it now.

### #211 — RUN-3 ops-dashboard: dashboard operations summary views (success rate, failure-kind mix, durations)
**Closed:** 2026-05-30. Commit `9554c86`.

Observability RUN stage §3 dashboard surface (docs/observability.md). Bring RUN-2 metrics into the web dashboard as an operations summary view (sibling to the existing usage view).
- Run success rate, failure-kind mix, median durations by workflow/phase, cancel/retry/red-block counts.
- Reuse the dashboard's read-only query layer (dashboard/src/queries.ts); inline aggregation to keep it self-contained.
- New nav tab or section alongside activity/projects/usage. Verify with browser-tools (screenshot + inspect).
Depends on RUN-2 (#metrics) for the aggregation shape. Lower priority than the CLI surfaces.


### #213 — RUN-5 otel: optional OpenTelemetry/JSONL trace export from forge events
**Closed:** 2026-05-30. Commit `92fa722`.

Observability RUN stage §5 (docs/observability.md). After the internal trace shape is stable, add export options. The WALK-2 spanKind groundwork (run|task|docker|model|tool|auth|gate|red-review on events) is the hook.

  forge export --run <id> --format jsonl       # one event per line
  forge export --run <id> --format otel        # OTLP spans (run→task→… hierarchy)

Scope (do JSONL first — trivial, no deps): dump eventsForRun as JSONL with runId/taskId/spanKind/timestamp/payload. OTel is the stretch: map run→root span, task→child spans, lifecycle events→span events/status; emit OTLP JSON (no collector required — file output). Keep it an EXPORT path, not the source of truth. Redact payloads (no secrets — payloads are already booleans/safe text by Crawl discipline, but double-check).

Lowest priority; capstone. JSONL slice is high-value-low-cost; OTel can be deferred.


### #212 — RUN-4 bundle: forge bundle <run-id> — sanitized debug archive of a run
**Closed:** 2026-05-30. Commit `c01bd8d`.

Observability RUN stage §4 (docs/observability.md). Produce a sanitized archive for debugging forge itself or handing a failed run to a reviewer without the whole project.

  forge bundle <run-id>            # writes <run-id>-bundle.tar.gz (or a dir)

Contents: run metadata, tasks, events, verdicts, task manifests, result.json files, stdout/stderr logs, prompts/packages (optional), usage records.

SANITIZATION (hard requirement):
- NEVER include raw auth state (auth-state files, NTFY_TOKEN, AWS creds, bearer tokens). The manifest auth block is already booleans-only (Crawl) — safe.
- Redact known secret-bearing paths; do not bundle ~/.forge/runtimes or notify.env or any auth-profile material.
- Bundle is per-run: copy from ~/.forge/runs/<runId>/ + the run/task/event/verdict rows for that run, not the whole DB.

Notes: bounded log inclusion (cap or note truncation — reuse the bounded-tail discipline). --json manifest of what was included. Pure assembly helper (testable: given a temp FORGE_HOME, assert archive contents + that no secret files are included).


### #210 — RUN-2 metrics: forge metrics — aggregate durations, failures, cancels, retries, red blocks
**Closed:** 2026-05-30. Commit `b15d57a`.

Observability RUN stage §3 (docs/observability.md). Reliability/management metrics, distinct from forge usage (which is token/cost). Aggregate over runs/tasks/events:
- run success rate
- task failure kinds (counts by kind)
- median task duration by workflow/phase/role
- idle kills, cancel count, retry count, red block rate
- gate wait time

Command:
  forge metrics --since 30d
  forge metrics --by workflow|phase|role
  forge metrics --json

Notes:
- Median durations from task started_at/completed_at. failure_kind counts from task.failed event payloads. cancels from run.cancelled events / abandoned runs. retries from task.retried events. red blocks from task.blocked_by_red.
- No schema change. Pure aggregation helpers (testable) + thin CLI. Don't duplicate forge usage's token rollups — link to it.
- Depends conceptually on RUN-1's window/scan helpers; share them.


### #209 — RUN-1 runs-query: forge runs query — search historical runs by status, failure_kind, project, age
**Closed:** 2026-05-30. Commit `2b3fc82`.

Observability RUN stage §1 (docs/observability.md). CLI query over ~/.forge/forge.db to answer operational questions:
- Which tasks hit idle_timeout this week?
- Which projects have the most auth failures?
- Which runs were cancelled manually?

Command (per doc):
  forge runs query --failure-kind idle_timeout --since 7d
  forge runs query --project ~/code/app --status abandoned
  forge runs query --json

Filters: --status, --failure-kind, --project, --since <Nd|all>, --workflow. --json for orchestrator consumption.

Notes:
- No schema change. failure_kind lives in task.failed event payloads (Crawl decision), so filtering by failure_kind means scanning events per task — reuse failureKindForTask (failure-kind.ts). For hundreds of runs that's fine in-process.
- Reuse the --since window parser pattern from usage.ts. Cross-project by default (like the dashboard), with --project to scope.
- Pure query helpers in a testable module; thin CLI wrapper. Stable JSON schema.


### #208 — WALK-5 dashboard-activity: add task timeline + live activity panel to the dashboard
**Closed:** 2026-05-30. Commit `b93a6cb`.

Observability WALK stage, §1 dashboard surface (docs/observability.md:325, 403).

Bring the Crawl/WALK observability data into the web dashboard (the CLI surfaces
are WALK-1/#204; this is the browser surface).

Scope:
- Task detail view: render the lifecycle event TIMELINE (eventsForTask) — the same
  data forge show <task-id> now shows, in the dashboard.
- Live activity panel for running tasks: last-output age, idle countdown, container
  name, current status, last lifecycle event (reuse WALK-1 computation).
- Failure surfacing: show failure_kind on failed tasks; group a run's failures by
  kind (groupFailedByKind already exists in show.ts).

Verify with browser-tools (screenshot + inspect) per the standing UI-verification
rule — don't ask the user to eyeball it manually.

Depends on WALK-1 (#204) for activity computation. Lower priority than the CLI
surfaces — file last, do after the read model is proven on the CLI side.

Acceptance:
- Dashboard task detail shows the event timeline.
- Running tasks show a live idle countdown that updates.
- Verified via browser-tools screenshots.


### #207 — WALK-4 rich-notifications: run-transition notifications carry failure_kind + a forge show next-command
**Closed:** 2026-05-30. Commit `26c75db`.

Observability WALK stage, §4 (docs/observability.md:379).

Enrich the CONTENT of forge's existing run/task notifications so the ping itself
answers "what failed and what do I do next" without opening a terminal.

Target format:
  Forge: task engineer failed: result_malformed.
  Run: feature login redesign
  Next: forge show task-engineer-abc123

  Forge: task manual-qa idle for 8m; timeout at 10m.
  Run: app redesign
  Next: forge show task-manual-qa-def456

Scope:
- notify/format.ts formatRunNotification / formatGateNotification should include
  failure_kind (from the task.failed event payload — Crawl) and a derived next
  command (reuse deriveNextCommandForTask/deriveNextCommandForRun from show.ts).
- Idle-warning notifications (idle for Xm; timeout at Ym) — optional stretch, ties
  to WALK-1 idle computation.
- Respect NO_NOTIFY (#198) and the real-runs-notify rule (test suite stays silent,
  real runs ping).

RELATIONSHIP: distinct from #203 (orchestrator-done ping for forge-on-forge work,
which has NO run transition at all). This ticket improves the content of pings
that already fire on run transitions; #203 is about a ping existing for direct
orchestrator work. Implement independently; share the formatting helper.

Acceptance:
- A failure notification names the failure_kind and a copy-pasteable forge show.
- Formatting is unit-tested per failure_kind.


### #206 — WALK-3 agent-progress: parse delimited JSON progress lines from agent stdout into task.progress/artifact/decision events
**Closed:** 2026-05-30. Commit `1ea53d3`.

Observability WALK stage, §2 (docs/observability.md:331).

Agents MAY (not must) emit structured progress records as clearly-delimited JSON
lines on stdout. Forge parses them into events. If an agent never emits them,
forge still works from container lifecycle + logs — this is purely additive.

Example agent lines (JSONL on stdout):
  {"type":"progress","message":"installed dependencies","percent":25}
  {"type":"progress","message":"running unit tests","percent":60}
  {"type":"artifact","kind":"screenshot","path":"/task/homepage.png"}
  {"type":"decision","summary":"using existing auth profile qa-admin"}

These become NEW event types: task.progress, task.artifact, task.decision.
(Adding event types → update EventType union in src/store/events.ts AND ensure a
real emission path, per the no-dead-enum invariant established in Crawl.)

Implementation notes:
- Parse from container.stdout.log. Claude agent logs are stream-json already
  (#200), so the progress lines must be distinguishable from the assistant
  stream — define a clear delimiter/shape and only parse lines that match it.
- Reuse / coordinate with the captureUsageForTask stdout-scan pass rather than
  adding a second full-file read (bounded — don't slurp multi-MB logs; see the
  Crawl bounded-tail fix).
- Redact: progress payloads are agent-authored — never persist secrets; cap sizes.

Acceptance:
- Well-formed progress/artifact/decision lines become task.progress/artifact/
  decision events, readable via eventsForTask and rendered in forge show timeline.
- Malformed or absent progress lines are ignored without failing the task.
- New event types have real emission paths + unit tests.


### #205 — WALK-2 watch-activity: forge watch --json emits structured task-activity + failure-kind events
**Closed:** 2026-05-30. Commit `1dc3815`.

Observability WALK stage, §1 surface + trace-shape (docs/observability.md:326, 349).

Today `forge watch` emits one JSON event per state CHANGE (run/task status
transitions). WALK adds live ACTIVITY signal between transitions so a consumer
(orchestrator, dashboard, script) can see a running task is alive and progressing,
not just "still running".

Scope:
- `forge watch --json` should emit task-activity records for running tasks:
  last-output time, idle duration, idle countdown (reuse WALK-1 computation).
- Failure transitions in the stream should carry failure_kind (already in the
  task.failed event payload from Crawl) so a watcher branches on kind without
  parsing prose.
- Adopt the trace-shape fields opportunistically: include runId, taskId, and
  spanKind (run|task|docker|model|tool|auth|gate|red-review) on emitted records
  where applicable, per §3 Trace Shape (observability.md:349). This keeps an OTel
  export path open later (WALK/RUN-otel) without a rewrite now.

Depends on WALK-1 (#204) for the activity computation. Does NOT require agent
cooperation — derives everything from container lifecycle + log mtimes.

Acceptance:
- `forge watch --json` surfaces failure_kind on failure events.
- Running tasks emit periodic activity records (last-output age + idle countdown).
- Records carry runId/taskId and a spanKind where meaningful.


### #204 — WALK-1 live-task-activity: show running task last-output time + idle countdown in status/show/watch
**Closed:** 2026-05-30. Commit `6cd3a5d`.

Observability WALK stage, §1 (docs/observability.md:309). Make ACTIVE tasks
inspectable while still running — the Crawl work made completed/failed work
explainable; this makes in-flight work observable.

For a running task, surface:
- startedAt
- last stdout/stderr output time (we have getLastOutputMtime in show.ts already)
- idle duration (now - last output)
- idle timeout threshold (now recorded per-task in manifest.json — see Crawl
  idle-timeout fix; use the recorded value, fall back to default)
- container name
- current status
- last lifecycle event

Surfaces (this ticket = the CLI read surfaces; dashboard split to WALK-5):
- `forge show <task-id>` — already shows last-output + idle timeout for any task;
  extend to show a live idle COUNTDOWN (time remaining before idle kill) when
  status=running.
- `forge status` — add per-running-task last-output age + idle countdown column.

Builds on: idle watchdog, live log streaming, the Crawl show.ts diagnostic
helpers (getLastOutputMtime, formatTimeAgo, getManifestIdleTimeoutMs).

Acceptance:
- A running task's `forge show` shows "idle Xs / timeout Ym (Zs left)".
- `forge status` shows last-output age for running tasks so a stalled task is
  obvious without opening show.
- Pure-function-friendly so the countdown math is unit-testable.


### #202 — Orchestrator-done notifications: ping when forge-on-forge work finishes (no run transition fires)
**Closed:** 2026-05-30. Commit `superseded`.


### #201 — forge invoke --run <terminal-run> attaches a running task but leaves run status complete → live task hidden in dashboard
**Closed:** 2026-05-30. Commit `ad82297`.

Hit live (and confused the user) multiple times: when the orchestrator chains engineer -> test-engineer by attaching the second invoke to the first's run via `forge invoke --run <runId>`, the engineer phase has already marked that run `complete`. The test-engineer task IS created and its container IS running, but `forge invoke --run` attaches the task WITHOUT flipping run.status back to `active`. The dashboard and `forge status` list by run status, so the run shows `complete` and the live test-engineer task is invisible — looks like "nothing is running" when a container is actively churning.

Confirmed: run-197-task-manifest-f45aaa status=complete while forge-task-test-engineer-2e8523 was Up 7 minutes with task.started + container.started events under that run.

Fix: when `forge invoke --run <runId>` (or any path) creates a non-terminal task under a run whose status is terminal (complete/abandoned), reactivate the run — set status back to `active`. The run isn't complete if it has a running task. Sibling to #185/#186 (run-status lifecycle correctness: cancel made abandon authoritative; this makes attach reactivate).

Workaround until fixed: orchestrator should NOT attach a new invoke to an already-complete run; give each invoke its own run so it shows active.


### #199 — forge-test drops --import ./src/test-setup.ts for file-specific args → false SQLITE_ERROR + bypasses test DB/notify isolation
**Closed:** 2026-05-30. Commit `419825c`.

The forge-test wrapper (what agents use to self-validate) omits `--import ./src/test-setup.ts` when invoked with specific file arguments, whereas `npm test` always includes it. test-setup.ts is load-bearing: it sets up the in-memory test DB schema (#170 isolation) AND clears FORGE_NOTIFY so the suite doesn't fire real notifications (#175).

Consequences when an agent/human runs `forge-test <specific-file>`:
- runNext / DB-touching tests fail with SQLITE_ERROR ('no such table/column') because the schema setup never ran — a FALSE failure that makes self-validation untrustworthy (agents have flagged this twice: #194 backfill, and the earlier runNext isolation confusion).
- Potentially worse: without the import, a specific-file run could touch the real ~/.forge/forge.db and/or fire real notifications (the two things test-setup.ts exists to prevent). Needs confirming whether the file-specific path actually reaches a live DB/provider in practice.

Fix: make forge-test ALWAYS pass `--import ./src/test-setup.ts` regardless of whether file args are present. Relates to #178 (forge-test node:test vs Jest) — same wrapper.


### #197 — Crawl 5 — manifest: write task manifest.json indexing artifacts
**Closed:** 2026-05-30.

Crawl milestone, step 5 of 5 (docs/observability.md, Crawl §5). Independent of Crawl 1-4 — can be built in parallel; consumed by Crawl 4's artifact-manifest line.

Each task directory gets a small manifest.json indexing known artifacts: taskId, runId, files map (prompt=CLAUDE.md, package=package.md, result=result.json, stdout/stderr logs), container.name, and an auth block describing whether a profile was REQUESTED and whether state was MOUNTED.

**Secrets discipline:** the manifest describes whether sensitive capabilities were mounted — NOT where bearer credentials live. No token paths, no auth-state contents. Consistent with the #176 rule (credential never in prompts/logs/project-mount; this is the same principle for the manifest).

**Acceptance:** every task dir gets a manifest.json on dispatch; no secret paths in it; forge show (Crawl 4) reads it for the artifact list.


### #196 — Crawl 4 — show-detail: grow forge show <run|task> into the diagnostic view
**Closed:** 2026-05-30.

Crawl milestone, step 4 of 5 (docs/observability.md, Crawl §4). Depends on Crawl 1 (timeline read path) and Crawl 3 (failure_kind in payloads).

**Grow forge show — do NOT add forge inspect.** Forge already has status (overview) + show (detail); a third overlapping read command is user-facing sprawl before the read model is stable. Make forge show <run-id|task-id> the canonical detail/diagnostic command.

Task view adds (on top of Crawl 1's timeline): status + failure_kind, container name, elapsed time, last-output timestamp, idle timeout if known, last few stdout/stderr lines, result-file status (missing/empty/malformed/valid), artifact manifest (Crawl 5), suggested next command (e.g. failed+idle_timeout → forge retry <id>).

Run view: identity/workflow/project/status, current blockers, failed tasks grouped by failure_kind, awaiting-gate + blocked-by-red tasks, running tasks with last-output time, next suggested command. (This is where the run-id branch from Crawl 1 gets its rich rendering.)

**Acceptance:** forge show <task-id> on a failed task shows the full diagnostic block from the doc's example (lines ~227-248); forge show <run-id> summarizes blockers + failures by kind; --json for both.


### #195 — Crawl 3 — failure-kind: classify task failures in structured event payloads (no schema column)
**Closed:** 2026-05-30.

Crawl milestone, step 3 of 5 (docs/observability.md, Crawl §3).

**Do NOT add a tasks.failure_kind column in this stage.** That's a schema change to ~/.forge/forge.db with machine-wide blast radius (every running forge re-migrates on next DB open), and its only advantage — aggregate queries — isn't realized until the Run-stage metrics layer. Store failure_kind in the structured FAILURE EVENT PAYLOAD; keep tasks.error as the prose summary. Promote to a column deliberately later, tied to #141 (SQL single-source-of-truth).

**Central classifier, not 24 hand-edits.** markTaskFailed has 24 call sites (invoke.ts ×8, runNext.ts ×12, gate.ts ×2, cancel.ts ×2), several in the dispatch core. Route them through one tested classifier module that records the failure event with a kind, rather than spreading string constants across the runner.

Initial kinds + mapping: AuthProfileError(missing)→auth_missing; AuthProfileError(expired)→auth_expired; IDLE_TIMEOUT_EXIT_CODE→idle_timeout; nonzero container exit + no result→container_crash; empty result.json→result_missing; malformed result.json→result_malformed; gate reject/request-changes→gate_rejected; forge cancel path→cancelled; auth injection failure→auth_injection_failed; plus model_error, tool_error, red_blocked, unknown.

**Acceptance:** every failure event carries a failure_kind; classification logic centralized + unit-tested for every kind; orchestrators can branch on failure_kind without parsing strings. (Dashboard grouping waits for the column/metrics layer — out of scope here.)


### #194 — Crawl 2 — events-backfill: emit the genuinely-missing lifecycle events
**Closed:** 2026-05-30.

Crawl milestone, step 2 of 5 (docs/observability.md, Crawl §2). Depends on Crawl 1 (read path) so the new events are actually visible.

**Only backfill what's genuinely missing.** Already emitted today (do NOT re-add): run.created, run.completed, run.cancelled, task.created, task.started, task.completed, task.failed, task.cancelled (#186), task.awaiting_red, task.blocked_by_red, gate.decided, verdict.received.

**The real gap to fill:**
- run.abandoned — NOT in the EventType union at all; add it. forge abandons runs (cancel/reaper) but emits no abandon event.
- task.awaiting_gate — emitted nowhere; add on the awaiting-gate transition.
- container.started / container.exited / container.killed / container.idle_timeout — none exist.
- auth.profile_applied / auth.profile_failed — the #176 auth epic emits ZERO events; add when forge stages auth state (applied) and when AuthProfileError throws (failed).
- Remove the DEAD enum values task.idle_timeout and task.crashed from EventType — they're in the union (events.ts:13-14) but no logEvent call ever fires them. Their meaning moves to failure_kind (Crawl 3).

**Naming decision (settled):** container.idle_timeout is the INFRA event (watchdog fired, container killed). The TASK outcome stays task.failed carrying failure_kind: idle_timeout (Crawl 3). Likewise container.exited(nonzero)+no result → task.failed + failure_kind: container_crash. Do not emit a separate task.idle_timeout/task.crashed event — failure_kind carries the distinction.

**Land mine — container.* events emit from the CALLER, not the executor.** src/v2/docker-exec.ts (DockerExecFn) has no taskId/runId and is on the do-not-touch-without-a-learnings-entry list. Emit from src/v2/invoke.ts and src/v2/runNext.ts which hold runId+taskId: container.started before the exec call, container.exited/killed/idle_timeout after, deriving idle from the existing IDLE_TIMEOUT_EXIT_CODE the executor returns.

**Acceptance:** every status transition emits an event; forge cancel, idle timeout, gate decisions, auth failures, red blocks all visible via Crawl 1's forge show timeline.


### #193 — Crawl 1 — events-read: eventsForTask/eventsForRun + render timelines in forge show
**Closed:** 2026-05-29.

Crawl milestone, step 1 of 5 (see docs/observability.md, Crawl section). The keystone — do this first; the rest of Crawl is worthless until it lands.

**The problem this fixes:** forge's events table is WRITE-ONLY. logEvent is the only accessor in src/store/events.ts; nothing — not forge show, status, watch, or the dashboard — ever reads it back (verified: zero `FROM events` queries in src/). Forge faithfully records ~12 event types from a dozen call sites into a table no command can display.

**Scope (deliberately minimal — no schema, no new emissions):**
- Add read accessors to src/store/events.ts: eventsForTask(taskId) and eventsForRun(runId).
- Render timelines in src/cli/commands/show.ts: for a task, its lifecycle events (+ relevant run-level + verdict events) in timestamp order; for a run, run lifecycle + task events as one ordered timeline.
- Add --json output (orchestrator-consumable).

**Acceptance:**
- forge show <task-id> displays an event timeline from existing data.
- forge show <run-id> displays a run timeline (NOTE: show currently only accepts task ids — this also requires the run-id branch; coordinate with Crawl 4 which grows the run-id detail view. Minimal here = timeline; rich diagnostics come in Crawl 4).
- No schema change. No new event emissions.

Foundation for Crawl 2 (backfill — the new events need a surface to appear on) and Crawl 4 (detail view). Blocks both.


### #192 — Revisit notification suppression: global NO_NOTIFY kill-switch + invoke-path noise
**Closed:** 2026-05-29.

Revisit how forge suppresses notifications. Two related problems in the notify subsystem, to be solved together.

**Problem 1 — testing suppression is indirect.** Today #175 silences the test suite by clearing FORGE_NOTIFY in src/test-setup.ts so isAnyProviderEnabled() is false. That works but it is implicit (you have to know that clearing the provider list is what disables notifications) and only covers the in-process suite. Proposed: a single explicit global kill-switch, e.g. NO_NOTIFY=true, checked at the top of the dispatch path (src/notify/trigger.ts dispatch() / isAnyProviderEnabled()) that short-circuits ALL providers regardless of FORGE_NOTIFY / NTFY_URL / Twilio config. Then test-setup.ts (and any other "don't notify" context) just sets NO_NOTIFY=true — clearer intent, one lever, provider-agnostic.

**Problem 2 — orchestrator-internal invoke runs notify on every completion.** Every `forge invoke` is its own run; updateRunStatus (src/store/runs.ts:128) fires notifyOnRunTransition on complete/failed, and the default FORGE_NOTIFY_ON includes complete+failed. So an orchestrator-driven invoke chain (engineer -> test-engineer -> ...) buzzes the human once per sub-agent, even though the orchestrator is watching synchronously and the human only needs gate / blocked / awaiting / top-level-pipeline-complete signals. Hit live 2026-05-29 during the #186 work (4+ pushes for one logical task). Candidate fix: suppress complete/failed ntfy for invoke-path runs specifically (keep them for `forge new` pipeline runs and ALL gate/blocked/awaiting states everywhere), or a per-invoke quiet flag. Role/path-based suppression is cleaner since the orchestrator always wants invokes quiet.

**Why together:** both are "this transition is not a human-actionable signal" — the same insight #175 applied to the test path. A clean design might unify them: a notification-policy layer where NO_NOTIFY is the hard global off, FORGE_NOTIFY_ON is the transition filter, and invoke-path runs default to a quiet policy.

Relates to #175 (test suite no longer notifies — the narrow precedent). Deferred — not urgent.


### #186 — forge cancel/kill verb for a stuck task or run (manual reaper)
**Closed:** 2026-05-29.

**From the #185 discussion.** There's no CLI to terminate a task stuck in a non-terminal state or to kill its container. When a task orphaned (parent died, see #185), the only way to clear it was poking the DB directly via store accessors (markTaskFailed + updateRunStatus). `gate` only handles awaiting_gate; `retry` only resets failed; `sweep` only closes runs whose tasks are ALL terminal.

Add a `forge cancel <task-id|run-id>` (or `forge sweep --running-orphans`) that: docker-kills `forge-<taskId>` if present, marks the task failed, and abandons the run. This is the manual counterpart to #185's automatic reaper — file alongside it. No schema change.

Relates to #185 (parent-died orphan reaper), #173 (idle-watchdog).


### #189 — Auth-profile review findings (consolidated: red panel + independent review)
**Closed:** 2026-05-29.

Combined, code-verified findings from forge's own red panel (red-security 0.78 / red-backend 0.88, both verdict FAIL) AND an independent external agent review of the #176 auth-profile code. Verified against source 2026-05-29. Supersedes #188.

**Priority is CORRECTNESS / CLEANUP, not security-urgent.** Per product owner (2026-05-29): zero users, security hardening deprioritized pre-launch — track these, fix genuine correctness bugs, revisit hardening before onboarding real users. Reviewers CONFIRMED the load-bearing invariants are sound: reds never receive the credential (runOneRed passes no profile), and sanitizeProfileName blocks path traversal.

**Correctness bugs (worth fixing):**
1. TOCTOU write-then-chmod — credential file briefly at umask default before chmod. Two sites: writeProfile (src/util/auth-profiles.ts) + staged copy (src/v2/auth-state.ts). Fix: writeFileSync(path, data, { mode: 0o600 }), ideally temp-file + rename.
2. [NEW, verified] Over-broad EXPIRY → premature expiry. profileExpiry (auth-profiles.ts:133/136) does Math.min over ALL cookie expires; an unrelated short-lived cookie (CSRF/analytics) marks a still-valid auth profile expired. Fix: prefer localStorage/JWT auth expiry when present; only consider likely auth/session cookies.
3. [NEW, verified] IPv6 [::1] not reconciled. new URL("http://[::1]:3000").hostname === "[::1]" (brackets) but LOCALHOST_HOSTS has "::1" → ::1 origins skip the localhost→host.docker.internal rewrite. Fix: normalize brackets or include both forms. (Low impact; rare.)
4. CdpSession.send has no timeout — `forge auth-profile login` hangs forever if Chrome/CDP stalls after Enter. Fix: per-call timeout that rejects + close the socket.
5. [NEW, verified] Wrong-tab capture. cdp-capture.ts:168 picks the FIRST page target. Mitigated by the dedicated-browser launch (one tab), but if the user opens tabs it can snapshot the wrong one. Fix: prefer the page whose origin matches the requested --url.
6. Cookie leading-dot domain (.localhost) not reconciled (auth-profiles.ts). Zero impact for the current localStorage-only app; real for cookie-based apps. Normalize cookie domains before reconciliation.

**Cleanup:**
7. Staged auth-state.json persists in the run dir after the run. Stage outside taskDir and/or unlink after the container exits.
8. Network.getCookies captures cookies from ALL origins, not just the target (over-broad capture). Scope to the target origin (pairs with #2).

**Documentation honesty (cheap, do it — NOT a code vuln):**
9. Correct overclaiming language. The injected token IS readable by the (trusted) primary agent inside its container — it can `cat /forge-auth/state.json`. Accurate guarantee: "never in prompts, logs, result.json, or the project mount" — NOT "the agent never holds/sees the credential." Fix the ADR (2026-05-28_auth-profile-cdp-localstorage-injection.md) + any commit-summary phrasing. This is NOT a vulnerability within forge's trust model (container boundary = trust line; trusted primaries; reds correctly excluded). A separate injector-process boundary for true isolation is possible but NOT warranted at this stage — explicitly out of scope.

**By-design (NOT defects — recorded so they aren't re-raised):**
- Pipeline auth scoping is a role allowlist incl engineer + frontend-specialist (they do UI visual verification). A workflow-level needs_auth: true flag is an optional refinement (tracked in #184), not a bug. The independent review rated this medium; it's by-design.

Provenance: forge red panel + independent external agent review, merged and code-verified by the orchestrator.


### #188 — Fix auth-profile review findings (TOCTOU perms, --meta bypass, CDP hang, cookie-dot)
**Closed:** 2026-05-29.

**From the red panel review of the #176 auth-profile code (2026-05-29).** Two reds (red-security 0.78, red-backend 0.88) converged on these REAL, unfixed defects. None critical for single-user macOS, but all legit and cheap:

1. **TOCTOU write-then-chmod (medium, both reds)** — `writeFileSync(path, data)` then `chmodSync(path, 0o600)` leaves the credential file briefly at umask default (world-readable on a shared host). Two sites: `writeProfile` (src/util/auth-profiles.ts) and the staged reconciled copy (src/v2/auth-state.ts). Fix: pass `{ mode: 0o600 }` to writeFileSync so perms are set at creation.
2. **--meta authProfile bypass (low, red-security)** — `forge new --meta '{"authProfile":"x"}'` injects the key into run metadata via the inputs spread (startRun), bypassing the up-front existence/expiry validation in new.ts (which only checks --auth-profile). Not a security hole (per-step resolution still fail-fasts), but defeats fail-fast-at-creation. Fix: validate metadata.authProfile too, or strip it from --meta.
3. **CdpSession.send has no timeout (medium, both)** — registers a pending promise then ws.send with no error/timeout handling; captureViaBrowser hangs forever if Chrome stops responding after the user presses Enter. Fix: bound send() with a timeout that rejects.
4. **Cookie leading-dot domain miss (red-be high / red-sec low)** — reconcileStateForContainer only matches exact `localhost`/`127.0.0.1`; a `.localhost` cookie domain isn't rewritten. Zero impact for the current localStorage-only app (no cookies), real for cookie-based apps. Calibration note: red-be over-rated this high.
5. **Staged auth-state.json never cleaned up (low, both)** — the reconciled copy persists in the run dir after the run. Lower priority (run dirs aren't auto-cleaned anyway).
6. **Network.getCookies over-broad (low, red-security)** — capture grabs cookies from all origins, not just the captured app's. Scope to the target origin.

Reds CONFIRMED the load-bearing invariants are sound: reds never receive the credential (runOneRed passes no profile), and sanitizeProfileName blocks path traversal. No hallucinated findings.

Recommended order if picked up: #1 (TOCTOU) + #2 (--meta) + #3 (CDP timeout) are quick and worthwhile; #4/#5/#6 lower priority.


### #176 — Auth profiles: agents test authenticated apps via a captured browser session (CDP), never credentials
**Closed:** 2026-05-29.

**Priority: high / soon — blocks QA of any authenticated app.** Today forge's browser agents (manual-qa, engineer/frontend visual verification) can only exercise *unauthenticated* surfaces. The implementer seeds already name this gap ("if the app requires authentication, check CLAUDE.md for a dev-auth path; if none, note it as a gap"). Without a systematic mechanism we either hand agents credentials (violates forge's no-secrets-to-agents posture) or skip authed flows entirely — and most real apps are behind a login.

**Principle:** agents operate *authenticated* but never *know credentials*. This is forge's existing trust model (read-only project mounts, container boundary as the trust line) generalized from the project to the app-under-test. The agent gets an authenticated browser context, not the secret.

**Concept — auth profiles.** A named profile binds a captured browser session to a set of domains:

```
auth_profiles:
  qa-admin:
    kind: browser-storage-state        # storageState-shaped JSON, loaded via CDP (NOT Playwright)
    path: ~/.forge/auth/qa-admin.storage.json
    domains: [ "https://staging.example.com" ]
    readonly: true
```

Task requests it: `forge invoke manual-qa --auth-profile qa-admin ...`. Forge copies the state into the authed task's container tmp, the CDP browser-tools start with cookies/localStorage already injected, and the path + contents are redacted from prompts and logs.

**Flow:**
1. Out-of-band trusted login: `forge auth-profile login qa-admin --url https://staging...` opens a real/controlled browser; the human logs in (incl. MFA).
2. Forge captures the session to a storageState-shaped JSON at the host-global path.
3. Later, `forge invoke ... --auth-profile qa-admin` injects it; the app sees the agent as logged in.
4. The prompt says "use auth profile qa-admin," never the password or cookie contents.

**Three load-bearing constraints (where the naive version breaks or leaks):**
- **CDP, not Playwright.** Forge retired Playwright for CDP browser-tools (#126, #128). Keep the storageState *format* but implement a CDP loader: cookies via `Network.setCookies`, localStorage/sessionStorage via `Page.addScriptToEvaluateOnNewDocument` per origin. Do not reintroduce Playwright. **Scope note:** "no Playwright" applies ONLY to the *agent's* injection path (browser-tools / manual-qa). The *project's* committed E2E suite IS Playwright (#177) and consumes this same storageState file *natively* via `storageState:` — same artifact, different consumer. Don't read this as "projects shouldn't use Playwright."
- **The state file is a bearer credential — store it host-global, never in the project tree.** Session cookies are live tokens. A path under `<project>/.forge/auth/` is readable by ANY agent via the project mount (read-only still means readable), defeating the principle. Store at `~/.forge/auth/<profile>.storage.json` (like runtimes), mode 600, gitignored, copied only into the specific authed task's container tmp — never via the general project mount. Encryption-at-rest is the trigger to activate #60 (`pass`).
- **Fail fast on expiry.** An expired session silently lands the agent on a login page, producing false bug reports ("app broken — shows login"). The profile must carry/derive expiry; `forge auth-profile status` checks it; the authed task fails fast ("profile qa-admin expired — re-run forge auth-profile login qa-admin") rather than proceeding logged-out.

**Smaller notes:**
- Name it distinct from `forge auth` (Claude API auth modes: bedrock/oauth/apikey). This is app-under-test auth, an orthogonal axis. `--auth-profile` is fine.
- `domains:` allowlist — inject state only for matching origins so staging cookies don't ride along to other hosts the agent navigates to.
- Redact profile path + contents from prompts, result.json, and container logs.

**Variant scoping:**
- v1 (build first): manual login + CDP capture/inject. No app changes, fits today.
- v2: scripted login using a vault secret -> activates #60.
- Preferred when available: app test-login endpoint (`/__test__/login?role=admin`) — deterministic, no UI login; recommend to app teams that can add it.
- Defer: magic-link / short-lived-token broker.
- Out of scope (for now): mobile — RN verification is tests-only, no browser/sim in container today.

**CLI surface:** `forge auth-profile login <name> --url <url>`, `forge auth-profile status [<name>]`, `forge auth-profile list`, `forge auth-profile rm <name>`; `--auth-profile <name>` on `forge invoke` and on pipeline steps that browser-verify.

**Schema:** new `auth_profiles` map (host-global and/or project `.forge/`), profile = {kind, path, domains[], readonly}. Resolve like runtimes (project override -> host-global fallback).

**Ties:** activates #60 (secret-at-rest); turns the implementer-seed dev-auth-gap note into a real mechanism; must respect the red read-only-mount rule (don't expose the cred via mounts); builds on this session's browser-verification hardening (ceda17d).


### #183 — Auth profiles: reconcile capture origin with container-reachable origin for host-served apps
**Closed:** 2026-05-29.

**Found proving #176 end-to-end in a real container.** A captured profile records the origin the human logged in at (e.g. `http://localhost:3000`). But an agent container on macOS cannot reach the host's `localhost` — it must browse `http://host.docker.internal:3000`. The browser-tools injector guards localStorage by `location.origin` (the domains allowlist), so when the agent browses host.docker.internal but the profile origin is localhost, injection silently no-ops and the agent lands logged-out (which, per #176 finding #2, renders an empty shell, not a login redirect — a false "app broken").

**Proof workaround used (do not ship as the UX):** hand-derived a `qa-admin-docker` profile by rewriting `http://localhost:3000` → `http://host.docker.internal:3000` (and cookie domain localhost → host.docker.internal). The Supabase session JWT is origin-agnostic, so the same token authenticated fine. Run passed: agent reported logged_in, steve@bargelt.com, steve-1, teams visible.

**What forge should do (options to weigh):**
- On copy into the authed container, if the profile origin host is `localhost`/`127.0.0.1` and the app is host-served, rewrite the origin (and cookie domains) to `host.docker.internal` in the in-container copy — transparent, no second profile. Needs a signal that the target is host-served (heuristic, or a flag on the profile / invoke).
- OR capture/store the profile under the container-reachable origin from the start (capture via host.docker.internal — but the human logs in on localhost).
- OR pass `--network host` so container localhost maps to host localhost (Docker Desktop 4.34+, macOS-gated; forge spawn has no network flag today — separate change).
- For PUBLIC staging/prod apps (real DNS, reachable identically from host and container) this is a non-issue; the gap is specific to localhost-served dev apps.

**Reachability is NOT the gap:** host.docker.internal:3000 returns 200 from the agent image with no --add-host (Docker Desktop auto-provides it). Only the origin mismatch needs solving.

Relates to #176 (auth profiles), #181 (pin browser-tools), #182 (generic env var).


### #181 — pi-skills/browser-tools is an unpinned dependency — fork + pin the auth injector
**Closed:** 2026-05-29.

**Found during #176 Slice 2.** forge mounts `${FORGE_BROWSER_TOOLS_DIR:-~/pi-skills/browser-tools}` into agent containers (read-only) — currently `~/.claude/skills/browser-tools` is a symlink to `~/pi-skills/browser-tools`, a checkout of the THIRD-PARTY repo `badlogic/pi-skills` sitting on upstream `main` (SHA 75d32a3 at time of writing). The #176 auth injector (`auth-inject.js` + a `browser-nav.js` edit) lives there as UNCOMMITTED local edits on top of upstream. forge therefore mounts "whatever SHA that checkout happens to be at" with zero pinning — works on this machine, no reproducible dependency state. A fresh clone / another machine / a container rebuild silently lacks the injector, which is exactly the silent-skip failure #176 exists to kill.

**Senior-engineer recommendation (relayed, agreed):**
- Fork or branch `badlogic/pi-skills`; commit the auth changes there.
- Pin forge to a specific git SHA / tag of the fork.
- Add a forge compat note: "auth profiles require pi-skills browser-tools >= commit Y."
- Patch files are an acceptable temporary escape hatch only, not the main strategy. Fork + pinned SHA is more boring and reproducible.

**Open sub-decisions (deferred from the build session):**
- Pin mechanism: (a) fork + documented required-SHA + a forge PREFLIGHT that hard-fails at dispatch when the mounted browser-tools lacks the injector — extends the spawn.ts browser-tools-mounted guard already added in #176 Slice 3 to also assert `auth-inject.js` presence; (b) git submodule in forge pinned to a SHA; (c) bake the fork into the agent image at a pinned SHA (revisits #128 mount-don't-bake). Leaning (a): boring, reproducible, no submodule friction, fits no-build-step workflow.
- Fork target is an outward action on the user's GitHub (gh repo fork) — needs the user.

**Until done:** #176 auth profiles only work on this machine. Blocks shipping auth-profile to any other environment.


### #182 — Genericize the auth injector env var (decouple browser-tools from forge)
**Closed:** 2026-05-29.

**Found during #176 Slice 2.** The browser-tools auth injector keys off `FORGE_AUTH_STATE`. The senior engineer noted (agreed) that loading a preloaded storage-state file is a GENERIC browser-tools capability, not forge-specific — "if a storage-state env var is set, load it." Renaming `FORGE_AUTH_STATE` to a neutral name (e.g. `BROWSER_TOOLS_STORAGE_STATE`) in both `auth-inject.js` and forge `spawn.ts` decouples the feature, makes it cleanly upstreamable to `badlogic/pi-skills`, and keeps the upstream change non-forge-branded.

**Scope:** rename in `auth-inject.js` (read the neutral var), forge `spawn.ts` (set the neutral var instead of FORGE_AUTH_STATE), update the #176 ADR. Pairs with the fork/pin ticket — do the rename before pushing to the fork so upstream history is clean. Small, isolated change.


### #180 — Bake Playwright (chromium) into the agent-dev-worker image for E2E — resolves #177 infra question
**Closed:** 2026-05-29.

**Decision (2026-05-29):** E2E testing (#177) requires Playwright + a browser available *inside* the agent container. Bake it into the `agent-dev-worker` image (docker/). This resolves #177's infra question in favor of "bake," not `connectOverCDP`.

**Bring Playwright's OWN chromium — do not reuse #128's CDP Chrome.** Rationale: keeps the project-E2E layer (b) independent of the agent-verification layer (a) — the same separation #177 draws — and preserves real Playwright isolation: per-test browser contexts, `storageState`-per-context (this is the seam #176 auth plugs into), and parallel workers. A shared `connectOverCDP` session to the browser-tools Chrome can't give that. #128's Chrome stays dedicated to browser-tools; Playwright drives its own. Two browsers, two layers — intentional.

**Specifics:**
- `npx playwright install --with-deps chromium` — chromium-only (~300MB) to limit image bloat; skip firefox/webkit unless a project needs them.
- Pin the baked `@playwright/test` version and its matching browser build (Playwright browser binaries are version-locked to the package).
- Set `PLAYWRIGHT_BROWSERS_PATH` to a shared baked location so a project's `npm install` finds the pre-downloaded browser instead of re-fetching it per run.
- **Version-mismatch wrinkle:** if a project pins a `@playwright/test` whose browser build differs from the baked one, Playwright re-downloads at run time (slower but works). Mitigation: bake a recent version + document a supported range; revisit only if it bites.

**Verification:** the container can run `npx playwright test` against a trivial spec headlessly and produce a result + trace with no network browser download.

**Ties:** resolves the infra question in #177 (E2E authoring + anti-downgrade gate); independent of #176 (auth) — this unblocks the auth-independent E2E-mechanics spike, so it can proceed in parallel; follows the image-baking pattern from #128 (which baked Chrome for browser-tools). Sequencing: this + #176 are the two prerequisites that make #177's E2E backfill real.


### #175 — Test suite fires real ntfy/twilio notifications — test-setup.ts didn't neutralize providers
**Closed:** 2026-05-29.

**Symptom:** running `npm test` in a shell with `FORGE_NOTIFY=ntfy` + `NTFY_URL` set sprays real push notifications — one per test run that transitions to complete/failed. Hit 2026-05-29: ~20 `[complete]` pushes for synthetic fixtures (`run-invoke-engineer-… some-project/x … — 0s`) during repeated suite runs.

**Cause:** `updateRunStatus` (src/store/runs.ts) fires `notifyOnRunTransition` on every terminal transition; both providers gate only on `FORGE_NOTIFY` (notify/ntfy.ts, notify/twilio.ts). `src/test-setup.ts` isolated the test DB (#170) but left notification env untouched, so fixtures fired real pushes to whoever's env was set in the shell.

**Fix (shipped):** `src/test-setup.ts` now sets `process.env.FORGE_NOTIFY = ""` for the whole suite → `isAnyProviderEnabled()` false → no pushes. Verified: full suite green, zero notifications.

**Lesson:** test isolation must cover *side-effects*, not just the DB — anything keyed off process env (notify, future webhooks) needs neutralizing in test-setup. Same class as #170.


### #84 — Document the two-channel feedback model for design workflows
**Closed:** 2026-05-28.

**Why:** Caught 2026-05-08 — Steven's call when reviewing the phase-flow PNGs: "I'd argue that this is exactly what the human loop is for. I can work with claude/pencil to make the corrections." Right take, and worth pinning down so future sessions don't reflexively reach for forge-reject when the cheaper channel exists.

**Two distinct feedback channels in the design workflow:**

1. **Forge gate (reject + onReject)** — for *prompt-level* problems. The prompt-author made wrong inferences (wrong screens listed, wrong style, missing requirements, stale context like "11 screens" when there are 20). Reject loops back to brief; prompt-author re-runs with rationale. Heavy: full round-trip, new Pencil session needed afterward.
2. **In-Pencil iteration with Claude** — for *rendering-level* problems. The prompt was right; one specific element rendered wrong (e.g., fanout pill showing single-task-progress instead of N-task-parallelism). Open the frame, tell Pencil-Claude what to fix, save. No forge round-trip. Stays inside the human-led `ui-review` phase where the brief intended.

**Heuristic for which channel:** if the *brief* would change as a result of the fix, that's a reject. If only the *frame* would change, that's a Pencil iteration.

**Where this lives:**
- prompt-author seed should mention both channels in PROMPT.md output (so the human running PROMPT.md knows iteration during the session is normal/expected, not a sign that the prompt was wrong).
- ui-design workflow's gate-button copy (#62) might want different verbs to reflect this — "reject" reads heavy when the right move was iteration. Maybe a third option "back to prompt-author" or "this is a Pencil-iteration thing, just keep working."
- Documentation: a small section in `docs/concepts.md` or a new `docs/how-to-design-workflows.md` walking through the two channels.

Validates by experience: Steven shipped multiple in-Pencil corrections this session that would have been over-rejected through forge.
**Why:** Caught alongside #80. Validator looks for `<basename(designDir)>.pen`; with shared corpora the filename is meaningful (`dashboard.pen`), not derived. The seed-convention is too tight.
**How to apply:** `submitValidators.ts` — replace fixed-name lookup with `readdirSync(designDir).filter(f => f.endsWith('.pen'))`. Error if zero (with a clear "did Pencil save?" message); error if multiple (ambiguity, list found files); pass if exactly one. The non-zero check still applies. ~10 lines.

### #171 — feature-ui-design-{provided,needed} build phase ignores discipline tags — port feature.yml fanout
**Closed:** 2026-05-28. Commit `645a523`.

**Caught 2026-05-28** on wnba-led-scoreboard: a `feature-ui-design-provided` run dispatched a single generic `engineer` for the whole build wave. The tech-lead plan tagged each step's discipline (steps 1–4 backend, 5–6 frontend), but the build phase ignored the tags — they rode along as metadata and never routed to frontend-specialist / backend-specialist. CLAUDE.md says the pipeline is "engineer (specialist per step)"; that did not happen.

**Root cause (verified).** The fanout mechanism exists and `feature.yml` uses it — its `build` step has:

    fanout:
      from_upstream: { step: plan, array_key: steps, input_key: step }
      agent_map: { frontend: frontend-specialist, backend: backend-specialist, infosec: security-advisor }

with `agent: engineer` as the fallback for unmapped/general disciplines. The two UI variants were never migrated:
- `seeds/workflows/feature-ui-design-provided.yml` build step (~line 48): plain `agent: engineer`, no fanout.
- `seeds/workflows/feature-ui-design-needed.yml` build step (~line 85): same.

The irony: the UI workflows are exactly where frontend-specialist matters most, and they are the two that don't route to it.

**Fix.** Port feature.yml's build-phase `fanout` block + the per-step `workflow_additions` ("Implement your assigned plan-step (passed via inputs.step)…") into both UI variants. YAML-only, no code change — the FanoutDef schema + runtime are already proven by feature.yml. Reds stay per-parent (review the aggregate diff), same as feature.yml (#139).

**Verify.** Confirm the tech-lead seed emits a `discipline` field per plan step (feature.yml already relies on it). Then a UI feature with mixed steps should fan out: frontend steps → frontend-specialist, backend → backend-specialist, unmapped → engineer.


### #166 — forge invoke prompt-author → host-side Claude Code + Pencil session (replace out-of-band handoff)
**Closed:** 2026-05-28. Commit `e358c38`.


### #159 — commit-msg hook false-positive: blocks 'forge claude' despite allowlist
**Closed:** 2026-05-28.


### #169 — Optional ntfy push notifications for forge events
**Closed:** 2026-05-28.


### #170 — Tests pollute shared forge.db — use isolated temp DB for test suite runs
**Closed:** 2026-05-28.


### #168 — Go toolchain support in agent containers + engineer seed
**Closed:** 2026-05-28.


### #164 — Agent rework: test-engineer (pipeline) + manual-QA (invoke-only) + engineer self-verification
**Closed:** 2026-05-28.


**Problem:** The current qa-engineer agent is a rubber stamp — re-runs unit tests, maybe takes a screenshot, reports. Burns tokens without catching real bugs. Engineer seed has validation language but agents skip browser-tools in practice.

**Three roles with clear boundaries:**

**Engineer** (build phase — tighten existing seed):
- Builds feature per plan, writes and runs unit tests
- Self-verifies: browser-tools for web apps, explicit "no visual verification path" for mobile/CLI
- Project-type-aware: reads Stack section to know what verification is possible
- Never returns `status: complete` without validation evidence

**Test Engineer** (build phase — NEW, replaces qa-engineer in default pipeline):
- Writes integration and E2E tests that prove the feature works through real user flows
- Web apps: browser-based test flows. Non-web: integration tests exercising real component interactions
- Output is committed test files — durable regression coverage, not a one-shot report
- Does NOT re-run unit tests. Does NOT do exploratory clicking.

**Manual QA** (verify phase — NEW, invoke-only, NOT in default pipeline):
- Acts like a real user: opens the app, clicks through flows, tries edge cases (weird inputs, empty states, overflow, resize)
- Output is a verdict with evidence (screenshots, repro steps). No test files.
- Does NOT run unit tests. Ever.
- Orchestrator invokes when diff is UI-heavy/user-facing; skips for refactors, CLI, backend-only

**Scope:**
1. Create `test-engineer` seed (new agent dir + CLAUDE.md)
2. Rework `qa-engineer` → `manual-qa` (rename or create new + deprecate)
3. Tighten `engineer` seed: project-type-aware verification, sharper enforcement
4. Update `frontend-specialist` seed to match
5. Update orchestrator template: RACI table, role descriptions, pipeline slot
6. Update workflow definitions referencing qa-engineer by name
7. Update forge CLAUDE.md orchestrator block (role table, gate-decision discipline)

### #162 — Dashboard usage: model mix per dimension
**Closed:** 2026-05-28.


### #161 — Dashboard usage: expandable token breakdown per row
**Closed:** 2026-05-28.


### #165 — forge invoke prompt-author → host-side Claude Code + Pencil session (replace out-of-band handoff)
**Closed:** 2026-05-27.


### #163 — orchestrator token capture: instrument forge claude to log model_calls
**Closed:** 2026-05-27.


### #156 — Dashboard usage view: useful AND beautiful (consumes #155)
**Closed:** 2026-05-27.

Follow-up to #155, which shipped the data layer (capture + backfill + CLI). User flagged that 1-5 are a waste without the dashboard view — 6 is the payoff.

**Why "useful AND beautiful":** the CLI proves the data is sound, but the rollup table isn't acted on at-a-glance. The dashboard needs to surface the actionable signals in a way that drives behavior change (which model to use where; which workflow has cache churn; which project is burning tokens).

**The actionable signals from the data we now have:**
- Total spend (weighted tokens) per project / workflow / model / role
- Cache hit rate trends — has it improved since the workflow YAML downgrades shipped?
- Cache reuse ratio — flags workflows where cache is being created and discarded
- Per-step model mix (post-#117 audit: confirm Opus burn is dropping)
- Time series: weighted tokens per day per project (rolling 30d)

**Design considerations (think hard before building):**
- **Headline metric first.** What's the single number on the page? Probably "weighted tokens last 7 days" with a delta vs prior 7 days. Or cache hit rate.
- **Comparison is the value.** Project A vs B; workflow X vs Y. Side-by-side bars or sparklines, not just numbers.
- **Drill-down hierarchy.** Click a project → see workflows. Click a workflow → see roles. Click a role → see tasks.
- **Time series.** A flat-roll snapshot tells you what's true now; the trend tells you whether the calibration is working.
- **Cache efficiency callouts.** Workflows with hit rate < 80% or reuse ratio < 5x should be visually flagged.
- **No dollar amounts.** This is unitless / weighted-tokens. Dollar conversion is brittle and OAuth users have no per-token cost — don't pretend.

**Implementation surface:**
- Dashboard server: new \`/api/usage\` endpoint with query params for the four rollup dimensions + time filters. Reuse the SQL shape from src/cli/commands/usage.ts.
- Dashboard client: new \`<UsageView />\` tab alongside activity / projects. Top-of-tab: headline metric + comparison chart. Below: per-dimension breakdowns with sparklines.
- Maybe a "what changed" tile: workflow YAML edits from #117 + this view side-by-side, watching the spec-writer → default migration's effect in real time.

**Composes with:**
- #155 — the data layer this consumes
- #154 — the existing dashboard Projects view; pattern-match the card grid + chip styling
- 0088737 commit — the workflow downgrades whose effect this measures

**Sequencing:** ship soon. User explicitly flagged this as essential and the CLI alone isn't act-on-able.

**Caught:** 2026-05-26 conversation while shipping #155.


### #157 — forge invoke leaks active runs; needs terminal transition + sweep CLI
**Closed:** 2026-05-26. Forward fix: invoke.ts closes the run it owns (when args.runId is undefined) at all 7 terminal sites — success and 6 failure paths. RunStatus has no 'failed' (matches runNext convention); both success and failure flip the owned run to 'complete' with the task-level status carrying success/failure. New `forge sweep [--dry-run] [--limit]` CLI: finds runs where status='active' but all tasks are terminal, flips to 'complete' with completed_at = MAX(tasks.completed_at) to preserve historical timestamps. Ran the live sweep — closed 34 phantom invoke runs (in-flight counts across harebrained-apps/split-keyboard-teacher/meatgeekv2 dropped from 18/10/5 → 0/0/1). **Also fixed the latent getDb readonly-cache bug** (flagged after #155 backfill; bit again in this ticket's sweep) — `_db` was a single module-cached connection; first caller's mode locked in for the process so a readonly-then-writable sequence silently dropped writes. Split into `_dbRW` + `_dbRO` caches; both reachable from any call site without footgun.

**Caught:** 2026-05-26 by an agent in harebrained-apps. Confirmed: 34 phantom-active runs on this machine, all workflow=invoke.

**Symptom:** every successful \`forge invoke\` accumulates as a permanent "active" run. \`forge projects show\`, \`forge status\`, and the dashboard's live-session signal all overcount indefinitely.

**Root cause:** src/v2/invoke.ts marks the task complete at line 207 but never calls updateRunStatus(runId, "complete"). Multi-step workflows close cleanly because runNext.ts:138 flips run status when the workflow finishes; invoke skips that path. Same for invoke's 5 failure-return sites — they call markTaskFailed but leave the run "active".

**Fix:**

1. Forward fix in src/v2/invoke.ts: when invoke owns the run (args.runId === undefined), update the run status to "complete" on success and "failed" on each failure return. Don't touch the run status when invoke is attached to a caller-supplied --run id.

2. Backfill via new \`forge sweep\` CLI: scan runs where status='active', all tasks are terminal (complete/failed/blocked_by_red), at least one task exists. Update status to 'complete' (or 'failed' if any task failed) and completed_at = MAX(tasks.completed_at). Idempotent. --dry-run + --limit N flags.

**Sequencing:** forward fix first (prevents new leaks), then backfill (cleans 34 existing). Both in one commit; commit unblocks running \`forge sweep\` for real.

**Caught:** 2026-05-26 conversation while migrating harebrained-apps to the per-developer .claude/ convention.


### #155 — Token + cache telemetry: capture, backfill, CLI, dashboard view
**Closed:** 2026-05-26. Data layer shipped (scope items 1-5). model_calls table reshaped with task_id/input/output/cache_read/cache_creation columns; cost dropped. Parser handles stream-json, dedupes by request_id, prefers message_delta totals; 11 tests cover edge cases. Capture wired into both spawn paths (invoke + runNext) as best-effort. forge usage backfill walked 175 historical task logs and inserted 5,139 rows; 146 tagged with alias via tasks-table lookup. forge usage CLI rollups across role/workflow/project/model/alias with cache hit rate + reuse ratio + weighted-tokens columns. Real data: claude-opus-4-7 = 76% of total weighted spend pre-workflow-downgrades; 96.7% cache hit rate corpus-wide; 29.6x reuse ratio. Dashboard view in follow-up #156 ("1-5 are a waste without 6").

Replaces #27's intent (which closed 2026-05-26 as "LiteLLM unreliable").

**Why:** Today's audit showed meatgeekv2 ran 78% of tasks on Opus when most could have been Sonnet (workflow YAMLs hardcoded \`model: spec-writer\` everywhere). Workflows were patched in commit \`0088737\`, but the only way to validate the change — and calibrate the next round — is data. Forge has a half-built \`model_calls\` table (schema present, 0 rows, never instrumented).

**The break:** claude-code already streams structured JSON to container.stdout.log via \`--output-format=stream-json\` (all three runtimes). Every assistant message includes \`usage\` with input/output/cache_read/cache_creation token counts. Every request's \`message_delta\` event has the canonical final usage with an \`iterations\` array. **Backfill is possible** — every existing run on disk has this data.

**Scope (this ticket = 1-5; dashboard view ships as separate ticket):**

1. Schema migration. \`model_calls\` gets \`task_id\` (FK to tasks), \`cache_read_tokens\`, \`cache_creation_tokens\`. Drop \`cost\` (we're not tracking dollars; OAuth has no per-token cost and price drift makes hardcoded tables stale).
2. Parser. \`extractUsageFromStdoutLog(path) → UsageRow[]\` — walks the stream-json, dedupes by \`request_id\`, takes the final \`message_delta\` usage per request.
3. Capture. spawn.ts at task-completion: parse the log, insert rows tagged with task_id.
4. Backfill. \`forge usage backfill\` walks ~/.forge/runs/*/task-*/container.stdout.log and populates historical (~hundreds of tasks become real data points).
5. CLI: \`forge usage\` with \`--by role|workflow|project|model\` rollups. Headline columns: input tokens, output tokens, cache hit rate (cache_read / (cache_read + cache_creation + input)), cache reuse ratio (cache_read / cache_creation), weighted-tokens (proxy for relative spend without committing to dollars). \`--since 7d\` time filter. \`--json\` for programmatic use.

**Out of scope this ticket (separate next ticket — must follow soon):**
- **Dashboard usage view.** Useful AND beautiful — cache efficiency as headline, cross-project / cross-workflow / cross-model comparisons, drill-downs, time series. The CLI from #5 proves the data; dashboard makes it act-on-able. The user explicitly flagged that 1-5 are a waste without 6 — file follow-up ticket immediately upon shipping this.

**Caught:** 2026-05-26 conversation about why meatgeekv2 was burning Opus.


### #87 — Design corpus convention: modify-in-place + git, not add-new-screens for additions
**Closed:** 2026-05-26. Encoded in the prompt-author seed as one of three per-screen classifications (NEW / ADDITION / MODIFY-IN-PLACE), with adjacent-on-canvas guidance for the ADDITION case (find_empty_space_on_canvas near the existing component). PROMPT.md renders one bullet per screen so Pencil sees the per-screen handling explicitly.

**Why:** Caught 2026-05-08 — Steven: "I'm still curious why we didn't just modify 5." The current pattern adds a new screen for every addition (screen 23 added the preview-line treatment to the existing gate panel from screen 05, instead of editing screen 05). That preserves audit trail at the cost of:
- Duplicate frames in the .pen (the gate panel exists in 05 *and* 23)
- "Which is canonical?" ambiguity at implementation time
- Linear screen-count growth as the corpus iterates

**The right convention:** modify in place. Screen 05 *becomes* the gate-panel-with-preview. The .pen file is committed to git after each Pencil session (per `~/code/forge-design/` already being a git repo); commit history is the audit trail. To see "what did this screen look like before phase-flow added the preview?", `git log dashboard.pen` and check out the prior version.

**What this implies for forge / the prompt-author seed (#86 update):**
- When a brief is "add X to existing component Y," PROMPT.md says "edit screen Y in place" (with the screen name discovered from the corpus, per #80) — not "add a new screen for X."
- After each Pencil session, the human commits the corpus: `cd ~/code/forge-design && git add -A && git commit -m "<run-title>: <short summary>"`. Eventually automate this — `forge submit` could run the commit on success (or warn if the dir is dirty + uncommitted on next run).

**Counter-argument worth noting:** new screens preserve "before/after" side by side without requiring the reviewer to git-checkout. If the design intent really is showing variation/comparison (state-A vs state-B of the same component), separate frames are honest. But for additions ("here's where the preview line goes"), that's not comparison — that's the new canonical state.

**Pragmatic middle ground (Steven 2026-05-08):** when adding a new screen for an addition, **position it directly next to the original on the .pen canvas**. Spatial proximity inside the .pen is the audit trail — anyone opening the file sees `05-gate-panel` and `23-gate-panel-advance-preview` adjacent and immediately reads "this is the evolved version of that one" without git archeology. Cheaper than git-history awareness, more semantic than just "new screen far away on the canvas." The prompt-author seed (post-#86) should encode this: when designing an addition to existing component X, PROMPT.md tells Pencil to use `find_empty_space_on_canvas` *near* X's position rather than just any free space.

**Sequencing:** ship #80 + #83 + #86 first (the seed-side fixes); revisit this convention when those are real and we have a feel for whether new-screen-for-additions still creeps back in.

### #86 — Prompt-author seed: distinguish "new component" from "addition to existing component"
**Closed:** 2026-05-26. The "Reading the existing design corpus" section of the seed walks the agent through cataloging existing screens at `/design`, classifying each requested screen, and stashing the result in `parameters.classifications`. The new `{{per_screen_handling}}` template placeholder renders the classifications into PROMPT.md as explicit per-screen rules ("design ONLY the addition; do not redraw X").

**Why:** Caught 2026-05-08 reviewing phase-flow design output. The brief asked for "next-action preview on the gate panel" — a single new element (an italicized line between rationale and buttons) added to the existing gate panel that already lives in the corpus (screen 05 `task-detail-gate.png`). The agent interpreted this as needing three separate gate-panel mockups (23/24/25), each showing a different preview-copy variant. Result: three near-identical full panels with slight variations + invented sections (GATE CONTEXT, AGENT MESSAGE) that weren't in the brief. The actual design content was one piece (preview line shape + placement) with three copy variants — should have been one annotated screen, not three.

**The shape of the bug:** the agent didn't know that the gate panel already exists in the design corpus, so it redrew it (with drift) instead of treating the brief as a tweak to an existing component. The prompt didn't say "the gate panel already exists; design only the addition."

**How to apply:** when authoring PROMPT.md for a shared-corpus run (per #67), the prompt-author should:
1. Read the existing PNGs/HTMLs in `<designDir>/code/` and `<designDir>/designs/`. Catalog what components already exist.
2. For each requested screen, decide: is this a *new component* or an *addition to an existing component*?
3. For additions, the PROMPT.md should explicitly say "the X component already exists in the corpus (see screen Y); design ONLY the addition (callout, annotation, single new element); do not redraw X." Optionally, ask the agent to design one annotated example + a sidecar showing copy/state variants of just the addition.
4. For new components, normal full-frame design as today.

**Composite with #80, #83:** the seed needs to read existing designDir state before authoring (#80), use existing PNG count for numbering (#83), AND distinguish new-vs-addition framing (#86). All three together make shared-corpus reuse work cleanly. Each one alone leaves drift.

### #80 — Prompt-author seed needs to read existing designDir before authoring (shared-corpus support)
**Closed:** 2026-05-26. Seed now requires corpus inspection at `/design` before authoring: discovers `*.pen` filename, counts existing PNGs (template's PRECONDITION 2 already computes START_NUM from this), respects legacy `<designDir>/designs/` layout for override users, and skips the touch precondition when a non-empty .pen already exists. Template adds per-two-screens Cmd+S pause-and-wait reminders so Pencil crashes don't lose multi-screen sessions (the 2026-05-08 incident).

**Why:** Caught 2026-05-08 mid-phase-flow run. The prompt-author seed assumes a fresh designDir and authors a PROMPT.md based on `<basename(designDir)>.pen` + screen numbering starting at `01-` + a static "N screens" framing pulled from the brief. With #67 (shared per-app corpus), every one of those assumptions breaks:
- Existing `.pen` file has a meaningful name (`dashboard.pen`), not the basename of the dir.
- Existing PNGs are numbered 01-20; the agent's `01-phase-pill-row-linear.png` would clobber.
- "Match the existing 11 screens" framing was stale (already 20 by run time). Cosmetic but misleading.
- The 0-byte `touch <basename>.pen` precondition created a useless second .pen file.
**How to apply:** Before authoring PROMPT.md, the prompt-author should:
1. Read the existing `.pen` file (any `*.pen` in designDir) and use its actual filename in the prompt.
2. Count existing PNGs in `designs/`; start new numbering at max+1.
3. Don't hardcode a screen count in the prompt body — say "the existing dashboard screens" or count at author time.
4. Skip the precondition `touch` step when an existing `.pen` is found.
5. Add a per-screen-pair Cmd+S reminder, not just an end-of-run warning. Pencil sessions crash mid-run (verified 2026-05-08); the loud end-of-run save is too late if the crash happens between screens 24 and 26 of a 26-screen design (which is exactly what just happened).
**Validation done so far:** prompt-author DOES tell Pencil to OPEN-the-existing-file and ADD frames (good — this part of the seed worked). Numbering and filename inference are the gaps.
**Composite with #79 + #82 (validator-glob-pen below):** these three together make shared-designDir reuse robust. Without all three, every reuse run hits a different sharp edge.

### #67 — Per-app design corpus: encourage / enforce shared designDir within an app
**Closed:** 2026-05-26. Convention-with-override: `deriveDefaultDesignDir` in `src/cli/commands/new.ts` now returns `<projectDir>/designs/` for design-touching workflows (was `~/code/<sanitized-title>/` per-run). `--design-dir <path>` still overrides for the legacy peer-dir / shared-design-system-across-repos shape. Pen/PNG layout flattened — designs live at the top of designDir alongside the .pen, with `code/` for optional HTML exports. docs/concepts.md gets a new "Design corpus" entry.

**Why:** Today every `ui-design` run gets its own `--design-dir`. Each .pen file is a fresh document with no link to prior designs of the same app. If you design the forge dashboard at `~/code/forge-design/dashboard.pen`, then later add a widget to that dashboard, the widget design lives in a new .pen with no automatic access to the variable block or named components from the dashboard's .pen. Pencil 0.2.5 has no cross-file component import — components live inside their .pen file. Result: visual drift, redundant token redefinition, and the human has to keep "the dashboard's house style" in their head when running each new ui-design.
**Caught 2026-05-08:** running ui-design for a forge dashboard widget against a fresh `--design-dir ~/code/forge-stats-widget/`. Steven flagged that this should have been added to `~/code/forge-design/` so it could reuse the existing component library + variable block. The prompt-author had no way to know.
**Three shapes to consider (decide before implementing):**
1. **Convention only.** Document that ui-design runs for the same app share a designDir. Update prompt-author seed to ask "is this an addition to an existing design corpus? if so, point me at it." Cheapest, no code change.
2. **`forge new --inherit-from <other-design-dir>`.** New flag. The prompt-author template gets a step at the top: "open the inherit-from .pen first, copy variable block + named components into the new .pen, then proceed." Pencil supports this manually; agent automates the copy. Risky — node-copying across .pen files isn't a tested path in Pencil 0.2.5.
3. **Reuse the same designDir; .pen grows monotonically.** No flag needed. The existing prompt-author already supports an existing .pen (touch + open_document is idempotent; new screens go in empty canvas space via `find_empty_space_on_canvas`). Just teach the human (and the prompt-author seed) that the right move is `--design-dir` pointed at the existing corpus, not a new dir. Accepts the cost of larger .pen files in exchange for actual reuse.
**Lean toward (3) initially.** It's the cheapest honest answer and exposes whether the monotonic-growth cost is real before we build (1) or (2). (1) becomes the documentation form of (3). (2) only becomes worth building if Pencil ships better cross-file tooling AND we hit a case where one .pen is genuinely too big.
**Open question:** how does forge know when a designDir already has a .pen worth reusing vs an empty/abandoned scratch? Probably: the prompt-author can detect a pre-existing non-zero .pen at the conventional path, surface it in `openQuestions` ("found existing design at <path>; reuse?"), and let the human gate the call.


### #120 — `forge auth status` is shallow + the underlying health probe is local-clock-only
**Closed:** 2026-05-26. (a) CLI now consumes `getAuthState()` (full profile/account/role/region/SSO portal/expiry/watchdog status); (b) `--deep` flag runs `aws sts get-caller-identity` for the honest answer. STS-cache-stale (#119) surfaced as a warning in the status output.

**Why:** Caught 2026-05-13 during diagnosis of #119. `forge auth status` for bedrock mode prints only `Auth mode: bedrock` + `AWS_REGION: us-east-1` — no SSO expiry, no STS cache state, no actual probe of whether the chain works. **Two bugs underneath:**

1. **CLI doesn't call the existing `getAuthState()` probe.** `src/cli/commands/auth.ts:103-128` reads `process.env.CLAUDE_CODE_USE_BEDROCK` and stops. The richer probe (`src/util/creds.ts:514` `getAuthState()`) checks SSO session expiry, parses the profile, returns `health: ok|expired|missing` + a `remediation` string. The dashboard's auth indicator (#97) uses it. The CLI doesn't. One-line fix: replace the dumb printing in `auth.ts:103-128` with a call to `getAuthState()` and a structured print of its fields.

2. **`getAuthState()` itself only checks the local clock**, not whether the credentials actually work. The bedrock branch (`creds.ts:516-542`) reads `~/.aws/sso/cache/*.json`, extracts `expiresAt`, returns `health: ok` if not clock-expired. That misses the failure mode from #119: AWS revokes the credential chain server-side when a new SSO session is minted; the old token's expiresAt is still in the future, so the probe says "ok" while STS returns 403.

**How to apply:**
- **#120a (small):** wire `auth.ts status` to `getAuthState()`. Print mode + health + identity + remediation + expiresAt + watchdog status + STS cache mtime. Cheap, makes the CLI useful immediately, doesn't fix the deeper probe gap but at least surfaces what we know.
- **#120b (bigger):** make `getAuthState()` actually exercise the chain when called explicitly. Two options:
  - (i) Call `aws sts get-caller-identity --profile <p>` as part of the probe. Adds ~500ms but is the only way to know whether the chain works. Probably too expensive for the dashboard's frequent-poll path; gate behind an explicit `--deep` flag or only run in the CLI's `status` command.
  - (ii) Compare STS cache mtime against SSO session token mtime. If SSO session is newer, the STS cache is stale (per #119's diagnosis). Doesn't catch *all* failure modes but catches the common one without hitting AWS.

Lean (i) for the CLI's `status` command (run once, user-initiated, the cost is acceptable). Lean (ii) for the dashboard's polled indicator (cheap, catches the common case).

**Composite with #117 / #118 / #119:** all four are auth-failure failure modes. #117 (wrong watchdog profile) prevents prevention; #118 (no log) hides the evidence; #119 (manual SSO leaves STS cache stale) is the runtime symptom; #120 is "forge can't even tell you what's wrong." Fix all four and the SSO auth path becomes honest.

**Caught:** 2026-05-13 — alongside #117/#118/#119 in same diagnosis session.

### #119 — Manual `aws sso login` invalidates forge's STS cache but forge doesn't notice
**Closed:** 2026-05-26. `detectStaleStsCache()` compares freshest SSO-session-cache mtime against freshest STS-cli-cache mtime; if SSO is newer (the typical manual-login-revoked-prior-STS shape), it returns a stale warning with the `aws sts get-caller-identity` remediation. Wired into both `validateCredsForNewRun()` (fails pre-spawn instead of letting the agent burn on a 403) and `forge auth status` (shown as a ⚠ warning). 7 tests added.

**Why:** Caught 2026-05-13. Failure mode: SSO session aged out overnight (watchdog wasn't refreshing per #117), Steven did `aws sso login --profile adx-dev` manually at 06:33 PDT. New SSO session minted. But `~/.aws/cli/cache/<hash>.json` still held STS credentials derived from the *old* SSO session — clock-valid (`Expiration: 2026-05-13T19:12:27Z`) but actually revoked by AWS the moment the new session was created. Container at 06:34 read the stale-but-clock-valid STS creds, sent them to Bedrock, got 403 "security token expired" on the first request and every retry. The container itself can't refresh — `~/.aws` is mounted read-only.

**How to apply:** Three layers worth considering:
1. **Pre-flight check in `forge new` / `forge next`:** beyond the existing #79 SSO-expiry check, verify the STS cache's underlying SSO session is the *current* one. Compare STS cache file mtime against SSO session token mtime: if SSO is newer, the STS cache is stale. Either fail the pre-flight with a clear message ("STS cache stale — run `aws sts get-caller-identity --profile $AWS_PROFILE` then retry") or auto-trigger STS re-derivation by calling that command from forge itself before spawn.
2. **Document the gotcha in `forge auth status`:** if mismatch detected, surface it: "⚠ STS cache predates current SSO session — derive fresh creds with `aws sts get-caller-identity --profile $AWS_PROFILE`."
3. **Container-side detection:** the agent gets 403 on first call; the agent could re-read the STS cache (still won't help since :ro mount), or forge could detect 403-on-first-call in container.stdout and surface it differently from "the agent itself errored" — currently the task just fails with no signal to the human that it was an auth-stale issue, not an agent issue.

Lean (1) + (2). The container can't fix this from inside; forge has to either catch it pre-spawn or guide the human to fix it pre-spawn.

**Composite with #117 + #118:** all three are SSO/STS auth-failure failure modes. #117 prevents the watchdog from doing its job; #118 hides the evidence; #119 is what happens when the human manually papers over the gap. Fixing #117 + #118 reduces how often #119 fires; fixing #119 makes the auth-stale state recoverable without container failure.

**Caught:** 2026-05-13 — root-cause analysis of why task-plan-7acda2 failed despite a fresh `aws sso login`.

### #118 — SSO watchdog has no log file; failures are invisible
**Closed:** 2026-05-26. Watchdog spawn now passes `[ignore, logFd, logFd]` instead of `'ignore'`; log lands at `~/.forge/sso-watchdog.log` (append-only — user rotates manually if it grows). New `forge auth watchdog-tail [-n N]` subcommand prints the path + tails the last N lines.

**Why:** Caught 2026-05-13 alongside #117. `src/util/sso-watchdog.ts:42` spawns the watchdog with `stdio: 'ignore'`. Any output the script produces (the `echo "[watchdog] ..."` lines for SSO-OK / refresh-attempt / refresh-failure) goes to `/dev/null`. When something goes wrong (wrong profile per #117, AWS CLI not installed, network blip), there's no on-disk record. Yesterday's #117 failure was undetectable until the container errored, which itself took hours.

**How to apply:** Redirect the watchdog's stdout+stderr to a log file at `~/.forge/sso-watchdog.log` (or one log per runId, rotating). Trade-offs:
- Single log: simpler; tail-able; old runs' entries linger
- Per-run log: cleaner audit per run; more files; harder to grep across history

Lean single log with a length cap (truncate-on-start or rotate at N MB). The script already prints timestamps, so a single log is grep-friendly.

Implementation: in `src/util/sso-watchdog.ts`, replace `stdio: 'ignore'` with `stdio: ['ignore', logFd, logFd]` where `logFd` is `openSync('~/.forge/sso-watchdog.log', 'a')`. Add a `forge auth watchdog-tail` CLI subcommand or similar so the user can read it without remembering the path.

**Caught:** 2026-05-13 — same diagnosis session as #117.

### #117 — SSO watchdog default profile is hardcoded and wrong for most setups
**Closed:** 2026-05-26. One-line fix in `scripts/run-sso-watchdog.sh`: `PROFILE="${SSO_WATCHDOG_PROFILE:-${AWS_PROFILE:-adx-dev-sso}}"`. Watchdog now inherits the user's already-set shell profile by default; the hardcoded fallback only kicks in when AWS_PROFILE isn't set.

**Why:** Caught 2026-05-13. `scripts/run-sso-watchdog.sh:33` defaults `SSO_WATCHDOG_PROFILE` to `adx-dev-sso`. Steven's actual setup uses `adx-dev` (the sso-session is named `adx-dev`, the profile is `adx-dev`, no `-sso` suffix anywhere). The watchdog has been running overnight (PID 64730, started May 12 20:20) but refreshing the wrong profile name — `aws sso login --profile adx-dev-sso` fails because that profile doesn't exist in `~/.aws/config`. Watchdog's `stdio: 'ignore'` in `src/util/sso-watchdog.ts:42` swallows the error output, so the failure was invisible.

**How to apply:** Two options worth weighing:
- (a) Default `SSO_WATCHDOG_PROFILE` to `${AWS_PROFILE:-adx-dev-sso}` in the script. Simplest — the watchdog inherits whatever the user's shell already set, falling back to today's default only when AWS_PROFILE is unset.
- (b) `src/util/sso-watchdog.ts` reads `process.env.AWS_PROFILE` at spawn time and passes it to the script as `SSO_WATCHDOG_PROFILE=<value>` in the child env. Marginally cleaner separation (script doesn't read env directly, forge controls the value).

Lean (a). Minimal change, matches how the user already authenticates, no schema change.

**Caught:** 2026-05-13 — diagnosing task-plan-7acda2 auth failure on the System Map (#105) run.

### #107 — Reds-during-reconcile: missed-reds-on-orphan-recovery is a design question
**Closed:** 2026-05-26. Stale alongside #74 — reconcile was deleted in the v2 cutover (commit 5ad0061), so the design question this ticket frames no longer has a target code path. Re-file if v2 ever grows an orphan-recovery mechanism.

**Why:** Split from #91 (item 3) on 2026-05-12. When forge recovers an orphan task whose phase has reds attached, the reds may never have been spawned — the parent forge died before kicking them off. Reconcile today (post-#91) just transitions the task per its gate type and continues, silently skipping the reds. For **specialist reds** (gateOnVerdict: false, informational only) that's mostly fine — the audit is lossy but the workflow continues correctly. For **authoritative reds** (gateOnVerdict: true) that's a real correctness gap: reds were supposed to gate the advance, but their absence is invisible to the human.

**The two real options, both with tradeoffs:**

1. **Spawn missed reds during reconcile.** Reconcile detects the gap (phase declares reds, no red tasks exist for this parent) and dispatches them as part of the recovery. Pros: workflow behaves as if forge had never died. Cons: reconcile becomes a dispatcher, not just a state-fixer — bigger surface, more failure modes. Also: the original task's container is gone, so the reds run against the post-hoc artifact rather than the live agent. That's actually fine for most red types (they read result.json), but a category to verify.

2. **Force a human-visible audit gap.** Reconcile transitions the recovered task to `awaiting_gate` (regardless of the phase's actual gate type) and leaves a marker on the task that "reds did not run on recovery — review the diff manually." The human force-advances after eyeballing. Pros: simpler reconcile; the audit gap is surfaced rather than hidden. Cons: harder for the human (no red verdicts to lean on); workflow stalls on every recovery even for benign cases.

**Open design questions to resolve before implementation:**
- Does the answer differ for specialist vs authoritative reds? Probably yes — specialist can be silently skipped (option 2-lite: continue but log), authoritative MUST surface (option 1 or 2).
- How does reconcile detect "reds were declared but not spawned"? Needs to compare `phase.reds` config to the actual red tasks in the DB — a small new query, doable.
- Where does the audit marker live in option 2? A field on the task row? A separate notes table? The dashboard's task detail would need to render it.

**Caught:** 2026-05-12 — separated from #91 so the simpler gate-honoring fix can ship without waiting on this conversation.

### #74 — Reconcile + watchdog can't catch zero-stdout orphans
**Closed:** 2026-05-26. Stale — `reconcile` was deleted in the v2 cutover (commit 5ad0061); the idle-stdout watchdog it references is gone too. The underlying failure mode (task stuck `running` after silent container death) may still exist in v2 in a different shape, but it hasn't been observed there. Re-file a fresh v2-shaped ticket if/when it bites.

**Why:** Caught 2026-05-08 on `task-investigate-dace4f`. Container apparently died (no `docker ps` output) but the task stayed `running` in the DB indefinitely. Three failure modes stacked:
1. **No container.stdout.log was ever written.** The task workspace had only the input files + an empty 0-byte `result.json`. Stdout never started flowing — possibly the container exited before producing any, or forge's `cpSpawn` parent process died before piping anything to disk.
2. **Reconcile doesn't catch this.** `reconcileRun` checks for non-empty `result.json` to decide "agent finished, forge lost track." Empty-but-existing `result.json` is treated as "still running, skip" — but here the container is genuinely gone.
3. **Idle watchdog can't fire.** The watchdog hooks `proc.stdout`. If the parent forge process (or its dispatch invocation) already exited, the watchdog isn't running anymore. If the container produced zero stdout AND its forge parent died, there's nothing watching.
**How to apply:** Three layered fixes worth considering:
1. **Reconcile sniffs for dead containers, not just non-empty result.json.** When status=running on disk but `docker ps` shows no matching container (forge could persist the container id at spawn time + check it on reconcile), mark failed with `container_crash`.
2. **Persist container id at spawn.** New column `tasks.container_id`. Lets reconcile check `docker inspect <id>` to detect "container is exited / dead / not running."
3. **Treat empty result.json + age beyond N minutes as a hard signal.** If a task has been "running" for over (say) 2× the idle-timeout AND result.json is 0 bytes AND no container is alive, declare it crashed.
**Recovery for the in-flight case:** SQL UPDATE the task back to pending + delete the empty result.json + `forge next` re-dispatches. Done manually for `task-investigate-dace4f` 2026-05-08.

### #77 — Evaluate Preact + htm for the dashboard
**Closed:** 2026-05-26. Already done — dashboard runs on Preact + htm via esm.sh, no build step. Ticket is post-facto.

**Why:** Caught 2026-05-08 — Steven: "I think we need to start thinking about using React." The elapsed-time bug (#76), smart-refresh (#72), input-value preservation, form state across re-renders, scroll preservation, optgroup vs flat-fallback fork — all symptoms of hand-rolling reactive primitives. Each individually is <50 lines; cumulatively the dashboard's html.ts is ~2000 lines doing what a real reactive layer would do for free. The dashboard is forge's primary UX (FORGE-DEC-015); investing in the right tool compounds.
**Three options to weigh:**
1. **Stay vanilla, fix bugs as they come.** Cheap per-bug; cumulative cost grows linearly. Zero infrastructure change.
2. **Preact (~3KB) + htm (template-tagged-literal API, no build step).** Almost-React API; ~80% of the win at ~10% of the cost. Render functions become components; smart-refresh disappears; controlled inputs handle their own state. Could rewrite html.ts in stages without breaking the existing server template. ~1-2 days.
3. **Full React + Vite + build pipeline.** Splits forge into "CLI/spine + agents (TS, no build)" and "dashboard (TS, build)." Most power, but introduces a real build forge has avoided.
**Lean (2).** Bounded reactive needs (panes, not Slack), no build pipeline, real diffing without forge becoming a two-build-system project. (3) only if the dashboard genuinely needs first-class React features (Suspense, server components, big component libraries). (1) is fine for tonight; not fine for the long term given how the dashboard is growing.
**Decide cold, not in the middle of a phase-flow run.** Real cost-benefit numbers come from: counting how many lines in html.ts are reactive-primitive workarounds, prototyping one render-function-as-Preact-component, measuring the migration friction. Don't commit until those numbers exist.
**Revisit when:** another reactive-bug-of-this-shape lands AND the dashboard's html.ts crosses some threshold (3000 lines? more reactive workarounds than actual UI logic?). At that point (1) is paying real interest and (2) becomes obvious.

### #93 — Reject UX: choose where to loop back, not just trigger the workflow's fixed onReject
**Closed:** 2026-05-26. No more interactive dashboard — gate decisions go through `forge gate` from a terminal. Picker UX assumed the dashboard. If a CLI equivalent ever becomes painful, re-file.

**Why:** Caught 2026-05-09 — Steven rejected architect output (wrong scope per #92, not a brief problem). Workflow's `onReject: "brief"` fired, spawning a fresh `prompt-author` brief task. But the brief was *fine*; the architect's seed was the problem. Looping to brief redoes work that was already correct, wastes tokens, and pollutes the corpus.

**The bug:** `onReject` is a single fixed target on the phase definition. The human at gate-reject time has no way to say "this output was wrong, restart from THIS phase, not the workflow's default." Today's only options are:
1. Reject → workflow's `onReject` target fires (fixed by config, may be wrong for this rejection)
2. Force-advance with rationale (admits the bad output into downstream phases — also wrong)
3. Manually mark the run abandoned via SQL (wasteful; loses audit trail)

**Two real shapes for the fix:**
- **(a) Picker at reject-time.** When the human clicks Reject in the dashboard, surface a phase picker: "redo from which phase?" Default to workflow's `onReject` target; allow override. The chosen phase becomes the parent for the new pending task.
- **(b) Multiple onReject targets per phase.** Workflow defines `onReject: ["brief", "architect"]` as valid options; human picks which fires. Less flexible than (a), but matches workflow-author intent (they know which targets are valid).

(a) is more flexible but harder to reason about ("what if the human picks an invalid loop target?"). (b) constrains to workflow-author-blessed targets. Lean (b) — workflows know their topology; humans pick from options the workflow validates.

**Composite with #92:** if architect is properly scoped (#92), most architect-rejects will be "your scope was wrong, redo architect with fixed expectations" — looping to architect is the right target. Today's onReject loops to brief. Different outcomes; different right answers depending on what failed.

**Caught the wrong way:** at 04:30 UTC, mid-run-shutdown. Architect output got rejected; brief re-spawned automatically; killed manually. Should have been: reject → "redo architect" picker → architect re-runs against the corrected seed.

### #65 — Per-question UX for `openQuestions` at the gate
**Closed:** 2026-05-26. No longer relevant — the dashboard checklist UX assumed a write-capable dashboard. Gate flow is CLI + orchestrator-mediated now; the orchestrator already negotiates openQuestions conversationally.

**Why:** Today `result.openQuestions` is a free-form array the agent emits to disclose every default it picked when the human didn't specify (style, screens, dimensions, etc.). At the gate, the human's only response surface is one rationale textarea — to correct any single default they have to write free-text addressing whichever one(s) were wrong. The agent re-runs and re-generates the whole PROMPT.md from the synthesized rationale. Works in 1-2 rounds in practice but the UX is clunky: no per-question response, no "ok / not ok" per item.
**How to apply:** When the dashboard's awaiting-gate detail renders a task whose result has `openQuestions`, render them as a checklist with three states per question (accept / change / explain) and a small inline text field for the change case. On submit, synthesize the gate rationale automatically from the per-question responses (e.g. "accepted #1, #3; changed #2 to: <text>; left #4 open") and POST to `/api/gate/:taskId` as today. The agent's re-run loop is unchanged — just a friendlier capture surface for the human.
Caught 2026-05-08 during #53 validation. Belongs in #57's iteration backlog alongside #62/#63/#64.




### #27 — LiteLLM proxy: route each task to the model best suited to it
**Closed:** 2026-05-26. LiteLLM is not reliable enough to put on the critical path. If per-task capability-based routing becomes worth it later, build it directly against provider SDKs rather than through a proxy.

**Why:** Today every task hits Anthropic-direct or Bedrock with whatever alias the workflow declared (`spec-writer` → Sonnet, `fast-orchestrator` → Haiku, `deep-thinker` → Opus). That hard-codes provider + family in the workflow. LiteLLM lets us declare model *capabilities* (cheap-fast, balanced, deep, cheap-summarize, etc.) and route per task without rewriting workflows. A reds panel might want a cheap fast model for triage and a stronger one for authoritative; a designer might want Opus for the discover phase and Sonnet for export. Today we can't express that without scattering provider IDs through the workflow files.
**How to apply:** Run a LiteLLM proxy locally (already partially supported via `FORGE_USE_LITELLM=1`). Define logical aliases in LiteLLM's config that map to the actual best model per task type. Expand `_agentRefs.ts`'s alias set so workflows can pick something more specific than the current three (`spec-writer` / `fast-orchestrator` / `deep-thinker`). Bonus, *not* the goal: LiteLLM also reports per-call cost — wiring that into the empty `model_calls` table gives us a cost view for free, but that's secondary to the routing capability.
Related: #38 (capture resolved model on the task row) is the audit-trail companion — once both land, the dashboard can show role + alias + resolved-model + tokens (+ cost when the bonus lands).

### #123 — Dashboard a11y posture: System Map (and broader dashboard) lacks focus indicators, aria-labels, non-color status signals
**Closed:** 2026-05-26. Deferred — no real users with a11y needs yet; dashboard is solo-developer-on-localhost. Revisit when (if) the dashboard ships to anyone else. Ticket body kept for the original audit findings and proposed scope.

**Why:** Caught 2026-05-13 by red-build-5b7129 during System Map (#105) red review. Six findings on the System Map specifically: filter chips lack visible focus indicators for keyboard navigation; modal is a keyboard trap with no visible escape path in keyboard focus order; HTML node labels signal status via color only (no secondary indicators / no sufficient text contrast); filter chips + close button lack aria-labels; cytoscape canvas container is a generic div with no accessible semantics or labeling; progress bar has no accessible text alternative. **All legitimate**, but **not System-Map-specific** — this is the broader dashboard's a11y posture, which has never been audited. The findings would surface on any other dashboard view too.

**Why not blocking #105:** the PRD didn't require a11y; the dashboard's existing surfaces have the same gaps; an a11y pass is a cross-cutting concern that deserves its own dedicated work, not a dashboard-feature-by-dashboard-feature bolt-on.

**How to apply (when):**
- Audit the dashboard as a whole, not the System Map in isolation. Pill row, task list, task detail, gate UI, run-new modal, auth indicator — every interactive surface gets the same treatment.
- Focus indicators: `:focus-visible` styles via CSS for all interactive elements. Not specific to one view.
- aria-labels on icon-only buttons + dynamic regions on the live-updating task pane.
- Keyboard navigation map: confirm tab order makes sense, Esc closes modals, no traps.
- Color + non-color status signaling: status badges already carry text ("complete" / "running"), so much of the color-only finding is incorrect-on-inspection — but the System Map's node label is the most color-heavy, would benefit from a glyph or text-label secondary signal.

**Sequencing:** post-#105 cleanup. Probably 1-2 days of focused work; not urgent, not in scope until a real user with an accessibility need surfaces.

**Caught:** 2026-05-13 — red review of System Map build.

### #154 — Dashboard Projects view: registry + orchestrator status as one page
**Closed:** 2026-05-26.

Filed 2026-05-26. Fourth piece of the project-registry / orchestrator-tracking arc; consumes #151, #152, #153.

**Problem.** The dashboard today only surfaces individual runs + in-flight tasks. There's no project-level view that answers "what projects do I have?" or "where am I actively working right now?".

**Shape.** New top-level dashboard page or tile: "Projects". Each project rendered as a card.

**Per-card content:**
- Project chip (color from .vscode, name from .forge/project.json if present)
- Description (from .forge/project.json) if present
- Last activity timestamp (relative: "2 hours ago", "3 days ago", "6 months ago")
- Run count + in-flight count
- 🟢 LIVE badge if \`~/.forge/orchestrators/\` has a fresh heartbeat for this projectDir (#153)
- Click → drills into the runs view filtered to this project

**Sort order:** by last activity, descending. Live projects float to the top (their last activity is "now").

**Visual states:**
- Live (orchestrator open + recent forge activity)
- Active (recent forge activity, no open orchestrator)
- Idle (no activity in >N days, no orchestrator)
- Stale (>6 months, dimmed but still visible)

**Implementation surface:**
- Dashboard server: new \`/api/projects\` endpoint returning the registry data + heartbeat status. Shape mirrors what \`forge projects list --json\` (from #152) returns, plus the heartbeat read.
- Dashboard client: new \`<ProjectsView />\` component. Uses the existing chip styling from #143.
- Routing: add a "Projects" link to the dashboard nav (alongside the existing activity feed).

**Composes with:**
- #143 (project chip color resolution) — reused for project cards.
- #151 (friendly name) — display name source.
- #152 (registry CLI) — same data source (refactored helper).
- #153 (orchestrator heartbeats) — live status badge.

**Out of scope:**
- Editing projects from the dashboard. The dashboard is read-only; mutations stay in CLI.
- Filtering / search beyond sort order. Add if it becomes painful.
- Per-project drill-down view richer than the existing runs view (yet — maybe later as a follow-up).

**Sizing.** Medium. The API endpoint is small; the client view is the bulk.

**Sequencing.** Needs #151, #152, #153 all shipped first. Comes last in the arc.

**Caught:** 2026-05-26 design conversation.


### #153 — Orchestrator heartbeats: track live Claude Code sessions running forge orchestrator
**Closed:** 2026-05-26.

Filed 2026-05-26. Third piece of the project-registry / orchestrator-tracking arc.

**Problem.** Forge doesn't know which projects have a live Claude Code orchestrator session open. The dashboard / future Projects view can show "this project had recent forge activity" but can't show "the user has a terminal open in this project RIGHT NOW driving forge."

The user explicitly asked for the latter in 2026-05-26 conversation. Two interpretations were considered:
- A. "Projects with recent forge activity" — derivable from existing DB. Approximate (a project can have an active in-flight run with no open terminal, or an open terminal with no recent dispatch). User rejected; wants the literal answer.
- B. "Live Claude Code sessions running the forge orchestrator block" — needs the orchestrator to actively announce itself.

This ticket implements B.

**Shape.** Heartbeat-driven liveness via Claude Code hooks installed by \`forge init\`:

1. **SessionStart hook** — when Claude Code starts in a project with the forge orchestrator block, the hook writes \`~/.forge/orchestrators/<session-id>.json\`:
\`\`\`json
{
  "sessionId": "abc123",
  "projectDir": "/Users/steve/code/my-app",
  "startedAt": "2026-05-26T10:00:00Z",
  "lastSeen": "2026-05-26T10:00:00Z"
}
\`\`\`

2. **Stop hook** (fires after every agent turn) — touches \`lastSeen\` in the same file.

3. **SessionEnd hook** — deletes the file.

4. **Liveness rule** (read side): a session with \`lastSeen\` newer than N minutes is "live"; older is "stale" (the SessionEnd hook didn't fire — terminal force-killed, etc.). Stale entries can be auto-garbage-collected after some threshold.

**Installation:**
- \`forge init\` writes the hook config to \`<project>/.claude/settings.json\`, alongside existing project setup (CLAUDE.md, .forge/).
- \`--no-install-hooks\` flag (already exists for commit-msg) extends to also suppress this hook install.
- Hook script lives at \`scripts/claude-hooks/orchestrator-heartbeat\` (shell, ~30 LoC) and is symlinked into projects.

**Composes with:**
- #152 (projects registry) — Projects view displays a "🟢 live now" badge on the card for any project with a fresh heartbeat.
- #154 (dashboard Projects page) — renders the live status.

**Out of scope:**
- Live-streaming the orchestrator's CONVERSATION (just liveness, not content).
- Showing what the orchestrator is doing right now (just "alive y/n").
- Multi-user / multi-machine orchestrator visibility — single Mac, single user.

**Sizing.** Medium. Hook scripts + install flow + tests + dashboard cross-reference.

**Tradeoff to flag at implementation time:** every \`forge init\`'d project gets a Claude Code hook installed in \`<project>/.claude/settings.json\`. Some users may find that intrusive. The \`--no-install-hooks\` opt-out covers it.

**Caught:** 2026-05-26 design conversation.


### #152 — forge projects list CLI: registry derived from runs DB + filesystem scan
**Closed:** 2026-05-26. Commit `e57e6e0c807c032eacd4dc22352460e04677a0cc`.

Filed 2026-05-26. Second piece of the project-registry / orchestrator-tracking arc; needs #151 (friendly name override) shipped to consume the project.json names.

**Problem.** User comes back from a break (travel, vacation) and can't easily remember every directory that is an active forge project, what state each is in, where on disk they live. No registry today.

**Shape — implicit registry, no new persistent state.** A "forge project" is detectable from existing signals:
- **DB:** \`SELECT DISTINCT project_dir FROM runs WHERE project_dir IS NOT NULL\` — every projectDir forge has ever dispatched against.
- **Filesystem:** scan a configurable root (default \`~/code\`, bounded depth) for directories whose \`CLAUDE.md\` contains the \`<!-- forge:orchestrator-start -->\` marker. Catches forge-init'd projects that haven't yet had a run.

Union, dedupe, sort by last activity. No \`forge projects add\` ceremony; \`forge init\` (or first \`forge new\` against a dir) effectively registers via these signals. Deleting a project drops it out naturally.

**Per-project metadata (no new tracking):**
- Friendly name (from \`.forge/project.json\` per #151) or basename
- Description (from \`.forge/project.json\`)
- Project color (from \`.vscode/settings.json\` titleBar.activeBackground — already resolved by dashboard/src/project-meta.ts)
- Last forge activity (max created_at across all runs/tasks for this projectDir)
- Total run count
- In-flight count (active runs + awaiting-gate runs)
- BACKLOG.md presence (\`<project>/BACKLOG.md\` exists?)
- README first line, if a README exists (the "what is this?" reminder)
- Last git commit timestamp (\`git log -1 --format=%ct\` cross-check, optional — guards against the case where forge.db says "active 6 months ago" but git shows "yesterday")

**CLI surfaces:**
\`\`\`
forge projects list                              # table sorted by last activity
forge projects list --sort=name                  # alphabetical
forge projects list --json                       # for scripting / dashboard
forge projects show <name>                       # detailed view of one project
forge projects show <name> --json                # detailed JSON
\`\`\`

Filesystem scan root configurable via env var (\`FORGE_PROJECT_SCAN_ROOTS=~/code,~/work\`) and \`--scan-root\` flag. Default \`~/code\` with max depth 3 (bounded to prevent runaway scans on large hierarchies).

**Implementation surface (~80-100 LoC):**
- New \`src/cli/commands/projects.ts\` — subcommand registration + handler logic.
- Refactor \`dashboard/src/project-meta.ts\` into a shared location (probably \`src/util/project-meta.ts\` with a re-export from the dashboard alias). Both CLI + dashboard read project.json + .vscode color from the same code.
- New SQL helper (in src/store/runs.ts or sibling): \`uniqueProjectDirs(): Array<{projectDir, lastRunAt, runCount, inFlightCount}>\`.
- Filesystem scan helper — pure-ish, recursive walk with depth bound, looks for CLAUDE.md + orchestrator marker.
- Tests for the SQL helper, the filesystem scanner, and the CLI command's pure formatting logic.

**Out of scope:**
- Dashboard Projects page (separate ticket — #154).
- Orchestrator-heartbeat integration (separate ticket — #153).
- \`forge projects add / remove\` (none needed — implicit registry).
- \`forge projects set <field> <value>\` to mutate project.json. For now, edit the file.

**Sizing.** Small-medium. One focused session.

**Caught:** 2026-05-26 design conversation.


### #151 — Friendly project name override via .forge/project.json
**Closed:** 2026-05-26. Commit `d8e8199265b44ab85c13a56d0b0c661a8143db42`.

Filed 2026-05-26. Smallest piece of the project-registry / orchestrator-tracking arc; ships first since both later features (forge projects CLI, dashboard Projects view) consume it.

**Problem.** Project labels in the dashboard chip + future registry derive from basename(projectDir). Some projects' directory names aren't friendly ("pocket-v1" → "Pocket — typing tutor"). User needs a way to override.

**Shape.** Optional file at \`<projectDir>/.forge/project.json\`:

\`\`\`json
{
  "name": "Pocket — typing tutor",
  "description": "split-keyboard pen-down trainer"
}
\`\`\`

Both fields optional. Missing file OR missing field → fall back to basename behavior (current).

Lives in \`.forge/\` (already created by \`forge init\`). No new directory.

**Why JSON over YAML.** Dashboard already parses JSON for .vscode color; no new parser needed. The shape is trivially flat; YAML's structural advantages don't apply.

**Why not piggyback on .vscode/settings.json** (where we get the color from): VS Code-specific. Some users / machines won't have VS Code. \`.forge/project.json\` is forge-native and works regardless.

**Implementation surface (small, ~30 LoC):**
- \`dashboard/src/project-meta.ts\` — extend the existing resolver. Read \`<projectDir>/.forge/project.json\` after the .vscode lookup. Return \`{label, color, description?}\`. \`label\` becomes \`name\` if present, basename otherwise.
- Dashboard \`ProjectChip\` already uses the resolved \`label\` — picks up the override automatically.
- Existing project-meta.test.ts adds 3-4 tests: project.json present with name only, with name + description, missing file (basename fallback), malformed JSON (basename fallback).

**Out of scope this ticket:**
- CLI to set the name (\`forge projects set\`). For now, edit the file by hand — fine for personal use.
- Reading project.json from anywhere outside the dashboard. The future forge projects list CLI will need it too; at that point refactor into a shared module. Don't preemptively move code.
- Caching invalidation when project.json changes mid-process — restart dashboard to pick up.
- Description anywhere — it's read but only stored on the entry; rendering it is for the future Projects view ticket.

**Composite with:**
- #(future) forge projects list — registry CLI. Reads the same resolver.
- #(future) orchestrator heartbeats — \`~/.forge/orchestrators/\` driven by Claude Code SessionStart/Stop hooks.
- #(future) dashboard Projects view — composes registry + heartbeats + friendly names.

These three are listed in the 2026-05-26 conversation; will file separately.

**Sizing.** Tiny. One focused session.

**Caught:** 2026-05-26 design conversation about project-registry / orchestrator-visibility feature arc.


### #147 — Reds: evidence-anchored output schema + post-validation to catch hallucinated citations
**Closed:** 2026-05-26. Commit `2cbcc05d133dab6603ab9e15b2dd967ba33f7267`.

Filed 2026-05-26 based on empirical audit of all 23 red verdicts in ~/.forge/forge.db.

**Why filed (data).** Of 23 red verdicts in the DB:
- 4 (17%) hallucinated their file:line citations — cited files don't exist, OR cited line is past EOF.
- Of those 4, **2 were authoritative \`fail\` verdicts at confidence 0.95 that BLOCKED runs against the split-keyboard-teacher project on entirely fabricated evidence**. Both came from red-backend on the same run (\`run-pocket-v1-prompt-practice-and-weakness-engine-*\`).
- 1 additional verdict was MIXED (some real citations, some hallucinated).

The pattern: reds emit confident, well-structured-looking findings with file:line references that LOOK plausible but point to nothing. Forge's gate aggregator currently trusts them at face value.

**Fix shape (technique #1 from /tmp/red-false-positives-research.md).** Mechanically grep-validate every cited file:line against the actual project source. Drop findings where the quoted text doesn't appear at the cited location. A verdict where all findings get dropped post-validation downgrades to inconclusive.

**Concrete changes:**
1. **Finding schema extension** — \`Finding\` type (\`src/types/index.ts\`) gains \`{file: string, line: number, quoted_text: string}\` as required fields alongside the existing \`{severity, summary, evidence, hypothesis}\`. \`quoted_text\` is a short verbatim snippet (1-3 lines) from \`file\` at \`line\`.
2. **Post-validator in \`src/v2/gate.ts\`** — when a verdict is written, iterate findings; for each finding, read \`<projectDir>/<file>\` at \`line ± 3\` lines of context; check whether \`quoted_text\` appears in that window. Drop findings where it doesn't. ~30-50 LoC.
3. **Verdict downgrade rule** — if a \`fail\` verdict had N findings before validation and 0 after, downgrade to \`inconclusive\` with a synthesized note \"all findings failed post-validation; treat as inconclusive\". Logged via \`logEvent\` for diagnostics.
4. **Seed updates** — all 5 red seed prompts (\`red-wide\`, \`red-narrow\`, \`red-frontend\`, \`red-backend\`, \`red-security\`) updated to require the new schema. New instruction: \"every finding MUST cite file:line AND quote 1-3 lines verbatim from that location. Findings that fail verbatim-match validation will be silently dropped.\"
5. **Tests** — new gate.ts tests verifying: drop on mismatched quote, drop on missing file, drop on out-of-bounds line, downgrade fail→inconclusive when all findings dropped, preserve verdicts where validation passes.

**Out of scope:**
- Per-finding waiver / suppression. Separate feature, separate ticket.
- K-of-N self-consistency sampling (technique #2). Defer until #1 is in place and we see the cleaner verdict stream.
- Ground-truth feedback capture (technique #3). Defer.
- Anything that changes the LLM behavior (prompts) beyond the schema requirement. The validator is the load-bearing change; seed updates are just to make reds emit the data the validator wants.
- Retroactive validation of historical verdicts. New rule applies only to new verdicts.

**Expected impact (from the audit data):**
- Prevents 2 of the 23 historical verdicts from BLOCKING runs (the red-backend hallucinations).
- Drops findings from 4 of 23 verdicts (the hallucination cluster).
- Plus probable cleanup of red-narrow's noise (its findings rarely cite anything, so most would get dropped → verdicts naturally land at inconclusive instead of being treated as signal).

**Sizing.** Small-medium. One focused session.

**Caught:** 2026-05-26 audit of red verdicts; cross-referenced with FP-mitigation literature survey at /tmp/red-false-positives-research.md.


### #90 — Submit captures corpus-level artifacts, not run-level deliverables
**Closed:** 2026-05-25. Deferred-by-design per the ticket's own "wait until it becomes a real problem in a real run" guidance. The mtime-threshold fix (option 2) is well-scoped; re-file as actionable when corpus noise actually shows up in a feature run that isn't design-bootstrap.

**Why:** Caught 2026-05-08 reviewing phase-flow submit. The validator globs `*.png` / `*.html` across designDir/{designs,code}/ and stores all matches in `result.pngFiles` / `result.htmlFiles`. With shared-corpus reuse (#67), that's the *whole corpus*, not just this run's deliverables. The phase-flow run's review task captured 24 PNGs + ~25 HTMLs — 20 of each from earlier runs that have nothing to do with the phase flow widget. Architect agent reads `inputs.upstream[*].result.pngFiles` and gets the full list as input, including 20 unrelated screens.

**For this run it's fine** (architect needs full corpus context to integrate the new component into the existing dashboard). For other features where designDir has unrelated history, it'd be noise.

**Three options:**
1. **Snapshot at brief-time, diff at submit-time.** When `forge new` creates a run with `--design-dir`, snapshot the existing file list to `run.metadata.designDirSnapshot`. At submit, compute "new since snapshot" and store both: `result.allPngFiles` (full corpus) and `result.newPngFiles` (just this run's). Architect prompt could choose which to read.
2. **mtime threshold.** Submit only captures files newer than `run.createdAt`. Cleaner; doesn't require run-creation-time bookkeeping. Edge case: if the human iterates in Pencil for a long time and the corpus had files added meanwhile (e.g. another forge run finished mid-Pencil-session), they'd show up as "new." Probably rare enough to ignore.
3. **Leave as-is.** Architect prompt updated to "when there are 20+ artifacts, distinguish 'just this run' from 'pre-existing context' by looking at filename numbering patterns." Frail; punts the problem to the agent.

**Lean (2)** — mtime threshold. Simple, no schema change, agent gets clean input most of the time. Composite with #88 (corpus consistency) makes the corpus-vs-deliverable distinction operational at multiple layers.

**Sequencing:** wait until we see this become an actual problem in a real run. For phase-flow specifically, the full-corpus context is appropriate. Capture and defer.

### #59 — Track Pencil release notes for auto-save shipping
**Closed:** 2026-05-25. Not work, just a watch reminder — closing as such. Re-file as actionable when Pencil ships auto-save (or any 0.3+ release that affects the PROMPT.md template's Cmd+S/stat-verification scaffolding).

**Why:** Pencil 0.2.5 has no auto-save (https://docs.pencil.dev/troubleshooting). Our PROMPT.md template has a load-bearing "Cmd+S to save dashboard.pen" warning + a stat-verification step. When Pencil ships auto-save, the warning becomes obsolete.
**How to apply:** Periodically run `npm view @pencil.dev/cli version` and check the changelog. When auto-save lands:
- Update the prompt-author template to drop the loud Cmd+S warning + the stat-verification step.
- Test that the .pen file persists without human Cmd+S in a real run.
- Update FORGE-DEC-014 with a "Revisited" note pointing at the simpler flow.
Lightweight: probably one check every couple of months unless we hear about it sooner.

### #81 — Pencil MCP server stale-handle failure mode (workaround documented)
**Closed:** 2026-05-25. Documented bug in Pencil 0.2.5 (VS Code extension specifically); workaround in PROMPT.md template tells the human to watch for the dirty marker. Nothing for forge to fix — upstream Pencil owns it. Steve flagged 2026-05-25 that desktop Pencil may not have this MCP-handle issue; if the design workflow rework moves toward desktop, this whole class of bug may be moot. Re-file as actionable if the failure mode shows up in a non-VS-Code Pencil session.

**Why:** Caught 2026-05-08 mid-phase-flow run. Pencil-Claude reported successful MCP calls (`open_document`, frame inserts, etc) and exported PNGs to disk, but the `dashboard.pen` tab in VS Code showed no dirty marker — meaning the in-memory edits were landing in *some* document, just not the one VS Code was showing. End-of-run Cmd+S did nothing because there was nothing dirty in the visible doc. Net result: PNGs exported, `.pen` source not updated, design lost on session close.

**Hypothesis:** Pencil's MCP server holds per-session in-memory document handles. If an earlier MCP call (or the `touch <wrong-name>.pen` precondition step that created an empty stub) activated a *different* in-memory document, subsequent calls with `filePath: <correct path>` silently routed to the stale handle instead of the file the human had open. The MCP tool reports success because it operated on *some* doc, just not the right one.

**Fix that worked:** restart VS Code → restart Claude session → re-run prompt. Cleared the handle map. Subsequent run shows dirty marker on `dashboard.pen` immediately on first MCP call (verified 2026-05-08).

**What forge / the prompt-author seed can't defend against:** this is Pencil-internal state. No external tool can introspect Pencil's MCP handle map. The seed's existing `get_editor_state` after `open_document` step is supposed to catch the wrong-active-editor case, but if MCP misroutes silently it would still report the right path.

**What the human can do:** watch the VS Code dirty marker as the live correctness indicator. If it doesn't appear within seconds of the first MCP call, the session is broken. Stop, restart VS Code + Claude, re-run.

**Add to PROMPT.md template:** a step early in the prompt that says "after the first `open_document` call, the human watching VS Code should see a dirty marker (●) appear on the target file's tab. If no marker appears within 10 seconds of the first edit, the MCP session is broken — restart VS Code and Claude, then re-run this prompt."

**Composite with #80:** #80's per-screen Cmd+S reminders are still good (Pencil sessions can also crash mid-run for unrelated reasons). The dirty-marker check is an *earlier* tripwire — catches the failure within seconds of starting, not after 24 screens of wasted work.

### #122 — Dashboard request-changes doesn't auto-dispatch the replacement task
**Closed:** 2026-05-25. Obsolete — the dashboard is read-only now; all gate decisions go through the orchestrator session, not dashboard clicks. There is no "request changes" button left to fix.

**Why:** Caught 2026-05-13 during System Map (#105) planner iteration. Workflow: click "Request changes" with rationale on the planner output. Spine inserts a new pending task for the same phase per `gate.ts:173-179` (re-queue with rationale injected as `inputs.requestedChanges`). Expected: dashboard automatically dispatches the new task (same way #108 chained gate-advance into `forge next`). Actual: the new task sits at `pending` until the human clicks "Run Next" a second time. Two clicks for what should be one action.

**Why this is a real bug, not a UX preference:** Request-changes IS the human's "redo this" decision. There's no second decision pending; nothing else the human reasonably wants to do between "request changes" and "dispatch the redo." The two-click pattern adds friction without adding choice.

**How to apply:** Look at how #108 wired advance auto-dispatch — same hook, same pattern. The dashboard's `/api/gate/:taskId` handler returns `nextTasks` from `gate()`; for advance, the dashboard chains into `next()`. The request-changes branch returns the replacement task in `nextTasks` too but the dashboard doesn't follow up. Probably 5-10 lines in the dashboard's gate handler — same auto-dispatch hook, just trigger on request-changes too.

**Doesn't apply to:**
- `reject` — that loops to a *different* phase via `onReject`; auto-dispatching could surprise the human (different phase, different agent, may want to pause).
- `advance` — already auto-dispatches per #108.
- `request-changes` to a manual phase — these throw at the spine layer per `gate.ts:152-157` so they can't reach this path.

**Composite with #115** (middle pane misses task.created): if #122 ships first, the request-changes flow becomes "click, see new task running" — which only works correctly if the middle pane actually shows the new task. #115 fixes the rendering gap; #122 closes the auto-dispatch gap. Both needed for the flow to feel right end-to-end.

**Not relevant for #116:** in the YAML orchestrator, request-changes is probably just a step-re-spawn, not a separate task-row insertion + dispatch. This is a v1 patch.

**Caught:** 2026-05-13 — after iterating planner output three times on System Map run.

### #146 — Engineer container missing pnpm (and likely yarn) on PATH — forces per-run workarounds
**Closed:** 2026-05-25. Commit `5913c1b5a7b26ec0e39b8c9f42f1da0eecb36ca0`.

Filed 2026-05-25. Recurring per-session friction on pnpm-based projects.

**Problem.** The agent-dev-worker container ships with Node 20 + npm but not pnpm. Any project using pnpm as its package manager (e.g. harebrained-apps, modern Next.js projects) hits this — the engineer cannot run the project's test commands until they self-install pnpm, OR they substitute a different validation path and leave a gap.

**Evidence.** Two engineer runs in one orchestration session against harebrained-apps (2026-05-25) both reported the issue:
- Run \`run-remove-dead-output-standalone-from-next-config-ts-cd2093\`: engineer worked around by running \`npm install -g pnpm\` into /home/agent/.npm-global/bin mid-task. Tests subsequently passed.
- Run \`run-backlog-6-resolve-pre-existing-eslint-errors-61116c\`: engineer skipped \`pnpm test:e2e\` entirely and substituted \`node_modules/.bin/eslint src/\` + \`tsc --noEmit\` for validation, noting "pnpm is unavailable in this container."

**Impact.** Lose-lose decision per engineer run on pnpm projects:
1. Accept the substitute validation (lint + tsc only) → partial seed compliance; orchestrator must judge whether the change touches the e2e surface and possibly run e2e on the host.
2. Reject and re-run → token waste for what was a reasonable substitution.

**Fix.** Add pnpm to docker/agent-dev-worker.Dockerfile via \`npm install -g pnpm@<pin>\`. One-line addition + image rebuild. Pin a specific major version for reproducibility (pnpm 10 is current at filing time).

Also worth adding: \`yarn\` (Yarn 1 / classic). Many older projects still use it; same one-line install pattern. Skip \`bun\` for now — it's a separate runtime, conflicts more, can add later if a project actually needs it.

**Sizing.** Tiny. One Dockerfile edit, one image rebuild (5-10 min), one smoke test that \`pnpm -v\` works in a fresh container, commit.

**Caught:** 2026-05-25 during back-to-back harebrained-apps runs.


### #144 — Auto-tint iTerm2 background to match forge project on cd / forge invocation (research)
**Closed:** 2026-05-25. Commit `029a8d357709fba1d2d85d6ec8ffd6bd815a2804`.

Filed 2026-05-25 as a research ticket.

**Idea.** Compose with the dashboard-color ticket (#143 — per-project label + color, sourced from .vscode/settings.json titleBar.activeBackground when present). Same idea, extended to the terminal: when you cd into a project (or run forge there), iTerm2's window background subtly tints to that project's color. Combined with the VS Code titlebar already being that color and the dashboard cards being that color, you get one consistent visual cue for "which project am I in right now?" across editor / terminal / dashboard.

**Research questions:**
1. Does iTerm2 support runtime background color changes via the command line? Likely yes via proprietary escape codes (`\033]1337;SetColors=bg=...\007`) or the iTerm2 Python API. Confirm exact syntax + edge cases (does it persist? per-tab vs per-window? does it survive a new tab? does Ghostty / kitty / other terminals expose anything equivalent for portability?).
2. What's the right trigger? Options:
   - **chpwd hook in zsh** — fires on every cd. Wire a function that reads `<cwd>/.vscode/settings.json` and tints accordingly. Most natural; zero forge involvement.
   - **forge CLI tint-on-invoke** — forge runs a `tintTerminal()` call at startup based on cwd's color. Tighter integration but only fires when forge runs (so terminal stays untinted between commands).
   - **Separate shell helper** — `forge-tint` or similar binary that the user wires into their shell config however they want.
3. How to handle "no color in .vscode/settings.json"? Don't tint? Use a hash-based default like the dashboard does? Reset to the iTerm2 profile default?
4. Subtle vs. obvious? A 5% saturation tint might be readable without being distracting; a 30% tint might be obnoxious. Test in practice.

**Sized as:** small to medium for research; the implementation is small either way (escape codes are stable).

**Composite with #143** (dashboard project color). Same color source, same lookup, same caching opportunity — if both land, factor out a `getProjectColor(projectDir)` helper they share. If just one lands, it's still useful standalone.

**Out of scope until research:** anything beyond iTerm2. Other terminals (Ghostty, kitty, Alacritty, plain Terminal.app) have varying levels of support. Don't try to be portable until iTerm2 is proven.

**Caught:** 2026-05-25 in conversation about dashboard project colors.


### #145 — Twilio SMS double opt-in flow: subscribe/confirm/unsubscribe + consent log
**Closed:** 2026-05-25. Commit `4a6ebc6`.

Filed 2026-05-25. Follow-on to #142 (Twilio SMS notifications shipped). Adds an explicit consent flow so the campaign-approval story is defensible.

**Why filed.** Twilio's A2P 10DLC campaign approval requires proof of recipient opt-in, even for one-person personal use. The current setup (edit notify.env with your TWILIO_TO and you're done) works mechanically but doesn't generate an audit trail. Shape 3 from the design conversation (CLI subscribe/confirm/unsubscribe) was preferred over self-attestation because it's safer: every subscription has a timestamped consent record + the recipient actively confirmed via SMS code.

**Flow.**
1. `forge notify subscribe +15551234567` — initiates. Forge generates a 4-digit code, stores pending state in ~/.forge/notify-state.json, sends an SMS: "forge: confirm subscription with: forge notify confirm 4827. Code expires in 10 minutes. Reply STOP to opt out."
2. `forge notify confirm <code>` — completes. Validates code, writes TWILIO_TO to notify.env, appends a consent event to ~/.forge/notify-consent.log (append-only JSON-lines audit). Sends a final SMS: "forge: subscribed. You'll be notified on workflow completion. Reply STOP to opt out, HELP for help."
3. `forge notify unsubscribe` — clears. Sends "forge: unsubscribed." to current TWILIO_TO, removes from notify.env, logs event.
4. `forge notify status` — shows current subscription, pending confirmation (if any), recent consent events.

**Consent log shape (append-only JSON-lines at ~/.forge/notify-consent.log):**
```
{"event":"subscribe-requested","to":"+15551234567","at":"2026-05-25T17:25:00Z"}
{"event":"subscribe-confirmed","to":"+15551234567","at":"2026-05-25T17:26:30Z","method":"cli-double-opt-in"}
{"event":"unsubscribe","to":"+15551234567","at":"2026-06-01T09:00:00Z"}
```

Append-only so the audit trail can't be silently rewritten. Twilio support can be shown the file directly if they ever ask.

**Storage layout:**
- ~/.forge/notify.env — TWILIO_* env vars (existing). subscribe/unsubscribe write TWILIO_TO here on confirm/unsub.
- ~/.forge/notify-state.json — current subscription + pending confirmation. Mutable, single JSON object.
- ~/.forge/notify-consent.log — JSON-lines append-only audit. Never rewritten, never truncated.

**State transitions:**
- subscribe to a number that's already subscribed → refuse, tell user to unsubscribe first
- subscribe while a different pending confirmation exists → cancel the pending one, start the new flow, log "subscribe-cancelled" for the old
- confirm with wrong code → "invalid code" error, no state change, allow retry within window
- confirm after expiry → "code expired, run subscribe again", no state change
- unsubscribe when not currently subscribed → no-op with informational message

**Out of scope.**
- HELP keyword auto-response (Twilio handles HELP carrier-side for 10DLC).
- Multiple concurrent subscribers (one TWILIO_TO at a time; the env var model is single-recipient).
- Subscription transfer (delete + re-subscribe instead).
- Web UI for subscription management.
- Encryption of the consent log (it's local-machine personal data; filesystem permissions are the boundary).

**Sizing.** Medium. ~150 LoC for consent.ts + state machine + the four subcommands, plus tests for each state transition.

**Caught:** 2026-05-25 conversation about Twilio campaign-approval compliance.


### #143 — Dashboard: per-project label + color on every task card
**Closed:** 2026-05-25. Commit `e84dc63`.

Filed 2026-05-25. As multi-project use grows (post-#138 workspace scoping + #140 dashboard re-merge), the dashboard's cross-project survey surface needs visual project labeling. Today there's none — task cards/rows from different projects look identical, and it gets confusing fast.

**Why filed.** Lived experience: running several projects through forge produces a homogeneous activity feed that doesn't say which project each task belongs to. The data is already populated (queries.ts puts `projectDir` on every ActivityEntry + InFlightEntry); the client just doesn't render it.

**Fix shape (shape 2 from the design conversation — label + color).**

1. **Label.** Show basename of `projectDir` on every card/row (e.g. `forge`, `my-app`). Full `projectDir` shown on hover via title attribute. Empty/null projectDir gets `—` or `(no project)`.

2. **Color.** Each project gets a consistent visual identity:
   - **Preferred source:** read `<projectDir>/.vscode/settings.json` and extract `workbench.colorCustomizations["titleBar.activeBackground"]`. Matches the color the user already assigns to that project's VS Code window for the same purpose (window identification). Reusing the editor color means zero new mental load.
   - **Fallback:** if no .vscode color (file missing, key absent, JSON malformed, or projectDir doesn't exist on disk), hash projectDir → HSL hue with fixed saturation/lightness tuned for legibility against the dashboard's dark background.
   - Cache per projectDir to avoid re-reading on every request.

3. **Where rendered.** Activity feed cards (small badge at top-left of each card). In-flight strip (color stripe on the side, or chip in the corner). Task detail view (header chip with the project name + color).

**Out of scope here.**
- Project filter UI (chip row / dropdown to filter "show only this project"). Worth doing later if label+color alone isn't enough.
- User-overridable project colors (e.g. dashboard-side color config). The .vscode source + hash fallback covers the natural case.
- Reading any other .vscode value (e.g. titleBar.activeForeground for contrast). Just the background for now; the dashboard chooses its own text color for legibility.

**Implementation surface.** Probably ~80 LoC total: a small project-meta helper in `dashboard/src/queries.ts` (or a sibling file) that resolves project metadata (basename + color) with caching, the API response includes it per entry, and `dashboard/client/renderers.js` renders the chip. Tests: file present, file missing, malformed JSON, key absent — verify the color resolution falls back cleanly in each case.

**Caught:** 2026-05-25 in conversation — observation that the feed gets confusing across multiple projects.


### #142 — Twilio SMS notifications on terminal run-state transitions
**Closed:** 2026-05-25. Commit `277279cba7919e86243e9959f8ea112505d9c86a`.

Filed 2026-05-25. Add an opt-in notification surface to forge so the host gets pinged when a workflow finishes (or otherwise stops making autonomous progress).

**Why filed.** Today a forge workflow ends silently. The user has to keep tabs on the orchestrator or refresh the dashboard to know when a run finished. For long-running multi-phase work (architect → plan → build with fanout → verify), that's friction: kick off, walk away, no signal when it's done. A Stop hook in Claude Code is the wrong tool (fires per orchestrator chat turn, not per workflow); the right signal is run-state transitions inside forge.

**Scope (opt-in, off by default).** No notification fires unless `FORGE_NOTIFY=twilio` is set. Provider-specific creds (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`) come from env vars; never stored in `~/.forge/` or committed. Optional `FORGE_NOTIFY_ON=complete,failed,blocked_by_red` overrides the default trigger set.

**Trigger set (defaults).** Three terminal-ish transitions:
1. `runs.status` flips to `complete` — workflow shipped.
2. `runs.status` flips to `abandoned` — workflow died/killed.
3. Any task transitions to `blocked_by_red` — run parked, needs the human.

Excludes `awaiting_gate` by default (would ping during normal gate flow — noisy). Customizable via FORGE_NOTIFY_ON.

**Message format.** Single SMS segment, ~70 chars:
```
forge: run-add-login-7c2a91 [complete] feature "add login" — 14m23s
```
Includes: run id (so `forge show <id>` resolves), state, workflow name + title, duration.

**Verification surface.** New `forge notify test` subcommand — sends a fixed "forge: test message from <hostname>" SMS so users can confirm the path works without waiting for a real workflow.

**Out of scope for this ticket.**
- Other providers (Pushover, ntfy, Slack, etc.). If they're needed later, refactor to a provider abstraction at that time. Single provider today.
- Retry on SMS failure. Log + continue. SMS reliability isn't worth complicating the run path.
- Rate limiting on forge side. Twilio's limits are high; personal use won't hit them.
- Notification for non-forge work (long Claude sessions outside any forge run). Separate concern.

**Sizing.** Small. ~80 LoC for the notify module + the call-site wiring + the test command. Plus the doc.

**Docs.** New `docs/how-to-set-up-notifications.md` (top-level how-to) covering: which env vars to set, how to verify with `forge notify test`, what triggers a notification, how to opt out, troubleshooting. NOT how to set up Twilio itself — users figure that out from Twilio docs.

**Caught:** 2026-05-25 conversation about Claude Code Stop hooks vs. forge-side notification.


### #139 — Wire build-step fanout in feature.yml + teach tech-lead to emit depends_on per plan-step
**Closed:** 2026-05-25. Commit `63b9f61`.

**Why:** The v2 runner has full fanout machinery (see src/v2/runNext.ts dispatchFanoutStep + runFanoutChild — DAG-driven, max_concurrency, failure_mode, per-discipline routing). But the actual feature workflow doesn't use it: \`seeds/workflows/feature.yml\` build step is a single \`engineer\` invocation, no \`fanout:\` block. The infrastructure shipped (closed #96 sub-shifts 3+4+5 absorbed by #116) but the workflow-level wiring + planner support never landed.

**Two-part fix:**

1. **Tech-lead seed update.** Today the planner outputs flat \`steps: [{id, summary, files, acceptance}]\`. For fanout the planner needs to add:
   - \`depends_on: string[]\` (other step ids this step blocks on)
   - \`discipline: "frontend" | "backend" | "infosec" | "platform" | "general"\` (which specialist routes the step)
   - \`files_modified\` must be honest at planning time — multiple containers writing to overlapping files is a race condition the runner can't catch
   
   Updated seed needs an example of dependency-graph shape + a load-bearing note that lying about \`files_modified\` independence breaks the world.

2. **feature.yml build step.** Add a \`fanout:\` block reading the tech-lead's \`steps\` array. Each plan-step becomes one fanout child task. Specialist routing via the discipline field — the runner needs to honor it (today \`dispatchFanoutStep\` calls \`runFanoutChild\` which uses \`step.agent\` from the workflow YAML — needs to be teachable that the discipline value picks the agent per child).

**Open question on shape:** the runner's current fanout assumes one agent per fanout step (you fan one agent across N items). Discipline-driven routing is different — different agents per child based on the child's data. That might need a small runner change (\`fanout.agent_from_input\` or similar). Worth a design pass before just wiring.

**Why this matters:** today the feature workflow's build phase is serial through one engineer agent. Multi-discipline features (frontend + backend + infra in one feature) all funnel through generic engineer, losing the specialist seeds we built. Wiring fanout makes the specialists earn their tokens.

**Sized as:** medium. Tech-lead seed update is small; feature.yml is small; the runner change for discipline-routed fanout is the real work.

**Composite with:** the v2 cutover (#116, closed). This is the unfinished tail.

**Caught:** 2026-05-23 — during quick-fix backlog triage; #96's deeper goal (build-phase decomposition) didn't fully land with v2.


### #140 — Un-split forge-dashboard: re-merge as npm workspace
**Closed:** 2026-05-25. Commit `d148962`.

Reverses #137 (the dashboard split). Filed and closed in the same session (2026-05-24).

**Why reverse.** Two costs surfaced after #137 shipped:
1. **Setup friction.** Multi-project use (the "install once" ergonomic established by #138) required two separate installs — one for forge, one for forge-dashboard. Contradicts the install-once shape.
2. **Schema drift risk.** Dashboard reads forge's SQLite directly. The schema contract was prose, not code. Cross-repo meant any forge schema change could silently break the dashboard at runtime instead of build time.

The original split rationale ("dashboard is separately optional, cross-project survey surface, big rewrite easier in its own repo") is still valid as a logical separation — but the repo split was the wrong axis. npm workspaces give us the logical separation without the operational cost.

**What shipped (commit d148962).**
- `dashboard/` workspace inside the forge repo. Root package.json declares `"workspaces": ["dashboard"]`. Dashboard's only own dep is `marked`; shared devDeps and better-sqlite3 hoist to root node_modules.
- `forge dashboard start [--port N] [--host H]` subcommand. Wraps spawn of tsx against the workspace's src/server.ts; resolves the workspace dir via fileURLToPath walk-up so it works regardless of cwd.
- TypeScript path alias `@forge/types` → forge's src/types/index.ts wired in dashboard/tsconfig.json. dashboard/src/queries.ts re-exports forge's Run/Task types (replacing dead duplicate exports).
- New short dashboard/CLAUDE.md (~30 lines, dashboard-specific) — NOT the standalone repo's CLAUDE.md, which was 100% generic orchestrator block and would have created inconsistency with how forge's own src/ is edited.
- Docs updates: README Dashboard section + intro + Where-things-live table, docs/quick-start.md step 11, docs/SCHEMA-CONTRACT.md top-line note about the merge.

**Honest scope caveats.**
- **Type extraction is largely cosmetic.** queries.ts had dead exports (RunRow/TaskRow/VerdictRow); nothing imported them. Re-exporting forge's Run/Task removes duplication but doesn't add true compile-time drift protection — the inline `as Array<{...}>` row casts in queries.ts still hardcode snake_case column names. Real drift fix requires a single source of truth for SQL schema (typed column-name constants or schema-as-code library); explicitly out of scope, called out in docs/SCHEMA-CONTRACT.md.
- **Dashboard tests still zero.** Out of scope for this ticket.

**Cleanup TODO for the user.**
- Delete ~/code/forge-dashboard/ locally (still present; safe to delete since the workspace works end-to-end and the source remains in GitHub).
- Archive the forge-dashboard GitHub repo (UI action — don't delete; cheap insurance).

**Verification:** 230/230 forge tests pass. Root + dashboard typecheck clean. forge dashboard start boots HTTP 200 on the shell + /api/feed against real data; works from cwd outside the forge repo.


### #138 — forge status is host-global; per-workspace orchestrators see runs from other projects
**Closed:** 2026-05-23. Commit `741e6f2`.

**Why:** Surfaced 2026-05-14 when Steven started a Claude Code orchestrator session in `~/code/audit-workspace` and it (correctly per the orchestrator template) ran `forge status --json` on startup, then picked up two `awaiting_gate` runs that actually belong to `~/code/forge`. The orchestrator's mental model is "I'm the forge orchestrator"; the reality is "I'm an orchestrator for ONE project, but forge state in `~/.forge/forge.db` is host-global."

Same category mismatch we already hit with BACKLOG.md being unscoped. Now for runs.

**Blast radius is small (not a data bug):** the orchestrator can't corrupt anything across workspaces. `forge next <runId>` uses the run's stored `projectDir`, so any dispatch goes to the original project. The worst case is a confused orchestrator wasting context on runs that aren't its responsibility.

**Fix shape (lean):**

1. **`forge status` filters by current workspace by default.** Add `--all` for the cross-project view. Resolves the "orchestrator sees foreign runs" problem at the CLI level — no orchestrator-template logic needed for the default case. ~30 LoC in `src/cli/commands/status.ts` + a filtered query in `src/store/runs.ts`.

2. **Stamp workspace into run metadata at invoke/new time.** Add `--workspace` flag defaulting to `cwd` on `forge invoke` + `forge new`; write to `run.metadata.workspace`. ~20 LoC. `forge status` matches `cwd === run.projectDir OR cwd === run.metadata.workspace` — the second clause handles audit-workspace cases where the orchestrator's workspace ≠ the target repo.

3. **Orchestrator template tweak.** Change the "pick up watching" instruction to: "Only pick up runs whose `projectDir` or `metadata.workspace` matches this workspace. Ignore others." Belt-and-suspenders complement to (1) and (2). ~10 LoC edit to `seeds/orchestrator-template.md`.

4. **Dashboard already does the right thing** (shows all runs intentionally — it's the cross-project survey surface). No change there.

**Sizing:** small fast-follow. Probably one short session for all three pieces.

**Workaround until landed:** tell the orchestrator in conversation "you're the X-workspace orchestrator; ignore runs whose projectDir isn't under this workspace." It listens.

**Caught:** 2026-05-14 — during audit-workspace bring-up.


### #96 — Build-phase decomposition: implementer fanout + orchestrator + planner-emits-deps
**Closed:** 2026-05-23. Commit `post-v2-runner-with-fanout`.

**Sub-shifts 3+4+5 absorbed by #116** (2026-05-13). Forge v2 makes DAG-driven implementation fanout the default model, not an opt-in primitive — planner emits `depends_on` + `discipline` + `files_modified`, runner parallelizes via the DAG, routes per discipline. The sub-shifts below are the v1 framing; if v1 ships them before #116, they're still valuable. If #116 lands first, the v2 implementation makes sub-shifts 3+4+5 moot. Sub-shifts 1+2 (specialist red + implementer seeds, shipped 2026-05-09) survive in both worlds.

**Why:** Today the `build` phase is a monolith — one `implementer` agent reads the plan, edits the codebase serially, produces one diff. That works for tasks small enough to fit in one agent's head, but it doesn't scale: parallel-safe steps run sequentially, the diff balloons until reds can barely review it, and there's no specialization (a frontend feature, a backend migration, and a security hardening pass all route through the same generic seed). Composite of multiple architectural shifts that share a lens — *the build phase needs to decompose into specialized fanout + coordination, the way other multi-phase forge primitives already work*.

The shift has four sub-shifts. **#92 architect-scope rewrite (closed) is the precedent**: same shape — agent role definition matters more than prompt tweaking. **#73 reds-as-reviewer (open)** is also adjacent — both are "the agent has the wrong job description, not just a wrong prompt."

**Sub-shift 1: specialist reds.** *Shipped tonight (foundation).* Three new red seeds (`red-frontend`, `red-backend`, `red-security`) with `gateOnVerdict: false` (informational, doesn't block) attached automatically to the `build` phase across `feature*` workflows alongside the existing `red-wide`/`red-narrow` authoritative reds. RedConfig extended with optional `additional?: AgentRef[]` to support arbitrary specialist reds. Each specialist reviews through its discipline's lens (a11y, transactions, secrets/auth/CSP). This sub-shift unblocks the others — the implementer-fanout and orchestrator can build on a working specialist-red layer.

**Sub-shift 2: specialist implementers.** *Shipped tonight (foundation).* Three new implementer seeds (`frontend-implementer`, `backend-implementer`, `infosec-implementer`) with discipline-specific framing. Original `implementer` stays as the generic fallback for ambiguous work. AgentRef gains optional `discipline?: "frontend" | "backend" | "infosec"` field. **Not yet wired into workflows.** Workflows still use the generic `implementer` for `build`. The seeds exist; the routing decision is part of sub-shift 3.

**Sub-shift 3: implementer fanout.** *Architecturally open.* The `build` phase fans out per plan-step, one specialized implementer container per step, running in parallel where steps are independent. **Hard parts:**
- **Planner emits a dependency graph.** Today the planner outputs `steps: [{id, summary, files, acceptance}]` — flat. For fanout to work, the planner needs to add `dependsOn: string[]` (other step ids) AND `discipline: "frontend" | "backend" | "infosec" | "general"`. Steps with deps wait for their parents. Steps without deps fan out in parallel. Steps without a discipline route to generic `implementer`.
- **Merge conflicts.** Multiple containers writing to the project at the same time is mechanically supported (each container has rw mount), but only safe if the planner correctly identifies file-level independence. Planner has to be honest about what files each step touches. False-negative independence (claiming two steps don't touch the same file when they do) → race condition between containers. The planner's job gets harder; planner seed needs to acknowledge this constraint.
- **Failure semantics.** Existing `fanout.failureMode` field has options (`fail-phase` | `retry-once` | `continue`). Lean `retry-once` for code-build fanout — transient failures get a chance to recover; persistent failures eventually fail-phase. **Continue is dangerous** for code (broken state); fail-phase is too brittle (one flaky red kills the run).
- **Atomicity of "build is done."** Today `build` produces one diff_summary. With fanout, each task produces its own. The synthesis happens... where? Three options worth weighing: (a) a new `merge` phase between `build` and `verify` that reconciles per-task diffs; (b) `build`'s gate-phase aggregates all sub-task results before advancing; (c) accept N diffs and let `verify` check them all together. Lean (a) — the orchestrator (sub-shift 4) is the natural home for this; merge becomes its visible output.

**Sub-shift 4: orchestrator role.** *Architecturally open.* A coordinator agent that lives inside the `build` phase, runs concurrently with the implementer fanout, and handles the gaps-between-containers that mechanical fanout can't. **What only an orchestrator can contribute:**
- **Pre-flight validation.** Receives the planner's step graph, validates feasibility, surfaces planner mistakes ("steps 3 and 7 both modify the same file but aren't marked as dependent — that's a planning bug").
- **In-flight monitoring.** Watches each implementer's progress. Detects stuck containers (no stdout, no result.json after N minutes — see #74). Detects drift (implementer A finished and changed a file that implementer B's plan assumed was static).
- **Conflict resolution.** When two implementers' file changes overlap, decides merge order, possibly re-plans one of them with the other's diff as input.
- **Finalization.** When all sub-tasks complete (or fail), produces the *aggregate* result that gate.ts reviews — diffs combined, failures surfaced, conflicts noted.

**Where the orchestrator lives in the workflow shape — three options:**
- **(a) Orchestrator-as-phase.** New `orchestrate` phase between `plan` and `build`. Reads the plan, decides parallelism, spawns implementer fanout, monitors, finalizes. The phase doesn't end until every implementer is done. *Cleanest workflow-shape-wise but a new primitive — current phases produce a result and exit; an orchestrator phase persists for fanout duration.*
- **(b) Orchestrator-as-meta-agent within `build`.** `build` has fanout=true plus an orchestrator container running in parallel that watches the fanouts. Two agents per phase; new mental model. *Lean (b) — coordinator is genuinely an agent role with judgment, not spine glue. Modeling it as a peer agent within the phase keeps workflow vocabulary clean.*
- **(c) Orchestrator-as-spine-extension.** Build orchestration into the spine itself, no agent. Mechanical-but-smarter. No coordinator-tokens cost. *Limits orchestration to what spine code can pre-program; loses agent's flexibility for novel situations.*

The decision between (a)/(b)/(c) defers to actual fanout-implementer behavior — needs experimental data.

**Why this matters and earns its tokens:**
- Today's "one implementer reads the plan, edits the codebase, produces a diff" works only for tasks that fit in one head. Forge has shipped that scale; the next scale is multi-step features where each step is its own concern.
- The build phase is the bottleneck for any non-trivial feature. Decomposition moves the bottleneck out.
- Specialization composes with fanout: specialist reds review per-step, specialist implementers handle per-discipline work, orchestrator coordinates. Each layer earns its place because the alternative (one generic agent reviewing/writing/coordinating everything) is forge's #92 architecture-tutoring failure mode at scale.
- `red-wide` and `red-narrow` are *probably* due for retirement once specialists are proven, but tonight's wiring keeps them alongside specialists rather than replacing — additive, reversible.

**How to apply (in order, sized for incremental shipment):**
1. *(Tonight, Tier 1.)* Specialist red seeds + specialist implementer seeds + RedConfig.additional + AgentRef.discipline. Workflows wire specialists to build phase, gateOnVerdict: false, parallel: true. Tests confirm registration. **No fanout yet.** Foundation only.
2. *(Future.)* Update planner seed to emit `dependsOn` + `discipline` per step. Existing build phase still runs serially; planner's new fields are additive metadata.
3. *(Future.)* Convert build phase to fanoutFromUpstream on `steps`. New phase shape that fans out per-step into specialized implementers based on discipline. Failure mode: retry-once. Use existing fanout machinery; specialists earn their places per-task instead of per-phase.
4. *(Future.)* Add orchestrator role. Decide (a)/(b)/(c) shape based on what step 3 reveals. Wire into build phase per chosen shape.
5. *(Future, optional.)* Add `merge` phase between `build` and `verify` if step 4's orchestrator produces aggregate output that needs its own gate.

**Composite with #73 (reds-as-reviewer):** both #73 and #96 are "one agent role doesn't earn its tokens because it's doing too much" — #73's reds were reviewing the underlying subject instead of the work-product (vocabulary mismatch); #96's implementer is one generic agent doing every discipline (specialization mismatch). Same lens: define each agent's role by what *only it* can contribute, then split when the lens reveals one agent is doing two jobs.

**Sequencing:** sub-shifts 1+2 ship tonight as foundation. 3+4+5 are daytime architectural conversations + experimental data + structured decisions. Each sub-shift is testable in isolation and reversible.

**Stretch goal worth flagging:** "skip architect" workflow flag. Some feature work (cheap features, refactors, isolated additions) doesn't need an architect phase. Today the workflow shape is fixed; turning architect off requires a new workflow file. Better: a workflow-level flag `phases.skipIf: <condition>`. Defer; architectural framing only.

### #124 — System Map drag-overrides Map grows unbounded across run switches
**Closed:** 2026-05-23. Commit `post-v2-dashboard-split`.

**Why:** Caught 2026-05-13 by red-build-337afd during System Map (#105) red review (severity: low). Module-level `dragOverrides = new Map()` is keyed by runId — opening the System Map on run A, dragging some nodes, closing, opening on run B, repeat — each runId accumulates its own inner Map of `{taskId → {x,y}}` and never gets cleaned up. Across a long dashboard session viewing many runs, the outer Map grows. Functionally fine: entries are tiny objects, no perceptible memory pressure even with hundreds of runs. But it's bounded-by-the-user's-patience, not bounded-by-anything-meaningful.
**How to apply:** A few options worth weighing:
- Cap the Map to N most-recently-used runs (10? 20?) with a simple LRU. Cheap.
- Clear entries on `loadRunDetail` for runs other than the current one. Simpler — only the current run keeps its drag state. Slightly worse UX (switching back to a run you previously organized loses your layout).
- Persist drag positions to DB per-run instead of in-memory. Counter to the explicit "drag-stable per-run-while-viewing only" decision in #105's PRD. Not the right move.
Lean LRU at 10 runs. Caps without forcing UX loss.
**Caught:** 2026-05-13 — red review of System Map build.

### #115 — Dashboard task list middle pane misses task-state transitions (smart-refresh gap)
**Closed:** 2026-05-23. Commit `post-v2-dashboard-split`.

**Why:** Caught 2026-05-12 during the System Map (#105) forge run. Two distinct cases, same underlying gap:

1. **Status transition.** Clicked "Run Next", architect task transitioned pending → running. Task pane (right) showed running correctly; task list (middle) stayed at `pending`.
2. **New downstream task.** Gate-advanced the architect, next-phase task was created via `createPhaseTasks` (gate.ts:120). Task pane reflected the new task; task list (middle) didn't show it until hard refresh.

Both self-correct on Cmd+R. DB state is honest; the middle pane's smart-refresh (#72) is dropping at least two event classes: `task.started` and `task.created`.
**How to apply:** Audit the middle pane's event subscriptions / render trigger. Likely one of:
- Smart-refresh only listens for run-level events (run.created / run.completed), not task lifecycle
- `task.started` + `task.created` events are emitted but the SSE/poll-derived state-update doesn't reach the middle-pane render path
- The middle pane renders from a snapshot computed once at run-open time; subsequent task list changes don't invalidate the snapshot
The two cases share a root cause — the middle pane isn't subscribed to the task-list-changed signal. Fix the subscription, both cases resolve.
**Composite with #77:** exactly the failure mode #77 (Preact + htm) calls out — html.ts hand-rolling reactive primitives, missing edges between event and re-render. Fixing in place is fine; eventually #77 makes this class of bug structurally impossible.
**Caught:** 2026-05-12 — during the #105 forge run.

### #131 — Dashboard CLIENT_JS bundle is stale until process restart; live diffs don't show
**Closed:** 2026-05-23. Commit `post-v2-dashboard-split`.

**Why:** Caught 2026-05-13 during the #127 forge run. Verifier-phase agent navigated to `http://host.docker.internal:8022` (the running host dashboard), found the System Map view still rendering the *pre-diff* red-edge style (solid magenta arrow, opacity 0.7), and correctly noted in its findings: *"the host server process was started before the changes; server restart would pick up the changes, but the code in /project/src/dashboard/html.ts is correct."* It then pivoted to a self-contained synthetic cytoscape render to validate the styles directly.

**Root cause:** The dashboard runs via `tsx` which hot-reloads server-side TypeScript on file change, BUT the dashboard's client-side bundle (`CLIENT_JS` inside `src/dashboard/html.ts` — a giant template literal that gets shipped to the browser) only gets re-evaluated when the server process restarts. Editing `html.ts` updates the file but the running dashboard keeps serving its captured-at-startup version of CLIENT_JS to the browser.

**Why it matters:** This is friction for two distinct workflows:
1. **Pair-coding iteration on the dashboard** — Steven + Claude editing `html.ts`, refreshing the browser, seeing no change, getting confused.
2. **Forge verify-phase visual verification (#128)** — the verifier expects `host.docker.internal:8022` to reflect the diff so it can screenshot the actual rendered result. Today it can't; the verifier has to pivot to synthetic renders (as in the #127 run) or know to restart the dashboard (it can't — different process scope).

**How to apply — options worth weighing:**
1. **File-watcher restart loop.** A small `chokidar`-style watcher in dev that re-imports `html.ts` and restarts the server on `src/dashboard/**.ts` change. Probably 30 lines. Caveat: in-flight HTTP connections drop; for a dev surface that's fine.
2. **Move CLIENT_JS out of the template literal into a separate served-on-each-request file.** The handler reads the file (or imports a fresh module) per request. Slower per request but always-fresh. Probably the cleaner refactor but bigger change.
3. **Document the restart-needed gotcha.** Cheapest. Doesn't help the verify-phase case at all.
4. **Verifier seed update: explicit guidance to use synthetic renders OR restart instruction.** This run's verifier pivoted naturally; codifying it lets future verifiers do it deliberately.

Lean (1) for the dev surface + (4) for the verify-phase case in the short term. (2) is the right long-term shape but it's a real refactor and might be unnecessary if Preact migration (#77) reshapes how the client-side ships.

**Composite with #77 (Preact migration), #128 (verifier render-check).** #77 likely reshapes how the client bundle ships; this might evaporate naturally. #128's verifier seed could note the workaround.

**Caught:** 2026-05-13 — during the verify phase of the #127 forge run.

### #137 — Split the dashboard into its own optional project
**Closed:** 2026-05-14. Commit `1d586ff`.

**Why:** Steven's call 2026-05-14, post-v2-cutover. The dashboard inside the forge monorepo couples release cadence (UI iteration is faster than runner iteration), forces every install to carry ~4K LoC of UI + htmx + server.ts whether they use it or not, and — most importantly — scopes the dashboard to "this project's runs" when it actually wants to be a *user-level tool* that views every forge run across every project on the host. `~/.forge/forge.db` is already host-global; the dashboard just needs to read it directly.

**Target shape:**
```
forge/              (this repo) — CLI + v2 runner + seeds
forge-dashboard/    (new repo)   — web UI; reads ~/.forge/forge.db; shells `forge` for actions
```
Installs separately. Runs as `forge-dashboard` or `npx forge-dashboard` on its own port. Discovers runs from `~/.forge/`; groups by `run.projectDir` for multi-project view.

**Trade you're making:** the SQLite schema + filesystem layout become a contract between the two repos. Today you can change a column + update queries.ts in one PR; after the split, schema changes need to think about dashboard compatibility. Worth paying, but name it.

**Three lock-points before doing the split:**
1. **Schema contract.** Write `docs/SCHEMA-CONTRACT.md` capturing what the dashboard reads from `forge.db` + filesystem (Run/Task/Verdict/Gate/Event tables; `~/.forge/runs/<runId>/<taskId>/{result.json,container.stdout.log,...}`). Once split, that document is the API. Anything outside it is implementation detail forge can change freely.
2. **Pill row first or last?** The current pill row is broken (stubbed from v2 deletion — see #136). Option (a): rebuild in this repo against v2 schema, then split. Option (b): split now with the pill row still stubbed; rebuild it in the new repo as its first feature. **Lean (b)** — splitting is the bigger architectural decision; don't gate it on one feature.
3. **`forge invoke` rendering.** Single-task invokes show up today as run rows with workflow="invoke". The dashboard should keep showing them, but they have no pipeline shape. Decide before split: render as single-pill "task" view, or special-case the layout.

**Not blocking anything else.** v2 ships without it; this is a future arc. Probably comes after #136 (or absorbs it).

**Caught:** 2026-05-14 — during post-v2 reflection on dashboard scope.

### #125 — Implementer seeds don't mention `forge-test`; tests fail mysteriously in build phase
**Closed:** 2026-05-14. Commit `01ca91c`.

**Why:** Caught 2026-05-13 reviewing the System Map (#105) build phase output. The implementer ran `npm test` inside its container, got 203 pass / 143 fail (better-sqlite3 ELF mismatch — host's darwin-arm64 binary doesn't load on container's linux-amd64), and reported them as "pre-existing failures unrelated to this change." On the host they're 345/345 green.

**Root cause:** `seeds/agents/verifier/CLAUDE.md:28-38` documents `forge-test` (the wrapper that rebuilds better-sqlite3 in `/tmp/forge-work` per #111), but **none of the implementer seeds do**. Today's implementer happened to use forge-test for the new targeted test file (it discovered the wrapper somehow) but reverted to `npm test` for the full-suite check. Result: misleading failure numbers in result.json, confused agent narrative, no actual regression.

**Affected seeds:**
- `seeds/agents/implementer/CLAUDE.md`
- `seeds/agents/frontend-implementer/CLAUDE.md`
- `seeds/agents/backend-implementer/CLAUDE.md`
- `seeds/agents/infosec-implementer/CLAUDE.md`

**How to apply:** Copy the forge-test block from `seeds/agents/verifier/CLAUDE.md:23-40` (the "When running tests inside this container" section) into each implementer seed under its own testing guidance. Same language, same examples, same caveat about infra-vs-test failures. Plus an explicit "never run plain `npm test` — always `forge-test`" sentence; explicit-by-prohibition matches how #92 (architect scope) was tightened to good effect.

**Why this is worth doing right now (not waiting for #116):** every build phase between today and v2 hits this same gap. The fix is ~10 lines in 4 files. Low risk, high signal-to-noise improvement in result.json narratives. In v2 (#116), the per-runtime guidance might move to a different place (runtime YAML? per-step task_file?), but the *content* survives — agents need to know about forge-test regardless of how the orchestrator dispatches them.

**Caught:** 2026-05-13 — build phase result.json analysis.

### #136 — Rebuild v2-aware pill row in the dashboard
**Closed:** 2026-05-14. Commit `277ee18`.

**Why:** v2 cutover deleted the v1 Workflow TypeScript type that `buildPhaseShape()` consumed. `src/dashboard/queries.ts` now returns `phaseShape: []` unconditionally; the run page renders zero pills. Task table still works.

**What's needed:** a `buildPhaseShape(workflow: v2.Workflow, tasks: Task[])` against `src/v2/schema`'s Workflow shape. The v1 Phase fields the dashboard consumes are: `name`, `agents[].role`, `gate`, `fanout`, `fanoutFromUpstream`, `reds`. v2's equivalent: `steps[].id`, `steps[].agent`, `steps[].gate`, `steps[].fanout`, `steps[].reds`. Mostly a renaming exercise.

**Composes with #137** — if the dashboard moves to its own repo, this work happens there instead. Decide between them before starting.

**Where to start:** `src/dashboard/phaseShape.ts` (currently stubbed to return `[]`). The old logic lives in git history at `b818f27^` if you want to compare. queries.ts:165 has the TODO marker for the rewrite point.

**Caught:** 2026-05-14 — stubbed deliberately during v2 cutover to ship the rest.

### #135 — Build reds review the wrong artifact (commit metadata, not the diff)
**Closed:** 2026-05-14. Commit `4b67e8a`.

**Why:** Surfaced on `run-smoke-v3-491805` (forge v2's first full real run). The build step's red-wide and red-narrow agents both came back as `inconclusive` because they reviewed the **previous commit** (`b83329f` — the v2 fix commit that pre-dated this run) instead of the engineer's actual diff in `src/cli/index.ts`. The pipeline isn't broken: the architecture sends each red the primary's `result.json` as `artifact`. But the engineer's `result.json` contains a textual *summary* of the diff, not the diff itself.

**Notes from the failing red:** *"Commit claims three fixes: (1) TASK_PACKAGE_MARKDOWN added to SpawnContext ✓ Verified—was missing, now present in both runNext.ts and invoke.ts; (2) Bedrock Haiku model ID fixed ✓ Verified; (3) runMetadata threaded through ✓ Verified. Tests updated (BASE_CTX, spawn.test.ts). All three claimed fix..."* — proves the red verified the *prior* commit, not the engineer's output.

**The fix:** seed update for `red-wide` / `red-narrow` (and probably the discipline reds) — when reviewing a build step's output, the red should:
1. Read the engineer's `files_modified` array from result.json
2. `git diff HEAD` or read each file via the `/project` mount (already there)
3. Review the actual code change, not the engineer's prose summary

**Sequencing:** before the next end-to-end forge run. Easy seed-only change (~5 lines in 2 seed CLAUDE.mds); no code change to the runner.

**Caught:** 2026-05-14 — during forge v2 smoke test post-merge.

### #134 — Gate UX: don't suggest `forge next` when run is complete
**Closed:** 2026-05-14. Commit `4b67e8a`.

**Why:** After gating the terminal step (`verify` in the feature workflow), `forge gate <taskId> advance` still prints `Next: forge next <run-id>` — but the runner already flipped the run to `complete` in `finalizeRunIfDone()`. The follow-up `forge next` would just print "nothing ready to dispatch."

**The fix:** in `src/cli/commands/gate.ts`, after the gate decision, check `getRun(task.runId).status` — if `complete`, print "Run complete." instead of "Next: forge next ...". Trivial (~5 lines).

**Caught:** 2026-05-14 — during forge v2 smoke test post-merge.

### #132 — BACKLOG.md as project state is brittle; fast-follow to v2 with a thin CLI + SQLite-backed storage
**Closed:** 2026-05-14. Commit `1ae5278`.

**Why:** Caught 2026-05-14 during the v2 RACI design pairing. BACKLOG.md is forge's single source of truth for tickets, session notes, and project state. It works today but has structural problems that grow with use:

1. **Unbounded growth.** Already ~57k tokens / ~1700 lines. The orchestrator reads it as orientation on every session start, burning context proportional to file size. Most of that is historical noise (Done-archived entries from months ago).
2. **No native query.** "All tickets touching the dashboard from the last 30 days" requires grep + parse, not query.
3. **Single-writer assumption.** As soon as agents in containers want to file follow-ups (today: the orchestrator does it on their behalf, in conversation), concurrent markdown edits silently conflict.
4. **Tight coupling.** Every consumer (orchestrator, dashboard, future agents) needs to parse 1700 lines of free-form markdown. No stable API.
5. **Brittle to schema drift.** Sticky IDs work because everyone agrees on the format. One bad merge breaks ID parsing across the whole history.

**Steven's call (2026-05-14):** "We may need to revisit BACKLOG.md as the sole source for the project info/issues. Seems brittle and will grow uncontrollably. Eventually we can tap into Jira and/or github issues... not quite yet though (corporate policies)."

**The right shape — two-phase migration:**

**Phase A (fast-follow to v2): thin `forge backlog` CLI over the existing markdown.**
- Commands: `forge backlog list [--status active|done] [--touches <path>]`, `forge backlog show <id>`, `forge backlog file <title> [--body -]`, `forge backlog close <id> [--commit <sha>]`, `forge backlog move <id> <section>`, `forge backlog notes [add|show]`
- The CLI reads/writes BACKLOG.md today, but **callers (orchestrator agent, dashboard, in-container agents) only see the CLI surface**. They don't parse markdown directly.
- Bonus discipline: notes-for-next-session caps at N entries (say 5); older notes archive to `learnings/session-notes/<date>.md`. Done-archived entries get *moved out* to `learnings/done-archived.md` rather than growing inline.
- Buys ~12-24 months before real DB pressure.

**Phase B (when phase A's discipline isn't enough OR when corporate policy unlocks Jira/GitHub):** swap the storage backend.
- Option (i): SQLite-backed. New `tickets` table in `~/.forge/forge.db`. BACKLOG.md becomes a *generated view* — projected from the DB, regenerated on writes, committed for the human-readable artifact. Native query/filter/search. Dashboard gets a "Tickets" view alongside Runs.
- Option (ii): GitHub Issues. Forge becomes a client of the project's GitHub repo's Issues. Sticky IDs become GitHub issue numbers. Pro: zero forge-maintained storage. Con: corporate-blocked today; requires network access at agent-invocation time.
- Option (iii): Jira. Same shape as (ii) but Jira. Same corporate-policy concerns.

**Why the two-phase split matters:** The `forge backlog` CLI surface stays the same across all three Phase-B options. Callers never change. Storage swap is internal. Migration cost = "write the new backend behind the existing CLI."

**What to ship in Phase A specifically:**
1. `src/cli/commands/backlog.ts` with the verbs above
2. A parser for the existing BACKLOG.md format (sections, sticky IDs, frontmatter-free markdown bodies)
3. Discipline-enforcement hooks: notes-cap, done-archived-archival
4. Orchestrator template update: orchestrator uses `forge backlog` commands instead of reading BACKLOG.md whole. (Big context win.)
5. `forge backlog migrate` once we move to phase B — projects existing markdown into the new backend in one shot.

**Composes with v2 cutover (#116):**
- v2's runner + invoke + orchestrator pattern lands first
- This is the **immediate** next architectural lift after v2 — the orchestrator can't be efficient at session start if it's reading 57k tokens of markdown
- Net context-window savings make this almost pay for itself in cost reductions

**Not blocking:** v2 ships with BACKLOG.md-as-markdown; this lands soon after. Don't conflate.

**Caught:** 2026-05-14 — during the v2 RACI design conversation, the "Informed = file" question surfaced that BACKLOG.md was being used as both a notification target AND project state, and neither fits cleanly.

### #116 — Forge v2: YAML-driven orchestrator (cutover complete)
**Closed:** 2026-05-14. Merge commit `b818f27` on `main` (the `yaml-orchestrator-116` branch merge). 23 commits on the branch; net `+1,113 / -6,228` LoC. 279/279 tests passing.

**What landed:**
- **v2 runner core**: schema (Zod) + YAML loader + ready-queue + DAG dispatcher (`src/v2/{schema,loader,ready-queue,inputs,runNext}.ts`). Wave-per-call shape; orchestrator calls `runNext` in a loop. Parallel-within-wave via `Promise.all`.
- **Reds + fanout in the runner**: reds spawn as child tasks after primary completes, verdicts persisted, authoritative-fail blocks via `blocked_by_red`; fanout reads upstream array, spawns N children with `max_concurrency`, applies failure_mode (`fail-phase` / `retry-once` / `continue`).
- **v2 gate**: `src/v2/gate.ts` — marks complete/fail; for reject + on_reject inserts pending in the on_reject step; for request-changes inserts pending in same step. Runner picks up successors via ready-queue (no proactive task creation).
- **`forge invoke`**: single-agent dispatch primitive (`src/v2/invoke.ts`, `src/cli/commands/invoke.ts`). The RACI orchestrator's bread-and-butter. Synchronous; returns when the agent completes.
- **RACI seed** (`seeds/forge-raci.md`): 11 work types, R+A+C+I rows, Path = in-session / invoke / pipeline. Implementation routes through pipeline; everything else through invoke.
- **Orchestrator template** (`seeds/orchestrator-template.md`) rewritten RACI-first: classify prompt → look up RACI → route. Multi-agent composition via chained `forge invoke` in the conversation, not a workflow file.
- **CLI cutover**: `forge new`/`next`/`gate` route to v2. `forge invoke` / `forge upgrade` / `forge init` / `forge watch` added.
- **3 workflow YAMLs**: `feature`, `feature-ui-design-needed`, `feature-ui-design-provided` in `seeds/workflows/`.
- **3 runtime YAMLs**: `claude-bedrock`, `claude-oauth`, `claude-apikey` with `detect` blocks. `runtime: claude` (schema default) auto-resolves via env at spawn time.
- **First real forge v2 run end-to-end** (`run-smoke-v3-491805`): architect → plan → build (engineer + 5 reds parallel) → verify, producing the `forge --version` flag diff committed as `51a3c64`.

**Deletions:**
- `src/spine/` (13 modules) + `src/workflows/` (8 v1 workflows + tests). v1 is gone.
- `forge submit` + submitValidators — ui-design is host-led under RACI; no manual phase needed.
- `reconcile` — orphaned-task safety net; v2 doesn't have one. `forge retry` is the manual escape.
- v1 types: `WorkflowName`, `Workflow`, `Phase`, `AgentRef`, `RedConfig`, `FanoutConfig`.
- Dashboard: 4 obsolete workflow options (investigation, codebase-assessment, ui-design, ui-design-revise) + `/api/submit` endpoint.

**Bugs caught + fixed during smoke testing:**
- `TASK_PACKAGE_MARKDOWN` was missing from `SpawnContext` (runtime YAML expected it via `${TASK_PACKAGE_MARKDOWN}` template).
- Bedrock Haiku model ID was missing the `-v1:0` suffix in `claude-bedrock.yml`.
- Run metadata (`brief`, `question`, `prd`) wasn't being folded into the first task's inputs.

**Model mapping (was inverted at one point during the day):**
- Bedrock `spec-writer` → Sonnet 4.6 (work account; Opus restricted).
- OAuth `spec-writer` → Opus 4.7 (personal Pro account).
- Both `fast-orchestrator` → Haiku 4.5.

**Honest flags:**
- **Reconcile is gone.** If a container produces result.json but Node loses the docker-close event, the task sits in `running` forever. Use `forge retry <id>`. File a v2 reconcile back if the bug shows up.
- **Dashboard pill row stubbed** — tracked as #136. Run page still works (task table fine; no pills).
- **Reds reviewed the wrong artifact on `run-smoke-v3-491805`** — tracked as #135. Architecture is right (red gets primary's result.json as artifact); seed needs to make the red consult `files_modified` + `git diff` rather than the engineer's summary text.

**Composes with:** closes #106 (provider abstraction is now a YAML file). Absorbed #96 sub-shifts 3+4+5 (implementer fanout) into the v2 DAG default model.

### #127 — System Map: red→parent arrows render as dotted tether
**Closed:** 2026-05-13. Shipped via forge feature run on `red-arrow-127` branch (the first forge run that exercised #128 end-to-end). Commit `ec6a519`.

**What landed:** `src/dashboard/html.ts` red-edge style — `line-style: 'dotted'`, `target-arrow-shape: 'none'`, `opacity: 0.4` (was 0.7). Width unchanged at 1.

**Option from the original entry:** option 6 (dotted thin line, no arrowhead, low-opacity magenta tether). Reads as "associated, not flow into" — matches reds-as-side-channel-audit, drops the misleading downstream-consumer connotation.

**Notes on the forge run that produced this:** the architect caught two real gotchas the brief didn't flag — the base edge selector's `target-arrow-shape: 'triangle'` is inherited unless explicitly overridden, and Cytoscape distinguishes `dotted` from `dashed`. Implementer made exactly those three style changes plus the override. First verify-phase run skipped browser-tools (reasoned "small CSS = code, not UI"); second run after the seed tightened invoked browser-tools 22 times and produced a real screenshot — validates both the change and #128 end-to-end. See the #128 Done entry for the seed-copy iteration.

**Co-shipped:** #121 (env-snapshot bedrock auth) commit `8e7306c`. The original run was blocked by stale STS cache under mount-mode auth — fixed by implementing Jeff & Terry's env-snapshot pattern. Originally filed as deferred-to-v2 in the BACKLOG; landed here because it was the actual blocker on this run.

### #121 — Bedrock auth: env-snapshot via aws configure export-credentials
**Closed:** 2026-05-13. Commit `8e7306c`.

**What landed:**
- `src/util/creds.ts` — new `exportAwsCreds(profile)` calls `aws configure export-credentials --profile <p> --format env-no-export` on the host and returns the parsed STS env vars. `FORGE_AWS_CREDS_FOR_TEST` escape hatch for unit tests.
- `src/spine/spawn.ts` — bedrock branch now defaults to env-snapshot: pass `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION` + STS env vars; drop the `~/.aws` mount + `AWS_PROFILE`. `FORGE_AUTH_MODE=mount` reverts to legacy mount-mode as escape hatch.
- Tests updated to assert env-snapshot is default, mount-mode falls back when toggled.

**Why this landed earlier than the BACKLOG planned (v2/#116):** during the first #128 validation run on 2026-05-13, the bedrock-mode container hit `ExpiredToken` even with a freshly-derived STS cache visible inside the container (mtime current, expiry 8h out, file readable). Host-side `aws sts get-caller-identity` succeeded against the same on-disk state at the same instant. Empirically proved the failure-shape #121 described: the container's AWS SDK derivation chain doesn't reproduce the host's. Implementing the env-snapshot path unblocked the run.

**Decision locked:** env-snapshot becomes the default. Mount mode is opt-in via `FORGE_AUTH_MODE=mount` for genuinely long-running containers (>1h, where the 1-hour STS TTL would expire mid-run). FORGE-DEC-013 is overturned in practice; its rationale (STS expiry mid-run) is mitigated by Jeff & Terry's pattern in their 8+ production projects and by the fact that forge tasks typically finish in minutes, not hours.

**Validation:** 355/355 tests pass. The second-attempt #127 forge run completed all phases (architect → plan → build → 5 reds → verify) using env-snapshot auth without further auth incidents. (One red, red-security, starved on what looked like Bedrock concurrent-request limits — separate concern, not auth.)

**Composite:** #117, #118, #119, #120 — these tactical mount-mode diagnostics remain useful only while mount mode exists. Under env-snapshot default, the failure modes they address (watchdog wrong profile, no log, manual `aws sso login` leaves STS stale, shallow auth status) become moot for the common path. Worth revisiting whether they're still worth fixing post-#121.

### #128 — Forge agent containers: bake Chrome, mount browser-tools skill, retire Playwright MCP
**Closed:** 2026-05-13. All five steps shipped + Playwright MCP fully torn down. Container side now uses pi-skills/browser-tools same as host side (#126).

**What landed (forge repo):**
- `docker/agent-dev-worker.Dockerfile` — replaced Playwright Chromium with Chromium-for-Testing via `npx @puppeteer/browsers install chrome@stable`. Added Chromium system deps (`libnss3`, `libgbm1`, etc.). `chmod` and ENTRYPOINT lines for the new entrypoint script. Pre-creates `/home/agent/.claude/skills/` for the bind mount.
- `docker/agent-entrypoint.sh` (new) — starts headless Chromium on `127.0.0.1:9222` in the background, then `exec`s the agent command. `--headless=new --no-sandbox --disable-dev-shm-usage`. `FORGE_NO_BROWSER=1` skips Chrome startup (test escape hatch).
- `docker/build.sh` — pinned image to `--platform linux/amd64`. Chrome doesn't ship Linux/arm64; image runs under Rosetta on Apple Silicon. Trade-off accepted: avoids dragging Playwright back in just for its arm64 bundle.
- `docker/.dockerignore` — allow `agent-entrypoint.sh` into build context.
- `src/spine/spawn.ts` — added `browserToolsDir` to `DockerArgsInput`, `resolveBrowserToolsDir()` resolver (env override via `FORGE_BROWSER_TOOLS_DIR`, default `~/pi-skills/browser-tools`, returns `undefined` when the source doesn't exist). Mount is `-v <dir>:/home/agent/.claude/skills/browser-tools:ro`. Mount is RO regardless of `readOnlyProject` — same invariant as `/design`.
- `src/spine/spawn.test.ts` — 5 new tests covering mount-absent, mount-present, RO-for-blue-agents, resolver-with-bad-path, resolver-with-good-path.
- `seeds/agents/verifier/CLAUDE.md` — new "Visual verification (UI changes)" section telling the verifier to use `browser-tools` when the plan touches UI. Cites the #105 lesson (tests-green ≠ render-correct) directly.

**What did NOT need touching:**
- `red-frontend` seed — reds declare `tools: ["read"]` only. Invoking browser-tools needs bash. Right role boundary: verifier opens the page; reds audit the artifact the implementer produced. Considered, rejected.
- `frontend-implementer` / `red-wide` / `red-narrow` — builder roles or read-only reds, neither needs the render-check invariant.

**Step 5 teardown (host-side, separate from forge repo):**
- Stopped + removed launchd service `com.sgws.playwright-mcp` (plist renamed to `.bak-before-128` in `~/Library/LaunchAgents/`).
- Removed Playwright from 5 project scopes in `~/.claude.json` (forge, forge-design, three OneDrive/obsidian projects). Backup at `~/.claude.json.bak-before-128`.
- Removed `playwright: ref: ""` stub from `~/.docker/mcp/registry.yaml`. Backup at `~/.docker/mcp/registry.yaml.bak-before-128`.
- Memory `reference_playwright_mcp_launchd.md` rewritten as "RETIRED 2026-05-13" with full restore instructions in case revival is ever needed.

**Validation:**
- 354/354 tests pass (5 new for #128).
- Live container test: `docker run` with skill bind mount, watched Chromium start in ~1.5s under Rosetta, ran `browser-screenshot.js` inside container, `docker cp`'d the PNG out, verified it's a valid screenshot (about:blank, 1906 bytes).
- The "still connecting" notice on this session's playwright MCP confirmed teardown took effect; future sessions will not see the playwright tools at all.

**Image size impact:** ~280MB for Chromium-for-Testing + system libs, roughly comparable to the Playwright Chromium that came out. Net wash.

**Open follow-up (lower priority, low scope):**
- **Upstream PR to pi-skills.** `browser-start.js` is Mac-hardcoded; a Linux-aware version (detect Chrome binary from env or PATH) would close the gap. Composes with #129.

**Composite with #116 (forge v2):** v2's runtime YAML inherits a working browser-tools surface to declare per-runtime. The `resolveBrowserToolsDir` + `browserToolsDir` mount pattern is a candidate for "declare this in the runtime YAML, runner translates to docker args."

**Caught:** 2026-05-13 (spun out of #126). **Closed:** 2026-05-13.

### #126 — Replace Playwright MCP with pi-skills browser-tools (host side)
**Closed:** 2026-05-13. **No forge code change** — pure host-side install. Pair-coding surface migrated; forge container side spun out to #128.

**What landed (host side only):**
- Cloned `badlogic/pi-skills` (MIT, https://github.com/badlogic/pi-skills) to `~/pi-skills`.
- `npm install` inside `~/pi-skills/browser-tools/` (puppeteer-core + helpers).
- Symlinked `~/pi-skills/browser-tools` → `~/.claude/skills/browser-tools`.
- Verified end-to-end on the running forge dashboard: `browser-start.js` → `browser-nav.js http://localhost:8022/` → `browser-screenshot.js` → Read returned path. ~3 seconds. No MCP, no transport, no wedge.

**Validations along the way:**
- Skills discovery works in headless `claude --print` mode — the mode forge uses (init message includes `skills:[...]`; bodies load only on invocation). `--add-dir` does NOT install skills; well-known paths only.
- Validated inside `agent-dev-worker:latest` container with the exact docker invocation pattern forge uses today; bedrock auth; skill mounted read-only at `/home/agent/.claude/skills/<name>` discovered and fired correctly. (This is the proof point #128 builds on.)
- Mario's evolution traced: `badlogic/browser-tools` → `badlogic/agent-tools` → **`badlogic/pi-skills`** (current). He migrated from PATH-alias + README to the Anthropic Skills format because it's cross-agent (Claude Code, Codex CLI, Amp, Droid all consume `SKILL.md`).
- Token cost win measured: Playwright MCP = 13.7k tokens per spawn; Chrome DevTools MCP = 18k; Skills format = ~225 tokens (description in init, body loaded only on invoke). Two orders of magnitude.

**Memory updates:**
- New: `reference_pi_skills_browser_tools.md` — install state + pattern shape + iteration loop.
- Updated: `reference_playwright_mcp_launchd.md` — flagged "still live, slated for teardown by #126/#128."

**Spun out:**
- **#128** — container-side migration (bake Linux Chrome, entrypoint, `spawn.ts` mount, seed updates, Playwright MCP teardown). Architecture locked here; that's the build.
- **#129** — shareable pattern future feature ("use Mario's tools from this repo, with a small install dance"); placeholder for when a second consumer appears.

**Caught:** 2026-05-13 during Playwright MCP wedge mid-#105 renderer iteration.

### #105 — System Map view (replaces old graph view)
**Closed:** 2026-05-13. Shipped via the System Map run forge ran on itself + a manual renderer-fix pass against the design frames after red review caught gaps. Commit `5a44588` on `system-map-105`; merged to main as `6a1b6aa`.

**What landed:**
- `src/dashboard/systemMap.ts` — pure `buildTaskGraph(tasks, phaseShape)` emitting nodes with `_fanoutTotal` / `_fanoutComplete` for in-node progress bars, plus three arrow kinds (linear, retry, red). `computeElkLayers` assigns ELK layer hints.
- `src/dashboard/systemMap.test.ts` — 15 unit tests.
- `src/dashboard/html.ts` — modal shell with header/canvas/footer, ELK layout via cytoscape-elk@2.3.0, reds hand-placed vertically in their parent's column post-layout, HTML labels via cytoscape-node-html-label@1.2.1 (auto-registers on cytoscape's core extension API, not a window global), drag-stable per-run via module-level `Map<runId, Map<taskId, {x,y}>>`, filter chips (All / Running / Failed / Pending / Reds), retry arrows arc below the row via bezier control points.
- Old graph view deleted: `graphView.ts`, `graphView.test.ts`, the `buildGraphDataClient` mirror, `openGraphView` / `relayoutGraph` / `expandFanoutPhase` / `collapseFanoutPhase` from CLIENT_JS, the dagre + cytoscape-dagre CDN tags, and the old `.graph-modal-*` CSS.
- `SYSTEM_MAP_STATUS_COLORS` extends the old map with `complete` (was `done` — wrong key, made every complete task render as gray) and adds icon glyphs per TaskStatus.

**Renderer fixes after the agent build phase shipped (red review found these, hand-iterated against design):**
- `_fanoutTotal` / `_fanoutComplete` referenced but never populated by the data layer.
- cytoscape-elk URL was `@1.4.0` (404 — that version doesn't exist on unpkg).
- `done` status key didn't match TaskStatus `complete`.
- nodeHtmlLabel detection used a non-existent `window.cytoscapeNodeHtmlLabel` global.
- ELK partitioning collided reds with downstream phases; switched to ELK-on-main-flow + hand-placement-for-reds.

**Closes:** #102 minimap, #101 side panel (not in the new designs).
**Follow-ups filed:** #115 (smart-refresh task-state gap, hit during this run), #123 (a11y posture), #124 (drag-overrides Map LRU), #125 (implementer seeds + forge-test), #126 (replace Playwright MCP with shell CDP — hit Playwright wedge during renderer iteration), #127 (red→parent arrow semantics — magenta arrow reads as flow when it should read as side-channel).

### #98 — Fanout-collapsed node polish (progress bar + tags) — superseded by System Map
**Closed:** 2026-05-13. The System Map (#105) has no collapsed-vs-expanded mode — every task renders as a peer node always. The "fanout-collapsed-node atom" concept was a v0 graph-view artifact; the new view's running-fanout progress bar is wired through `_fanoutTotal` / `_fanoutComplete` on individual running tasks. Anything left here is genuinely obsolete.

### #114 — Mount designDir read-only at /design inside agent containers
**Closed:** 2026-05-12. Caught preparing the System Map (#105) PRD run: the architect agent in `feature-ui-design-needed` / `feature-ui-design-provided` was being told to "read upstream design artifacts" pointing at host paths that the container had no way to reach. `--design-dir` set `run.metadata.designDir` and `inputs.designDir`, both as host paths — but `spawn.ts` only mounted `/project` and `/task`. The seed instruction to "Read them" was a lie; the architect would have bluffed past it. This was the root cause behind shaping the PRD differently — fixed at the spine layer instead.

**What shipped:**
- `SpawnOptions.designDir` (optional, host path). When set, spawn adds `-v <designDir>:/design:ro`. **Always read-only**, even for blue agents whose `/project` is rw — the design corpus is human-curated via Pencil on the host; agents never write into it.
- `dispatch.ts` reads `run.metadata.designDir` via new `designDirFor(run)` helper and passes through to both `spawn()` (blue) and `spawnRed()` (red).
- `spawnRed.ts` propagates `designDir` to `runOneRed` → `spawn()` so reds reviewing design-adjacent artifacts (frontend, UI architecture) can read the same canonical PNGs/HTML the human approved.
- `seeds/agents/architect/CLAUDE.md` — explicit instruction: design corpus is at `/design` inside the container; translate host paths from `inputs.upstream[*].result.{html,png}Files` and `inputs.designDir` to `/design/<relative>` before reading.
- `seeds/agents/prompt-author/CLAUDE.md` — `inputs.designDir` clarified as **host path**: use it for paths *in the PROMPT.md you produce* (human-on-host Pencil runs that), but for in-container reads (e.g. inspecting existing PNGs per #80) use `/design`.
- Three new buildDockerArgs tests covering: no mount when unset, mount with `:ro` when set, mount stays `:ro` even when `readOnlyProject: false`.

**Forward-only.** Existing seeds had been *telling* agents to read host paths; if any actually tried, the failure was silent (file not found, agent improvises around it). Now the seeds give an honest container path. No DB migration; runs created before #114 simply don't get a `/design` mount (their architects never tried to read from it anyway).

**Out of scope:** rewriting `inputs.designDir` itself to be the container path. That would diverge from `run.metadata.designDir` (which submit and dashboard use as host paths) and force a translation layer for prompt-author (which generates PROMPT.md with host paths for human-on-host execution). Two paths to know about is the right shape: one for human-environment context, one for in-container reads.

349/349 tests passing (was 346, +3). Typecheck green.

### #102, #101 — minimap + side panel closed: not in the designs
**Closed:** 2026-05-12 during System Map design review. The new designs (system-map.png, system-map-fanout.png, system-map-reds-detail.png) don't include either a minimap or a side panel. The designer's call is one view, draggable, no secondary surfaces. If real-run density makes a "where am I" affordance necessary later, file fresh — the old `ycyNE` (minimap) and `UTf00` (side panel) components in the .pen library are stale-but-not-deleted.

### #113 — Promote specialist reds to authoritative (gateOnVerdict: true)
**Closed:** 2026-05-12. Specialist `additional[]` reds (red-frontend / red-backend / red-security) now inherit RedConfig.authority + gateOnVerdict like wide/narrow do. A fail blocks the gate via `blocked_by_red`; override is the existing `--force --rationale` path.

**Shape that shipped:** Path A from the planning conversation — minimal, reversible, no schema change.
- `src/spine/spawnRed.ts` — extracted `buildLaunchPlan(redConfig)` as a pure exported function. All reds in a RedConfig (wide / narrow / additional) get the same authority + countsTowardGate: true. Pre-#113, `additional` was hardcoded `specialist` / countsTowardGate: false.
- `src/types/index.ts` — RedConfig.additional doc comment rewritten to reflect new gating semantics.
- `src/workflows/feature.ts`, `feature-ui-design-needed.ts`, `feature-ui-design-provided.ts` — comments updated; no structural change (RedConfig was already `authority: "authoritative"` + `gateOnVerdict: true`).
- `seeds/agents/red-{frontend,backend,security}/CLAUDE.md` — reworded from "specialist red, informational" to "discipline red, fail blocks the gate." Tone matches red-wide/red-narrow.
- `src/spine/spawnRed.test.ts` — new file, 5 unit tests against `buildLaunchPlan` (inheritance for additional[], specialist-authority workflows still propagate specialist, empty/missing wide-narrow cases).
- `src/workflows/specialistSeeds.test.ts` — assertion flipped from "CLAUDE.md says `gateOnVerdict: false`" to "CLAUDE.md self-identifies as discipline red + says fail blocks the gate."

**Forward-only.** Legacy verdicts in the DB still carry `authority: 'specialist'`; the dashboard's #110 specialist-fail-rationale path remains intact for them. New runs write `authority: 'authoritative'` for discipline reds and trip the `blocked_by_red` + force-advance UI instead. The two paths coexist; no migration.

**What's still load-bearing:** the `RedAuthority` type's `specialist` value, `gate.ts`'s `aggregateVerdicts` specialist-fails branch, and the dashboard's `v.authority === 'specialist'` checks all remain — they handle legacy verdicts and leave room for future non-gating reds (e.g. triage). Cleanup of that branch is a Path B future task, not filed yet because it's only worth doing once legacy verdicts have aged out.

**Verification.** 346/346 tests passing (5 new), typecheck green. Real end-to-end verification needs a feature run where a discipline red fires — first occurrence will exercise the `blocked_by_red` + dashboard force-advance flow.

**Tests of note still asserting old behavior:** the four #110 tests in `gate.test.ts` (`gate=human advance with specialist fail requires rationale`, etc.) still pass because they manually insert verdicts with `authority: 'specialist'` — that path is still real for legacy data, just not how new specialists are recorded. Intentional.

### Active-cleanup pass 2026-05-12 — 8 stale entries closed
End-of-session sweep before a Claude upgrade. Each entry is genuinely dead or shipped:

- **#85 — Graph view as a separate screen.** Parent of all the GRAPH: work that followed. #98 / #100 / #101 / #102 / #103 / #105 all came out of this. The original parent is dead; its children carry the work.
- **#53 — prompt-author agent seed + ui-design template.** Shipped. `seeds/agents/prompt-author/CLAUDE.md` + `seeds/agents/prompt-author/templates/` exist. Validated empirically (note in the original entry confirmed this on 2026-05-07).
- **#45 — `forge auth status` warns on stale bedrock vars.** Functionally shipped by #97 — the dashboard auth-mode popover renders the bedrock token's expiry timestamp + remaining time + amber/red health dot when stale. The original framing (a CLI flag) was made redundant by the always-on indicator.
- **#39 — Audit the spawn → DB pipeline for missing fields.** Meta-task from 2026-05-08 that said "run an audit someday after #32/#38/#27 land." Never materialized into action. If a specific missing field comes up, file that directly; "do an audit" was perpetually-deferrable.
- **#49 — Design-reviewer red agent (future investigation).** Predicated on FORGE-DEC-014-killed assumptions about the in-container designer. Re-evaluate when host-led-Pencil generates evidence worth catching.
- **#50 — React Native code export from Pencil .pen files.** Dependent on the container-designer (#46) that FORGE-DEC-014 killed. Dead-parent → dead-child.
- **#51 + #51b — design-reviewer agent: visual diff implemented UI vs design artifact.** Same FORGE-DEC-014 problem: the artifact pair (`pngFiles` + `htmlFiles`) the agent was supposed to consume comes from the killed `#46` container-designer flow. Worth revisiting once the host-led-Pencil + prompt-author flow has produced a few real design corpora that could feed a different reviewer shape.
- **#52 — Browser DevTools error capture.** Tied to #51's Puppeteer-Core CLI scripts. Same FORGE-DEC-014 dependency. If a forge workflow ever needs "did the page render without errors" as a check, file fresh.

Active dropped from 36 → 28.

### #104 — GRAPH: Rejects + retries design session — superseded by #105
**Closed:** 2026-05-12. Resolved-by-decision rather than work: the rule for the graph view is "render the real workflow — every task, every relationship." That eliminates the design-session framing — there's no separate set of decisions to make. Scope absorbed into #105.

### #99 — GRAPH: retry chains — superseded by #105
**Closed:** 2026-05-12. Was a narrow placeholder ("draw retry edges between failed-and-retried tasks"). The broader rewrite in #105 covers retry chains of any length + reds + every other task relationship, so this entry is no longer the right shape.

### #25 — Validate onReject rationale-propagation end-to-end
**Closed:** 2026-05-12. Legacy entry from 2026-05-07. The original onReject implementation (#25 in archive — `d075f9f`) shipped years ago; this validation follow-up never got prioritized and the world has moved on. Three reasons to close rather than carry:
1. ui-design's review-phase reject path has been exercised in real runs since 2026-05-08 (the `#54`-era prompt-author iterations). If it were broken end-to-end we'd have seen it.
2. The `inputs.rejectedRationale` + `inputs.rejectedTaskId` propagation is unit-tested in `src/spine/gate.test.ts` ("gate reject on a review task triggers onReject and creates a brief task with rejectedRationale").
3. The bigger reject-UX question — letting the human pick WHICH phase to loop back to — is captured by #93, which is the live ticket. #25's validation framing is subsumed there.

### #91 — Reconcile bypasses gate=human on recovery
**Closed:** 2026-05-12 on commit `91f9e17`. **First end-to-end forge feature run that landed real spine code on forge itself.** Architect agent caught two material errors in the original brief (the fix needed to branch on `gate !== "auto"` not `gate === "human"` to also cover `gate: "verdict"`; and needed `markTaskAwaitingGate` not bare `setTaskStatus` to preserve the result payload for human review). Shipped fix:
- `src/spine/reconcile.ts`: orphan blue recovery now branches on phase.gate — `auto` → `markTaskComplete`, otherwise → `markTaskAwaitingGate`. Red-task path unchanged (guarded by `!task.parentId`).
- 3 new tests cover gate=auto, gate=human, gate=verdict paths; 2 pre-existing tests fixed to pin `gate: "auto"` so they actually exercise the auto branch (they were silently relying on the old broken behavior).
**Item 3 (reds-during-reconcile)** split out as #107 — separate design question.

### #100 — GRAPH: fanout layout broken
**Closed:** 2026-05-11 on branch `graph-view-85` → merged to main as part of `ed7e8c5`. Three failure modes from the original capture (overlap, gap, edge-cut) resolved by shipping Hypothesis C — flat-node model, no cytoscape compound parents. Children of an expanded fanout phase are top-level peer nodes; dagre handles parallel ranks natively. Plus curved edges (`unbundled-bezier`) so the graph reads as flow not org-chart, plus failed children rendered as dead-ends (no outgoing edge to next phase) matching real workflow semantics. Original WIP (compound nodes + grid sub-layout) is gone.

### #97 — Auth-mode indicator in the dashboard chrome
**Closed:** 2026-05-11/12 across `0c58d65`, `5d4580e`, `d92c32f`, `81e0193`, `0748752`, `73b0bb8`, `2c1e6b4`, `487da9f`, `c39643c`. Shipped:
- Read-only indicator under the FORGE wordmark in the sidebar. Single line of geist-mono: `● {mode} · {identity}` with the dot color-coded by health (green/amber/red).
- Click opens a popover with mode-specific detail. Bedrock shows profile, account, role, region, SSO portal, token expiry + remaining time, watchdog status. OAuth shows account email, organization, plan tier, login date (sourced from a host-side hint cache populated by `forge auth login`). Apikey is intentionally bare — leaking key prefixes/suffixes was a security concern.
- Polled every 60s; SSO-expires-mid-session auto-surfaces without a dashboard restart.
- AWS_PROFILE env var alone now triggers bedrock auto-detect (no need to set CLAUDE_CODE_USE_BEDROCK=1). Migrated the OAuth volume mount from `/home/agent/.claude` to `/home/agent` so `.claude.json` (account info) is captured alongside `.credentials.json` (token); volume name bumped to `forge-claude-oauth-v2`.
- Async-loaded Google Fonts via media-swap so a blocked `fonts.googleapis.com` (corp proxies) doesn't freeze paint.

### #79 — Auto-detect bedrock + pre-flight check
**Closed:** 2026-05-11/12 across `f3d2d76`, `8f1c464`, `7ab5231`. Shipped:
- `detectCredsMode()` auto-detects bedrock when AWS_PROFILE is set or when `~/.aws/config` has SSO configured for the active profile. `CLAUDE_CODE_USE_BEDROCK=0` is the hard-off override.
- Pre-flight validation at both `forge new` and `forge next` — bedrock SSO cache freshness check, apikey env-var presence check. Dashboard's POST routes auth errors via `AUTH_ERROR_PREFIX` to a 400 toast, not a generic 500.
- New helpers: `resolveAwsProfile()` (defaults to "default"), `resolveAwsRegion()` (defaults to us-east-1), `hasAwsSsoConfigured()`, `hasFreshSsoCache()`, `hasAnyAwsSsoProfile()`.
- 19+ new tests in `creds.test.ts` covering every detector branch.

### #109 — Transactional reconcile writes
**Closed:** 2026-05-12 on branch `transactional-writes-109` → merged to main. Test suite 341/341 (+3 reconcile tests). Scoped to reconcile only; dispatch + gate split out to #112.
- `src/spine/reconcile.ts`: per-task write batch wrapped in `getDb().transaction(...)`. Rollback on throw leaves the task in `running`; the next reconcile call re-attempts cleanly. Catch logs to stderr (not the DB — the failure may itself be a DB write failure).
- Added a test-only `_setReconcileFaultForTest(step, error)` hook + named fault points (`after-mark-blue`, `after-log-completed`, `after-insert-verdict`, `after-log-verdict`). Lets fault-injection tests verify rollback without monkey-patching the store module.
- 3 new tests: rollback on mid-sequence fault (after mark-blue) + rollback of both writes (verdict insert + parent transition) + retry-pin (subsequent reconcile succeeds).
**Unblocked by #111** — needed in-container test runs to do fault-injection work end-to-end.

### #103 — GRAPH: top-bar run-status pill
**Closed:** 2026-05-12 on branch `graph-status-pill-103` → merged to main. Suite at 338/338 (no test deltas — single-span chrome addition).
- `src/dashboard/html.ts`: graph-modal-header gains a `.badge.status-<run.status>` span between the title and the close button. Reuses `rowDisplayStatus()` so `active` renders as "running" consistent with the sidebar run-row badge. Migrated `margin-left:auto` from `.graph-modal-close` to the new badge so both stay flush-right.
**Live-verified** in the dashboard against a complete run; green-dot "complete" badge renders cleanly.

### #110 — Require rationale when advancing over a failed specialist red
**Closed:** 2026-05-12 on branch `rationale-on-red-fail-110` → merged to main. Test suite 338/338 (+5 gate tests). Two-layer fix:
- **Spine (`src/spine/gate.ts`):** specialist-fail-rationale check now applies to ANY gate type, not just verdict-gated phases. Previously a `gate: "human"` task with a failed specialist red could be advanced with no rationale at all — zero audit trail of the override. Authoritative-red protection (via the `blocked_by_red` status path) was already correct for all gate types and is unchanged.
- **Dashboard (`src/dashboard/html.ts`):** gateActionsSection computes `advanceRequiresRationale` from the verdict list. When true: specialist red verdict cards are surfaced (same `redVerdictCard` used for `blocked_by_red`); helper text + textarea placeholder shift to "required to advance over the specialist red(s) above"; the Advance button becomes `⚠ Advance over red(s)` in btn-warning styling and passes `requireRationale: true`, triggering doGate's existing client-side toast on empty submission.
- 5 new gate tests cover both gate types (human, verdict), happy/empty/forced paths.
**Live-verified** by flipping `task-build-aa57f1` (the #91 build with a real red-backend specialist fail at 0.85) back to `awaiting_gate`, opening the dashboard, confirming the rendering + the empty-rationale toast + the non-empty-rationale path.

### #108 — Dashboard: gate-advance auto-dispatches the next phase
**Closed:** 2026-05-12 on branch `auto-dispatch-108` → merged to main. Test suite at 333/333 (+5 server tests). Shipped:
- `src/dashboard/server.ts`: `handleGate` chains into `forge next` after a successful `advance`. Skips the chain on reject/request-changes and on already-complete runs. Auth errors from the chained dispatch route to 400; other dispatch errors to 500 with a clear "Advanced X but dispatch failed" prefix. Response gains optional `dispatched: true` + `dispatchSummary` so the dashboard toast can confirm both halves happened.
- `src/dashboard/server.test.ts`: 5 new tests covering happy chain, reject doesn't chain, complete-run doesn't chain, dispatch failure → 500, dispatch auth error → 400.
- CLI behavior unchanged (`forge gate` still prints "Next: forge next ..." and exits). The chain is dashboard-only convenience, preserving CLI composability.

### #111 — Verify phase blocked by native-module mismatch
**Closed:** 2026-05-12 on branch `verify-container-111` → merged to main as `da06410`. Test suite 328/328 passes inside the agent container, matching host. Shipped:
- `docker/forge-test.sh`: wrapper that copies `/project` to `/tmp/forge-work`, rebuilds `better-sqlite3` for the container platform, runs tests there. ~30s overhead per container; host's `/project` is never mutated (works under `:ro` mount too — reds can now run tests).
- `docker/agent-dev-worker.Dockerfile`: bakes the wrapper at `/usr/local/bin/forge-test`. `build-essential` + `python3` were already present so no other prereqs needed.
- `docker/.dockerignore`: allows `forge-test.sh` into the build context.
- `seeds/agents/verifier/CLAUDE.md`: documents `forge-test` usage and the platform-mismatch rationale, replacing the previous "agent figures out testing" looseness that produced #91's diagnostic-only verify behavior.
**Approach taken:** option 1 from the original entry (rebuild in container) — chosen over per-platform `node_modules` volumes (option 2) or swapping the SQLite binding (option 3). Cost: ~30s per container, acceptable.
**Unblocks:** #109 (transactional reconcile + fault-injection tests).

### #95 — Copy-id button next to run name in run-detail header
**Closed:** 2026-05-09 overnight, on branch `graph-view-85` (251 tests, no test deltas — pure UI).
- `src/dashboard/html.ts`: middle-pane run-detail header now renders `<run-id> [copy] [status-badge]`. Reuses the existing `copy` class + `copyText` helper. Mirrors the task-id copy pattern in `taskHeaderSection` (#78).
- Sidebar rows kept tooltip-only — too cramped for an inline button.

### #92 — Architect seed rewrite (systems-architect, not implementation-tutor)
**Closed:** 2026-05-09 morning, on branch `graph-view-85` (233 tests passing — seed-only change, no test deltas).
- `seeds/agents/architect/CLAUDE.md` rewritten. Role reframed to "surface what makes a feature hard/slow/expensive/impossible; decide where logic lives, who owns what state, what's authoritative for what." Explicit anti-pattern list: don't pick type names, function names, file paths, or "do X this way when both are valid." Worked example contrasting bad output (the actual line-level outputs from task-architect-c29474) against good output (boundary-risk + scaling + workflow-as-source-of-truth + prior-art references).
- New output schema: `{risks, constraints, boundaries, priorArt, openQuestions, notes}`. Empty arrays explicitly OK — "five real entries beat fifteen padded ones." Each entry should cite real evidence (file paths, real risks).
- Test for the architect's output earning its tokens: does any entry reference something the implementer wouldn't naturally see from inside the code? If not, the run was waste.
- Three workflow files updated to point at the new schema: `feature.ts`, `feature-ui-design-needed.ts`, `feature-ui-design-provided.ts`. Each `workflowAdditions` string mentions the new field set + reminds the agent that this is NOT implementation guidance.
- Dashboard `workflowSchema.ts` brief-field help copy updated.
- Reinstalled via `FORCE=1 install-seeds.sh`.
- Composite with #73 (reds-as-reviewer): same shape of category mistake — wrong job description. #73 still open as an architectural call.

### #83 — PROMPT.md template: count existing PNGs, use max+1 as starting number
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — seed-only change, no test deltas).
- `seeds/agents/prompt-author/templates/ui-design.md`: new PRECONDITION 2 step counts existing PNGs in `{{output_dir}}` (using `ls *.png | wc -l`), sets `START_NUM` accordingly. Step 6 (PNG NAMING) updated to use `$(printf "%02d" $START_NUM)` etc. instead of hardcoded 01/02. Empty/non-existent directory → `START_NUM=1` → numbering starts at `01-` as before.
- `{{file_naming_list}}` is now a list of suggested screen names, not a list of literal filenames — the prefix is computed at run time from the corpus state.
- Reinstalled via `FORCE=1 scripts/install-seeds.sh`. Active in `~/.forge/agents/prompt-author/templates/`.
- Unblocks shared-corpus reuse (#67) where prior runs already produced PNGs 01-N. Without this, the template hardcoded 01 and would clobber.
- Long-term fix (#80) still pending — prompt-author should mount designDir read-only and bake the start number into PROMPT.md at author time. Different code path; this template-level fix ships value now.

### #75 — Dashboard: markdown rendering for prose result fields
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- New `looksLikeMarkdown(s)` heuristic in html.ts: triggers on at least one structural marker — heading line (`^#{1,6}\s`), triple-backtick fence (`^```), or two-or-more list-marker lines. Inline markers (bold, links) alone don't trigger; ordinary prose with one **bold** word stays plain.
- New `renderMarkdown(src)` walks lines and emits structured DOM: fenced code blocks (`<pre><code>`), headings (h3-h6 to avoid clashing with `.result-field-label` h3 above), ordered + unordered lists, paragraphs that gather consecutive non-structural lines.
- New `renderInline(s)` handles inline: HTML-escape input, then `**bold**`, `*em*`, `` `code` ``, `[text](url)` for http(s) + relative anchors. javascript: links explicitly rejected — anchor href regex requires `https?://` or `#` start. XSS-safe: input is escapeHtml'd before any markdown patterns are applied.
- Wired into `renderResultValue` — string values that pass the markdown heuristic go through `renderMarkdown`; everything else falls through to the existing paragraph treatment. Paths still get the `<code>` path treatment first (no regression).
- Backticks throughout (in regex source + comments) escaped via `\\u0060` because the entire CLIENT_JS lives inside a TS template literal where raw backticks would close the literal early.
- Pretty/raw toggle (#34) unchanged — raw mode keeps showing the source markdown.

### #64 — Sidebar widened to 320px + tooltips on truncated run ids
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- `#app` `grid-template-columns` bumped from `280px 360px 1fr` to `320px 360px 1fr`. Common kebab-cased run ids (`run-test-prompt-author-v3-da7d57`, ~32 chars) stop truncating in the sidebar.
- Sidebar runRow now carries `title="<full id> — <title>"`, hoverable for the full id even when wider names truncate.
- Run-pane breadcrumb shortId span carries `title="<full id>"` for the same reason.
- Draggable resizers (option a from BACKLOG #64) deferred — option b shipped as a 10-line fallback.

### #62 + #63 — Human-led gate copy fork + fresh-session warning
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- **#62 (gate copy fork):** `gateActionsSection` reads `phaseShape` to detect human-led phases (`isManual: true`). Three button-shape branches now: blocked-by-red (existing), human-led (new), agent-led (existing). Human-led branch shows two buttons — "✓ I've done the work" + "✕ I've decided not to do this" — and skips the request-changes middle option (which gate.ts rejects on manual phases anyway because there's no agent to re-dispatch). Rationale label changes to "Notes — optional on confirm, required on send-back / stop." Same primitive, different verbs.
- **#63 (fresh-session warning):** awaiting_gate brief tasks now render a yellow warn alert above the rationale: "⚡ Run the PROMPT.md in a fresh Claude Code session before approving. Don't paste into a session already mid-task — long structured prompts can silently drop trailing sections when the running session compacts mid-run." Caught 2026-05-08 during FOLLOWUP-PROMPT.md run.
- Detail render-key already includes the slim phaseShape signal from #71, so this picks up phaseFilter changes naturally.
- New `findPhaseShape(phaseName)` helper looks up the phase in `state.runDetail.phaseShape` (also useful to future copy/icon variants).

### #76 — Elapsed-time cells tick once per second (smart-refresh side-effect)
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing — pure UI, no test deltas).
- `src/dashboard/html.ts`: new `liveDurationSpan(extraClass, startIso, endIso)` helper that emits a `<span>` carrying `data-elapsed-started-at` + (when set) `data-elapsed-completed-at` attributes. New `tickElapsedCells` walks `[data-elapsed-started-at]` once per second and rewrites `textContent` only when `completedAt` is missing — no DOM identity churn, no scroll/focus/input disruption, smart-refresh keys (#72) untouched.
- New `startElapsedTicker` kicks off a single `setInterval(tickElapsedCells, 1000)` from `bootstrap`. Idempotent — second call is a no-op.
- Three call sites converted: run-pane DURATION (run-meta-strip), task-row trailing elapsed cell (row-side), and the task-detail ELAPSED row in `taskHeaderSection`. All three update live without polling.
- Pattern is reusable for any future once-per-second cell (countdowns, freshness indicators).

### #94 — Retry button suppressed on tasks failed via gate-reject
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing, +3 new).
- `src/dashboard/queries.ts`: `getTaskDetail` returns a derived `failureMode: 'rejected' | 'crashed_or_agent_error' | undefined` field. Rejected = task is failed AND has at least one gate row with `decision='reject'`. `crashed_or_agent_error` covers everything else (container crash, agent error, validation failure, watchdog kill). undefined for non-failed tasks.
- `src/dashboard/html.ts`: failed-task rendering branches on `failureMode === 'rejected'`. The retry section is suppressed on rejected. Banner copy clarifies — "Task was rejected at the gate. Retry would re-run the same agent..." vs the original crash banner.
- Detail render-key (#72) includes `failureMode` so the retry section flips correctly when a gate-reject lands.
- 3 new queries.test cases: rejected, crashed, undefined-on-non-failed.

### #89 — Drop FORGE_DASHBOARD_INTERACTIVE feature flag (always on)
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (228 tests passing — net -5 vs post-#71's 233 because the 4× "503 when not interactive" tests + the meta-default-false test became obsolete and got dropped).
- `src/dashboard/server.ts`: dropped `isInteractive()`, dropped the 503 read-only branch in `handlePost`. `/api/meta` returns `{ interactive: true }` unconditionally for backwards compat with any browser tab still loaded from before this change.
- `src/dashboard/html.ts`: dropped `renderReadOnlyNewRun` + every `if (!state.interactive)` branch (retryActionsSection, submitActionsSection, gateActionsSection, openNewRunModal, sidebar's "+ New run" button). `state.interactive` field stays on the state object but is fixed at `true` — kept as a noop because it participates in the smart-refresh keys (#72) and ripping it out of every key would be a larger churn for zero functional gain.
- `src/dashboard/server.test.ts`: removed the 5 obsolete tests + the env-var setup/teardown lines that were noops post-flag.
- CSRF header check (`X-Forge-Request: 1`) stays — the actual defense against drive-by browser POSTs.
- No documentation changes needed; the README + docs didn't mention the flag.

### #71 — Dashboard: phase pill row + advance-preview line
**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (233 tests passing, +15 new).
**What shipped:**
- **Server: `src/dashboard/phaseShape.ts`** — pure helper that builds a `PhaseShape[]` from a `Workflow` + the run's tasks. Per-phase: `name`, `agentRoles`, `gate`, `isManual`, `hasFanout`, `fanoutConcurrency`, `fanoutFromUpstream`, `hasReds`, `redsAuthority`, `redsGateOnVerdict`, `onReject`, plus dynamic `status` (attention-ranked) + `taskCounts` + `fanoutDots` (per-task status array for fanout phases, in creation order). Excludes red-prefixed agentRole tasks from phase aggregates — reds don't pull a phase back to running once their blue is done.
- **Server: `getRunWithShouldPoll` is now async** and returns `phaseShape: PhaseShape[]`. Loaded via `loadWorkflow(run.workflow)` per request — workflow files are TS imports already cached by Node, so the cost is one Map lookup. Tolerates unknown workflow names (e.g. legacy runs after a rename) by returning an empty phaseShape rather than 500. Updated `server.ts` and the existing `queries.test.ts` for the async signature.
- **Client: pill row above the task list.** New CSS classes for phase pills (status-coded background + border; 7 statuses match the design's status key: pending, done, running, awaiting_gate, awaiting_human_input, awaiting_red, blocked_by_red/failed). Each pill: gate icon (👤 manual / ⚡ agent), phase name, gate-type sub-label (◎ human / ⚡ auto / ⚖ verdict), trailing ✓ when done, trailing colored dot when phase has reds (red for authoritative, warning for specialist). Fanout pills expand to show a row of small colored dots (one per task) + a summary like "×4 running" / "16/20 done · 4 failed". Click a pill toggles `state.phaseFilter`; the task list filters to that phase + a clearable chip appears in the TASKS header.
- **Client: `describeAdvanceConsequence(currentTask)` advance-preview.** Italicized one-line summary rendered below the gate-actions row on awaiting_gate detail. Four flavors: (1) terminal — "Advancing also finalizes the run."; (2) human-led next-phase — "Advancing puts this run into awaiting_human_input. You'll need to run the PROMPT.md..."; (3) fanout next-phase — "Advancing creates 16 investigate tasks (one per claim from frame-question), running 4 at a time. Reds: specialist."; (4) plain agent — "Advancing dispatches the architect phase (architect). Reds: specialist." Reads the upstream task's `result[arrayKey]` to surface the actual fanout count when the phase is fanout-from-upstream.
- **Smart-refresh integration:** middle render-key now includes `phaseShape` (slimmed) + `state.phaseFilter`. Detail render-key includes `phaseShape` so the advance-preview line refreshes when the next-phase shape changes. `selectRun` clears `phaseFilter`.
- **Tests:** 13 new in `phaseShape.test.ts` (linear / fanout / reds / status aggregation / red-prefixed exclusion / fanoutConcurrency / fanoutFromUpstream / onReject); 1 new in `queries.test.ts` (phaseShape returned). +2 from prior counts elsewhere = 233 passing total (was 218 at start of session).
- **Smoke:** spun up the dashboard against `~/.forge/forge.db` and inspected `/api/runs/<id>` for both an investigation run (4 phases, fanout dots = 21-task strip) and the abandoned phase-flow run (6 phases, mix of done/failed/pending with reds on architect+build). PhaseShape builds correctly across both. HTML payload includes 56 hits for the new CSS classes — the styles + render code shipped to client.
**Designs referenced:** `~/code/forge-design/designs/21-phase-pill-row-linear.png`, `22-phase-pill-row-fanout.png`, `23-gate-panel-advance-preview.png`, `26-run-pane-composite.png`. Visual review still pending — Steven gates the corpus-consistency pass (#88) on his eyeballs first.
**Out-of-scope by design:**
- **Drill-in pane on fanout-pill click (granularity 3 from the BACKLOG entry).** Punted; existing task-list filtering is the v1 drill-in.
- **Sankey/DAG view (#85).** Different surface; the BACKLOG entry is explicit about lands-after-#71.

### #46, #47, #48 — closed earlier, retroactively recorded
- **#46** (Designer agent + Pencil integration) — SUPERSEDED by FORGE-DEC-014, container-based v1 abandoned. Cleanup landed under #58 (commits `d15e741`, `a9d1b1e`, `40fe81b` on `designer-agent-46`, merged into main as `e744e18`).
- **#47** — renumbered as #60 (host-side secret storage via `pass`). Original framing was PENCIL_CLI_KEY-in-containers; container designer is dead so the secret-storage need shifts.
- **#48** (Dashboard support for design review) — substance landed in #57 (interactive dashboard v1) and #54 (manual-phase ui-review with artifact-path render). Image preview deferred — needs `/api/artifact?path=...` passthrough endpoint.

### #35, #36, #37, #38, #40, #41, #43, #44 — closed earlier, retroactively recorded
- **#35** (Dashboard gate buttons + run-next + what's-next surfacing) — closed by `interactive-dashboard-57` merge (`a8e1b0f`) shipping the v1 interactive dashboard.
- **#36** (project_dir on runs table) — closed `4c216a0`.
- **#37** (`forge advise` command) — closed `23797fa`.
- **#38** (capture agent_alias + agent_model on tasks) — closed `91de39d`.
- **#40** (`forge gate <run-id> advance --all`) — closed `756dcde`.
- **#41** (auto-finalize run when terminal phase auto-gates) — closed `9201bc2`. Plus a follow-up fix for the human-gate-on-terminal-advance path (closed `09889cf`).
- **#43** (three-pane CSS layout) — closed by the dashboard reskin in `interactive-dashboard-57` (commit `65eaae3`, merged as `a8e1b0f`).
- **#44** (npm test glob portability) — closed `4ab9c17`.



### #82 — `forge submit` validator: glob `*.pen` instead of fixed filename
**Closed:** 2026-05-08 evening, on branch `phase-flow-71` (218 tests passing, +2 new).
- `submitValidators.ts` no longer derives the .pen filename from `basename(designDir)`. Now it `readdirSync(designDir).filter(f => f.endsWith('.pen'))` — exactly one matches → use it; zero → "No .pen file found, did Pencil save?"; multiple → "Multiple .pen files found: <list>; move/delete extras and re-submit."
- The non-zero size check still applies (catches Pencil-saved-empty-file failure mode).
- Fix unblocks shared-corpus reuse (#67) where the .pen filename is meaningful (e.g. `dashboard.pen`) rather than derived from the directory name.
- New tests: "designDir doesn't exist" + "multiple .pen files" + "any .pen filename works." Existing test for "throws on missing .pen" updated to the new error message; existing "basename-not-title" test rewritten as "any-filename-works" to pin the new contract.
**Caught:** 2026-05-08 — the phase-flow run had `dashboard.pen` (the existing dashboard corpus) but submit was looking for `forge-design.pen` (basename of designDir). Hard-error every time without manual rename or env-var hack.

### #78 — `forge retry` + dashboard retry button (insert-new shape, audit-preserving)
**Closed:** 2026-05-08 evening, on branch `phase-flow-71` (216 tests passing, +13 new).
- **Audit-preserving shape (Steven's call mid-implementation):** retry doesn't mutate the failed task in place — it creates a *new* task row with a fresh id, same phase/role/inputs/agentAlias/agentModel, `parentId` pointing at the failed one, status `pending`. The original stays `failed` forever as the audit record. Mirrors `request-changes` semantics in gate.ts. Cascading retries form a walkable chain via parentId.
- New `src/spine/retry.ts`: `retry(taskId)` returns `{task, newTask}`. Status guard: only operates on `failed`. Logs `task.retried` event with `newTaskId` + `previousError` for audit.
- New CLI: `forge retry <task-id>`. Prints both ids (failed + new pending).
- New POST endpoint `/api/retry/:taskId` shells out to `bin/forge retry` per FORGE-DEC-015. CSRF + interactive gates apply.
- Dashboard:
  - Failed tasks show an alert banner with the error + a "↻ Retry task" button in a new section above the inputs.
  - `taskHeaderSection` renders `RETRY OF <id>` (when current task has a same-phase non-red parent) and `RETRIED AS <id>, ...` (when same-phase non-red children exist with this task's id as parentId). Clickable — selectTask navigates the chain.
  - Smart-refresh detail key includes a "chain signal" (parent + child statuses) so retry-creating-a-new-row triggers a re-render even though `td.task` itself didn't change.
- 13 new tests across spine + server. Spine tests cover: original-stays-failed, new-pending-with-parentId, inheritance of phase/role/inputs/model, fresh composedSystemPrompt slot, cascading chain, both rows persist.
**Caught:** 2026-05-08 — `task-brief-6cc6ca` failed with AWS auth expiry. First fix was mutate-in-place; mid-review Steven called out that audit history should be preserved. Insert-new is the right shape.
**Out-of-scope:** rerun-on-complete (different semantics — user wants a different result from same inputs; needs design before implementing).

### #70 — Workflow rename refactor + composed feature-ui-design-needed + awaiting_red status
**Closed:** 2026-05-08 evening, on branch `workflow-rename-70` (203 tests passing).
**What shipped:**
- **Renames** (disambiguating "design" — was overloading system-architecture and UI/UX):
  - `feature-design-needed` → `feature` (the no-UI variant; CLI / API / library / refactor work)
  - `feature-design-provided` → `feature-ui-design-provided` (added architect phase at front; was missing — Steven 2026-05-08: architecture review is universal across feature work)
  - `design-revise` → `ui-design-revise` (new file; the old design-revise.ts was already deleted under #58)
  - `investigation.frame` phase → `frame-question` (was ambiguous in dashboard rendering)
  - `ui-design.review` phase → `ui-review` (consistency with composed workflow)
- **New workflow file:** `feature-ui-design-needed` — composed shape: brief → ui-review → architect → plan → build → verify. Mixes manual + agent + reds + onReject branching. Forge's most complex workflow shape. The architect's onReject loops back to `brief` (revise the design first per Steven Q2).
- **FORGE-DEC-017 + new task status `awaiting_red`** — honest vocabulary for "blue done, reds running, gate not yet decided." Was being collapsed into `complete` which was a lie. Wired through dispatch.ts (sets status), next.ts (surfaces kind), advise.ts (informational, ranks after running), reconcile.ts (skips), CLI status icon (⏵), dashboard badge tone + sort rank (peer of running).
- **Architect seed updated** — reads `inputs.upstream[*].result.{htmlFiles,pngFiles}` when present; treats the design as canonical UI; surfaces design/code conflicts as architectural decisions. Re-installed via FORCE=1 install-seeds.sh.
- **Phase data migration in db.ts** — UPDATE runs SET workflow on the rename pairs, UPDATE tasks SET phase for `frame`→`frame-question` and `review`→`ui-review`. Idempotent. No alias map (Steven 2026-05-08: "we need to wait for my current test run to complete! Solves it no?" — yes; in-flight migration not needed if no in-flight runs).
- **Modal grouping** (Steven Q3): WORKFLOW_GROUPS introduced (Build features / Design UI / Investigate or audit), rendered as native `<optgroup>`s in the picker. WORKFLOW_ORDER derived from groups so they stay in sync.
- **Tests:** advise.test, fanout.test, reconcile.test, composeSystemPrompt.test, manualPhase.test, submit.test, gate.test, constraints.test, server.test, workflowSchema.test all updated for the new names. New tests for awaiting_red in next.test + advise.test. 203 passing total (was 199).
- **CLAUDE.md updated** — state-machine status list, design-workflow exception list.

### #55 — ui-design-revise workflow rewrite
**Closed:** 2026-05-08 (rolled into #70). New `src/workflows/ui-design-revise.ts` registers the same two-phase shape as `ui-design` (brief + ui-review). The brief phase's prompt-author seed gets a workflowAdditions hint pointing at a (future) `templates/ui-design-revise.md`; until that template exists, the standard ui-design template works for revise too — the prompt-author can adapt based on the brief saying "revise X."

### #66 — Dashboard new-run modal (full form, all 6 workflows)
**Closed:** 2026-05-08 afternoon, on branch `new-run-modal-66` (199 tests passing, +26 new).
**What shipped:**
- New `src/dashboard/workflowSchema.ts`: single source of truth for the modal — workflow specs (description + per-workflow required/optional fields), universal fields (title + project), validation (required + absolute-path + shell-meta loose mode per Steven 2026-05-08 call), and argv builder for `forge new`.
- New `GET /api/workflows` endpoint exposes the schema; modal fetches once and caches.
- `POST /api/runs` replaces the 501 stub: validates server-side, shells out to `bin/forge new` (per FORGE-DEC-015), parses `Created run <id>` from stdout, returns `{runId, summary}`. 400 + structured `errors[]` on validation failure (client maps these to per-field error rows). 500 + stderr on subprocess failure.
- Dashboard modal: workflow picker first, fields appear/disappear per workflow choice, per-field validation, error rows on the matching field, submit disabled while creating, success closes modal + selects the new run. Read-only fallback when not interactive.
- 26 new tests covering: schema validation per workflow + edge cases (relative paths, shell-meta in paths, whitespace), argv builder shape per workflow, server endpoint (CSRF, interactive, validation surfacing, argv shell-out shape per workflow, success runId parsing, error surfacing).
**Locked design decisions** (Steven 2026-05-08):
- (A) Schema lives in `src/dashboard/workflowSchema.ts`, dashboard-internal — CLI keeps Commander as its source of truth. Sharing would couple two consumers without enough payoff.
- (B) Loose path validation — must be absolute (`/` or `~`), no shell metacharacters. Existence is `forge new`'s job downstream (mkdir for designDir, mount for project).
- (C) Briefs/questions are textareas. No shell-quoting concerns since cpSpawn takes argv as an array.
**Open follow-up:** when `--design-dir` defaults to `~/code/<title-slug>/`, the modal could pre-fill it as the user types the title (live default-derivation). Current behavior: empty placeholder text. Cheap polish, defer.

### #34 — Pretty/raw result view toggle
**Closed:** 2026-05-08, on branch `new-run-modal-66`.
Per-task toggle in the OUTPUT header. Pretty mode walks the result object structurally — top-level string keys become labeled paragraph blocks (split on blank lines so `\n\n`-separated prose reads naturally); arrays of strings become numbered lists; arrays of objects become sub-cards; paths get monospace styling; nested objects render with a left border. Raw mode is the original JSON code block with `white-space: pre-wrap` so it word-wraps too. Toggle state is stored in a closure-scoped Map keyed by task id — survives polling re-renders, lost on full page reload (good enough). Caught when the synthesizer's 3-key output (architecturalImplications + antiFindings + openQuestions) was unreadable as a single JSON wall.

### #72 — Dashboard: smart-refresh
**Closed:** 2026-05-08 afternoon, on branch `new-run-modal-66`.
**What shipped:** Each render function (`renderSidebar`, `renderMiddle`, `renderDetail`) computes a render key from the data + selection state it would draw, and bails out if the key matches the last render. Polling ticks that bring back unchanged data become silent — DOM is untouched, scroll/input/focus/animation/selection state preserved automatically. JSON.stringify-based; cheap because pane data is bounded.
**Why this fix replaces the band-aids:** Previously we patched scrollTop preservation and input-value preservation as scoped fixes for symptoms (scroll-jump on red-verdict reading; textarea wipe mid-typing). Each new form interaction would have needed its own preservation logic. Smart-refresh ends the entire class — when nothing's changed, nothing re-renders. The scroll/input preservation patches stay in place as a second layer (handle the case where data DOES change but the user has unsubmitted state).
**Caught:** 2026-05-08 — three distinct polling-induced bugs in an afternoon (scroll-jump, textarea-wipe, middle-column scroll-jump). Steven's call: stop patching, do this right.

### #68 — `forge new --design-dir` pre-creates the conventional layout
**Closed:** 2026-05-08, on `main` (alongside #54 smoke-test fixes).
`src/cli/commands/new.ts` now creates `<designDir>/`, `<designDir>/designs/`, and `<designDir>/code/` via `mkdirSync({recursive: true})` when designDir is set. Idempotent — reusing an existing designDir (per #67) leaves prior artifacts untouched. Caught during the v4 smoke test where the human session's PROMPT.md hit `mkdir -p` defensively at run time; cleaner to do this once at run creation so submit's existsSync checks have something deterministic to verify.

### #69 — Prompt-author seed: hard-stop on missing Pencil MCP
**Closed:** 2026-05-08, on `main` (seed change).
`seeds/agents/prompt-author/templates/ui-design.md` gains a PRECONDITION 0 step: verify `mcp__pencil__*` tools are connected before starting; if not, refuse to proceed and tell the human to reconnect. Caught 2026-05-08: a session ran the prompt without Pencil MCP attached and started writing HTML files as a fallback — wrong artifact type, would have hard-errored at `forge submit` because no .pen + no PNGs. Refuse + wait is the right shape, not improvise. Re-installed via `FORCE=1 scripts/install-seeds.sh`.

### #54 — `ui-design` review phase + manual-phase primitive
**Closed:** 2026-05-08 afternoon, on `main` (FORGE-DEC-016 + implementation).
**What shipped:**
- New task status `awaiting_human_input` added to `TaskStatus` union. Manual phases (`agents: []`) create exactly one task in this status; human transitions it via `forge submit`.
- New CLI: `forge submit <task-id> [--notes "..."]`. Validates `<designDir>/<title>.pen` non-zero + `<designDir>/designs/*.png` ≥ 1 + `<designDir>/code/*.html` ≥ 1. Hard-errors on missing `run.metadata.designDir` for `ui-design`/`ui-design-revise`. Captures paths into `task.result` and transitions to `awaiting_gate`.
- `src/workflows/ui-design.ts`: `review` phase added with `agents: []`, `gate: "human"`, `onReject: "brief"`. Reject loops back to brief with `inputs.rejectedRationale` populated (exercises the #25 plumbing).
- Spine: `next.ts` recognizes `awaiting_human_input` (returns new `kind`). `dispatch.ts` no-ops on empty-agents phases. `advise.ts` recommends `forge submit`. `gate.ts` rejects `request-changes` on manual phases (would otherwise create a pending task with no agent to dispatch).
- Dashboard: `/api/submit/:taskId` POST endpoint shells out to `forge submit` (FORGE-DEC-015 pattern). Awaiting-gate detail for review tasks renders artifact paths (.pen, PNGs, HTML files). Awaiting-human-input detail renders the brief context (PROMPT.md inline, parameters, openQuestions, designDir) + "I'm done" submit button.
- New helpers in `util/paths.ts`: `briefPromptHostPath` + `sanitizeTitleForFilename` (extracted from `new.ts`).
- New event type `task.submitted` in the audit trail.
**Tests:** 22 new tests across manualPhase, submit, advise, gate, server. 171 passing total (was 149).
**Closes / exercises:** #25 (onReject end-to-end via the reject path — verified by gate.test.ts). #48's substance partially lands (text-only artifact list in dashboard; PNG image previews remain a future enhancement, blocked on the browser file:// → http page security boundary).
**Depends on / unblocks:** #55 (design-revise rewrite) is unblocked — same workflow shape with a different prompt-author template. #66 (dashboard new-run modal) becomes load-bearing because submit hard-errors on missing designDir.

### #57 — Interactive dashboard v1 (gate buttons, run-next, design review)
**Closed:** 2026-05-08, merged to main as `a8e1b0f` (merge of branch `interactive-dashboard-57`, branch commit `65eaae3`).
**What shipped:**
- Full reskin to the Lunaris designs at `~/code/forge-design/designs/01-08`. Three-pane layout. CSS variables sourced from the .pen file's variable block. Geist + Geist Mono via Google Fonts CDN.
- POST endpoints in `src/dashboard/server.ts` for `/api/gate/<task>`, `/api/next/<run>`, `/api/runs` (501 stub). All shell out to `bin/forge` per FORGE-DEC-015.
- Mutations gated behind `FORGE_DASHBOARD_INTERACTIVE=1` (read-only by default). CSRF = `X-Forge-Request: 1` header. Localhost-only.
- `GET /api/meta` reports the interactivity flag so the client renders gate buttons or copy-CLI fallbacks.
- `listRunsForDashboard` returns task counts via SQL JOIN.
- 11 new server tests on the branch.
**Screens shipped:** 01 run list, 02 task list, 03 generic detail, 04 design detail, 05 awaiting-gate, 06 run-row overflow, 08 blocked-by-red. Stub for 07 (new-run modal).
**Deferred to followups:** screens 09/10 (#54), 11 (#53), 12-20 (the 9 FOLLOWUP-PROMPT.md gaps). Dashboard polish #62-65. Real new-run modal pending `forge new` POST schema.
**Absorbs:** #34 (human-readable result view — partly), #35 (gate buttons + run-next), #48 (design review surface).

### #58 — Tear down container-designer code (cleanup)
**Closed:** 2026-05-07/08 overnight, commits `d15e741` + `a9d1b1e` + `40fe81b` on branch `designer-agent-46` (3 commits).
**What got deleted:**
- `docker/agent-designer-worker.Dockerfile`, `docker/build-designer.sh` (commit 1)
- `seeds/agents/designer/` (CLAUDE.md, settings.json, skills/pencil-design/SKILL.md), `seeds/agents/designer-export/` (commit 2)
- `AgentRef.image` field on the type + plumbing through `dispatch.ts`, `spawnRed.ts`, `spawn.ts` (commit 3)
- `DESIGNER_IMAGE` constant + the conditional `PENCIL_CLI_KEY` env-var forwarding (commit 3)
- `pickIdleTimeoutMs(image, explicit)` simplified back to `resolveIdleTimeoutMs(explicit)` (commit 3)
- `src/workflows/ui-design.ts`, `src/workflows/design-revise.ts` (commit 3 — workflow names still registered in WorkflowName for #54/#55 to re-add the files)
- 3 PENCIL_CLI_KEY tests + 2 pickIdleTimeoutMs tests, replaced with 3 resolveIdleTimeoutMs tests (commit 3)
- Dockerignore tightened back to just `agent-dev-worker.Dockerfile` + `corp-root.pem` (commit 1)
**Tests on branch after cleanup:** 110 passing. Typecheck green at every commit boundary.
**Branch disposition:** the `designer-agent-46` branch is no longer load-bearing once these commits are accepted. The few clean wins were cherry-picked to main during the same overnight session (`98b9ed5`, `a42f23c`, `e119bfc`). After merge, `git branch -D designer-agent-46` is safe.

### #56 — Second Pencil pass: design the missing screens
**Closed:** 2026-05-07. Validated by a live `MISSING-SCREENS-PROMPT.md` run against the existing `~/code/forge-design/dashboard.pen`.
**Output:** 6 new screens added (now 11 total in the .pen file). PNGs at `~/code/forge-design/designs/06-run-row-actions.png` through `11-prompt-author-interview.png`. The .pen file is 458 KB, saved to disk by the human after the run. The dashboard interactive surface is now fully specified — no anticipated rework when implementing #57.
**Coverage delivered:** run-row actions (3 states) with overflow menu, new-run modal with workflow typeahead + CLI-equivalent display, blocked_by_red detail with force-advance affordance, design-handoff view (PROMPT.md inline + loud Cmd+S warning), design-review view (PNG gallery + approve/revise gate), prompt-author interview (chat thread + structured Q&A current question card). All in Lunaris/Saturated-Code-Bridge style with the same component library as the original 5 screens.
**Storage:** ~/code/forge-design/ is the working dir, untracked by forge git. No remote (per Steven's call). Treat as canonical reference for #57's implementation.


### #25 — Propagate reject rationale to onReject phase + tell blues about retry inputs (partial)
**Closed:** 2026-05-06, commit `d075f9f`
**Followup tracked above:** end-to-end validation requires a workflow that uses `onReject`, which doesn't exist yet. See #25 in Active.

### #26 — Stuck-task detection via idle-stdout watchdog
**Closed:** 2026-05-06, commit `aca548e`
Added `startIdleWatchdog`. Container killed if no stdout for 5 min (configurable via `FORGE_AGENT_IDLE_TIMEOUT_MS`). Five unit tests.

### #29 — DB-lock contention between concurrent forge invocations
**Closed:** 2026-05-06, commit `7c87274`
Added 5s `busy_timeout` on the SQLite singleton. Optional `{readOnly: true}` flag on `getDb()`. `forge show` always read-only; `forge status` accepts `--read-only`. ADR FORGE-DEC-012 (commit `cc61d92`).

### #30 — Red agents told about /project mount (+ blues, follow-up)
**Closed:** 2026-05-06, commits `57d16ff` (reds) + `5a9ded1` (blues, follow-up)
Both red seeds and all 9 non-implementer blue seeds got a `## Reading the project` section. Validated against the topaz-mobile review: reds gave evidence-cited verdicts with file:line citations, framer + assessors all read the codebase.

### #31 — Document forge dashboard in README + docs/quick-start.md
**Closed:** 2026-05-07, commit `676a27e`
Also fixed stale bedrock instructions in quick-start.md that referenced the pre-FORGE-DEC-013 design.

### #32 — Fail tasks whose result.json is empty/non-JSON-text
**Closed:** 2026-05-07, commit `f7cd71c`
Discovered when the framer's first run produced prose instead of JSON and was silently marked complete. Two cooperating bugs: `readResultJson` returned the envelope when the inner `result` was prose; `spawn`'s `reportedStatus` defaulted to `"complete"` on missing status. Both fixed; reconcile got the same treatment. Nine new tests.

### FORGE-DEC-013 — Profile-mount + detached watchdog
**Closed:** 2026-05-06/07, commits `21e79de` + `93d6a8b` + `41e2e6b` + `f860dbc` + `e5755b9`
Bedrock containers now mount `~/.aws` read-only and use `AWS_PROFILE`; STS env-var snapshotting removed. Detached host-side SSO watchdog with PID-file lifecycle keeps creds fresh in the background, survives forge process exits, auto-stops on run completion. Drop-in of Terry's `run-sso-watchdog.sh` with attribution. ADR + index entry.

## Done (archived)

(Nothing here yet. Periodically promote items from "Done (recent)" once they're old enough that nobody references them.)
