---
id: FG-247
type: story
status: done
title: Implementer seeds' mandatory validation misses tsc type-check + format-check — forge-clean changes fail CI
closed: 2026-06-20
---

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