import type { Command } from "commander";
import { hostname } from "node:os";
import { isTwilioEnabled, notifyTwilio } from "../../notify/twilio.js";

export function registerNotify(program: Command): void {
  const notify = program
    .command("notify")
    .description("Notification surface (SMS via Twilio; opt-in via FORGE_NOTIFY=twilio)");

  notify
    .command("test")
    .description("Send a test SMS using the current env config. Verifies the path without waiting for a real workflow.")
    .option("--to <number>", "override TWILIO_TO for this one send (E.164 format, e.g. +15551234567)")
    .action(async (opts: { to?: string }) => {
      if (!isTwilioEnabled()) {
        console.error(
          "forge notify: not configured. Set FORGE_NOTIFY=twilio and all four TWILIO_* env vars (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_TO). See docs/how-to-set-up-notifications.md."
        );
        process.exitCode = 1;
        return;
      }
      const body = `forge: test message from ${hostname()}`;
      const result = await notifyTwilio(body, opts.to);
      if (result.ok) {
        console.log(`✓ SMS sent (sid: ${result.sid})`);
      } else {
        console.error(`✗ SMS failed: ${result.error}`);
        process.exitCode = 1;
      }
    });
}
