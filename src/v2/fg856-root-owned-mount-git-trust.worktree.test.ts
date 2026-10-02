// FG-856 — Docker Desktop presents the bind-mounted project ROOT as uid 0 while
// its contents stay uid 1000, and the agent user's Git refuses the checkout as
// "dubious ownership"; the FG-559 entrypoint probe then exits 122 before any
// agent starts. Companion to the FG-559 files in this tier.
//
// Everything here runs REAL Git against a fixture whose root directory is really
// owned by another uid — no mocked error text. Making a directory owned by
// another uid needs root, so the suite uses passwordless sudo (GitHub runners and
// the agent image both have it). Without it the suite FAILS naming the missing
// capability; it never skips (FG-642).
//
// The trust exception under test is the one Forge actually ships: the env
// entries are taken from buildProvisionerDockerArgs for a runtime that mounts the
// project at the fixture's path, and the probe is the entrypoint's own text.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Runtime } from "./schema.js";
import { buildProvisionerDockerArgs, GIT_UNAVAILABLE_EXIT_CODE } from "./spawn.js";
import { invoke, type DockerExecFn } from "./invoke.js";
import { failureKindForTask } from "./failure-kind.js";
import { eventsForTask } from "../store/events.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const MY_UID = process.getuid!();
const MY_GID = process.getgid!();
const OTHER_UID = MY_UID === 0 ? 65534 : 0;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    spawnSync("sudo", ["-n", "chown", "-R", `${MY_UID}:${MY_GID}`, d]);
    rmSync(d, { recursive: true, force: true });
  }
});

function requireSudo(): void {
  const r = spawnSync("sudo", ["-n", "true"], { encoding: "utf8" });
  if (r.status !== 0) {
    assert.fail(
      "FG-856 regression needs passwordless sudo to make a fixture root owned by another uid (FG-642: never skip " +
        `silently). \`sudo -n true\` exited ${r.status}: ${r.stderr ?? r.error?.message ?? ""}`,
    );
  }
}

/** Own exactly `dir` (not its contents) by another uid — the Docker Desktop shape. */
function chownToOther(dir: string): void {
  const r = spawnSync("sudo", ["-n", "chown", `${OTHER_UID}:${OTHER_UID}`, dir], { encoding: "utf8" });
  assert.equal(r.status, 0, `sudo chown ${dir}: ${r.stderr}`);
}

/** No ambient Git config may grant (or deny) the trust under test. */
function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const k of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k) || ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].includes(k)) {
      delete env[k];
    }
  }
  return { ...env, ...extra };
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: cleanGitEnv(env) });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, ...args: string[]): void {
  const r = run("git", args, cwd);
  assert.equal(r.code, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
}

/** The env Forge's launcher hands a container whose project mount lands at
 *  `mountPath` — read off the real builder, not restated here. */
function launcherTrustEnv(mountPath: string): Record<string, string> {
  const runtime: Runtime = {
    name: "fg856",
    description: "fg856",
    image: "agent-dev-worker:latest",
    models: { default: "m" },
    auth: { mode: "apikey" },
    env: {},
    mounts: [{ host: "${PROJECT_DIR}", container: mountPath, mode: "ro", optional: false }],
    invocation: { command: "true", args: [] },
    container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
    result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
  } as Runtime;
  const args = buildProvisionerDockerArgs(
    runtime,
    { TASK_ID: "fg856", PROJECT_DIR: "/nonexistent-fg856-project" },
    { lockfileHash: "fg856", volumes: [], installRoot: mountPath },
  );
  const env: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i - 1] !== "-e" || !args[i]!.startsWith("GIT_CONFIG_")) continue;
    const eq = args[i]!.indexOf("=");
    env[args[i]!.slice(0, eq)] = args[i]!.slice(eq + 1);
  }
  assert.ok(env["GIT_CONFIG_COUNT"], "the launcher must emit the trust entry at all");
  return env;
}

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg856-")));
  tmpDirs.push(base);
  return base;
}

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  gitOk(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "file.txt"), "revision 1\n");
  gitOk(path, "add", ".");
  gitOk(path, "-c", "user.email=t@forge.test", "-c", "user.name=Forge Test", "commit", "-q", "-m", "commit 1");
}

/** The entrypoint's FG-559/FG-856 probe, sliced out of the FILE so the test runs
 *  what the image runs (precedent: fg559-worktree-git-enforcement). */
function entrypointProbe(): string {
  const lines = readFileSync(join(REPO_ROOT, "docker/agent-entrypoint.sh"), "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes("# FG-559: prove git actually RESOLVES"));
  assert.ok(start >= 0, "agent-entrypoint.sh lost the FG-559 probe anchor");
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'exec "$@"');
  assert.ok(end > start, 'agent-entrypoint.sh lost the exec "$@" end anchor');
  const block = lines.slice(start, end).join("\n");
  assert.match(block, /exit 122/);
  return block;
}

function runProbe(cwd: string, env: Record<string, string> = {}) {
  return run("bash", ["-c", entrypointProbe()], cwd, env);
}

const OWNERSHIP_DIAGNOSIS = /another uid[\s\S]*FG-856[\s\S]*docker\/build\.sh[\s\S]*do not chown/;
const WORKTREE_ADVICE = /parent \.git is not mounted \(FG-559\)/;

// ─── 1. Ordinary checkout, root-owned root ───────────────────────────────────

test("fg856: a root-owned checkout root fails git without the exception, passes with it for EXACTLY that path, and not for any other", () => {
  requireSudo();
  const base = newBase();
  const repo = join(base, "project");
  makeRepo(repo);
  chownToOther(repo);

  const bare = run("git", ["rev-parse", "--git-dir"], repo);
  assert.notEqual(bare.code, 0, "the regression must reproduce: a differently owned root is refused");
  assert.match(bare.stderr, /dubious ownership/);

  const trusted = launcherTrustEnv(repo);
  const ok = run("git", ["rev-parse", "--git-dir"], repo, trusted);
  assert.equal(ok.code, 0, `the launcher's exact-path entry must make git resolve: ${ok.stderr}`);
  const log = run("git", ["log", "--oneline"], repo, trusted);
  assert.equal(log.code, 0, `later git commands are covered too, not only the probe: ${log.stderr}`);
  assert.match(log.stdout, /commit 1/);

  for (const other of [`${repo}-other`, base]) {
    const r = run("git", ["rev-parse", "--git-dir"], repo, launcherTrustEnv(other));
    assert.notEqual(r.code, 0, `trusting ${other} must NOT cover ${repo}`);
    assert.match(r.stderr, /dubious ownership/);
  }
  // A root or non-normalized mount path never reaches git: the launcher refuses it.
  for (const broad of [`${base}/`, "/"]) {
    assert.throws(() => launcherTrustEnv(broad), /FG-856: refusing Git trust/, broad);
  }
});

test("fg856: the image's system-scope line trusts exactly /project, and system scope is honored by this git", () => {
  requireSudo();
  const dockerfile = readFileSync(join(REPO_ROOT, "docker/agent-dev-worker.Dockerfile"), "utf8");
  const lines = dockerfile.split("\n").filter((l) => /safe\.directory/.test(l) && /^\s*RUN\b/.test(l));
  assert.deepEqual(lines, ["RUN git config --system --add safe.directory /project"]);
  assert.doesNotMatch(dockerfile, /safe\.directory\s+["']?\*/, "never trust every repository");

  // Same command shape, against a scratch system file and the fixture's path.
  const base = newBase();
  const repo = join(base, "project");
  makeRepo(repo);
  chownToOther(repo);
  const systemFile = join(base, "gitconfig-system");
  writeFileSync(systemFile, "");
  const add = run("git", ["config", "--system", "--add", "safe.directory", repo], base, { GIT_CONFIG_SYSTEM: systemFile });
  assert.equal(add.code, 0, add.stderr);
  const r = run("git", ["rev-parse", "--git-dir"], repo, { GIT_CONFIG_SYSTEM: systemFile });
  assert.equal(r.code, 0, `a system-scope exact-path entry must make git resolve: ${r.stderr}`);
});

// ─── 2. The actual entrypoint probe ──────────────────────────────────────────

test("fg856 (entrypoint): a root-owned root exits 122 with Git's cause and the OWNERSHIP diagnosis — not the worktree advice; with the exception it proceeds", () => {
  requireSudo();
  const base = newBase();
  const repo = join(base, "project");
  makeRepo(repo);
  chownToOther(repo);

  const refused = runProbe(repo);
  assert.equal(refused.code, GIT_UNAVAILABLE_EXIT_CODE, refused.stderr);
  const firstLine = refused.stderr.split("\n")[0]!;
  assert.match(firstLine, /git is unusable in .*: fatal: detected dubious ownership/, "Git's own message comes first");
  assert.match(refused.stderr, OWNERSHIP_DIAGNOSIS);
  assert.doesNotMatch(refused.stderr, WORKTREE_ADVICE, "an ownership refusal must not send the operator after a mount");
  assert.doesNotMatch(refused.stderr, /safe\.directory \*|safe\.directory=\*(?!\))/, "never advise trusting everything");

  const proceeds = runProbe(repo, launcherTrustEnv(repo));
  assert.equal(proceeds.code, 0, `with the launcher's exception the probe must fall through: ${proceeds.stderr}`);
});

// ─── 3. Linked worktree and shared-object clone, differently owned roots ─────

test("fg856: a linked worktree with root-owned mount root, parent .git and admin dir resolves history with ONLY the project path trusted", () => {
  requireSudo();
  const base = newBase();
  const parent = join(base, "parent");
  makeRepo(parent);
  const wt = join(base, "wt");
  gitOk(parent, "worktree", "add", "-q", "-b", "fg856-wt", wt);
  const adminDir = join(parent, ".git", "worktrees", "wt");
  chownToOther(wt);
  chownToOther(adminDir);
  chownToOther(join(parent, ".git"));

  assert.notEqual(run("git", ["rev-parse", "--git-dir"], wt).code, 0, "the worktree must be refused untrusted");

  const trusted = launcherTrustEnv(wt);
  const revParse = run("git", ["rev-parse", "--git-dir"], wt, trusted);
  assert.equal(revParse.code, 0, revParse.stderr);
  const log = run("git", ["log", "--oneline"], wt, trusted);
  assert.equal(log.code, 0, log.stderr);
  assert.match(log.stdout, /commit 1/);
  assert.equal(runProbe(wt, trusted).code, 0, "the entrypoint probe must pass a trusted worktree");
});

test("fg856: a shared-object (private) clone with root-owned root and parent object store resolves history with ONLY the clone path trusted", () => {
  requireSudo();
  const base = newBase();
  const parent = join(base, "parent");
  makeRepo(parent);
  const clone = join(base, "clone");
  gitOk(base, "clone", "-q", "--shared", parent, clone);
  assert.match(readFileSync(join(clone, ".git", "objects", "info", "alternates"), "utf8"), /parent\/\.git\/objects/);
  chownToOther(clone);
  chownToOther(join(parent, ".git", "objects"));

  assert.notEqual(run("git", ["rev-parse", "--git-dir"], clone).code, 0, "the clone must be refused untrusted");

  const trusted = launcherTrustEnv(clone);
  const log = run("git", ["log", "--oneline"], clone, trusted);
  assert.equal(log.code, 0, log.stderr);
  assert.match(log.stdout, /commit 1/);
  assert.equal(runProbe(clone, trusted).code, 0, "the entrypoint probe must pass a trusted clone");
});

// ─── 4. Missing parent .git still refuses, with the worktree advice ──────────

function stubRuntime(): void {
  const fhome = process.env["FORGE_HOME"]!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `
name: claude
description: fg856 stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(fhome);
}

/** Hands the runner the REAL probe's stderr and exit code. */
function probeExec(code: number, stderr: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, stderr);
    return code;
  };
}

test("fg856: a missing linked-worktree parent .git still exits 122 even with the project trusted, with the WORKTREE advice, classified verification_environment_unavailable", async () => {
  requireSudo();
  const base = newBase();
  const parent = join(base, "parent");
  makeRepo(parent);
  const wt = join(base, "wt");
  gitOk(parent, "worktree", "add", "-q", "-b", "fg856-wt", wt);
  renameSync(join(parent, ".git"), join(base, "moved-git"));
  chownToOther(wt);

  const probe = runProbe(wt, launcherTrustEnv(wt));
  assert.equal(probe.code, GIT_UNAVAILABLE_EXIT_CODE, `trust must never mask a broken mount: ${probe.stderr}`);
  assert.match(probe.stderr.split("\n")[0]!, /git is unusable in .*: fatal: not a git repository/);
  assert.match(probe.stderr, WORKTREE_ADVICE);
  assert.doesNotMatch(probe.stderr, /FG-856/, "a missing parent .git is not an ownership problem");

  stubRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir: "/tmp/x", dockerExec: probeExec(probe.code, probe.stderr) });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "verification_environment_unavailable");
  assert.match(r.error ?? "", WORKTREE_ADVICE, "the live classification carries the probe's own advice");
  const ev = eventsForTask(r.taskId).find((e) => e.eventType === "container.git_unavailable");
  assert.match(String((ev?.payload as { cause?: unknown } | undefined)?.cause), /not a git repository/);
});

test("fg856: the REAL ownership refusal is classified verification_environment_unavailable carrying Git's cause", async () => {
  requireSudo();
  const base = newBase();
  const repo = join(base, "project");
  makeRepo(repo);
  chownToOther(repo);
  const probe = runProbe(repo);
  assert.equal(probe.code, GIT_UNAVAILABLE_EXIT_CODE);

  stubRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  const r = await invoke({ agentRole: "engineer", task: "do thing", projectDir: "/tmp/x", dockerExec: probeExec(probe.code, probe.stderr) });
  assert.equal(r.status, "failed");
  assert.equal(failureKindForTask(r.taskId), "verification_environment_unavailable");
  assert.match(r.error ?? "", /dubious ownership/);
  assert.match(r.error ?? "", OWNERSHIP_DIAGNOSIS);
  assert.doesNotMatch(r.error ?? "", WORKTREE_ADVICE);
});
