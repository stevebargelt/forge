import { test } from "node:test";
import assert from "node:assert/strict";
import { CHROME_LAUNCH_ARGS } from "./chrome-bin.js";

test("FG-760: shared Chromium launch arguments retain the CI-required no-sandbox flag", () => {
  assert.ok(
    CHROME_LAUNCH_ARGS.includes("--no-sandbox"),
    "--no-sandbox is required for Chromium to launch on the GitHub ubuntu runner"
  );
});
