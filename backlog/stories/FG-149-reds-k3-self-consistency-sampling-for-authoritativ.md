---
id: FG-149
type: story
status: active
title: "Reds: K=3 self-consistency sampling for authoritative verdicts"
---

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