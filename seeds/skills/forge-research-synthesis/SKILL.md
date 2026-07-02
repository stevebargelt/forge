---
name: forge-research-synthesis
description: Run the dual-researcher + synthesis workflow (`forge new research-synthesis`) for questions worth independently arguing both ways before trusting the answer. Use instead of a single `forge invoke research-specialist` when the question is contested, high-stakes, or you want structural (not just prompted) adversarial verification.
---

# forge-research-synthesis

`research-synthesis` is a v2 workflow (`seeds/workflows/research-synthesis.yml`) that decomposes a question into claim lanes, investigates each lane with two independent researchers arguing opposite sides, then synthesizes a per-claim verdict. Full walkthrough and output layout: `docs/how-to-research-synthesis.md`. This skill only summarizes when to reach for it.

## Non-goal

Host/orchestrator skill only. It documents a CLI-driven workflow run from the terminal. Containerized agents do not discover or read `.claude/skills`.

## Shape

```
frame  (research-framer, gate: human — decomposes the question into 3-7 lanes)
  ├── research-primary  (fanout per lane, gate: auto — argues FOR each claim)
  └── research-skeptic  (fanout per lane, gate: auto — argues AGAINST each claim)
       ↓
synthesize  (synthesizer, gate: human — per-lane verdict: supported | refuted | inconclusive)
```

`research-primary` and `research-skeptic` both `depends_on: [frame]` only — neither sees the other's findings before synthesis. That structural isolation (not just prompting) is the point of this workflow over a single research pass.

## Running it

```bash
forge new research-synthesis "<slug>" --question "<a specific, decomposable question>"
forge next run-<slug>-<suffix> --project <dir>
```

Advance the `frame` and `synthesize` human gates with `forge gate <task-id> advance` (or `reject`/`request-changes`) as usual. Advancing the `synthesize` gate auto-renders a Markdown report; re-render or export it any time with `forge report <run-id> [--out <path>]`.

## When to use this vs a single `forge invoke research-specialist`

- **Single invoke** (`forge invoke research-specialist --task "..."`): fine for a narrow factual lookup where one researcher's findings are trustworthy on their own, or where speed matters more than adversarial rigor.
- **research-synthesis**: reach for this when the question is a claim someone could reasonably argue either way on, when a wrong answer is costly, or when you want per-claim confidence and an explicit `disagreements` trail rather than one researcher's unchallenged conclusion. It costs more (a framer, N×2 researchers, a synthesizer) — spend that budget on questions where being wrong is expensive.

For genuine provider-level independence (not just role-level), pin `research-primary` and `research-skeptic` to different providers in `overrides.agents` in `model-policy.yml` — see `docs/how-to-research-synthesis.md` ("Mixed-provider routing") and `docs/how-to-model-policy.md`.

## Roles, not policy

The researcher and synthesizer behavior itself lives in `seeds/agents/research-specialist/`, `seeds/agents/research-primary/`, `seeds/agents/research-skeptic/`, `seeds/agents/research-framer/`, and `seeds/agents/synthesizer/` — this skill points to the workflow shape and when to invoke it, not to the agents' internal instructions.

## Research discipline

- **Primary over secondary.** Favor primary sources (code, docs, observed behavior) over secondary summaries when a primary source is practically reachable — this is the researcher's own standing discipline, not new policy; see `seeds/agents/research-specialist/CLAUDE.md`.
- **Fact vs. inference.** State plainly which findings are directly observed versus inferred — don't let an inference read with the same confidence as an observation. The per-claim `verdict`/`conclusion` fields already carry this distinction (`supported`/`refuted`/`inconclusive`); carry it into whatever you tell the user too.
- **End with a decision.** Don't let a research pass land as an open-ended summary. Close it out with either concrete recommended backlog items (`forge backlog file "<title>" --body <text>`) or an explicit "no action" conclusion.

This section is about how you use the output, not a separate research rubric — the researcher/synthesizer discipline itself is owned by the seeds above (`research-specialist`, and sibling `research-primary`/`research-skeptic`/`research-framer`/`synthesizer`).
