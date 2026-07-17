---
id: FG-586
type: story
status: active
title: an authoritative red result.json that is valid JSON behind one stray leading character is silently downgraded to failed/inconclusive — a real fail:0.98 + shipping-reviewer needs_fix were erased by a leading '+'
created: 2026-07-17
---

> **Recovery disposition (operator, 2026-07-17):** KEEP ACTIVE — an orchestration-integrity defect, not
> optional hardening (malformed authoritative reviewer output can erase a blocking verdict). Do NOT start it now; ACs unchanged (not expanded) in this record pass.


**Observed live:** FG-578 build phase, run
`run-fg-578-forge-upgrade-must-not-clobber-the-operator-authored-raci-e51e00`, 2026-07-17. Two of six build
reds.

## The defect

An authoritative red's `result.json` that is **well-formed JSON except for a single stray leading character**
is silently downgraded to a non-blocking / failed state, and its real verdict + findings are lost unless a
human manually repairs the file.

Concretely: `task-red-build-b0c441` and `task-red-build-2509f6` each wrote a `result.json` beginning with the
two bytes `+{` (a leading `+` before the opening brace; the rest of the document is valid JSON). Verified with
`od -c`: corrupt files start `+ { \n`, clean reds start `{ \n`.

Result:
- `b0c441` — actually `verdict: fail, confidence 0.98`, three findings (the FORCE/docs drift set) — recorded
  as `status: failed, error: result.json malformed`.
- `2509f6` — actually the **shipping-reviewer**, `verdict: needs_fix, confidence 0.94`, one finding — recorded
  as `status: failed, error: result.json malformed`.
- On the build parent, red-wide and shipping-reviewer therefore surfaced as `inconclusive, confidence 0`.

So an **authoritative fail and a shipping-reviewer needs_fix were both erased by one leading byte.** I only
recovered them by stripping everything before the first `{` and re-parsing by hand.

## Why it matters

This is a wrong-ship vector **in the review pipeline itself**. In an autonomous run, an orchestrator that
trusted the recorded state would see two `inconclusive/0` authoritative reds and (per the "procedural noise →
advance with rationale" disposition) could advance over a real `fail:0.98` carrying three findings plus a
shipping-reviewer `needs_fix`. The gate that exists to block a bad diff is defeated by a one-character
serialization slip in the agent's output.

It is a DIFFERENT cause from the FG-418 class (an unsubstantiated `fail` downgraded to `inconclusive`): there
the verdict was genuinely empty; here the verdict is fully substantiated and well-formed and is lost purely to
a leading-character parse failure.

## Likely cause (hypothesis — confirm in code)

The agent emitted its result with a leading `+` — plausibly a diff-fence artifact, a stray patch marker, or a
tool wrapping the payload. The ingestion path (the reader that turns `result.json` into a verdict row —
`src/v2/runNext.ts` / the reds ingestion + `gradeFindings`) treats a `JSON.parse` throw as "malformed →
failed/inconclusive" rather than attempting a bounded recovery.

## Fix direction (for the implementer to evaluate, not prescriptive)

Two independent hardening options; do both if cheap:
1. **Ingestion tolerance.** Before `JSON.parse`, strip a bounded leading/trailing non-JSON envelope (whitespace,
   a single `+`/`-` diff marker, ```` ```json ```` fences) — the same normalization FG-491 applied to
   `files_modified` claims. A well-formed JSON body wrapped in one stray marker must not erase an authoritative
   verdict.
2. **A malformed AUTHORITATIVE red result must not silently become non-blocking.** Today `malformed → failed`
   on the red task maps up to `inconclusive/0` on the parent, which is *advanceable*. A malformed authoritative
   red should **block** (fail-closed) and be surfaced as "unreadable reviewer output — inspect", never as a
   pass-adjacent inconclusive. An unreadable verdict is not a clean one (the same principle the completion
   watchers use).

## Acceptance (EXECUTED)
- A red `result.json` that is valid JSON behind a single leading `+` (or a ```` ```json ```` fence) is ingested
  with its real verdict and findings intact. Observed RED against current code using the exact `+{...}` capture
  from this run as the fixture.
- A genuinely unparseable authoritative red result blocks the gate (fail-closed) rather than mapping to an
  advanceable inconclusive. Negative test.
- Tests exercise the real ingestion path (runNext dispatchReds), not a hand-called parser.

## Second occurrence — a DIFFERENT corruption mode (2026-07-17, FG-580 architect phase)

`task-red-architect-8e0a82` (FG-580 architecture pass) recorded `status: failed / result.json malformed`.
This time the file starts CLEAN (`{`, not `+{`) but is malformed INTERNALLY — `json.loads` fails at
"Expecting ',' delimiter" mid-document (char ~930, inside a finding string value; likely an unescaped quote or
control char in the agent's prose). The recovered verdict was `fail (0.84)` with a real MEDIUM
(vendor-authenticity: the offline guard doesn't prove vendored modules are authentic vs local shims).

**Implication for the fix:** the FG-586(1) leading-envelope-strip direction would NOT catch this — a stray
byte in the MIDDLE isn't a leading/trailing envelope. This reinforces the SECOND fix direction as the
load-bearing one: **a malformed AUTHORITATIVE red result must fail-closed (block + surface "unreadable
reviewer output — inspect"), never map to an advanceable inconclusive/failed.** Whatever the corruption mode
(leading char, internal bad byte, truncation), the guarantee must be "an unreadable authoritative verdict
blocks", not "we successfully parsed a recovery." Recovery-by-stripping is a nice-to-have; fail-closed is the
invariant. Two occurrences in one session (build reds + architect reds) — the agent JSON serialization is
unreliable enough that this is not rare.