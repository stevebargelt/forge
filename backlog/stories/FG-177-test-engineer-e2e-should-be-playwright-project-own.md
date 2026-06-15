---
id: FG-177
type: story
status: active
title: test-engineer E2E should be Playwright (project-owned), kept strictly separate from agent verification (browser-tools)
---

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