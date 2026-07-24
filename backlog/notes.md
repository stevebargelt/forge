**Last session ended 2026-07-24.**

**Where we left off:** Took up FG-496 (DB-backed backlog). Did an architecture + decomposition pass, split it into five sequential slices (FG-606..FG-610), then implemented, reviewed, and shipped **Slice A (FG-606)** end-to-end through the feature pipeline + review-loop → merged to main (`642b952`, PR #156) and closed. Stopped there per operator direction ("report before starting FG-607").

**Picked up next:**
1. **FG-607 — FG-496 Slice B** (DB-backed backlog CRUD behind the `src/backlog/structured.ts` seam + per-project storage mode; default stays `markdown`). The natural next slice; delivers the FG-495 cross-worktree shape in db mode. Open decisions already resolved on the ticket (storage-mode = per-project keyed by project_key host-side in DB; id allocation = transactional sequence per (project_key, prefix)).
2. Then **FG-608** (Slice C — seam-bypassing readers + authoritative cutover; it now also OWNS the removal-reconciliation deferred out of FG-606), **FG-609** (D — queue primitives), **FG-610** (E — atomic claims + claim-next).
3. Route Slice B as `implementation_full` (foundational, builds on Slice A's schema/identity). Same drive pattern worked: launch waves under `forge launch run` + launch-wait Monitor; feature pipeline architect→plan→build→verify→docs, then `forge review-loop FG-607 --since <mergebase> --max-rounds 1`.

**External state to remember:**
- PR #156 merged; nothing pending off-repo. All FG-606 work is on main.
- **Account is on claude_max with a WEEKLY usage cap.** A long agent build hit "out of credits / weekly limit" mid-session (429, reset 17:00 UTC) and killed a build wave; recovered via `forge retry <fanout-parent> --force` + `forge next` after the reset. If invokes start 429ing, that's the cap, not a bug.
- review-loop CI probe quirk: it kept printing "CI unavailable: no status for CI / test-extended" and fell back to LOCAL verification, because `test-extended` is a fail-closed AGGREGATE of six shard jobs that finalizes only after all shards finish. CI was actually healthy — confirm merge-gate green independently with `gh pr checks <pr>` (look for `test` + `test-extended` pass), don't trust the loop's "unavailable".

**Decisions worth not relitigating:**
- **FG-606 import is APPEND-ONLY by deliberate decision.** The Slice-A shadow is non-authoritative (nothing reads it), so it does NOT prune tickets/relations removed from Markdown. Do NOT re-add cross-source pruning to Slice A — a naive single-`imported_from` prune destructively deletes a ticket a sibling linked worktree still has. Multi-source-safe removal reconciliation is deferred to **FG-608** (where the DB becomes authoritative). The "DB rows == Markdown set" AC on FG-606 was refined to append-only scope to match.
- **Project identity:** the shared-DB `project_identity` registry is the authority; `.forge/config.yml` `project_key` is a cache/seed. Derive from `src/util/repository-identity.ts` `repositoryCheckoutIdentity` (converges linked worktrees via git-common-dir) — NEVER `src/v2/project-identity.ts` (`projectIdentity` deliberately diverges per checkout, FG-425). Registry enforces two-directional uniqueness + a 5-rung authority ladder + refuse-on-conflict.
- **Config/DB write atomicity:** the guarded atomic config write happens INSIDE the import `BEGIN IMMEDIATE` txn, BEFORE the commit; the only safe residual is config-only (inert, adopted on retry), never an authoritative DB identity with a missing config.
- **Don't over-guard this personal tool.** I over-drove red-wide across ~6 review rounds on adversarial "maybe" findings (self-symlink attacks, exotic worktree races) and escalated each; operator pushback: "this isn't used by anyone but me." Fix REAL bugs + genuine design forks; disposition theoretical red findings yourself; prefer SIMPLIFYING over adding guards/layers. Saved as memory `feedback_dont_overguard_personal_tool`.

**Shipped (for reference):**
- **FG-606** — FG-496 Slice A: DB ticket schema (`tickets`/`ticket_events`(composite PK)/`ticket_relations`/`blocker_evidence`/storage-mode/id-sequence, all `(project_key, ticket_id)`-keyed, additive-only no user_version bump) + cross-worktree project-identity registry + `forge backlog import` (idempotent-additive, fail-closed on bad status/malformed, symlink/TOCTOU-safe config writes). `642b952` PR #156.
- FG-496 decomposed into FG-606..FG-610 (backlog commits `8cc99e5`, `c1c450a`); FG-608 updated to inherit removal reconciliation.
