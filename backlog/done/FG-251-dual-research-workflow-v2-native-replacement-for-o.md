---
id: FG-251
type: story
status: done
title: "Dual-research workflow: v2-native replacement for old investigation"
closed: 2026-06-21
---

**Captured from user direction 2026-06-02.** We want the dual-research / synthesis shape as a v2-native replacement for the removed `investigation` pipeline. This is about the workflow semantics; the broader config/setup ergonomics are split to #252.

**Research workflow shape to preserve:** create a v2-native replacement for the old `investigation` pipeline, likely named `research-synthesis` rather than resurrecting `investigation`. Flow:
- Frame the user question into concrete research lanes / claims.
- Fan out independent dual researchers per lane: primary evidence and counter-evidence / skeptic.
- Keep those researchers independent; neither should read the other's output before synthesis.
- Synthesize both sides into `supported | refuted | inconclusive` judgments with cited evidence and disagreement notes.
- Avoid normal red `pass/fail` semantics on investigator outputs. #73 was right: research needs opposing evidence and synthesis, not red-verdict review vocabulary.

**Provider/model routing requirement:** support intentional mixed-provider research, e.g. `research-primary` on Claude model/profile X and `research-skeptic` on Codex/OpenAI model/profile Y. Current shipped model policy can do this through agent-role profile overrides, but that implies creating/distinguishing roles and writing policy YAML. Long-term ergonomic option: step-level profile overrides such as `overrides.steps[research-synthesis.research-primary]`, so two steps can share the same seed while using different providers.

**Open design point:** decide whether this is a first-class pipeline (`forge new research-synthesis ...`) or an orchestrator-driven invoke template that still records a coherent run. The workflow wants auditability, fanout, and dashboard state, so a YAML workflow is likely justified despite v2's current "pipelines are implementation" bias.

**Relations:** #73 (research category mistake), #225 (bounded provider/profile choice), #252 (collaborative setup should generate any needed policy/config), #42 (new workflow docs need a non-existing workflow example), stale `docs/how-to-new-analysis.md` still describes removed `investigation` pipeline.