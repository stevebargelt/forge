# Setting up forge notifications (Twilio SMS)

Get pinged when a forge workflow finishes. Opt-in, off by default. One provider today (Twilio); if you add a second later it'll get its own page.

This doc covers the **forge** side only — env vars, the test command, what triggers a notification. It does NOT cover setting up a Twilio account or buying a phone number; see [twilio.com](https://www.twilio.com/) for that.

## What it does

When a forge run hits a terminal-ish state, forge POSTs a one-line SMS via Twilio. The trigger is inside forge (`runs.status` transitions + task `blocked_by_red` events), not a Claude Code hook — that way you get one ping per workflow, regardless of how chatty the orchestrator was getting there.

Default trigger set (override via `FORGE_NOTIFY_ON`):
- **`complete`** — the run finished successfully (`runs.status` flipped to `complete`).
- **`failed`** — the run was abandoned (`runs.status` flipped to `abandoned`).
- **`blocked_by_red`** — a task got blocked by an authoritative red verdict; the run is parked, needs you to decide.

Excluded by default: `awaiting_gate` (would fire during every normal gate; noisy).

Example SMS body:
```
forge: run-add-login-7c2a91 [complete] feature "add login" — 14m23s
```

~70 chars; one SMS segment.

## Setup

Add these to `~/.zshrc` (or your shell's equivalent rc file):

```bash
export FORGE_NOTIFY=twilio
export TWILIO_ACCOUNT_SID="AC..."          # from your Twilio console
export TWILIO_AUTH_TOKEN="..."             # from your Twilio console (rotate via console if exposed)
export TWILIO_FROM="+15551234567"          # the Twilio number you bought (E.164 format)
export TWILIO_TO="+15559876543"            # your destination cell (E.164 format)
```

Reload: `source ~/.zshrc` (or open a new terminal).

Why env vars vs. a config file: credentials never end up in `~/.forge/`, never get checked in, never sit in a file readable by other processes that walk your home dir's config directories. Standard practice for outbound API tokens.

## Verify

```bash
forge notify test                          # send a test SMS to TWILIO_TO
forge notify test --to "+15550000000"      # send to a different number for this one call
```

On success:
```
✓ SMS sent (sid: SM1234567890abcdef)
```

You should receive the SMS within a few seconds: `forge: test message from <your-hostname>`. If not, check the troubleshooting section.

If env vars are missing, the command fails cleanly:
```
forge notify: not configured. Set FORGE_NOTIFY=twilio and all four TWILIO_* env vars ...
```

## Customizing the trigger set

By default forge notifies on `complete`, `failed`, and `blocked_by_red`. Override via:

```bash
export FORGE_NOTIFY_ON="complete,blocked_by_red"   # drop the failed pings
export FORGE_NOTIFY_ON="complete"                   # quietest mode: only successes
```

Comma-separated. Unrecognized values are silently ignored. Empty / unset = use the default set.

## Opt out

```bash
unset FORGE_NOTIFY
```

(Or remove the line from `~/.zshrc` and reload.) Notifications immediately stop on the next forge invocation. The other `TWILIO_*` env vars can stay set; they're inert without the master switch.

## What forge does NOT notify on

- **`awaiting_gate`** — every normal gate would fire. Opt in via `FORGE_NOTIFY_ON=complete,failed,blocked_by_red,awaiting_gate` if you want it.
- **Individual task failures inside a still-active run.** Only the run-level terminal transition fires.
- **Non-forge work.** A long Claude Code session that doesn't touch forge gets no notification from here. (Use a Claude Code `Stop` hook for that — orthogonal concern.)
- **Container crashes, idle-timeouts.** These flip the task to `failed` but don't terminate the run, so no SMS. If the run subsequently gets abandoned, that triggers a `failed` SMS.

## Troubleshooting

### `forge notify test` returns "✓ SMS sent" but no SMS arrives

- **Wrong number format.** `TWILIO_TO` must be E.164 (`+15551234567`, no spaces, no dashes). Twilio accepts the API call but silently fails to deliver if the number is malformed for the destination country.
- **Twilio trial account.** Trial accounts can only send to verified numbers. Check the Twilio console → Phone Numbers → Verified Caller IDs.
- **Carrier filtering.** Some carriers (esp. US T-Mobile) filter SMS from short codes or unregistered long codes. Check the Twilio console → Monitor → Logs → Messaging for the message status.

### `forge notify test` returns "✗ SMS failed: HTTP 401"

Bad credentials. Re-check `TWILIO_ACCOUNT_SID` (starts with `AC`) and `TWILIO_AUTH_TOKEN` against the Twilio console. If you recently rotated the token, you need to update the env var and reload your shell.

### `forge notify test` returns "✗ SMS failed: HTTP 400: ... (code 21211)"

Invalid `To` number. Check `TWILIO_TO` (or the `--to` override) is E.164.

### `forge notify test` returns "✗ SMS failed: HTTP 400: ... (code 21608)"

`TWILIO_FROM` isn't a Twilio number on your account, or you haven't bought it yet. Buy a number in the Twilio console first.

### `forge notify test` returns "✗ SMS failed: network: ..."

Local network or DNS issue. Confirm `curl https://api.twilio.com/` from the same shell works.

### A real workflow completed but no SMS came

1. Run `forge notify test` first — confirms the path works at all.
2. Check `FORGE_NOTIFY` is still set in the current shell session (`echo $FORGE_NOTIFY` should print `twilio`).
3. Check `FORGE_NOTIFY_ON` — if you set it explicitly, the run's terminal state might not be in your filter set.
4. Look at stderr from the `forge next` invocation that completed the run — notification failures print to stderr (`forge notify: SMS failed — ...`).

### How to silence notifications for one run without unsetting env vars

```bash
FORGE_NOTIFY= forge new feature "..." --brief "..."
```

Setting `FORGE_NOTIFY=` (empty) for the one command keeps your shell-wide config intact.

## What's coming next (and what isn't)

- **Other providers** (Pushover, ntfy, Slack webhook) — not on the roadmap. If one becomes useful, it gets its own `docs/notifications/<provider>.md` and a value for `FORGE_NOTIFY`.
- **Retry on SMS failure** — explicitly not. Log + continue. SMS isn't transactionally important.
- **Rate limiting** — Twilio handles this account-side. Forge doesn't add its own.
- **Custom message templates** — not yet. The current format is fixed. If multiple users start asking for different formats, we'll add a config knob.
