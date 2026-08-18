import assert from "node:assert/strict";
import { test } from "node:test";
import { invocationId, invocationMarkers, parentStartToken } from "./integration-build-invocation.js";

// RF-1: keying the build-preload's lock/ready markers on the parent PID alone let
// an OS PID-reuse make a later invocation reuse a prior invocation's stale READY
// and skip the rebuild. Folding the parent start time into the identity closes it.

test("RF-1: a recycled parent PID (same ppid, later start) yields a distinct identity and disjoint markers", () => {
  const ppid = 4242;
  const prior = invocationId(ppid, "j1000");
  const recycled = invocationId(ppid, "j2000"); // same PID number, a process that started later
  assert.notEqual(recycled, prior);

  // The lock dir and ready sentinel therefore never collide, so the later
  // invocation cannot take the follower path against the prior tree's READY.
  const a = invocationMarkers(prior);
  const b = invocationMarkers(recycled);
  assert.notEqual(a.lockDir, b.lockDir);
  assert.notEqual(a.ready, b.ready);
});

test("all subprocesses of one invocation (same ppid + start token) agree on one identity", () => {
  assert.equal(invocationId(4242, "j1000"), invocationId(4242, "j1000"));
});

test("without a start token the identity degrades to PID-only keying (no worse than pre-fix)", () => {
  assert.equal(invocationId(4242, ""), "4242");
});

test("RF-1: parentStartToken returns a real non-empty token on this platform, so the guard is armed here", () => {
  // The recheck and CI run on Linux, where /proc exposes the parent's start time.
  // A silent fall-through to PID-only keying would leave the reuse hole open, so
  // this asserts the token is actually populated.
  const token = parentStartToken(process.ppid);
  if (process.platform === "linux") {
    assert.match(token, /^j\d+$/, "Linux must key on /proc starttime, not fall back to PID-only");
  } else {
    assert.ok(typeof token === "string" && token.length > 0);
  }
});

test("markers live under the OS tmpdir and carry the invocation id", () => {
  const { lockDir, ready } = invocationMarkers("4242-j1000");
  assert.match(lockDir, /forge-integration-build\.4242-j1000\.lock$/);
  assert.match(ready, /forge-integration-build\.4242-j1000\.ready$/);
});
