End-of-session handoff for a forge orchestrator. Update the backlog notes block so the next session has a real starting point, and surface anything that needs human attention before stopping.

**Hard rule for this command: use the `forge backlog` CLI for all backlog reads and writes. Do NOT use the Read or Edit tool on BACKLOG.md — the CLI is the bounded interface.** Drill into specific tickets only via `forge backlog show <id>` when you need one ticket's body.

The value of the notes block is forward-looking context that git can't give you (where the thread left off, decisions about what *wasn't* done, external state to remember). "What shipped" is incidental — git log is the canonical record. Lead with the forward-looking sections.

Steps:

1. Run these in parallel to collect session state:
   - `git log --oneline origin/main..HEAD 2>/dev/null` — commits ahead of origin since last push
   - `git status` — uncommitted changes
   - `forge backlog notes show` — the current notes block (about to be replaced)
   - `forge backlog list --status done 2>&1 | head -30` — tickets closed recently (most-recent first)

2. Draft a new notes block in this exact shape and apply it immediately by piping it to `forge backlog notes replace -` via a **quoted-delimiter heredoc** — this is mandatory, because handoff blocks contain backticks, `$`, and quotes that a plain `"..."` argument would let the shell expand or mangle:

   ```
   forge backlog notes replace - <<'NOTES'
   <draft block goes here>
   NOTES
   ```

   The quoted `'NOTES'` delimiter disables all shell expansion, so the block lands verbatim. (`replace` also rejects empty input, so a botched pipe errors instead of silently wiping the block.) Do NOT carry forward the old content unchanged; the value comes from synthesizing what's actually true *now*. Do NOT present the draft for review — the user trusts the synthesis and is not going to read it before applying. If the synthesis is wrong, they'll catch it in the next session's `/orient`.

   ```
   **Last session ended <YYYY-MM-DD>.**

   **Where we left off:** <one sentence on the mid-conversation thread or last user direction>

   **Picked up next:** <2-3 concrete starting moves the next session can take, ordered by priority>

   **External state to remember:** <off-repo items: third-party approvals, deployments, manual steps pending, etc. Omit this section entirely if there is none — don't pad with "nothing.">

   **Decisions worth not relitigating:** <items considered + closed/deferred this session with one-line reason each. Prevents future-self from re-debating settled calls. Omit if none.>

   **Shipped (for reference):** <punch list of ticket IDs + one-liners. Git log is canonical; this is orientation only. Keep tight.>
   ```

   **Reconciliation guard for "Picked up next":** Before listing any ticket under "Picked up next", verify it still appears in the active list and is not in the done list and not referenced by a merge commit from this session. Any ticket that closed or landed this session belongs under **Shipped (for reference)**, never under "Picked up next". If a next move is not a ticket (e.g. an external review, hardware verification, a manual deploy step), state it explicitly as a non-ticket thread — don't assign it a `#number` ref — so it is not mistaken for a backlog item and is not lost when ticket refs are pruned.

3. Final status line: report branch ahead-of-origin count + uncommitted file count. If commits are unpushed, ask whether to push. **Do not auto-push.**

Do NOT:
- Read BACKLOG.md whole (use the CLI)
- Auto-push commits (always ask)
- Auto-update CLAUDE.md or memory without flagging the proposed change first and getting an explicit yes
- Lead the notes with "what shipped" — the forward-looking sections are the value; shipped list is reference
- Pad sections with "nothing to report here" — omit empty sections entirely
