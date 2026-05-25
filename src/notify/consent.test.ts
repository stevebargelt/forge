import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadState,
  saveState,
  appendConsentLog,
  updateNotifyEnvTo,
  generateConfirmationCode,
  looksLikeE164,
  type NotifyState,
} from "./consent.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-consent-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ----- loadState -----

test("loadState: returns defaults when file missing", () => {
  const s = loadState(join(dir, "state.json"));
  assert.deepEqual(s, { currentSubscription: null, pendingConfirmation: null });
});

test("loadState: returns defaults when file is corrupt JSON", () => {
  const path = join(dir, "state.json");
  writeFileSync(path, "{ not json");
  const s = loadState(path);
  assert.deepEqual(s, { currentSubscription: null, pendingConfirmation: null });
});

test("loadState / saveState: round-trip preserves currentSubscription", () => {
  const path = join(dir, "state.json");
  const original: NotifyState = {
    currentSubscription: { to: "+15551234567", subscribedAt: "2026-05-25T17:00:00Z" },
    pendingConfirmation: null,
  };
  saveState(original, path);
  assert.deepEqual(loadState(path), original);
});

test("loadState / saveState: round-trip preserves pendingConfirmation", () => {
  const path = join(dir, "state.json");
  const original: NotifyState = {
    currentSubscription: null,
    pendingConfirmation: {
      to: "+15551234567",
      code: "4827",
      createdAt: "2026-05-25T17:00:00Z",
      expiresAt: "2026-05-25T17:10:00Z",
    },
  };
  saveState(original, path);
  assert.deepEqual(loadState(path), original);
});

test("saveState: atomic write (no .tmp left behind on success)", () => {
  const path = join(dir, "state.json");
  saveState({ currentSubscription: null, pendingConfirmation: null }, path);
  assert.ok(existsSync(path));
  assert.ok(!existsSync(`${path}.tmp`));
});

// ----- appendConsentLog -----

test("appendConsentLog: appends a JSON line; existing lines preserved", () => {
  const path = join(dir, "consent.log");
  appendConsentLog({ event: "subscribe-requested", to: "+15551234567", at: "2026-05-25T17:00:00Z" }, path);
  appendConsentLog({ event: "subscribe-confirmed", to: "+15551234567", at: "2026-05-25T17:01:00Z", method: "cli-double-opt-in" }, path);

  const content = readFileSync(path, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).event, "subscribe-requested");
  assert.equal(JSON.parse(lines[1]!).event, "subscribe-confirmed");
});

test("appendConsentLog: creates parent dir if missing", () => {
  const path = join(dir, "nested", "deeper", "consent.log");
  appendConsentLog({ event: "unsubscribe", to: "+15551234567", at: "2026-05-25T17:00:00Z" }, path);
  assert.ok(existsSync(path));
});

// ----- updateNotifyEnvTo -----

test("updateNotifyEnvTo: writes TWILIO_TO when file missing", () => {
  const path = join(dir, "notify.env");
  updateNotifyEnvTo("+15551234567", path);
  assert.equal(readFileSync(path, "utf8"), "TWILIO_TO=+15551234567\n");
});

test("updateNotifyEnvTo: updates existing TWILIO_TO line in place; preserves other lines", () => {
  const path = join(dir, "notify.env");
  writeFileSync(path, [
    "# Notification config",
    "FORGE_NOTIFY=twilio",
    "TWILIO_ACCOUNT_SID=AC123",
    "TWILIO_AUTH_TOKEN=secret",
    "TWILIO_FROM=+15550000000",
    "TWILIO_TO=+15559999999",
    "",
  ].join("\n"));

  updateNotifyEnvTo("+15551234567", path);

  const out = readFileSync(path, "utf8");
  assert.match(out, /^# Notification config$/m);
  assert.match(out, /^FORGE_NOTIFY=twilio$/m);
  assert.match(out, /^TWILIO_ACCOUNT_SID=AC123$/m);
  assert.match(out, /^TWILIO_AUTH_TOKEN=secret$/m);
  assert.match(out, /^TWILIO_FROM=\+15550000000$/m);
  assert.match(out, /^TWILIO_TO=\+15551234567$/m);
  // Only one TWILIO_TO line.
  assert.equal(out.match(/^TWILIO_TO=/gm)?.length, 1);
});

test("updateNotifyEnvTo: removes TWILIO_TO when number is null; preserves other lines", () => {
  const path = join(dir, "notify.env");
  writeFileSync(path, "FORGE_NOTIFY=twilio\nTWILIO_TO=+15559999999\nTWILIO_FROM=+15550000000\n");

  updateNotifyEnvTo(null, path);

  const out = readFileSync(path, "utf8");
  assert.match(out, /^FORGE_NOTIFY=twilio$/m);
  assert.match(out, /^TWILIO_FROM=\+15550000000$/m);
  assert.ok(!/TWILIO_TO/.test(out));
});

test("updateNotifyEnvTo: removing absent TWILIO_TO is a no-op", () => {
  const path = join(dir, "notify.env");
  writeFileSync(path, "FORGE_NOTIFY=twilio\nTWILIO_FROM=+15550000000\n");
  const before = readFileSync(path, "utf8");
  updateNotifyEnvTo(null, path);
  assert.equal(readFileSync(path, "utf8"), before);
});

// ----- generateConfirmationCode -----

test("generateConfirmationCode: returns a 4-digit numeric string without leading zero", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateConfirmationCode();
    assert.match(c, /^[1-9]\d{3}$/);
  }
});

// ----- looksLikeE164 -----

test("looksLikeE164: accepts well-formed E.164", () => {
  assert.equal(looksLikeE164("+15551234567"), true);
  assert.equal(looksLikeE164("+447911123456"), true);
});

test("looksLikeE164: rejects missing + prefix, leading zero in country code, or non-digit chars", () => {
  assert.equal(looksLikeE164("15551234567"), false);
  assert.equal(looksLikeE164("+05551234567"), false);
  assert.equal(looksLikeE164("+1 555 123 4567"), false);
  assert.equal(looksLikeE164("+1-555-123-4567"), false);
  assert.equal(looksLikeE164(""), false);
});
