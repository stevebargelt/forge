---
id: FG-145
type: story
status: done
title: "Twilio SMS double opt-in flow: subscribe/confirm/unsubscribe + consent log"
---

**Closed:** 2026-05-25. Commit `4a6ebc6`.

Filed 2026-05-25. Follow-on to #142 (Twilio SMS notifications shipped). Adds an explicit consent flow so the campaign-approval story is defensible.

**Why filed.** Twilio's A2P 10DLC campaign approval requires proof of recipient opt-in, even for one-person personal use. The current setup (edit notify.env with your TWILIO_TO and you're done) works mechanically but doesn't generate an audit trail. Shape 3 from the design conversation (CLI subscribe/confirm/unsubscribe) was preferred over self-attestation because it's safer: every subscription has a timestamped consent record + the recipient actively confirmed via SMS code.

**Flow.**
1. `forge notify subscribe +15551234567` — initiates. Forge generates a 4-digit code, stores pending state in ~/.forge/notify-state.json, sends an SMS: "forge: confirm subscription with: forge notify confirm 4827. Code expires in 10 minutes. Reply STOP to opt out."
2. `forge notify confirm <code>` — completes. Validates code, writes TWILIO_TO to notify.env, appends a consent event to ~/.forge/notify-consent.log (append-only JSON-lines audit). Sends a final SMS: "forge: subscribed. You'll be notified on workflow completion. Reply STOP to opt out, HELP for help."
3. `forge notify unsubscribe` — clears. Sends "forge: unsubscribed." to current TWILIO_TO, removes from notify.env, logs event.
4. `forge notify status` — shows current subscription, pending confirmation (if any), recent consent events.

**Consent log shape (append-only JSON-lines at ~/.forge/notify-consent.log):**
```
{"event":"subscribe-requested","to":"+15551234567","at":"2026-05-25T17:25:00Z"}
{"event":"subscribe-confirmed","to":"+15551234567","at":"2026-05-25T17:26:30Z","method":"cli-double-opt-in"}
{"event":"unsubscribe","to":"+15551234567","at":"2026-06-01T09:00:00Z"}
```

Append-only so the audit trail can't be silently rewritten. Twilio support can be shown the file directly if they ever ask.

**Storage layout:**
- ~/.forge/notify.env — TWILIO_* env vars (existing). subscribe/unsubscribe write TWILIO_TO here on confirm/unsub.
- ~/.forge/notify-state.json — current subscription + pending confirmation. Mutable, single JSON object.
- ~/.forge/notify-consent.log — JSON-lines append-only audit. Never rewritten, never truncated.

**State transitions:**
- subscribe to a number that's already subscribed → refuse, tell user to unsubscribe first
- subscribe while a different pending confirmation exists → cancel the pending one, start the new flow, log "subscribe-cancelled" for the old
- confirm with wrong code → "invalid code" error, no state change, allow retry within window
- confirm after expiry → "code expired, run subscribe again", no state change
- unsubscribe when not currently subscribed → no-op with informational message

**Out of scope.**
- HELP keyword auto-response (Twilio handles HELP carrier-side for 10DLC).
- Multiple concurrent subscribers (one TWILIO_TO at a time; the env var model is single-recipient).
- Subscription transfer (delete + re-subscribe instead).
- Web UI for subscription management.
- Encryption of the consent log (it's local-machine personal data; filesystem permissions are the boundary).

**Sizing.** Medium. ~150 LoC for consent.ts + state machine + the four subcommands, plus tests for each state transition.

**Caught:** 2026-05-25 conversation about Twilio campaign-approval compliance.