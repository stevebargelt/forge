// FG-621 step 4 — the guard on the AC 2 / AC 11 operator evidence script.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. `scripts/fg621-clone-boundary-smoke.sh`
// runs a REAL container against the agent image; no tier in this repo can do
// that (agent containers have no Docker daemon, and no CI job builds or runs
// the image). So the green path is proven exactly once, host-side on macOS, by
// the operator, and pasted into FG-621 — the FG-559 precedent.
//
// What IS provable here, and what the ticket actually depends on, is that the
// script cannot go quietly green:
//
//   1. Every missing prerequisite exits NONZERO with a diagnostic. A skip-to-
//      green would be a FALSE SECURITY PROOF, which is worse than no proof.
//   2. Its adjudicator can go RED. A smoke script that always prints PASS
//      proves nothing about the boundary, so the three canned-log cases below
//      drive it into each of its failure modes: a parent write that SUCCEEDED,
//      a probe that never ran, and a probe whose command was never found (a
//      typo, which must never read as a refusal).
//   3. It stays outside every npm tier and outside CI, per the recorded
//      decision not to add a third required check.
//
// Tier: integration, not unit — this file drives a real subprocess and a real
// `git clone --shared`, both of which src/test-tiers.test.ts bans from the unit
// tier (isUnitTierSubprocessViolator).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "fg621-clone-boundary-smoke.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

// The standard tool dirs, carrying the git/mktemp/coreutils the script needs but
// NOT the operator's macOS docker (which lives in /usr/local/bin or ~/.docker/bin).
// It is NOT docker-free in general — a Linux CI runner installs docker to
// /usr/bin/docker — so it is only ever safe for the cases that shadow docker with
// stubDockerPath. The genuine-absence case below uses EMPTY_PATH instead.
const TOOLS_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// A PATH nothing at all is on, so `command -v docker` cannot find a docker on ANY
// host. Usable only because the docker check is the script's FIRST prerequisite
// and everything preceding it (case, [, echo, command, exit) is a bash builtin.
const EMPTY_PATH = "";

// The interpreter, resolved to an absolute path ONCE. A case that hands the
// script an empty PATH must not thereby hide bash itself from the spawn.
const BASH =
  spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout?.trim() || "/bin/bash";

type Run = { status: number | null; stdout: string; stderr: string; all: string };

function runScript(args: string[], env: Record<string, string>): Run {
  const r = spawnSync(BASH, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: TOOLS_PATH, ...env },
    timeout: 120_000,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { status: r.status, stdout, stderr, all: stdout + stderr };
}

/** Writes an executable `docker` stub into a fresh dir and returns a PATH that
 *  finds it first. The stub is the ONLY docker any case below can reach. */
function stubDockerPath(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fg621-stub-"));
  const bin = join(dir, "docker");
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(bin, 0o755);
  return `${dir}:${TOOLS_PATH}`;
}

/** A real parent repo the script can clone --shared from: one commit, packed
 *  refs (the packed-ref probe needs a genuinely packed ref), real objects. */
function makeParentRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg621-parent-"));
  const git = (...a: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${a.join(" ")} failed: ${r.stderr}`);
  };
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  git("config", "user.email", "fg621@example.com");
  git("config", "user.name", "fg621");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("pack-refs", "--all");
  return dir;
}

/** The probe ids the script actually defines, read out of the script itself so
 *  the canned logs below cannot drift away from the real probe set. */
function probeIds(): { negatives: string[]; positives: string[]; all: string[] } {
  const all = [...SCRIPT_SRC.matchAll(/^probe (\S+) /gm)].map((m) => m[1]!);
  assert.ok(all.length >= 15, `expected the script to define many probes, found ${all.length}`);
  return {
    negatives: all.filter((id) => /^n\d/.test(id)),
    positives: all.filter((id) => /^[pc]\d/.test(id)),
    all,
  };
}

/** A docker stub that passes every prerequisite and, on `run`, emits `log`. */
function cannedLogStub(log: string): string {
  return [
    `case "$1" in`,
    `  info) exit 0 ;;`,
    `  image) exit 0 ;;`,
    `  version) echo "stub" ; exit 0 ;;`,
    `  run) cat <<'FG621_CANNED_LOG'`,
    log,
    `FG621_CANNED_LOG`,
    `    exit 0 ;;`,
    `  *) exit 1 ;;`,
    `esac`,
  ].join("\n");
}

function cannedLog(entries: Array<{ id: string; rc: number; out: string }>, done = true): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`PROBE_BEGIN ${e.id}`);
    lines.push(`PROBE_CMD ${e.id} | (canned)`);
    lines.push(`PROBE_OUT ${e.id} | ${e.out}`);
    lines.push(`PROBE_RC ${e.id} ${e.rc}`);
  }
  if (done) lines.push("CONTAINER_DONE");
  return lines.join("\n");
}

// ── the script is a committed, executable, syntactically valid artifact ──────

test("FG-621 smoke script is committed executable and syntactically valid", () => {
  const mode = statSync(SCRIPT).mode;
  assert.ok(mode & 0o100, "owner-executable bit must be set (it is an operator entry point)");
  assert.ok(mode & 0o001, "world-executable bit must be set");

  assert.equal(spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" }).status, 0, "host script must parse");

  // The in-container probe program is a separate shell program shipped inside a
  // quoted heredoc, so `bash -n` on the outer file does NOT check it. A syntax
  // error in there would surface only as a container that dies mid-probe.
  const m = /^CONTAINER_SCRIPT=\$\(cat <<'CEOF'$([\s\S]*?)^CEOF$/m.exec(SCRIPT_SRC);
  assert.ok(m, "the container probe program must be a quoted CEOF heredoc");
  const inner = mkdtempSync(join(tmpdir(), "fg621-inner-"));
  const innerPath = join(inner, "container.sh");
  writeFileSync(innerPath, m[1]!);
  try {
    assert.equal(
      spawnSync("bash", ["-n", innerPath], { encoding: "utf8" }).status,
      0,
      "the in-container probe program must parse",
    );
  } finally {
    rmSync(inner, { recursive: true, force: true });
  }
});

// ── fail-closed on every missing prerequisite ────────────────────────────────

test("FG-621 smoke exits nonzero when docker is not on PATH", () => {
  // EMPTY_PATH, not the standard tool dirs: a Linux runner keeps docker at
  // /usr/bin/docker, so handing the script /usr/bin would let it sail past this
  // prerequisite and refuse at the NEXT one — proving fail-closed, but not this
  // branch. An empty PATH is the only way to prove genuine absence on every host.
  const r = runScript([], { PATH: EMPTY_PATH });
  assert.notEqual(r.status, 0, "a missing docker binary must never exit 0");
  assert.match(r.all, /FATAL/);
  assert.match(r.all, /no 'docker' on PATH/);
  assert.match(r.all, /fails closed/);
});

test("FG-621 smoke exits nonzero when the Docker daemon is unreachable", () => {
  const PATH = stubDockerPath(
    `[ "$1" = info ] && { echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2; exit 1; }\nexit 0`,
  );
  const r = runScript([], { PATH });
  assert.notEqual(r.status, 0, "an unreachable daemon must never exit 0");
  assert.match(r.all, /FATAL: no reachable Docker daemon/);
  assert.match(r.all, /docker info/);
});

test("FG-621 smoke exits nonzero when the candidate image is absent", () => {
  const PATH = stubDockerPath(
    `case "$1" in\n  info) exit 0 ;;\n  image) echo "Error response from daemon: No such image: $3" >&2; exit 1 ;;\n  *) exit 1 ;;\nesac`,
  );
  const r = runScript(["--image", "agent-dev-worker:fg621-candidate"], { PATH });
  assert.notEqual(r.status, 0, "an absent image must never exit 0");
  assert.match(r.all, /FATAL: candidate image 'agent-dev-worker:fg621-candidate' is absent/);
  assert.match(r.all, /docker\/build\.sh/);
});

test("FG-621 smoke exits nonzero when the project dir is not a git repository", () => {
  const PATH = stubDockerPath(`exit 0`);
  const notARepo = mkdtempSync(join(tmpdir(), "fg621-notrepo-"));
  try {
    const r = runScript(["--project-dir", notARepo], { PATH });
    assert.notEqual(r.status, 0);
    assert.match(r.all, /FATAL/);
    assert.match(r.all, /\.git is not a directory/);
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("FG-621 smoke exits nonzero — not silently skipping the probe — when there is no packed ref to aim at", () => {
  // AC 2 names packed-ref updates explicitly. A repo with no packed-refs file
  // gives that probe no real target, and the script must refuse rather than
  // quietly drop one of the five negative writes.
  const PATH = stubDockerPath(`exit 0`);
  const parent = mkdtempSync(join(tmpdir(), "fg621-nopacked-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main", parent], { encoding: "utf8" });
    spawnSync("git", ["-C", parent, "config", "user.email", "fg621@example.com"]);
    spawnSync("git", ["-C", parent, "config", "user.name", "fg621"]);
    writeFileSync(join(parent, "a.txt"), "a\n");
    spawnSync("git", ["-C", parent, "add", "-A"]);
    spawnSync("git", ["-C", parent, "commit", "-qm", "base"]);
    const r = runScript(["--project-dir", parent], { PATH });
    assert.notEqual(r.status, 0);
    assert.match(r.all, /packed-refs does not exist/);
    assert.match(r.all, /pack-refs --all/, "the diagnostic must be actionable");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FG-621 smoke exits nonzero on an unknown argument rather than proceeding", () => {
  const r = runScript(["--pretend-everything-passed"], {});
  assert.notEqual(r.status, 0);
  assert.match(r.all, /unknown argument/);
});

// ── the adjudicator can go RED: a smoke that cannot fail proves nothing ──────

test("FG-621 smoke FAILS when a parent write is NOT refused", () => {
  const { negatives, positives } = probeIds();
  assert.ok(negatives.length >= 5, `expected >=5 negative probes, found ${negatives.length}`);
  const log = cannedLog([
    ...positives.map((id) => ({ id, rc: 0, out: "ok" })),
    // Every parent write "succeeds" — the exact state AC 2 exists to exclude.
    ...negatives.map((id) => ({ id, rc: 0, out: "" })),
  ]);
  const parent = makeParentRepo();
  try {
    const r = runScript(["--project-dir", parent], { PATH: stubDockerPath(cannedLogStub(log)) });
    assert.notEqual(r.status, 0, "a container that mutated the parent must never exit 0");
    assert.match(r.all, /NOT REFUSED/, "the verdict must name the write that succeeded");
    assert.match(r.all, /AC 2 \/ AC 11 : FAIL/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FG-621 smoke FAILS when a probe never ran, rather than reading absence as a refusal", () => {
  const parent = makeParentRepo();
  try {
    // The container produced no probe records at all — a dead or crashed probe
    // program. Absence of a successful write is NOT evidence of a refusal.
    const r = runScript(["--project-dir", parent], { PATH: stubDockerPath(cannedLogStub("")) });
    assert.notEqual(r.status, 0);
    assert.match(r.all, /NEVER RAN/);
    assert.match(r.all, /did NOT reach its end/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FG-621 smoke FAILS when a negative probe's command was not found — a typo is not a refusal", () => {
  const { negatives, positives } = probeIds();
  const log = cannedLog([
    ...positives.map((id) => ({ id, rc: 0, out: "ok" })),
    ...negatives.map((id) => ({ id, rc: 127, out: "sh: 1: gti: not found" })),
  ]);
  const parent = makeParentRepo();
  try {
    const r = runScript(["--project-dir", parent], { PATH: stubDockerPath(cannedLogStub(log)) });
    assert.notEqual(r.status, 0);
    assert.match(r.all, /COMMAND DID NOT RUN/);
    assert.match(r.all, /a typo must never read as a refusal/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FG-621 smoke emits a copy-pasteable evidence block naming the mount shape under test", () => {
  const { negatives, positives } = probeIds();
  const log = cannedLog([
    ...positives.map((id) => ({ id, rc: 0, out: "ok" })),
    ...negatives.map((id) => ({ id, rc: 1, out: "fatal: not a git repository" })),
  ]);
  const parent = makeParentRepo();
  try {
    const r = runScript(["--project-dir", parent], { PATH: stubDockerPath(cannedLogStub(log)) });
    // The run is not green (the canned positives carry no real commit sha, so
    // the host-side fetch has nothing to retrieve) — the assertion here is
    // about the evidence the operator pastes, not the verdict.
    assert.match(r.stdout, /Paste everything between the fences into FG-621/);
    assert.match(r.stdout, /run id      : /);
    assert.match(r.stdout, /parent objs : .*identity-mounted :ro/);
    assert.match(r.stdout, /no parent \.git \/ refs \/ index \/ HEAD \/ packed-refs mount of any kind/);
    assert.match(r.stdout, /-v .*:\/project:rw/);
    for (const id of [...negatives, ...positives]) {
      assert.match(r.stdout, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `evidence must list ${id}`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ── the script's own body covers what AC 2 and AC 11 name ───────────────────

test("FG-621 smoke body covers all five AC-2 negative writes", () => {
  const required: Array<[string, RegExp]> = [
    ["parent ref creation", /update-ref refs\/heads\/fg621-smoke-intruder/],
    ["parent main update", /update-ref refs\/heads\/main/],
    ["parent origin\\/\\* update", /update-ref refs\/remotes\/origin\/main/],
    ["parent packed-ref update", /update-ref '\$FG621_PACKED_REF'/],
    ["parent object-store deletion", /rm -f '\$FG621_PARENT_OBJECT_FILE'/],
  ];
  for (const [label, re] of required) {
    assert.match(SCRIPT_SRC, re, `AC 2 requires a probe for ${label}`);
  }
  // Each one must also be ADJUDICATED as a refusal, not merely executed.
  for (const id of probeIds().negatives) {
    assert.match(
      SCRIPT_SRC,
      new RegExp(`expect_refused ${id}\\b`),
      `${id} is executed but never adjudicated — an unread probe proves nothing`,
    );
  }
});

test("FG-621 smoke body covers all four AC-11 positives", () => {
  const required: Array<[string, RegExp]> = [
    ["parent history readable in-container", /probe p1_parent_history_readable "git -C \/project log/],
    ["in-clone commit succeeds", /git add -A && git commit -q -m/],
    ["host fetch retrieves the commit", /git -C "\$PROJECT_DIR" fetch [^\n]*"refs\/heads\/\$BRANCH:refs\/heads\/\$BRANCH"/],
    ["parent unchanged before\\/after", /h4_parent_object_store_unchanged/],
  ];
  for (const [label, re] of required) {
    assert.match(SCRIPT_SRC, re, `AC 11 requires ${label}`);
  }
  // The before/after comparison must be taken across the container run and
  // BEFORE the host's own capture fetch, or it would compare the parent to
  // itself after forge legitimately wrote to it.
  const beforeAt = SCRIPT_SRC.indexOf('snapshot "$WORK/before"');
  const dockerAt = SCRIPT_SRC.indexOf('docker "${DOCKER_ARGS[@]}"');
  const afterAt = SCRIPT_SRC.indexOf('snapshot "$WORK/after"');
  const fetchAt = SCRIPT_SRC.indexOf('git -C "$PROJECT_DIR" fetch');
  assert.ok(beforeAt > 0 && dockerAt > beforeAt, "the baseline must be captured before the container runs");
  assert.ok(afterAt > dockerAt, "the comparison snapshot must be taken after the container runs");
  assert.ok(fetchAt > afterAt, "the host capture fetch must happen after the parent-unchanged comparison");
});

// ── it stays out of every tier and out of CI ─────────────────────────────────

test("FG-621 smoke has exactly one exit-0 path and it is the last line", () => {
  const lines = SCRIPT_SRC.split("\n");
  const exitZero = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => /^exit 0$/.test(l));
  assert.equal(exitZero.length, 1, `expected exactly one 'exit 0', found ${exitZero.length}`);
  const lastNonEmpty = lines.map((l) => l.trim()).filter((l) => l.length > 0).at(-1);
  assert.equal(lastNonEmpty, "exit 0", "the only exit-0 must be the final success path");
  assert.doesNotMatch(SCRIPT_SRC, /\bexit 0\b.*skip/i, "there is no skip-to-green path");
});

test("FG-621 smoke is wired into no npm tier and no CI job", () => {
  const name = "fg621-clone-boundary-smoke";
  const pkg = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
  assert.ok(!pkg.includes(name), "the smoke script must not be reachable from any npm script");
  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(!ci.includes(name), "FG-621 records: do NOT add a third required CI check for this");
  assert.match(SCRIPT_SRC, /outside every npm tier/i, "the header must state why it is outside the tiers");
});
