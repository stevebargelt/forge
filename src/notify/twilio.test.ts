import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isTwilioEnabled, notifyTwilio } from "./twilio.js";

// Snapshot + restore env so individual tests don't leak into each other.
let savedEnv: Record<string, string | undefined>;
const KEYS = ["FORGE_NOTIFY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_TO"];

beforeEach(() => {
  savedEnv = {};
  for (const k of KEYS) savedEnv[k] = process.env[k];
  // Start each test from a known-empty baseline.
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("isTwilioEnabled: returns false when FORGE_NOTIFY is unset", () => {
  process.env["TWILIO_ACCOUNT_SID"] = "AC123";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  assert.equal(isTwilioEnabled(), false);
});

test("isTwilioEnabled: returns false when FORGE_NOTIFY is set to a different provider", () => {
  process.env["FORGE_NOTIFY"] = "pushover";
  process.env["TWILIO_ACCOUNT_SID"] = "AC123";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  assert.equal(isTwilioEnabled(), false);
});

test("isTwilioEnabled: returns false when any required TWILIO_* env var is missing", () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC123";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  // TWILIO_TO missing
  assert.equal(isTwilioEnabled(), false);
});

test("isTwilioEnabled: returns false when an env var is set to empty string", () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  assert.equal(isTwilioEnabled(), false);
});

test("isTwilioEnabled: returns true when FORGE_NOTIFY=twilio and all four TWILIO_* are present", () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC123";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  assert.equal(isTwilioEnabled(), true);
});

test("notifyTwilio: returns ok:false when isTwilioEnabled is false (defense in depth — no network call)", async () => {
  // FORGE_NOTIFY unset; should refuse before any network attempt.
  const r = await notifyTwilio("test");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /FORGE_NOTIFY|TWILIO_/);
});
