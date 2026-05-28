import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isNtfyEnabled } from "./ntfy.js";

const KEYS = ["FORGE_NOTIFY", "NTFY_URL", "NTFY_TOKEN"];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

describe("isNtfyEnabled", () => {
  test("returns false when FORGE_NOTIFY is unset", () => {
    assert.equal(isNtfyEnabled(), false);
  });

  test("returns false when FORGE_NOTIFY does not include ntfy", () => {
    process.env["FORGE_NOTIFY"] = "twilio";
    process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
    assert.equal(isNtfyEnabled(), false);
  });

  test("returns false when NTFY_URL is missing", () => {
    process.env["FORGE_NOTIFY"] = "ntfy";
    assert.equal(isNtfyEnabled(), false);
  });

  test("returns true when FORGE_NOTIFY=ntfy and NTFY_URL is set", () => {
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
    assert.equal(isNtfyEnabled(), true);
  });

  test("returns true when FORGE_NOTIFY=twilio,ntfy (comma-separated)", () => {
    process.env["FORGE_NOTIFY"] = "twilio,ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
    assert.equal(isNtfyEnabled(), true);
  });
});
