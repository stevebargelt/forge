# Forge documentation

Use this page to find the current operator documentation. Historical plans,
product specifications, research, and decision records are retained for context,
but they do not override current behavior or backlog state.

## Start here

- [Quick start](quick-start.md) — configure a project and run Forge.
- [Concepts](concepts.md) — lifecycle, task, campaign, publication, and recovery
  behavior.
- [Invariants](invariants.md) — correctness and authority boundaries.
- [Schema contract](SCHEMA-CONTRACT.md) — database ownership and compatibility.
- [Testing](how-to-testing.md) — test tiers and required verification.
- [Autonomous-run prompt](autonomous-run-prompt.md) — current long-running
  operator policy.
- [Secret hygiene and redaction](redaction.md) — credential and artifact
  handling.

## Operate Forge

- [Use Forge across projects](how-to-use-forge-across-projects.md)
- [Upgrade Forge](how-to-upgrade.md)
- [Move a project backlog to the database](how-to-backlog-db-cutover.md)
- [Select models and providers](how-to-model-policy.md)
- [Set up notifications](how-to-set-up-notifications.md)
- [Run ntfy](how-to-ntfy.md)
- [SMS terms](sms-terms.md) — consent and privacy terms for the optional SMS
  integration.
- [Use project-provided test authentication](how-to-project-auth.md)
- [Configure iTerm project tinting](how-to-iterm-tint.md)
- [Configure a work laptop](work-laptop-setup.md)

## Extend Forge

- [Add an agent](how-to-new-agent.md)
- [Add a workflow](how-to-new-workflow.md)
- [Add a feature](how-to-new-feature.md)
- [Use Pi skills outside Forge projects](how-to-pi-skills-in-non-forge-project.md)
- [Synthesize research](how-to-research-synthesis.md)

## Design and historical context

- [PRDs](prds/README.md) — accepted product and architecture specifications,
  including shipped historical records.
- [Plans](plans/README.md) — point-in-time implementation plans and closeout
  evidence.
- [Research](research/README.md) — competitive and technical assessments.
- [Decision records](../learnings/README.md) — ADRs and retained design
  provenance.
- [Campaign Runner shipping plan](campaign-runner-plan.md) — shipped historical
  delivery record.
- [Operator-surface addons](operator-surface-addons.md) — non-authoritative
  concept note.
- [FG-495 test timing](test-suite-timing-fg495.md) — retained measurement behind
  the current test tiers.

## Sources of truth

- Current ticket state: the backlog database through `forge backlog`
- Current run and review state: `forge show` and `forge review show`
- Current implementation behavior: source, tests, and the operator guides above
- Historical sequencing snapshot: [`backlog/PLAN.md`](../backlog/PLAN.md);
  it was last revised on 2026-07-30 and is not a live queue

`backlog/notes.md` is a session handoff, not durable product documentation.
