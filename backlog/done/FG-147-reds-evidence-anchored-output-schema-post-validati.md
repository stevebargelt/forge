---
id: FG-147
type: story
status: done
title: "Reds: evidence-anchored output schema + post-validation to catch hallucinated citations"
---

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