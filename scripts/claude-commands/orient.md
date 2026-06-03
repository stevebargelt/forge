Start-of-session orientation for a forge orchestrator. Execute the orchestrator's start-of-session protocol and report a compact state-of-play. Do not re-state the orchestrator role — the CLAUDE.md orchestrator block already establishes it; performing the protocol IS the demonstration.

**Hard rule for this command: use the `forge backlog` CLI for all backlog reads. Do NOT use the Read tool on BACKLOG.md — it's ~2000 lines and grows; the CLI is the bounded interface.** `forge backlog show <id>` is the only acceptable way to fetch a specific ticket body.

Steps:

1. Run these in parallel:
   - `forge backlog notes show` — the handoff from the prior session
   - `forge backlog list --status active` — currently-open tickets (titles only)
   - `forge backlog list --status done 2>&1 | head -30` — recently closed tickets, for reconciling against the notes' priorities
   - `git status` — working tree state
   - `git log --oneline origin/main..HEAD 2>/dev/null` — unpushed commits ahead of origin (silently empty if no remote)
   - `forge projects show "$(basename "$PWD")" 2>/dev/null` — this project's run history + live sessions (silent if forge doesn't know about it)
   - `forge ops check --json 2>/dev/null` — read-only operational incidents for this project (silent/empty on older installs without the command)

2. Synthesize and report in this order, compact (no headers padded with whitespace):
   - **Project:** name + path
   - **Picking up:** the "Picked up next" line from the notes block, plus the most recent commit subject
   - **State:** current branch · N commits ahead of origin · dirty/clean
   - **Active tickets:** total count + the top 3 by sticky number
   - **Needs attention:** unpushed commits older than a day, in-flight forge runs that aren't this session, stale notes (notes block missing a "Picked up next" section), stale ticket refs (from reconciliation below), ops incidents (when non-empty, see below)

   **Ticket reconciliation (do this before reporting):** Extract every `#<number>` reference from the notes' "Picked up next" section. For each one, check whether it appears in the active list. Any ref that does NOT appear in the active list — it shows up in the done list, or is absent altogether — is stale. Surface each stale ref under **Needs attention** as: _"notes list #N as a next step, but it is no longer active (closed/merged) — likely already shipped; the live next move is elsewhere."_ If the closing commit sha is visible in the git log output, cite it. Do not treat the notes' priority list as live until every ticket ref has been verified against the active list.

   **Ops attention (include only when non-empty):** If `forge ops check --json` returned a non-empty array, surface under **Needs attention** as: _"Ops attention: N incident(s) — <kind>, e.g. retry_orphan (run-x / task-y)."_ Lead with the highest-severity incidents; name the kind plus run/task IDs. Omit entirely when the array is empty — consistent with not padding nothing-to-report sections. These incidents are scoped to this project (cwd) and are read-only signals; orient reports them, it does not act on them.

3. End with one question: **"What do we forge next?"** Let the user steer. Do not volunteer a plan or start work; orientation is a pre-condition for work, not work itself.

Do NOT:
- Read BACKLOG.md whole (use the CLI)
- Re-state "you are a forge orchestrator" — performing the protocol is stronger than declaring the role
- Pre-load context the user didn't ask for (no `git log -p`, no diffing recent commits, no reading source files)
- Auto-recommend the next ticket — that's a planning decision the user owns
