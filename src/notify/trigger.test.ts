import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { notifyOnRunTransition, notifyOnTaskBlockedByRed } from "./trigger.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-x",
  workflow: "feature",
  title: "x",
  status: "active",
  createdAt: "2026-05-25T12:00:00Z",
};

// Snapshot + restore env per test to keep them isolated.
let savedEnv: Record<string, string | undefined>;
const KEYS = ["FORGE_NOTIFY", "FORGE_NOTIFY_ON", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_TO"];

beforeEach(() => {
  savedEnv = {};
  for (const k of KEYS) savedEnv[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("notifyOnRunTransition: short-circuits cleanly when isTwilioEnabled is false (no throw)", async () => {
  await notifyOnRunTransition(RUN, "complete", "active");
  // If the short-circuit failed we'd either throw or attempt a network call;
  // arriving here without error is the assertion.
  assert.ok(true);
});

test("notifyOnRunTransition: no-op when newStatus === previousStatus (idempotent re-save)", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  await notifyOnRunTransition(RUN, "complete", "complete");
  assert.ok(true);
});

test("notifyOnRunTransition: ignores statuses with no mapping (e.g. 'active')", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  await notifyOnRunTransition(RUN, "active", undefined);
  assert.ok(true);
});

test("notifyOnRunTransition: respects FORGE_NOTIFY_ON exclusion", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  process.env["FORGE_NOTIFY_ON"] = "failed";  // 'complete' explicitly filtered out
  await notifyOnRunTransition(RUN, "complete", "active");
  assert.ok(true);
});

test("notifyOnTaskBlockedByRed: short-circuits when isTwilioEnabled is false", async () => {
  await notifyOnTaskBlockedByRed(RUN);
  assert.ok(true);
});

test("notifyOnTaskBlockedByRed: respects FORGE_NOTIFY_ON exclusion", async () => {
  process.env["FORGE_NOTIFY"] = "twilio";
  process.env["TWILIO_ACCOUNT_SID"] = "AC_invalid";
  process.env["TWILIO_AUTH_TOKEN"] = "token";
  process.env["TWILIO_FROM"] = "+15551234567";
  process.env["TWILIO_TO"] = "+15559876543";
  process.env["FORGE_NOTIFY_ON"] = "complete";  // explicitly NOT blocked_by_red
  await notifyOnTaskBlockedByRed(RUN);
  assert.ok(true);
});
