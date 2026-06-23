# forge — learnings

Architectural decisions and reusable patterns for forge. Captured at the moment of decision; consulted before re-litigating anything.

This is the **forge repo's** corpus, not the vault. The vault corpus at `obsidian/stevieb-sgws/learnings/` is prior research that informed forge's design — read it, don't write to it. New decisions made during forge build belong here.

## Structure

```
learnings/
├── README.md                   — this file
├── decisions/
│   ├── _DECISION_TEMPLATE.md
│   └── YYYY-MM-DD_<short-name>.md
└── patterns/
    ├── _PATTERN_TEMPLATE.md
    └── YYYY-MM-DD_<short-name>.md
```

## Decisions index

| ID | Date | Decision |
|---|---|---|
| FORGE-DEC-001 | 2026-05-06 | [better-sqlite3 over node:sqlite](decisions/2026-05-06_better-sqlite3-over-node-sqlite.md) |
| FORGE-DEC-002 | 2026-05-06 | [Commander as the CLI framework](decisions/2026-05-06_commander-as-cli-framework.md) |
| FORGE-DEC-003 | 2026-05-06 | [Module boundaries: cli / spine / store / types / util / workflows](decisions/2026-05-06_module-boundaries.md) |
| FORGE-DEC-004 | 2026-05-06 | [Workflow definitions are TypeScript files](decisions/2026-05-06_workflow-as-typescript.md) |
| FORGE-DEC-005 | 2026-05-06 | [tsx + bin/forge shim instead of compiled dist](decisions/2026-05-06_tsx-runtime-no-build-step.md) |
| FORGE-DEC-006 | 2026-05-06 | [Inject corporate root CA into the agent image at build time](decisions/2026-05-06_corporate-tls-cert-injection.md) |
| FORGE-DEC-007 | 2026-05-06 | [Three auth modes; OAuth via a docker volume, not a host file mount](decisions/2026-05-06_three-auth-modes-volume-oauth.md) |
| FORGE-DEC-008 | 2026-05-06 | [Bedrock Claude 4.x requires cross-region inference profile IDs](decisions/2026-05-06_bedrock-claude-4-needs-inference-profile.md) |
| FORGE-DEC-009 | 2026-05-06 | [Reconcile orphaned tasks at top of `forge next` and `status`](decisions/2026-05-06_reconcile-orphaned-tasks.md) |
| FORGE-DEC-010 | 2026-05-06 | [Use Node's built-in `node:test` runner with `tsx`](decisions/2026-05-06_node-test-as-test-runner.md) |
| FORGE-DEC-011 | 2026-05-06 | [Docker mount of project dir can corrupt native node binaries (gotcha + recovery)](decisions/2026-05-06_docker-mount-corrupts-native-binary.md) |
| FORGE-DEC-012 | 2026-05-06 | [Optional read-only flag on the DB singleton + 5s busy_timeout](decisions/2026-05-06_read-only-db-connection-flag.md) |
| FORGE-DEC-013 | 2026-05-06 | [Mount ~/.aws into bedrock containers + detached SSO watchdog](decisions/2026-05-06_profile-mount-and-detached-watchdog.md) |
| FORGE-DEC-014 | 2026-05-07 | [Host-led human-driven design phase, with forge as the prompt-author](decisions/2026-05-07_host-led-pencil-design.md) |
| FORGE-DEC-015 | 2026-05-07 | [Interactive dashboard: shell out to bin/forge, gate behind env flag, CSRF header](decisions/2026-05-07_interactive-dashboard.md) |
| FORGE-DEC-016 | 2026-05-08 | [~~Manual phases and the awaiting_human_input task status~~](decisions/2026-05-08_manual-phase-and-awaiting-human-input.md) *(superseded by FORGE-DEC-020)* |
| FORGE-DEC-017 | 2026-05-08 | [`awaiting_red` task status](decisions/2026-05-08_awaiting-red-status.md) |
| FORGE-DEC-020 | 2026-06-20 | [Remove `awaiting_human_input` task status](decisions/2026-06-20_remove-awaiting-human-input-status.md) *(supersedes FORGE-DEC-016)* |
| FORGE-DEC-021 | 2026-06-20 | [Remove TaskContract feature (AWN-4 phase 1, closes FG-223 unbuilt)](decisions/2026-06-20_remove-taskcontract-feature.md) |
| FORGE-DEC-022 | 2026-06-23 | [Resolve project mount root on invoke/new; hard-fail on suspicious subdir mounts (FG-374)](decisions/2026-06-23_project-mount-root-resolution.md) |

## Patterns index

(none yet — will be filed after first real runs reveal patterns worth elevating)

## When to file

- **During build:** when you make a non-obvious architectural choice, write the ADR right then. Two minutes now is worth an hour of re-derivation later.
- **After a run:** when a run reveals a reusable pattern (a prompt structure that worked, an agent handoff contract, a failure mode reds consistently catch), file a pattern.
- **On revisit:** if you override a past decision, mark the old one `Superseded`, link the new one, note why conditions changed.
