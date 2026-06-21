# How-to: run a research-synthesis workflow

`research-synthesis` is a first-class workflow that investigates a question using two independent researchers — one finding supporting evidence, one finding counter-evidence — then synthesizes their outputs into per-claim verdicts. It replaces ad-hoc sequential research invocations with a structured, auditable pipeline.

## Quick start

```bash
forge new research-synthesis "cache-invalidation-safety" \
  --question "Does the cache invalidation path in this codebase avoid stale reads under concurrent writes?"
forge next run-cache-invalidation-safety-<suffix> --project ~/code/myproject
```

`--question` is the only required input. It can be a yes/no claim, a design question, or a comparative question — anything a researcher can break into independently verifiable lanes.

## Why two researchers?

A single researcher can satisfy a question with the first evidence they find. Two independent researchers, each tasked with opposite objectives, surface the strongest case on both sides before any synthesis happens. The skeptic cannot see the primary's findings before synthesis; structural DAG isolation enforces this — the two research fanout steps share only the `frame` step as their dependency.

```
frame
  ├── research-primary (lane-1, lane-2, …)   ←— depends_on: [frame] only
  └── research-skeptic (lane-1, lane-2, …)   ←— depends_on: [frame] only
       ↓
   synthesize
```

## What to expect at each phase

### `frame` — decompose the question

The `research-framer` agent reads `inputs.question` and produces 3–7 independently researchable lanes. Each lane has an `id`, a `claim`, and a `context` sentence.

Gate: **human**. Review the decomposition before committing to parallel research. Common reasons to reject:

- A lane is too vague to guide a search
- Lanes overlap significantly (the synthesizer will get confused pairing them)
- A critical angle is missing

```bash
forge show task-frame-<suffix>
forge gate task-frame-<suffix> advance
forge next run-cache-invalidation-safety-<suffix> --project ~/code/myproject
```

### `research-primary` and `research-skeptic` — parallel fanout

One child task spawns per lane, for each role. `research-primary` searches for evidence that **supports** each claim; `research-skeptic` searches for evidence that **challenges or refutes** it.

Gate: **auto** (both roles). Neither produces a pass/fail verdict — they produce prose findings. The synthesizer pairs them by lane index.

These run in parallel. If one child fails (container crash, agent error), that lane surfaces as `inconclusive` in synthesis rather than blocking the entire run.

### `synthesize` — per-claim verdicts

The synthesizer reads all primary and skeptic outputs, paired by lane, and emits a structured result:

```json
{
  "status": "complete",
  "overall_summary": "2-4 sentence roll-up across all claims",
  "claims": [
    {
      "id": "lane-1",
      "claim": "the original claim text",
      "verdict": "supported | refuted | inconclusive",
      "evidence": "citations from both research branches",
      "disagreements": "where the two branches conflicted; empty if they agreed",
      "confidence": "high | medium | low"
    }
  ]
}
```

`inconclusive` means neither branch produced clearly stronger evidence, or the branches directly contradicted each other without resolution. It is not a failure — it is an honest reporting of epistemic state.

Gate: **human**. Review the synthesis before the run closes. Common reasons to reject:

- A verdict is asserted without citing any concrete evidence
- A significant disagreement between branches was buried in `evidence` rather than surfaced in `disagreements`
- A lane that produced strong evidence on one side was marked `inconclusive` without explanation

```bash
forge show task-synthesize-<suffix>
forge gate task-synthesize-<suffix> advance
forge next run-cache-invalidation-safety-<suffix> --project ~/code/myproject
```

When you advance the synthesize gate, forge automatically renders a `report.md` and prints its path to the console (`Report written to <project>/research/<slug>.md`). The report contains the question, an overall summary, and per-claim verdict sections.

## Mixed-provider routing

Each research role can run on a different provider. This is the intended configuration for production use: two independent providers, no shared context, no shared provider-level bias.

Add to your `~/.forge/model-policy.yml` (or `<project>/.forge/model-policy.yml`):

```yaml
overrides:
  agents:
    # Each researcher runs on a different provider — structural independence
    # at the API level, not just the prompt level.
    research-primary: claude-subscription
    research-skeptic: codex-subscription
```

See `docs/how-to-model-policy.md` for full policy setup. Without a model-policy.yml, both roles fall through to the forge default (legacy resolution).

## Navigating the outputs

All outputs live under `~/.forge/runs/<run-id>/`:

| Task | File | What's in it |
|------|------|--------------|
| `task-frame-*` | `result.json` | `{question, lanes: [{id, claim, context}]}` |
| `task-research-primary-*` | `stdout.log` | prose findings per lane (supporting evidence) |
| `task-research-skeptic-*` | `stdout.log` | prose findings per lane (counter-evidence) |
| `task-synthesize-*` | `result.json` | `{overall_summary, claims: [{id, claim, verdict, evidence, disagreements, confidence}]}` — drives the auto-generated report |

The synthesizer's `result.json` is the structured source of truth. The auto-generated report at `<project>/research/<slug>-<run-id-suffix>.md` is the human-readable deliverable. Use `forge report <run-id>` to re-render it at any time.

The researcher logs are your audit trail for understanding how each verdict was reached.

## When something goes wrong

- **Frame rejected**: the lanes were too vague or overlapping. Reject with specific feedback; the framer re-runs with your rationale in context.
- **Research child fails**: that lane becomes `inconclusive` in synthesis. Check `~/.forge/runs/<run-id>/<task-id>/container.stderr.log`. If it was infra (OOM, creds), fix and rerun `forge next`.
- **Synthesis rejected**: the synthesizer re-runs with your rejection rationale, re-reading the same researcher outputs. Provide specific per-lane feedback (e.g. "lane-3 verdict cited no code-level evidence").

## Reading the report

When you advance the synthesize gate, forge writes a Markdown report automatically. No manual step required.

**Default location:** `<project>/research/<slug>-<run-id-suffix>.md`

The report contains the question, a 2–4 sentence overall summary across all claims, and one section per claim with its verdict, confidence level, evidence citations, and any disagreements between the two research branches.

**Re-render at any time:**

```bash
forge report <run-id>
```

Prints the report to stdout. Useful if you want to pipe it, diff it, or share it.

**Export to a specific path:**

```bash
forge report <run-id> --out ~/reports/my-research.md
```

**Override the default output location at run creation:**

```bash
forge new research-synthesis "my-question" \
  --question "..." \
  --out ~/reports/my-research.md
```

The `--out` path is stored in the run and used automatically when the report is generated on synthesize gate advance.
