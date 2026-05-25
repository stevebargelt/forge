# forge SMS notification terms

This page is the canonical consent / privacy terms for forge's SMS notification feature. Suitable for linking from a Twilio A2P 10DLC campaign registration as the "consent mechanism URL" / "privacy policy URL."

## Who sends

`forge` is a personal CLI tool that orchestrates multi-agent AI workflows on a single user's machine. It is not a service operated for others. The SMS notification feature is opt-in and off by default. Source: [github.com/stevebargelt/forge](https://github.com/stevebargelt/forge).

## Who receives

Only phone numbers that the forge user has explicitly subscribed via the `forge notify subscribe` double opt-in flow. Subscription requires:

1. The user runs `forge notify subscribe +1XXXXXXXXXX` from the CLI.
2. The destination number receives an SMS with a 4-digit confirmation code.
3. The recipient (or the user, when self-subscribing) runs `forge notify confirm <code>` to complete.

A timestamped record of each subscription, including the destination number and the confirmation event, is appended to a local audit log at `~/.forge/notify-consent.log`. The log is append-only and never edited.

## What triggers messages

forge sends an SMS only when a workflow's run state transitions to one of:
- `complete` — workflow finished successfully
- `failed` — workflow was abandoned
- `blocked_by_red` — a task was blocked by an adversarial review verdict; the user's input is needed

Default behavior is one message per terminal transition. There are no marketing messages, no recurring digests, no scheduled sends.

Sample message:
```
forge: run-add-login-7c2a91 [complete] feature "add login" — 14m23s
```

Message frequency is bounded by how many workflows the user runs — typically a handful per day at most, often zero on a given day.

## Opt out

Two paths, both immediate:

1. **STOP keyword.** Reply `STOP` to the From number. Twilio carrier-side blocks all future sends to the (From, To) pair automatically. forge cannot bypass this.
2. **CLI:** `forge notify unsubscribe` clears the local subscription and sends a final confirmation SMS (unless `--silent`).

`HELP` keyword is handled by Twilio carrier-side and returns standard guidance.

## Data handling

- Phone numbers, subscription timestamps, and consent events are stored exclusively in local files under `~/.forge/` on the user's machine. No cloud sync. No analytics.
- The Twilio API is the only third party that sees the destination number and message bodies (Twilio is the SMS transit). See [Twilio's privacy policy](https://www.twilio.com/legal/privacy).
- Auth tokens for Twilio are stored in `~/.forge/notify.env` on the user's machine. They are never logged, transmitted to any party other than Twilio at message-send time, or included in error messages.

## Contact

For questions about this notification feature: open an issue at [github.com/stevebargelt/forge/issues](https://github.com/stevebargelt/forge/issues), or contact `steve@bargelt.com`.

## Last updated

2026-05-25
