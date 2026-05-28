# Setting up forge notifications

Get pinged when a forge workflow finishes. Opt-in, off by default. Two providers: **Twilio SMS** and **ntfy push notifications**. Use one or both (`FORGE_NOTIFY=twilio,ntfy`).

This doc covers the **forge** side only — credentials, the opt-in flow, the test command, what triggers a notification. It does NOT cover setting up a Twilio account or buying a phone number (see [twilio.com](https://www.twilio.com/)), or hosting an ntfy server (see [docs/how-to-ntfy.md](how-to-ntfy.md)).

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

Two parts: **credentials** in a config file (one-time), then **subscribe** the destination number via a double opt-in flow.

### 1. Credentials

Put your Twilio account info in `~/.forge/notify.env`. Forge loads this file at every CLI invocation; no shell reload, no global env pollution, no risk of accidentally committing into a repo.

```
# ~/.forge/notify.env
FORGE_NOTIFY=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+15551234567
```

Note: **don't** put `TWILIO_TO` here. The subscribe flow (next step) writes it for you after the recipient confirms via SMS code. Compliance with Twilio A2P 10DLC needs an explicit consent record (see [SMS terms](sms-terms.md) and the consent log section below).

Format: bash-style `KEY=value` per line. Blank lines and `# comments` are ignored. Surrounding `"..."` or `'...'` around values is stripped.

### 2. Subscribe (double opt-in)

```bash
forge notify subscribe +15559876543
```

That sends a confirmation SMS to `+15559876543` with a 4-digit code, e.g.:
```
forge: confirm subscription with: forge notify confirm 4827. Code expires in 10 min. Reply STOP to opt out.
```

You (or whoever owns the destination number) then runs:

```bash
forge notify confirm 4827
```

That:
- Writes `TWILIO_TO=+15559876543` into `~/.forge/notify.env`.
- Appends a `subscribe-confirmed` event to `~/.forge/notify-consent.log` (append-only audit trail; Twilio campaign approval references this).
- Sends a final SMS: `forge: subscribed. You'll be notified on workflow completion. Reply STOP to opt out.`

The code expires in 10 minutes. Wrong codes are rejected with no lockout — just try again or re-run `subscribe`.

### Verify

```bash
forge notify test                          # send a test SMS to TWILIO_TO
forge notify test --to "+15550000000"      # send to a different number for this one call
forge notify status                        # show current subscription + state
```

`forge notify test` produces `✓ SMS sent (sid: SM...)` on success. The test SMS goes to the confirmed `TWILIO_TO` (or `--to` if overridden) and is body `forge: test message from <hostname>`.

### Unsubscribe

```bash
forge notify unsubscribe                   # sends a goodbye SMS first
forge notify unsubscribe --silent          # skip the goodbye
```

Clears `TWILIO_TO` from `notify.env`, logs an `unsubscribe` event to the consent log, and (unless `--silent`) sends `forge: unsubscribed. No more messages.` to the now-former recipient.

Twilio also handles `STOP` keyword carrier-side automatically: replying STOP to the From number blocks all future sends to that pair, no forge action needed.

## Consent records

`~/.forge/notify-consent.log` is an append-only JSON-lines file capturing every subscribe / confirm / unsubscribe event. Sample:

```
{"event":"subscribe-requested","to":"+15559876543","at":"2026-05-25T17:25:00.000Z"}
{"event":"subscribe-confirmed","to":"+15559876543","at":"2026-05-25T17:26:30.000Z","method":"cli-double-opt-in"}
{"event":"unsubscribe","to":"+15559876543","at":"2026-06-01T09:00:00.000Z"}
```

This is the file you point Twilio at if their A2P 10DLC reviewers ask for proof of recipient opt-in. Never edit it manually; it's append-only by contract.

## Advanced: manual `TWILIO_TO`

If you really want to skip the subscribe flow (you're scripting, or migrating from an earlier version), you can put `TWILIO_TO=...` directly in `notify.env`. Notifications still fire. But:
- No consent record exists, so Twilio campaign review will lack evidence for this destination.
- `forge notify status` flags the situation and tells you to run subscribe for compliance.

Generally use the CLI flow.

## Shell env vars as an alternative

If you'd rather export `TWILIO_*` in `~/.zshrc` (e.g. you already have them set for another tool that uses Twilio), that works too. Shell-set env vars **take precedence** over `~/.forge/notify.env`. But the subscribe / confirm flow only writes to `notify.env` — if you want the consent log entry, run subscribe; the env var path doesn't create one.

---

## ntfy (push notifications)

ntfy is a simple HTTP-based push notification service. No account, no API keys (unless your server requires auth), no compliance flow. Just a URL.

### Setup

Add to `~/.forge/notify.env`:

```
FORGE_NOTIFY=ntfy
NTFY_URL=https://your-ntfy-server.example.com/forge
```

That's it. `NTFY_URL` is the full topic URL (server + topic name in the path). Optional vars:

- `NTFY_TOKEN` — bearer token for your ntfy server. Required if auth is enabled (recommended — open topics let anyone spam your phone).
- `NTFY_PRIORITY` — ntfy message priority (`min`, `low`, `default`, `high`, `urgent`). Default: `default`.

To use **both** Twilio and ntfy:

```
FORGE_NOTIFY=twilio,ntfy
```

Both fire on the same events. Each provider's failure is independent — if SMS fails, ntfy still sends (and vice versa).

### Verify

```bash
forge notify test     # sends to all configured providers
forge notify status   # shows which providers are ready
```

### Hosting ntfy

See [docs/how-to-ntfy.md](how-to-ntfy.md) for self-hosting options (Azure, Raspberry Pi, etc.) or use the free public instance at `ntfy.sh` for quick testing:

```
NTFY_URL=https://ntfy.sh/my-forge-notifications
```

(Public topics are world-readable — use a hard-to-guess topic name or self-host for privacy.)

---

## Customizing the trigger set

By default forge notifies on `complete`, `failed`, and `blocked_by_red`. Override via:

```bash
export FORGE_NOTIFY_ON="complete,blocked_by_red"   # drop the failed pings
export FORGE_NOTIFY_ON="complete"                   # quietest mode: only successes
```

Comma-separated. Unrecognized values are silently ignored. Empty / unset = use the default set.

## Opt out (master switch)

To stop all notifications without unsubscribing the number:
- Edit `~/.forge/notify.env` and change `FORGE_NOTIFY=twilio` to `FORGE_NOTIFY=` (or comment it out).
- Or in a single-shell context: `unset FORGE_NOTIFY`.

Notifications immediately stop on the next forge invocation. The other `TWILIO_*` values can stay set; they're inert without the master switch.

## What forge does NOT notify on

- **`awaiting_gate`** — every normal gate would fire. Opt in via `FORGE_NOTIFY_ON=complete,failed,blocked_by_red,awaiting_gate` if you want it.
- **Individual task failures inside a still-active run.** Only the run-level terminal transition fires.
- **Non-forge work.** A long Claude Code session that doesn't touch forge gets no notification from here. (Use a Claude Code `Stop` hook for that — orthogonal concern.)
- **Container crashes, idle-timeouts.** These flip the task to `failed` but don't terminate the run, so no SMS. If the run subsequently gets abandoned, that triggers a `failed` SMS.

## Troubleshooting

### `forge notify subscribe` fails with "doesn't look like E.164"

The number must be `+<country code><number>`, digits only. No spaces, no dashes, no parentheses. Example: `+15551234567`, not `+1 (555) 123-4567`.

### `forge notify subscribe` succeeds but no SMS arrives at the destination

- **Wrong number format that passes the local check** but Twilio rejects internally. Check Twilio Console → Monitor → Logs → Messaging for the message status + error code.
- **Twilio trial account.** Trial accounts can only send to verified numbers. Check Twilio Console → Phone Numbers → Verified Caller IDs.
- **A2P 10DLC campaign not yet approved.** US destinations require a registered campaign. Pre-approval, Twilio returns success at the API level but carrier filtering drops the message (status `failed` / `undelivered` with code 30034 or similar).

### `forge notify confirm` says "no pending subscription"

The subscribe flow either wasn't run, or the pending state was cleared (timeout, or `unsubscribe` of a different number in between). Re-run `forge notify subscribe <number>`.

### `forge notify confirm` says "code expired"

Codes are valid for 10 minutes. Re-run `forge notify subscribe <number>` to get a new one.

### `forge notify test` returns "✓ SMS sent" but no SMS arrives

Same as the subscribe-but-no-SMS-arrives section above. The Twilio API accepting the call and the recipient actually getting the SMS are different things — check Twilio Console → Monitor → Logs → Messaging.

### `forge notify test` returns "✗ SMS failed: HTTP 401"

Bad credentials. Re-check `TWILIO_ACCOUNT_SID` (starts with `AC`) and `TWILIO_AUTH_TOKEN` in `notify.env`. If you recently rotated the token, update the file and re-run.

### `forge notify test` returns "✗ SMS failed: HTTP 400: ... (code 21211)"

Invalid `To` number. Check `TWILIO_TO` (or the `--to` override) is E.164.

### `forge notify test` returns "✗ SMS failed: HTTP 400: ... (code 21608)"

`TWILIO_FROM` isn't a Twilio number on your account, or you haven't bought it yet. Buy a number in the Twilio console first.

### `forge notify test` returns "✗ SMS failed: network: ..."

Local network or DNS issue. Confirm `curl https://api.twilio.com/` from the same shell works.

### A real workflow completed but no SMS came

1. Run `forge notify test` first — confirms the path works at all.
2. Check `forge notify status` — confirms `FORGE_NOTIFY=twilio` is loaded and a subscription is active.
3. Check `FORGE_NOTIFY_ON` if you set it explicitly — the run's terminal state might not be in your filter set.
4. Look at stderr from the `forge next` invocation that completed the run — notification failures print there.

### How to silence notifications for one run without unsubscribing

```bash
FORGE_NOTIFY= forge new feature "..." --brief "..."
```

Setting `FORGE_NOTIFY=` (empty) for the one command keeps your shell-wide config intact.

## What's coming next (and what isn't)

- **Other providers** (Pushover, Slack webhook) — not on the roadmap. If one becomes useful, it gets its own doc and a value for `FORGE_NOTIFY`.
- **Retry on SMS failure** — explicitly not. Log + continue. SMS isn't transactionally important.
- **Rate limiting** — Twilio handles this account-side. Forge doesn't add its own.
- **Custom message templates** — not yet. The current format is fixed. If multiple users start asking for different formats, we'll add a config knob.
- **HELP keyword auto-response on the forge side** — not needed; Twilio handles HELP carrier-side for 10DLC numbers.
