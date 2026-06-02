import type { Command } from "commander";
import { hostname } from "node:os";
import { isTwilioEnabled, notifyTwilio } from "../../notify/twilio.js";
import { isNtfyEnabled, notifyNtfy } from "../../notify/ntfy.js";
import {
  loadState,
  saveState,
  appendConsentLog,
  updateNotifyEnvTo,
  generateConfirmationCode,
  looksLikeE164,
  PATHS,
} from "../../notify/consent.js";
import { subscribeRequestBody, subscribeConfirmedBody, unsubscribeBody } from "../../notify/format.js";
import { emitMilestone, MILESTONE_KINDS } from "../../notify/milestone.js";

const CONFIRMATION_WINDOW_MIN = 10;

export function registerNotify(program: Command): void {
  const notify = program
    .command("notify")
    .description("Notification surface (SMS via Twilio, push via ntfy; opt-in via FORGE_NOTIFY=twilio|ntfy|twilio,ntfy)");

  // ----- test -----
  notify
    .command("test")
    .description("Send a test notification via all configured providers.")
    .option("--to <number>", "override TWILIO_TO for this one send (E.164 format, e.g. +15551234567)")
    .action(async (opts: { to?: string }) => {
      const twilioOn = isTwilioEnabled();
      const ntfyOn = isNtfyEnabled();
      if (!twilioOn && !ntfyOn) {
        console.error(
          "forge notify: not configured. Set FORGE_NOTIFY=twilio|ntfy|twilio,ntfy in ~/.forge/notify.env. See docs/how-to-set-up-notifications.md."
        );
        process.exitCode = 1;
        return;
      }
      const body = `forge: test message from ${hostname()}`;
      let anyFailed = false;
      if (twilioOn) {
        const result = await notifyTwilio(body, opts.to);
        if (result.ok) {
          console.log(`✓ SMS sent (sid: ${result.sid})`);
        } else {
          console.error(`✗ SMS failed: ${result.error}`);
          anyFailed = true;
        }
      }
      if (ntfyOn) {
        const result = await notifyNtfy(body, "forge: test");
        if (result.ok) {
          console.log(`✓ ntfy sent`);
        } else {
          console.error(`✗ ntfy failed: ${result.error}`);
          anyFailed = true;
        }
      }
      if (anyFailed) process.exitCode = 1;
    });

  // ----- milestone (#202/#203) -----
  notify
    .command("milestone")
    .description("Declare an orchestrator checkpoint. Always recorded as an orchestrator.milestone event; forge applies policy + dedupe to decide whether to push.")
    .requiredOption("--run <id>", "run id this milestone belongs to")
    .requiredOption("--kind <kind>", `milestone kind: ${MILESTONE_KINDS.join(" | ")}`)
    .requiredOption("--title <title>", "short one-line title")
    .option("--body <body>", "optional longer body (defaults to the title)")
    .option("--dedupe-key <key>", "suppress a duplicate push for this key within the run")
    .option("--json", "emit JSON instead of a human line")
    .action(async (opts: { run: string; kind: string; title: string; body?: string; dedupeKey?: string; json?: boolean }) => {
      try {
        const res = await emitMilestone({
          runId: opts.run,
          kind: opts.kind,
          title: opts.title,
          ...(opts.body ? { body: opts.body } : {}),
          ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify({ recorded: true, kind: opts.kind, dispatched: res.dispatched, reason: res.decision.reason, importance: res.importance, ...(res.docsImpactWarning ? { docsImpactWarning: res.docsImpactWarning } : {}) }, null, 2));
          return;
        }
        console.log(`✓ recorded orchestrator.milestone [${opts.kind}]`);
        console.log(`  ${res.dispatched ? "→ pushed" : "→ no push"}: ${res.decision.reason}`);
        if (res.decision.send && !res.dispatched) {
          console.log(`  (policy said send, but no provider configured — set FORGE_NOTIFY. See docs/how-to-set-up-notifications.md)`);
        }
        if (res.docsImpactWarning) {
          console.warn(`  ⚠ ${res.docsImpactWarning}`);
        }
      } catch (e) {
        console.error(`forge notify milestone: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  // ----- subscribe -----
  notify
    .command("subscribe")
    .argument("<number>", "destination phone number in E.164 format, e.g. +15551234567")
    .description("Start a double opt-in subscription: sends a confirmation SMS with a code; complete via `forge notify confirm <code>`.")
    .action(async (number: string) => {
      if (!looksLikeE164(number)) {
        console.error(`forge notify: '${number}' doesn't look like E.164 (expected +<country><number>, digits only).`);
        process.exitCode = 1;
        return;
      }
      // We need the Twilio creds to send the confirmation. TWILIO_TO doesn't
      // matter for the subscribe SMS (we use --to override on notifyTwilio),
      // so check FROM/SID/TOKEN/FORGE_NOTIFY by sending without relying on
      // isTwilioEnabled (which requires TWILIO_TO too).
      const acct = process.env["TWILIO_ACCOUNT_SID"];
      const token = process.env["TWILIO_AUTH_TOKEN"];
      const from = process.env["TWILIO_FROM"];
      const master = process.env["FORGE_NOTIFY"];
      if (master !== "twilio" || !acct || !token || !from) {
        console.error(
          "forge notify: subscribe requires FORGE_NOTIFY=twilio + TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM. See docs/how-to-set-up-notifications.md."
        );
        process.exitCode = 1;
        return;
      }

      const state = loadState();
      if (state.currentSubscription && state.currentSubscription.to !== number) {
        console.error(
          `forge notify: a confirmed subscription already exists for ${state.currentSubscription.to}. Run 'forge notify unsubscribe' first.`
        );
        process.exitCode = 1;
        return;
      }
      if (state.currentSubscription && state.currentSubscription.to === number) {
        console.error(`forge notify: ${number} is already subscribed.`);
        process.exitCode = 1;
        return;
      }
      // If a different pending confirmation exists, cancel it.
      if (state.pendingConfirmation && state.pendingConfirmation.to !== number) {
        appendConsentLog({
          event: "subscribe-cancelled",
          to: state.pendingConfirmation.to,
          at: new Date().toISOString(),
          note: "superseded by new subscribe to " + number,
        });
      }

      const code = generateConfirmationCode();
      const now = new Date();
      const expires = new Date(now.getTime() + CONFIRMATION_WINDOW_MIN * 60_000);
      const pending = {
        to: number,
        code,
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
      };

      // Persist pending state + audit BEFORE the SMS so a crash-during-send
      // leaves an audit breadcrumb. On SMS failure we roll back.
      saveState({ ...state, pendingConfirmation: pending });
      appendConsentLog({ event: "subscribe-requested", to: number, at: now.toISOString() });

      const body = subscribeRequestBody(code);
      const result = await notifyTwilio(body, number);
      if (!result.ok) {
        // Roll back the pending state — the user got no SMS, so the flow can't proceed.
        saveState(state);
        console.error(`✗ SMS failed: ${result.error}`);
        console.error(`  Pending subscription cleared. Re-run 'forge notify subscribe ${number}' to retry.`);
        process.exitCode = 1;
        return;
      }

      console.log(`✓ confirmation code sent to ${number} (sid: ${result.sid})`);
      console.log(`  Complete with: forge notify confirm <code-from-sms>`);
      console.log(`  Code expires in ${CONFIRMATION_WINDOW_MIN} minutes.`);
    });

  // ----- confirm -----
  notify
    .command("confirm")
    .argument("<code>", "the 4-digit code from the subscribe confirmation SMS")
    .description("Complete a pending subscription using the code received via SMS.")
    .action(async (code: string) => {
      const state = loadState();
      const pending = state.pendingConfirmation;
      if (!pending) {
        console.error("forge notify: no pending subscription. Run 'forge notify subscribe <number>' first.");
        process.exitCode = 1;
        return;
      }
      const now = new Date();
      if (new Date(pending.expiresAt).getTime() < now.getTime()) {
        // Expired: clear the pending entry so the user knows to restart.
        saveState({ ...state, pendingConfirmation: null });
        console.error(`forge notify: code expired. Run 'forge notify subscribe ${pending.to}' again.`);
        process.exitCode = 1;
        return;
      }
      if (code !== pending.code) {
        console.error("forge notify: invalid code. Try again (no lockout).");
        process.exitCode = 1;
        return;
      }

      // Confirmed. Write TWILIO_TO to notify.env, log, update state, send final SMS.
      updateNotifyEnvTo(pending.to);
      process.env["TWILIO_TO"] = pending.to;  // current process sees it for the final SMS
      const confirmedAt = now.toISOString();
      saveState({
        currentSubscription: { to: pending.to, subscribedAt: confirmedAt },
        pendingConfirmation: null,
      });
      appendConsentLog({
        event: "subscribe-confirmed",
        to: pending.to,
        at: confirmedAt,
        method: "cli-double-opt-in",
      });

      const body = subscribeConfirmedBody();
      const result = await notifyTwilio(body, pending.to);
      if (!result.ok) {
        // State is already written — the subscription IS confirmed even if
        // the final ack SMS didn't deliver. Surface the error but don't undo.
        console.error(`✓ subscribed (TWILIO_TO=${pending.to} written to notify.env)`);
        console.error(`  ✗ final ack SMS failed: ${result.error}`);
        console.error(`  The subscription is active — future workflow notifications will send normally.`);
        return;
      }
      console.log(`✓ subscribed (TWILIO_TO=${pending.to} written to notify.env)`);
      console.log(`  Confirmation SMS sent (sid: ${result.sid}).`);
    });

  // ----- unsubscribe -----
  notify
    .command("unsubscribe")
    .description("Clear the active subscription. Removes TWILIO_TO from notify.env; sends a goodbye SMS unless --silent.")
    .option("--silent", "skip the goodbye SMS")
    .action(async (opts: { silent?: boolean }) => {
      const state = loadState();
      const current = state.currentSubscription;
      // Fall back to TWILIO_TO env if state file is empty (legacy: user set notify.env manually).
      const number = current?.to ?? process.env["TWILIO_TO"] ?? null;
      if (!number) {
        console.log("forge notify: no active subscription. Nothing to do.");
        return;
      }

      const at = new Date().toISOString();
      appendConsentLog({ event: "unsubscribe", to: number, at });
      updateNotifyEnvTo(null);
      saveState({ ...state, currentSubscription: null });

      if (opts.silent) {
        console.log(`✓ unsubscribed ${number} (silent — no SMS sent).`);
        return;
      }
      const result = await notifyTwilio(unsubscribeBody(), number);
      if (!result.ok) {
        console.log(`✓ unsubscribed ${number} (notify.env cleared).`);
        console.error(`  ✗ goodbye SMS failed: ${result.error}`);
        return;
      }
      console.log(`✓ unsubscribed ${number} (sid: ${result.sid}).`);
    });

  // ----- status -----
  notify
    .command("status")
    .description("Show notification subscription state + recent consent events.")
    .action(() => {
      const state = loadState();
      const master = process.env["FORGE_NOTIFY"] ?? "(unset)";
      const twilioReady = isTwilioEnabled();
      const ntfyReady = isNtfyEnabled();

      console.log(`FORGE_NOTIFY: ${master}`);
      console.log(`Twilio ready: ${twilioReady ? "yes" : "no"}`);
      console.log(`ntfy ready:   ${ntfyReady ? "yes" : "no"}${ntfyReady ? ` (${process.env["NTFY_URL"]})` : ""}`);
      console.log("");

      if (state.currentSubscription) {
        console.log(`Active subscription: ${state.currentSubscription.to} (since ${state.currentSubscription.subscribedAt})`);
      } else if (process.env["TWILIO_TO"]) {
        console.log(`Active subscription: (none in state.json — TWILIO_TO=${process.env["TWILIO_TO"]} set manually in env or notify.env)`);
        console.log(`  For Twilio compliance, run: forge notify subscribe ${process.env["TWILIO_TO"]}`);
      } else {
        console.log("Active subscription: none");
      }

      if (state.pendingConfirmation) {
        const remainingMs = new Date(state.pendingConfirmation.expiresAt).getTime() - Date.now();
        const remainingMin = Math.max(0, Math.floor(remainingMs / 60_000));
        console.log(`Pending confirmation: ${state.pendingConfirmation.to} (${remainingMin} min remaining)`);
      } else {
        console.log("Pending confirmation: none");
      }

      console.log("");
      console.log(`Consent log: ${PATHS.log}`);
      console.log("(tail -10 the file to see recent events; the log is append-only — Twilio may ask for it.)");
    });
}
