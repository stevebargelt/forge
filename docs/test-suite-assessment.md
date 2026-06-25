# Test Suite Health Assessment

**Snapshot date:** 2026-06-24 · **Scope:** all `src/**/*.test.ts` (139 files, ~1796 `test()` calls)

Point-in-time analysis of whether the suite is necessary and non-overlapping. Findings were gathered by read-only survey agents and synthesized here; **treat the specific deletion candidates as leads, not verdicts** — confirm a given assertion is genuinely covered elsewhere before removing it. This is an assessment, not a change: no tests were modified.

## Bottom line

The suite is **healthy overall**, not bloated in a way that's hiding bugs. Estimated **~8–15% redundancy/over-granularity**, concentrated in three pockets. The dominant structural pattern — a `foo.test.ts` (pure functions) + `foo.integration.test.ts` (real CLI spawn / real DB / real fs) pair per module — is a *sound* seam split; the cost is that the integration layer occasionally re-asserts logic the unit layer already proves.

Highest-ROI, lowest-risk cleanup: table-drive the granular formatter tests and de-dupe the RACI schema tests. The 20 ticket-named `fgNNN-*` files are mostly justified but suffer a discoverability/setup-duplication smell worth addressing by **reorganization, not deletion**.

## Findings by confidence

### High confidence — concrete, cited overlap

| Area | Finding | Suggested action |
|------|---------|------------------|
| **RACI schema dedup** (`src/raci/`) | The `accountable=human` / malformed-grammar / required-field constraints are tested across `parse.test.ts`, `policy-schema.test.ts`, AND `route-validate.test.ts`. `compile.test.ts:84-86` ("output validates against RoutingPolicySchema") asserts a schema that `compile.ts` already guarantees by construction. ~8–10 tests re-assert the same constraints. | Consolidate grammar/schema assertions into `policy-schema.test.ts`; keep `parse.test.ts` for grammar-only cases; drop the `compile.test.ts` schema-roundtrip assertion. |
| **`show.test.ts` over-granularity** (94 tests) | ~15–20 tests are one-assertion-per-case formatter tests: `formatTimeAgo` (4), `computeElapsed` (5), `tailLines` (6), `deriveNextCommandForTask` (6), `groupFailedByKind` (4). The *logic* is trivial; the cases differ only by input/output. | Convert to table-driven (`[input, expected]`) — ~20% file reduction, no coverage loss. Keep the genuinely subtle ones (`getFailureKindFromEvents`, reconcile `#298` state machine). |
| **backlog unit vs integration** | `structured.test.ts` (42) and `structured.integration.test.ts` (53) re-assert the same filter/move/dedup logic across the function seam and the CLI seam — e.g. `listTickets filters by type` ↔ `backlog list --type epic`; `moveTicket`/`closeTicket` ↔ `backlog move`/`backlog close`. ~5–8 tests overlap. | Keep unit as the contract layer; trim the integration layer to 1–2 smoke tests per command (it still earns its place for argv/error-message/real-fs coverage). |
| **`auth-profiles.test.ts` `fmtExpiry`** (5 tests) | Pure output-format assertions whose underlying state is already exercised by the `profileStatus` tests. | Drop to 1–2 smoke cases. |
| **`creds.test.ts` OAuth hint helpers** (7 tests) | Mostly trivial round-trip / atomicity / env-override getters; only the stale-volume-mismatch case is high value. (Note: the other 60 `creds.test.ts` tests are **justified** — low-level env parsing that fails silently warrants the granularity.) | Consolidate the 7 hint tests to ~2. |
| **`notify/format.test.ts` SMS-length** (5 tests) | Assert platform constraints (160-char segments) per message, not behavior. | Keep 1 representative; the rest add little. |
| **`cancel` / `backlog-notes` unit↔integration** | 3–4 state-transition overlaps in cancel; 2–3 append/replace overlaps in notes. | Move basic state assertions to the integration layer; keep unit tests for pure logic only. |

### Medium confidence — structural, not deletion

- **The `fgNNN-*` ticket-scoped files (20 files, mostly `src/v2/`).** Survey of the dispatch family (`fg351/352/353/354/381-dispatch`) found they exercise **distinct dispatch seams** — worktree mount substitution, merge-back, fanout-integration state machine, persistence-check scope, context-packet assembly — and are *complementary* to the module unit tests (`spawn`, `invoke`, `runNext`, `worktree-lifecycle`), not redundant with them. Several even use falsification tests (e.g. `fg354-dispatch` proves the check uses the worktree path, not naive `projectDir`). **Do not bulk-delete these.** The real costs are (a) every file re-implements `makeTmpDir`/`initGitRepo`/`ensureDispatchTestRuntime` setup, and (b) ticket-number naming makes the suite's behavioral coverage opaque. *Caveat: this is the one cluster the survey rated "all necessary"; that clean a verdict over 20 files warrants a spot-check before relying on it.*

### Low / no concern

- `store/` (per-table accessors), `init.test.ts` (49 — deep block-merge/hook logic, well-separated from its 5 integration tests), `model-calls.test.ts` (36 — three functionally-distinct log extractors), and the adversarial regression files (`fg389-*-adversarial`) are clean — coverage tracks function boundaries with little overlap.

## Recommended next steps (in ROI order)

1. **De-dupe RACI schema tests** — remove ~8–10 redundant constraint assertions; lowest risk, clear duplication.
2. **Table-drive `show.test.ts` formatters** — ~20% reduction in the largest unit file, zero coverage loss.
3. **Trim backlog/cancel/notes integration re-assertions** — keep smoke + seam coverage, drop logic re-tests.
4. **Reorganize (don't delete) the `fgNNN-*` cluster** — extract a shared dispatch-test harness; consider renaming files to the behavior they guard (the ticket number can live in a comment). This is the biggest *maintainability* win even though it removes few tests.

Each of 1–3 is a small, isolated change. If pursued, route as a normal engineer task **per area** (not one mega-PR), and re-run the full host suite after each — the point is fewer tests, not fewer guarantees.
