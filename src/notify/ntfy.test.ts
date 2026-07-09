import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isNtfyEnabled, notifyNtfy } from "./ntfy.js";

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

// FG-494: fetch header values are ByteStrings (Latin-1) — a title containing a
// character outside 0x00-0xFF (em-dash, arrows, checkmarks, emoji) threw
// "Cannot convert argument to a ByteString" at request construction. The POST
// body has no such constraint (string bodies are UTF-8-encoded), so only
// header-bound fields were affected.
describe("notifyNtfy — FG-494 Unicode title handling", () => {
  const EM_DASH = "Milestone — shipped";
  const ARROW = "Step 1 → Step 2";
  const CHECKMARK = "Tests ✓ passing";
  const EMOJI = "🚀 Launched";
  const ASCII_ONLY = "Milestone shipped";

  let originalFetch: typeof fetch;
  let capturedHeaders: Record<string, string> | undefined;
  let capturedBody: unknown;

  beforeEach(() => {
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.com/forge";
    originalFetch = globalThis.fetch;
    capturedHeaders = undefined;
    capturedBody = undefined;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetchOk(): void {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as typeof fetch;
  }

  function decodeRfc2047(encoded: string): string {
    const match = encoded.match(/^=\?UTF-8\?B\?(.+)\?=$/);
    assert.ok(match, `expected RFC 2047 encoded-word, got: ${encoded}`);
    return Buffer.from(match![1]!, "base64").toString("utf8");
  }

  for (const [label, title] of [
    ["em-dash", EM_DASH],
    ["arrow", ARROW],
    ["checkmark", CHECKMARK],
    ["emoji", EMOJI],
  ] as const) {
    test(`title with ${label} does not throw, encodes as RFC 2047, roundtrips`, async () => {
      stubFetchOk();
      const result = await notifyNtfy("plain body", title);
      assert.equal(result.ok, true);
      const header = capturedHeaders?.["Title"];
      assert.ok(header, "Title header was set");
      assert.equal(decodeRfc2047(header!), title);
    });
  }

  for (const [label, chars] of [
    ["em-dash", EM_DASH],
    ["arrow", ARROW],
    ["checkmark", CHECKMARK],
    ["emoji", EMOJI],
  ] as const) {
    test(`body with ${label} passes through unmodified`, async () => {
      stubFetchOk();
      const result = await notifyNtfy(chars, ASCII_ONLY);
      assert.equal(result.ok, true);
      assert.equal(capturedBody, chars);
    });
  }

  test("pure-ASCII title is byte-identical, no RFC 2047 wrapper applied", async () => {
    stubFetchOk();
    const result = await notifyNtfy("plain body", ASCII_ONLY);
    assert.equal(result.ok, true);
    assert.equal(capturedHeaders?.["Title"], ASCII_ONLY);
  });
});
