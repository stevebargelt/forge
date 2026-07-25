// FG-614: the OPERATOR-observable contract when the tmux server's own cwd is gone.
//
// `fg614-launch-cwd.integration.test.ts` pins the mechanism (the wrapper's chdir, the
// probe, the diagnosis string, the guard's refusal). This file pins what an OPERATOR
// actually gets, driven through the real `forge launch` CLI against a real tmux server
// that is genuinely stuck in a deleted directory:
//
//   1. the diagnosis FIRES on the real condition and is COMPLETE — dead path, cause,
//      the "this launch is unaffected" clause, the remedy, and the remedy's COST. The
//      cost is the part that makes `tmux kill-server` safe to act on: without it the
//      operator is told to do something that silently kills live work.
//   2. the launch SUCCEEDS under that condition and the child genuinely runs in the
//      recorded cwd — the child's OBSERVED cwd, not merely a zero exit.
//   3. forge NEVER kills the server. The live session in the bricked server is still
//      there afterwards, still holding its process. The ticket forbids auto-killing.
//   4. `forge launch show` names the condition for such a launch, and does NOT invent
//      one for a launch submitted against a healthy server.
//   5. the probe DEGRADES HONESTLY: when the working directory cannot be read — or when
//      the probe command cannot be run at all — it is `unprobed` with a named reason,
//      never a false `missing` and never a `no_server` forge did not observe. Forced
//      here rather than waited for.
//
// The darwin (`lsof`) probe branch is platform-gated and cannot run in a Linux
// container; it was verified by hand on a macOS host during FG-614.
//
// Every tmux server started here lives on its OWN socket (TMUX_TMPDIR) and is killed on
// teardown — the discipline FG-614 exists to enforce.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHES_DIR, probeTmuxServerCwd, readLaunch, shellQuote, startLaunch, type LaunchMeta, type LaunchView, type TmuxRunner } from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const skipNoTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0 ? false : "tmux not available";

const scratch = mkdtempSync(join(tmpdir(), "fg614cond-"));
/** Socket dirs kept short and under /tmp: a unix socket path has a ~104-char limit. */
const sockets: string[] = [];

after(() => {
  for (const sock of sockets) {
    spawnSync("tmux", ["kill-server"], { stdio: "ignore", env: { ...process.env, TMUX_TMPDIR: sock } });
    rmSync(sock, { recursive: true, force: true });
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A tmux server on a socket of this test's own, started FROM `cwd` (so the server
 *  inherits it) with one session holding a LIVE process. */
function startIsolatedServer(cwd: string, session: string): { sock: string; tmux: TmuxRunner; pid: number } {
  const sock = mkdtempSync("/tmp/fg614c-");
  sockets.push(sock);
  const env = { ...process.env, TMUX_TMPDIR: sock };
  const start = spawnSync("tmux", ["new-session", "-d", "-s", session, "cat"], { cwd, env, encoding: "utf8" });
  assert.equal(start.status, 0, `the isolated tmux server should start: ${start.stderr}`);
  const tmux: TmuxRunner = (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
  const pid = Number(String(tmux(["display-message", "-p", "#{pid}"]) ?? "").trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "the isolated server reports a pid");
  return { sock, tmux, pid };
}

/** The real CLI an operator runs, pointed at one of this test's private sockets. */
function forgeCli(args: string[], opts: { cwd: string; sock: string }): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(tsx, [entry, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, TMUX_TMPDIR: opts.sock },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

const PRINT_CWD = [process.execPath, "-e", "process.stdout.write(process.cwd())"];

type Run = {
  serverCwd: string;
  recorded: string;
  sock: string;
  tmux: TmuxRunner;
  serverPid: number;
  session: string;
  cli: { status: number | null; stdout: string; stderr: string };
  meta: LaunchMeta;
  view: LaunchView;
};

/** ONE real launch, submitted through the CLI against a server whose own working
 *  directory has been deleted. Memoised: it is the single expensive fixture every
 *  operator-facing assertion below reads, and re-running it per test would multiply
 *  real tmux servers for no extra evidence. */
let brickedRun: Promise<Run> | undefined;
function launchOnBrickedServer(): Promise<Run> {
  brickedRun ??= (async (): Promise<Run> => {
    const fixture = mkdtempSync(join(scratch, "serverdir-"));
    const serverCwd = realpathSync(fixture);
    const session = "fg614-victim";
    const { sock, tmux, pid } = startIsolatedServer(fixture, session);
    // THE CONDITION: the server outlives the directory it was started from.
    rmSync(fixture, { recursive: true, force: true });
    assert.equal(existsSync(serverCwd), false, "the server's working directory is genuinely gone");

    const recorded = realpathSync(mkdtempSync(join(scratch, "recorded-")));
    const cli = forgeCli(["launch", "run", "--json", "--name", "fg614cond", "--", ...PRINT_CWD], { cwd: recorded, sock });
    assert.equal(cli.status, 0, `forge launch run must still submit on a bricked server: ${cli.stdout}${cli.stderr}`);
    const meta = JSON.parse(cli.stdout) as LaunchMeta;

    await waitFor("the launch's exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
    const view = readLaunch(meta.id, tmux);
    assert.ok(view, "the launch record is readable");
    return { serverCwd, recorded, sock, tmux, serverPid: pid, session, cli, meta, view: view! };
  })();
  return brickedRun;
}

// ── 1. the diagnosis fires on the real condition, and it is complete ─────────────

test("FG-614: on a REAL server stuck in a deleted directory, `forge launch run` prints the NAMED diagnosis — dead path, cause, the unaffected clause, the remedy, AND the remedy's cost", { skip: skipNoTmux }, async () => {
  const run = await launchOnBrickedServer();
  const err = run.cli.stderr;

  assert.match(err, /tmux server's own working directory no longer exists/, "the condition is named as the LAUNCHER's, not the child's");
  assert.ok(err.includes(run.serverCwd), `the dead directory is named verbatim so an operator can recognise it: ${err}`);
  assert.match(err, /cause: the long-lived tmux server inherited this directory/, "the cause is explained, not just asserted");
  assert.match(err, /uv_cwd/, "and connected to the error an operator actually sees");
  assert.match(err, /this launch is unaffected/, "the operator is told THIS launch is fine — otherwise the message reads as a failure");
  assert.match(err, /remedy/, "the remedy is given");
  assert.match(err, /tmux kill-server/, "…and it is stated exactly");

  // The COST is what makes the remedy safe to act on: `tmux kill-server` kills live
  // work, so a diagnosis that omits what it would take with it is not actionable.
  const cost = /kills (\d+) tmux session\(s\), (\d+) of which still hold a live process/.exec(err);
  assert.ok(cost, `the remedy must state what it COSTS, with real counts: ${err}`);
  assert.ok(Number(cost?.[1]) >= 1, "the session the remedy would kill is counted");
  assert.ok(Number(cost?.[2]) >= 1, "…and the live process inside it is counted as live work that dies with the server");
  assert.doesNotMatch(err, /could not count them/, "the counts were readable here, so the uncounted fallback must not be used");
  assert.match(err, /operator's call/, "the remedy is the operator's decision");
  assert.match(err, /forge will NOT restart your tmux server/, "and forge states that it will not act on its own");

  // The condition is RECORDED, not merely printed — a later reader can name it too.
  assert.equal(run.meta.tmuxServerCwd?.state, "missing", `the probe named the condition: ${JSON.stringify(run.meta.tmuxServerCwd)}`);
  assert.equal(run.meta.tmuxServerCwd?.state === "missing" ? run.meta.tmuxServerCwd.path : "", run.serverCwd);
  // …and it stayed on stderr: `--json` output an operator pipes is still just JSON.
  assert.equal(run.meta.id, JSON.parse(run.cli.stdout).id, "the diagnosis never contaminated --json stdout");
});

// ── 2. the launch succeeds, and the child really runs in the recorded cwd ────────

test("FG-614: that launch SUCCEEDS and the child genuinely runs in the RECORDED cwd — the observed cwd, not just a zero exit", { skip: skipNoTmux }, async () => {
  const run = await launchOnBrickedServer();

  assert.deepEqual(run.view.status, { state: "exited_ok", code: 0 }, "the launch is unaffected by the server's condition");
  assert.equal(run.meta.cwd, run.recorded, "forge recorded the directory the operator submitted from");
  assert.equal(
    readFileSync(run.view.logPath, "utf8").trim(),
    run.recorded,
    "the child OBSERVED itself in the recorded cwd — not the server's dead one, and not a fallback",
  );
  assert.doesNotMatch(readFileSync(run.view.logPath, "utf8"), /uv_cwd|process\.cwd failed/, "no uv_cwd trace is attributed to the launched command");
  assert.equal(run.view.diagnosis, undefined, "forge had nothing to refuse — the guard's diagnosis is for a launch that never started");
});

test("FG-614: the pane command startLaunch ACTUALLY hands tmux enters the recorded cwd — proven by running that exact command from a directory that has been deleted", async () => {
  // The end-to-end test above cannot prove this everywhere: on tmux 3.2a/Linux
  // `new-session -c <dir>` already places the pane correctly, so the launch lands in the
  // recorded cwd even with the guard removed. On the macOS tmux that produced the FG-614
  // incident it does NOT (verified by hand in the ticket), and there the guard is the
  // only thing that saves the launch. So the wiring is proven platform-independently
  // instead: take the pane command startLaunch really built — not one assembled by this
  // test — and run it from a genuinely deleted directory, the state a pane forked from a
  // bricked server inherits.
  const recorded = realpathSync(mkdtempSync(join(scratch, "wired-")));
  const dead = mkdtempSync(join(scratch, "deadcwd-"));
  let paneCommand = "";
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "respawn-pane") paneCommand = args[args.length - 1] ?? "";
    if (args[0] === "display-message") return "4242\n";
    return "";
  };

  const meta = startLaunch([process.execPath, "-e", "process.stdout.write(process.cwd())"], { name: "fg614wired", cwd: recorded, tmux });
  assert.ok(paneCommand !== "", "startLaunch handed tmux a pane command");

  // spawnSync cannot chdir INTO a deleted directory, so the condition is created from
  // inside the shell: enter it, delete it, then run the pane command with it as cwd.
  const r = spawnSync("/bin/sh", ["-c", `cd ${shellQuote(dead)} && rm -rf ${shellQuote(dead)} && ${paneCommand}`], { encoding: "utf8" });
  assert.equal(r.status, 0, `the pane command must survive a dead inherited cwd: ${r.stdout}${r.stderr}`);

  await waitFor("the launch's exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
  const view = readLaunch(meta.id, tmux)!;
  assert.deepEqual(view.status, { state: "exited_ok", code: 0 }, "the command ran to completion");
  const log = readFileSync(view.logPath, "utf8");
  assert.equal(log.trim(), recorded, "the child observed itself in the cwd startLaunch RECORDED, not the dead one it inherited");
  assert.doesNotMatch(log, /uv_cwd|process\.cwd failed/, "and no uv_cwd trace was ever attributed to the launched command");
});

// ── 3. forge never kills the server ──────────────────────────────────────────────

test("FG-614: forge NEVER kills the tmux server — the live session in the bricked server survives the launch untouched", { skip: skipNoTmux }, async () => {
  const run = await launchOnBrickedServer();

  const pidAfter = Number(String(run.tmux(["display-message", "-p", "#{pid}"]) ?? "").trim());
  assert.equal(pidAfter, run.serverPid, "the SAME server is still running — forge did not restart it behind the operator's back");

  const panes = String(run.tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_dead} #{pane_pid}"]) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const victim = panes.find((l) => l.startsWith(`${run.session} `));
  assert.ok(victim, `the pre-existing session must still exist: ${panes.join(" | ")}`);
  const [, dead, panePid] = victim!.split(" ");
  assert.equal(dead, "0", "…and its pane is not dead — the live process was not killed");
  assert.doesNotThrow(() => process.kill(Number(panePid), 0), "the live process inside that session is still running");
});

// ── 4. `forge launch show` names the condition — and does not invent one ─────────

test("FG-614: `forge launch show` renders the tmux-server condition recorded at submission, with the same remedy and cost", { skip: skipNoTmux }, async () => {
  const run = await launchOnBrickedServer();
  const show = forgeCli(["launch", "show", run.meta.id], { cwd: run.recorded, sock: run.sock });

  assert.equal(show.status, 0, `forge launch show failed: ${show.stderr}`);
  assert.match(show.stdout, /tmux server condition at submission/, "the section is rendered for a launch submitted under the condition");
  assert.ok(show.stdout.includes(run.serverCwd), "it names the directory the server is stuck in");
  assert.match(show.stdout, /tmux kill-server/, "it repeats the remedy");
  assert.match(show.stdout, /kills \d+ tmux session\(s\), \d+ of which still hold a live process/, "…with the cost, so `show` is as actionable as the submission");
  assert.match(show.stdout, /status:/, "and it is rendered alongside the ordinary record, not instead of it");
});

test("FG-614: `forge launch show` does NOT invent a server condition for a launch submitted against a HEALTHY server", { skip: skipNoTmux }, async () => {
  const healthy = realpathSync(mkdtempSync(join(scratch, "healthy-")));
  const { sock, tmux } = startIsolatedServer(healthy, "fg614-healthy");
  const recorded = realpathSync(mkdtempSync(join(scratch, "okrecorded-")));

  const cli = forgeCli(["launch", "run", "--json", "--name", "fg614ok", "--", ...PRINT_CWD], { cwd: recorded, sock });
  assert.equal(cli.status, 0, `${cli.stdout}${cli.stderr}`);
  const meta = JSON.parse(cli.stdout) as LaunchMeta;

  assert.equal(meta.tmuxServerCwd?.state, "ok", `a live server in a live directory probes ok: ${JSON.stringify(meta.tmuxServerCwd)}`);
  assert.doesNotMatch(cli.stderr, /working directory no longer exists|tmux kill-server/, "nothing alarming is printed for a healthy launcher");

  await waitFor("the healthy launch's exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
  const view = readLaunch(meta.id, tmux)!;
  assert.deepEqual(view.status, { state: "exited_ok", code: 0 });
  assert.equal(readFileSync(view.logPath, "utf8").trim(), recorded, "the child still runs in the recorded cwd — the chdir is unconditional, not a bricked-server special case");

  const show = forgeCli(["launch", "show", meta.id], { cwd: recorded, sock });
  assert.equal(show.status, 0, `forge launch show failed: ${show.stderr}`);
  assert.doesNotMatch(show.stdout, /tmux server condition at submission/, "no condition section is invented for a healthy launch");
  assert.doesNotMatch(show.stdout, /diagnosis \(forge/, "and forge claims no diagnosis it does not have");
});

// ── 5. the probe degrades honestly — forced, not waited for ──────────────────────

test("FG-614: when tmux does not report a usable server pid, the probe is `unprobed` with a reason — never a guessed `missing`", () => {
  for (const answer of ["not-a-pid\n", "", "0\n", "-1\n"]) {
    const probe = probeTmuxServerCwd({ tmux: () => answer });
    assert.equal(probe.state, "unprobed", `tmux answered ${JSON.stringify(answer)}: ${JSON.stringify(probe)}`);
    assert.match(probe.state === "unprobed" ? probe.reason : "", /tmux did not report a server pid/, "the reason is named, not blank");
  }
});

test("FG-614: when the server's working directory cannot be READ, the probe names the pid and the platform and reports `unprobed` — it never accuses a server it could not inspect", () => {
  // A pid that cannot exist on any platform, so procfs (linux) and lsof (darwin) both
  // fail — the same shape as a probe that is refused permission to read.
  const impossible = 2_147_483_647;
  const probe = probeTmuxServerCwd({ tmux: () => `${impossible}\n` });

  assert.equal(probe.state, "unprobed", `an unreadable pid must not become a claim: ${JSON.stringify(probe)}`);
  assert.match(probe.state === "unprobed" ? probe.reason : "", new RegExp(`could not read the working directory of tmux server pid ${impossible} on ${process.platform}`));
  // The two failure modes it must never collapse into: `ok` hides a real condition,
  // `missing` accuses an operator's healthy server on no evidence.
  assert.notEqual(probe.state, "missing");
  assert.notEqual(probe.state, "ok");
});

test("FG-614: on a platform whose process working directory forge cannot read, the probe is `unprobed` naming the platform — the darwin/linux branches are the only ones that ever claim anything", () => {
  // Control first: on THIS platform, the same stub (pointing at a live pid whose cwd
  // exists) probes `ok`. So the difference below is the platform, nothing else.
  const control = probeTmuxServerCwd({ tmux: () => `${process.pid}\n` });
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.equal(control.state, "ok", `a readable, existing cwd probes ok: ${JSON.stringify(control)}`);
  }

  // Forced in a child: the platform is a property of the whole process, and this test
  // process must keep its own.
  const script = join(scratch, "unsupported-platform-probe.ts");
  writeFileSync(
    script,
    [
      `import { probeTmuxServerCwd } from ${JSON.stringify(join(here, "launch.ts"))};`,
      `Object.defineProperty(process, "platform", { value: "sunos", configurable: true });`,
      `console.log(JSON.stringify(probeTmuxServerCwd({ tmux: () => String(process.pid) })));`,
    ].join("\n"),
  );
  const r = spawnSync(tsx, [script], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, `the probe must not throw on an unsupported platform: ${r.stdout}${r.stderr}`);

  const probe = JSON.parse(r.stdout.trim());
  assert.equal(probe.state, "unprobed", `an unsupported platform is stated, not guessed at: ${r.stdout}`);
  assert.match(probe.reason, /could not read the working directory of tmux server pid \d+ on sunos/, "the reason names the platform, so the gap is diagnosable");
});

// A failed `display-message` is two different facts, and `no_server` is only one of
// them: it is a POSITIVE CLAIM about the operator's host ("nothing is running there").
// Forge may make it only when tmux actually said so. The three tests below hold both
// branches apart — the ticket's own principle applied to the probe itself.

test("FG-614: a genuinely absent tmux server IS `no_server` — tmux ran, reached the socket, and reported nothing listening", { skip: skipNoTmux }, () => {
  const sock = mkdtempSync("/tmp/fg614n-");
  sockets.push(sock);
  const probe = probeTmuxServerCwd({
    tmux: (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, TMUX_TMPDIR: sock } }),
  });
  assert.deepEqual(probe, { state: "no_server" }, "a real observation of an empty socket dir is the one case that may claim no_server");
});

test("FG-614: a probe that CANNOT RUN is `unprobed` naming the command and the failure — never `no_server`, a claim about the host forge never verified", () => {
  // tmux unresolvable on PATH: the probe never reached a socket, so it observed nothing
  // about whether a server exists. Reported as the gap it is.
  const probe = probeTmuxServerCwd({
    tmux: (args) => execFileSync("tmux-fg614-not-on-path", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }),
  });

  assert.notEqual(probe.state, "no_server", "forge could not ask, so it must not answer for the operator's host");
  assert.equal(probe.state, "unprobed", `an unperformable probe is stated as such: ${JSON.stringify(probe)}`);
  const reason = probe.state === "unprobed" ? probe.reason : "";
  assert.match(reason, /could not run `tmux display-message -p '#\{pid\}'`/, "the reason names the command that failed");
  assert.match(reason, /ENOENT|not found/, "…and the underlying error, so the gap is diagnosable");
  // The other two it must never collapse into: `missing` accuses a healthy server,
  // `ok` hides a real condition. And it never throws out of the launch path.
  assert.notEqual(probe.state, "missing");
  assert.notEqual(probe.state, "ok");
});

test("FG-614: a socket directory forge cannot READ is `unprobed` too — the failure mode that looks most like an absent server and is not one", { skip: skipNoTmux }, (t) => {
  const sock = mkdtempSync("/tmp/fg614p-");
  sockets.push(sock);
  const env = { ...process.env, TMUX_TMPDIR: sock };
  const start = spawnSync("tmux", ["new-session", "-d", "-s", "fg614-perm", "cat"], { cwd: scratch, env, encoding: "utf8" });
  assert.equal(start.status, 0, `the isolated tmux server should start: ${start.stderr}`);
  const socketDir = join(sock, `tmux-${process.getuid?.() ?? 0}`);

  try {
    chmodSync(socketDir, 0o000);
    if (spawnSync("tmux", ["display-message", "-p", "#{pid}"], { env, encoding: "utf8" }).status === 0) {
      t.skip("this uid can read a 0000 directory (root), so the condition cannot be created here");
      return;
    }
    const probe = probeTmuxServerCwd({
      tmux: (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env }),
    });
    // A server IS running behind that directory — calling this `no_server` would be
    // flatly false, and the launch record would carry the falsehood.
    assert.notEqual(probe.state, "no_server", "the server exists; forge simply could not reach it");
    assert.equal(probe.state, "unprobed", `an unreadable socket dir is a gap, not a reading: ${JSON.stringify(probe)}`);
    assert.match(probe.state === "unprobed" ? probe.reason : "", /Permission denied/, "the reason names what actually failed");
  } finally {
    chmodSync(socketDir, 0o700);
  }
});
