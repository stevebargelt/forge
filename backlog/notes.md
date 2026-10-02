**Last session ended 2026-09-28.**

**Where we left off:** Ran the Opus 5.5 best-practices audit of all of forge (4 read-only research lanes; findings filed as FG-804..FG-812), then shipped FG-804/805/806/807/809 and FG-813+FG-788 end to end (engineer → docs → test-engineer → evidence-led review → merge). Host checkout at main `8e8e7e9f`, seeds republished, image rebuilt (Claude Code pinned 2.1.281), doctor OK. Last recommendation to the operator: FG-808 next.

**Picked up next:**
1. FG-808 — detect a silent model switch on container dispatches (wire `usageModelMismatches` after `captureUsageForTask` in invoke.ts + runNext.ts; switched vs mixed; codex `unverifiable`). Bounded, implementation_quick.
2. v0.2.0 release gate per `backlog/releases/v0.2.0.md` — rebuild the candidate from main `8e8e7e9f` (NOT `32a11544`): it now carries FG-804 image pin + doctor floor, FG-805 carrier, FG-806, FG-807 effort, FG-809 headless contract, FG-813/788 recheck binding. Operator authorizes the tag.
3. Remaining Opus 5.5 audit tickets: FG-811 (seed/protocol wording pass, documentation-maintainer-heavy), FG-812 (orchestrator template restructure — orchestrator's own surface, edit seed then `forge-dev upgrade`), FG-810 (per-model prompt overlays — needs an architecture-advisor pass first, implementation_full). FG-803 (Opus 5.5 as shipped seed default) has uncommitted in-progress edits in `~/code/forge-v020` (branch feat/fg-803-opus-5-5-default) — resume there, don't restart.

**External state to remember:**
- `forge upgrade` reports INCOMPLETE on every run because `~/code/forge-scratch-workspace/.forge/model-policy.yml` needs a human decision (an alias source is absent); trakt-letterboxd / constellation policies likewise. Operator's call; not caused by this session.
- This host's policy maps activity `review` → codex-subscription, so since FG-807 the reds inside `feature` pipeline runs resolve to `gpt-5.6-terra` (were Haiku via fast-orchestrator). Evidence-led `forge review` reds already did. Pin in `~/.forge/model-policy.yml` if Claude reds are wanted.
- Disposable clones safe to delete: `~/code/forge-opus55-audit`, `forge-fg804`, `forge-fg805`, `forge-fg806`, `forge-fg807`, `forge-fg809`, `forge-fg813` (all merged).
- Operator dirty files in ~/code/forge (backlog/PLAN.md, backlog/notes.md, backlog/releases/) are intentionally uncommitted; use `forge upgrade --skip-git` here after `git pull --ff-only`.

**Decisions worth not relitigating:**
- Pipeline agents' write-mode framing (destructive-action list + TASKS.md) keys off the actual `/project` mount, so rw-mounted advisory primaries get it too — accepted (FG-809).
- Effort is not gated per model; legacy hosts (no model-policy.yml) now route reds to runtime.models.default — accepted, documented (FG-807).
- Evidence-led Stage 9 now re-executes cited acceptance tests itself; a claim forge tried and could not execute is `unproven`, never met on supplied output (FG-813 RF-1).
- FG-788 was mislabeled in the prior notes as the joined-title defect; that is FG-813. Both are now closed.
- `forge launch run --require-control-toolchain` correctly refuses a shell-script argv[0]; launch scripts without the flag.

**Memories this session may have invalidated:**
- `project_review_acceptance_evidence_exactness.md` / `project_review_loop_operational_quirks.md` — FG-813 (8e8e7e9f) fixed the joined executed_assertion binding: fixers now cite structured `{test_file, test_name}`, forge executes every cited lane itself, and a Stage 9 `test_name` is one name (semicolons OK). Proposed correction: drop the "settle via rejected_premise + replayed_command" workaround as the normal Stage 8 remedy; host `npm ci` + manual replay should no longer be needed.
- `project_evidence_led_review_contract_mechanics.md` — proposed addition (carried from last session, still unapplied): schema key is `risk_lenses`, `--evaluated-no-drift` takes a statement, `bounded_inspection` requires `limitation`; `--acceptance` evidence kinds are regression_test | replayed_reproduction | anchored_verification | bounded_inspection (not replayed_command).
- `feedback_forge_invoke_must_run_backgrounded.md` — proposed addition: forge refuses dispatching agents against the forge checkout itself (FG-612); always `--project <clone>` for forge-on-forge, including read-only research.

**Shipped (for reference):**
- FG-806 pipeline Dependency environment section (4cc687ae, #339); FG-805 carrier rendered + single delivery (6a242920, #340); FG-804 Claude CLI pin + doctor floor (8df21d73, #341); FG-809 headless agent contract (54d1cefb, #342); FG-807 effort knob + red intent routing (bd8f9d60, #343); FG-813 + FG-788 per-test/per-file recheck binding + dashboard lanes (8e8e7e9f, #344). Filed from the audit: FG-808, FG-810, FG-811, FG-812.

FG-814 Paperclip research: 4 RO research lanes + spec-writer synthesis on run run-fg-814-paperclip-vs-forge-research-bdbedf produced docs/research/competitive/paperclip-forge-assessment.md and paperclip-forge-recommendations.md (13 recs: P1 typed usage/cost semantics, supervised reconcile sweep, admission-time spend guardrails). PR #345 (427143b4) green on test + test-extended; awaiting operator merge decision (docs-only). Workspace ~/code/paperclip-research (disposable). Lane reports at ~/code/paperclip-research/design/lanes/. After merge: close FG-814 with the merge sha; consider filing the 8 suggested tickets and the 11 Forge doc/code drift items (sudo claim in docs/repo-guide.md:69 is the concrete one).

FG-814 MERGED as f5d95846 (#345) and closed with Acceptance Evidence. Not filed yet (operator's call): the 8 suggested tickets in paperclip-forge-recommendations.md and the 11 Forge doc/code drift items in the assessment (sudo claim at docs/repo-guide.md:69 is the concrete one). Disposable workspace ~/code/paperclip-research left in place; lane reports are its only non-repo content.

FG-814 amendments IN PROGRESS on branch docs/fg-814-recs-amend in ~/code/paperclip-research/forge (6 local commits, NOT pushed, no PR by operator instruction until the doc pass is done). Added since merge: controller loop P1, billing_mode from seed, Bedrock dollar enforceability, auth_routing_incompatible (FG-816), cost_usd_estimated, bounded auto-retry, rec 4 clarity rewrite, role-scoped secret bindings, and five operator-surface entries from two new UI lanes (E: paperclip UI, F: forge dashboard; reports in ~/code/paperclip-research/design/lanes/). Doc now has 21 recommendations. Remaining unreviewed with operator: 6, 9, 10, 14, 17. Lane F surfaced Forge dashboard drift worth ticketing: dashboard/CLAUDE.md describes retired gate/next/retry POSTs and wrong LoC; server.ts header says four POSTs (classify is fifth); KIND_META lacks two inbox kinds; remote board never emits stale.

FG-814 doc pass continues on docs/fg-814-recs-amend (11 local commits, unpushed by instruction). Now 26 recommendations. Added since last note: roles surface (14, ticket FG-817 filed at operator request), left-column nav with IA research first (15), engagement workspaces incl. dashboard New-engagement control (16), document workflows with sourcing lens (17), diagnostic skill (19), doc-review cursor + delta-first packages. backlog/SOMEDAY.md on main (5780a3ba, 47eb3f6c) holds connectors, non-code deliverables, tool gateway, second approver, chat answering. Operator instruction in force: doc edits only, no new tickets, until the doc is finalized; then ONE PR.

FG-814 doc pass MERGED as 4e172228 (#347): 26 recommendations final. FG-814 acceptance evidence updated with all three merges. Open follow-ups from the study: FG-815 controller loop (P1 rec 1), FG-816 auth_routing_incompatible (rec 8), FG-817 Roles surface (rec 14, operator wants it implemented). Doc-only-pass instruction has ended with the merge. Disposable workspace ~/code/paperclip-research still on disk (clone synced to main; lane reports in design/lanes/).

v0.2.0 dashboard tranche filed at operator request: FG-818 (IA research, IN PROGRESS: launch-fg818-ia-research-z2z8kt on clone branch docs/fg-818-dashboard-ia), FG-819 inbox completeness + remote stale, FG-820 left nav, FG-821 cockpit, FG-822 action registry, FG-823 inbox dismiss/snooze, FG-817 roles, FG-824 tokens/formatters/freshness. Tranche added to backlog/releases/v0.2.0.md committed scope (operator file, uncommitted). Build order is dependency order; FG-819 can run concurrently with FG-818. Operator rule recorded in memory: fold known in-theme work into the release, no cut-risk deferral.

FG-818 IA document written (5 groups Now/Plan/Evidence/Setup/Health; group derived from view; 2 server badges; 720px bottom bar), red-wide 1 finding fixed, PR #348 open awaiting CI. Material finding for FG-820: composeInbox is dashboard-only, no forge attention verb; Home badge blocked until derivation moves under src/v2/ with a CLI surface. FG-819 plan presented, awaiting operator go.

FG-818 MERGED 6be20c59 (#348), closed with acceptance grid. FG-819 engineer IN PROGRESS: launch-fg819-engineer-skkwt5, clone ~/code/forge-fg819 branch feat/fg-819-inbox-completeness-remote-stale, route implementation_quick (test-engineer followup mandatory, then documentation-maintainer for docs/concepts.md, then forge review start FG-819 --project ~/code/forge-fg819).

FG-819 committed 55154507 on ~/code/forge-fg819 (feat/fg-819-inbox-completeness-remote-stale), PR #349 open, ci-wait armed. In-container: 4 FG-819 integration tests passed; 6 unrelated env-bound failures (tailscale real-boot, esbuild arm64 tarball, real-CLI classify 60s timeout) plus one to watch on CI: remote-board.e2e 'actual server-entry children preserve local responses'. Docs updated (concepts.md, SCHEMA-CONTRACT.md). Review contract prepared at scratchpad fg819/contract.json (lenses wide/frontend/backend); start review after CI green: forge review start FG-819 --contract <file> --route implementation_quick --project ~/code/forge-fg819 --run run-fg-819-inbox-completeness-remote-stale-6793ca. Test-engineer lesson: dashboard integration tier must run via npm run test:integration -w dashboard (tsconfig paths alias), not bare node --import tsx from root.

FG-819 review review-eeb31c466a20: discovery 2 findings (RF-1 refresh re-sorted before fetch; RF-2 CLAUDE.md line 3 drift), both fix_now, fix batch committed by coordinator as c83dbe91 and pushed to PR #349. Continuing (launch-fg819-review-c4-a3i4s3): docs recon -> verification at c83dbe91 (CI) -> recheck -> shipping review (needs --acceptance and --docs-closeout files at Stage 9).

FG-819 review: docs stage clean; post-fix verification RED at c83dbe91 (CI test job: FG-642 census expects 4 tests for fg819-order-pinning, fixer added a 5th). Dispatched test-engineer (testing_automation) for the one-line census bump: launch-fg819-census-fix-1aa1i1. Then: commit as implementation commit, push, CI, forge review continue (candidate should rebind to new HEAD; if refused, read the refusal). Stage 9 files ready at scratchpad fg819/acceptance.json + docs-closeout.json.

FG-819: review-eeb31c466a20 is parked blocked_environment at c83dbe91 (candidate cannot move after a fixer-introduced deterministic red; gap ticket filed). Opened a SECOND review at 9401a9a1 (census fix on branch, PR #349 head) — launch-fg819-review2-start. Old review's RF-1/RF-2 are fixed in code; new discovery should confirm. Stage 9 files unchanged.

FG-819 second review review-e148aba6d07f at 9401a9a1: verify green (CI 15/15), contract confirmed after widening wide scope to cover dashboard/src/claude-md-mutation-parity.test.ts, discovery dispatched (launch-fg819-review2-c2-iyp13z). FG-825 filed for the coordinator gap (no candidate-movement path after a fixer-introduced deterministic red).

FG-819 review-e148aba6d07f: discovery 2 findings (RF-1 focus-entry not counted as activity; RF-2 parity test hardcoded count), both fix_now, batch committed e6422d2f (census correctly bumped to 6 this time), pushed to PR #349. Driving --all (launch-fg819-review2-c4-643a3a) with acceptance + docs-closeout files; final verification waits on CI at e6422d2f (ci-wait armed).

FG-819 review-e148aba6d07f SETTLED at 3b555b39 (shipping review 8/8: verification green, acceptance mapped 5/5 met, findings settled, fix_now resolved, tip equality, identity, contract covers diff, docs closeout). PR #349 head 3b555b39; awaiting CI green at that sha (ciwait armed) then merge under the automated-review authorization, close FG-819 with grid, delete clone ~/code/forge-fg819. Old review review-eeb31c466a20 remains parked blocked_environment at c83dbe91 (superseded; FG-825 covers the gap).

FG-819 SHIPPED: merged 2fb6bd82 (#349), closed with acceptance grid, clone ~/code/forge-fg819 removed, milestone pushed. v0.2.0 tranche status: FG-818 done, FG-819 done; next in dependency order FG-820 (left-column nav, IA doc at docs/research/dashboard-information-architecture.md; note its finding that the Home badge is blocked until composeInbox moves under src/v2 with a CLI surface). FG-825 open (coordinator gap). Test-engineer lesson recorded earlier: dashboard integration tier runs via npm run test:integration -w dashboard.

FG-820 IN PROGRESS on ~/code/forge-fg820 (feat/fg-820-left-column-nav). Step 1 engineer running: launch-fg820-engineer-1-bkkexi (move composeInbox to src/v2, counts field, forge attention list). Step 2 brief at scratchpad fg820/engineer-2.md (left column per IA doc; decisions: no icon rail, Home badge from server counts only, Runs unbadged + placeholder view, scope in hash, relabels with aliases, strip removed). Then test-engineer, maintainer, review (lenses wide/frontend/backend), PR, merge, dashboard restart.

FG-820 step 1 engineer was blocked ~30 min inside npm run test:integration -w dashboard: two src/server.ts children hung (real-boot suites), orchestrator terminated them via docker exec (container pids, not docker top's host pids) and the runner exited; agent resumes. Ticket FG-826 filed for the container hang (2nd occurrence). Lesson: docker top prints host-namespace pids; use docker exec ps for kills inside a container.

FG-820 step 1 COMPLETE (uncommitted on clone): derivation + mappers moved to src/v2/attention-inbox*.ts, counts field, forge attention list (shells dashboard/src/attention/cli-entry.ts; follow-up candidate: move the FG-693 scope layer into src/ so the CLI is in-process). 3 in-container failures = FG-826 real-boot suites (CI authority). Maintainer must update docs/concepts.md Attention inbox paths + verb + counts, docs/redaction.md:144 path. Step 2 (left column) dispatching on the same run.

FG-820 step 2 COMPLETE (uncommitted, 49 files on clone): ROUTES table, left column (5 groups), scope in hash, aliases, Home badge from counts, Runs + Roles placeholder views, bottom bar + drawer, browser suite fg820-left-column-nav (6, census registered). Deviations accepted: #task/#explain object routes + breadcrumbs deferred to FG-821; per-view 'Filtered to' banner replaced by the column's scope control; inbox poll now runs on every view. Final in-container reds = FG-580 offline-boot pair (env). Engineer screenshots were lost with the container (/tmp) — test-engineer (launch-fg820-test-engineer-6a79z6) re-captures to /task/screenshots. Lesson for seeds: screenshots must be written under /task/screenshots, never /tmp.

FG-820 committed 45b70484 on ~/code/forge-fg820 (feat/fg-820-left-column-nav), PR #350 open, ci-wait armed. Docs impact: updated (concepts, redaction, how-to-testing by maintainer; SCHEMA-CONTRACT, dashboard/CLAUDE.md by engineer). Stage 9 files ready at scratchpad fg820/acceptance.json (7 AC, 6 regression tests + docs inspection) and docs-closeout.json; contract at fg820/contract.json (wide/frontend/backend). After CI green: git branch -f main origin/main in clone; forge review start FG-820 --contract ... --route implementation_quick --project ~/code/forge-fg820 --run run-fg-820-left-column-navigation-7b87d2 --evaluated-no-drift <statement>; then continue --all with the two files; push any coordinator commits; merge; close; restart dashboard.

FG-820: CI green 15/15 at 45b70484 (#350). Review started: launch-fg820-review-start-c99m5d with --evaluated-no-drift; expect stop at disposition. Then: disposition per policy, continue --all with fg820/acceptance.json + docs-closeout.json, push coordinator commits before shipping (tip_equality), merge, close with grid, rm ~/code/forge-fg820, restart dashboard (kill server pid, forge launch run --purpose dashboard -- forge dashboard start).

FG-820 review review-c6064d989c1e at 45b70484: backend + wide pass, frontend 1 finding RF-1 (skip-link target .app:focus outline none, FG-692) fix_now; fix batch dispatched (launch-fg820-review-c1-k2fv76). After it: push coordinator commit, continue --all with acceptance + docs-closeout, expect CI wait at the post-fix sha, push docs-cycle commit if any before shipping (tip_equality), merge, close, dashboard restart.

FG-820: RF-1 fixed by coordinator batch c189d472 (focus-visible outline + assertion; census unchanged at 7), pushed to #350. Driving --all (launch-fg820-review-c2-o6c50b) with acceptance + docs-closeout; ci-wait armed at c189d472. If the docs cycle moves the candidate, push before shipping (tip_equality).

FG-820 SHIPPED: merged 413c5bbb (#350), closed with acceptance grid, clone removed, milestone pushed, host dashboard restarted on the new nav. v0.2.0 tranche: FG-818, FG-819, FG-820 done; next FG-821 cockpit (run index, #task/<id> + #task/<id>/explain object pages, breadcrumbs, links to reviews/launches/verifications, Runs badge via an active-run count field on GET /api/runs), then FG-822 action registry, FG-823 inbox dismiss/snooze, FG-817 roles, FG-824 tokens. Open follow-ups from FG-820: move the FG-693 scope layer into src/ so forge attention list runs in-process (unfiled; low).

OPERATOR AUTHORIZATION (2026-09-28): 'work as autonomously as possible - I have to step away'. Scope: continue the v0.2.0 dashboard tranche (FG-821, FG-822, FG-823, FG-817, FG-824) end to end without per-step confirmation: route, dispatch, test-engineer, docs, evidence-led review, merge under the automated-review authorization, close with grid, restart dashboard, next item. Stop and ask only for product/scope decisions, destructive actions, or blockers.

FG-821 IN PROGRESS (autonomous): clone ~/code/forge-fg821 branch feat/fg-821-cockpit; step A engineer running launch-fg821-engineer-a-hm0w6e (GET /api/runs paged+activeCount memoized 30s, GET /api/review/:id, task links, GET /api/backlog/:id/runs). Briefs for step B (pages, breadcrumbs, headers, Runs badge), test-engineer and docs at scratchpad fg821/. Chain: A -> B -> test-engineer -> docs -> commit -> PR -> CI -> review (contract to be authored from changed paths) -> merge -> close -> dashboard restart -> FG-822.

FG-821 step A COMPLETE (uncommitted, 8 files): run-index.ts endpoint (paged, activeCount, nextCursor, memoized), review by id, task links, backlog/:id/runs (list scope). Step B running: launch-fg821-engineer-b-l3nhgi.

FG-821 step B COMPLETE (uncommitted, 44 files, screenshots on host in task-engineer-34c707, census fg821-cockpit-pages=11 port 18825). Gap: run rows lacked ticketId and evidence tab fanned out over tasks — step C dispatched (launch-fg821-engineer-c-5jh9tf) to add ticketId to GET /api/runs rows and a GET /api/run/:id/evidence route. Then test-engineer -> docs -> commit -> PR.

FG-821 step C COMPLETE: ticketId on run rows (shared serializer; forge runs query --json gains it = public_api_changed additive), GET /api/run/:id/evidence, integration file passes 13/13 when run as 'cd dashboard && npx tsx --test src/<file>' (a root-dir 'npx tsx --test dashboard/src/<file>' fails at load because the @forge/project-meta tsconfig alias only resolves under dashboard/tsconfig.json). RULE for briefs: run dashboard integration files from the dashboard dir. Test-engineer running: launch-fg821-test-engineer-04884m.

FG-821 test-engineer: browser 12/12 (census 12), added an integration test in fg821-cockpit-routes.integration.test.ts but could not execute it (ran from root; alias) -> status failed for that lane only; CI dashboard_integration + review Stage 9 will execute it. Docs maintainer dispatched (launch-fg821-docs-*). Next: commit, push, PR, ci-wait, review start with contract (wide/frontend/backend), continue --all with acceptance + docs-closeout, merge, close, restart dashboard, then FG-822.

FG-821 docs done (concepts, how-to-testing, dashboard/CLAUDE.md; SCHEMA-CONTRACT by engineers). Committing + PR now; Stage 9 files at scratchpad fg821/acceptance.json (7 AC) + docs-closeout.json; contract fg821/contract.json. Then ci-wait, review start (evaluated-no-drift), continue --all, push coordinator commits, merge, close, dashboard restart, FG-822.

FG-821: CI green 15/15 at 864a40df (#351). Review starting (launch fg821-review-start) with evaluated-no-drift; contract wide/frontend/backend. Next: disposition, continue --all with fg821/acceptance.json + docs-closeout.json, push coordinator commits before shipping, merge, close with grid, rm ~/code/forge-fg821, restart dashboard, then FG-822.

FG-821 review review-ae23f02fac56 at 864a40df: backend pass; frontend RF-1 (tablist without tab/tabpanel roles, FG-692) and wide RF-2 (release.ts client-module closure missing new cockpit modules — torn-release risk, HIGH) both fix_now; fix batch dispatched launch-fg821-review-c1-3ebdor. After: push, continue --all with acceptance + docs-closeout, push docs-cycle commit if any, merge, close, rm clone, restart dashboard, FG-822. Seed lesson: any new dashboard/client module must be added to src/v2/release.ts's required list (RF-2 asks for a graph-walking test so it cannot recur).

FG-821: fix batch 0e20c11d (tab roles; release closure + graph-walk test in src/v2/release.test.ts), pushed. Driving --all (launch-fg821-review-c2-zh7yyb); ci-wait armed at 0e20c11d. If docs cycle moves the candidate: push before shipping.

FG-821 SHIPPED: merged eca5bc74 (#351), closed with grid, clone removed, milestone pushed, dashboard restarting. v0.2.0 tranche: 4 of 8 done (818, 819, 820, 821). FG-822 (action registry) starting autonomously on ~/code/forge-fg822 branch feat/fg-822-action-registry; brief at scratchpad fg822/engineer.md (ACTION_ROUTES: gate/retry/recover-re-drive, preview GET /api/task/:id/actions, eligibility from retry-policy POLICY no-advice + RE_DRIVABLE guard, shared guards with queue-mutation, buttons on task page + inbox rows, no arm/cancel/force). Then test-engineer, docs, PR, review, merge, restart, FG-823.

FG-822 engineer COMPLETE (uncommitted, 21 files): ACTION_ROUTES in dashboard/src/action-mutation.ts with shared guards, POST task gate/retry/recover-re-drive, GET /api/task/:id/actions preview, buttons on task page + inbox rows, fg822-task-actions browser suite (4, port 18826), integration 8/8 from dashboard dir, guard-refactor suites re-run individually. Screenshots on host. Only reds: FG-580 offline-boot pair (container). Test-engineer dispatched.

FG-822 test-engineer COMPLETE (15/15; browser suite 5, census 5; integration 10/10 from dashboard dir). Docs maintainer dispatched. Contract at scratchpad fg822/contract.json (wide/frontend/backend/security), acceptance draft (AC7 pending docs). Then commit, PR, CI, review start, --all, merge, close, rm clone, restart dashboard, FG-823.

FG-822 docs done (concepts, SCHEMA-CONTRACT, how-to-testing, DEC-015 note; dashboard/CLAUDE.md by engineer). Committing + PR now. Stage 9 files at scratchpad fg822/acceptance.json + docs-closeout.json; contract fg822/contract.json (wide/frontend/backend/security). Then ci-wait, review start, --all, merge, close, rm clone, restart dashboard, FG-823.

FG-822: CI green 15/15 at ff04d05c (#352). Review starting (fg822-review-start) with contract wide/frontend/backend/security; learnings/decisions/ widened into the wide lens. FG-823 briefs pre-written at scratchpad fg823/. After FG-822 merges: restart dashboard, clone forge-fg823, launch engineer.

FG-822 review review-f301d70eff3b at ff04d05c: verify green, contract confirmed (wide widened to learnings/decisions/; lesson: never pass --evaluated-no-drift together with --add-lens — the coordinator refuses the pair; widen alone). Discovery dispatched over wide/frontend/backend/security (launch-fg822-review-c2-2xdg4h). Then disposition, --all with fg822/acceptance.json + docs-closeout.json, push coordinator commits, merge, close, rm clone, restart dashboard, FG-823 (briefs at scratchpad fg823/).

FG-822 discovery: 0 findings across wide/frontend/backend/security. Driving --all (launch-fg822-review-c3-f35zb8). FG-823 clone pre-created at ~/code/forge-fg823 (branch feat/fg-823-attention-dismiss, from main before FG-822 merge — must fetch && reset --hard origin/main after #352 merges, before launching).

FG-822 review review-f301d70eff3b: docs cycle moved candidate to 3ba81ee2 (docs/quick-start.md), pushed. Shipping blocked: AC 1's cited integration test FAILS on macOS host (mkdtemp /var vs realpath /private/var in the expected spawn cwd; passes on Linux/CI). Test-only fix dispatched (launch-fg822-realpath-fix, testing_automation). Then: commit as implementation commit, push, CI, NEW review at the corrected head (FG-825 gap: coordinator cannot move the candidate for a non-finding correction), --all with the same Stage 9 files, merge, close, rm clone, restart dashboard, FG-823.

FG-822: realpath test fix committed on the branch (fg822 + fg591 integration suites compare realpath cwd; 10/10 on macOS host), pushed to #352; ci-wait armed. review-f301d70eff3b stays parked at 3ba81ee2 (superseded). On CI green: forge review start FG-822 (new review) at the new head with fg822/contract.json + --add-lens wide:learnings/decisions/ ONLY on continue (never with --evaluated-no-drift); then --all with acceptance + docs-closeout; merge; close; rm clone; restart dashboard; FG-823.

FG-822: CI green 15/15 at 0087831d (#352). Second review starting at 0087831d (fg822-review2-start) with the contract's wide scope now including learnings/decisions/ so no widening is needed. Then disposition (expect clean or re-confirm of prior clean lenses), --all with fg822/acceptance.json + docs-closeout.json, push any docs-cycle commit, merge, close, rm clone, restart dashboard, FG-823 (clone at ~/code/forge-fg823 must be reset to origin/main after merge).

FG-822 second review review-d5a2d0ac53ce at 0087831d: frontend + security pass; backend RF-1 (classify route bypasses the shared mutation slot — concurrency, fix_now) and wide RF-2 (how-to-testing.md browser totals stale, fix_now); fix batch dispatched launch-fg822-review2-c1-x242hz. Note: first discovery at ff04d05c was clean across all four lenses; second sampled two real findings — discovery is sampling, which is why the ledger and recheck, not a clean pass, settle it.

FG-822: fix batch 12f26d44 (classify via withMutationSlot + 503 when full; contention test; how-to-testing totals; new census-vs-docs consistency test), pushed to #352; driving --all (launch-fg822-review2-c2-op2jc7); ci-wait armed at 12f26d44. If docs cycle moves the candidate: push before shipping.

FG-822 SHIPPED: merged 80089974 (#352), closed with grid, clone removed, milestone pushed, dashboard restarting. v0.2.0 tranche: 5 of 8 done (818, 819, 820, 821, 822). FG-823 (attention dismiss/snooze; additive attention_dismissals table, machine-wide) starting on ~/code/forge-fg823 reset to 80089974; briefs at scratchpad fg823/ with accumulated lessons appended. Then test-engineer, docs, PR, review (contract to author; lenses wide/frontend/backend/security since new POST routes + schema), merge, restart, FG-817.

FG-823 engineer: ran the full dashboard integration tier despite the brief; hung on FG-826 suites; orchestrator killed the two src/server.ts children (container pids) at ~12 min; agent continues. FG-826 updated with this third occurrence. Monitor re-armed (launch-fg823-engineer-v4ueh1).

FG-823 engineer result: complete but 4 reds — 2 env (classify real-CLI, FG-782) and 2 REAL: the FG-822 inbox-row action button tests fail (Dismiss/Snooze displaced the resolving verb buttons; screenshot confirms). Store tests pass under npm test (6030/6030; the 2-file 'test failed' was a bare npx run). Rejected that part; fix engineer dispatched (launch fg823-engineer-fix). Then test-engineer -> docs -> commit -> PR -> review (contract: wide/frontend/backend/security; schema change: attention_dismissals).

OPERATOR (2026-09-29 ~02:40): 'keep going as autonomously as possible - I'm going to bed'. Continue FG-823 -> FG-817 -> FG-824 end to end (dispatch, verify, review, merge under automated-review authorization, close, restart dashboard). Do not start the v0.2.0 candidate rebuild/release gate (operator's call). Stop only for product decisions, destructive actions, blockers. Leave a full handoff in notes at the end.

FG-823 fix pass: FG-822 inbox tests pass 5/5 repeatedly; earlier reds were a contended-run flake and the screenshot was a taskless-gate fixture; browser tier 196/198 (FG-580 pair only). Engineer work accepted. Test-engineer dispatched with an explicit re-run of the fg822 suite and a shared-preview-selector assertion. Contract at scratchpad fg823/contract.json.

FG-823 test-engineer: status failed by design — its new 6th browser test exposed a real defect (two previews visible in one inbox row when Snooze opens over a gate-action preview; the fix pass had called it a 'known limitation'). fg822 suite 5/5 isolated; CLI integration 7 passing. Engineer fix 2 dispatched (one preview per row, distinct classes added, all tiers to run). Then docs, commit, PR, review.

FG-823 fix 2 COMPLETE: one preview per inbox row (state in InboxRowControls), distinct preview classes, +1 browser test (census fg823=7, tier 200/200, root 6030/6030). Docs maintainer dispatched (launch fg823-docs). Then commit, PR, ci-wait, review start with fg823/contract.json (wide/frontend/backend/security), --all with acceptance + docs-closeout, push docs-cycle commit, merge, close, rm clone, restart dashboard, FG-817 (briefs at scratchpad fg817/).

FG-823 docs done (concepts, SCHEMA-CONTRACT by maintainer; how-to-testing, dashboard/CLAUDE.md by engineers). Committing + PR. Stage 9 files ready (fg823/acceptance.json, docs-closeout.json); contract fg823/contract.json. Then ci-wait, review start with --evaluated-no-drift ONLY (contract already covers all paths incl. learnings/decisions/), --all, push docs-cycle commit, merge, close, rm clone, restart dashboard, FG-817.

FG-823 PR #353 CI RED at c16a8dbb: dashboard_browser EACCES mkdir /task/screenshots from the fg823 browser suite (hardcoded container path; the file aborted, 6 tests unrun) -> dashboard_integration FG-642 count 194/200. Test-only fix dispatched (launch fg823-ci-fix, testing_automation): default screenshot dir to mkdtemp unless FG823_SCREENSHOT_DIR set, sweep sibling suites. Review NOT started yet (good: no FG-825 candidate issue). After fix: commit, push, CI, review start at new head. Lesson for briefs: screenshots go to /task/screenshots ONLY via an env var the container sets; suites must default to tmpdir.

FG-823: screenshot-dir fix committed and pushed to #353 (fg823 suite defaults to mkdtemp; sibling sweep clean); ci-wait armed. On green: review start at the new head with --evaluated-no-drift (contract fg823/contract.json), --all with acceptance + docs-closeout, push docs-cycle commit, merge, close, rm clone, restart dashboard, then FG-817 (clone staged at ~/code/forge-fg817, reset to origin/main first).

FG-823: CI green 15/15 at 51bf9197 (#353). Review starting (fg823-review-start), four lenses. Then disposition, --all with fg823/acceptance.json + docs-closeout.json, push docs-cycle commit if any, merge, close with grid, rm clone, restart dashboard, FG-817.

FG-823 review review-26a8ea029555 at 51bf9197: RF-2 (--actor forgeable) and RF-3 (wide inconclusive) rejected_premise with anchors; RF-1 (dismissed-only empty copy) fix_now, tied to AC 3 so accepted_risk needed --operator. Fix cycle running as launch-fg823-review-fix-h95mg7. Next: push coordinator fix commit, wait CI, continue --all with acceptance+docs-closeout, push docs commit, merge #353, close, rm clone, restart dashboard, FG-817.

FG-823: coordinator fix cycle landed 73083f2b (pushed) but the fixer added an 8th browser test without a census bump, so CI at 73083f2b will be red on the census. test-engineer census fix running (launch-fg823-census-fix-vqwhr2) on ~/code/forge-fg823. After it lands: commit + push, ci-wait, then per FG-825 a SECOND forge review start at the corrected head (RF-2/RF-3 rejected_premise again with the same anchors; RF-1 fixed so it should not recur), then --all with acceptance + docs-closeout, merge #353, close, rm clone, restart dashboard, FG-817. FG-825 occurrence count is now 3.

FG-823: census correction committed 8cedf143 and pushed; ci-wait armed on #353. On green: SECOND forge review start at 8cedf143 (--evaluated-no-drift; contract fg823/contract.json), redo RF dispositions (actor forgeable -> rejected_premise anchored at src/cli/commands/gate.ts:36; wide inconclusive -> rejected_premise), --all with acceptance + docs-closeout, push any docs commit, merge, close, rm clone, restart dashboard, FG-817.

FG-823: CI green 15/15 at 8cedf143; ci-wait advanced. Second review starting (launch-fg823-review2-start-i0dzxy). Then dispositions, --all with fg823/acceptance.json + docs-closeout.json, push docs commit, merge #353, close with grid, rm clone, restart dashboard, FG-817.

FG-823 second review review-527c0296eb2a at 8cedf143: RF-1 (actor forgeable) rejected_premise again; RF-2 (dashboard/CLAUDE.md snooze presets omit 2w) fix_now, fix cycle running as launch-fg823-review2-fix-7s0dx3. After it: check the fix diff for a census-affecting test (none expected), push the coordinator commit, ci-wait #353, continue --all with acceptance + docs-closeout, push docs commit, merge, close, rm clone, restart dashboard, FG-817.

FG-823: second fix cycle landed 2bf79f1b (CLAUDE.md 2w preset + parity test), pushed. Docs stage running (launch-fg823-review2-docs-y7v3sx). Next: push any docs commit, ci-wait #353, continue --all with acceptance + docs-closeout, merge, close, rm clone, restart dashboard, FG-817.

FG-823: docs cycle moved candidate to 1803d411 (dashboard/CLAUDE.md + docs/concepts.md), pushed; ci-wait armed on #353. On green: continue --all --acceptance fg823/acceptance.json --docs-closeout fg823/docs-closeout.json on review-527c0296eb2a, then merge #353, close FG-823 with grid, rm ~/code/forge-fg823, restart dashboard, FG-817.

FG-823: CI green 15/15 at 1803d411, ci-wait advanced; review-527c0296eb2a final stages running (launch-fg823-review2-all-cm24on). On settled: merge #353 (squash), close FG-823 with acceptance grid citing the merge sha, rm ~/code/forge-fg823, restart dashboard, then FG-817 (reset ~/code/forge-fg817 to origin/main first).

FG-823 review-527c0296eb2a: recheck at 1803d411 left RF-2 inconclusive (not_executed) because ~/code/forge-fg823 had NO root node_modules, so the dashboard_unit lane crashed at import (better-sqlite3 missing via src/store/db.ts). Env gap, not a fix defect (CI green 15/15 at 1803d411). npm ci running in the clone under the control toolchain (launch-fg823-npm-ci-0btwny); then dry-run continue to see the transition, re-drive recheck, --all with acceptance + docs-closeout, merge, close, rm clone, restart dashboard, FG-817. Lesson: run npm ci in every forge-on-forge clone at setup.

FG-823: clone deps installed (npm ci under control toolchain); parity test yields 3/3 green on host. RF-2 re-recorded fix_now (env-caused inconclusive); batch revision running as launch-fg823-review2-fix2-vyulzu. If the fixer commits: push, ci-wait #353, then continue --all with acceptance + docs-closeout; if no commit: continue --all directly. Then merge, close, rm clone, restart dashboard, FG-817.

FG-823: coordinator refused a 2nd remediation cycle (single-batch cap); RF-2 recorded rejected_premise with replayed_command evidence (parity test 3/3 at 1803d411 after npm ci; CLAUDE.md:64 names 2w). Final stages running as launch-fg823-review2-all2-i5xy46. Then merge #353, close with grid, rm clone, restart dashboard, FG-817.

FG-823 SHIPPED: merged #353 as 0a967a3a, closed with acceptance grid; clone removed; dashboard restarted (launch-dashboard-nk6bds). Tranche status: 818/819/820/821/822/823 shipped; FG-817 next (clone ~/code/forge-fg817 on feat/fg-817-roles-surface at 0a967a3a, npm ci running launch-fg817-npm-ci-ikg08p), then FG-824. Do NOT start the v0.2.0 candidate rebuild/release gate (operator's call). Follow-ups for operator: FG-815, FG-816, FG-825 (3 occurrences), FG-826 (3 occurrences).

FG-817 started: route implementation_quick (engineer -> test-engineer followup), engineer running on ~/code/forge-fg817 as launch-fg817-engineer-agma2d (brief fg817/engineer.md, run title 'FG-817 dashboard roles surface'). After it: verify tests_run/screenshots/docs_impact, check git status in the clone, test-engineer on the same run (fg817/test-engineer.md), documentation-maintainer (fg817/docs.md), commit, PR, ci-wait, review start, merge, close, then FG-824.

FG-817: engineer pass 1 complete (task-engineer-2830f3, 7511 tests, 5 screenshots, census 8/8 at 209 total, roles list + 9 tabs, GET /api/roles + /api/roles/:role). Gap vs AC 3: Instructions composed host-only; engineer follow-up running (launch-fg817-engineer2-uxxhpj, brief fg817/engineer2.md) to honor the scope project via the registry. Then test-engineer (fg817/test-engineer.md), docs (fg817/docs.md), commit, PR, ci-wait, review, merge, close, FG-824.

FG-817: engineer follow-up complete (task-engineer-3290fc): ?project=<key> on GET /api/roles/:role composes with the project addendum via the registry; 1 unrelated flake (docker-exec FG-536 cleanup ENOTEMPTY, passes alone). test-engineer running (launch-fg817-test-engineer). Then docs (fg817/docs.md), commit, PR, ci-wait, review, merge, close, FG-824 (clone staged at ~/code/forge-fg824, branch feat/fg-824-status-tokens, deps installed).

FG-817: test-engineer pass 1 (task-test-engineer-d9d421) wrote 2 tests (routes parity via real binary, release closure); pass 2 launched for receipts fidelity + usage parity (fg817/test-engineer2.md) in parallel with documentation-maintainer (fg817/docs.md; docs-only paths). Then: commit all, PR, ci-wait, review start (contract to write: lenses wide/frontend/backend/security; security scope = dashboard/src/roles.ts, server.ts, src/v2/role-surface.ts (registry project resolution, no path from caller), invoke.ts/invoke-shape.ts), merge, close, FG-824.

FG-817: test-engineer pass 2 (task-test-engineer-b41ff5) wrote receipts-fidelity + usage-parity integration tests (2/2 in container) but its result.json had a stray leading '+' so forge recorded the task failed (work is on disk). Receipts test FAILS on macOS host: role-surface.ts generationIdOfSource uses relative() on raw home vs canonical source (/var vs /private/var) -> null. Engineer follow-up 3 running (launch-fg817-engineer3-jsg71a, fg817/engineer3.md) to realpath both sides + unit test. Docs maintainer still running (launch-fg817-docs-ssgji6). Then: host-run the two src/v2 fg817 integration files, commit, PR, ci-wait, review (contract fg817/contract.json; acceptance/docs-closeout drafts have PLACEHOLDERs to fill), merge, close, FG-824.

FG-817: all agent work committed as 763de924 on feat/fg-817-roles-surface, PR #354 open. CI test job will be RED on the FG-704 timings guard (94.8% < 95%: two new src/v2 integration files unmeasured). Remedy: 'Measure integration timings' workflow_dispatch on the branch -> download artifact scripts/integration-timings.json -> commit to branch -> ci-wait -> review start (fg817/contract.json; acceptance.json + docs-closeout.json final) -> merge -> close -> FG-824 (reset ~/code/forge-fg824 to the new main first; census/main.js conflicts otherwise). Docs: maintainer task-documentation-maintainer-f7b195 updated concepts, SCHEMA-CONTRACT, how-to-new-agent, how-to-model-policy.

FG-817: timings manifest refreshed from canonical run 36524861418 (344/344), committed on the branch and pushed; CI at 763de924 was green except the FG-704 guard. Next: ci-wait #354 at the new head, review start (fg817/contract.json, --evaluated-no-drift), dispositions, --all with acceptance + docs-closeout, merge, close with grid, rm clone, restart dashboard, FG-824 (reset ~/code/forge-fg824 to new main).

FG-817: CI green 15/15 at 0feb5748 (#354). Review starting (fg817-review-start; contract fg817/contract.json incl. scripts/integration-timings.json in wide). Then dispositions, fix batch if any (push coordinator commits; check census on any browser test the fixer adds), --all with fg817/acceptance.json + docs-closeout.json, merge, close with grid, rm clone, restart dashboard, FG-824.

FG-817 review review-bf0c3b1c740e at 0feb5748: RF-1 (usage top-10k role-bucket cap) accepted_risk (no AC/invariant tie); RF-2 (wide inconclusive) rejected_premise. No fix cycle. --all running with acceptance + docs-closeout. On settled: merge #354, close with grid, rm clone, restart dashboard, FG-824.

FG-817 SHIPPED: merged #354 as 029dcd44, closed with acceptance grid; clone removed; dashboard restarted. Tranche: 818/819/820/821/822/823/817 shipped; FG-824 (last) dispatched on ~/code/forge-fg824 (branch feat/fg-824-status-tokens at 029dcd44, deps installed). Do NOT start the v0.2.0 candidate rebuild/release gate (operator's call). Operator follow-ups: FG-815, FG-816, FG-825 (3 occurrences), FG-826 (3). Agent result.json with a stray leading '+' (task-test-engineer-b41ff5) made forge mark the task failed though the work landed — one-off, not ticketed.

FG-824: engineer complete (task-engineer-feab0f, 7435 tests, 3 screenshots, census 5 at 214, no root integration files). test-engineer launched (fg824-test-engineer). Then docs (fg824/docs.md), commit, PR, ci-wait, review (write fg824/contract.json: lenses wide/frontend/backend/security; security scope: dashboard/src/queries.ts, shell.ts, src/store/queue-claims.ts, src/v2/launch.ts, src/types/index.ts), merge, close, restart dashboard. Then STOP: v0.2.0 candidate rebuild/release gate is the operator's call.

FG-824: test-engineer complete (task-test-engineer-4cadcc): +1 browser test (keyboard recovery button), census 6 / 215, full browser tier 215/215; coverage judged sufficient (engineer suites cover mixed-fixture vocab, thresholds, recovery card; unit scans enforce exclusivity). Docs maintainer running (launch-fg824-docs-oo3d22). Then commit, PR, ci-wait, review (fg824/contract.json; acceptance.json drafted with 2 PLACEHOLDERs; docs-closeout PLACEHOLDER), merge, close, restart dashboard, STOP before the v0.2.0 release gate.

FG-824: docs done (task-documentation-maintainer-11c9f5: concepts, how-to-testing, dashboard/CLAUDE.md; SCHEMA-CONTRACT verified unchanged). Committing + PR now; then ci-wait, review start (fg824/contract.json), --all with acceptance + docs-closeout (both final), merge, close with grid, rm clone, restart dashboard. Then STOP: v0.2.0 candidate rebuild/release gate is the operator's call.

FG-824: PR #355 at 31be655c, CI green 15/15 first push; ci-wait advanced. Review starting (fg824-review-start). Then dispositions, fix batch if any (push coordinator commits; census check on any browser test), --all with fg824/acceptance.json + docs-closeout.json (both final), merge, close with grid, rm clone, restart dashboard. Then STOP: v0.2.0 candidate rebuild/release gate is the operator's call.

FG-824 review review-908b4477f731 at 31be655c: 3 findings, one defect — recovery card's defaultRecoveryVerb builds 'forge retry <id> --force' for orphaned_needs_finalize (+ docs/concepts.md:459). All fix_now; batch fix running (launch-fg824-review-fix). After: check the fixer's diff for a browser-test census bump, push the coordinator commit, ci-wait #355, continue (docs stage), push, ci-wait, continue --all with acceptance + docs-closeout, merge, close, restart dashboard. Then STOP before the v0.2.0 release gate.

FG-824: batch fix landed 4c8be86e (card never names --force; docs + CLAUDE.md corrected; tests extended, census exact 6/215), pushed. Docs stage running (fg824-review-docs). Then push any docs commit, ci-wait #355, continue --all with acceptance + docs-closeout, merge, close with grid, rm clone, restart dashboard, STOP before the v0.2.0 release gate.

FG-824: docs stage changed nothing; candidate 4c8be86e (pushed). ci-wait armed on #355. On green: continue --all --acceptance fg824/acceptance.json --docs-closeout fg824/docs-closeout.json on review-908b4477f731, merge #355, close FG-824 with grid, rm ~/code/forge-fg824, restart dashboard. Then STOP: v0.2.0 candidate rebuild/release gate is the operator's call.

FG-824 SHIPPED: merged #355 as f759e8d1, closed with acceptance grid; clone removed; dashboard restarted on main f759e8d1. v0.2.0 DASHBOARD TRANCHE COMPLETE: FG-818 (6be20c59), FG-819 (2fb6bd82), FG-820 (413c5bbb), FG-821 (eca5bc74), FG-822 (80089974), FG-823 (0a967a3a), FG-817 (029dcd44), FG-824 (f759e8d1). Picked up next: OPERATOR decides the v0.2.0 candidate rebuild + release gate (backlog/releases/v0.2.0.md) — not started by design. Open follow-ups: FG-815, FG-816, FG-825 (coordinator cannot adopt a non-finding correction; 3 occurrences, census miss is the recurring cause), FG-826 (dashboard integration tier hangs in containers; 3 occurrences). Stale mention noted by the maintainer: docs/research/competitive/paperclip-forge-recommendations.md cites duration.js (deleted by FG-824) — archival doc, untouched. Lessons applied tonight: npm ci in every forge-on-forge clone; new src/**/*.integration.test.ts needs the timings manifest refreshed via the canonical 'Measure integration timings' workflow_dispatch + artifact commit; a review has ONE remediation cycle — an env-caused inconclusive recheck is settled by rejected_premise with replayed_command evidence, never a second fix_now.

Housekeeping for the operator: older forge-on-forge clones from earlier sessions still exist at ~/code/forge-fg804, -fg805, -fg806, -fg807, -fg809, -fg813 (not touched tonight; check for unpushed work before removing).

FG-827 STARTED (operator: go, autonomous): clone ~/code/forge-fg827 on feat/fg-827-roles-second-pass at 37bcdd82; engineer running (launch-fg827-engineer-irp8gr, brief fg827/engineer.md, design dir fg827/design with Paperclip + Forge screenshots, run title 'FG-827 roles second pass'); npm ci running (launch-fg827-npm-ci-135of0). Chain: test-engineer -> docs -> commit/PR -> ci-wait -> review (contract to write) -> merge -> close -> restart dashboard. Still NOT starting the v0.2.0 release gate.

FG-827: engineer complete (task-engineer-cec711: 7430 tests, 2 load-timeout flakes in unrelated suites pass alone; 8 screenshots; census fg827 8 at 223; forge model resolve refactored onto src/v2/model-resolve-report.ts shared with the Harness tab). test-engineer launched (fg827-test-engineer). Then docs (fg827/docs.md), commit, PR, ci-wait, review (fg827/contract.json), merge, close, restart dashboard.

FG-827: test-engineer (task-test-engineer-9cbf8d) wrote 4 tests; 3 FAIL on real defects: constraint bytes not in Composed (source fidelity), activity_unmapped row dispatchable:true, Read view strips hostile HTML instead of escaping. Engineer follow-up running (launch-fg827-engineer2, fg827/engineer2.md). Then docs, commit, PR, ci-wait, review, merge, close.

FG-827: engineer fix complete (task-engineer-7e0267): Files panel carries composed section bytes (+raw when it differs), unmapped rows dispatchable:false from the shared report, Read view escapes hostile HTML; host run 40/40 on the fg827/fg817 dashboard suites. Docs maintainer running (fg827-docs). Then commit, PR, ci-wait, review, merge, close, restart dashboard.

FG-827: docs verified (task-documentation-maintainer-43a8ba; how-to-model-policy updated, rest verified). Committed 94bb1704, PR #356 open, ci-wait armed. On green: review start (fg827/contract.json, --evaluated-no-drift), dispositions, --all with acceptance + docs-closeout (final), merge, close with grid, rm clone, restart dashboard.

FG-827: CI green 15/15 at 94bb1704 (#356), ci-wait advanced; review starting (fg827-review-start). Then dispositions, fix batch if any (push coordinator commits; census check), --all with fg827/acceptance.json + docs-closeout.json, merge, close with grid, rm clone, restart dashboard.

FG-827 review review-0c9eaf317b31 at 94bb1704: RF-1/RF-2 (security shard could not see markdown.js — contract named markdown-render.js by mistake) rejected_premise with replayed escaping tests + anchor at markdown.js:14; RF-3 (stale nine-tabs comment in the census) fix_now, batch running (fg827-review-fix). After: push coordinator commit, ci-wait #356, docs stage, --all with acceptance + docs-closeout, merge, close, restart dashboard. Lesson: name the exact renderer file in the security scope.

FG-827: batch fix landed 956b9b74 (census comment + prose-parity test), pushed; docs stage running (fg827-review-docs); ci-wait armed on #356 at 956b9b74. Then push any docs commit (re-wait CI if so), --all with acceptance + docs-closeout, merge, close with grid, rm clone, restart dashboard.

FG-827: CI green 15/15 at 956b9b74; docs stage changed nothing; final stages running (fg827-review-all). On settled: merge #356, close FG-827 with grid, rm ~/code/forge-fg827, restart dashboard.

FG-827 SHIPPED: merged #356 as 83717cac, closed with acceptance grid; clone removed; dashboard restarted on main 83717cac. Picked up next: OPERATOR decides the v0.2.0 candidate rebuild + release gate (backlog/releases/v0.2.0.md) — not started by design; FG-827 landed after the tranche and belongs in the same release. Open follow-ups: FG-815, FG-816, FG-825 (3 occurrences), FG-826 (3), FG-797/FG-798 (skills registry; the Roles Skills tab has an empty 'available' section waiting for it). SOMEDAY: per-role budgets. Lesson: name the exact renderer/sanitizer file in a security lens scope (the FG-827 contract said markdown-render.js; the file is markdown.js, so the security shard could not see it). Older clones ~/code/forge-fg804..fg813 untouched.

FG-828 (sortable Roles list) filed and started: clone ~/code/forge-fg828 on feat/fg-828-roles-sort; engineer + npm ci launching. Chain: test-engineer -> docs (small; engineer edits CLAUDE.md/concepts) -> commit/PR -> ci-wait -> review (write fg828/contract.json: wide/frontend/backend; security only if a new input surface appears — the hash params are parsed client-side) -> merge -> close -> restart dashboard.

FG-828: engineer complete (task-engineer-a4315c: 7400 tests, 3 unrelated load failures pass alone; 2 screenshots; browser suite fg828-roles-sort 4 tests at 228; sort via ?sort=&dir= in the hash). test-engineer running (fg828-test-engineer). Then docs, commit, PR, ci-wait, review (fg828/contract.json, 3 lenses), merge, close, restart dashboard.

FG-828: test-engineer pass 1 (task-test-engineer-482291) +2 browser tests (suite 6 at 230); 1 failure was a wrong premise (my brief): #roles is scope:none by FG-817/FG-820 design so scope params drop there. Pass 2 launched (fg828-test-engineer2) to assert the route table's real contract; contract invariant corrected. Then docs, commit, PR, ci-wait, review, merge, close, restart dashboard.

FG-829 (role glyph tiles) filed from the approved mock (scratch fg829/design/glyphs.{html,png}); run AFTER FG-828 lands (same client modules). FG-828: docs maintainer running (fg828-docs), then commit, PR, ci-wait, review, merge, close.

FG-828: docs verified (task-documentation-maintainer-d6be27; how-to-testing updated). Committing + PR now; then ci-wait, review start (fg828/contract.json, 3 lenses, --evaluated-no-drift), dispositions, --all with acceptance + docs-closeout (final), merge, close with grid, rm clone, restart dashboard. Then FG-829 (glyph tiles) on a fresh clone from the new main.

FG-828: CI green 15/15 at da93956c (#357), ci-wait advanced; review starting (fg828-review-start, 3 lenses). Then dispositions, fix batch if any, --all with fg828/acceptance.json + docs-closeout.json, merge, close with grid, rm clone, restart dashboard, then FG-829 on a fresh clone.

FG-828 review review-e08d64d8f676 at da93956c: RF-1 inactive sort headers below AA contrast (inherit --fg-faint) -> fix_now, batch running (fg828-review-fix). After: check the fixer's diff (no browser suite change expected), push, ci-wait #357, docs stage, --all with acceptance + docs-closeout, merge, close, restart dashboard, then FG-829.

FG-828: contrast fix landed 7d63d202 (sort-header -> var(--fg-dim) + contrast unit test), pushed; docs stage running (fg828-review-docs); ci-wait armed on #357 at 7d63d202. Then --all with acceptance + docs-closeout, merge, close with grid, rm clone, restart dashboard, FG-829.

FG-828: CI green 15/15 at 7d63d202; docs stage changed nothing; final stages running (fg828-review-all). On settled: merge #357, close FG-828 with grid, rm ~/code/forge-fg828, restart dashboard, then FG-829 on a fresh clone (brief fg829/engineer.md ready, design dir fg829/design).

FG-828 SHIPPED: merged #357 as 6c43ef75, closed with grid; clone removed; dashboard restarted. FG-829 (role glyph tiles) starting on ~/code/forge-fg829 (feat/fg-829-role-glyphs from 6c43ef75; engineer + npm ci launching; briefs/contract in scratch fg829/). Chain: test-engineer -> docs -> commit/PR -> ci-wait -> review (4 lenses; security = inline SVG generator) -> merge -> close -> restart dashboard. v0.2.0 release gate still the operator's call.

FG-829: engineer complete (task-engineer-99246f: 7416 tests; 2 offline-boot timeouts under full tier, pass alone — CI arbitrates; 5 screenshots; suite fg829-role-glyphs 4 at 234). test-engineer launched (fg829-test-engineer). Then docs, commit, PR, ci-wait, review, merge, close, restart dashboard.

FG-829: test-engineer complete (task-test-engineer-1c0ca6: +1 browser test, suite 5 at 235, full tier 235/235, root 6041/6041). Docs maintainer running (fg829-docs). Then commit, PR, ci-wait, review (fg829/contract.json, 4 lenses), merge, close with grid, rm clone, restart dashboard.

FG-829: docs done (task-documentation-maintainer-864528: CLAUDE.md, concepts, how-to-new-agent, how-to-testing). Committing + PR; then ci-wait, review start (fg829/contract.json, --evaluated-no-drift), dispositions, --all with acceptance + docs-closeout (final), merge, close with grid, rm clone, restart dashboard.

FG-829: CI green 15/15 at a6e47f35 (#358), ci-wait advanced; review starting (fg829-review-start, 4 lenses). Then dispositions, fix batch if any, --all with fg829/acceptance.json + docs-closeout.json, merge, close with grid, rm clone, restart dashboard.

FG-829 review review-0a90213d1926 at a6e47f35: discovery clean (0 findings, 4 lenses). --all running (fg829-review-all). If the docs stage commits, push and re-wait CI before merge. On settled: merge #358, close FG-829 with grid, rm ~/code/forge-fg829, restart dashboard.

FG-829 SHIPPED: merged #358 as a8a59f82 (clean review, 0 findings), closed with grid; clone removed; dashboard restarted on main a8a59f82. Roles surface complete: FG-817 (029dcd44), FG-827 (83717cac), FG-828 (6c43ef75), FG-829 (a8a59f82) on top of the v0.2.0 tranche (FG-818..824). Picked up next: OPERATOR decides the v0.2.0 candidate rebuild + release gate (backlog/releases/v0.2.0.md) — not started by design; all twelve dashboard tickets since the Paperclip study belong in it. Open follow-ups: FG-815, FG-816, FG-825 (3 occurrences), FG-826 (3), FG-797/FG-798 (skills registry -> Roles Skills 'available' section). SOMEDAY: per-role budgets. Older clones ~/code/forge-fg804..fg813 untouched.

Operator filed 9 tickets today (FG-830..FG-838; FG-833 is an idea awaiting 4 decisions). Working lanes: DASHBOARD serial FG-831 (running, launch-fg831-engineer-1novzt, clone ~/code/forge-fg831) -> FG-832 -> FG-830 -> FG-838 -> FG-836 -> FG-837 -> FG-834 -> FG-835 editor; CLI lane parallel FG-835 part 1 (running, launch-fg835-engineer-cli-filnwe, clone ~/code/forge-fg835; new src/cli integration files => refresh timings manifest via the canonical workflow). Standard chain per ticket; briefs in scratch fg8xx/; lessons block in scratch lane/lessons.md.

FG-835 part 1: engineer complete (task-engineer-567764: propose/apply gate, atomic-write util, audit, backup; 6072 tests; 1 new src/cli integration file => timings refresh needed before PR CI). test-engineer launched (fg835-test-engineer). Then docs, commit, PR, timings workflow_dispatch + artifact commit, ci-wait, review (contract to write: lenses wide/backend/security; security = model-policy-gate.ts, atomic-write.ts, model.ts), merge, close part 1 (ticket stays open for the editor), re-plan the editor pass.

FG-835 part 1: test-engineer pass 1 (task-test-engineer-95360d) +4 enforcement tests; 1 failed on a byte-equality premise (apply-without-confirm prints an 'apply' heading + 'Not applied' line by design) — pass 2 launched to assert gate/diff equality instead; docs maintainer running in parallel (docs/** only). Then commit, PR, timings workflow_dispatch (2 new src/cli integration files), artifact commit, ci-wait, review (fg835/contract.json), merge, leave FG-835 open for the editor pass.

FG-831: engineer complete (task-engineer-0bec4d: labels path·branch, primary marked, show-N-missing, realpath dedupe, forge projects prune --missing with a NEW additive table pruned_checkouts (machine-wide DB; CREATE TABLE IF NOT EXISTS, no user_version bump) — engineer wrote no parity test; test-engineer brief demands it). test-engineer launched (fg831-test-engineer). FG-835 part 1: pass-3 test correction running (fg835-test-engineer3); docs done (task-documentation-maintainer-076b0f: how-to-model-policy, invariants 7).

FG-835 part 1: tests 14/14 on host; committing + PR; timings measurement dispatched on the branch (2 new src/cli integration files). Then download artifact -> commit -> ci-wait -> review start (fg835/contract.json) -> merge -> record part-1 evidence on the ticket (stays open for the editor).

FG-831: docs verified (task-documentation-maintainer-c5601f); committing + PR; then ci-wait, review start (fg831/contract.json), --all with acceptance + docs-closeout (final), merge, close, rm clone, restart dashboard, then FG-832 on a fresh clone. FG-835 part 1: PR #359 at 53aae8ee; timings run 36663236979 in progress (ci-wait armed).

FG-831: CI red on dashboard_integration — one FG-595 test asserts deleted scratchpads are SUPPRESSED from the registry (old contract); FG-831 keeps them flagged missing by design. Engineer follow-up running (fg831-engineer2) to update that test; then commit, push, ci-wait, review. FG-835 timings run still in progress.

FG-831: test-contract update passes on Linux but fails on macOS (raw /var lookup vs canonical /private/var registry roots) — engineer follow-up 3 running (fg831-engineer3) to realpath the test's expected paths (and product if it compares raw vs canonical). Then commit, push, ci-wait #360, review.

FG-831: test corrections (registry contract + realpath) 12/12 on host; committing + push; ci-wait #360 re-armed. FG-835 timings run still in progress.

FG-831: CI green 15/15 at 5b8a8de9 (#360); review starting (fg831-review-start). Then dispositions, fix batch if any, --all with acceptance + docs-closeout, merge, close, rm clone, restart dashboard, then FG-832 (brief ready). FG-835 timings run 36663236979 still in progress.

FG-831 review review-882fc68094c7 at 5b8a8de9: RF-1/RF-2 (frontend red ran the browser suite from repo root; alias unresolved) rejected_premise with a host replay 4/4 from the dashboard dir; RF-3 wide inconclusive rejected_premise. --all running (fg831-review-all). On settled: merge #360, close FG-831 with grid, rm clone, restart dashboard, FG-832. Lesson for the frontend red brief/contract: name the dashboard-dir invocation in the contract's threat_model or lens notes.

FG-831 SHIPPED: merged #360 as 73878609, closed with grid; clone removed; dashboard restarted. FG-832 dispatched on ~/code/forge-fg832 (feat/fg-832-backlog-default-filter from 73878609). FG-835 part 1: PR #359 at 53aae8ee awaiting timings run 36663236979 (in progress ~55 min). Dashboard lane after FG-832: FG-830 -> FG-838 -> FG-836 -> FG-837 -> FG-834 -> FG-835 editor.

FG-835 part 1: timings manifest refreshed (346/346) committed cf429a81, pushed; ci-wait armed on #359. On green: review start (fg835/contract.json; scopes wide/backend/security; changed paths incl. scripts/integration-timings.json under wide), --all with acceptance + docs-closeout, merge, record part-1 evidence on FG-835 (ticket stays open for the editor). FG-832 engineer running.

FG-835 part 1: CI green 15/15 at cf429a81 (#359); review starting (fg835-review-start, lenses wide/backend/security). On settled: merge #359, record part-1 acceptance evidence on FG-835 (ticket stays OPEN for the editor, AC 2-8), rm clone. FG-832: test-engineer running.

FG-835 review review-621ad726837f at cf429a81: RF-1 audit-before-rename (audit can lie), RF-2 no CAS/lock between gate and write, RF-3 --project .forge symlink can redirect the write to the host policy — all fix_now in ONE batch (fg835-review-fix); RF-4 wide inconclusive rejected. After the batch: push, ci-wait #359 (if the fixer adds a src/cli integration FILE, refresh timings again; tests added to existing files need nothing), docs stage, --all, merge.

FG-832: docs verified (task-documentation-maintainer-5e2355); committing + PR; then ci-wait, review (fg832/contract.json, 3 lenses), merge, close, rm clone, restart dashboard, then FG-830 (brief ready). FG-835 batch fix still running.

FG-835 part 1: batch fix landed e49f55c3 (CAS + lock, escape guard, audit ordering; no new integration files), pushed; docs stage running (fg835-review-docs); ci-wait on #359 next. Then --all with acceptance + docs-closeout, merge, record part-1 evidence. FG-832: PR #361 ci-wait armed.

FG-832: CI red — fg832-backlog-filter.test.ts mkdirSync('/task/screenshots') at module scope (EACCES on the runner) so the file fails to load and the FG-642 guard reports 239/244. test-engineer pass 2 running (fg832-test-engineer2) to default to mkdtemp + env override. Then commit, push, ci-wait, review. Recurring miss despite the lessons block — consider a lint/guard test that greps browser-tests for a hardcoded /task/screenshots.

FG-832: screenshot-dir fix committed + pushed; ci-wait re-arming on #361. FG-835 part 1: docs cycle moved candidate to df1bcd75 (how-to-model-policy + invariants), pushed; ci-wait re-arming on #359; then --all with acceptance + docs-closeout, merge, record part-1 evidence. FG-839 filed (browser-tier content guard).

FG-832: CI green 15/15 at 7cc93eee (#361); review starting (fg832-review-start, 3 lenses). On settled: merge #361, close with grid, rm clone, restart dashboard, then FG-830 (brief ready). FG-835 part 1: CI at df1bcd75 in progress (#359).

FG-835 part 1: CI green 15/15 at df1bcd75; --all running (fg835-review-all). On settled: merge #359, record part-1 evidence on FG-835 (stays open), rm clone. FG-832 review discovery running.

FG-832 review review-588c77234246 at 7cc93eee: RF-1 (census comment claims a Backlog badge) fix_now, batch running (fg832-review-fix). Then push, ci-wait #361, docs stage, --all, merge, close, restart dashboard, FG-830. FG-835 --all running.

FG-832: batch fix (census comment) landed 80cc860d, pushed; docs stage running; ci-wait armed on #361 at 80cc860d. Then --all with acceptance + docs-closeout, merge, close, restart dashboard, FG-830. FG-835 --all still running.

FG-835 part 1: recheck resolved RF-1..3; new RF-5 (post-check symlink swap TOCTOU) deferred to FG-697 (second call site recorded there); --all re-driven (fg835-review-all2). On settled: merge #359, record part-1 evidence on FG-835. FG-832: docs stage + ci-wait at 80cc860d armed.

FG-835 PART 1 SHIPPED: merged #359 as 10ace122; part-1 evidence recorded on the ticket (stays open for the editor); clone removed; host main pulled (verbs live). CLI/backend lane now: FG-836 part 1 (query rewrite + covering index + budget test; no client) on ~/code/forge-fg836. Dashboard lane: FG-832 at 80cc860d awaiting CI then --all/merge; then FG-830 -> FG-838 -> FG-836 part 2 (loading state) -> FG-837 -> FG-834 -> FG-835 editor.

FG-832: CI green at 80cc860d; --all running (fg832-review-all). On settled: merge #361, close with grid, rm clone, restart dashboard, then FG-830 on a fresh clone. FG-836 part 1 engineer running.

FG-832 SHIPPED: merged #361 as 9ee88b7d, closed with grid; clone removed; dashboard restarted. FG-830 dispatched on ~/code/forge-fg830 (feat/fg-830-notes-view from 9ee88b7d). FG-836 part 1 engineer running on the backend lane. Shipped today so far from the new batch: FG-831, FG-832, FG-835 part 1.

FG-836 part 1: engineer complete (task-engineer-281b60: set-based rewrite, additive index idx_events_task_type_created (machine-wide DB, parity extended), golden old-vs-new test with mutation checks, budget test; client untouched). test-engineer launched (fg836-test-engineer). Then docs (SCHEMA-CONTRACT verify), commit, PR, ci-wait, review (contract to write: wide/backend/security; security = schema.ts + queries.ts), merge, record part-1 evidence; part 2 (loading state, hash window) later in the dashboard lane.

FG-836 part 1: docs verified (task-documentation-maintainer-3c919b); committing + PR; then ci-wait, review (fg836/contract.json), merge, record part-1 evidence (ticket stays open for part 2 loading state). FG-830 engineer running.

FG-830: engineer complete (task-engineer-b01df9: Notes under Plan, #notes[/<checkout>], GET /api/notes, Backlog stripped of notes; 7501 tests; suite 6 at 250). test-engineer launched (fg830-test-engineer). FG-836 part 1: PR #362 at edad51af, ci-wait armed.

FG-836 part 1: CI green at edad51af (#362); review starting (fg836-review-start, 3 lenses). On settled: merge #362, record part-1 evidence on FG-836 (stays open for part 2), rm clone, restart dashboard (the index lands on the next writable open — run a writable forge command after merge). FG-830 test-engineer running.

FG-836 part 1 review review-05e8bd94eafe at edad51af: backend + security clean; wide inconclusive rejected. --all running (fg836-review-all). On settled: merge #362, record part-1 evidence, rm clone, restart dashboard + run a writable forge command so the index is created. FG-830 test-engineer running.

FG-836 PART 1 SHIPPED: merged #362 as 6a3febfd (this writable command creates idx_events_task_type_created on the host store); part-1 evidence on the ticket (open for part 2: loading state + hash window). Clone removed. Restarting dashboard and measuring the real endpoints next.

FG-836 part 1 measured live on the host store after merge (index present): agent-runtime 7d 1.1s (cold), 30d 0.13s, 90d 0.28s; /api/ops 0.04s — from 58s/4s/47s/64s. Dashboard restarted on 6a3febfd. Shipped from the new batch: FG-831, FG-832, FG-835 pt1, FG-836 pt1. Dashboard lane: FG-830 test-engineer running -> docs -> PR -> review -> merge; then FG-838 (brief ready) -> FG-836 pt2 -> FG-837 -> FG-834 -> FG-835 editor.

FG-830: test-engineer done (task-test-engineer-7338a7: +1 integration file, +2 browser tests; suite 8 at 252; status 'failed' only because the forge-test wrapper was blocked in the container scratch — every real run green). Docs maintainer running (fg830-docs). Then commit, PR, ci-wait, review (fg830/contract.json), merge, close, restart dashboard, then FG-838.

FG-830: docs verified (task-documentation-maintainer-2da245); committing + PR; then ci-wait, review (fg830/contract.json, 4 lenses), merge, close with grid, rm clone, restart dashboard, then FG-838 (brief ready).

FG-830: CI green at b76778ea (#363); review starting (fg830-review-start, 4 lenses). On settled: merge #363, close with grid, rm clone, restart dashboard, then FG-838 on a fresh clone (brief ready).

FG-830 review review-71626608a142 at b76778ea: RF-1 read-then-stat race (content vs mtime), RF-2 unanchored session-date matcher, RF-3 IA matrix missing the Notes row — all fix_now in one batch (fg830-review-fix). After: check the fixer's diff for census changes, push, ci-wait #363, docs stage, --all, merge, close, restart dashboard, FG-838.

FG-830: batch fix landed 7c02c110 (fd-based note read, anchored matcher, IA row; suite counts unchanged), pushed; docs stage launching; ci-wait on #363 at 7c02c110 next. Then --all, merge, close, restart dashboard, FG-838.

FG-830: CI green at 7c02c110; --all running (fg830-review-all). On settled: merge #363, close with grid, rm clone, restart dashboard, then FG-838 on a fresh clone.

FG-830 SHIPPED: merged #363 as 83bfbe77, closed with grid; clone removed; dashboard restarted. FG-838 dispatched on ~/code/forge-fg838 (feat/fg-838-header-guidance from 83bfbe77). Shipped from the new batch: FG-831, FG-832, FG-830, FG-835 pt1, FG-836 pt1. Remaining lane: FG-838 -> FG-836 pt2 -> FG-837 -> FG-834 -> FG-835 editor; FG-839 (guard) can run on the backend lane next; FG-833 idea awaits operator decisions.

FG-839 (browser-tier content guard) dispatched on the backend lane: ~/code/forge-fg839, feat/fg-839-browser-tier-guard from 83bfbe77 (launch-fg839-engineer-led8j7). FG-838 engineer running on the dashboard lane; its contract/briefs staged.

FG-839: engineer complete (task-engineer-0855c4: guard test, fail-first names missing suites, how-to-testing rules; 6060 tests). test-engineer launched (fg839-test-engineer). Then docs (maintainer also carries the two rules into the implementer seeds' validation section), commit, PR, ci-wait, review (contract: wide/backend), merge, close. FG-838 engineer running.

FG-838: engineer complete (task-engineer-c354d6: info-tip module, static lines removed from every list view, object headers keep live facts; suite 5 at 257; 2 offline-boot flakes pass alone). test-engineer launched (fg838-test-engineer). FG-839 test-engineer running on the backend lane.

FG-839: test-engineer done (task-test-engineer-7619cc: +1 fail-first naming case; guard 6/6; 6059 root tests). Docs maintainer running (fg839-docs; also carries the two rules into implementer seeds). Then commit, PR, ci-wait, review (fg839/contract.json, wide/backend), merge, close. FG-838 test-engineer running.

FG-839: docs + seeds done (task-documentation-maintainer-2a79ee); committing + PR; then ci-wait, review (fg839/contract.json), merge, close, rm clone. Note: seeds/agents changes ship via forge upgrade on hosts. FG-838 test-engineer running.

FG-839: CI integration_serial job was CANCELLED by a runner shutdown signal (infra, not a test); re-ran failed jobs on run 36674302959; ci-wait re-arming on #364.

FG-839: CI green after the infra re-run at 990d97b1 (#364); review starting (fg839-review-start, wide/backend). On settled: merge #364, close with grid, rm clone. FG-838 test-engineer still running.

FG-838: test-engineer done (task-test-engineer-870797: +2 browser tests; suite 7 at 259; full tier green apart from the offline-boot container limitation). Docs maintainer launching. Then commit, PR, ci-wait, review (fg838/contract.json, 3 lenses), merge, close, restart dashboard, then FG-836 part 2. FG-839 review in discovery.

FG-838: docs verified (task-documentation-maintainer-49745c); committing + PR; then ci-wait, review (fg838/contract.json), merge, close, restart dashboard, then FG-836 part 2 (brief in scratch fg836b/). FG-839 review discovery running.

FG-839 review review-58029e4c7a39 at 990d97b1: backend clean; wide inconclusive rejected; --all running (fg839-review-all). On settled: merge #364, close with grid, rm clone. FG-838: PR #365 at 63fa49b6, ci-wait armed.

FG-839 SHIPPED: merged #364 as 1a04dd80, closed with grid; clone removed; host main pulled. Note: seeds/agents changed — the published generation on this host picks it up on the next forge upgrade (operator's call; not run). Backend lane free. Dashboard lane: FG-838 at PR #365 awaiting CI, then FG-836 part 2 -> FG-837 -> FG-834 -> FG-835 editor.

FG-834 part 1 (server: raci propose/apply registry rows + GET /api/raci) dispatched on the backend lane: ~/code/forge-fg834, feat/fg-834-raci-routes from 1a04dd80 (launch-fg834-engineer-lepxwt). Part 2 (editor UI) later on the dashboard lane after FG-837. FG-838 at PR #365 awaiting CI.

FG-838: CI green at 63fa49b6 (#365); review starting (fg838-review-start, 3 lenses). On settled: merge #365, close with grid, rm clone, restart dashboard, then FG-836 part 2 on a fresh clone (brief scratch fg836b/engineer.md). FG-834 part 1 engineer running on the backend lane.

FG-838 review review-a1330a7c866b at 63fa49b6: RF-1 click-outside close loses focus -> fix_now (batch running fg838-review-fix); RF-2 wide inconclusive rejected. After: check census on any added browser test, push, ci-wait #365, docs stage, --all, merge, close, restart dashboard, FG-836 part 2. FG-834 part 1 engineer running.

FG-838: focus-return fix landed 3291c59a (census unchanged at 7/259), pushed; docs stage running; ci-wait armed on #365 at 3291c59a. Then --all with acceptance + docs-closeout, merge, close, restart dashboard, FG-836 part 2. FG-834 part 1 engineer running.

FG-834 part 1: engineer complete (task-engineer-7fc073: raci-mutation.ts rows for propose/apply with proposal window + typed confirm; GET /api/raci; client untouched; 7294 tests). Follow-up running (fg834-engineer2) to record the rationale (--rationale on forge raci apply) and candidate sha in the audit line. Filed the pre-existing /api/governance audit-log drift as its own ticket. FG-838 at 3291c59a awaiting CI.

FG-838: CI green at 3291c59a; --all running (fg838-review-all). On settled: merge #365, close with grid, rm clone, restart dashboard, then FG-836 part 2 on a fresh clone. FG-834 follow-up (rationale) running.

FG-838 SHIPPED: merged #365 as 2e92c209, closed with grid; clone removed; dashboard restarted. FG-836 part 2 (loading state, hash window) dispatched on ~/code/forge-fg836b (feat/fg-836-ops-loading from 2e92c209). Shipped from the new batch: FG-831, FG-832, FG-830, FG-838, FG-839, FG-835 pt1, FG-836 pt1. Remaining: FG-836 pt2 (running) -> FG-837 -> FG-834 pt2 editor -> FG-835 pt2 editor; FG-834 pt1 follow-up running on the backend lane; FG-840 filed; FG-833 idea awaits decisions.

FG-834 part 1: follow-up complete (task-engineer-5b2f82: --rationale/--source on forge raci apply, audit carries rationale + candidate_sha256; 16/16 route tests on host). test-engineer launched (fg834-test-engineer). Then docs (ADR revising FG-591 D2 + invariant 15), commit, PR, ci-wait, review (fg834/contract.json), merge, record part-1 evidence. FG-836 part 2 engineer running.

FG-834 part 1: committed + pushed as PR #366 (feat/fg-834-raci-routes, clone ~/code/forge-fg834), ci-wait ciwait-b82937505acb armed. Next: review start with fg834/contract.json (lenses wide/backend/security, refs AC 2/3/6 server half + AC 5), acceptance.json + docs-closeout.json staged, merge, record part-1 evidence; ticket stays open for part 2 editor UI.

FG-834 review review-a6591cfb8c32: RF-1 (proposal consumed outside slot) + RF-3/RF-4 (ADR wording) fix_now in one batch (launch-fg834-review-fix-9b7b7d); RF-2 deferred to FG-840 AC 4 (audit attribution is a claim; operator picks label-vs-token). After fix: push coordinator commit, docs stage with fg834/docs-closeout.json, ci-wait, continue --all with acceptance.json, merge PR 366. FG-836 part 2: engineer pass 1 complete (runtime chart), test-engineer running (launch-fg836b-test-engineer-dwx07n); second engineer pass staged at fg836b/engineer2.md for the Ops summary since-control (hash + showing label + loading) — dispatch after the test-engineer.

FG-836 part 2: test-engineer done (task-test-engineer-557e88: regression test for late-resolving aborted refresh + 1 browser case; census 45/266). Second engineer pass launched (launch-fg836b-engineer2-5zysmz) for the Ops summary since-control (hash since=, showing label, loading state). Then: bounded test-engineer on the delta, docs (fg836b/docs.md — add since= param), commit/PR, ci-wait, review (fg836b/contract.json), merge, close FG-836 with grid for AC 3/4/6/7.

FG-834 part 1 MERGED 4a62e1ea (#366); part-1 evidence recorded on the ticket, which stays open for part 2 (editor UI). Clone removed, host on main, dashboard restarted. RF-2 (audit attribution is a claim) parked on FG-840 AC 4 for the operator. FG-836 part 2: engineer2 (since-control) running.

FG-834 part 2 prepared: approved mock at scratchpad fg834/design/edit-raci-mock.{html,png} (+ live-routing.png), brief fg834/engineer-part2.md, contract fg834/contract-part2.json; clone ~/code/forge-fg834b on feat/fg-834-raci-editor (npm ci launched). Dispatch with --design-dir fg834/design once the FG-836 dashboard lane closes. FG-836 part 2: second test-engineer running (launch-fg836b-test-engineer2-skc6r5).

FG-835 part 2a (server half: model-policy propose/apply registry rows + GET /api/model-policy + apply --rationale/--source) launched: engineer launch-fg835b-engineer-qrsasa, clone ~/code/forge-fg835b on feat/fg-835-model-policy-routes (npm ci launch-fg835b-npm-ci-tky59w). Brief at scratchpad fg835b/engineer.md. After it: test-engineer, docs, PR, ci-wait, review, merge, record part-2a evidence; part 2b (editor UI) needs a mock (live-config.png captured at fg835/design).

FG-836 part 2: PR #367 open (feat/fg-836-ops-loading, clone ~/code/forge-fg836b), ci-wait armed. Next on green CI: forge review start FG-836 --contract fg836b/contract.json (lenses wide/frontend; refs AC 3/4/6/7) --project ~/code/forge-fg836b --run run-fg-836-ops-loading-state-80a921; acceptance.json + docs-closeout.json staged; merge; close FG-836 with grid (AC 1/2/5 evidence already on the ticket from part 1).

FG-835 part 2a: engineer complete (task-engineer-f28bdd: model-policy-mutation.ts routes, GET /api/model-policy with Harness-shared rows, apply --rationale/--source; run run-fg-835-model-policy-routes-6b4bf5). test-engineer launching (fg835b/test-engineer.md); contract at fg835b/contract.json (refs AC 4/6 server half + AC 5). Then docs (invariants/ADR/concepts are part 2b), PR, ci-wait, review, merge, record part-2a evidence.

FG-836 part 2: PR #367 CI green (15/15), review started (launch-fg836b-review-start-tcudip). FG-835 part 2a test-engineer running (launch-fg835b-test-engineer-2kvp51).

FG-836 review review-4383cece4bbd: wide shard inconclusive (client paths scoped to frontend lens, whose shard passed) — RF-1/RF-2 rejected_premise with replayed browser suite 13/13 at 6ce8930e; docs stage running (launch-fg836b-review-docs-1qfz3r); then ci-wait if the candidate moves, --all with fg836b/acceptance.json, merge #367, close FG-836. FG-835 part 2a: test-engineer done (5 enforcement tests), docs pass launching; then commit/PR, ci-wait, review, merge, record evidence.

FG-836: docs stage moved candidate to cbe42f69 (pushed); ci-wait ciwait-97a2a6a062ab armed on #367. On green: forge review continue review-4383cece4bbd --all --acceptance fg836b/acceptance.json --docs-closeout fg836b/docs-closeout.json, merge, close.

FG-835 part 2a: PR #368 open (feat/fg-835-model-policy-routes, clone ~/code/forge-fg835b), ci-wait ciwait-a8d172f98582 armed. On green: review start FG-835 --contract fg835b/contract.json (wide/backend/security; refs AC 4/6 server half + AC 5) --project ~/code/forge-fg835b --run run-fg-835-model-policy-routes-6b4bf5; acceptance.json + docs-closeout.json staged; merge; record part-2a evidence (ticket stays open for 2b).

FG-836 CLOSED at 1f4c64c9 (#367) with the AC 3/4/6/7 grid; clone removed; dashboard restarted. FG-834 part 2 (RACI editor UI) dispatching on the dashboard lane: clone ~/code/forge-fg834b (feat/fg-834-raci-editor, reset to main 1f4c64c9), brief fg834/engineer-part2.md, design fg834/design (edit-raci-mock.png), contract fg834/contract-part2.json. FG-835 part 2a: PR #368 CI green, review started (launch-fg835b-review-start-5t2fiu).

FG-835 review review-6308fad9dd6f at a9ba37eb: backend shard pass; security + wide shards inconclusive (guards/resolveCheckoutDir are unchanged files outside the diff shard) — replaying enforcement + routes integration suites (launch-fg835b-replay-v4cx2o) to reject both with replayed_command evidence, then continue --docs-closeout fg835b/docs-closeout.json, ci-wait #368 if the candidate moves, --all with fg835b/acceptance.json, merge, record part-2a evidence.

FG-835 review review-6308fad9dd6f: RF-1/RF-2 (security + wide shard inconclusives) rejected_premise with replayed 17/17 FG-835 cases at a9ba37eb; docs stage running (launch-fg835b-review-docs-q6xzy7). OBSERVED (n=1, not filed): fg834-raci-enforcement.test.ts:192 'four shared mutation slots are occupied' fails (0 vs 4) when the whole dashboard unit tier runs on the host in one npm run, passes 4/4 alone and in CI — interference in the combined host run; watch for recurrence before filing. FG-834 part 2 engineer running (launch-fg834b-engineer-2shj88).

FG-835: docs stage moved candidate to dbf391f8 (pushed); ci-wait ciwait-6a91e20d07f9 on #368. On green: forge review continue review-6308fad9dd6f --all --acceptance fg835b/acceptance.json --docs-closeout fg835b/docs-closeout.json, merge #368, record part-2a evidence on FG-835 (stays open for 2b).

FG-835 review: recheck at dbf391f8 surfaced RF-3 (invariants.md wording attributes the dashboard's propose/typed-key/rationale preconditions to the terminal CLI) — fix_now, fix batch running (launch-fg835b-review-fix-tmrjga). After: push the coordinator commit, docs stage (--docs-closeout fg835b/docs-closeout.json), ci-wait #368, --all with fg835b/acceptance.json, merge, evidence from fg835b/evidence-part2a.md.

FG-835 review: RF-3 deferred to FG-835 part 2b (AC 8 invariants wording; requirement appended to the ticket body) because the single remediation window had closed; final stages re-running (launch-fg835b-review-final2-95qba9). Then merge #368 at dbf391f8 and record evidence from fg835b/evidence-part2a.md.

FG-835 part 2a MERGED 96ad22e8 (#368); evidence recorded on the ticket (stays open for 2b: editor UI + AC 8 wording incl. RF-3). Clone removed, host on main, dashboard restarted. Backend lane free. FG-834 part 2 engineer still running (launch-fg834b-engineer-2shj88).

FG-840 (AC 1-3 only; AC 4 audit-attribution is the operator's call) launched on the backend lane: engineer launch-fg840-engineer-le746n, clone ~/code/forge-fg840 on fix/fg-840-governance-audit-source from 96ad22e8, brief scratchpad fg840/engineer.md. Note: it edits governance.js RECORDED section minimally while FG-834 part 2 rewrites the rest — whichever merges second rebases; a conflict goes to an engineer pass. FG-833 stays an idea parked on four operator decisions (which fit-now verbs, durable-launch kind scope, default filter, approve rationale storage).

FG-834 part 2: engineer complete (task-engineer-b764fb on run run-fg-834-raci-editor-7c63fa; editor matches the mock; 4 side-by-side screenshots; census 46/277; #routing?mode=edit; small server read-model additions: GET /api/raci host text + propose --json candidateRoutes). test-engineer launching; contract fg834/contract-part2.json widened to wide/frontend/backend/security. Then docs, PR, ci-wait, review, merge, close FG-834 with the full grid.

FG-840: engineer complete (task-engineer-950c94 on run run-fg-840-governance-audit-source-8ee401: shared reader dashboard/src/raci-audit.ts, governance recorded section carries source/path, GET /api/raci reuses it). test-engineer launching; then docs, PR, ci-wait, review (fg840/contract.json wide/backend/frontend), merge, evidence for AC 1-3 (AC 4 open for the operator). FG-834 part 2 test-engineer running (launch-fg834b-test-engineer-0tyjxq).

FG-840: test-engineer done (5 tests incl. one browser case in fg820-left-column-nav; census bumped). Docs pass launching; then commit/PR, ci-wait, review, merge. NOTE: FG-840 and FG-834 part 2 both bump src/util/browser-tier-census.ts + docs/how-to-testing.md totals — the second to merge must rebase (engineer pass if it conflicts).

FG-840: docs reconciled; committing + PR now; ci-wait registered. On green: review start FG-840 --contract fg840/contract.json (wide/backend/frontend) --project ~/code/forge-fg840 --run run-fg-840-governance-audit-source-8ee401; acceptance.json + docs-closeout.json staged; merge; evidence for AC 1-3; ticket stays open for AC 4 (operator).

FG-834 part 2: test-engineer done (task-test-engineer-53fd29; unit 13/13, browser 5 cases, census 46/277). Docs pass launching (fg834/docs-part2.md). Then commit/PR, ci-wait, review (fg834/contract-part2.json), merge, close FG-834 with the full grid. FG-840: PR #369 in CI (ciwait-34240f96652b).

FG-834 part 2: docs reconciled; committing + PR now. On green: review start FG-834 --contract fg834/contract-part2.json --project ~/code/forge-fg834b --run run-fg-834-raci-editor-7c63fa; continue with acceptance-part2.json + docs-closeout-part2.json; merge; close with fg834/close-grid.md (fill MERGE_SHA/FINAL_SHA/REVIEW_ID). FG-840 PR #369 in CI.

FG-840: PR #369 CI green (15/15); review started (launch-fg840-review-start-5kbwgm). FG-834 part 2: PR #370 in CI (ciwait-b8b6551d9551).

FG-840 review review-d53bce31ea83 at 5ebfb777: RF-1 (symlink containment on the scoped log read) + RF-2 (rows read actor, DTO field is by) fix_now; RF-3 wide inconclusive → replay running (launch-fg840-replay-47a5dj) for rejected_premise; then continue (fix batch), push, docs stage, ci-wait #369, --all with fg840/acceptance.json, merge, evidence from fg840/evidence.md.

FG-834 part 2: PR #370 CI green (15/15); review started (launch-fg834b-review-start-pi63d0). FG-840: replay for RF-3 running.

Filed FG-841 (fg834-raci-enforcement slot-occupancy assertion fails only in a combined host unit-tier run; n=2 at a9ba37eb and 5ebfb777; passes alone and in CI). FG-840 review: RF-3 rejected (9/9 replay), fix batch running for RF-1/RF-2 (launch-fg840-review-fix-d196kc). FG-834 part 2 review discovery running (launch-fg834b-review-start-pi63d0).

FG-834 part 2 review review-79bfd4c1de49 at b836efba: RF-1 (Edit RACI button inert in edit mode) + RF-2 (how-to per-project state sentence) fix_now, batch running (launch-fg834b-review-fix-pzh4kw). After: push coordinator commit, docs stage with fg834/docs-closeout-part2.json, ci-wait #370, --all with fg834/acceptance-part2.json, merge, close with fg834/close-grid.md.

FG-834 part 2: fix batch committed 662225ba (pushed); docs stage running (launch-fg834b-review-docs-kxt0wg); ci-wait registered on #370 for the fix sha. FG-840 fix batch still running (launch-fg840-review-fix-d196kc).

FG-840: fix batch committed 7fff1a83 (realpath containment on the scoped log read; attribution field normalized; pushed); docs stage running (launch-fg840-review-docs-hdk2qo); ci-wait ciwait-228e6d69456f on #369. FG-834 part 2: docs stage running, ci-wait on #370 for 662225ba.

FG-834 part 2: docs stage changed nothing; candidate stays 662225ba; waiting on #370 CI (ciwait-40cea08bcc76), then continue --all with fg834/acceptance-part2.json + docs-closeout-part2.json, merge, close with fg834/close-grid.md (FINAL_SHA=662225ba).

FG-840: docs stage moved candidate to 460c79aa (pushed); CI re-running on #369. On green: continue --all with fg840/acceptance.json + docs-closeout.json, merge, evidence (FINAL_SHA=460c79aa, REVIEW_ID=review-d53bce31ea83).

FG-834 part 2: #370 CI green at 662225ba; final review stages running (launch-fg834b-review-final-f7jwao); then merge #370 and close FG-834 with fg834/close-grid.md. FG-840: #369 CI re-running at 460c79aa (ciwait-228e6d69456f).

FG-840: CI RED at 460c79aa — the review fixer's realpathSync in dashboard/src/raci-audit.ts trips the FG-693 single-canonicalizer guard (test + fg693_alias_identity + test-extended). Remediation window is spent, so: engineer pass to route containment through src/util/path-identity.ts (fg840/engineer-fix.md), hand commit + push, CI green, then a FRESH forge review start FG-840 with fg840/contract.json (FG-823 precedent). FG-834 part 2: recheck said RF-1 still_present because the rechecker container's browser file failed at load (71 ms, no Chrome); host replay running (launch-fg834b-browser-replay-kgi2sg) — on pass, re-disposition RF-1 rejected_premise with the replay, then continue --all, merge #370, close.

FG-834 part 2: RF-1 re-dispositioned rejected_premise (control rendered disabled at 662225ba; CI dashboard_browser passed all 5 cases at that sha; the rechecker container failed the file at load, no Chrome). Final stages re-running (launch-fg834b-review-final2-n8773a). HOST-ONLY observation (n=1, not filed): fg834-raci-editor browser cases 'edit a route…' and 'Reset to host default…' time out on the host waiting for .raci-tag-changed even alone, while the clone's bin/forge propose answers in 1 s with candidateRoutes — likely the rig's seed apply (stdio ignored) failing on this host; CI and the container pass. FG-840: guard fix committed (path-identity containment), pushed; ci-wait on #369; then a FRESH review start.

FG-834 part 2 shipping stage refused AC 2/4/6: the host verification runs the browser suite on the HOST, where 'edit a route…' and 'Reset to host default…' time out (20 s waiting for .raci-tag-changed) although the rig's seed apply succeeds and the clone's propose answers in 1 s; CI dashboard_browser passed all 5 at 662225ba. Re-cited AC 2/4/6 with host-executed unit tests from fg834-raci-editor.test.ts; final stages re-running (launch-fg834b-review-final3). Host-only browser discrepancy unexplained (n=1) — if it recurs, file it next to FG-841.

FG-834 CLOSED at a2aac5e9 (#370) with the full grid; clone removed; dashboard restarted. Dashboard lane free: next FG-835 part 2b (model-policy editor; needs a mock — live-config.png captured at fg835/design) then FG-837. FG-840: #369 CI running on the guard fix f51d8428, then a fresh review start.

FG-840: #369 CI green at f51d8428 (guard fix); fresh review starting (second review of the branch). FG-835 part 2b: clone ~/code/forge-fg835c (feat/fg-835-model-policy-editor from a2aac5e9, npm ci launched); mock drafted at fg835/design/models-editor-mock.{html,png} (new Setup › Models page: source line, quick-edit cards, YAML editor + resolution table, proposal diff, typed-target apply, backups with Restore, recorded).

FG-840: PR #369 is CONFLICTING with main after FG-834 part 2 (census, how-to-testing totals, governance.js). Stopped the premature second review start (killed PID 19065 of launch-fg840-review2-start-qiua6u — check forge review list for a partial FG-840 review row to ignore). Rebase engineer launched (fg840/engineer-rebase.md); then force-with-lease push, CI, then a fresh review start. FG-835 part 2b engineer launched (launch-fg835c-engineer-ytd03s) with the Models mock.

FG-840: rebased onto a2aac5e9 by engineer task-engineer-9b6ada (census 46/278; governance.js keeps the editor + the RECORDED caption; raci-editor-view.js RecordedTable carries the caption too); HEAD 68ef72cf force-pushed with lease; CI on #369; then a FRESH review start (the earlier partial review row at contract_confirmed is abandoned).

FG-840: CI dashboard_browser RED at rebased 68ef72cf — the FG-840 fg820 case waits for .gov-audit-row .gov-audit-actor, which FG-834's RecordedTable (project in scope) does not render: two recorded renderers after the rebase. Engineer launched (fg840/engineer-recorded.md) to make ONE shared recorded component; then commit/push, CI, fresh review start. FG-835 part 2b engineer still running.

FG-840: recorded-renderer unification done (task-engineer-419804: one shared RECORDED component for governance.js + raci-editor-view.js; fg820 + fg834 browser suites 13/13 in Chromium); committing + pushing; CI on #369 next, then a FRESH review start with fg840/contract.json (add dashboard/client/raci-editor-view.js + dashboard/src/shell.ts to the frontend scope — already covered by dashboard/client/ and dashboard/src/).

FG-840: #369 CI green + MERGEABLE at 850e48f3; fresh review starting (third start; the killed second one sits at contract_confirmed and is abandoned). On settle: continue with fg840/acceptance.json + docs-closeout.json, merge, evidence from fg840/evidence.md (FINAL_SHA per review).

FG-840 review review-8c3b319c1012 at 850e48f3: RF-1 (whole-file read before tail) fix_now — bounded reverse read (accepted_risk would need --operator since it names the bounded-tail invariant); RF-2 wide inconclusive → replay running (launch-fg840-replay3-l1ckrf) for rejected_premise; then continue (fix batch), push, docs stage, ci-wait #369, --all with fg840/acceptance.json, merge, evidence. FG-835 part 2b engineer still running (launch-fg835c-engineer-ytd03s, ~40 min).

FG-840 review-8c3b319c1012: RF-2 rejected (12/12 replay at 850e48f3); RF-1 fix batch running (launch-fg840-review3-fix-ru3ep1). After: push coordinator commit, docs stage with fg840/docs-closeout.json, ci-wait #369, --all with fg840/acceptance.json, merge, evidence from fg840/evidence.md. FG-841 n=3.

FG-840: RF-1 fix batch committed 78edb819 (bounded reverse read + tests; pushed); docs stage launching; ci-wait on #369. Then --all with fg840/acceptance.json, merge, evidence.

FG-840: docs stage changed nothing; candidate 78edb819; waiting on #369 CI (ciwait-9827c70d1f80), then forge review continue review-8c3b319c1012 --all --acceptance fg840/acceptance.json --docs-closeout fg840/docs-closeout.json, merge, evidence (FINAL_SHA=78edb819, REVIEW_ID=review-8c3b319c1012).

FG-840: #369 CI green at 78edb819; final review stages running (launch-fg840-review3-final-poa4f4); then merge #369 and record AC 1-3 evidence from fg840/evidence.md (ticket stays open for AC 4). FG-835 part 2b engineer at ~45 min, still running.

FG-840 MERGED a88d9826 (#369); AC 1-3 evidence recorded, ticket OPEN for AC 4 (operator decision: label --by/--source as a claim, or bind dashboard applies with a token). Clone removed, host on main, dashboard restarted. Backend lane free; remaining batch items: FG-835 part 2b (engineer running), FG-837 (dashboard lane, needs a mock — Roles parity; design refs at scratchpad fg837/design), FG-833 (idea, operator decisions), FG-841 (host-only flake, n=3).

FG-837 (Roles parity) launched in parallel on its own clone ~/code/forge-fg837 (feat/fg-837-roles-parity from a88d9826) with the approved mocks at scratchpad fg837/design; brief fg837/engineer.md. Expect census/how-to-testing/view-routing/release.ts overlaps with FG-835 part 2b — whichever merges second gets a rebase engineer pass (FG-840 precedent).

FG-835 part 2b: engineer complete (task-engineer-90c50d on run run-fg-835-models-editor-a4cd52; Models page #models?mode=edit&target=; 6 browser cases on 18842; census 47/283; 9 screenshots incl. 3 side-by-side; GET /api/model-policy gained backups[].text + knownModels; ADR learnings/decisions/2026-09-30_model-policy-edited-from-the-dashboard.md; invariants 7/15 reworded). test-engineer launching; then docs, commit/PR, ci-wait, review (fg835c/contract.json wide/frontend/backend/security), merge, close FG-835 with the full grid. FG-837 engineer running.

FG-835 part 2b: test-engineer (task-test-engineer-b93d4f) found a real picker defect (prior model option dropped after a keyboard change) → engineer fix launched (fg835c/engineer-fix.md); its second finding (fg834-raci-editor browser suite does not finish in the container) matches the host-only timeouts seen during FG-834's review — CI passes it; environments where it hangs: this host + one test-engineer container (n=2), not filed yet. After the fix: docs (fg835c/docs.md), commit/PR, ci-wait, review (fg835c/contract.json), merge, close FG-835 with fg835c/close-grid.md.

FG-835 part 2b: picker fix done (task-engineer-6f4504; alphabetical, prior option kept; unit + browser regressions). Docs pass launching; then commit/PR, ci-wait, review (fg835c/contract.json), merge, close with fg835c/close-grid.md. FG-837 engineer running (launch-fg837-engineer-t3z8lf).

FG-835 part 2b: docs reconciled; committing + PR now; ci-wait registered. On green: review start FG-835 --contract fg835c/contract.json --project ~/code/forge-fg835c --run run-fg-835-models-editor-a4cd52; continue with fg835c/acceptance.json + docs-closeout.json; merge; close FG-835 with fg835c/close-grid.md (fill MERGE_SHA/PR_NUM/FINAL_SHA/REVIEW_ID). FG-837 engineer running.

FG-837: engineer complete (task-engineer-b96630 on run run-fg-837-roles-parity-77471d; list + role page per the mocks; 7 browser cases on PORT 18842; census 47/285; 4 roles suites got selector updates). test-engineer launching. MERGE-ORDER NOTE: FG-835 part 2b (#371) and FG-837 both add a browser suite on PORT 18842 and both bump the census from 46/277 — whichever merges second needs a rebase engineer pass that changes its PORT (FG-839 duplicate-port guard) and recomputes the census (48 suites / 290 tests) + docs/how-to-testing.md totals.

FG-837: test-engineer done (task-test-engineer-189b10; +1 browser case → suite 8, census 47/286; 36/36 across the roles suites). Its AC-4 finding (mock PNGs are 2x renders vs 1200px implementation shots) is moot: the engineer's side-by-side composites rendered the mock HTML at 1200 beside the implementation. Docs pass launching; then commit/PR, ci-wait, review (fg837/contract.json), merge, close with fg837/close-grid.md. Whichever of #371 (FG-835) / FG-837 merges second: rebase pass (PORT 18842 collision + census 48/291).

FG-837: docs reconciled; committing + PR now; ci-wait registered. On green: review start FG-837 --contract fg837/contract.json --project ~/code/forge-fg837 --run run-fg-837-roles-parity-77471d; continue with fg837/acceptance.json + docs-closeout.json; merge; close with fg837/close-grid.md. FG-835 #371 CI in progress.

FG-835 #371 is DIRTY (conflicts with FG-840's main) and GitHub runs no checks on a conflicting PR — its ci-wait cancelled. Plan: merge FG-837 (#372, clean on current main) first, then ONE rebase engineer pass for FG-835 (fg835c/engineer-rebase.md: FG-840 + FG-837 overlaps, PORT 18842 → new value, census 48/291), force-with-lease push, CI, review, merge, close.

FG-837: #372 CI green + CLEAN at 0f10c06e; review starting. On settle: continue with fg837/acceptance.json + docs-closeout.json, merge, close with fg837/close-grid.md (PR_NUM=372, FINAL_SHA per review), then dispatch the FG-835 rebase.

FG-837 review review-d61fd9af84c2 at 0f10c06e: RF-1 (focus outline depends on :has()) + RF-2 (concepts sentence on empty families) fix_now, batch launching. After: push coordinator commit, docs stage with fg837/docs-closeout.json, ci-wait #372, --all with fg837/acceptance.json, merge, close with fg837/close-grid.md; then the FG-835 rebase.

FG-837: fix batch committed 38ae4643 (pushed); docs stage launching; ci-wait on #372 for the fix sha. Then --all with fg837/acceptance.json + docs-closeout.json, merge, close with fg837/close-grid.md (FINAL_SHA = post-docs candidate), then the FG-835 rebase.

FG-837: docs stage changed nothing; candidate 38ae4643; waiting on #372 CI (ciwait-333a3e3cf2cf), then continue --all with fg837/acceptance.json + docs-closeout.json, merge, close (FINAL_SHA=38ae4643), then the FG-835 rebase.

FG-837: #372 CI green at 38ae4643; final review stages running; then merge #372, close FG-837 with fg837/close-grid.md, then dispatch the FG-835 rebase (fg835c/engineer-rebase.md).

FG-837 CLOSED at 06f42ff1 (#372) with the full grid; clone removed; dashboard restarted. Next: FG-835 rebase onto 06f42ff1 (fg835c/engineer-rebase.md: FG-840 + FG-837 overlaps, PORT 18842 → new value, census 48/291), force-with-lease push, CI, review, merge, close.

FG-835 part 2b: rebased onto 06f42ff1 by engineer task-engineer-8221cf (PORT 18843; census 48/292); force-pushed with lease; CI on #371. Then review start with fg835c/contract.json, continue with acceptance.json + docs-closeout.json, merge, close FG-835 with fg835c/close-grid.md. That closes the dashboard batch except FG-833 (idea awaiting operator decisions), FG-840 AC 4 (operator decision) and FG-841 (host-only flake).

FG-835 part 2b: #371 CI green + CLEAN at 08426548; review starting. On settle: continue with fg835c/acceptance.json + docs-closeout.json, merge #371, close FG-835 with fg835c/close-grid.md (PR #371, FINAL_SHA per review).

FG-835 review review-4ae47fb6199c at 08426548: RF-1 (Harness link drops project scope) + RF-3 (restore docs vs size limit) + RF-2 (backup text in the list read model → lazy fetch on Restore; accepted_risk would need --operator) all fix_now in ONE batch. After: push coordinator commit, docs stage with fg835c/docs-closeout.json, ci-wait #371, --all with fg835c/acceptance.json (AC 6 evidence 'restore' unit test name may change — re-read the suite before --all), merge, close with fg835c/close-grid.md.

FG-835: fix batch committed 663c3c98 (Harness link scope, lazy backup fetch via GET ?backup=, oversized-backup refusal in docs+UI; 29 files); pushed; docs stage launching; ci-wait on #371. Then --all with fg835c/acceptance.json + docs-closeout.json, merge, close with fg835c/close-grid.md.

FG-835: docs stage changed nothing; candidate 663c3c98; waiting on #371 CI (ciwait-18a75da39cbc), then forge review continue review-4ae47fb6199c --all --acceptance fg835c/acceptance.json --docs-closeout fg835c/docs-closeout.json, merge, close FG-835 with fg835c/close-grid.md (FINAL_SHA=663c3c98).

FG-835: CI dashboard_integration RED at 663c3c98 on 'integ FG-823: the dashboard route drives the SAME real CLI…' (fetch failed in 16 ms — server never answered; not an FG-835 file; ports differ 18827/18829 vs 18835). Rerunning the failed jobs once (run 36701413358) to separate a port/timing race from a deterministic break; ci-wait ciwait-ff9dea1475e5. If it fails again deterministically: engineer fix pass, hand commit, fresh review (window spent).

Filed FG-842: six duplicate listen ports among dashboard/src integration fixtures (18827 FG-823/FG-827; 18835 FG-834-enforcement/FG-835-routes; …) race in CI's parallel tier — the #371 red was this, not the diff; likely also FG-841's mechanism. FG-835: CI rerun in progress (ciwait-ff9dea1475e5).

FG-835: #371 rerun green (15/15, CLEAN) at 663c3c98 — the earlier red was the FG-842 port race; final review stages running; then merge #371, close FG-835 with fg835c/close-grid.md (FINAL_SHA=663c3c98), remove clone, restart dashboard, notify.

FG-835 review: recheck said RF-1 still_present from the host browser run (CLI-shelling fixture; host-only pattern) while CI dashboard_browser passed all 8 cases at 663c3c98 and the link uses the scoped helper → rejected_premise (anchored line 231); final stages re-running. Then merge #371, close FG-835. HOST OBSERVATION (n=2 suites now: fg834-raci-editor, fg835-models-editor): browser fixtures that exec the real bin/forge time out on this host only — consider a ticket if it recurs on a third suite.

FG-835 CLOSED at b787f669 (#371) with the full grid; clone removed; dashboard restarted. DASHBOARD BATCH COMPLETE this session: FG-830, 831, 832, 834, 835, 836, 837, 838, 839 closed; FG-840 merged with AC 1-3 met and OPEN for AC 4 (operator: label --by/--source as a claim vs bind dashboard applies with a token); FG-833 stays an idea parked on four operator decisions; FG-841 (host-only slot-occupancy flake, n=3) and FG-842 (six duplicate dashboard/src fixture ports; likely FG-841's cause) filed. Host-only observation: browser fixtures that exec the real bin/forge (fg834-raci-editor, fg835-models-editor) time out on this host while CI/containers pass — not filed (n=2 suites). Release gate (v0.2.0 candidate) NOT started — operator's call. seeds/agents changed by FG-839: published generation picks it up on the next forge upgrade (operator's call). Older clones ~/code/forge-fg804..fg813 untouched.

FG-843 filed (scope column → project select only; checkout chooser only on Routing/Config/Notes with ≥2 live operator checkouts; run-only dirs are run checkouts, never operator ones; one derivation in queries.ts). Mock at scratchpad fg843/design/scope-mock.png; brief fg843/engineer.md; test-engineer + contract staged; clone ~/code/forge-fg843 (feat/fg-843-checkout-scope from b787f669; npm ci launched). Dispatching the engineer with --design-dir once the mock is viewed.

FG-844 filed (Queue board lanes wrap: .queue-columns repeat(auto-fit, minmax(280px,1fr)) → one row, internal scroll, sticky headers, compact >20, lane strip <900px) with mock fg844/design/queue-mock.png; engineer dispatching on clone ~/code/forge-fg844 (fix/fg-844-queue-board-lanes). FG-843 engineer running (launch-fg843-engineer-0o2rti). Both add a browser suite — the second to merge rebases (census + PORT).

FG-844: engineer complete (task-engineer-830e31 on run run-fg-844-queue-board-lanes-1df2fc; one-row board matches the mock; 5 browser cases on PORT 18851; census 49/299; lanes Backlog/Queued/In progress/Blocked/Done/Executing unchanged; strip is a top tablist). test-engineer running (launch-fg844-test-engineer-99op16); docs brief staged; then commit/PR, ci-wait, review (fg844/contract.json), merge, close. FG-843 engineer still running.

Filed FG-845: AI attribution as a dashboard setting — host default beneath the per-project value, Config row + Projects column, two closed-registry controls (set --host / unset), propagation honesty. Two parts (reader+CLI first; dashboard after FG-843). Not started.

FG-844: test-engineer done (task-test-engineer-80c462; +1 browser case → 6; census 49/300; no defects). Docs pass launching; then commit/PR, ci-wait, review (fg844/contract.json wide/frontend), merge, close with fg844/close-grid.md. FG-843 engineer still running.

FG-844: docs verified (no changes needed); committing + PR now; ci-wait registered. On green: review start FG-844 --contract fg844/contract.json --project ~/code/forge-fg844 --run run-fg-844-queue-board-lanes-1df2fc; continue with fg844/acceptance.json + docs-closeout.json; merge; close with fg844/close-grid.md. FG-843 engineer still running (launch-fg843-engineer-0o2rti).

FG-844: #373 CI green + CLEAN at c0feea44; review starting. On settle: continue with fg844/acceptance.json + docs-closeout.json, merge #373, close with fg844/close-grid.md (PR #373, FINAL_SHA per review). FG-843 engineer still running (~35 min).

FG-844 review review-e129b4ee4de3 at c0feea44: frontend shard pass; wide shard inconclusive (docs+census only) → replay running (launch-fg844-replay-728d90) for rejected_premise; then continue --docs-closeout fg844/docs-closeout.json, ci-wait #373 if the candidate moves, --all with fg844/acceptance.json, merge, close with fg844/close-grid.md (REVIEW_ID=review-e129b4ee4de3). FG-843 engineer still running.

FG-844: RF-1 rejected (unit tier replay at c0feea44 + CI dashboard_browser 6/6); docs stage launching; then ci-wait #373 if the candidate moves, --all with fg844/acceptance.json, merge, close with fg844/close-grid.md. FG-841 n=4. FG-843 engineer still running.

FG-844: docs stage changed nothing; candidate c0feea44 (CI already green); final review stages running; then merge #373, close FG-844 with fg844/close-grid.md (FINAL_SHA=c0feea44), remove clone, restart dashboard, notify. FG-843 engineer still running.

FG-844 CLOSED at 21cf6d0b (#373) with the grid; clone removed; dashboard restarted. FG-843 engineer still running (launch-fg843-engineer-0o2rti, since 14:35Z) — when it lands it must rebase onto 21cf6d0b (census now 49/300 on main; its suite's PORT must avoid 18851 and every other port in both test dirs). FG-845 filed, not started.

FG-843: engineer complete (task-engineer-e92960 on run run-fg-843-checkout-scope-176a41): scope column = project select only; chooser on Routing/Config/Notes; operator checkout = workspace_purposes rows + live session; run-only dirs are run checkouts; 8 browser cases; census 49/302 on the branch; assertion changes in ~10 existing suites flagged for the test-engineer to adjudicate. test-engineer launching; then docs, rebase onto 21cf6d0b (fg843/engineer-rebase.md), commit/PR, ci-wait, review (fg843/contract.json), merge, close.

FG-843: test-engineer (task-test-engineer-7b1085) found 2 real defects left as red browser assertions — symlinked-parent run loses its Runs label (path-identity gap); unknown ?checkout= accepted as a fabricated run checkout instead of canonicalizing → engineer fix launched (fg843/engineer-fix.md). After: docs (fg843/docs.md), rebase (fg843/engineer-rebase.md) onto 21cf6d0b, commit/PR, ci-wait, review (fg843/contract.json), merge, close with fg843/close-grid.md.

FG-843: engineer fix done (task-engineer-79fed5: symlinked-parent run labels via the registry alias listing + path-identity; unknown ?checkout= canonicalizes to the primary; 8/8 browser, 2 unit cases added). Docs pass launching; then rebase onto 21cf6d0b (fg843/engineer-rebase.md), commit/PR, ci-wait, review (fg843/contract.json), merge, close with fg843/close-grid.md.

FG-843: docs reconciled (6 files); committed + PR opening; rebase engineer launching onto 21cf6d0b (census on main 49/300; branch adds fg843 suite 8 → expect 50/308; PORTs 18844/18845 unique). After: force-with-lease push, ci-wait, review (fg843/contract.json), merge, close with fg843/close-grid.md.

FG-843: rebased onto 21cf6d0b (task-engineer-a77724; census 50/308; ports unique) → b4703be3 force-pushed with lease; CI on #374. On green: review start FG-843 --contract fg843/contract.json --project ~/code/forge-fg843 --run run-fg-843-checkout-scope-176a41; continue with fg843/acceptance.json + docs-closeout.json; merge; close with fg843/close-grid.md (PR #374, FINAL_SHA per review).

FG-843: #374 CI green + CLEAN at b4703be3; review starting. On settle: continue with fg843/acceptance.json + docs-closeout.json, merge #374, close FG-843 with fg843/close-grid.md, remove clone, restart dashboard, notify.

FG-843 review discovery running (launch-fg843-review-start-aaf0s5); replay at b4703be3 running (launch-fg843-replay-kaidrd); CI dashboard_browser 8/8 at b4703be3 cached at fg843/ci-evidence.txt for a wide-shard rejected_premise if one appears.

FG-843 review review-66834032ec3d at b4703be3: RF-1 (live session promoted a run clone to operator → registry rows only), RF-2 (Routing/Config checkout pick leaked into shared project reads/badges), RF-3 (dashboard/CLAUDE.md stale scope-bar paragraph) — all fix_now, ONE batch running. After: push coordinator commit, docs stage with fg843/docs-closeout.json, ci-wait #374, --all with fg843/acceptance.json (re-check the RF-1 unit test name cited for AC 3 — it may be renamed), merge, close with fg843/close-grid.md.

FG-843: fix batch committed 1d94a0ec (registry-rows-only operator rule; checkout pick no longer narrows shared reads; CLAUDE.md paragraph; pushed); docs stage launching; ci-wait on #374. Then --all with fg843/acceptance.json + docs-closeout.json, merge, close with fg843/close-grid.md. FG-841 n=5.

FG-843: docs stage moved candidate to 7296b8d1 (4 docs paths; pushed); CI re-running on #374. On green: continue --all with fg843/acceptance.json + docs-closeout.json, merge, close with fg843/close-grid.md (FINAL_SHA=7296b8d1).

FG-843: CI test job RED at 7296b8d1 — FG-642 census guard: the review fixer added a 9th browser case without bumping the census (8 → 9; totals 50/308 → 50/309). Remediation window spent → engineer census pass (fg843/engineer-census.md), hand commit + push, CI, FRESH review start (FG-823 precedent), continue --all, merge, close. The stale ci-wait ciwait-e9798c2ca55d will complete red; register a new one after the push.

FG-843: census bumped to 9 (hand commit on the branch; pushed); CI re-running on #374; on green → FRESH forge review start FG-843 (fg843/contract.json), dispositions, continue --all with fg843/acceptance.json + docs-closeout.json, merge, close with fg843/close-grid.md (REVIEW_ID/FINAL_SHA per the new review).

FG-843: #374 dashboard_integration red at 81a4d007 = FG-842 port race (FG-823 vs FG-827 on 18827), not the diff; failed jobs rerun; new ci-wait registered. On green → fresh review start (fg843/contract.json), dispositions with fg843/replay-evidence.json + CI browser job at 81a4d007, continue --all, merge, close.

FG-843: #374 rerun green + CLEAN at 81a4d007 (FG-842 race confirmed); fresh review starting (second review of the branch). Evidence for a wide-shard inconclusive cached: fg843/replay-evidence.json (16/16 at 81a4d007) + fg843/ci-evidence-81a4d007.txt (9/9 real Chrome). On settle: continue with fg843/acceptance.json + docs-closeout.json, merge #374, close FG-843 with fg843/close-grid.md (fill REVIEW_ID, FINAL_SHA=81a4d007), remove clone, restart dashboard, notify.

FG-843 fresh review review-eb9be20e02de at 81a4d007: backend + frontend shards pass; RF-1 wide inconclusive rejected (16/16 replay + 9/9 CI Chrome); docs stage launching; then ci-wait #374 if the candidate moves, --all with fg843/acceptance.json + docs-closeout.json, merge, close with fg843/close-grid.md (REVIEW_ID=review-eb9be20e02de, FINAL_SHA per docs stage).

FG-843: fresh review's docs stage moved the candidate to d19a1301 (pushed); CI re-running on #374. On green: continue --all with fg843/acceptance.json + docs-closeout.json, merge, close with fg843/close-grid.md (FINAL_SHA=d19a1301).

FG-843: #374 CI green + CLEAN at d19a1301; final review stages running; then merge #374, close FG-843 with fg843/close-grid.md (only MERGE_SHA left to fill), remove clone, restart dashboard, notify.

FG-843 CLOSED at 999dac15 (#374) with the grid; clone removed; dashboard restarted on main. Session tally: FG-830/831/832/834/835/836/837/838/839/843/844 closed; FG-840 merged, OPEN for AC 4 (operator: audit attribution as claim vs token); FG-845 filed (AI attribution as a dashboard setting; two parts, dashboard part after FG-843 — now unblocked); FG-841 (host-only slot flake, n=6) and FG-842 (duplicate dashboard/src fixture ports incl. cross-directory pairs; caused two red CI runs today) filed; FG-833 idea parked on operator decisions. Release gate not started (operator's call); seeds changed by FG-839 land on the next forge upgrade (operator's call). Host observation not filed: browser fixtures that exec the real bin/forge time out on this host and in some containers while CI passes (fg834/fg835 editor suites).

FG-840 AC 4: operator chose option (a) — attribution is a CLAIM (label + docs, no token). Engineer launched (launch-fg840b-engineer-b3lam9; clone ~/code/forge-fg840b on fix/fg-840-attribution-claim from 999dac15; brief scratchpad fg840b/engineer.md); test-engineer/docs/contract/grid staged under fg840b/. Then PR, ci-wait, review, merge, close FG-840 (AC 1-3 evidence already on the ticket).

Queue enqueue 'nothing happened' diagnosed: the route worked; enqueue was REFUSED (FG-845 lacked ## Problem / ## Goal) and the refusal alert renders at the top of the page, out of view below FG-844's viewport-bounded board. FG-845 given the sections and enqueued (position 5, ready). FG-846 filed (outcome at the point of action + focus). FG-841/FG-842 given Problem/Goal sections so they enqueue. Lesson: tickets I file need ## Problem and ## Goal (or ## Expected behavior) for the readiness gate. FG-840 AC 4 engineer still running.

FG-840 AC 4: engineer complete (task-engineer-3944f9 on run run-fg-840-attribution-claim-b2dab6: claimed marker + caption on Routing and Models Recorded panels; docs + ADR addendum; no server/census change). test-engineer launching; then docs (fg840b/docs.md), commit/PR, ci-wait, review (fg840b/contract.json), merge, close FG-840 with fg840b/close-grid.md.

FG-840 AC 4: test-engineer done (task-test-engineer-ce3a97; 44 passed; no defects; no census change). Docs pass launching; then commit/PR, ci-wait, review (fg840b/contract.json), merge, close FG-840 with fg840b/close-grid.md.

FG-840 AC 4: docs verified (dashboard/CLAUDE.md updated); committing + PR now; ci-wait registered. On green: review start FG-840 --contract fg840b/contract.json --project ~/code/forge-fg840b --run run-fg-840-attribution-claim-b2dab6; continue with fg840b/acceptance.json + docs-closeout.json; merge; close FG-840 with fg840b/close-grid.md (fill PR_NUM/MERGE_SHA/FINAL_SHA/REVIEW_ID).

FG-840 AC 4: PR #375 open at dca44556 (first gh pr create hit a transient GraphQL error; retry succeeded); ci-wait ciwait-b29b9ee73e32 armed.

FG-842 STARTED (route testing_automation → test-engineer; clone ~/code/forge-fg842 on test/fg-842-fixture-ports from 999dac15; brief scratchpad fg842/test-engineer.md): dedupe the 11 fixture port collisions (prefer port 0), extend the FG-839 guard across both test dirs, docs, and re-test FG-841. Triggered by the third red CI cycle today (PR #375). FG-840 AC 4: PR #375 CI has 1 pending job; rerun the failed dashboard_integration job when the run completes, then review start.

FG-840 AC 4: #375 rerun green + CLEAN at dca44556 (FG-842 race confirmed); review starting; evidence cached at fg840b/replay-evidence.json + fg840b/ci-evidence.txt. On settle: continue with fg840b/acceptance.json + docs-closeout.json, merge #375, close FG-840 with fg840b/close-grid.md (fill MERGE_SHA/FINAL_SHA/REVIEW_ID). FG-842 test-engineer running.

FG-840 AC 4 review review-30a23506e4fd at dca44556: RF-1 (Models rows fabricate 'via cli (claimed)' when source is absent) fix_now — batch running; RF-2 wide inconclusive rejected (replay + CI Chrome). After: push coordinator commit, docs stage with fg840b/docs-closeout.json, ci-wait #375 if the candidate moves, --all with fg840b/acceptance.json, merge, close with fg840b/close-grid.md.

FG-840 AC 4: RF-1 fix batch committed 8b7ea2d4 (no fabricated source on source-less Models rows; unit case; pushed); docs stage launching; ci-wait on #375. Then --all with fg840b/acceptance.json + docs-closeout.json, merge, close FG-840 with fg840b/close-grid.md (FINAL_SHA per docs stage). FG-842 test-engineer running.

FG-840 AC 4: docs stage moved candidate to b50a8c84 (3 docs paths; pushed); CI re-running on #375 (the armed ci-wait ciwait-c6b6d9a6f107 will complete for the superseded 8b7ea2d4 run — advance it and register a new one). On green at b50a8c84: continue --all, merge #375, close FG-840 with fg840b/close-grid.md (only MERGE_SHA left).

FG-842: test-engineer done (task-test-engineer-f101a7): all 11+2 collisions moved to unique 19001-19020 literals; guard extended across both dirs with a seeded-duplicate proof; docs updated. Its 'failed' status = AC 4's three combined host runs could not finish in the container — running them on the host myself (fg842-combined-1..3 launches). Docs pass launching. Then commit/PR, ci-wait, review (fg842/contract.json, route testing_automation), merge, close with a grid; FG-841 closes only if the combined runs stay green.

FG-842: committed + PR #376 (test/fg-842-fixture-ports); ci-wait registered; combined host run 1 running (fg842-combined-1), runs 2-3 follow serially; docs verified. On green CI + combined runs: review start (fg842/contract.json, route testing_automation), fill AC 4 results into fg842/acceptance.json, continue --all, merge, close FG-842 (+ FG-841 if the runs stay green).

FG-840 AC 4: CI at b50a8c84 RED — dashboard_integration = FG-842 race (again; #376 will end it); dashboard_browser = REAL: two FG-835 Models cases broke after the RF-1 fix batch (Who cell no longer says 'cli' for a terminal line — assertion encoded the fabricated source; and 'newest backup is the file the first apply replaced' in the Restore case — possible regression in models-editor-state.js). Remediation window spent → engineer fix pass (fg840b/engineer-fix2.md), hand commit + push, CI, FRESH review start. FG-842: PR #376 in CI; combined host run 1 running.

FG-842 AC 4 answered: combined host run 1 (unique ports) still fails only the FG-841 case → ports were not FG-841's cause; FG-841 updated (timing lead: assert after four children have started) and stays open; no further combined runs needed for FG-842. FG-842: PR #376 in CI; on green → review start (fg842/contract.json), continue --all with fg842/acceptance.json + docs-closeout.json, merge, close. FG-840 AC 4: engineer fix2 running.

FG-842: #376 CI green + CLEAN at 07ccc93e (integration tier passed first time on the deduped ports); review starting. On settle: continue with fg842/acceptance.json + docs-closeout.json, merge #376, close FG-842 with fg842/close-grid.md (fill MERGE_SHA/FINAL_SHA/REVIEW_ID), rm ~/code/forge-fg842. FG-840 AC 4 fix2 engineer running.

FG-840 AC 4: test fix committed f32afc9a (the 'cli' assertion encoded the fabricated source; the Restore failure was its cascade); pushed; CI on #375 (ciwait-f8efd75a2e06). On green → FRESH review start (fg840b/contract.json), continue --all, merge, close. FG-842 review review-8d269ab89c4c at 07ccc93e: backend shard pass; RF-1 wide inconclusive (guard file outside the docs shard) → rejected_premise once the root-tier replay (launch-fg842-replay-lve4h9) lands; then continue --docs-closeout, --all, merge #376, close.

FG-842 review: RF-1 rejected (root tier 6063/6063 at 07ccc93e incl. both guard cases); docs stage launching; then ci-wait #376 if the candidate moves, --all with fg842/acceptance.json + docs-closeout.json, merge, close FG-842 with fg842/close-grid.md, rm clone. FG-840: #375 CI running at f32afc9a.

FG-842: docs stage moved candidate to bccf3de6 (3 docs paths; pushed); CI re-running on #376. On green: continue --all with fg842/acceptance.json + docs-closeout.json, merge, close FG-842 with fg842/close-grid.md (only MERGE_SHA left). FG-840: #375 CI running at f32afc9a.

FG-842 docs cycle edited seeds/agents/{engineer,frontend-specialist,test-engineer}/CLAUDE.md (the fixture-port rule) — like FG-839's seed edits, the published generation picks these up on the next forge upgrade (operator's call).

FG-840 AC 4: CI at f32afc9a red on dashboard_integration (FG-842 race; #376 pending) and dashboard_browser 'FG-819: keyboard focus tabbing into the inbox…' (untouched suite; likely a focus-timing flake, n=1). Rerunning the failed jobs on run 36757171239; the FG-835 Models cases now pass. If FG-819 fails again deterministically, investigate before treating this branch as clean.

BLOCKER for #375 and #376: 'integ FG-823: the dashboard route drives the SAME real CLI…' fails in CI's dashboard_integration even with unique ports (FG-842 branch at bccf3de6) and without EADDRINUSE — the fixture server never answers ('fetch failed' in ~15 ms): a startup/readiness race in that fixture, not ports. PR 375's browser rerun passed (FG-819 was a flake). Plan: test-engineer fix on the FG-842 branch (readiness wait for that fixture), commit, CI, fresh FG-842 review; then rerun #375.

FG-842 follow-up launched (test-engineer, testing_automation): fg823-attention-dismiss-cli imports ./server.js at module level and fetches with no listening wait — readiness race under the parallel tier; fix that fixture (+ siblings with the same shape), prove 5x alone + 1x combined. Then hand commit on test/fg-842-fixture-ports, push, CI, FRESH FG-842 review (review-8d269ab89c4c is superseded by the new candidate), merge #376, close; then rerun #375 → fresh FG-840 review → merge → close.

Filed FG-847 (operator: a needs_refinement enqueue refusal is a dead end in the dashboard): readiness read route (forge readiness --json parity), ticket-body edit through the closed registry (forge backlog edit --body -), Refine panel on the Queue refusal + Backlog ticket page pre-seeded with the proposal, re-run verdict, enqueue when ready; part 2 = agent-drafted sections via FG-833's durable-launch kind. Evaluates exploratory (enqueue-able). Not started; FG-842 fixture-readiness fix still running.

FG-842: readiness fix committed (5 fixtures await a successful response + opt out of remote mode; root cause of the residual 'fetch failed' race); pushed; CI on #376. On green: FRESH review start (fg842/contract.json, testing_automation), continue --all with fg842/acceptance.json + docs-closeout.json, merge, close with fg842/close-grid.md (fill REVIEW_ID/FINAL_SHA/MERGE_SHA). Then rerun #375 → fresh FG-840 review → merge → close.

FG-840 AC 4 plan after FG-842 merges: rebase fix/fg-840-attribution-claim onto main (fg840b/engineer-rebase.md — picks up the fixture readiness fix so #375's integration tier stops flaking), force-with-lease push, ci-wait #375, FRESH review start (fg840b/contract.json), continue --all, merge, close FG-840. FG-842: #376 CI at 08451343 running; root-tier replay (launch-fg842-replay2-bgismy) running for the fresh review's evidence.

FG-842: #376 CI green + CLEAN at 08451343; fresh review starting (second review; review-8d269ab89c4c superseded). Evidence cached: fg842/replay-evidence.json (root tier 6063/6063 at 08451343). On settle: continue with fg842/acceptance.json + docs-closeout.json, merge #376, close FG-842 with fg842/close-grid.md (fill REVIEW_ID/FINAL_SHA/MERGE_SHA), rm clone; then the FG-840 rebase.

FG-842: second review start refused (3 seed CLAUDE.md edits outside lens scopes) — contract wide scope now includes seeds/; third start launching.

FG-842 review review-67e16224a80b at 08451343: both shards pass, 0 findings; docs stage launching; then ci-wait #376 if the candidate moves, --all with fg842/acceptance.json + docs-closeout.json, merge, close with fg842/close-grid.md (FINAL_SHA per docs stage).

FG-842: docs stage moved candidate to 3df1f8c3 (pushed); CI re-running on #376. On green: continue --all with fg842/acceptance.json + docs-closeout.json, merge, close FG-842 with fg842/close-grid.md (only MERGE_SHA left), rm clone; then the FG-840 rebase.

FG-842: #376 CI green + CLEAN at 3df1f8c3; final review stages running; then merge #376, close FG-842 with fg842/close-grid.md, rm clone, then FG-840 rebase (fg840b/engineer-rebase.md) → push → CI → fresh review → merge → close.

FG-842: first --all refused (acceptance AC 1 evidence carried regression_test keys after the bounded_inspection rewrite); normalized fg842/acceptance.json (only kind/inspection/limitation or kind/test_file/test_name) and relaunched the final stages.

FG-842 review recheck surfaced RF-1 (docs promise a readiness rule the guard doesn't enforce) after the remediation boundary → filed FG-848 (guard enforces readiness probe + FORGE_DASHBOARD_REMOTE opt-out via a shared helper; docs say 'enforced') and deferred RF-1 to it; final stages relaunched. Then merge #376, close FG-842, FG-840 rebase.

FG-842 CLOSED at bebeca4c (#376) with the grid; clone removed. FG-840 AC 4: rebase engineer launched onto bebeca4c (fg840b/engineer-rebase.md); then force-with-lease push, ci-wait #375, FRESH review start (fg840b/contract.json), continue --all, merge, close FG-840 with fg840b/close-grid.md, rm clone, restart dashboard, notify.

FG-840 AC 4: rebased onto bebeca4c → 10f4e097 (clean, no conflicts), force-pushed with lease; CI on #375; dashboard unit-tier replay at 10f4e097 launching for the fresh review's evidence. On green CI: FRESH review start (fg840b/contract.json), disposition, continue --all with fg840b/acceptance.json + docs-closeout.json, merge #375, close FG-840 with fg840b/close-grid.md, rm clone, restart dashboard, notify.

FG-840 AC 4: #375 CI green + CLEAN at 10f4e097 (first pass on the rebased branch — FG-842's readiness fix ended the integration flake); fresh review starting (second review). Evidence cached at fg840b/replay-evidence.json. On settle: continue with fg840b/acceptance.json + docs-closeout.json, merge #375, close FG-840 with fg840b/close-grid.md (fill REVIEW_ID/FINAL_SHA/MERGE_SHA), rm clone, restart dashboard, notify, final handoff.

FG-840 fresh review review-f832f3101cab at 10f4e097: RF-1 (Routing rows fabricate a 'cli' actor for source-only records — mirror of the Models fix) fix_now, batch running. After: push coordinator commit, docs stage with fg840b/docs-closeout.json, ci-wait #375, --all with fg840b/acceptance.json, merge, close FG-840 with fg840b/close-grid.md.

FG-840: RF-1 fix batch committed c11d7324 (renderer shows only the fields a record carries; unit cases for source-only/actor-only/both/neither; pushed); docs stage launching; ci-wait on #375. Then --all with fg840b/acceptance.json + docs-closeout.json, merge, close FG-840 with fg840b/close-grid.md (FINAL_SHA per docs stage), rm clone, restart dashboard, notify, final handoff.

FG-840: docs stage moved candidate to 2acda715 (3 docs paths; pushed); CI re-running on #375. On green: continue --all with fg840b/acceptance.json + docs-closeout.json, merge, close FG-840 with fg840b/close-grid.md (only MERGE_SHA left), rm clone, restart dashboard, notify, final handoff.

FG-840 AC 4: CI dashboard_browser RED at 2acda715 — the review fix (no fabricated actor/source) left the FG-834 browser assertion td:has-text('cli') stale (+ the Reset case cascading), same shape as the Models fix earlier. Window spent → engineer fix3 (fg840b/engineer-fix3.md), hand commit + push, CI, FRESH review start, continue --all, merge, close.

FG-849 filed (Roles row click → test-engineer in Safari; FG-837 stretched link on positioned <tr>). Clone ~/code/forge-fg849 branch fix/fg-849-roles-row-click; engineer launch-fg849-engineer-ax5qf3 (brief scratchpad/fg849/engineer.md). Next: test-engineer on the same run, docs check, commit/push/PR, ci-wait, review start, merge, close (AC 1 needs the operator's Safari confirmation). FG-840: a21528c1 pushed on PR 375, ci-wait armed; then FRESH review start.

FG-840: CI green at a21528c1 (15/15 after FG-841 rerun). Third review start launch-fg840b-review3-start-27nio7 (run run-fg-840-attribution-claim-b2dab6). On completion: read review id, disposition, continue --all --acceptance fg840b/acceptance.json --docs-closeout fg840b/docs-closeout.json, merge #375, close with fg840b/close-grid.md (REVIEW3_ID + MERGE_SHA placeholders). FG-849: test-engineer launch-fg849-test-engineer-l6o4qp in flight.

FG-840 review-673a25f80341 at a21528c1: RF-1 (empty recorded panels omit the claim caption, medium) + RF-2 (how-to-model-policy says 'no attribution at all' vs the rendered 'unattributed', low) both fix_now; fix batch launch-fg840b-review3-fix-w4jqnk. After it: grep browser suites for stale caption assertions BEFORE pushing, docs stage, push, CI, continue --all, merge #375, close.

FG-849: committed a598b86b, PR #377, ci-wait ciwait-56a242c277ab armed. Next: review start FG-849 --contract fg849/contract.json --route implementation_quick --project ~/code/forge-fg849 --run run-fg-849-roles-row-click-104b45 (after CI), acceptance fg849/acceptance.json + docs-closeout fg849/docs-closeout.json staged; AC 1 needs the operator's Safari confirmation before close.

FG-840: fix batch b8ecb1d2 + docs 521badc9 pushed on PR 375; ci-wait ciwait-208fc415aac7. On green: forge review continue review-673a25f80341 --all --acceptance fg840b/acceptance.json --docs-closeout fg840b/docs-closeout.json --project ~/code/forge-fg840b, merge, close. FG-849 PR 377: dashboard_browser red on 'FG-828: a header is reached by Tab and operated by Enter and Space' (aria-sort read right after the hash flipped: role asc vs mount asc) — rerun requested (ciwait-bd8643c4c53e), host replay launch-fg849-fg828-replay-1-mwuij7. A mis-scoped full-tier replay (launch-fg849-fg828-replay-a8edv2; npm run test:browser -- <file> appends to the glob) was killed by process group.

FG-828 keyboard case is a PRE-EXISTING flake: 2/6 on main bebeca4c, 1/6 on the FG-849 candidate (host, sequential) — filed FG-850 (test-only; route testing_automation). PR 377 stays blocked only on that rerun; FG-849 review starts once CI is green. Clone ~/code/forge-fg850 being prepared.

FG-850: clone ~/code/forge-fg850 branch test/fg-850-hash-then-dom-waits; test-engineer launch-fg850-test-engineer-fhfoyd (route testing_automation, no followups). Next: commit/push/PR, ci-wait, review start (contract: wide+frontend, scopes dashboard/browser-tests + docs + seeds), merge, close.

FG-840 review-673a25f80341: verify_final + recheck green at 521badc9 (RF-1/RF-2 resolved); shipping refused once on a stale acceptance test name (unit test renamed by the fix batch to 'FG-840 AC 4: Routing's rendered Recorded rows label every attribution as a claim') — corrected, re-running (launch-fg840b-review3-ship-2trbl2). FG-849 review-157ed693c4f1: both wide findings rejected_premise (host replay + CI); continue --all running (launch-fg849-review-all-if57ky). FG-850 test-engineer still running.

FG-840 CLOSED: PR #375 merged as 044c8d6d (review-673a25f80341 settled at 521badc9; grid appended). Clone forge-fg840b removed. Dashboard restart pending until FG-849 merges (one restart for both).

FG-849: PR #377 merged as 85101651 (review-157ed693c4f1 settled at a598b86b, CI 15/15). Ticket stays OPEN for AC 1 — the operator's Safari confirmation (first/middle/last Roles rows). Dashboard restarted on main at 85101651. On confirmation: fill SAFARI_CONFIRMATION in fg849/close-grid.md, append, close --commit 85101651, rm ~/code/forge-fg849.

FG-850: committed 6df1e9e7 (rebased on 85101651), PR #378, ci-wait ciwait-7f03b6f52c56; host 20-run measurement launch-fg850-fg828-20runs-i609ao (TE's own tally in-container was 20/20). Contract/acceptance/docs-closeout staged in scratchpad/fg850 (AC 1 inspection placeholder TWENTY_RUN_EVIDENCE to fill from the launch log). Next: review start FG-850 --route testing_automation --run run-fg-850-hash-then-dom-waits-e849ea after CI green; continue --all; merge; close.

FG-850: CI 15/15 at 6df1e9e7; host 20-run 0/20 failed. Review start launch-fg850-review-start-bpanfg (run run-fg-850-hash-then-dom-waits-e849ea). Then disposition, continue --all --acceptance fg850/acceptance.json --docs-closeout fg850/docs-closeout.json, merge #378, close with fg850/close-grid.md, rm ~/code/forge-fg850.

FG-850 CLOSED: PR #378 merged as 9c4465d5 (review-4b7bc3ae6f3c settled at 6df1e9e7; grid appended); clone removed. OPEN: FG-849 awaits the operator's Safari confirmation (AC 1) — merged 85101651, dashboard restarted on it, close grid at scratchpad/fg849/close-grid.md (SAFARI_CONFIRMATION placeholder). Remaining backlog: FG-845 (AI attribution dashboard setting), FG-846, FG-847, FG-848, FG-841 (ECONNRESET lead, n=10). FG-833 idea + release gate are the operator's.

Started FG-845 part 1 (engineer launch-fg845-engineer-p1-w8yd5b on ~/code/forge-fg845, brief scratchpad/fg845/engineer-part1.md; part 2 = dashboard, needs a mock) and FG-848 (test-engineer launch-fg848-test-engineer-339hp4 on ~/code/forge-fg848, route testing_automation, brief scratchpad/fg848/test-engineer.md). Both run in parallel; per-ticket chain as before.

FG-848: TE pass complete (helper dashboard/src/test-support/await-dashboard-ready.ts, guard extended, 5 fixtures switched); docs maintainer running (launch-fg848-docs-ccrf1i). Orchestrator found a detection hole (guard only applies to fixtures already carrying one half of the convention) — fix brief scratchpad/fg848/test-engineer-fix.md to dispatch after the docs launch; then commit/push/PR/CI/review.

FG-848: docs updated (how-to-testing.md, dashboard/CLAUDE.md); guard-detection fix pass launch-fg848-te-fix-fb1scf. FG-845 p1: engineer done (11 files, reader+CLI+hook), test-engineer launch-fg845-test-engineer-p1-mkxbwn; docs brief staged scratchpad/fg845/docs-part1.md.

FG-845 p1: test-engineer FAILED on its own new case — config set --host drops a YAML comment (parse+reserialize); engineer fix pass launch-fg845-engineer-fix1-y1u0wp (line-oriented edits for set/--host/unset). Then docs (scratchpad/fg845/docs-part1.md), commit/push/PR, CI, review.

FG-845 p1: engineer fix done (line-oriented set/--host/unset; set on an UNPARSEABLE config now refuses instead of overwriting — flag in the PR body); docs maintainer running (launch-fg845-docs-p1-6p42oe). Engineer noted writeBacklogConfig/writeProjectKey still parse+reserialize (would drop comments) — verify before filing a follow-up.

FG-845 p1: committed da463fba + pushed (no PR yet). Docs maintainer task-documentation-maintainer-954715 FAILED (model_error: Sonnet 5 safeguards flagged the message) — retried with --model spec-writer. Filed FG-851 (writeBacklogConfig/writeProjectKey parse+reserialize; premise verified in src/backlog/config.ts:158-200). Then PR, ci-wait, review start.

FG-848: committed d6289445 (61 files: helper + guard w/ import-based detection + ~60 fixtures switched + docs), PR #379, ci-wait ciwait-73d50d634971. Next: review start FG-848 --route testing_automation --run run-fg-848-fixture-readiness-guard-646311 --contract fg848/contract.json after CI; acceptance + docs-closeout staged.

FG-845 p1: docs retry OK on spec-writer (6 docs incl. seeds/constraints/no-ai-attribution.md → needs forge upgrade on host later); committed 2ff33917, PR #380, ci-wait ciwait-d4819f363d1e. Review files staged: fg845/contract-part1.json (wide+backend+security), acceptance-part1.json (AC 1–2 only), docs-closeout-part1.json. Route implementation_quick, run run-fg-845-part-1-attribution-host-default-cli-f81144. FG-848 PR #379 CI in flight.

FG-845 p1: CI 15/15 at 2ff33917; review start launch-fg845-review-p1-start-vxk3pk. Close grid (part 1, AC 1–2 only; ticket stays open for the dashboard part) at scratchpad/fg845/close-grid-part1.md. FG-848 PR #379 rerun in flight (ciwait-d1d544211d61).

FG-845 p1 review-17fefd1cab3f at 2ff33917: RF-1 duplicate top-level key resolves allow (fix_now), RF-3 quick-start says unset creates the file (fix_now), RF-2 host allow invisible in containers (deferred → FG-853 filed). Fix batch launch-fg845-review-p1-fix-6whqcx. FG-852 filed (remote e2e Date header) and started on the reused ~/code/forge-fg849 clone (branch test/fg-852-remote-e2e-date-header, launch-fg852-test-engineer-fa9crm). FG-848 PR #379: second rerun in flight (ciwait-47a29f6e5faf) after FG-841 n=12 + the FG-852 flake.

FG-841 ROOT CAUSE (orchestrator): in-process server + sync CLI call between requests blocks the shared loop past the 5 s keep-alive; next fetch hits a dying pooled socket. TE launch-fg841-test-engineer-bi7uxp on ~/code/forge-fg841. FG-848 PR #379 is red 3x on exactly this → hold FG-848 until FG-841 lands, then rebase #379. FG-845 p1: fix batch 273dd3bf; docs stage launch-fg845-review-p1-docs-y5sp13.

FG-845 p1: docs cycle 9bf9af4f pushed; ci-wait ciwait-7757d2ed5073 on PR 380. On green: continue --all --acceptance fg845/acceptance-part1.json --docs-closeout fg845/docs-closeout-part1.json --project ~/code/forge-fg845, merge, append close-grid-part1.md (ticket stays open for the dashboard part).

FG-845 PART 1 SHIPPED: PR #380 merged as eda85cb5 (review-17fefd1cab3f settled at 9bf9af4f; part-1 grid appended; ticket OPEN for AC 3-5 dashboard part — needs an approved mock in --design-dir before the engineer). Clone forge-fg845 removed. Host needs forge upgrade for seeds/constraints/no-ai-attribution.md (plus the earlier FG-839/FG-842 seed edits) — operator-run. Follow-ups filed: FG-851 (other config writers), FG-853 (host allow invisible in containers).

FG-852: committed 17d8d280 on the reused ~/code/forge-fg849 clone, PR #381, ci-wait ciwait-f76651372746; review files staged in scratchpad/fg852 (route testing_automation, run run-fg-852-remote-e2e-date-header-22672e). Dashboard health check: fine — headless needed ~20 s for the first poll batch; not a regression.

FG-845 PART 2 mock drafted (NOT yet approved by the operator): scratchpad/fg845/design/attribution-mock.html + .png — one 'Git attribution' row in the Config SOURCES table (mode + source tag + file + host default + checkout + rendered-block sync), a controls card under the table (This project: suppress|allow|inherit host default → set/unset; Host default: suppress|allow → set --host; Preview → Confirm through the registry), the stale-block notice, and one 'Git attribution: <mode> <source tag>' line per Projects card (tags: project override / host default / built-in default / fail-closed). Baselines: live-config.png, live-projects.png. On approval: new clone, engineer with --design-dir scratchpad/fg845/design, route implementation_quick, then test-engineer (browser cases + census), docs, review with AC 3–5.

FG-852: CI 15/15 at 17d8d280; review start launch-fg852-review-start-ann7gg; close grid staged scratchpad/fg852/close-grid.md. Then continue --all, merge #381, close, and the ~/code/forge-fg849 clone can be removed once FG-849's Safari check lands.

FG-852 CLOSED: PR #381 merged as 71833824 (review-041054b8621a settled at 17d8d280; grid appended). ~/code/forge-fg849 reset to main (kept until FG-849's Safari check; then rm). Open: FG-841 TE (launch-fg841-test-engineer-bi7uxp), FG-848 PR #379 on hold for FG-841, FG-849 Safari, FG-845 p2 mock approval, FG-846, FG-847, FG-851, FG-853.

FG-851 started: clone ~/code/forge-fg851 branch fix/fg-851-config-writers-line-edit, engineer launch-fg851-engineer-hhcisl (route implementation_quick; brief scratchpad/fg851/engineer.md). Then test-engineer on the same run, docs, PR, CI, review.

FG-851: engineer done (7 files; init/migrate/mode-set surface ConfigWriteRefusal; projectKey:null now removes the line — flag in PR); test-engineer launch-fg851-test-engineer-du36hl; docs brief staged scratchpad/fg851/docs.md.

FG-851: docs reconciled (cutover how-to, concepts, quick-start); committed 7b738b5e, PR #382, ci-wait ciwait-74aba6cf8e15. Review files complete in scratchpad/fg851 (contract wide+backend; acceptance; docs-closeout; close-grid with MERGE_SHA/REVIEW_ID placeholders). On green: review start FG-851 --route implementation_quick --run run-fg-851-config-writers-line-edit-333a67 --project ~/code/forge-fg851.

PR #382 (FG-851) red once on FG-841's ORIGINAL shape ('four shared mutation slots are occupied', fg834-raci-enforcement.test.ts:192) in CI job test — first time in CI, on a branch that touches nothing under dashboard/. Recorded on FG-841 with the mechanism (occupancy sampled before the 4th admission). Rerun queued (ciwait-42569c5bf269). When the FG-841 TE result lands: if it did not fold this case in, dispatch a bounded second TE pass on ~/code/forge-fg841 before commit (waitFor over occupancy / deterministic admission signal).

FG-851: CI 15/15 at 7b738b5e after one rerun (FG-841 slot flake); review start launch-fg851-review-start-2ylxf3. Then dispositions, continue --all --acceptance fg851/acceptance.json --docs-closeout fg851/docs-closeout.json, merge #382, close with fg851/close-grid.md, rm ~/code/forge-fg851. FG-841 TE still running (sequential 20/20 green; under-load pass done; writing up).

FG-841 TE pass 1 (status failed only because the full dashboard integration tier hung >18 min in the container on src/remote/tailscale/serve-process.integration.test.ts staying alive after its last assertion — LEAD, unrelated to the fix; verify on host before filing): fixtureFetch helper (Connection: close) in dashboard/src/test-support/fixture-fetch.ts, four fixtures switched, fg841-dashboard-keepalive.test.ts regression; fg823 sequential 20/20, under-load 5/5; on Node 24.21 the old shape did not reproduce in 4 trials (CI ECONNRESET remains the evidence). Pass 2 for the slot-occupancy shape: launch-fg841-te-2 (brief scratchpad/fg841/test-engineer-2.md). Then commit/push/PR, rebase FG-848 #379 afterwards.

FG-851 review-6442e0da6185 at 7b738b5e: RF-1 (init scaffolds before the config write, so a write-time refusal leaves side effects) fix_now; fix batch launch-fg851-review-fix-1ixkfh. Then docs stage, push, CI, continue --all, merge #382, close.

FG-841: committed 904e1892 (fixture-fetch helper + 4 fixtures + fg841-dashboard-keepalive.test.ts + fg834-raci-enforcement waitForCalls), PR #383, ci-wait ciwait-7882cae8fd2c; docs maintainer launch-fg841-docs-leue9k (spec-writer) will add a second commit. Review files: scratchpad/fg841/contract.json staged; acceptance/docs-closeout/close-grid to write once the ticket's AC text is confirmed. After merge: rebase FG-848 PR #379 (conflicts expected in fg823 fixtures + test-support/) and rerun its CI. FG-851: fix batch 58f3323e, docs stage launch-fg851-review-docs-yrhp21.

FG-851: fix batch 58f3323e (init writes config before any scaffold; new integration case), docs stage changed nothing; pushed, ci-wait ciwait-ece4370ddaa7 on PR 382. On green: continue --all --acceptance fg851/acceptance.json --docs-closeout fg851/docs-closeout.json, merge, close.

FG-841: docs committed 4fab2fee (dashboard/CLAUDE.md + how-to-testing.md), pushed; ci-wait ciwait-64b599662929 on PR 383. Host 3x unit-tier run launch-fg841-unit-tier-3x-z3kcop in flight (AC 2; fill UNIT_TIER_TALLY in fg841/acceptance.json + close-grid.md). On CI green: review start FG-841 --route testing_automation --contract fg841/contract.json --run run-fg-841-dashboard-econnreset-4ffbe5 --project ~/code/forge-fg841.

FG-841: CI 15/15 at 4fab2fee; review start launch-fg841-review-start-nf3ah9. Host 3x unit-tier run still in flight (launch-fg841-unit-tier-3x-z3kcop) — fill UNIT_TIER_TALLY before continue --all. FG-851: continue --all launch-fg851-review-all-anvwhz in flight; on settle merge #382 + close.

FG-851 CLOSED: PR #382 merged as a425ba7a (review-6442e0da6185 settled at 58f3323e; grid appended); clone removed. In flight: FG-841 review-3d5056a0c0e2 docs stage (launch-fg841-review-docs-at10fw) + host 3x run (launch-fg841-unit-tier-3x-z3kcop; runs 1-2 green). Then FG-848 rebase. Operator-gated: FG-849 Safari, FG-845 p2 mock.

FG-841: host 3x unit tier 3/3 green (AC 2 filled); docs + verify_final green at 4fab2fee; continue --all launch-fg841-review-all-12wjw7 (recheck no-op + shipping). On settle: merge #383, append fg841/close-grid.md (MERGE_SHA/REVIEW_ID=review-3d5056a0c0e2), close FG-841, rm ~/code/forge-fg841, then rebase FG-848 #379 onto main (expect conflicts in fg823 fixtures and dashboard/src/test-support/), re-register ci-wait.

FG-841 CLOSED: PR #383 merged as 6824141d (review-3d5056a0c0e2 settled at 4fab2fee; grid appended); clone removed. NEXT: rebase FG-848 PR #379 (~/code/forge-fg848, branch test/fg-848-fixture-readiness-guard) onto main 6824141d — conflicts expected in the four fg823/fg821/fg827/attention-inbox fixtures and dashboard/src/test-support/ (FG-841 added fixture-fetch.ts; FG-848 added await-dashboard-ready.ts) — via an engineer rebase pass, then push + ci-wait.

FG-848: mechanical rebase onto 6824141d conflicted (dashboard/CLAUDE.md, docs/how-to-testing.md, fg823-attention-dismiss-cli + fg827-roles-second-pass fixtures — FG-841's fixtureFetch vs FG-848's readiness probe); aborted; test-engineer rebase pass launch-fg848-rebase-3czgkk (brief scratchpad/fg848/rebase.md: readiness helper polls through fixtureFetch, docs merged, guard regex adjusted if needed). Then push --force-with-lease, ci-wait on #379, review start --route testing_automation --contract fg848/contract.json.

FG-848 rebased onto 6824141d by the test-engineer (readiness helper polls through fixtureFetch; docs merged); pushed force-with-lease; ci-wait re-registered on PR #379. On green: review start FG-848 --route testing_automation --contract fg848/contract.json --project ~/code/forge-fg848 --run run-fg-848-fixture-readiness-guard-646311 (contract lens scopes still cover the paths; add dashboard/src/test-support under frontend — already under dashboard/src/).

FG-848: CI 15/15 at 645bb2c8 on the FIRST attempt (dashboard tier green without rerun — FG-841 fix evidence); review start launch-fg848-review-start-rpqcak. Then dispositions, continue --all --acceptance fg848/acceptance.json --docs-closeout fg848/docs-closeout.json, merge #379, close with fg848/close-grid.md, rm ~/code/forge-fg848.

FG-848 review-c89c735989a1 at 645bb2c8: RF-1 (guard requires the literal 'const BASE', so a differently-named base URL escapes the rule) fix_now — detect by server import alone; fix batch launch-fg848-review-fix-tvqncu. Then docs stage, push, ci-wait #379, continue --all, merge, close.

FG-848: fix batch 9784a961 (guard detects by server import alone; two more negative cases), docs stage changed nothing; pushed; ci-wait ciwait-ecc90840417b on PR 379. On green: continue --all --acceptance fg848/acceptance.json --docs-closeout fg848/docs-closeout.json --project ~/code/forge-fg848, merge, close with fg848/close-grid.md (MERGE_SHA/REVIEW_ID=review-c89c735989a1), rm clone.

FG-848 CLOSED: PR #379 merged as a43b9863 (review-c89c735989a1 settled at 9784a961; grid appended); clone removed. Remaining active: FG-849 (operator Safari check; merged 85101651), FG-845 (part 2 dashboard — mock at scratchpad/fg845/design awaiting operator approval), FG-846 (queue refusal at point of action — needs a mock), FG-847 (needs_refinement in place — exploratory, needs a mock), FG-853 (carry resolved attribution into containers — backend). Host owes forge upgrade (seed edits from FG-839/842/845). Clones on disk: ~/code/forge-fg849 (main; rm after Safari check).

FG-846 + FG-847 combined Queue mock drafted (NOT yet approved): scratchpad/fg846/design/queue-refusal-mock.html + .png — refusal rendered as the next sibling of the control with focus + role=alert, gaps checklist + proposal + Refine… (FG-847: editor pre-seeded with missing sections, Save via forge backlog edit --body -, readiness re-run, Enqueue again), refused-card pill, placement rule reusable for FG-822/834/835. Baseline live-queue.png. Two mocks now await the operator: fg845/design/attribution-mock.png (FG-845 p2) and this one. FG-853 engineer launch-fg853-engineer-z8i214 in flight.

FG-853: engineer done (8 files; FORGE_AI_ATTRIBUTION_CARRIED set in src/v2/spawn.ts buildDockerArgs from the durable project; reader + hook mirror consult project → carried → host → default; doctor/show say '(carried)'); test-engineer launch-fg853-test-engineer-wexkaf; docs brief staged scratchpad/fg853/docs.md (use --model spec-writer). Then PR, CI, review (contract wide+backend+security like FG-845 p1).

FG-853: test-engineer FAILED on 3 real defects — buildDockerArgs read the inherited FORGE_AI_ATTRIBUTION_CARRIED (nested-container propagation), the hook accepted an extra ';extra=' field as allow, malformed carried values suppressed without naming the level. Engineer fix pass launch-fg853-engineer-fix1-usnil2 (brief scratchpad/fg853/engineer-fix1.md). Then docs (spec-writer), commit/push/PR, CI, review.

FG-853: fix pass done, docs reconciled (concepts + how-to-ai-attribution), committed d99e4f19, PR #384, ci-wait ciwait-690862c72e76. Review files complete in scratchpad/fg853 (contract wide+backend+security; acceptance; docs-closeout; close-grid with MERGE_SHA/REVIEW_ID placeholders). On green: review start FG-853 --route implementation_quick --run run-fg-853-attribution-carry-into-containers-bee9db --project ~/code/forge-fg853.

FG-853: CI 15/15 at d99e4f19 (first attempt); review start launch-fg853-review-start-pwmr9d. Then dispositions, continue --all --acceptance fg853/acceptance.json --docs-closeout fg853/docs-closeout.json, merge #384, close with fg853/close-grid.md, rm ~/code/forge-fg853.

FG-853 review-79823eaa4e57 at d99e4f19: security RF-1 'a container process can forge the carried allow and bypass a host suppress' → rejected_premise (anchored: the hook reads the mounted clone's own .forge/config.yml FIRST and lets it win — the container process already controlled the in-container outcome; the hook there is a guardrail, not a boundary; the host-side constraint/review gate is the boundary and is untouched). Worth an operator glance: if the operator wants the in-container hook to be adversarially robust, that is a new threat model, not this ticket. continue --all launch-fg853-review-all-n91kpy.

FG-853: docs cycle moved the candidate to 027ce10a (quick-start sentence); pushed; CI 15/15 at 027ce10a. First shipping attempt withheld on local_only + a local 'test: FAILED' that the review's own verified_final at the same sha contradicted (test: ok) — no case name recorded. Shipping re-run launch-fg853-review-ship-kz5xyy with CI as covering evidence. If it withholds on verification again, capture the runner output before deciding.

FG-853 CLOSED: PR #384 merged as bddb8d31 (review-79823eaa4e57 settled at 027ce10a; security RF-1 rejected_premise — see earlier note; grid appended); clone removed. ACTIVE NOW: FG-849 (operator Safari check only; merged 85101651; clone ~/code/forge-fg849 on main — rm after), FG-845 part 2 (mock awaiting approval), FG-846 + FG-847 (combined mock awaiting approval). Host owes forge upgrade (seed edits FG-839/842/845). Nothing in flight.

FG-845 PART 2 APPROVED by the operator (2026-10-01, 'build it'). Clone ~/code/forge-fg845b branch feat/fg-845-attribution-dashboard; npm ci launch-fg845b-npm-ci-pgkpnz; engineer brief scratchpad/fg845/engineer-part2.md with --design-dir scratchpad/fg845/design (attribution-mock.html/.png + live baselines). Chain: engineer → test-engineer (browser cases + census) → docs → PR → CI → review (AC 3–5; ticket closes when all five AC are met) → merge → close. Still operator-gated: FG-849 Safari check, FG-846/847 Queue mock, forge upgrade.

FG-845 p2: engineer launch-fg845b-engineer-5e6u72 (route implementation_quick, --design-dir scratchpad/fg845/design).

FG-845 p2: engineer done (22 files: attribution-render/view.js, ai-attribution-mutation.ts + 2 registry routes, config-graph aiAttribution DTO, Projects line, status tokens, shell CSS, CLAUDE.md route rows, 2 unit test files; screenshots in task-engineer-180fc6/screenshots); test-engineer launch-fg845b-test-engineer-cf55ze (new browser suite fg845-attribution-setting + census). Docs brief scratchpad/fg845/docs-part2.md; contract-part2.json staged.

FG-845 p2: test-engineer FAILED — real-Chrome case: Host default → allow → Confirm, then reload still shows 'suppress · built-in default'. Suspects: (1) the route's child does not inherit the server's FORGE_HOME so --host writes to another home (would be a product hazard too), or (2) a cached config-graph read. Engineer fix launch-fg845b-engineer-fix-jjm3cd (brief scratchpad/fg845/engineer-fix-part2.md). Browser suite fg845-attribution-setting (3 cases) registered in the census; docs/how-to-testing totals updated by the TE.

FG-845 p2: fix pass found NEITHER suspect real — --host write lands in the server's FORGE_HOME (runForgeVerb passes process.env), nothing caches the read; the browser case reloaded before the apply finished and its wait matched 'host default: none'. Test fixed; suite 3/3 green. Docs maintainer launch-fg845b-docs (spec-writer). Then commit/push/PR, CI, review (contract-part2.json: wide+frontend+backend+security).

FG-845 p2: docs reconciled (how-to-ai-attribution, SCHEMA-CONTRACT, concepts; CLAUDE.md + how-to-testing already by the agents); committed a84dc57d, PR #385, ci-wait ciwait-4160bcfdb20a. Review files: contract-part2.json, acceptance-part2.json, docs-closeout-part2.json, close-grid-part2.md (MERGE_SHA/REVIEW_ID placeholders). Maintainer flagged a PRE-EXISTING stale count in SCHEMA-CONTRACT's HTTP API intro ('eight' non-GET routes) — check whether fixed in the diff; else a one-line docs follow-up. On green: review start FG-845 --route implementation_quick --contract fg845/contract-part2.json --project ~/code/forge-fg845b --run run-fg-845-part-2-attribution-on-config-and-projects-b0bc9f.

FG-845 p2: SCHEMA-CONTRACT 'only non-GET routes are…' sentence (pre-existing stale, made worse by the two new routes) → bounded maintainer fix launch-fg845b-docs-fix-0nbuuv on the same clone; then commit, push, re-register ci-wait on #385 (the current CI run at a84dc57d is superseded), review start.

FG-845 p2: schema-contract sentence fixed, committed 06518e0e, pushed; ci-wait ciwait-4160bcfdb20a now tracks the new head. On green: review start FG-845 --route implementation_quick --contract fg845/contract-part2.json --project ~/code/forge-fg845b --run run-fg-845-part-2-attribution-on-config-and-projects-b0bc9f.

FG-845 p2: CI at 06518e0e red on ONE case — integ FG-845 attribution routes (fg835-model-policy-routes.integration.test.ts:526): GET /api/control-plane returns no aiAttribution on the Linux runner (passed in the container). Suspects: a control-plane/config-graph branch that omits the field (unregistered checkout, realpath mismatch, partial graph on a warning path). Engineer fix2 launch-fg845b-engineer-fix2-a60jbj (brief scratchpad/fg845/engineer-fix2-part2.md). Then commit/push, ci-wait #385, review start.

FG-845 p2: CI red was the TEST reading a nonexistent /api/control-plane (404) — not the runner; fixed to /api/config-graph (the page's route); committed 6c878df5, pushed, ci-wait ciwait-69f113b7fdcc. Memory saved: verify agent 'ran green' claims against container stdout. On green: review start FG-845 --route implementation_quick --contract fg845/contract-part2.json --project ~/code/forge-fg845b --run run-fg-845-part-2-attribution-on-config-and-projects-b0bc9f.

FG-845 p2: CI 15/15 at 6c878df5; review start launch-fg845b-review-start-wk7q4n (contract-part2: wide+frontend+backend+security). Then dispositions, continue --all --acceptance fg845/acceptance-part2.json --docs-closeout fg845/docs-closeout-part2.json, merge #385, append close-grid-part2.md (all five AC met → close FG-845), rm ~/code/forge-fg845b, restart the dashboard.

FG-845 p2: review start refused once (src/store/events.ts outside every lens scope — the new event type); backend scope now includes src/store/; relaunched launch-fg845b-review-start2-7zquay.

FG-845 p2 review-e3b4be5ff08a at 6c878df5: RF-1 audit-insert failure reported as a failed apply after the file changed (fix_now), RF-2 Escape does not dismiss the preview + weak browser assertion (fix_now), RF-4 ai-attribution-mutation.ts missing from release closure (fix_now), RF-3 security shard inconclusive — ai-attribution-mutation.ts was outside my security scope → host replay launch-fg845b-routes-replay-xebjs6 of fg845-attribution-routes.test.ts for a rejected_premise with replayed_command, then continue (fix batch). Lesson: list NEW files explicitly in the security lens scope.

FG-845 p2: host replay of the dashboard unit tier at 6c878df5 FAILED one case — fg845-attribution-routes 'a caller path is never --project' compares a raw mkdtemp path to the registry's realpath (/var vs /private/var on macOS; CI Linux green). Decision: ONE engineer pass (launch-fg845b-engineer-fix3) fixes RF-1/RF-2/RF-4 + the macOS assertion; then hand commit, push, CI, FRESH review start (review-e3b4be5ff08a superseded; security scope now names ai-attribution-mutation.ts). Lesson: run the dashboard unit tier on the host before review for dashboard tickets that spawn children with tmp checkouts.

FG-845 p2: fix3 committed fc9a55d4 (audit-gap reporting, Escape, release closure, canonical-path assertion), pushed, ci-wait ciwait-89e8ca56e1f3. Engineer noted two OUT-OF-SCOPE macOS/symlinked-TMPDIR failures already on main: fg799-config-ai-attribution.integration 'doctor prints the effective ai attribution line' (FG-853) and src/v2/loader.test.ts 'returns source=host when only workspace copy present' — host check launch-fg845b-drift-check-ljiq8r; file ONE ticket if confirmed. On CI green: FRESH review start FG-845 --contract fg845/contract-part2.json (security scope now explicit) --route implementation_quick --run run-fg-845-part-2-attribution-on-config-and-projects-b0bc9f --project ~/code/forge-fg845b.

Filed FG-854 (macOS raw-temp-path assertion in the FG-853 doctor case; confirmed on host; loader case unconfirmed). FG-845 p2: CI at fc9a55d4 pending (13); fresh review start on green.

FG-845 p2: CI 15/15 at fc9a55d4; FRESH review start launch-fg845b-review-start3-4pcfxt (supersedes review-e3b4be5ff08a). Then dispositions, continue --all --acceptance fg845/acceptance-part2.json --docs-closeout fg845/docs-closeout-part2.json, merge #385, append close-grid-part2.md, close FG-845, rm clone, restart dashboard.

FG-845 p2 review-bd537bdc573c at fc9a55d4: RF-1 apply accepted with no audit row → fix_now (restore bytes + refuse 'audit_unrecorded'); RF-2 read-modify-write race in the shared line editor → fix_now (CAS before rename, in src/backlog/config.ts so all writers get it — NOTE: this touches FG-851's helper, machine-wide config writes); RF-3 Confirm transport failure leaves the control running → fix_now; RF-4 wide inconclusive → rejected_premise (anchored to the executed tests + other shards). Fix batch launch-fg845b-review3-fix-2avo7h; then docs stage, push, ci-wait #385, continue --all, merge, close FG-845.

FG-845 p2: fix batch 3721b352 (13 files: atomic apply-with-audit, CAS in the shared line editor, Confirm transport failure); docs stage launch-fg845b-review3-docs-t7cvp4. Then push, ci-wait #385, continue --all --acceptance fg845/acceptance-part2.json --docs-closeout fg845/docs-closeout-part2.json, merge, close.

FG-845 p2: fix batch 3721b352 added a 4th browser case WITHOUT the census bump (census says 3; docs 51/312) — CI job test will be red on the FG-642 guard. Plan: after the docs stage (launch-fg845b-review3-docs-t7cvp4) lands, engineer census pass (brief scratchpad/fg845/engineer-census-part2.md), hand commit, push, CI, FRESH review start (review-bd537bdc573c superseded). Rule reminder: name the census in fix_now rationales when a fix may add browser cases.

FG-845 p2: docs cycle moved the candidate to 0cd4ed4b (3 docs paths); engineer census pass launch-fg845b-engineer-census-j9ovwa running on the clone. Then hand commit, push, ci-wait #385, FRESH review start (review-bd537bdc573c superseded; contract-part2.json).

FG-845 p2: census pass committed 7967d1d9 (census 4; docs totals to verify), pushed, ci-wait ciwait-6c7820c3ac5c. On green: FRESH review start (review-bd537bdc573c superseded) with contract-part2.json; then continue --all, merge, close FG-845.

FG-845 p2: CI 15/15 at 7967d1d9; FRESH review start launch-fg845b-review-start4-5dllug (supersedes review-bd537bdc573c). On settle: continue --all --acceptance fg845/acceptance-part2.json --docs-closeout fg845/docs-closeout-part2.json, merge #385, append close-grid-part2.md, close FG-845 (AC 1-5), rm ~/code/forge-fg845b, restart dashboard, notify.

FG-845 p2: review start refused on src/backlog/config.ts + test (fix batch touched the shared line editor; scope lacked src/backlog/) — backend scope now has src/backlog/, security names src/backlog/config.ts; relaunched launch-fg845b-review-start5-jd0ckr at 7967d1d9.

FG-845 p2 review-6b796ca9adad at 7967d1d9: RF-1 crash window between rename and audit insert → deferred to FG-855 (filed: accept/reorder/journal, operator decides); RF-2 security inconclusive (unchanged mutation-guards.ts outside the diff shard) → rejected_premise anchored to the executed guard cases; RF-3 wide inconclusive → rejected_premise (same as before). continue --all launched; on settle merge #385, append close-grid-part2.md, close FG-845, rm clone, restart dashboard.

FG-845 p2: docs cycle moved the candidate to f80d9d7f (pushed; ci-wait ciwait-934d599fcb6d); recheck's new RF-4 (how-to wording on undo failure) deferred to FG-855; shipping stage launched. On settle + CI green: merge #385, append close-grid-part2.md (MERGE_SHA), close FG-845, rm clone, restart dashboard, notify.

FG-845 CLOSED (all five AC): PR #385 merged as 3c2c0e9a (review-6b796ca9adad settled at f80d9d7f; part 2 grid appended); clone removed; dashboard restarted on main at 3c2c0e9a. Nothing in flight. Open: FG-849 (operator Safari check; ~/code/forge-fg849 on main, rm after), FG-846 + FG-847 (combined Queue mock awaiting approval at scratchpad/fg846/design/queue-refusal-mock.png), FG-854 (macOS temp-path test drift, test-only), FG-855 (audit atomicity decision — operator). Host owes forge upgrade (seed edits FG-839/842/845).

FG-854 started: clone ~/code/forge-fg854 branch test/fg-854-canonical-tmp-paths; test-engineer launch-fg854-test-engineer-ykc7jb (route testing_automation; brief scratchpad/fg854/test-engineer.md). Then commit/push/PR, ci-wait, review start (contract wide+backend), continue --all, merge, close.

FG-854: TE fixed 2 files (provenPhysical on the expectation; sweep: fg845 routes already fixed, loader n/a); committed ca88cedb, PR #386, ci-wait ciwait-d359a4eb7be5; review files staged in scratchpad/fg854 (route testing_automation, run run-fg-854-canonical-tmp-paths-in-tests-fdba15). On green: review start, continue --all, merge, close, rm clone.

FG-854: CI 15/15 at ca88cedb; review start launched (fg854-review-start). Then continue --all --acceptance fg854/acceptance.json --docs-closeout fg854/docs-closeout.json, merge #386, close with fg854/close-grid.md, rm ~/code/forge-fg854.

FG-854 CLOSED: PR #386 merged as da73bf8b (review-0c99f02fc649 settled at ca88cedb; grid appended); clone removed. NOTHING IN FLIGHT. Active: FG-849 (operator Safari check; ~/code/forge-fg849 on main — rm after), FG-846 + FG-847 (combined Queue mock at scratchpad/fg846/design/queue-refusal-mock.png awaiting approval), FG-855 (audit atomicity decision — operator; recommendation (a) recorded). Host owes forge upgrade (seed edits FG-839/842/845). Dashboard on 8024 runs main at 3c2c0e9a (FG-845 p2).

OPERATOR DECISIONS 2026-10-02: (1) FG-849 Safari check confirmed → closed at 85101651, clone removed. (2) FG-846+FG-847 combined Queue mock APPROVED ('go') → one build on ~/code/forge-fg846 branch feat/fg-846-847-queue-refusal-in-place (mock + baseline in scratchpad/fg846/design). (3) forge upgrade run on the host (seed edits FG-839/842/845 landed). (4) FG-855: option (a) accept the crash window, file wins → docs-only change (ADR note under the FG-822 registry decision + one sentence in docs/how-to-ai-attribution.md + the RF-4 wording fix) on ~/code/forge-fg855 branch docs/fg-855-audit-window-accepted via documentation-maintainer; PR + CI; wide-lens review; close.

FG-846/847: engineer launch-fg846-engineer-wfbmcp (route implementation_quick, --design-dir scratchpad/fg846/design). FG-855: documentation-maintainer launch-fg855-docs-a06cby (spec-writer; brief scratchpad/fg855/docs.md). Watchdog armed.

FG-855: docs by the maintainer (ADR note, how-to-ai-attribution incl. RF-4 wording, how-to-model-policy); committed f03bc4c6, PR #387, ci-wait ciwait-8d8077a276b2; review files staged in scratchpad/fg855 (wide lens only; route documentation_durable; run run-fg-855-accepted-audit-window-docs-79aa67). On green: review start, continue --all, merge, close, rm clone.

FG-855: CI 15/15 at f03bc4c6; review start launch-fg855-review-start-mk00wg (wide only, route documentation_durable). Then continue --all --acceptance fg855/acceptance.json --docs-closeout fg855/docs-closeout.json, merge #387, close with fg855/close-grid.md, rm ~/code/forge-fg855. FG-846/847 engineer still running (launch-fg846-engineer-wfbmcp).

FG-855 review-fe17dc711000 at f03bc4c6: RF-1 (the ADR note generalized the attribution write-then-audit ordering to RACI apply, which does not do that) → fix_now; fix batch launch-fg855-review-fix-vyc8ie. Then docs stage, push, ci-wait #387, continue --all, merge, close.

FG-855: fix batch 2ec523d0 (ADR note now describes each apply's real ordering: model policy applyModelPolicy, RACI applyRaciChange, attribution; window scoped per apply); docs stage launch-fg855-review-docs-u6xaht. Then push, ci-wait #387, continue --all, merge, close.

FG-855: docs stage changed nothing at 2ec523d0; pushed; ci-wait ciwait-9503afa7e670 on #387; continue --all (verify_final/recheck/shipping) launched. On settle + CI green: merge #387, append fg855/close-grid.md, close FG-855, rm ~/code/forge-fg855.

FG-855: recheck's new RF-2 (ADR omits the undo-failure clause) — window spent → maintainer one-clause pass (fg855-docs-fix), hand commit, push, ci-wait #387, FRESH wide-lens review start (review-fe17dc711000 superseded), continue --all, merge, close.

FG-855: one-clause ADR fix committed b801337e, pushed; ci-wait ciwait-5300bb441229; FRESH wide-lens review start launched (fg855-review-start2; review-fe17dc711000 superseded). On settle + CI green: continue --all, merge #387, close FG-855 (fill REVIEW_ID/MERGE_SHA in fg855/close-grid.md), rm clone.

FG-855 review-ce1249423661 at b801337e: wide inconclusive → rejected_premise (anchored to config.ts:123; prior review adjudicated the docs-vs-code match). continue --all launched (fg855-review2-all). CI 15/15 at b801337e. On settle: merge #387, fill REVIEW_ID=review-ce1249423661 + MERGE_SHA in fg855/close-grid.md, close FG-855, rm clone.

FG-846/847: engineer done (31 files: action-outcome.js placement helper, refine-panel-view.js + refine-state.js, backlog-edit-mutation.ts registry route, readiness DTO via src/readiness, ticket page edit mode, 3 unit test files; screenshots match the mock — task-engineer-e84079/screenshots); test-engineer launch-fg846-test-engineer-8zsp0x (new browser suite fg846-queue-refusal + census). Docs brief scratchpad/fg846/docs.md; contract.json staged.

FG-855: docs cycle moved the candidate to 7b3c6ea9 (three one-line RACI-ordering touch-ups: SCHEMA-CONTRACT, concepts, how-to-use-forge-across-projects); verify_final's LOCAL run reported test: FAILED with no case name (docs-only diff; likely host-only). Pushed; ci-wait ciwait-30d9665ec230. On CI green: continue --all again (verification reuses CI evidence), merge #387, close FG-855.

FG-855 CLOSED: PR #387 merged as 1ed64f9d (review-ce1249423661 settled at 7b3c6ea9; grid appended); clone removed. In flight: FG-846/847 test-engineer launch-fg846-test-engineer-8zsp0x on ~/code/forge-fg846. Nothing operator-gated.

FG-846/847: test-engineer pass 1 returned FAILED (browser suite 2 cases written + census 2 + docs 315, but the dashboard-tier integration cases and the dashboard unit tier / per-file runs were not done) → rejected, pass 2 launched (fg846-te-2; brief scratchpad/fg846/test-engineer-2.md). Then docs (spec-writer), commit/push/PR, CI, review.

FG-846/847: TE pass 2 complete (3 integ FG-847 cases in fg835-model-policy-routes.integration.test.ts; browser suite 2 cases; census 2 / docs 315) BUT the container stdout shows '✖ integ FG-847: dashboard edit streams the body…' with no ✔ line → host replay launch-fg846-integ-replay-q55juk before trusting it. Docs maintainer launch-fg846-docs-kuwtz9 running. Acceptance/docs-closeout staged (DOCS_ placeholders). Then commit/push/PR, ci-wait, review start (contract.json), continue --all, merge, close FG-846 + FG-847.

FG-846/847: host replay confirmed all 3 integ FG-847 cases green; docs reconciled (SCHEMA-CONTRACT, concepts, cutover how-to, interactive-dashboard ADR; CLAUDE.md + how-to-testing by the agents); committed 902927f5, PR #388, ci-wait ciwait-e651f145f6bd. Review files in scratchpad/fg846 (contract.json wide+frontend+backend+security; acceptance.json 10 refs; docs-closeout.json). On green: review start FG-846 --route implementation_quick --run run-fg-846-847-…-f610e3 --project ~/code/forge-fg846 (the contract's acceptance_refs cover FG-847 too; close both tickets on settle).

FG-846/847: CI 15/15 at 902927f5 (first attempt); review start launch-fg846-review-start-azzya0. Contract backend scope now includes src/readiness/ + src/util/ (relaunch if the first start refused on scope). Then dispositions, continue --all --acceptance fg846/acceptance.json --docs-closeout fg846/docs-closeout.json, merge #388, append close-grid-846.md / close-grid-847.md, close both, rm clone, restart dashboard.

FG-846/847: first review start refused on src/readiness/readiness.ts (scope); backend scope extended; relaunched launch-fg846-review-start2-66974w at 902927f5.

FG-846/847 review-8beb7e5dda73 at 902927f5: RF-1 concurrent Refine saves overwrite (fix_now: CAS inside the store write, --base-revision through the CLI), RF-2 edit commits without its event / reported refused (fix_now: ticket write + event in ONE transaction — same SQLite store, unlike FG-855), RF-4 duplicate of RF-2, RF-3 late readiness response recorded into a new scope (fix_now: scope token), RF-5 docs contradiction on where readiness is evaluated (fix_now). Fix batch launch-fg846-review-fix-umfbkn. NOTE: a schema/transaction change to the ticket store is machine-wide (~/.forge/forge.db) — flag at merge. After the batch: grep browser suites for stranded assertions + check the census before pushing.

FG-846/847: fix batch 4670dc7e (11 files: CAS + single transaction in src/backlog/structured.ts + backlog.ts with --base-revision; scope-bound readiness fetch; outcome helper; docs); census consistent (2 cases / 2). Docs stage launched (fg846-review-docs). Then push, ci-wait #388, continue --all, merge, close FG-846 + FG-847, rm clone, restart dashboard.

FG-846/847: docs cycle moved the candidate to e576772c (3 docs paths); pushed; ci-wait ciwait-551412c0c740 on #388. On green: continue --all --acceptance fg846/acceptance.json --docs-closeout fg846/docs-closeout.json --project ~/code/forge-fg846 (verification reuses CI), merge, close both, rm clone, restart dashboard. Machine-wide note for the shipped summary: forge backlog edit gains --base-revision and the ticket write + event are one transaction in ~/.forge/forge.db (no schema change).

FG-846/847: CI at e576772c red on ONE case — the fix batch added --base-revision to the edit argv and updated the unit test but not the integ FG-847 'streams the body' expectation (stranded assertion, FG-843 class). Window spent → test-engineer pass 3 (fg846-te-3), hand commit, push, ci-wait #388, FRESH review start (review-8beb7e5dda73 superseded), continue --all, merge, close both. Lesson re-confirmed: a fix_now rationale that changes argv/rendered text must say 'sweep the integration and browser suites for the old shape'.

FG-846/847: stranded argv expectation fixed, committed 8aa55973, pushed; ci-wait ciwait-f9d6110e5da2; FRESH review start launched (fg846-review-start3; review-8beb7e5dda73 superseded). On settle + CI green: continue --all --acceptance fg846/acceptance.json --docs-closeout fg846/docs-closeout.json, merge #388, append close-grid-846.md / close-grid-847.md (REVIEW_ID + MERGE_SHA), close both, rm clone, restart dashboard, notify.

FG-846/847 review-a42e663b6b25 at 8aa55973: RF-1 route lets a save omit baseRevision (fix_now: required on the route), RF-2 late Refine-save outcome lands in a new scope (fix_now: scope token like the readiness fetch), RF-3 Dismiss drops focus (fix_now), RF-5 docs cycle put revision_moved text under Projects classify (fix_now), RF-4 security inconclusive — backlog-edit-mutation.ts was outside my security scope (rejected_premise anchored to the executed guard tests; scope now names it; memory rule added). Fix batch launch-fg846-review3-fix-o3qt9l. After it: sweep integ + browser suites for the new request shape, check census, docs stage, push, ci-wait #388, continue --all, merge, close both.

FG-846/847: fix batch 166a8934 (11 files; required baseRevision on the route with the integ case updated this time; scope-bound save outcome; Dismiss focus; docs placement); census consistent (2/2). Docs stage launched (fg846-review3-docs). Then push, ci-wait #388, continue --all, merge, close both, rm clone, restart dashboard.

FG-846/847: docs cycle moved the candidate to 2d789fb3 (one path); pushed; ci-wait ciwait-f49df466cab1 on #388. On green: continue --all --acceptance fg846/acceptance.json --docs-closeout fg846/docs-closeout.json --project ~/code/forge-fg846 (review-a42e663b6b25), merge, close FG-846 + FG-847 with their grids, rm clone, restart dashboard, notify.

FG-846/847: CI at 2d789fb3 red on ONE browser case from FG-845 ('a Confirm whose request never reaches the server … focus returns to the pressed control' false) — passed on this branch's two earlier CI runs and on main; batch 166a8934 added no global listener and attribution-view.js is untouched here → treated as a focus-timing flake, rerun requested (ciwait-a6761ee25a02). If it fails again: bounded fix pass on attribution-view.js's transport-failure focus restore (waitFor focus, not a one-shot), hand commit, fresh review.

FG-846/847: the FG-845 browser case passed on rerun (focus-timing flake, n=1 — note on the FG-845 case 'a Confirm whose request never reaches the server…' line 215 if it recurs). CI 15/15 at 2d789fb3; continue --all launched (fg846-review3-all). On settle: merge #388, close both, rm clone, restart dashboard, notify.

FG-846 + FG-847 CLOSED: PR #388 merged as 2bf7e583 (review-a42e663b6b25 settled at 2d789fb3; grids appended to both); clone removed; dashboard restarted on main at 2bf7e583. NOTHING IN FLIGHT; nothing operator-gated. Active backlog is empty of actionable tickets (FG-833 idea + v0.2.0 release gate are the operator's). Machine-wide: forge backlog edit gained --base-revision and the ticket write + event are one transaction (no schema change).

FG-856 STARTED (operator: 'actively blocking work on my work machine'): clone ~/code/forge-fg856 branch fix/fg-856-container-git-trust; engineer launch-fg856-engineer-d781q7 (route implementation_quick; brief scratchpad/fg856/engineer.md — BOTH halves: Dockerfile safe.directory /project exact + launcher-injected GIT_CONFIG_* for the resolved mount path across agent/probe/provisioner/reviewer containers, preserving existing entries; entrypoint + reconcile/invoke diagnostics name the ownership cause; real-Git root-owned regression with sudo chown, fail-loud when unavailable). AC 3 (work-machine invoke) is the operator's after merge: pull forge main, docker/build.sh, run an invoke on ~/code/dashboard. Chain: TE → docs → PR → CI → review → merge → close.

FG-856: engineer done (9 files: Dockerfile safe.directory /project exact; entrypoint prints Git's cause, ownership remedy on 'dubious ownership', worktree advice only when the gitdir target is missing; spawn.ts appendProjectGitTrust for the resolved mount path on every container kind, existing GIT_CONFIG_* preserved; invoke/runNext/reconcile preserve the cause; new src/v2/fg856-root-owned-mount-git-trust.worktree.test.ts fails loud without sudo). Test-engineer launch-fg856-test-engineer-v3tcrd. Then docs (spec-writer, scratchpad/fg856/docs.md), PR, CI, review (contract.json wide+backend+security), merge, close; AC 3 = operator's work-machine invoke after pull + docker/build.sh.

FG-856: test-engineer complete (spawn.test.ts +5 FG-856 cases incl. preserved GIT_CONFIG_* and bogus-count refusal; fg559 worktree +1; container stdout spot-checked ✔). Docs maintainer launch-fg856-docs-dq8r09 (spec-writer). Host image rebuild + ticket repro + in-container root-owned simulation launch-fg856-image-repro-l7le01 (scratchpad/fg856/repro.mjs) — fills AC 2; acceptance.json + close-grid.md staged with REPRO_/WORK_MACHINE_ placeholders (AC 3 is the operator's). Then commit/push/PR, ci-wait, review start (contract.json wide+backend+security), continue --all, merge, close.

FG-856: host verification DONE — image rebuilt from the branch, ticket repro + real entrypoint pass; in-image root-owned simulation refused without exception and TRUST_OK with the system entry (AC 2 filled). Docs: maintainer updated docs/concepts.md only (FG-856 sections at ~1228/1230) — checking whether work-laptop-setup / how-to-upgrade / quick-start need the rebuild + ownership remedy too. Committed fd1af8e4, PR #389, ci-wait ciwait-4240a3610455. On green: review start FG-856 --route implementation_quick --contract fg856/contract.json --run run-fg-856-…-e4eb99 --project ~/code/forge-fg856.

FG-856: docs pass 2 updated how-to-upgrade + work-laptop-setup; committed caa26727, pushed; ci-wait ciwait-4240a3610455 tracks the new head. Review files complete in scratchpad/fg856 (contract wide+backend+security; acceptance with AC 3 WORK_MACHINE placeholder for the operator; docs-closeout; close-grid). On green: review start FG-856 --route implementation_quick --run run-fg-856-…-e4eb99 --project ~/code/forge-fg856; continue --all; merge; close (AC 3 recorded when the operator confirms the work-machine invoke). Operator said 'It just reset' — unclear referent; asked.

FG-856: CI 15/15 at caa26727; review start launched (fg856-review-start; contract wide+backend+security). Then dispositions, continue --all --acceptance fg856/acceptance.json --docs-closeout fg856/docs-closeout.json (AC 3 entry is a bounded_inspection placeholder WORK_MACHINE_INSPECTION — fill with the operator's confirmation, or if the review's shipping stage refuses it, mark AC 3 pending and hold the close until the operator confirms), merge #389, close, rm clone, notify shipped with the rebuild instruction.

FG-856 review-74d05e975606 at caa26727: RF-1 provisioner drops runtime GIT_CONFIG_* (fix_now), RF-2 an unrestricted mount path could make the exception filesystem-wide (fix_now: validate absolute/normalized/non-root path equal to the mount, refuse otherwise), RF-3 wide inconclusive (rejected_premise anchored to executed tests). Fix batch launch-fg856-review-fix-8q2agn. OPERATOR DECISION PENDING: A = merge with AC 3 (work-machine invoke) recorded pending the operator's run under an explicit override, ticket stays open; B = hold the merge. Recommended A. After the batch: docs stage, push, ci-wait #389, continue --all (shipping will refuse acceptance_unmet on AC 3 → on A, forge gate --force with rationale naming the operator's authorization).

FG-856: first fix batch's fixer (task-engineer-d6ed6a) exited 0 with NO result.json (result_missing) — coordinator recorded nothing, batch stays open; its partial edits (mount-path validation + tests, looked complete) stashed on the clone as 'fg856 fixer d6ed6a partial'; batch retried launch-fg856-review-fix2-95dnta from clean caa26727. OPERATOR A/B on merging with AC 3 pending still open.

FG-856: retried fix batch landed e916fd9d (mount path must be absolute, normalized, below root, and the container side of an actual -v mount — else the dispatch refuses by name; provisioner preserves GIT_CONFIG_*; tests extended); stash dropped. Docs stage launch-fg856-review-docs-ifmr4u. Then push, ci-wait #389, continue --all (shipping refuses on AC 3 → operator A/B).

FG-856: docs cycle moved the candidate to 84825e5d (one path); pushed; ci-wait ciwait-2bb5fb548ad6 on #389. On green: continue --all --acceptance fg856/acceptance.json --docs-closeout fg856/docs-closeout.json — expect acceptance_unmet on AC 3 → needs the operator's A (gate --force with rationale, merge, ticket stays open) or B (hold).

FG-856 review-74d05e975606: verify_final + recheck at 84825e5d — RF-2 still_present per the rechecker ('a runtime mounting at / or another ancestor trusts every repo below'): '/' IS refused by the batch, and a plain ancestor entry is exact-match in Git (not recursive), but a value ending in '/*' (Git's recursive form) would pass the current checks — real residual gap. Window spent → engineer fix2 (refuse any glob char; unit cases) launch-fg856-engineer-fix2, hand commit, push, ci-wait #389, FRESH review start (review-74d05e975606 superseded). A/B on AC 3 still pending from the operator.

FG-856: fix2 committed 6a137729 (refuse glob chars in appendProjectGitTrust; unit cases; worktree case 'not for any other' already proves an ancestor entry does not cover a nested repo). Pushed; ciwait-9131faf45fe2 registered on PR 389, Monitor armed. Next on green: FRESH forge review start FG-856 (contract scratchpad/fg856/contract.json, --project ~/code/forge-fg856, run e4eb99); review-74d05e975606 superseded. Then dispositions, continue --all; expect acceptance_unmet on AC 3 → operator A/B (recommended A: gate --force w/ rationale, merge, ticket stays OPEN).

FG-856 review-dc5d4689f2d6: RF-1 (wide docs-only inconclusive) rejected_premise; docs cycle moved candidate to 1422f32f (pushed; ciwait-821a584e9bbf). Shipping stage refused: AC 1/4/6/7 'FAILED in the cited runner output' — the fg856 worktree suite needs passwordless sudo (sudo -n true asks for a password on this host) so it fails loudly in the host worktree run; CI worktree job 110964045218 (run 37044975154 @6a137729) executed all 7 cases ✔. Acceptance entries for AC 1/4/6/7 rewritten as bounded_inspection citing that CI execution (backup acceptance.regression-tests.bak.json). On CI green at 1422f32f: re-run continue --all; expect only AC 3 unmet → operator A/B. Consider a follow-up: let the suite fall back to GIT_TEST_ASSUME_DIFFERENT_OWNER when sudo is unavailable so hosts without passwordless sudo can execute it.

FG-856: CI at 1422f32f (docs-only) 13/15 — integration_4 failed on src/campaign/fg753-terminal-recovery.integration.test.ts '--terminal-recovery: a campaign_system residual…' with ENOTEMPTY on its temp dir (cleanup race; passed at 6a137729 with identical code). gh run rerun --failed issued; ciwait-1677fc6d482f + Monitor. Shipping stage relaunch now blocks ONLY on verification_green (that CI job) and AC 3. On green: relaunch continue --all → AC 3 only → operator A/B.

FG-856 DECISION PENDING: review-dc5d4689f2d6 at 1422f32f fully settled (RF-1 rejected_premise; verify_final green; recheck clean; CI 15/15 after one unrelated integration_4 flake rerun; tip equal). Shipping stage refuses ONLY acceptance_unmet on AC 3 (operator's work-machine invoke). Milestone decision_needed emitted (fg856-ac3-merge-decision). A (recommended): squash-merge PR 389 under a recorded override, append close-grid, ticket stays OPEN for AC 3, rm clone, dashboard restart, notify shipped with rebuild instruction. B: hold. Merge is NOT done until the operator answers.

FG-856 SHIPPED per operator A: PR 389 squash-merged as 146802d3 under a recorded override (only AC 3 unmet). Acceptance Evidence grid appended to FG-856 (revision 2; AC 3 row 'pending'). Clone ~/code/forge-fg856 removed; dashboard restarted on main at 146802d3 (launch-dashboard-p41n17); shipped milestone emitted. FG-856 stays OPEN until the operator records AC 3 (work machine: git pull, docker/build.sh, ordinary-checkout forge invoke; record image id, checkout sha, run id) — then close with --commit 146802d3. Backlog otherwise empty of actionable tickets; FG-833 idea and the v0.2.0 release gate are the operator's.

FG-857 filed (agent image ubuntu:22.04 glibc 2.35 → better-sqlite3@13 linux prebuild needs GLIBC_2.38; blocks SBMCP-1 on the work machine). Clone ~/code/forge-fg857 branch fix/fg-857-agent-image-ubuntu-24 (npm ci done). Engineer launch-fg857-engineer-nmyqri (route implementation_quick; brief scratchpad/fg857/engineer.md — agent cannot docker build; it reports host_verification_commands for me to run under forge launch). Then: host image build + in-image checks + fg559/fg856 worktree suites, TE, docs (rebuild instruction), PR, ci-wait, review, merge. FG-856 still OPEN for AC 3 (operator reports git trust fixed on the work machine; image id/sha/run id not yet recorded).

FG-857 host verification: image rebuilt on ubuntu:24.04 (id 6e6e1b92, launch-fg857-image-build2-phoymq; first attempt hit a registry metadata DeadlineExceeded, pull then rebuild). Harness launch-fg857-verify-image-uv4b5f: post-fix PASS (glibc 2.39, agent 1000:1000, no ubuntu user, sudo, tools, FG-856 trust entry, better-sqlite3@13.0.1 linux-arm64 prebuild loads, 43/43 FG-559/FG-856/FG-376 cases inside the image, 0 skipped); pre-fix falsification PASS (22.04 fails glibc-floor + GLIBC_2.38 not found). TE done (10 tests, 2 files). Docs maintainer launch-fg857-docs-86nmt2 running; FG-551 launch tier launch-fg857-verify-launch-tier running. Next: commit (exclude docker/corp-root.pem build placeholder), push, PR, ci-wait, review.

FG-857: committed 43e4fcd5, PR #390, ciwait-d9ecb1ac24fb. Contract + docs-closeout written (scratchpad/fg857). In flight: FG-551 launch tier (launch-fg857-verify-launch-tier-0sebuu), emulated amd64 build to tag agent-dev-worker:fg857-amd64 (launch-fg857-build-amd64-yb05uc) for AC 1's amd64 clause. On CI green: forge review start FG-857 --contract scratchpad/fg857/contract.json --route implementation_quick --project ~/code/forge-fg857 --run b19ee4; acceptance.json to write once amd64 result is in. Maintainer flagged pre-existing staleness (quick-start 'Node 20'; '(DEC-009)' label on the agent-user layer) — out of scope, not filed.

FG-857: CI 15/15 at 43e4fcd5 (PR #390). Review start launch-fg857-review-start-9z7wsz (contract scratchpad/fg857/contract.json). FG-858 filed: verify-launch-tier-in-image.sh runs the tier without the FG-728 build preload (14 CLI cases fail 'Cannot find module .forge-integration-build/cli/index.js' in both arms; pre-existing, not the rebase). acceptance.json written (AC 1 has AMD64_PLACEHOLDER pending launch-fg857-build-amd64-2-pctsvj). Clone's corp-root.pem is build.sh's placeholder — never commit it.

FG-857 review-5322807d8cec at 43e4fcd5: RF-1 (wide scope-bound inconclusive) rejected_premise; docs stage no-op; verify_final green; recheck no-op. Shipping stage NOT yet run: acceptance.json AC 1 still has AMD64_PLACEHOLDER pending the emulated amd64 build (launch-fg857-build-amd64-2-pctsvj; its docker pull --platform linux/amd64 has produced no output for 6 min — registry flaky today). On amd64 result: fill AC 1, forge review continue --all --acceptance --docs-closeout, then merge #390, close FG-857 with the merge sha, rm clone, dashboard restart, notify shipped (operators rebuild image). FG-858 filed for the launch-tier harness.

FG-857: amd64 emulated build failed 3x on registry fetch of linux/amd64 ubuntu:24.04 (DeadlineExceeded x2; one pull hung 30 min, SIGKILLed by PID 72443) while arm64 works. AC 1 recorded unmet for the amd64 clause (arm64 build executed). Shipping stage launched (launch-fg857-review-ship-w6swmr); expect acceptance_unmet on AC 1 only → operator A/B (A: merge under override, ticket stays open until an amd64 build is recorded; B: hold).

FG-857 DECISION PENDING: review-5322807d8cec settled (RF-1 rejected_premise; verify green; recheck no-op); CI 15/15 at 43e4fcd5; shipping refuses ONLY on AC 1's amd64 clause (unexecuted — registry fetch failures from this host). Milestone fg857-amd64-merge-decision emitted. A (recommended): squash-merge #390 under override, append grid (AC 1 'pending amd64'), ticket stays OPEN; rm clone; dashboard restart; notify shipped with rebuild instruction. B: hold.

FG-857 SHIPPED per operator A: PR 390 squash-merged as 770eeb1c under a recorded override (AC 1 amd64 clause pending). Grid appended (revision 2). Clone removed; prefix image removed; dashboard restarted on main at 770eeb1c (launch-dashboard-8iccxe); shipped milestone emitted. Host image agent-dev-worker:latest is already the 24.04 build from the identical Dockerfile. OPEN awaiting operator records: FG-856 AC 3 (work-machine ordinary-checkout invoke: image id, checkout sha, run id — operator reported 'git fixed'), FG-857 AC 1 amd64 (an amd64 build, or confirmation the work machine is arm64 → close). FG-858 (launch-tier harness preload) is actionable next. FG-833 idea and the v0.2.0 release gate remain the operator's.
