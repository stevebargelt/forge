---
id: FG-148
type: story
status: done
title: "red-narrow investigation: 6 of 7 verdicts are process-noise; rework or retire"
closed: 2026-06-19
---

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