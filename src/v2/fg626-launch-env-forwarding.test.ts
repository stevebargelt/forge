// FG-626: `forge launch run` must forward the caller's per-invocation FORGE_-prefixed
// environment into the launched workload — the mandated dispatch path silently dropped
// it before, disarming every env gate forge has (FORGE_WORKTREES, FORGE_CI_*, …).
//
// These are the PURE / stubbed-tmux halves: the forwarding decision (planForgeEnvForwarding)
// and the `new-session -e` args startLaunch builds from it. The real-tmux end-to-end proof
// (the var actually reaching the workload) lives in the integration test alongside.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import {
  LAUNCHES_DIR,
  listLaunches,
  planForgeEnvForwarding,
  redactForwardedEnvForRecord,
  isAllowlistedForgeEnvName,
  REDACTED_ENV_VALUE,
  startLaunch,
  type LaunchProfile,
  type TmuxRunner,
} from "./launch.js";
import { rmSync } from "node:fs";

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

/** A minimal tmux stub: records calls, answers pane pid by format. Never spawns. */
function tmuxStub(): { tmux: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  const tmux: TmuxRunner = (args) => {
    calls.push(args);
    if (args[0] === "display-message") return "4242\n";
    return "";
  };
  return { tmux, calls };
}

/** The `-e VALUE` entries a new-session call carried, as `NAME=VALUE` strings. */
function envPins(newSession: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < newSession.length; i++) {
    if (newSession[i] === "-e") out.push(newSession[i + 1]!);
  }
  return out;
}

// ── the pure forwarding decision ─────────────────────────────────────────────────

test("FG-626: planForgeEnvForwarding forwards FORGE_-prefixed vars and NOTHING else (PATH/TMUX/auth are never swept)", () => {
  const plan = planForgeEnvForwarding({
    FORGE_WORKTREES: "1",
    FORGE_CI_POLL_SECONDS: "5",
    PATH: "/evil/ambient",
    TMUX: "/tmp/tmux-501/default,4242,0",
    TMUX_TMPDIR: "/tmp/whatever",
    HOME: "/home/op",
    AWS_SECRET_ACCESS_KEY: "shhh",
    NOT_FORGE: "x",
  });
  assert.deepEqual(
    plan.forwarded,
    [
      { name: "FORGE_CI_POLL_SECONDS", value: "5" },
      { name: "FORGE_WORKTREES", value: "1" },
    ],
    "only FORGE_-prefixed variables are forwarded — PATH, TMUX, TMUX_TMPDIR, auth, and non-FORGE vars are excluded",
  );
  assert.deepEqual(plan.dropped, [], "nothing was dropped — every FORGE_ var here is forwardable");
});

test("FG-626: FORGE_RELEASE_ID is DROPPED (never forwarded) and named — the release identity is forge's own, never a caller channel", () => {
  const plan = planForgeEnvForwarding({ FORGE_RELEASE_ID: "poison", FORGE_WORKTREES: "1" });
  assert.deepEqual(plan.forwarded, [{ name: "FORGE_WORKTREES", value: "1" }], "the ordinary gate still forwards");
  assert.equal(plan.dropped.length, 1);
  assert.equal(plan.dropped[0]!.name, "FORGE_RELEASE_ID", "the dropped variable is named");
  assert.match(plan.dropped[0]!.reason, /release/i, "and the reason is stated");
});

test("FG-626: a FORGE_ value that cannot survive the session env (a newline) is DROPPED-with-reason, not silently corrupted", () => {
  const plan = planForgeEnvForwarding({ FORGE_MULTILINE: "a\nb", FORGE_WORKTREES: "1" });
  assert.deepEqual(plan.forwarded, [{ name: "FORGE_WORKTREES", value: "1" }]);
  assert.equal(plan.dropped.length, 1);
  assert.equal(plan.dropped[0]!.name, "FORGE_MULTILINE");
  assert.match(plan.dropped[0]!.reason, /newline/i);
});

test("FG-626: an empty-string FORGE_ value is forwarded (present-but-empty is a real state, not absent)", () => {
  const plan = planForgeEnvForwarding({ FORGE_NOTIFY: "" });
  assert.deepEqual(plan.forwarded, [{ name: "FORGE_NOTIFY", value: "" }]);
});

// ── FG-707: recording is a fail-closed ALLOWLIST — only enumerated gate values are kept ─

test("FG-707: only an allowlisted gate NAME keeps its recorded value; every other FORGE_ name is redacted BY DESIGN", () => {
  // On the allowlist: the audit needs these values.
  assert.equal(isAllowlistedForgeEnvName("FORGE_WORKTREES"), true, "an enumerated worktree gate keeps its value");
  assert.equal(isAllowlistedForgeEnvName("FORGE_CI_POLL_SECONDS"), true, "an enumerated CI knob keeps its value");
  // Not on the allowlist → redacted. A credential name, obviously.
  assert.equal(isAllowlistedForgeEnvName("FORGE_AWS_CREDS_FOR_TEST"), false, "a credential name is not on the allowlist");
  assert.equal(isAllowlistedForgeEnvName("FORGE_TOKEN"), false, "an injected TOKEN name is not on the allowlist");
  // FG-707/RF-4: FORGE_CONTROLLER_ID is the lease-fencing controller identity, not
  // configuration — capability-adjacent, so its value is redacted like any other unlisted name.
  assert.equal(isAllowlistedForgeEnvName("FORGE_CONTROLLER_ID"), false, "the lease-fencing controller id is redacted, not allowlisted");
  // AC2: FORGE_AUTH_MODE is a mode selector, NOT a credential — but under fail-closed an
  // unlisted name is redacted regardless. This is the FG-626 recheck's own counterexample.
  assert.equal(isAllowlistedForgeEnvName("FORGE_AUTH_MODE"), false, "FORGE_AUTH_MODE is not allowlisted, so its value is redacted");
  // AC3: an arbitrary unlisted name is redacted — the defining fail-closed property. A name we
  // never enumerated (a future secret gate) is redacted the moment it exists, not by omission.
  assert.equal(isAllowlistedForgeEnvName("FORGE_SOMETHING_UNKNOWN"), false, "an arbitrary unlisted name is redacted");
});

test("FG-707: redactForwardedEnvForRecord keeps allowlisted values verbatim and redacts everything else, name preserved", () => {
  const redacted = redactForwardedEnvForRecord({
    forwarded: [
      { name: "FORGE_AWS_CREDS_FOR_TEST", value: "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t" },
      { name: "FORGE_AUTH_MODE", value: "mount" },
      { name: "FORGE_SOMETHING_UNKNOWN", value: "arbitrary" },
      { name: "FORGE_WORKTREES", value: "1" },
      { name: "FORGE_CI_POLL_SECONDS", value: "30" },
    ],
    dropped: [{ name: "FORGE_RELEASE_ID", reason: "release identity" }],
  });
  assert.deepEqual(
    redacted.forwarded,
    [
      { name: "FORGE_AWS_CREDS_FOR_TEST", value: REDACTED_ENV_VALUE, redacted: true },
      { name: "FORGE_AUTH_MODE", value: REDACTED_ENV_VALUE, redacted: true },
      { name: "FORGE_SOMETHING_UNKNOWN", value: REDACTED_ENV_VALUE, redacted: true },
      { name: "FORGE_WORKTREES", value: "1" },
      { name: "FORGE_CI_POLL_SECONDS", value: "30" },
    ],
    "unlisted names (credential, mode selector, arbitrary) are all redacted; allowlisted gates keep their value verbatim",
  );
  assert.ok(!redacted.forwarded[0]!.value.includes("AWS_SECRET_ACCESS_KEY"), "no secret material survives into the record");
  assert.deepEqual(redacted.dropped, [{ name: "FORGE_RELEASE_ID", reason: "release identity" }], "dropped audit reasons pass through unchanged");
});

test("FG-707: allowlist membership is exact — prefix, suffix, and casing near-misses are redacted", () => {
  const nearMisses = ["FORGE_WORKTREES_X", "FORGE_CI_POLL_SECONDS_EXTRA", "forge_worktrees"];
  const redacted = redactForwardedEnvForRecord({
    forwarded: nearMisses.map((name) => ({ name, value: `attacker-controlled-${name}` })),
    dropped: [],
  });

  assert.deepEqual(
    redacted.forwarded,
    nearMisses.map((name) => ({ name, value: REDACTED_ENV_VALUE, redacted: true })),
    "only an exact, case-sensitive allowlist member can retain its audit value",
  );
  for (const name of nearMisses) {
    assert.equal(isAllowlistedForgeEnvName(name), false, `${name} is not an allowlist member`);
  }
});

test("FG-707: startLaunch RECORDS an unlisted value redacted, but FORWARDS the real value to the workload", () => {
  const stub = tmuxStub();
  const meta = startLaunch([process.execPath, "-e", "0"], {
    name: "fg626redact",
    tmux: stub.tmux,
    env: { ...process.env, FORGE_AWS_CREDS_FOR_TEST: "AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t", FORGE_AUTH_MODE: "mount", FORGE_WORKTREES: "1" },
  });

  // Recorded surface: the credential name is present but its value is redacted; the
  // ordinary gate keeps its value so the audit can still distinguish =1 from =0.
  const rec = meta.forwardedEnv!.forwarded;
  const creds = rec.find((f) => f.name === "FORGE_AWS_CREDS_FOR_TEST")!;
  assert.equal(creds.value, REDACTED_ENV_VALUE, "the credential value is redacted in the durable record");
  assert.equal(creds.redacted, true, "and flagged as a deliberate redaction");
  // AC2: FORGE_AUTH_MODE is unlisted, so its value is redacted in meta.json too — the
  // fail-closed counterexample, proven on the durable record surface.
  const authMode = rec.find((f) => f.name === "FORGE_AUTH_MODE")!;
  assert.equal(authMode.value, REDACTED_ENV_VALUE, "FORGE_AUTH_MODE is redacted in the durable record (not on the allowlist)");
  assert.equal(authMode.redacted, true, "and flagged as a deliberate redaction");
  assert.ok(rec.some((f) => f.name === "FORGE_WORKTREES" && f.value === "1" && !f.redacted), "the ordinary gate keeps its recorded value");
  assert.ok(!JSON.stringify(meta.forwardedEnv).includes("AWS_SECRET_ACCESS_KEY"), "no secret material anywhere in the recorded env");

  // Workload surface: the real values still reach the session env unredacted — redaction is
  // an audit-surface concern only, never a functional one.
  const pins = envPins(stub.calls.find((c) => c[0] === "new-session")!);
  assert.ok(
    pins.includes("FORGE_AWS_CREDS_FOR_TEST=AWS_ACCESS_KEY_ID=k,AWS_SECRET_ACCESS_KEY=s,AWS_SESSION_TOKEN=t"),
    "the workload receives the REAL credential value — the gate is armed, only the record is redacted",
  );
  assert.ok(pins.includes("FORGE_AUTH_MODE=mount"), "the workload receives the REAL FORGE_AUTH_MODE value — redaction never disarms the gate");
  assert.ok(pins.includes("FORGE_WORKTREES=1"), "the ordinary gate reaches the workload too");
});

// ── the session env startLaunch builds from the plan ─────────────────────────────

// NB: the startLaunch-level tests below spread `...process.env` into the invocation env
// exactly as the real CLI does (opts.env defaults to process.env) and assert by
// membership — robust to whatever ambient FORGE_ vars the runner carries. The strict
// "only FORGE_ vars, nothing else" invariant is proven by the pure planForgeEnvForwarding
// tests above, which take a controlled literal env.

test("FG-626: startLaunch forwards the FORGE_ vars into the session via `new-session -e` and RECORDS the set on the launch", () => {
  const stub = tmuxStub();
  const meta = startLaunch([process.execPath, "-e", "0"], {
    name: "fg626fwd",
    tmux: stub.tmux,
    env: { ...process.env, FORGE_WORKTREES: "1", FORGE_CI_POLL_SECONDS: "5" },
  });
  const pins = envPins(stub.calls.find((c) => c[0] === "new-session")!);
  assert.ok(pins.includes("FORGE_WORKTREES=1"), "FORGE_WORKTREES reaches the session env");
  assert.ok(pins.includes("FORGE_CI_POLL_SECONDS=5"), "FORGE_CI_POLL_SECONDS reaches the session env");
  assert.ok(!pins.some((p) => p.startsWith("PATH=")), "with no contract, PATH is never forwarded (not FORGE_-prefixed, never swept)");

  const fwd = meta.forwardedEnv?.forwarded ?? [];
  assert.ok(fwd.some((f) => f.name === "FORGE_WORKTREES" && f.value === "1"), "the forwarded set is recorded on the launch for audit");
  assert.ok(fwd.some((f) => f.name === "FORGE_CI_POLL_SECONDS" && f.value === "5"));
  assert.ok(!fwd.some((f) => f.name === "PATH"), "PATH is never in the recorded forwarded set");
});

// ── constraint 1: forwarding is independent of the FG-555 PATH pin ────────────────

test("FG-626 (constraint 1): forwarding a FORGE_ var never puts PATH on the session env — the FG-706 recorder pin is what protects the workload, not the session env", () => {
  const stub = tmuxStub();
  const pinned = `${dirname(process.execPath)}:/fg626-pin-marker`;
  const profile: LaunchProfile = { path: pinned, requireAbi: process.versions.modules, label: "control-runtime" };
  // A direct node interpreter (provable under the fail-closed contract), so the guard
  // passes; the point under test is that forwarding rides the `-e` channel while the PATH
  // pin does NOT — FG-706 moved the pin into the recorder because tmux cannot carry PATH
  // to a respawn-pane workload. The ambient PATH is deliberately hostile so a leak of it
  // onto the session env would be visible.
  startLaunch([process.execPath, "-e", "0"], {
    name: "fg626pin",
    tmux: stub.tmux,
    profile,
    env: { ...process.env, FORGE_WORKTREES: "1", PATH: "/evil/ambient" },
  });

  const newSession = stub.calls.find((c) => c[0] === "new-session")!;
  const pins = envPins(newSession);
  assert.deepEqual(
    pins.filter((p) => p.startsWith("PATH=")),
    [],
    "no PATH is written to the session env — never the pinned one (that lives in the recorder) and never the ambient/forwarded one",
  );
  assert.ok(pins.includes("FORGE_WORKTREES=1"), "the FORGE_ var is still forwarded through the `-e` channel");
});

// ── constraint 2: a caller-supplied FORGE_RELEASE_ID never becomes the recorded id ─

test("FG-626 (constraint 2): a caller-supplied FORGE_RELEASE_ID never becomes the recorded release id, and is not forwarded", () => {
  const stub = tmuxStub();
  const meta = startLaunch([process.execPath, "-e", "0"], {
    name: "fg626rel",
    tmux: stub.tmux,
    env: { ...process.env, FORGE_RELEASE_ID: "poison-release-id", FORGE_WORKTREES: "1" },
  });

  // R1 control release id is derived from forge's own manifest — NEVER the poisoned env.
  assert.notEqual(meta.control?.release.releaseId, "poison-release-id", "the recorded release id is not the caller-supplied one");

  // It is dropped (not forwarded), and named.
  assert.ok(!meta.forwardedEnv?.forwarded.some((f) => f.name === "FORGE_RELEASE_ID"), "FORGE_RELEASE_ID is never forwarded into the workload");
  const drop = meta.forwardedEnv?.dropped.find((d) => d.name === "FORGE_RELEASE_ID");
  assert.ok(drop, "FORGE_RELEASE_ID is recorded as dropped for audit");
  assert.match(drop!.reason, /release/i);

  // And no FORGE_RELEASE_ID -e pin reaches the session either.
  const newSession = stub.calls.find((c) => c[0] === "new-session")!;
  assert.ok(!envPins(newSession).some((p) => p.startsWith("FORGE_RELEASE_ID=")), "no FORGE_RELEASE_ID env pin reaches the tmux session");

  assert.equal(listLaunches(stub.tmux).length, 1, "the launch itself proceeded — the poisoned var is dropped, not a refusal");
});
