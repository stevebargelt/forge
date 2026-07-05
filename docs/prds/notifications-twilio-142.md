# SPEC — Twilio SMS notifications on terminal run-state transitions (#142)

**Status:** shipped in commit `277279c`. Follow-up: post-ship the config surface was changed from "env vars in `~/.zshrc`" to "`~/.forge/notify.env` file (preferred), shell env vars as override." A small loader at `src/notify/load-env.ts` populates `process.env` from the file at CLI startup; shell-set vars take precedence. Same code paths in `twilio.ts` / `trigger.ts` unchanged. Reason for the change: keeps notification creds inside forge's config dir alongside the rest of host-global state, doesn't pollute every shell, no accidental-commit risk.

**Follow-up (FG-471):** the "excluded from defaults" call on `awaiting_gate` below (in "Out of scope") was reversed post-ship — `DEFAULT_NOTIFY_ON` in `src/notify/trigger.ts` includes `awaiting_gate`, so gate pings fire by default like `complete`/`failed`/`blocked_by_red`. A gate needs operator action, which makes it worth a push same as a red-block. Current behavior is documented in [docs/how-to-set-up-notifications.md](../how-to-set-up-notifications.md); the original draft text below is preserved as-is for history.

**Backlog linkage:** closes #142.

---

**Original draft below (preserved for context — pre-loader change):**

## Objective

Add an opt-in notification surface to forge so the host gets pinged via SMS when a workflow finishes (or otherwise stops making autonomous progress). Today a forge workflow ends silently — the user has to keep tabs on the orchestrator or refresh the dashboard. For long-running multi-phase work (architect → plan → build with fanout → verify), that's friction: kick off, walk away, no signal when it's done.

After this spec lands:

- Setting `FORGE_NOTIFY=twilio` + the four `TWILIO_*` env vars in `~/.zshrc` turns notifications on.
- When a run transitions to a terminal-ish state (`complete`, `abandoned`, or any task hits `blocked_by_red`), forge POSTs to the Twilio SMS API with a one-line status message.
- `forge notify test` sends a fixed test SMS so the setup can be verified without waiting for a real workflow.
- The default is OFF — unset env vars means no behavior change, no network calls, no surprise costs.

The single-provider approach is intentional: one user, one need today. If a second provider (Pushover, ntfy, Slack webhook) becomes real, refactor to a provider abstraction at that time.

## Out of scope (deferred)

- **Other providers.** Pushover, ntfy, Slack webhooks, etc. Single provider for now.
- **Retry on SMS failure.** Log + continue. SMS reliability isn't worth complicating the run path.
- **Rate limiting on forge side.** Twilio's account limits are high; personal use won't hit them.
- **Notification for non-forge work.** A long Claude session outside any forge run wouldn't get a notification from this surface. Out of scope; that's a Claude Code hook concern.
- **Background/detached sending.** The Twilio POST is synchronous (200-500ms). For terminal transitions that don't block other dispatches, the latency is invisible. Don't over-engineer with detached subprocess.
- **Including projectDir or workspace in the SMS body.** Run-id implicitly carries the title; user can `forge show <id>` for full context. Keep the SMS under 160 chars (one segment).
- **Notification on `awaiting_gate`.** Excluded from defaults — would fire on every normal gate, noisy. User can opt in via `FORGE_NOTIFY_ON=complete,failed,blocked_by_red,awaiting_gate` if they want it.
- **Config in `~/.forge/notifications.yml` or similar.** Env vars only. No new config file in this spec.

## Commands

### `forge notify test` — NEW

```
forge notify test                  # send a test SMS using current env config
forge notify test --to <number>    # override TWILIO_TO for this one send
```

Behavior:
- Reads the same env vars as the production path: `FORGE_NOTIFY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`.
- Refuses (with a clear error) if `FORGE_NOTIFY` is unset or any required env var is missing.
- Sends a fixed message: `forge: test message from <hostname>` (where `<hostname>` is `os.hostname()`).
- Prints the Twilio API response message-SID on success, the error on failure.

### Everything else — unchanged

No CLI changes to `forge new`, `forge invoke`, `forge next`, `forge gate`, `forge status`, etc. Notifications fire automatically on the relevant transitions when env vars are configured.

## Project structure (files touched)

### Code

- `src/notify/twilio.ts` — NEW. Exports two functions:
  - `notifyTwilio(body: string): Promise<{ ok: true; sid: string } | { ok: false; error: string }>` — POSTs to Twilio's Messages API. Reads `TWILIO_*` env vars at call time (no caching). Returns structured result; never throws.
  - `isTwilioEnabled(): boolean` — checks `FORGE_NOTIFY === "twilio"` AND all four required env vars are present. Used by the call sites to short-circuit cheaply when notifications are off.
- `src/notify/format.ts` — NEW. Pure function `formatRunNotification(run: Run, state: "complete" | "failed" | "blocked_by_red", durationMs?: number): string`. Returns the single-line SMS body. Truncates to 160 chars if a long workflow title would push it over.
- `src/notify/trigger.ts` — NEW. Exports `notifyOnRunTransition(run: Run, newStatus: string)` and `notifyOnTaskBlockedByRed(task: Task, run: Run)`. Each: checks `isTwilioEnabled()`, checks the relevant transition is in `FORGE_NOTIFY_ON` (default: `complete,failed,blocked_by_red`), composes the message via `format.ts`, fires `notifyTwilio()`, logs the result via the existing event log. Never throws — notification failures don't crash the run.
- `src/store/runs.ts::updateRunStatus` — add a single call to `notifyOnRunTransition(run, status)` after the DB write, when the new status is `complete` or `abandoned`. Reads the previous status to avoid double-firing on re-saves of the same status.
- `src/v2/gate.ts` (or wherever task status flips to `blocked_by_red`) — add `notifyOnTaskBlockedByRed(task, run)` at the call site. Find via `grep -n 'blocked_by_red' src/`.
- `src/cli/commands/notify.ts` — NEW. Registers the `notify` top-level command with a `test` subcommand. Action handler calls `notifyTwilio()` with the fixed test message; prints sid or error.
- `src/cli/index.ts` — register `registerNotify(program)`.

### Docs

- `docs/how-to-set-up-notifications.md` — NEW. Top-level how-to. Sections:
  - **What this is** — one paragraph: SMS when a forge run finishes; opt-in, off by default.
  - **Setup** — the four env vars to add to `~/.zshrc`, plus the master switch `FORGE_NOTIFY=twilio`. Recommend `source ~/.zshrc` after editing.
  - **Verify** — `forge notify test` — should produce SMS within a few seconds; print the message-SID on success.
  - **What triggers a notification** — table of run states + which fire by default. Mention `FORGE_NOTIFY_ON` override.
  - **Message format** — example + character budget note.
  - **Opt out** — `unset FORGE_NOTIFY` (or remove from `~/.zshrc`). Notifications immediately stop on next forge invocation.
  - **Troubleshooting** — no SMS arriving (check `forge notify test` first; verify TWILIO_TO format; check Twilio console for sent messages); error messages and what they mean.
  - **NOT covered:** how to get a Twilio account or buy a phone number. Link to twilio.com instead.
- `README.md` — add `docs/how-to-set-up-notifications.md` to the Docs section list (single line).
- `docs/quick-start.md` — NOT updated. Notifications are opt-in and orthogonal to the main flow; doesn't belong in first-run walkthrough.

### Backlog hygiene

- Close #142 with the commit sha after landing.

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess` on. Run `npm run typecheck` and `npm test` before commit.
- ES modules; `.js` suffix on every import from a `.ts` file.
- `src/notify/*.ts` modules are pure where possible (`format.ts` is fully pure; `twilio.ts` has the network call; `trigger.ts` is the only thing with global state from env vars).
- No comments unless WHY is non-obvious. The "never throws" contract on `notifyTwilio` deserves a one-liner ("notification failures don't crash the run").
- Use `fetch` (Node 20+ built-in). No `node-fetch` or `axios` dependency.

## Testing strategy

Baseline: 240/240 tests pass on `main` at `58cd16a`.

### New tests

- `src/notify/format.test.ts` — NEW:
  - `formatRunNotification: complete state produces the expected one-liner`
  - `formatRunNotification: failed state produces the expected one-liner`
  - `formatRunNotification: blocked_by_red state produces the expected one-liner`
  - `formatRunNotification: omits duration when not provided`
  - `formatRunNotification: truncates a long title to keep the SMS under 160 chars`
  - `formatRunNotification: handles workflow name with quotes/special chars without breaking the format`

- `src/notify/twilio.test.ts` — NEW:
  - `isTwilioEnabled: returns false when FORGE_NOTIFY is unset`
  - `isTwilioEnabled: returns false when any required TWILIO_* env var is missing`
  - `isTwilioEnabled: returns true when FORGE_NOTIFY=twilio and all four TWILIO_* are present`
  - `notifyTwilio: returns ok: false when isTwilioEnabled is false (caller guards but defense in depth)`
  - `notifyTwilio` real-call test: NOT included — would hit the real Twilio API. The success/failure paths are exercised manually via `forge notify test` during verification.

- `src/notify/trigger.test.ts` — NEW (optional; can be folded into format/twilio tests):
  - `notifyOnRunTransition: short-circuits cleanly when isTwilioEnabled is false (no network call)`
  - `notifyOnRunTransition: ignores status changes not in FORGE_NOTIFY_ON`
  - `notifyOnRunTransition: ignores no-op same-status writes`

- `src/cli/commands/notify.test.ts` — NEW (optional):
  - Pure test of the test-message composition (`forge: test message from <hostname>`); the actual command handler isn't subprocess-tested (matches prior pattern).

### Manual verification (the spec is not done without these)

1. Add the five env vars to `~/.zshrc` (user-side; not in this commit). `source ~/.zshrc`.
2. `forge notify test` — should send an SMS within a few seconds. Confirm receipt; confirm Twilio dashboard shows one outbound message.
3. `forge notify test --to +1<other-number>` — confirms the override flag works.
4. `unset FORGE_NOTIFY && forge notify test` — should fail with a clear "FORGE_NOTIFY is not set" error.
5. Kick off a short real workflow (`forge invoke research-specialist --task "one-sentence test claim" --run-title "notify smoke test"`). When the run completes, confirm SMS arrives.
6. Force a blocked_by_red transition (or simulate one by running a workflow whose reds are guaranteed to fail). Confirm SMS arrives.

### Regression check
- `npm run typecheck` clean (root + dashboard).
- `npm test` — 240/240 + new tests pass.
- All existing CLI commands unaffected (typecheck catches signature breaks).
- Forge runs with `FORGE_NOTIFY` unset behave identically to today (zero network calls).

## Boundaries

### Always do
- Read Twilio credentials from env vars only. Never from `~/.forge/`, never from `package.json`, never in a checked-in file.
- Default OFF. No notification fires unless `FORGE_NOTIFY=twilio` is set.
- Never block or fail a forge run because of a notification error. Log via the existing event log; the run continues.
- Use `fetch` (Node 20 built-in). No new dependencies.

### Ask first about
- Adding a config file (e.g. `~/.forge/notifications.yml`). Env vars only for this spec.
- Adding a second provider. Refactor decision; out of scope here.
- Adding background/detached notification sending. Synchronous for now.
- Including projectDir or workspace in the SMS body. Keep the format as specified.
- Adding rate limiting or deduplication. Personal use; not needed yet.

### Never do
- Log the auth token. Never. Not in stderr, not in events.db, not in any error message that surfaces it.
- Hard-code phone numbers or credentials anywhere in the repo.
- Add Twilio creds to `package.json`, `.env.example`, or any checked-in file.
- Make the notification path throw — wrap all errors in the structured return.
- Touch the verdict aggregation rule in `gate.ts` beyond adding the one trigger call.
- Touch the Docker spawn pattern.
- Change the state-machine status values.
- Estimate work in days/weeks.

## Implementation order

1. **Pure modules first.** `src/notify/format.ts` + its tests. No env vars, no network, just string formatting. Confirms the message shape.
2. **`twilio.ts` + `isTwilioEnabled`.** Network module + the env-var guard. Tests cover the guard logic; real network call is verified manually in step 6.
3. **`trigger.ts`.** Composes format + twilio; reads `FORGE_NOTIFY_ON`; never throws. Tests confirm the short-circuit and filter logic.
4. **Wire `updateRunStatus`.** One call site, one new line. Manual smoke test: change a run's status via `node --import tsx` REPL, confirm trigger.ts fires (with notifications off, just confirm no errors; with notifications on, confirm SMS).
5. **Wire `blocked_by_red` transition.** Grep for the call site in `src/v2/gate.ts` or `src/v2/runNext.ts`; add the second trigger call.
6. **`forge notify test` subcommand.** New file + registration. Manual verification: real SMS to confirm the end-to-end path.
7. **Docs.** Write `docs/how-to-set-up-notifications.md` from the structure above. Add one-line pointer to README.
8. **Backlog hygiene + commit.** Close #142 with the commit sha. Update BACKLOG notes.

Each step is independently testable. Pause for review between 4 and 5 if the blocked_by_red call site is ambiguous (it might live in multiple places — gate.ts handles authoritative-red fails, but reconcile or retry paths could too).
