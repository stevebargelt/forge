# SPEC — Twilio SMS double opt-in flow (#145)

**Status:** shipped in `4a6ebc6`; original specification preserved below.
**Backlog linkage:** #145 closed. Follow-on to #142 (Twilio notifications shipped).

## Objective

The #142 notification surface works mechanically — set env vars, get pings. But Twilio's A2P 10DLC campaign approval requires proof of recipient opt-in, even for one-person personal use. This spec adds a CLI-driven double opt-in: the user runs `forge notify subscribe <number>`, the number receives a confirmation SMS with a code, the user runs `forge notify confirm <code>`, and forge writes both the active TWILIO_TO and an append-only consent record.

After this lands:

- Twilio campaign reviewers can be shown `~/.forge/notify-consent.log` as proof of consent.
- The recipient explicitly confirms via SMS code before any notification SMS will arrive.
- `forge notify unsubscribe` cleanly removes the recipient and logs the event.
- `forge notify status` shows current subscription state + recent consent events.
- Existing flow (manually editing `notify.env`) still works — but the CLI flow is the documented path.

## Out of scope (deferred)

- **HELP keyword auto-response.** Twilio handles HELP carrier-side for 10DLC numbers — no forge code needed.
- **Multiple concurrent subscribers.** TWILIO_TO is single-valued. If you ever need to notify multiple recipients, that's a different feature (multi-channel fanout) and a separate ticket.
- **Subscription transfer / "move TWILIO_TO to another number."** Just `unsubscribe` then `subscribe <new>`.
- **Web UI for subscription management.** CLI-only; matches forge's interaction model.
- **Encryption of the consent log.** Local-machine personal data; filesystem permissions are the boundary. Don't add complexity here.
- **STOP handling on the forge side.** Twilio's carrier-side STOP blocking is already automatic for 10DLC. If the user replies STOP, future sends to that pair are refused at the API level — `notifyTwilio` will return an error (which we already handle gracefully via stderr). No proactive code needed.
- **Backward compat for users who already set TWILIO_TO manually in notify.env.** If TWILIO_TO is set but no consent record exists, the existing `forge notify test` / production notifications still work — opt-in CLI is opt-in itself. Add a one-line note in `forge notify status` if this is the case ("TWILIO_TO is set in notify.env but no subscribe record — for Twilio compliance, run `forge notify subscribe <number>` and confirm").

## Commands (CLI surface)

### `forge notify subscribe <number>` — NEW

```
forge notify subscribe +15551234567
```

Behavior:
- Validates the number looks like E.164 (`+` prefix + digits). Rejects otherwise.
- Refuses if a confirmed subscription already exists for a different number ("unsubscribe first").
- If a pending confirmation already exists for a *different* number, cancel it (log a `subscribe-cancelled` event) and start the new flow.
- Generates a 4-digit confirmation code (random, no leading zero).
- Writes `notify-state.json` with `{ pendingConfirmation: { to, code, createdAt, expiresAt } }`. Window: 10 minutes.
- Logs a `subscribe-requested` event to `notify-consent.log`.
- Sends the SMS: `forge: confirm subscription with: forge notify confirm 4827. Code expires in 10 min. Reply STOP to opt out.`
- Prints to terminal: instructions to run the confirm command + how long the code is valid.
- On SMS failure: rolls back the state write and the log entry (so retry is clean).

### `forge notify confirm <code>` — NEW

```
forge notify confirm 4827
```

Behavior:
- Reads `notify-state.json`. If no pending confirmation, error: "no pending subscription".
- If the code doesn't match: error: "invalid code", no state change, retry allowed (no lockout — this is personal use).
- If the code matches but `expiresAt` is past: error: "code expired, run subscribe again", clears the pending entry.
- On success:
  - Writes/updates `TWILIO_TO=<number>` in `~/.forge/notify.env` (creates the file if absent, preserves other lines if present).
  - Updates `notify-state.json`: clears `pendingConfirmation`, sets `currentSubscription: { to, subscribedAt }`.
  - Appends `subscribe-confirmed` event to `notify-consent.log`.
  - Sends final SMS: `forge: subscribed. You'll be notified on workflow completion. Reply STOP to opt out.`
  - Prints terminal confirmation.

### `forge notify unsubscribe` — NEW

```
forge notify unsubscribe
forge notify unsubscribe --silent       # skip the goodbye SMS
```

Behavior:
- Reads current subscription from `notify-state.json` (preferred) or `notify.env` (fallback).
- If no subscription: informational message, exit 0.
- Otherwise:
  - Unless `--silent`: sends `forge: unsubscribed. No more messages.` to the current number.
  - Removes `TWILIO_TO=` line from `notify.env` (leaves other vars intact). If the file becomes empty/all-blank, leaves it (don't delete).
  - Updates `notify-state.json`: clears `currentSubscription`.
  - Appends `unsubscribe` event to `notify-consent.log`.

### `forge notify status` — NEW

```
forge notify status
```

Prints (in plain text):
- `FORGE_NOTIFY` value, whether all required env vars are set (`isTwilioEnabled()` result)
- Current confirmed subscription (number + subscribedAt), or "no active subscription"
- Pending confirmation if any (number + minutes remaining), or "none"
- Recent consent events (last 10 from the log)
- Compliance hint if TWILIO_TO is set in notify.env but no consent record exists

### `forge notify test` — UNCHANGED

Still sends the hostname test SMS. Doesn't require a confirmed subscription (uses TWILIO_TO directly) — it's a wiring test, not a notification.

## Project structure (files touched)

### Code

- `src/notify/consent.ts` — NEW. Owns the state machine + storage. Exports:
  - `loadState(): NotifyState` — reads `~/.forge/notify-state.json`, returns `{ currentSubscription, pendingConfirmation }`. Defaults if file missing.
  - `saveState(state): void` — writes atomically (write-temp + rename).
  - `appendConsentLog(event: ConsentEvent): void` — append-only line to `~/.forge/notify-consent.log`.
  - `generateConfirmationCode(): string` — 4-digit random.
  - `updateNotifyEnvTo(number: string | null): void` — surgically writes/removes `TWILIO_TO` line in `~/.forge/notify.env`. Leaves other lines intact. If number is null, removes the line.

- `src/cli/commands/notify.ts` — EXTENDED. Add `subscribe`, `confirm`, `unsubscribe`, `status` subcommands alongside the existing `test`. Each handler is small (10–30 LoC) and delegates state work to `consent.ts`.

- `src/notify/twilio.ts` — UNCHANGED.
- `src/notify/format.ts` — small addition: exported `subscribeRequestBody(code)`, `subscribeConfirmedBody()`, `unsubscribeBody()` for the canonical SMS texts. Keeps strings in one place.
- `src/notify/trigger.ts` — UNCHANGED.

### Tests

- `src/notify/consent.test.ts` — NEW:
  - `loadState: returns defaults when file missing`
  - `loadState/saveState: round-trip preserves currentSubscription`
  - `loadState/saveState: round-trip preserves pendingConfirmation`
  - `saveState: atomic write (write to temp, rename)`
  - `appendConsentLog: appends a JSON line; existing lines preserved`
  - `appendConsentLog: handles missing parent dir (FORGE_HOME) by creating it`
  - `updateNotifyEnvTo: writes TWILIO_TO when file missing`
  - `updateNotifyEnvTo: updates existing TWILIO_TO line in place`
  - `updateNotifyEnvTo: preserves other lines (comments, blanks, other env vars)`
  - `updateNotifyEnvTo: removes TWILIO_TO when number is null`
  - `generateConfirmationCode: returns 4-digit numeric string without leading zero`
- `src/notify/format.test.ts` — extend with one test per canonical SMS body (verify format + length under 160 chars).

### Docs

- `docs/how-to-set-up-notifications.md` — major update:
  - Setup section now leads with `forge notify subscribe <number>` → `confirm <code>` flow, NOT manual env-file editing.
  - Old "edit ~/.forge/notify.env directly" remains as the "advanced / scripted" alternative further down.
  - Add a new "Unsubscribing" section.
  - Add a new "Consent records" section explaining `~/.forge/notify-consent.log` and that Twilio campaign approval can reference it.

- `docs/sms-terms.md` — NEW. One-page consent terms:
  - Who sends, who receives
  - What triggers messages (terminal forge transitions)
  - How to opt out (STOP keyword + `forge notify unsubscribe`)
  - Privacy: data stays on the local machine, no third parties beyond Twilio
  - Contact (the user's email, blank for the user to fill in)
  - Suitable for linking to during Twilio campaign registration

## Code style

- TypeScript strict, ES modules, `.js` suffix on imports.
- `consent.ts` is mostly pure (the file I/O is unavoidable); state mutation goes through `saveState`.
- File writes are atomic (write to `<file>.tmp`, `rename` to target). Prevents corruption mid-write.
- No comments unless WHY is non-obvious. The atomic-write pattern + the "append-only is intentional" intent both deserve one-liners.
- No new dependencies.

## Testing strategy

Baseline: 268/268 forge tests + 8/8 dashboard tests pass on `main` at `0a13cf7`.

### New tests (covered above)
- ~11 consent.test.ts tests
- ~3 additional format.test.ts tests for the new SMS bodies

### Manual verification

The full path requires real SMS:

1. `forge notify subscribe +15551234567` (your real number) — terminal prints "code sent, confirm within 10 minutes". SMS arrives.
2. `forge notify confirm <code-from-sms>` — terminal prints "confirmed". Final "subscribed" SMS arrives.
3. `forge notify status` — shows `currentSubscription` populated, recent events.
4. `cat ~/.forge/notify-consent.log` — JSON lines showing subscribe-requested + subscribe-confirmed.
5. `cat ~/.forge/notify.env` — `TWILIO_TO=+15551234567` present.
6. `forge notify test` — still works (sends test SMS to the now-confirmed number).
7. `forge notify unsubscribe` — "unsubscribed" SMS arrives. `notify.env` TWILIO_TO removed. Log gains an `unsubscribe` event.
8. `forge notify status` — shows "no active subscription".
9. Re-subscribe → confirm with wrong code → "invalid code", state unchanged.
10. Re-subscribe → wait 10+ min → confirm → "code expired".

### Regression check
- `npm run typecheck` clean (root + dashboard).
- `npm test` — 268+ + new tests pass.
- Existing `forge notify test` still works (no behavior change).
- Existing notifications on workflow completion still fire (the trigger path is unchanged).

## Boundaries

### Always do
- Atomic file writes for `notify-state.json` and `notify.env` (write-temp + rename).
- Append-only for `notify-consent.log`. Never truncate, never rewrite a prior line.
- Validate E.164 format on subscribe before sending the SMS.
- Surface SMS failures clearly — but don't leave half-written state. Roll back on failure.
- Never log the auth token or include it in any error message.

### Ask first about
- Adding HELP / STOP keyword handling on the forge side (Twilio does it carrier-side for 10DLC).
- Storing consent records anywhere outside `~/.forge/notify-consent.log`.
- Encrypting the consent log.
- Adding any non-CLI surface (web UI, API endpoint) for subscription management.
- Changing the manual-edit path (notify.env editing) to be a hard error rather than just a status hint.

### Never do
- Truncate or rewrite `notify-consent.log`. Append-only is the contract — Twilio support might ask for it.
- Send an SMS that doesn't include "Reply STOP to opt out" on the subscribe-request or subscribe-confirmed messages.
- Accept a confirmation code that's expired or matches a stale pending entry.
- Allow `subscribe` to silently overwrite a confirmed subscription. The user MUST unsubscribe first.
- Add anything to `notify.env` other than `KEY=value` lines (no JSON, no shell heredocs).

## Implementation order

1. **`src/notify/consent.ts` + tests.** State machine + storage primitives, no CLI yet. Verify atomic writes, JSON-lines append, surgical env-file updates.
2. **`src/notify/format.ts` extension.** Add subscribe-request / subscribe-confirmed / unsubscribe body composers. Update format.test.ts.
3. **`src/cli/commands/notify.ts` extension.** Add `subscribe`, `confirm`, `unsubscribe`, `status` subcommands. Each delegates to consent.ts + twilio.ts; the handlers themselves are thin.
4. **`docs/how-to-set-up-notifications.md`** rewrite: lead with the CLI flow, demote manual notify.env editing to "advanced".
5. **`docs/sms-terms.md`** new page for the Twilio campaign registration.
6. **Manual verification** end-to-end (10 steps under Testing → Manual). Requires real SMS — user does this.
7. **Backlog hygiene + commit.** Close #145.

Each step is independently verifiable. Pause for review after step 1 if the state-machine shape produces any surprises (e.g. concurrency concerns from two terminals running `subscribe` simultaneously — should be rare for personal use but worth a one-line note if I notice it during implementation).
