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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "fg621-clone-boundary-smoke.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

// Where the node running THIS test lives. The script builds its fixture through
// forge's own createTaskClone, so it needs a node — and on a GitHub runner node
// is in the tool cache (/opt/hostedtoolcache/node/<ver>/x64/bin), which is on no
// standard tool dir. Deriving it from process.execPath rather than naming a
// directory is what makes the fixture work on a runner and a container alike.
const NODE_BIN_DIR = dirname(process.execPath);

// The standard tool dirs, carrying the git/mktemp/coreutils the script needs but
// NOT the operator's macOS docker (which lives in /usr/local/bin or ~/.docker/bin).
// It is NOT docker-free in general — a Linux CI runner installs docker to
// /usr/bin/docker — so it is only ever safe for the cases that shadow docker with
// stubDockerPath. The genuine-absence case below uses EMPTY_PATH instead.
const TOOLS_PATH = `/usr/bin:/bin:/usr/sbin:/sbin:${NODE_BIN_DIR}`;

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
 *  refs (the packed-ref probe needs a genuinely packed ref), real objects.
 *
 *  `looseObjects` pads the object store out to a REAL repo's scale — see the
 *  SIGPIPE section at the bottom of this file for why a four-object store is
 *  the blind spot rather than the baseline. They are hashed in, not committed,
 *  so the working tree and the ref graph are identical either way. */
function makeParentRepo(looseObjects = 0): string {
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

  if (looseObjects > 0) {
    const blobs = join(dir, "blobs");
    mkdirSync(blobs, { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < looseObjects; i++) {
      const rel = join("blobs", `f${i}.txt`);
      writeFileSync(join(dir, rel), `fg621 filler ${i}\n`);
      paths.push(rel);
    }
    // One hash-object for all of them: ~0.15s for 4000, versus a fork each.
    const r = spawnSync("git", ["-C", dir, "hash-object", "-w", "--stdin-paths"], {
      encoding: "utf8",
      input: `${paths.join("\n")}\n`,
    });
    assert.equal(r.status, 0, `bulk hash-object failed: ${r.stderr}`);
    rmSync(blobs, { recursive: true, force: true });
  }
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

/** A docker stub that passes every prerequisite and, on `run`, emits `log`.
 *  `sideEffect` is shell run before the log — it stands in for whatever the
 *  container did to the host while the script was not looking, and so is the
 *  only way to drive the before/after comparison down its unequal branch. */
function cannedLogStub(log: string, sideEffect = ""): string {
  return [
    `case "$1" in`,
    `  info) exit 0 ;;`,
    `  image) exit 0 ;;`,
    `  version) echo "stub" ; exit 0 ;;`,
    `  run)`,
    sideEffect,
    `    cat <<'FG621_CANNED_LOG'`,
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
    // Per LINE, because that is how the container's probe() prefixes output —
    // a multi-line `out` here is a probe that printed multi-line output, not a
    // malformed record.
    for (const line of e.out.split("\n")) lines.push(`PROBE_OUT ${e.id} | ${line}`);
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

test("FG-621 smoke supplies the container NOTHING git-related — the evidence must measure the product, not itself", () => {
  // The defect this guards: an earlier revision exported GIT_AUTHOR_*/
  // GIT_COMMITTER_* into the container, so the AC 11 commit probe reported
  // SUCCESS while a real mutating dispatch died with "Author identity unknown".
  // An evidence script that supplies what it is meant to be proving is worse
  // than no evidence, because it reads as a pass.
  for (const forbidden of [
    /-e "GIT_AUTHOR_/,
    /-e "GIT_COMMITTER_/,
    /-e "GIT_CONFIG_/,
    /-e "EMAIL=/,
  ]) {
    assert.doesNotMatch(SCRIPT_SRC, forbidden, `the script must not hand the container ${forbidden.source}`);
  }
  // And the fixture must be the PRODUCT's workspace, not a hand-rolled clone —
  // that is what makes the identity the container finds forge's own.
  assert.match(SCRIPT_SRC, /createTaskClone/, "the fixture clone must be built by forge's own constructor");
  assert.doesNotMatch(SCRIPT_SRC, /^git clone --quiet --shared/m, "no hand-rolled clone may stand in for it");
  assert.match(SCRIPT_SRC, /expect_success p7_agent_commit_identity/, "and the commit's identity must be adjudicated");
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

// ── size-dependent death: the blind spot every case above shared ─────────────
//
// THE DEFECT THESE EXIST FOR. The script used `find … | head -n 1`,
// `diff … | head -n 5` and `printf '%s' "$out" | grep -q`. Every one of those
// readers exits as soon as it has what it needs and closes the pipe; the writer
// then takes SIGPIPE. Under the script's `set -euo pipefail` that is a 141 the
// shell reads as a failed command — so on /project the script died at the first
// one and produced ZERO bytes of output, having never run a container.
//
// It is SIZE-DEPENDENT, and that is precisely why sixteen green tests above did
// not catch it: makeParentRepo() holds four objects, find finishes writing
// before head exits, and no one takes a signal. A test that only drives the
// small case re-creates the exact blind spot.
//
// So each case below drives ONE reader at a scale where the writer is provably
// still producing output when the reader would have gone away, and states the
// scale and the reason inline. The numbers are sized against the pipe buffer —
// 64 KiB on Linux, 16 KiB on macOS — because a writer whose whole output fits
// in the buffer never blocks and so never notices the reader left.

/** Loose objects for the first-object find. 4000 paths of ~110 bytes is ~440 KB
 *  of find output — ~7x a Linux pipe buffer, ~27x a macOS one — so find is still
 *  walking when `head -n 1` would have exited, on any host. Costs ~0.15s. */
const SIGPIPE_OBJECT_COUNT = 4000;

/** Parent refs and objects the "container" adds behind the script's back. 60 of
 *  each makes both before/after diffs far longer than the 5 lines the detail
 *  prints, which is the only condition under which `diff | head -n 5` breaks. */
const SIGPIPE_MUTATION_COUNT = 60;

/** Lines of probe output. 2000 x ~80 bytes is ~160 KB — over 2x a Linux pipe
 *  buffer — so `printf | grep -q` blocks with the match already consumed. */
const SIGPIPE_OUT_LINES = 2000;

test("FG-621 smoke survives an object store large enough to SIGPIPE the first-object find", () => {
  // Drives the prerequisite at line ~126 against ~4004 object files rather than
  // four. Before the fix this exited 141 with zero output, never reaching the
  // container at all — the reproduction from the ticket, at fixture scale.
  const { negatives, positives } = probeIds();
  const log = cannedLog([
    ...positives.map((id) => ({ id, rc: 0, out: "ok" })),
    ...negatives.map((id) => ({ id, rc: 1, out: "fatal: not a git repository" })),
  ]);
  const parent = makeParentRepo(SIGPIPE_OBJECT_COUNT);
  try {
    const r = runScript(["--project-dir", parent], { PATH: stubDockerPath(cannedLogStub(log)) });
    assert.notEqual(r.status, 141, "SIGPIPE: a reader closed the pipe on a writer that was still going");
    assert.ok(r.stdout.length > 0, "the script produced NO output at all — it died before adjudicating anything");
    assert.match(r.stdout, /Paste everything between the fences into FG-621/);

    // Not just "it survived": it adjudicated against the large store. The h4
    // label carries the file count it actually compared.
    const m = /parent object store file list identical before\/after \((\d+) files\)/.exec(r.stdout);
    assert.ok(m, "the object-store verdict must name the store it compared");
    assert.ok(
      Number(m[1]) >= SIGPIPE_OBJECT_COUNT,
      `expected >=${SIGPIPE_OBJECT_COUNT} object files in the comparison, saw ${m[1]}`,
    );
    for (const id of negatives) assert.match(r.stdout, new RegExp(`${id}\\s+PASS\\s+refused`), `${id} must adjudicate`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FG-621 smoke REPORTS a parent that was modified, even when the diff is long", () => {
  // The container writes 60 refs and 60 objects into the parent while the script
  // is between its before and after snapshots. That is the AC 2 catastrophe —
  // the one outcome that must never be misreported — and it is ALSO the only
  // case in which the diff runs past `head -n 5`. Before the fix the detail
  // lines died twice over: SIGPIPE from head, and diff's own "they differ"
  // status reaching errexit through pipefail. Either killed the script before
  // it could say the parent had been touched.
  const { negatives, positives } = probeIds();
  const log = cannedLog([
    ...positives.map((id) => ({ id, rc: 0, out: "ok" })),
    ...negatives.map((id) => ({ id, rc: 1, out: "fatal: not a git repository" })),
  ]);
  const parent = makeParentRepo();
  const mutate = [
    `    for i in $(seq 1 ${SIGPIPE_MUTATION_COUNT}); do`,
    `      git -C '${parent}' update-ref "refs/heads/fg621-intruder-$i" HEAD`,
    `      printf 'fg621 intruder %s\\n' "$i" | git -C '${parent}' hash-object -w --stdin >/dev/null`,
    `    done`,
  ].join("\n");
  try {
    const r = runScript(["--project-dir", parent], { PATH: stubDockerPath(cannedLogStub(log, mutate)) });
    assert.notEqual(r.status, 141, "SIGPIPE: the long-diff path killed the script instead of reporting");
    assert.notEqual(r.status, 0, "a parent that was written to must never exit 0");
    assert.match(r.stdout, /Paste everything between the fences into FG-621/, "the operator must still get evidence");
    assert.match(r.stdout, /h1_parent_refs_unchanged\s+FAIL/, "the modified ref listing must be reported");
    assert.match(r.stdout, /h4_parent_object_store_unchanged\s+FAIL/, "the modified object store must be reported");
    // And the detail must be non-empty — a fix that merely stopped dying while
    // reporting an empty diff would be no better for the operator reading this.
    assert.match(r.stdout, /h1_parent_refs_unchanged\s+FAIL.*fg621-intruder-/, "the detail must name what changed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FG-621 smoke recognises a refusal buried in thousands of lines of probe output", () => {
  // The refusal message is on line 1 of 2000, which is the worst case for
  // `printf '%s' "$out" | grep -q`: grep matches immediately and exits, printf
  // takes SIGPIPE, pipefail makes the pipeline nonzero — and because it sits in
  // an `if` condition, errexit does NOT fire. The refusal silently reads as NO
  // refusal and every AC 2 negative flips to FAIL. Fails safe, reports wrong.
  const { negatives, positives } = probeIds();
  const noise = Array.from({ length: SIGPIPE_OUT_LINES }, (_, i) => `noise ${i} ${"x".repeat(64)}`);
  const log = cannedLog([
    // "commit" first for the same reason: it is what expect_success's own
    // `grep -qF "$want"` is looking for, so grep leaves the pipe immediately.
    ...positives.map((id) => ({ id, rc: 0, out: ["commit", ...noise].join("\n") })),
    ...negatives.map((id) => ({ id, rc: 1, out: ["fatal: not a git repository", ...noise].join("\n") })),
  ]);
  const parent = makeParentRepo();
  try {
    const r = runScript(["--project-dir", parent], { PATH: stubDockerPath(cannedLogStub(log)) });
    assert.notEqual(r.status, 141);
    for (const id of negatives) {
      assert.match(
        r.stdout,
        new RegExp(`${id}\\s+PASS\\s+refused rc=1: fatal: not a git repository`),
        `${id}: a real refusal must be recognised regardless of how much the probe printed`,
      );
    }
    // The one-line summary must be the FIRST line, not the whole 2000-line dump.
    assert.doesNotMatch(r.stdout, /refused rc=1:.*noise 0/, "the verdict must carry one line, not the whole output");
    // The positive side of the same reader: expect_success's substring check.
    // (p4/p7 want values this canned log cannot know, so they stay unasserted.)
    assert.match(
      r.stdout,
      /p3_parent_object_readable\s+PASS\s+ok rc=0: commit/,
      "a wanted substring must be found regardless of how much followed it",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("FG-621 smoke builds no pipe whose reader can exit before its writer", () => {
  // A structural backstop for the three cases above: they prove today's readers
  // are safe at scale, this stops a new `| head` / `| grep -q` from being added
  // back. The whole class is "reader exits early, writer takes SIGPIPE, pipefail
  // + errexit kills a script that had already got the right answer".
  const host = SCRIPT_SRC.replace(/^CONTAINER_SCRIPT=\$\(cat <<'CEOF'$[\s\S]*?^CEOF$/m, "");
  const offenders = host
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    // `[^|]` so an `||` list — two pipe CHARACTERS, no pipeline — is not a hit.
    .filter((l) => /[^|]\|\s*(head|grep\s+-[A-Za-z]*q)\b/.test(l));
  assert.deepEqual(offenders, [], "pipe into an early-exiting reader — use a here-string or -print -quit");
  assert.match(SCRIPT_SRC, /-print -quit/, "the first-object find must stop itself rather than be stopped by head");
  assert.match(SCRIPT_SRC, /set -euo pipefail/, "and the fix must not have been to weaken the error handling");
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
