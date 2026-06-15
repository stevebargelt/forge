---
id: FG-252
type: story
status: done
title: Collaborative project config setup — stop making humans hand-write Forge YAML
---

**Closed:** 2026-06-07.

**Shipped (HOST-level new-machine readiness; commits 412d716, d6f47fa, 5e924c0):** `forge setup` — guided-creates the active `~/.forge/model-policy.yml` from the installed seed when absent (never overwrites; host-local, never committed), ensures `routing-policy.yml` is compiled from the RACI, runs the #229 read-only release check (image / runtime CLIs / per-profile auth / model+routing policy validity), and reports a statically-verified Codex review-loop readiness line — no live agent run, no DB mutation. `--dry-run` previews. Pure core fixture-tested; provisioning IO tested against a temp FORGE_HOME. Also fixed a #229 doctor bug surfaced live (image presence via `docker image ls` instead of the containerd-unreliable `inspect <name>`). New `docs/work-laptop-setup.md` checklist + quick-start pointers. Verified live: this host reports Ready.

**Closed acceptance-met by explicit human override.** All of #252's explicit acceptance criteria (active model-policy or guided creation, routing compiled, seeds installed, image diagnosed, creds diagnosed without spend, Codex review-loop path verified, no hand-written YAML, host-local config preserved, checklist doc) are met and tested; full suite green. The review-loop ended `reviewer_failed` (round-2 verification broke from the fixer's own change) after the fixer autonomously expanded into PROJECT-local config + docs-surfaces + `forge new` wiring — in-scope per the ticket context but landed via a structurally-failed loop, so that unreviewed WIP was discarded and re-filed clean as **#308**. (The `SessionEnd`-hook bug the fixer run surfaced is **#307**.)

**Split from #251 per user direction 2026-06-02.** The product smell is setup friction: Forge is accumulating "write this YAML by hand" steps (`docs-surfaces.yml`, `model-policy.yml`, future workflow/provider routing). That is the wrong primary UX. The user does not want to hand-author config files; setup should happen collaboratively during `forge init`, `forge upgrade`, or the first run that needs the config.

**Config UX requirement:** Forge should guide configuration through an orchestrator-mediated flow:
- On `forge init` or `forge upgrade`, detect missing/partial project config and ask concise setup questions.
- On first run of a workflow that requires config, pause and offer to generate the needed project-local files.
- Generated files should be explicit and reviewable (`<project>/.forge/docs-surfaces.yml`, `<project>/.forge/model-policy.yml`, future workflow/provider config), but the orchestrator/CLI should author them from choices.
- Preserve direct YAML editing as an expert escape hatch, not the primary setup path.

**Possible command shapes:** `forge init --configure`, `forge config doctor`, `forge config setup <capability>`, or first-run prompts from commands like `forge new research-synthesis ...` when required config is missing. The exact surface is open; the principle is collaborative setup, not "read docs and write YAML."

**New-machine requirement:** make it easy to set up a new machine with Forge. The setup path should verify/install seeds, runtimes, auth/provider availability, project hooks/slash commands, model policy, docs surfaces, and any workflow-specific config needed for the project. This overlaps #229 but is broader than image rebuild/provider auth checks.

**Why this matters:** Forge's promise is conversational orchestration across projects and machines. Every hand-written YAML prerequisite erodes the first-run/new-machine experience. Config should remain declarative on disk for auditability, but discovered and generated through Forge.

**Relations:** #246 (docs-surfaces project config introduced the pattern), #225 (bounded provider/profile choice), #229 (new-machine upgrade/init completeness), #251 (research-synthesis will need provider/profile setup), #42 (workflow docs should not normalize hand-authored YAML as the default user path).