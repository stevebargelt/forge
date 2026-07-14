# Forge Invariants

A compact set of rules for reasoning about forge's control plane. Humans, orchestrators, and agents should be able to re-derive most decisions from these rather than from folklore. This is a compression layer, not a tutorial — see `docs/concepts.md` for the full glossary and the `how-to-*.md` files for procedure.

If a discussion needs a rule not listed here, that's a signal the rule should either get added here or doesn't actually hold system-wide.

## Vocabulary

- **SOURCE** — the human-authored or version-controlled origin of a rule or config. Something a person edits directly.
- **DERIVED** — mechanically produced from a SOURCE by a compiler/loader, never hand-edited as the primary path (an escape hatch may exist, but it's explicitly unsupported).
- **EFFECTIVE** — the value actually in force for one concrete dispatch or host, after precedence and overrides are resolved.
- **RECORDED** — a fact persisted at the moment something happened. Read back as history, never recomputed — it describes what was true *then*, not what is true now.

## The invariants

1. **SQLite (`~/.forge/forge.db`) is the SOURCE of run/task lifecycle truth.** Task artifacts (`result.json`, stderr, worktree diffs) are evidence for a task row's state, not the state itself.
2. **A run's status is only `active | complete | abandoned` — there is no run-level `failed`.** Success/failure detail lives on individual task rows (`pending|running|awaiting_gate|awaiting_red|complete|failed|blocked_by_red|awaiting_recovery`). A run can legitimately complete while containing failed tasks.
3. **Project config fully replaces host config, file by file — it never merges.** If `<project>/.forge/` has its own `workflows/<name>.yml`, `model-policy.yml`, `routing-policy.yml`, or `docs-surfaces.yml`, that file is the EFFECTIVE one in its entirety; if it's absent, the host/built-in default applies whole.
4. **Host-installed config under `~/.forge/` is the EFFECTIVE runtime configuration.** Repo `seeds/` are SOURCE templates, copied in by `install-seeds.sh` / `forge upgrade` — editing a seed changes nothing until it's reinstalled.
5. **The RACI is SOURCE; `routing-policy.yml` is DERIVED; a resolved route is EFFECTIVE.** The human-authored `forge-raci.md` compiles to the typed policy — never the reverse — and `forge route explain` resolves the policy plus precedence into the one route a specific dispatch actually takes.
6. **Every task dispatch writes a RECORDED control-plane receipt** (workflow/runtime/model-policy/routing source + path, project mount mode, constraint counts, …). It is fixed at dispatch time and never recomputed — an Explain view reads history, not current config.
7. **Model policy decides who runs a task; workflow YAML decides what work happens.** Provider, auth, and concrete model resolve from model policy by capability; steps, gates, reds, and fanout shape come from the workflow definition. The two resolve independently.
8. **Runtime YAML describes how a provider/model is actually executed** — image, mounts, invocation args, auth strategy — one layer beneath model policy, which only chooses which runtime applies.
9. **Red agents are always mounted read-only on the project at the OS/container level.** This is Docker mount enforcement (`:ro`), never a prompt instruction, and it is never relaxed for any red.
10. **All state mutation goes through the forge control plane.** The dashboard reads `~/.forge/forge.db` directly but mutates nothing itself — any dashboard action that changes state shells out to the `forge` CLI, keeping one enforcement path for auth and validation.
11. **Agents are fallible workers, not the trust boundary.** Gates, red review, host verification/tests, and CI are the trust boundary — a task or agent claiming success is not itself sufficient evidence that it's true.
12. **Durable docs are maintained deliberately, not as a side effect.** A dedicated pass (the documentation-maintainer, or an explicit docs-impact resolution) reconciles docs against ground truth; nobody edits `docs/**` or `README*` casually mid-conversation.
13. **The publish target never holds UNVALIDATED work — it fast-forwards to a fully-validated commit, or it does not move.** Validation (tests, integration gate, reds, review) runs against a candidate commit built in a throwaway integration worktree, never against the target; the exact validated SHA is then published through a short compare-and-swap window. A failed gate, a refused CAS, or a dirty target leaves the target unchanged — so there is never a bad merge on the target to undo. **But a validated candidate that has already WON the CAS is durably published.** A crash after the ref advance leaves a publication that recovery **completes** (finishing the outstanding working-tree checkout) rather than undoes — recovery decides from `{baseSha, candidateSha, currentTargetSha}` and the RECORDED target ref, never from working-tree contents (AD-5). So "crash mid-publish" does not mean "nothing was published": it means *ask recovery*, and never hand-roll a rollback. (FG-425; `learnings/decisions/serialized-integration-publisher.md`.)
14. **A publisher that has lost the publication window mutates NOTHING, and no terminal claim may stand over an unsettled publication.** Once a publisher discovers it no longer owns the short mutex, it executes no target-mutating command — not `update-ref`, `read-tree`, `checkout`, `reset`, or cleanup, and not even a rollback of its own ref advance (the window's new owner may already have synchronized the tree onto the candidate, so a compare-and-swap "undo" would still corrupt the target). It preserves the durable publishing intent instead, and only AD-5 convergence — never a lane sweep — may settle an attempt recorded `publishing`. A task whose publication is unsettled parks in the non-terminal `awaiting_recovery`; a terminal refusal claiming "nothing was published" may never stand over an attempt whose ref advance landed, because it invites a retry of work that is already on the target. (FG-425 AC5; FORGE-DEC-027, `learnings/decisions/2026-07-13_awaiting-recovery-task-status.md`.)
15. **Accountability for what ships is always human.** Automation can gate, verify, and recommend, but responsibility for what merges or ships is never delegated to an agent or a passing check alone.

## Non-goals

This document does not replace `docs/concepts.md`, ADRs under `learnings/decisions/`, or the how-tos. It states the small set of rules that make the rest of those legible — not every mechanism, edge case, or recovery path.
