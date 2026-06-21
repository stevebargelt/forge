---
id: FG-306
type: story
status: done
title: "doctor/upgrade follow-ups: quick-start docs + RUNTIME_BINDING CLI-expectation row (#229)"
closed: 2026-06-21
---

**Type:** Follow-ups from #229's review-loop (adjacent polish, not release blockers). Low priority.

1. ~~docs/quick-start.md still presents plain `forge upgrade` as the complete one-step refresh.~~ **DONE in #252** — quick-start now surfaces the automatic release check, `--rebuild-image`, and `forge setup`/`forge doctor` as the new-host path.

2. **README.md (~line 80)** — the `forge upgrade` one-liner omits the automatic read-only release check and `--rebuild-image`. Low priority: the line already points to docs/how-to-upgrade.md where both are documented.

3. **RUNTIME_BINDING-reachable runtimes with a missing/malformed seed YAML.** `forge doctor`'s in-image CLI expectations are derived from installed runtime YAMLs (workspace + project) plus explicit `profile.runtime`, NOT from the (provider, auth) -> runtime binding table. So a policy that resolves to e.g. `codex-subscription` via the table while its seed YAML is absent/malformed would emit no `cli codex` row — the gap goes undiagnosed. Only matters for a broken install (the codex-subscription seed exists in normal setups, so it's covered today). Consider deriving an explicit CLI-expectation/diagnostic row for binding-table-reachable runtimes too. Low priority.