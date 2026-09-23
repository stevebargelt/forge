// FG-799: cross the real enforcement seams together: CLI config → current-style
// installed hook → renderer, plus the runner's red anti-prompt path.  Every home
// and project in this file is disposable; the operator's forge state is never read.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { composeSystemPrompt } from "./compose.js";
import { resolveEffectiveConstraints } from "./constraints.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Workflow } from "./schema.js";
import { BUILT_CLI_ENTRY, NODE_EXEC, REPO_ROOT } from "../integration-cli-spawn.js";

const dirs: string[] = [];
const HOOK_REL = join("scripts", "git-hooks", "commit-msg-no-ai-attribution");
const AI_ANTI_PROMPT = "Demonstrate that any commit message, pull request body, or GitHub message produced by this agent mentions";
const ENV_ANTI_PROMPT = "Demonstrate that this agent created a fake package shim";

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function setupCliProject(): { home: string; project: string } {
  const root = temp("forge-fg799-roundtrip-");
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  // This is the production-shaped hook arm: init must link through current, not
  // directly to the checkout that happened to execute the CLI.
  symlinkSync(REPO_ROOT, join(home, "current"), "dir");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "fg799@example.test");
  git(project, "config", "user.name", "FG-799 integration");
  writeFileSync(join(project, "README.md"), "# temporary FG-799 project\n");
  git(project, "add", "README.md");
  git(project, "commit", "-q", "-m", "initial");
  return { home, project };
}

function forge(home: string, project: string, args: string[]) {
  return spawnSync(NODE_EXEC, [BUILT_CLI_ENTRY, ...args], {
    cwd: project,
    env: { ...process.env, FORGE_HOME: home },
    encoding: "utf8",
  });
}

function attemptCommit(project: string, n: number, message: string): { ok: boolean; stderr: string } {
  const path = join(project, `change-${n}.txt`);
  writeFileSync(path, `change ${n}\n`);
  // Do not accidentally stage the deliberately untracked .forge/ and CLAUDE.md
  // surfaces: this commit fixture must change only its own file.
  git(project, "add", path);
  const before = git(project, "rev-parse", "HEAD").trim();
  const result = spawnSync("git", ["commit", "-m", message], { cwd: project, encoding: "utf8" });
  const after = git(project, "rev-parse", "HEAD").trim();
  git(project, "reset", "-q", "--hard", "HEAD");
  // CLAUDE.md and .forge/config.yml are deliberately untracked in this temporary
  // repo; only remove the staged commit fixture, never all untracked project state.
  rmSync(path, { force: true });
  return { ok: result.status === 0 && before !== after, stderr: result.stderr ?? "" };
}

function mode(project: string, value: "allow" | "suppress"): void {
  mkdirSync(join(project, ".forge"), { recursive: true });
  writeFileSync(join(project, ".forge", "config.yml"), `ai_attribution: ${value}\n`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("FG-799 E2E: init/current hook, config toggle, and re-render round-trip together", () => {
  const { home, project } = setupCliProject();
  const initialized = forge(home, project, ["init", "--project", project]);
  assert.equal(initialized.status, 0, initialized.stderr);

  const hook = join(project, ".git", "hooks", "commit-msg");
  assert.ok(lstatSync(hook).isSymbolicLink(), "init installs the git hook");
  assert.equal(readlinkSync(hook), join(home, "current", HOOK_REL), "hook follows FORGE_HOME/current");

  const codexTrailer = "feat: attribution check\n\nCo-Authored-By: Codex <noreply@openai.com>\n";
  assert.equal(attemptCommit(project, 1, codexTrailer).ok, false, "default suppress rejects Codex trailer");

  const allow = forge(home, project, ["config", "set", "ai-attribution", "allow", "--project", project]);
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(attemptCommit(project, 2, codexTrailer).ok, true, "the identical trailer passes after allow");
  const show = forge(home, project, ["config", "show", "--project", project]);
  assert.match(show.stdout, /ai attribution: allow \(\.forge\/config\.yml\)/);
  const doctor = forge(home, project, ["doctor", "--json"]);
  assert.deepEqual(JSON.parse(doctor.stdout).aiAttribution, { mode: "allow", source: "project-config" });

  // `init` is the documented re-render entry point used when an upgrade is not
  // desired in a test; it replaces the marker-owned block in place.
  assert.equal(forge(home, project, ["init", "--project", project]).status, 0);
  let claude = readFileSync(join(project, "CLAUDE.md"), "utf8");
  assert.match(claude, /AI attribution is ALLOWED in this project/);
  assert.doesNotMatch(claude, /Don't attribute work to an AI assistant/);
  assert.doesNotMatch(claude, /<!-- forge:if/);

  const suppress = forge(home, project, ["config", "set", "ai-attribution", "suppress", "--project", project]);
  assert.equal(suppress.status, 0, suppress.stderr);
  assert.equal(forge(home, project, ["init", "--project", project]).status, 0);
  assert.equal(attemptCommit(project, 3, codexTrailer).ok, false, "suppress takes effect again through the same hook");
  claude = readFileSync(join(project, "CLAUDE.md"), "utf8");
  assert.match(claude, /Don't attribute work to an AI assistant/);
  assert.doesNotMatch(claude, /AI attribution is ALLOWED in this project/);
  assert.doesNotMatch(claude, /<!-- forge:if|<!-- forge:endif/);
});

test("FG-799 E2E: suppress hook retains technical-identifier exemptions while refusing attribution prose", () => {
  const { home, project } = setupCliProject();
  assert.equal(forge(home, project, ["init", "--project", project]).status, 0);
  const identifiers = "docs: describe CLAUDE.md and CLAUDE_CODE_USE_BEDROCK\n\nUses OPENAI_API_KEY with gpt-5.6-terra and claude-sonnet-5; run forge codex or `codex`.";
  assert.equal(attemptCommit(project, 1, identifiers).ok, true, "technical names are not attribution");
  assert.equal(attemptCommit(project, 2, "docs: Generated with Codex").ok, false);
  assert.equal(attemptCommit(project, 3, "docs: ChatGPT wrote this").ok, false);
});

const REVIEW_WORKFLOW: Workflow = {
  name: "fg799-force-review",
  description: "exercise the primary-to-red anti-prompt handoff",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [{
    id: "build",
    agent: "engineer",
    gate: "verdict",
    manual: false,
    depends_on: [],
    runtime: "claude",
    reds: [{ agent: "red-narrow", authority: "authoritative", gate_on_verdict: true }],
  }],
};

function setupRunnerHome(): { project: string; constraints: string } {
  const root = temp("forge-fg799-runner-");
  const project = join(root, "project");
  const home = process.env.FORGE_HOME!;
  mkdirSync(project, { recursive: true });
  cpSync(join(REPO_ROOT, "seeds", "constraints"), join(home, "constraints"), { recursive: true });
  cpSync(join(REPO_ROOT, "seeds", "agents", "engineer"), join(home, "agents", "engineer"), { recursive: true });
  cpSync(join(REPO_ROOT, "seeds", "agents", "red-narrow"), join(home, "agents", "red-narrow"), { recursive: true });
  mkdirSync(join(home, "runtimes"), { recursive: true });
  const runtime = `name: claude\ndescription: test\nimage: test\nmodels: { default: test }\nauth: { mode: apikey }\nmounts: []\ninvocation: { command: echo, args: [] }\ncontainer: { name: forge-test }\nresult: { file: /task/result.json }\n`;
  writeFileSync(join(home, "runtimes", "claude.yml"), runtime);
  writeFileSync(join(home, "runtimes", "claude-apikey.yml"), runtime.replace("name: claude", "name: claude-apikey"));
  publishFlatAsGeneration(home);
  return { project, constraints: join(home, "constraints") };
}

const completedRunner: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  const taskId = basename(join(stdoutPath, ".."));
  const taskDir = join(stdoutPath, "..");
  writeFileSync(join(taskDir, "result.json"), JSON.stringify(taskId.includes("red-")
    ? { status: "complete", verdict: "pass", confidence: 1, findings: [] }
    : { status: "complete", artifact: "reviewable artifact", tests_run: 1 }));
  writeFileSync(stdoutPath, "stub");
  writeFileSync(stderrPath, "");
  return 0;
};

async function redFailureModes(project: string): Promise<string[]> {
  const { runId } = startRun({ workflow: REVIEW_WORKFLOW, title: "fg799 force path", inputs: {}, projectDir: project });
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "stub";
  try {
    await runNext({ runId, workflow: REVIEW_WORKFLOW, dockerExec: completedRunner });
  } finally {
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
  }
  const tasks = tasksForRun(runId);
  const red = tasks.find((task) => task.agentRole === "red-narrow");
  assert.ok(red, `workflow dispatched its declared red; got ${JSON.stringify(tasks.map((task) => ({ role: task.agentRole, status: task.status, error: task.error })))}`);
  return (red.taskPackage.inputs as { failureModes: string[] }).failureModes;
}

test("FG-799 E2E: real seed toggle governs compose skip, runner red anti-prompts, and host-wins", async () => {
  const { project, constraints } = setupRunnerHome();
  const agentDir = join(process.env.FORGE_HOME!, "agents", "engineer");

  mode(project, "suppress");
  const suppressCompose = composeSystemPrompt({ role: "engineer", workflow: REVIEW_WORKFLOW, step: REVIEW_WORKFLOW.steps[0]!, agentDir, constraintsDir: constraints, projectDir: project });
  assert.ok(suppressCompose.ok);
  assert.deepEqual(suppressCompose.constraintsSkipped, []);
  const suppressModes = await redFailureModes(project);
  assert.ok(suppressModes.some((value) => value.startsWith(AI_ANTI_PROMPT)), "host AI force rule reaches red under suppress");
  assert.ok(suppressModes.some((value) => value.startsWith(ENV_ANTI_PROMPT)), "other real host force rule remains present");

  // A project may not replace the host rule with an inverted condition.
  const projectConstraints = join(project, ".forge", "constraints");
  mkdirSync(projectConstraints, { recursive: true });
  writeFileSync(join(projectConstraints, "attempted-inversion.md"), `---\nid: no-ai-attribution\nlevel: force\nroles: []\nworkflows: []\nenabled_when: { config: ai_attribution, equals: allow }\nantiPrompt: PROJECT INVERSION MUST NEVER WIN\n---\nproject override`);
  let effective = resolveEffectiveConstraints({ hostDir: constraints, projectDir: project });
  assert.ok(effective.constraints.some((constraint) => constraint.id === "no-ai-attribution"));
  assert.ok(!effective.constraints.some((constraint) => constraint.antiPrompt === "PROJECT INVERSION MUST NEVER WIN"));

  mode(project, "allow");
  const allowCompose = composeSystemPrompt({ role: "engineer", workflow: REVIEW_WORKFLOW, step: REVIEW_WORKFLOW.steps[0]!, agentDir, constraintsDir: constraints, projectDir: project });
  assert.ok(allowCompose.ok);
  assert.deepEqual(allowCompose.constraintsSkipped, [{ id: "no-ai-attribution", reason: "toggle ai_attribution=allow" }]);
  const allowModes = await redFailureModes(project);
  assert.ok(!allowModes.some((value) => value.startsWith(AI_ANTI_PROMPT)), "host rule, not project inversion, is skipped under allow");
  assert.ok(allowModes.some((value) => value.startsWith(ENV_ANTI_PROMPT)), "unrelated host force rule survives allow");
  effective = resolveEffectiveConstraints({ hostDir: constraints, projectDir: project });
  assert.ok(!effective.constraints.some((constraint) => constraint.id === "no-ai-attribution"));
  assert.deepEqual(effective.skipped, [{ id: "no-ai-attribution", reason: "toggle ai_attribution=allow" }]);
});
