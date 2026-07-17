import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReleaseReport, summarizeProblems, type ReleaseInputs } from "./release-doctor.js";

// A fully-green baseline; each test overrides one surface to exercise a scenario.
// The baseline is `dev` — the mtime heuristic and the `forge upgrade
// --rebuild-image` advice are both dev-only, and the release variants of each are
// pinned by the FG-577 tests at the bottom of this file.
function green(over: Partial<ReleaseInputs> = {}): ReleaseInputs {
  return {
    mode: "dev",
    image: { name: "agent-dev-worker:latest", present: true, createdMs: 2000, buildInputMtimeMs: 1000 },
    clis: [
      { command: "claude", present: true, neededBy: ["claude-oauth"] },
      { command: "codex", present: true, neededBy: ["codex-subscription"] },
    ],
    policy: { present: true, valid: true },
    profileAuth: [
      { profile: "codex-subscription", provider: "openai", auth: "subscription", status: "available", detail: "Codex subscription credential present" },
    ],
    routing: { present: true, ok: true, detail: "present and validates" },
    ...over,
  };
}

const status = (r: ReturnType<typeof buildReleaseReport>, namePart: string) =>
  r.checks.find((c) => c.name.includes(namePart))?.status;

test("#229 green path: every check ok, overall ok", () => {
  const r = buildReleaseReport(green());
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.status === "ok"), `not all ok: ${JSON.stringify(r.checks)}`);
});

test("#229 image missing → fail with a rebuild next-command, overall NOT ready", () => {
  const r = buildReleaseReport(green({ image: { name: "agent-dev-worker:latest", present: false } }));
  assert.equal(status(r, "image"), "fail");
  assert.equal(r.ok, false);
  const img = r.checks.find((c) => c.name.includes("image"))!;
  assert.match(img.next ?? "", /docker\/build\.sh|rebuild/i);
});

test("#229 image stale (Dockerfile newer than image) → warn, but not blocking", () => {
  const r = buildReleaseReport(green({ image: { name: "agent-dev-worker:latest", present: true, createdMs: 1000, buildInputMtimeMs: 5000 } }));
  assert.equal(status(r, "image"), "warn");
  assert.match(r.checks.find((c) => c.name.includes("image"))!.detail, /STALE/);
  assert.equal(r.ok, true, "a stale image warns, doesn't block");
});

test("#229 docker unreachable (not 'No such image') → image skip, never a false 'rebuild' fail", () => {
  const r = buildReleaseReport(green({
    image: { name: "agent-dev-worker:latest", present: false, dockerError: "Cannot connect to the Docker daemon" },
    clis: [{ command: "codex", present: null, neededBy: ["codex-subscription"] }],
  }));
  const img = r.checks.find((c) => c.name.includes("image"))!;
  assert.equal(img.status, "skip", "a daemon hiccup must not be reported as a missing image");
  assert.match(img.detail, /could not probe docker/i);
  assert.match(img.next ?? "", /docker is running/i);
  assert.equal(r.ok, true, "unverifiable (skip) is not a blocking failure");
});

test("#229 configured codex but missing codex CLI in image → fail before invoke", () => {
  const r = buildReleaseReport(green({
    clis: [
      { command: "claude", present: true, neededBy: ["claude-oauth"] },
      { command: "codex", present: false, neededBy: ["codex-subscription"] },
    ],
  }));
  const codex = r.checks.find((c) => c.name === "cli codex")!;
  assert.equal(codex.status, "fail");
  assert.match(codex.detail, /missing from the image.*codex-subscription/);
  assert.equal(r.ok, false);
});

test("#229 CLI not probed (image unavailable) → skip, not a false-green fail", () => {
  const r = buildReleaseReport(green({
    image: { name: "agent-dev-worker:latest", present: false },
    clis: [{ command: "codex", present: null, neededBy: ["codex-subscription"] }],
  }));
  assert.equal(r.checks.find((c) => c.name === "cli codex")!.status, "skip");
  // image fail already makes it not-ready; the skipped CLI doesn't add a second fail.
  assert.equal(r.ok, false);
});

test("#229 configured profile but missing credential → fail (diagnosed before invoke)", () => {
  const r = buildReleaseReport(green({
    profileAuth: [
      { profile: "pi-groq", provider: "groq", auth: "api", status: "unavailable", detail: "GROQ_API_KEY not set" },
    ],
  }));
  const auth = r.checks.find((c) => c.name.includes("pi-groq"))!;
  assert.equal(auth.status, "fail");
  assert.match(auth.detail, /GROQ_API_KEY not set/);
  assert.equal(r.ok, false);
});

test("#229 opt-in profile (reachable:false) with missing cred → warn, not a blocking fail", () => {
  const r = buildReleaseReport(green({
    profileAuth: [
      { profile: "claude-subscription", provider: "anthropic", auth: "subscription", status: "available", detail: "ok", reachable: true },
      { profile: "pi-groq", provider: "groq", auth: "api", status: "unavailable", detail: "GROQ_API_KEY not set", reachable: false },
    ],
  }));
  assert.equal(status(r, "pi-groq"), "warn");
  assert.match(r.checks.find((c) => c.name.includes("pi-groq"))!.detail, /opt-in profile/);
  assert.equal(r.ok, true, "an opt-in profile's missing cred doesn't block default-work readiness");
});

test("#229 default-reachable profile (reachable:true) with missing cred → fail", () => {
  const r = buildReleaseReport(green({
    profileAuth: [
      { profile: "claude-subscription", provider: "anthropic", auth: "subscription", status: "unavailable", detail: "no OAuth", reachable: true },
    ],
  }));
  assert.equal(status(r, "claude-subscription"), "fail");
  assert.equal(r.ok, false);
});

test("#229 bedrock profile present → AWS diagnostic surfaced (available → ok)", () => {
  const r = buildReleaseReport(green({
    profileAuth: [
      { profile: "claude-bedrock", provider: "anthropic", auth: "bedrock", status: "available", detail: "AWS profile/config present" },
    ],
  }));
  assert.equal(status(r, "claude-bedrock"), "ok");
});

test("#229 unknown auth (e.g. OAuth in a volume) → warn, never blocks", () => {
  const r = buildReleaseReport(green({
    profileAuth: [
      { profile: "claude-subscription", provider: "anthropic", auth: "subscription", status: "unknown", detail: "no OAuth hint cached" },
    ],
  }));
  assert.equal(status(r, "claude-subscription"), "warn");
  assert.match(r.checks.find((c) => c.name.includes("claude-subscription"))!.detail, /not checkable from the host/);
  assert.equal(r.ok, true);
});

test("#229 model-policy absent → ok (legacy mode), present+invalid → fail", () => {
  assert.equal(status(buildReleaseReport(green({ policy: { present: false, valid: false } })), "model-policy"), "ok");
  const bad = buildReleaseReport(green({ policy: { present: true, valid: false, error: "unknown key 'profle'" } }));
  assert.equal(status(bad, "model-policy"), "fail");
  assert.equal(bad.ok, false);
});

test("#229 routing-policy absent → warn; present+invalid → fail", () => {
  assert.equal(status(buildReleaseReport(green({ routing: { present: false, ok: false, detail: "" } })), "routing-policy"), "warn");
  const bad = buildReleaseReport(green({ routing: { present: true, ok: false, detail: "2 findings" } }));
  assert.equal(status(bad, "routing-policy"), "fail");
  assert.equal(bad.ok, false);
});

// ─────────── FG-577: the mtime heuristic and the advice are mode-scoped ───────────
//
// A release tree is materialized with cpSync (release.ts), which does NOT preserve
// timestamps: every build input carries the moment the release was BUILT, not an
// edit time. Judged by the dev heuristic, that is unconditionally "newer than the
// image" — so every release host reported a permanently STALE image, and the only
// remedy the advice named (`forge upgrade --rebuild-image`) refuses on a release.
// STALE → run the named command → it refuses → still STALE, forever.

test("FG-577: a release does NOT report STALE from cpSync-stamped build inputs (the dev heuristic still does)", () => {
  // The identical inputs, differing only in mode: build inputs stamped long after
  // the image, exactly as a fresh release materialization stamps them.
  const image = { name: "agent-dev-worker:latest", present: true, createdMs: 1000, buildInputMtimeMs: 5000 };

  const dev = buildReleaseReport(green({ mode: "dev", image }));
  assert.equal(status(dev, "image"), "warn", "dev keeps the heuristic — this fix must not disarm it (FG-543 owns that)");

  const release = buildReleaseReport(green({ mode: "release", image }));
  assert.equal(status(release, "image"), "ok", "a release's build-input mtimes cannot prove staleness");
  assert.doesNotMatch(release.checks.find((c) => c.name.includes("image"))!.detail, /STALE/);
});

test("FG-577: no advice reachable in release mode names a command that refuses in release mode", () => {
  // Every check driven to a state that carries a `next`, so the sweep covers the
  // whole advice surface rather than the one string that started this.
  const report = buildReleaseReport(green({
    mode: "release",
    image: { name: "agent-dev-worker:latest", present: false },
    clis: [
      { command: "codex", present: false, neededBy: ["codex-subscription"] },
      { command: "claude", present: null, neededBy: ["claude-oauth"] },
    ],
    policy: { present: true, valid: false, error: "boom" },
    profileAuth: [{ profile: "p", provider: "openai", auth: "api", status: "unavailable", detail: "no cred" }],
    routing: { present: false, ok: false, detail: "" },
  }));
  const advice = report.checks.map((c) => c.next).filter((n): n is string => n !== undefined);
  assert.ok(advice.length >= 4, "the sweep must actually reach the advice surface");
  for (const next of advice) {
    assert.ok(
      !next.includes("forge upgrade --rebuild-image"),
      `release-mode advice names a command that refuses under a release: ${next}`,
    );
  }
  // …and the rebuild advice still says how to actually do it, from the checkout.
  assert.match(advice.join("\n"), /forge-dev upgrade --rebuild-image/);
});

test("FG-577: dev mode keeps naming the command that WORKS there", () => {
  const report = buildReleaseReport(green({ mode: "dev", image: { name: "agent-dev-worker:latest", present: false } }));
  assert.match(report.checks.find((c) => c.name.includes("image"))!.next ?? "", /forge upgrade --rebuild-image/);
});

test("#229 summarizeProblems lists only non-ok rows with their next-commands", () => {
  const r = buildReleaseReport(green({
    clis: [{ command: "codex", present: false, neededBy: ["codex-subscription"] }],
  }));
  const problems = summarizeProblems(r);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /cli codex.*missing.*→/);
});
