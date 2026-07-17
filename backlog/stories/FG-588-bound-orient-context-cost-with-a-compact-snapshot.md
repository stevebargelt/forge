---
id: FG-588
type: story
status: active
title: Bound /orient context cost with a compact snapshot and conditional drill-down
created: 2026-07-17
---

## Problem

`/orient` is intended to produce a compact start-of-session state-of-play, but its seven unconditional reads have grown with Forge's underlying surfaces. On 2026-07-17 in the Forge project, before any synthesis, the command produced approximately:

| Read | Output |
|---|---:|
| `forge backlog notes show` | 8.5 KB / 37 lines |
| `forge backlog list --status active` | 12.3 KB / 87 lines |
| recent done tickets (`head -30`) | approximately 3–4 KB |
| `forge projects show forge` | 1.3 KB / 22 lines |
| `forge ops check --json` | 13.0 KB / 224 lines |
| Git status/ahead reads | negligible |

The orientation therefore injects roughly 39 KB (about 10,000 model-input tokens) before reasoning, although its report uses only a small fraction: selected handoff fields, active count and referenced-ticket status, project liveness, and an ops count plus a few incident identities.

This is not merely cosmetic:

- `ops check --json` emits full evidence and recommended-action prose for every incident, while orient needs count/severity/kind/run/task only. FG-549 will clear today's twelve stale incidents, but the output remains unbounded as the real incident set grows.
- The full active list is loaded to report a count/top-three and validate a few note references.
- `done | head -30` is both wasteful and incorrect for reconciliation: a referenced closed ticket outside the newest thirty is indistinguishable from an absent ticket.
- `projects show` returns ten recent runs although orient needs live sessions, in-flight count, and last activity.
- The handoff notes are consumed whole even though orient principally uses `Where we left off` and `Picked up next`; verbose handoffs can dominate the context and stale non-ticket assertions are not reconciled.

Repeated shell-side `jq`/`awk` projections inside the Markdown command would reduce bytes on this machine but create a fragile, duplicated parsing contract and external-tool dependency. Forge should own the bounded data shape.

## Goal

Make orientation a two-stage operation:

1. One compact, read-only Forge snapshot supplies the bounded state needed for ordinary orientation.
2. The orchestrator performs targeted drill-down (`forge backlog show`, `forge show`, or full `forge ops check --json`) only for identities the snapshot marks as requiring attention.

Retain every current orientation signal; remove unconditional bulk payload, not capability.

## Design direction

Add a stable machine-readable surface, provisionally:

```text
forge orient snapshot --json
```

An equivalent command name is acceptable, but it must be a Forge-owned schema rather than Markdown-embedded JSON parsing. The snapshot should include:

- project identity/path, last activity, live-session count, and in-flight count;
- bounded handoff fields needed by orient (`Where we left off`, `Picked up next`, and any explicitly supported attention flags);
- active-ticket count and a compact identity set sufficient to reconcile ticket references;
- exact status/title for tickets referenced by `Picked up next`, regardless of how old a closed ticket is;
- ops incident count, counts by severity, and a bounded highest-severity identity projection (`severity`, `kind`, `runId`, `taskId`), excluding full evidence/action prose;
- explicit truncation metadata wherever a bounded field cannot be represented completely. Never silently truncate.

Keep Git status/ahead checks separate unless the implementation can include them without weakening evidence or introducing shell-dependent behavior.

Update `scripts/claude-commands/orient.md` to use the snapshot, then conditionally fetch details only when the snapshot identifies a stale reference, in-flight run, or actionable incident.

Also establish a bounded handoff-notes contract. Detailed histories and evidence belong in tickets, plans, and commits; handoff carries only the forward pointer. Coordinate with FG-380's future host-local storage and FG-550's optional memory-invalidation section rather than losing either field.

## Acceptance criteria

- `/orient` preserves its existing semantic report: project, picking up, Git state, active-ticket summary, stale-reference detection, run/liveness attention, ops attention, and the closing operator question.
- Ordinary orientation uses one compact Forge snapshot plus the bounded Git reads; it does not unconditionally load full notes, all ticket titles, thirty arbitrary done tickets, ten recent runs, or complete incident evidence.
- Snapshot generation is read-only and side-effect-free. In particular, it does not send ops notifications, write milestone events, mutate notes, reconcile tasks, or change project files.
- A `Picked up next` reference is resolved by exact ticket identity/status. A closed ticket older than the newest thirty is still reported as closed; an actually missing ticket is reported as missing.
- Ops summary includes total and severity counts plus only a bounded set of highest-severity identities. Full `evidence` and `recommendedAction` appear only after targeted drill-down.
- Snapshot output remains at or below 5 KB in a fixture with at least 100 active tickets, 450 done tickets, 20 ops incidents, and normal bounded handoff notes. If a field exceeds its contract, the result carries explicit `truncated`/count metadata rather than silently dropping information.
- The handoff/orient contract places a concrete size or structural bound on forward notes. An overlong notes block is either rejected with guidance or represented by an explicit bounded/truncated state; it is never injected wholesale without notice.
- The implementation does not depend on `jq`, Python, GNU-only utilities, or caller-PATH Node to shape the snapshot.
- The snapshot schema has focused unit/integration tests for empty state, normal state, over-limit state, stale/closed/missing ticket references, mixed-severity incidents, and read-only behavior.
- A regression test measures the rendered `/orient` input fixture and fails if bulk fields such as incident evidence or every ticket title re-enter the ordinary snapshot.
- Existing full-detail commands remain available and unchanged for conditional investigation.
- Canonical command propagation is verified through the existing Forge-managed `.claude/commands/orient.md` symlink/install path; do not create per-project copied variants.
- Before/after evidence records output bytes and Forge-process count for the Forge-project fixture. Target: approximately 39 KB / five Forge subprocesses today to no more than 5 KB / one Forge subprocess for Forge-owned orientation state.

## Non-goals

- Removing ops, backlog, handoff, project-liveness, or Git signals from orientation.
- Fixing the incident-lifecycle defect owned by FG-549.
- Moving operational notes to host-local storage; FG-380 owns that storage boundary.
- Implementing FG-550's memory-invalidation semantics, though the compact schema must be able to carry its optional flag when it lands.
- Making `/orient` choose the next ticket or begin work automatically.
- Returning full ticket bodies, run histories, incident evidence, or remediation instructions in the ordinary snapshot.

## Relations

- **FG-549:** clears permanently recurring `orphaned_work_may_persist` incidents; complementary, not a substitute for bounded ops output.
- **FG-380:** moves operational handoff/orientation state out of tracked project files. The snapshot should consume that future storage without changing its public shape.
- **FG-550:** adds optional session-known memory invalidations to handoff; preserve the signal compactly without running a memory audit.
- **FG-253:** provider adapter surfaces; the canonical orient contract should remain Forge-owned even if provider-specific command files later become generated adapters.
