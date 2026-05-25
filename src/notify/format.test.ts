import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRunNotification, formatDuration } from "./format.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-add-login-7c2a91",
  workflow: "feature",
  title: "add login",
  status: "complete",
  createdAt: "2026-05-25T12:00:00Z",
};

test("formatRunNotification: complete state produces the expected one-liner", () => {
  const out = formatRunNotification(RUN, "complete", 14 * 60 * 1000 + 23 * 1000);
  assert.equal(out, 'forge: run-add-login-7c2a91 [complete] feature "add login" — 14m23s');
});

test("formatRunNotification: failed state produces the expected one-liner", () => {
  const out = formatRunNotification({ ...RUN, status: "abandoned" }, "failed", 5 * 1000);
  assert.equal(out, 'forge: run-add-login-7c2a91 [failed] feature "add login" — 5s');
});

test("formatRunNotification: blocked_by_red state produces the expected one-liner", () => {
  const out = formatRunNotification(RUN, "blocked_by_red", 60 * 1000);
  assert.equal(out, 'forge: run-add-login-7c2a91 [blocked_by_red] feature "add login" — 1m0s');
});

test("formatRunNotification: omits duration when not provided", () => {
  const out = formatRunNotification(RUN, "complete");
  assert.equal(out, 'forge: run-add-login-7c2a91 [complete] feature "add login"');
});

test("formatRunNotification: truncates a long title to keep the SMS under 160 chars", () => {
  const longTitle = "a".repeat(300);
  const out = formatRunNotification({ ...RUN, title: longTitle }, "complete", 1000);
  assert.ok(out.length <= 160, `expected length <= 160, got ${out.length}`);
  assert.ok(out.endsWith('..." — 1s'), `expected truncation marker, got: ${out}`);
  assert.ok(out.startsWith("forge: run-add-login-7c2a91 [complete] feature "));
});

test("formatRunNotification: handles a title containing double quotes without breaking the format", () => {
  const out = formatRunNotification(
    { ...RUN, title: 'add "OAuth" login' },
    "complete",
    1000,
  );
  // Double quotes inside the title get downgraded to singles so the outer quoting stays clean.
  assert.equal(out, `forge: run-add-login-7c2a91 [complete] feature "add 'OAuth' login" — 1s`);
});

test("formatDuration: sub-minute returns just seconds", () => {
  assert.equal(formatDuration(500), "0s");
  assert.equal(formatDuration(45 * 1000), "45s");
});

test("formatDuration: under an hour returns MmSs", () => {
  assert.equal(formatDuration(60 * 1000), "1m0s");
  assert.equal(formatDuration(14 * 60 * 1000 + 23 * 1000), "14m23s");
});

test("formatDuration: an hour or more returns HhMmSs", () => {
  assert.equal(formatDuration(60 * 60 * 1000), "1h0m0s");
  assert.equal(formatDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000 + 30 * 1000), "2h5m30s");
});

test("formatDuration: clamps negative input to 0", () => {
  assert.equal(formatDuration(-1000), "0s");
});
