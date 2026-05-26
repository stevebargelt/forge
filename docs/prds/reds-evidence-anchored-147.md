# SPEC — Reds: evidence-anchored output schema + post-validation (#147)

**Status:** draft, awaiting confirmation
**Backlog linkage:** closes #147. Composite with #148 (red-narrow investigation) — #147 lands first; if red-narrow's signal-to-noise still looks bad after, #148 revives as actual investigation work.

## Objective

Mechanically validate that red-agent findings cite real code. Drop findings whose `quoted_text` doesn't appear at the cited `file:line`. Downgrade `fail` verdicts to `inconclusive` when all findings get dropped (meaning the red's "evidence" was entirely hallucinated).

After this lands:

- Every red finding can optionally carry `{file, line, quoted_text}`. When present, all three get validated against the actual project source.
- The validator is a pure function (`validateVerdict(v, projectDir) → {validatedVerdict, droppedFindings[]}`). Called between `runOneRed` returning and `insertVerdict` writing to the DB.
- Findings without `file/line/quoted_text` pass through unchanged (the validator doesn't punish reds reviewing prose-y artifacts like architect outputs where source-anchoring isn't always applicable).
- A `fail` verdict whose findings are 100% dropped post-validation downgrades to `inconclusive` with a synthesized note. This is the load-bearing part — it un-blocks runs that would have been blocked by hallucinated evidence.
- Red seeds get updated to require the new fields and warn that un-anchored findings will be silently dropped.

**Expected impact**, calibrated against the existing 23 verdicts in `~/.forge/forge.db`:
- 4 verdicts (17%) had hallucinated citations; all of those findings would be dropped.
- 2 of those were authoritative `fail` blocks at confidence 0.95 (both red-backend on `run-pocket-v1-prompt-practice-and-weakness-engine-*`). Both would have been downgraded to inconclusive — runs NOT blocked.
- red-narrow's 6 process-noise verdicts (ungrounded findings) are unaffected by validation (no citations to validate). Separate ticket #148 covers that.

## Out of scope (deferred)

- **K-of-N self-consistency sampling** (research technique #2). Defer; revisit after #147 lands and we see the cleaner verdict stream.
- **Ground-truth feedback capture** (research technique #3, `forge gate --feedback`). Defer.
- **Per-finding waiver / suppression mechanism.** Out of scope; separate ticket if needed.
- **Retroactive validation of historical verdicts.** New rule applies only to new verdicts written after this lands.
- **Rubric anchoring / severity tiering** (research technique #5). Doesn't address the dominant FP pattern (hallucination); defer.
- **Changing the verdict aggregation rule in `gate.ts`.** Aggregation logic stays — only the per-finding validation upstream of insertVerdict changes.
- **Anything that changes the LLM behavior beyond the schema instruction.** The validator is the load-bearing change; seed updates are just to make reds emit the data the validator wants.

## Commands (no CLI changes)

This spec adds no new CLI surface. Behavior change is at the runtime verdict-write path. Users invoke forge exactly as today.

## Project structure (files touched)

### Code

- `src/types/index.ts` — extend `Finding` type with three optional fields:
  ```ts
  export type Finding = {
    severity: "high" | "medium" | "low";
    summary: string;
    evidence: string;
    hypothesis: string;
    // #147: optional source anchoring. When present, all three must be set
    // together. The validator drops findings where the quoted_text doesn't
    // appear at file:line. Findings without these are kept un-anchored.
    file?: string;
    line?: number;
    quoted_text?: string;
  };
  ```

- `src/v2/validate-findings.ts` — NEW. Pure module exporting:
  - `validateFinding(f: Finding, projectDir: string): { ok: true } | { ok: false; reason: string }` — pure, deterministic.
    - If finding has no `file/line/quoted_text` → `{ ok: true }` (un-anchored findings pass through).
    - If `<projectDir>/<file>` doesn't exist → `{ ok: false, reason: 'file does not exist' }`.
    - If `line` is past EOF → `{ ok: false, reason: 'line N > file has M lines' }`.
    - If `quoted_text` doesn't appear in `±3 lines` of context around `line` → `{ ok: false, reason: 'quoted_text not found at file:line ±3' }`.
    - Otherwise → `{ ok: true }`.
  - `validateVerdict(v: Verdict, projectDir: string): { validated: Verdict; dropped: Array<{finding: Finding; reason: string}> }` — applies `validateFinding` to each finding; collects survivors + drops.
    - If all findings dropped AND original verdict was `fail`: returns `{ verdict: 'inconclusive', confidence: v.confidence, findings: [], notes: 'all N findings dropped post-validation (hallucinated citations); verdict downgraded to inconclusive' }`.
    - Otherwise: returns `{ ...v, findings: survivors }`.
  - `~80 LoC including comments`.

- `src/v2/runNext.ts` — wire the validator. In `runReds` (the function that handles `insertVerdict`), call `validateVerdict(r.verdict, args.projectDir)` before insert. Use the validated verdict for both the DB write and the `authoritativeFail` check. Log `verdict.findings_dropped` event when any drops occur. `~10 LoC change.`

- `src/store/events.ts` — add `"verdict.findings_dropped"` to the `EventType` union. ~1 line.

### Seeds

- `seeds/agents/red-wide/CLAUDE.md`
- `seeds/agents/red-narrow/CLAUDE.md`
- `seeds/agents/red-frontend/CLAUDE.md`
- `seeds/agents/red-backend/CLAUDE.md`
- `seeds/agents/red-security/CLAUDE.md`

Each gets a new "**Evidence anchoring (required)**" section with:
- New required output: each finding SHOULD include `file`, `line`, and a 1-3 line verbatim `quoted_text` from that location whenever the finding refers to specific code.
- Explicit warning: "findings with `file:line:quoted_text` that don't validate (file missing, line out of bounds, or quoted text not appearing within ±3 lines of cited line) are SILENTLY DROPPED. Findings without `file:line:quoted_text` are kept un-anchored — use this only when the concern truly isn't tied to specific code (e.g. abstract design gaps)."
- Updated output schema example showing the new fields.

Reinstall via `FORCE=1 ./scripts/install-seeds.sh` after editing.

### Tests

- `src/v2/validate-findings.test.ts` — NEW. Pure unit tests. ~10 tests:
  - `validateFinding: returns ok for un-anchored finding (no file/line/quoted_text)`
  - `validateFinding: returns ok when quoted_text appears exactly at file:line`
  - `validateFinding: returns ok when quoted_text appears within ±3 line window of file:line`
  - `validateFinding: rejects when file does not exist`
  - `validateFinding: rejects when line is past EOF`
  - `validateFinding: rejects when quoted_text doesn't appear at file:line ±3`
  - `validateVerdict: passes verdict through unchanged when all findings validate`
  - `validateVerdict: filters out invalidated findings`
  - `validateVerdict: downgrades fail → inconclusive when all findings dropped`
  - `validateVerdict: leaves pass / inconclusive unchanged even when all findings dropped`

Tests use a tmpdir + writeFileSync pattern to set up controlled project sources. Same convention as `consent.test.ts`.

### Docs

- `docs/concepts.md` — extend the **Verdict** entry to mention post-validation: "Findings with `{file, line, quoted_text}` are mechanically validated against the project source; un-anchored findings pass through. A `fail` verdict whose findings all fail validation downgrades to `inconclusive`."

## Code style

- TypeScript strict, ES modules, `.js` suffix on imports.
- `validate-findings.ts` is pure (no I/O beyond `readFileSync` for the project source). No global state.
- `Finding.file`, `.line`, `.quoted_text` are OPTIONAL in the type (backward compat with old DB rows + tests that don't use them). When emitted by agents, all three should be set together.
- No new dependencies.
- One comment in `validate-findings.ts` explaining the ±3 line window choice ("agents sometimes cite a line number that's off by a few because of formatter / whitespace drift; ±3 catches the common cases without being so wide it loses the anchor's value").

## Testing strategy

Baseline: 287/287 forge tests + 8/8 dashboard tests pass on `main` at `ff41394`.

### New tests
- ~10 tests in `validate-findings.test.ts`.

### Regression check
- `npm run typecheck` clean.
- `npm test` — 287 + 10 = ~297 pass.
- All existing v2 / store tests untouched.

### Manual verification

After implementation:
1. Re-run a simple `forge new feature "noop" --brief "..."` against the split-keyboard-teacher project (or any local project with sources).
2. When reds run, confirm the verdicts in DB show the new fields when reds cite source.
3. To verify the validator catches hallucinations: manually craft a verdict JSON (or use a synthetic stub-dockerExec test) where a finding cites a non-existent file. Verify the finding gets dropped and a `verdict.findings_dropped` event lands.
4. To verify downgrade: synthesize a `fail` verdict where ALL findings are hallucinated. Verify it lands in DB as `inconclusive` with the synthesized note.

### Retroactive sanity-check (one-shot)

After landing, write a small one-off script that runs `validateVerdict` against every historical verdict in `~/.forge/forge.db` and reports which would have been downgraded. Expected: at least 2 (the red-backend hallucinated blocks). If the count is higher, the validator may be over-aggressive; tune the ±3 window or quoted-text matching.

## Boundaries

### Always do
- Keep `validate-findings.ts` pure. No DB writes from the validator itself; the caller (`runNext.ts`) does the persistence.
- Validator must be idempotent: same input → same output.
- A finding that has `file/line/quoted_text` ALL set is validated; partial-set (e.g. only `file` and `line`, missing `quoted_text`) is treated as un-anchored.
- Log every drop via `logEvent('verdict.findings_dropped', { ... })` so diagnostics are queryable.
- Backward compat: old DB rows + old test fixtures continue to work.

### Ask first about
- Changing the ±3 line window.
- Making `file/line/quoted_text` REQUIRED on the `Finding` type (breaks existing fixtures + DB rows).
- Adding rubric tiering (severity-tier-based gating) — out of scope; separate research direction.
- Modifying `aggregateVerdicts` logic in `gate.ts` (verdict aggregation rule). Aggregation stays; only per-finding validation changes.

### Never do
- Mutate the verdict object in place. Return a new object.
- Make the validator throw on bad input — return a structured result.
- Add network calls or any I/O beyond `readFileSync` for the cited project file.
- Validate against anything other than the project source (no validating against git history, no validating against test files exclusively, etc.).
- Touch the state-machine status values or the Docker spawn pattern.
- Use `--no-verify` to skip hooks.

## Implementation order

1. **`Finding` type extension** in `src/types/index.ts`. Typecheck passes. No behavior change.
2. **`validate-findings.ts` + tests.** Pure module. All 10 tests pass.
3. **Wire into `runNext.ts`.** Call validator before `insertVerdict`; use validated verdict for the authoritativeFail check too. Existing tests still pass.
4. **`events.ts` extension** — add `verdict.findings_dropped` to the EventType union.
5. **Seed updates** — all 5 red seeds get the new evidence-anchoring section. Reinstall seeds.
6. **Manual smoke run** — one short workflow against a real local project. Verify validator behavior in real data.
7. **Retroactive sanity-check script** — run against historical DB verdicts. Confirm 2+ would have been downgraded; investigate if dramatically more.
8. **Backlog hygiene + commit.** Close #147 with the commit sha.

Each step is independently verifiable via typecheck + tests. Pause after step 6 if real-data behavior diverges from the test expectations.
