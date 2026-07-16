// FG-535: the PRODUCTION launch path, end to end — the real `forge launch` CLI
// (Commander parsing, human + --json rendering) driving a REAL tmux server that
// really owns the process. Nothing here is stubbed: the sibling
// launch.integration.test.ts injects a TmuxRunner to pin record-keeping, but a
// stub cannot prove the two things FG-535 actually turns on — that tmux keeps
// the work alive after the submitter is gone, and that a signal-killed command
// is distinguishable from one that merely returned 143.
//
// Requires tmux (present on ubuntu-latest, where the extended tier runs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWrapperCommand, LAUNCHES_DIR, startLaunch, type LaunchView, type TmuxRunner } from "./launch.js";
import { buildRelease, thawReleaseTree, type BuildReleaseResult } from "./release.js";
import { findGitRoot } from "../util/git-root.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const started: string[] = [];

function forge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], { encoding: "utf8" });
}

function launchRun(name: string, command: string[]): LaunchView {
  const res = forge(["launch", "run", "--name", name, "--json", "--", ...command]);
  assert.equal(res.status, 0, `forge launch run failed: ${res.stderr}`);
  const meta = JSON.parse(res.stdout) as LaunchView;
  started.push(meta.id);
  return meta;
}

function show(id: string): LaunchView {
  const res = forge(["launch", "show", id, "--json"]);
  assert.equal(res.status, 0, `forge launch show failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as LaunchView;
}

function tmuxSessionAlive(session: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8" }).status === 0;
}

/** Poll a real, out-of-process condition — the tmux-owned command is nobody's
 *  child here, so there is nothing to await. */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

before(() => {
  assert.ok(hasTmux, "these tests require tmux — install it (apt install tmux / brew install tmux)");
});

after(() => {
  for (const id of started) forge(["launch", "rm", id, "--force"]);
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

test("FG-535 CLI: a FAST command keeps its durable record and its inspectable pane (remain-on-exit is armed before the command runs)", async () => {
  // The regression this pins: when the target command was the session's own
  // command, a command that finished immediately destroyed the session before
  // remain-on-exit could be set — set-option then threw, and the error path
  // DELETED the launch record of a command that had actually run to completion.
  const meta = launchRun("fast", ["sh", "-c", "echo done-fast"]);

  await waitFor("the fast command's exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const v = show(meta.id);
  assert.deepEqual(v.status, { state: "exited_ok", code: 0 }, "the completed command has a terminal record");
  assert.equal(readFileSync(v.logPath, "utf8").trim(), "done-fast");
  assert.ok(tmuxSessionAlive(meta.tmuxSession), "remain-on-exit kept the dead pane inspectable");
});

test("FG-535 tmux: a command that finishes BEFORE remain-on-exit could be armed still keeps its record", async () => {
  // The regression, forced rather than raced. When the target command WAS the
  // session's own command, a command that finished before `set-option` landed
  // destroyed the session; set-option then threw and the error path DELETED the
  // record of a command that had run to completion. Racing a fast command can't
  // prove this reliably (node's own startup usually wins the race), so this
  // stretches the window the way a loaded host would: real tmux, real process
  // ownership, with the set-option call delayed a full second. Under the
  // bootstrap-pane sequence the delay is harmless — the inert pane cannot exit,
  // so there is no window to lose.
  const slowSetOption: TmuxRunner = (args) => {
    if (args[0] === "set-option") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    execFileSync("tmux", args, { stdio: ["ignore", "ignore", "pipe"] });
  };

  const meta = startLaunch(["sh", "-c", "echo instant"], { name: "slowarm", tmux: slowSetOption });
  started.push(meta.id);

  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
  const v = show(meta.id);
  assert.deepEqual(v.status, { state: "exited_ok", code: 0 }, "the completed command kept a terminal record");
  assert.equal(readFileSync(v.logPath, "utf8").trim(), "instant");
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id, "meta.json")), "the record was not deleted by a failed set-option");
  assert.ok(tmuxSessionAlive(meta.tmuxSession), "remain-on-exit was armed before the command could ever run");
});

test("FG-535 CLI: tmux owns the process — it outlives the submitting CLI call, which returns at once", async () => {
  const pidFile = join(tmpdir(), `fg535-own-${process.pid}.pid`);
  rmSync(pidFile, { force: true });

  const before = Date.now();
  const meta = launchRun("owned", ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`]);
  const submitMs = Date.now() - before;

  // The submitting call is synchronous and short — it never owns the work.
  assert.ok(submitMs < 15_000, `forge launch run should return promptly, took ${submitMs}ms`);

  await waitFor("the launched command to report its pid", () => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8").trim());

  // The submitter has already exited; the command is still running, and it is
  // NOT a descendant of this test process — the tmux server owns it.
  process.kill(pid, 0);
  assert.equal(show(meta.id).status.state, "running");
  assert.ok(tmuxSessionAlive(meta.tmuxSession));

  const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  assert.notEqual(Number(ppid), process.pid, "the launched process is not this process's child");

  rmSync(pidFile, { force: true });
});

test("FG-535 CLI: the persisted owner pid names the REAL live process that owns the command", async () => {
  const meta = launchRun("ownerpid", ["sleep", "300"]);

  // The record is only useful for attribution if the pid it names is the actual
  // owner: alive, owned by the tmux server, and not a child of the submitter
  // (which has already exited).
  assert.ok(typeof meta.ownerPid === "number" && meta.ownerPid > 0, `owner pid was not recorded: ${meta.ownerPid}`);
  process.kill(meta.ownerPid!, 0);

  const paneOwner = spawnSync("tmux", ["display-message", "-p", "-t", `${meta.tmuxSession}:`, "#{pane_pid}"], { encoding: "utf8" });
  assert.equal(Number(paneOwner.stdout.trim()), meta.ownerPid, "the record names the pane tmux itself owns");

  const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(meta.ownerPid)], { encoding: "utf8" }).stdout.trim();
  assert.notEqual(Number(ppid), meta.launcherPid, "the owner is not a child of the launcher");

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, new RegExp(`owner:\\s+pid ${meta.ownerPid} \\(tmux pane\\)  launched by pid ${meta.launcherPid}`));
  assert.equal(show(meta.id).status.state, "running");
});

test("FG-535 CLI: a REAL SIGTERM records WIFSIGNALED evidence and still refuses to name a sender", async () => {
  const pidFile = join(tmpdir(), `fg535-term-${process.pid}.pid`);
  rmSync(pidFile, { force: true });
  const meta = launchRun("termed", ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`]);

  await waitFor("the launched command to report its pid", () => existsSync(pidFile));
  process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGTERM");

  await waitFor("the terminal record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  // The kernel's verdict, not a guess from a 143-shaped number.
  assert.deepEqual(JSON.parse(readFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "utf8")), {
    code: null, signal: "SIGTERM",
  });
  assert.deepEqual(show(meta.id).status, { state: "signaled", signal: "SIGTERM", sender: "unrecorded" });

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, /terminated by SIGTERM/);
  assert.match(human.stdout, /sender not recorded — origin unknown/,
    "FG-535 AC: attribution stays unknown when the signal sender was never captured");

  rmSync(pidFile, { force: true });
});

test("FG-535 CLI: killing the OWNER itself (the wrapper, SIGKILL — no exit record possible) reads owner_gone, not running-forever", async () => {
  const meta = launchRun("ownerkill", ["sleep", "300"]);
  assert.ok(typeof meta.ownerPid === "number" && meta.ownerPid > 0, `owner pid was not recorded: ${meta.ownerPid}`);

  // SIGKILL the wrapper: it cannot run any handler, so the exit record is
  // never written — the exact shape a harness sweep of the pane's process
  // leaves behind. remain-on-exit keeps the session alive holding a dead pane.
  process.kill(meta.ownerPid!, "SIGKILL");
  await waitFor("the dead pane to be classified", () => show(meta.id).status.state === "owner_gone");

  assert.ok(!existsSync(join(LAUNCHES_DIR, meta.id, "exit")), "precondition: no exit record was ever written");
  assert.ok(tmuxSessionAlive(meta.tmuxSession), "precondition: the session itself is still alive (remain-on-exit)");
  assert.deepEqual(show(meta.id).status, { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" });

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, /owner gone without an exit record \(wrapper killed, or failed before recording — cause and sender not recorded\)/);

  // Terminal-by-evidence, so cleanup no longer demands --force.
  const rm = forge(["launch", "rm", meta.id]);
  assert.equal(rm.status, 0, `rm of a terminated owner must not need --force: ${rm.stderr}`);
  assert.ok(!tmuxSessionAlive(meta.tmuxSession));
});

test("FG-535 CLI: a wrapper that FAILS its last-act write (I/O failure, no kill at all) also reads owner_gone — which is why the claim stays indeterminate", async () => {
  const meta = launchRun("iofail", ["sleep", "2"]);
  // Force the exit-record write to fail: the log fd is already open (appends
  // keep working), but a read-only launch dir makes the exit writeFileSync
  // throw — the wrapper then exits NORMALLY, never killed by anyone.
  execFileSync("chmod", ["555", join(LAUNCHES_DIR, meta.id)]);

  await waitFor("the dead pane to be classified", () => show(meta.id).status.state === "owner_gone", 30_000);
  assert.ok(!existsSync(join(LAUNCHES_DIR, meta.id, "exit")), "no exit record could be written");
  assert.deepEqual(show(meta.id).status, { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" },
    "identical evidence shape to a killed wrapper — so the status must not claim a termination");

  execFileSync("chmod", ["755", join(LAUNCHES_DIR, meta.id)]); // let cleanup remove it
});

test("FG-535 CLI: a command that DELIBERATELY exits 143 is not reported as a kill", async () => {
  const meta = launchRun("selfexit", ["sh", "-c", "exit 143"]);
  await waitFor("the terminal record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  assert.deepEqual(show(meta.id).status, { state: "terminated_unattributed", code: 143 });

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, /no signal evidence — origin unknown/);
  assert.doesNotMatch(human.stdout, /SIGTERM/, "exit 143 alone must never be read as a SIGTERM");
});

test("FG-535 CLI: list and show render the operator surface, and rm cleans up", async () => {
  const meta = launchRun("listed", ["sh", "-c", "echo hello from run-abc-123 task-engineer-9f"]);
  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const list = forge(["launch", "list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${meta.id}\\s+exited 0`), list.stdout);

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, new RegExp(`launch:\\s+${meta.id}`));
  assert.match(human.stdout, /status:\s+exited 0/);
  assert.match(human.stdout, /runs:\s+run-abc-123/, "forge ids are surfaced from the log");
  assert.match(human.stdout, /tasks:\s+task-engineer-9f/);
  assert.match(human.stdout, /log tail/);

  // The machine surface an orchestrator polls between turns.
  const json = show(meta.id);
  assert.deepEqual(json.command, ["sh", "-c", "echo hello from run-abc-123 task-engineer-9f"]);
  assert.deepEqual(json.forgeIds, { runIds: ["run-abc-123"], taskIds: ["task-engineer-9f"] });
  assert.ok(json.startedAt && json.tmuxSession && json.logPath && json.cwd);

  const rm = forge(["launch", "rm", meta.id]);
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(!existsSync(join(LAUNCHES_DIR, meta.id)), "the record is gone");
  assert.ok(!tmuxSessionAlive(meta.tmuxSession), "the remain-on-exit pane is cleaned up");
});

test("FG-569 R2 (END-TO-END through a BUILT release): forge launch show surfaces the recorder's provenance in BOTH --json and human output", async () => {
  // The R1 operator-surface test above checks only pre-FG-569 fields; the R2
  // end-to-end test (launch-r2.integration.test.ts) reads runtime.json DIRECTLY,
  // never through the CLI. This closes the gap: BUILD a real release, launch through
  // its generated entry (which exports FORGE_RELEASE_ID from its own manifest — no
  // hand-injected env), and assert the recorder provenance the whole way through the
  // OPERATOR SURFACE — `forge launch show --json` and the human `recorder:` line.
  const relParent = mkdtempSync(join(tmpdir(), "fg569-show-release-"));
  const releaseDir = join(relParent, "release");
  let built: BuildReleaseResult;
  try {
    built = buildRelease({ sourceRoot: findGitRoot(process.cwd()), home: join(relParent, "build-home"), outDir: releaseDir });
  } catch (e) {
    // A dirty/non-git source can't be built into a release (assertCommitDescribesTree);
    // that is an environment precondition, not a launch-surface regression.
    thawReleaseTree(relParent);
    rmSync(relParent, { recursive: true, force: true });
    assert.fail(`could not build a release to drive the operator surface: ${(e as Error).message}`);
  }

  try {
    // Launch THROUGH the built entry so FORGE_RELEASE_ID is exported by the entry
    // from its manifest, into the SAME FORGE_HOME the forge() CLI reads back.
    const run = spawnSync(built.entryPath, ["launch", "run", "--name", "r2show", "--json", "--", "true"], { encoding: "utf8", env: process.env });
    assert.equal(run.status, 0, `forge launch run through the release entry failed: ${run.stderr}`);
    const meta = JSON.parse(run.stdout) as LaunchView;
    started.push(meta.id);

    // Poll the OPERATOR SURFACE (not runtime.json) for the recorder record.
    await waitFor("recorder provenance to appear in show --json", () => show(meta.id).recorder !== undefined);
    const v = show(meta.id);
    assert.ok(v.recorder, "forge launch show --json surfaces the recorder's runtime");
    // execPath: the recorder ran under the release's PINNED interpreter. realpath both
    // sides — the recorder canonicalizes process.execPath (macOS /var → /private/var).
    assert.equal(realpathSync(v.recorder!.execPath), realpathSync(built.manifest.interpreter), "recorder.execPath is the release's pinned interpreter");
    assert.equal(v.recorder!.abi, process.versions.modules, "recorder.abi is the running ABI");
    assert.equal(v.recorder!.releaseId, built.manifest.id, "recorder.releaseId is the release's manifest id — reached via the CLI, sourced from the entry's manifest");
    assert.notEqual(v.recorder!.releaseId, null, "R2 release-id is live for a real release, not the null the bug shipped");

    // The HUMAN surface renders the recorder line with the same provenance.
    const human = forge(["launch", "show", meta.id]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`recorder:\\s+\\S+\\s+abi ${v.recorder!.abi} \\(node ${process.version.replace(/\./g, "\\.")}\\)`), "human output carries the recorder execPath + abi line");
    assert.match(human.stdout, new RegExp(`release ${built.manifest.id}`), "human recorder line names the release id");
  } finally {
    thawReleaseTree(relParent);
    rmSync(relParent, { recursive: true, force: true });
  }
});

test("FG-569 R1 (release A submits, DISTINGUISHABLE recorder): forge launch show surfaces R1 (A) and R2 (distinct) SEPARATELY — in --json AND human, never merged, R1 never inferred from R2", async () => {
  // The mutant this kills is the R1 mirror of the R2 one: "infer R1 from R2 (read
  // the submitter's identity off the recorder)". A launch is submitted by a BUILT
  // release A — so R1 = release A's CLI identity (its pinned interpreter, id, commit),
  // captured inside release A's process at submission. The recorder is then made a
  // GENUINELY DIFFERENT runtime (a copied interpreter, a distinct baked release id) —
  // the same two-interpreter setup the R2 tests use. If the surface derived R1 from R2,
  // R1 would show the recorder's execPath/id; it must show release A's instead.
  const relParent = mkdtempSync(join(tmpdir(), "fg569-r1-release-"));
  const releaseDir = join(relParent, "release");
  let built: BuildReleaseResult;
  try {
    built = buildRelease({ sourceRoot: findGitRoot(process.cwd()), home: join(relParent, "build-home"), outDir: releaseDir });
  } catch (e) {
    thawReleaseTree(relParent);
    rmSync(relParent, { recursive: true, force: true });
    assert.fail(`could not build release A to submit the launch: ${(e as Error).message}`);
  }

  const altNode = join(relParent, "alt-node");
  try {
    // Submit the launch THROUGH release A's entry, into the test-scoped FORGE_HOME the
    // forge() CLI reads back. meta.json.control (R1) is captured inside release A's
    // process from release A's OWN manifest — authentic, not hand-written.
    const run = spawnSync(built.entryPath, ["launch", "run", "--name", "r1a", "--json", "--", "true"], { encoding: "utf8", env: process.env });
    assert.equal(run.status, 0, `forge launch run through release A failed: ${run.stderr}`);
    const meta = JSON.parse(run.stdout) as LaunchView;
    started.push(meta.id);

    // Wait for release A's own recorder to finish (its exit record), THEN replace
    // runtime.json (R2) with a recorder run under a genuinely DIFFERENT interpreter and
    // a DISTINCT baked release id — a copy of node, exactly the R2 two-interpreter setup.
    await waitFor("release A's recorder to finish", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
    copyFileSync(process.execPath, altNode);
    chmodSync(altNode, 0o755);
    assert.notEqual(realpathSync(altNode), realpathSync(process.execPath), "alt interpreter is a genuinely different path");
    const throwDir = mkdtempSync(join(relParent, "recorder-"));
    const rtPath = join(LAUNCHES_DIR, meta.id, "runtime.json");
    const wrapper = buildWrapperCommand(["true"], join(throwDir, "log"), join(throwDir, "exit"), rtPath, altNode, "release-B-recorder-distinct");
    const rec = spawnSync("/bin/sh", ["-c", wrapper], { encoding: "utf8", env: process.env });
    assert.equal(rec.status, 0, `distinct recorder failed: ${rec.stderr}`);

    // The OPERATOR SURFACE (--json): R1 and R2 are separate fields, each correct.
    const v = show(meta.id);
    assert.ok(v.control, "R1 (control) is surfaced");
    assert.ok(v.recorder, "R2 (recorder) is surfaced");
    assert.equal(v.control!.release.kind, "release", "R1 is release A's identity, kind release");
    assert.equal(v.control!.release.releaseId, built.manifest.id, "R1 releaseId is release A's manifest id");
    assert.equal(v.control!.release.kind === "release" && v.control!.release.commit, built.manifest.commit, "R1 commit is release A's commit");
    assert.equal(realpathSync(v.control!.execPath), realpathSync(built.manifest.interpreter), "R1 execPath is release A's pinned interpreter");
    assert.equal(realpathSync(v.recorder!.execPath), realpathSync(altNode), "R2 execPath is the DISTINCT recorder interpreter");
    assert.equal(v.recorder!.releaseId, "release-B-recorder-distinct", "R2 releaseId is the recorder's own baked id");
    // The kill: the two identities are DISTINCT. A surface inferring R1 from R2 cannot do this.
    assert.notEqual(realpathSync(v.control!.execPath), realpathSync(v.recorder!.execPath), "R1 and R2 execPaths differ");
    assert.notEqual(v.control!.release.releaseId, v.recorder!.releaseId, "R1 and R2 release ids differ");

    // The HUMAN surface: two distinct lines, control (R1) then recorder (R2).
    const human = forge(["launch", "show", meta.id]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`control:.*release ${built.manifest.id} \\(commit ${built.manifest.commit.slice(0, 7)}`), "human R1 line names release A's id + commit");
    assert.match(human.stdout, new RegExp(`recorder:.*release release-B-recorder-distinct`), "human R2 line names the distinct recorder id");
  } finally {
    thawReleaseTree(relParent);
    rmSync(relParent, { recursive: true, force: true });
  }
});

test("FG-569 R1 (DEV launch): forge launch show records R1 as the explicit dev/unversioned identity (kind dev, releaseId null); R2 is null-release", async () => {
  // A dev CLI (bin/forge via the tsx entry — no release manifest) must record an
  // EXPLICIT dev marker, never a manufactured id and never omitted-as-if-release.
  const meta = launchRun("devr1", ["true"]);

  const v = show(meta.id);
  assert.ok(v.control, "R1 is recorded for a dev launch too — never dropped");
  assert.equal(v.control!.release.kind, "dev", "a dev CLI records kind dev");
  assert.equal(v.control!.release.releaseId, null, "dev R1 releaseId is explicitly null, not a manufactured id");
  assert.ok(typeof v.control!.execPath === "string" && v.control!.execPath.length > 0, "R1 still captures the dev CLI's own execPath");

  // R2: a dev launch's recorder records a null release too.
  await waitFor("the dev recorder to write its runtime", () => show(meta.id).recorder !== undefined);
  assert.equal(show(meta.id).recorder!.releaseId, null, "R2 release is null for a dev launch");

  const human = forge(["launch", "show", meta.id]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /control:.*dev \(unversioned\)/, "human R1 line marks a dev launch explicitly");
});

test("FG-569 R1 (OLD record, no R1 field): forge launch show displays R1 as not-recorded — never crashes, never manufactures an identity", () => {
  // A launch record written BEFORE FG-569 has no `control` field. The surface must
  // load it, say "not recorded", and never invent an execPath/release for it.
  const oldId = "launch-oldrec-legacy1";
  const oldDir = join(LAUNCHES_DIR, oldId);
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "meta.json"), JSON.stringify({
    id: oldId,
    command: ["forge", "review-loop", "FG-OLD"],
    tmuxSession: `forge-${oldId}`,
    launcherPid: 4242,
    ownerPid: 4243,
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: join(oldDir, "out.log"),
    cwd: "/project",
  }, null, 2));
  // A terminal exit record so the surface never needs a (nonexistent) tmux session.
  writeFileSync(join(oldDir, "exit"), `{"code":0,"signal":null}`);

  const human = forge(["launch", "show", oldId]);
  assert.equal(human.status, 0, `show of a pre-R1 record must not crash: ${human.stderr}`);
  assert.match(human.stdout, /control:\s+not recorded/, "R1 is shown as not-recorded for an old record");
  assert.doesNotMatch(human.stdout, /control:.*abi /, "no manufactured execPath/abi for an old record");

  const json = show(oldId);
  assert.equal(json.control, undefined, "no R1 field is manufactured in --json for a pre-R1 record");
});

test("FG-535 CLI: rm refuses a RUNNING launch without --force — removal must never be what kills the work", () => {
  const meta = launchRun("guarded", ["sleep", "300"]);

  const refused = forge(["launch", "rm", meta.id]);
  assert.notEqual(refused.status, 0, "removing a running launch must fail");
  assert.match(refused.stderr, /still running/);
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id)), "the record survives the refused removal");
  assert.ok(tmuxSessionAlive(meta.tmuxSession), "and so does the work");

  assert.equal(forge(["launch", "rm", meta.id, "--force"]).status, 0);
  assert.ok(!tmuxSessionAlive(meta.tmuxSession));
});
