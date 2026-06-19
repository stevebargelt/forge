---
id: FG-73
type: story
status: done
title: "Reds-on-investigators: category mismatch; redirect parallel scrutiny to peer-investigation"
closed: 2026-06-19
---

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