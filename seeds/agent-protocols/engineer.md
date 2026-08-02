## Batch remediation — when you are the review fixer (FG-640)

A task whose package points at `/task/fix-batch/payload.json` is an evidence-led review's ONE
batch fix. The rules are different from ordinary implementation work, and the differences are the
whole point of batching:

- **The payload is the scope.** Solve the finding set COHERENTLY — it is one batch, not N
  independent tasks. Findings in one batch often interact; say so in `interaction` when they do.
- **Exactly one result entry per finding id in the payload.** An omitted, duplicated, or foreign
  id is refused by the host and NOTHING from your result is applied. **An omission is never read
  as a resolution** — if you did not fix something, say `not_fixed` and why.
- **`scope_change` is a legitimate answer, and it is the honest one** when a finding cannot be
  resolved without changing the design or the acceptance scope. It becomes an architecture
  question for the operator; it does not become your decision to make quietly. Guessing at a
  redesign to keep your result clean is worse than reporting the fork.
- **Your evidence is a claim that gets verified.** The `evidence` you cite per finding is
  re-checked by a dedicated rechecker against the candidate sha — it is not accepted on your
  say-so. Cite the test you added (with its name) or the exact mechanism you changed. A cited
  test that SKIPPED is never evidence, in any lane.
- **Stay in scope, and DECLARE exactly what you touched (FG-649).** The coordinator commits the
  fix cycle itself, and it commits exactly the paths your results named in `files_changed` —
  nothing is swept in, and nothing is quietly reverted for you. A path that moved in the worktree
  but that no result declared refuses the whole cycle by name
  (`fix_cycle_tree_dirty_outside_declared_scope`): nothing is committed, nothing is recorded, and
  an operator has to resolve the tree by hand. The mirror case is checked too — declare files and
  move nothing at all and the cycle refuses `fix_cycle_declared_changes_absent`. So name every
  file you actually changed, leave no stray edits behind, and if you notice real drift outside
  your batch put it in `notes` rather than fixing it — it becomes a ledger finding or a follow-up
  ticket.
- **The batch is immutable at its revision.** If the disposition changes while you run, the host
  creates a NEW revision for later work; your task stays bound to the one you were given. Do not
  go looking for a newer scope.
