import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNotifyEnv } from "./load-env.js";

let dir: string;
let envPath: string;
const TEST_KEYS = ["TEST_FORGE_NOTIFY", "TEST_TWILIO_ACCOUNT_SID", "TEST_TWILIO_AUTH_TOKEN", "TEST_TWILIO_TO"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-loadenv-test-"));
  envPath = join(dir, "notify.env");
  savedEnv = {};
  for (const k of TEST_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of TEST_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("loadNotifyEnv: silently no-ops when the file doesn't exist", () => {
  loadNotifyEnv(envPath);  // file doesn't exist yet
  assert.equal(process.env["TEST_FORGE_NOTIFY"], undefined);
});

test("loadNotifyEnv: parses simple KEY=value lines into process.env", () => {
  writeFileSync(envPath, "TEST_FORGE_NOTIFY=twilio\nTEST_TWILIO_ACCOUNT_SID=AC123\n");
  loadNotifyEnv(envPath);
  assert.equal(process.env["TEST_FORGE_NOTIFY"], "twilio");
  assert.equal(process.env["TEST_TWILIO_ACCOUNT_SID"], "AC123");
});

test("loadNotifyEnv: shell-set env vars take precedence (file is a fallback, not an override)", () => {
  process.env["TEST_FORGE_NOTIFY"] = "pushover";  // already set
  writeFileSync(envPath, "TEST_FORGE_NOTIFY=twilio\nTEST_TWILIO_TO=+15550000000\n");
  loadNotifyEnv(envPath);
  assert.equal(process.env["TEST_FORGE_NOTIFY"], "pushover");  // unchanged
  assert.equal(process.env["TEST_TWILIO_TO"], "+15550000000"); // set from file
});

test("loadNotifyEnv: ignores blank lines, comments, and malformed lines", () => {
  writeFileSync(envPath, [
    "# A comment",
    "",
    "   # indented comment",
    "no_equals_here",
    "=value-with-no-key",
    "TEST_TWILIO_ACCOUNT_SID=AC123",
    "",
  ].join("\n"));
  loadNotifyEnv(envPath);
  assert.equal(process.env["TEST_TWILIO_ACCOUNT_SID"], "AC123");
});

test("loadNotifyEnv: strips surrounding double and single quotes from values", () => {
  writeFileSync(envPath, [
    'TEST_TWILIO_AUTH_TOKEN="quoted-value"',
    "TEST_TWILIO_TO='+15550000000'",
    "TEST_FORGE_NOTIFY=unquoted",
  ].join("\n"));
  loadNotifyEnv(envPath);
  assert.equal(process.env["TEST_TWILIO_AUTH_TOKEN"], "quoted-value");
  assert.equal(process.env["TEST_TWILIO_TO"], "+15550000000");
  assert.equal(process.env["TEST_FORGE_NOTIFY"], "unquoted");
});

test("loadNotifyEnv: a value containing an '=' is preserved (split on FIRST '=' only)", () => {
  writeFileSync(envPath, "TEST_TWILIO_AUTH_TOKEN=abc=def=ghi\n");
  loadNotifyEnv(envPath);
  assert.equal(process.env["TEST_TWILIO_AUTH_TOKEN"], "abc=def=ghi");
});
