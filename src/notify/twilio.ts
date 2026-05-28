// Twilio SMS transport. Single-provider implementation — if a second provider
// shows up later, refactor to a provider abstraction at that time.
//
// Contract:
//   - notifyTwilio never throws. Errors are returned as { ok: false, error }.
//     Notification failures must NOT crash a forge run.
//   - Env vars are read at call time (not cached). Lets users rotate creds
//     without restarting forge.
//   - Auth token is never logged or returned. Only Twilio's response sid /
//     error message bubble up.

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export type TwilioResult =
  | { ok: true; sid: string }
  | { ok: false; error: string };

// All four required for the Twilio path. FORGE_NOTIFY is the master switch.
const REQUIRED_VARS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_TO"] as const;

export function isTwilioEnabled(): boolean {
  const providers = (process.env["FORGE_NOTIFY"] ?? "").split(",").map(s => s.trim());
  if (!providers.includes("twilio")) return false;
  for (const k of REQUIRED_VARS) {
    const v = process.env[k];
    if (!v || v.length === 0) return false;
  }
  return true;
}

export async function notifyTwilio(body: string, toOverride?: string): Promise<TwilioResult> {
  if (!isTwilioEnabled()) {
    return { ok: false, error: "FORGE_NOTIFY is not 'twilio' or required TWILIO_* env vars are missing" };
  }
  const sid = process.env["TWILIO_ACCOUNT_SID"]!;
  const token = process.env["TWILIO_AUTH_TOKEN"]!;
  const from = process.env["TWILIO_FROM"]!;
  const to = toOverride ?? process.env["TWILIO_TO"]!;

  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      // Twilio returns JSON error bodies; extract just the message if we can.
      let msg = `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text) as { message?: string; code?: number };
        if (json.message) msg = `${msg}: ${json.message}${json.code ? ` (code ${json.code})` : ""}`;
      } catch {
        if (text.length > 0 && text.length < 200) msg = `${msg}: ${text}`;
      }
      return { ok: false, error: msg };
    }
    try {
      const json = JSON.parse(text) as { sid?: string };
      if (json.sid) return { ok: true, sid: json.sid };
      return { ok: false, error: "Twilio returned 2xx but no message sid in body" };
    } catch {
      return { ok: false, error: "Twilio returned 2xx but body wasn't JSON" };
    }
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
}
