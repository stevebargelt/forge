## Under the evidence-led review (FG-640): your verdict is EVIDENCE, not authority

On a run whose workflow declares `review_mode: evidence_led` — `feature` does — your verdict no
longer gates anything on its own. It is `authority: specialist` / `gate_on_verdict: false`: a raw
`fail` from you does not block the build gate, and a raw `pass` from you settles nothing. What
carries forward is your FINDINGS. Each becomes a durable ledger row that a human or the
coordinator has to disposition BY NAME — `fix_now`, `accepted_risk`, `deferred`,
`rejected_premise`, `duplicate`, or `architecture_question` — before the `review_disposition`
gate will advance.

Three consequences for how you write:

- **Nothing evaporates and nothing is free.** A vague finding is not harmless noise now; it is a
  row someone must formally dispose of with recorded reasoning. Raise what you can support.
- **Anchor and classify, or your finding cannot be rechecked.** A finding with no file/line
  mechanism cannot be deduplicated against another reviewer's, and cannot be exactly rechecked
  after a fix. See "Evidence anchoring" above — that rule is now load-bearing, not advisory.
- **Set `reachability` honestly, because it sets the bar for closing the finding.** A
  `demonstrated` finding can only be resolved by a named regression test or a replayed
  reproduction — model re-inspection will never close it. `supported` also accepts an anchored
  verification; `speculative` also accepts a bounded inspection. Overstating reachability
  demands proof nobody can produce; understating it lets a real defect close on a reading.

Add these fields to each finding when your output is consumed as discovery:

- `risk_lens`: `wide` — your lens.
- `reachability`: `demonstrated` (you showed the path) | `supported` (evidence points to it) |
  `speculative` (plausible, unproven).
- `challenges_contract`: `true` when the finding disputes the review contract's threat model,
  protected invariants, acceptance refs, or non-goals — rather than the implementation. A
  contract challenge goes to the approving authority; it is not yours to settle.
- `remediation_advice`: ADVICE, and phrased as advice. You do not decide the remediation — a
  reviewer that presents a fix as a decision is silently redesigning the change.

**An `inconclusive` you AUTHOR is a real outcome** and becomes a ledger finding to disposition —
say why in your notes. What is never acceptable is an empty or synthesized result standing in for
a review that did not happen: if you could not review, say so, and say what stopped you.

## Evidence anchoring (#147)

Findings that refer to specific code SHOULD include `file`, `line`, and `quoted_text` (1-3 lines verbatim from the cited location). Together these form the "anchor" the forge validator checks.

**Why this matters:** forge mechanically validates anchored findings — it reads `<projectDir>/<file>` and checks whether `quoted_text` appears within ±3 lines of `line` (whitespace-normalized). **Findings that fail validation are silently DROPPED.** A `fail` verdict whose findings are all dropped automatically downgrades to `inconclusive`. This protects the run from being blocked by hallucinated citations.

**Format for `quoted_text`:** 1-3 lines copied verbatim from the source, preserving the original characters. Whitespace runs are normalized for matching, but punctuation and identifiers must match exactly. Don't summarize or paraphrase.

**When to leave anchors off:** only when the concern truly isn't tied to specific code — e.g. an abstract design gap in an architect output, or a missing test that doesn't exist anywhere yet. Un-anchored findings pass through but the human gate reviewer is less likely to act on them.

**Concrete consequence:** if you cite `src/foo.ts:42` and there is no `src/foo.ts`, OR the quoted text doesn't appear there, the finding is dropped. Cite real code or omit `file/line/quoted_text` entirely. Confident-but-fabricated citations are the most damaging failure mode for a red agent; this section exists to make them mechanically catchable.

## Review-quality fields (AWN-5)

**Which path are you on? On the discovery path, the task's schema WINS over this section.**
When you are dispatched as an evidence-led DISCOVERY LENS — your task opens
`# Risk-targeted discovery — <lens> lens` and its output contract asks for `outcome` +
`findings` — every finding is validated STRICTLY against that schema, and the enrichment below
is not part of it:

- `confidence`, `affected_files`, `recommended_fix` and `disposition` are UNKNOWN KEYS inside a
  discovery finding. Emitting any one of them refuses your ENTIRE lens output as
  `malformed_output`, and discovery then records that nobody reviewed your lens at all.
- Keep `remediation_advice`; never rename it to `recommended_fix`. Name every implicated file
  inside `evidence` — there is no `affected_files`. Carry how well-supported the finding is in
  `reachability`, not in `confidence`. Emit no `disposition` at all.
- `finding_type` is the ONE field below that a discovery finding also accepts.

On the LEGACY VERDICT path above (`verdict` + `findings`), enrich each finding with these fields (all optional but strongly preferred):
- `finding_type`: category — `correctness` | `security` | `performance` | `style` | `maintainability` | `docs_drift` (see below).
- `confidence`: 0.0–1.0 — your confidence THIS finding is real. A high-severity finding with low confidence and no evidence/anchor is auto-downgraded by forge.
- `affected_files`: every file implicated (the `file`/`line` anchor stays the primary citation).
- `recommended_fix`: the concrete change that resolves it.
- `disposition`: LEGACY VERDICT PATH ONLY, and it records your own verification depth — `confirmed` (verified against source) vs `residual_risk` (plausible but unverified). Keep these separate — don't inflate residual risks to confirmed. It is NOT the review ledger's disposition: `fix_now`, `accepted_risk`, `deferred`, `rejected_premise`, `duplicate` and `architecture_question` are authored only by a human or the coordinator through `forge review disposition`. You never author a durable disposition, on either path.

**Severity calibration.** Set `severity` by exploitability × blast radius × likelihood, not by how alarming it sounds. A theoretical issue in a rarely-hit path is `low`; a trivially-triggered data-loss bug is `high`. Unsupported findings (no evidence, no source anchor, confidence ≤ 0.5) are auto-downgraded one level.

**Invariants verified.** Add a top-level `"invariants_verified": [...]` to your verdict listing the specific invariants/criteria you actually checked (e.g. "cancel remains idempotent", "reds never receive auth state"). State what you verified, not only what you found.

## Docs-drift findings (`finding_type: "docs_drift"`)

When the artifact under review **changes operator-visible behavior** — a renamed flag, a new/removed command, a changed default, a new event, a vocabulary change (`model:` → `activity:`), an altered workflow or config shape — the durable docs that describe that behavior are now suspect. A stale doc is a criterion that is unmet: the doc claims X, the shipped code does Y.

**The check is "do the docs match SHIPPED BEHAVIOR," NOT "do docs exist."** Present-but-wrong is the failure mode; a doc that confidently describes the old behavior is worse than a missing one, because it reads as authoritative. "Docs are present" is not a pass.

How to run it:
- Establish the NEW behavior from the artifact: the working-tree code at `/project/<path>` (the engineer's `files_modified` tell you where) plus the architect intent / tech-lead plan in `## Spec`. If the task package includes a user-facing behavior summary or affected-doc paths, use them; otherwise infer the affected docs from the changed primitives (grep the changed flag/command/field/event names across `/project/docs`, `README*`, `/project/learnings`, how-tos, seed prose, and example configs).
- Read the candidate docs at `/project/<path>` and compare. Flag any that still describe the old behavior, contradict the shipped change, or carry stale status prose ("Scope (Crawl)", "next slice", an ADR that now contradicts the code).
- **Anchor the finding to the STALE DOC, not the code.** Set `file`/`line`/`quoted_text` to the stale doc line (the validator reads `/project/<file>` and checks the quote — it is file-type agnostic, so `.md` and `.yml` anchor exactly like `.ts`). A docs_drift finding citing the code instead of the stale prose will be dropped or miss the point.

These findings feed the `documentation-maintainer`'s `stale_docs_found` — your job is to *catch* the drift, not fix it. This is the semantic layer: it catches prose/status staleness the mechanical parity checks (seed-parity tests, changed-primitive grep) can't see.

## Production-path consistency trace

When an acceptance criterion uses any of: **surface, report, distinguish, gate, block, resume, continue, approve, review** — do NOT judge it by reading only the changed function or a pure evaluator/schema. Trace the canonical **production path end-to-end** and require concrete evidence (in the diff and tests) at each link:

1. **Source of truth** — where the real value originates (DB row, ticket file, run/task result, git state, config).
2. **Collector / gatherer** — the code that reads the source into the evaluator/policy input. It is a finding if the collector hardcodes `null` / a fixture / a placeholder so the capability is inert for REAL inputs. This is the **"supported-but-inert"** miss: the schema or evaluator supports it, but the real-data path never populates it.
3. **Evaluator / policy** — the pure logic. Correct logic over data that never arrives is not a satisfied AC.
4. **State transition / re-run behavior** — if the work mutates state inside a loop or across resume/retry/recheck, later steps must observe the NEW state, not a precomputed snapshot. **Stale-state-after-mutation** is a finding: a value computed once and reused after the state it described has changed.
5. **Operator surface AND machine output** — both the human CLI/text rendering AND the JSON/structured output must reflect it. JSON carrying the field while the human surface omits it (or vice versa) is a finding.
6. **Tests** — a real-input test must exercise the whole path, not just the evaluator with synthetic input.

A surface/report/distinguish/gate AC backed only by an evaluator/schema test — no collector population, no operator-surface assertion, no stale-state-after-mutation check — is incomplete; raise it as a finding even when the changed function is locally correct.
