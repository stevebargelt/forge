import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOrchestratorBlock,
  executeClaudeCommandsPlan,
  executeClaudeHooksPlan,
  forgeSlashCommands,
  planClaudeCommands,
  planClaudeHooks,
  planCommitMsgHook,
} from "./init.js";

const TEMPLATE = `<!-- forge:orchestrator-start -->
# forge orchestrator
You are the orchestrator.
<!-- forge:orchestrator-end -->`;

const TEMPLATE_V2 = `<!-- forge:orchestrator-start -->
# forge orchestrator (v2)
Different body.
<!-- forge:orchestrator-end -->`;

test("applyOrchestratorBlock: appends to empty CLAUDE.md", () => {
  const out = applyOrchestratorBlock("", TEMPLATE);
  assert.equal(out, TEMPLATE + "\n");
});

test("applyOrchestratorBlock: appends with separator when CLAUDE.md has content", () => {
  const existing = "# my project\n\nSome notes.\n";
  const out = applyOrchestratorBlock(existing, TEMPLATE);
  assert.ok(out.startsWith("# my project"));
  assert.ok(out.includes("Some notes."));
  assert.ok(out.includes("<!-- forge:orchestrator-start -->"));
  assert.ok(out.includes("<!-- forge:orchestrator-end -->"));
});

test("applyOrchestratorBlock: replaces existing block in place", () => {
  const before = `# my project\n\nSome notes.\n\n${TEMPLATE}\n\n## After section\n\nMore content.\n`;
  const out = applyOrchestratorBlock(before, TEMPLATE_V2);
  assert.ok(out.includes("# my project"));
  assert.ok(out.includes("Some notes."));
  assert.ok(out.includes("# forge orchestrator (v2)"));
  assert.ok(!out.includes("# forge orchestrator\n"));  // old block gone
  assert.ok(out.includes("## After section"));
  assert.ok(out.includes("More content."));
});

test("applyOrchestratorBlock: idempotent — replacing block with same content yields same text", () => {
  const once = applyOrchestratorBlock("# project\n\nbody.\n", TEMPLATE);
  const twice = applyOrchestratorBlock(once, TEMPLATE);
  assert.equal(once, twice);
});

test("applyOrchestratorBlock: unbalanced markers throws (only start marker)", () => {
  const corrupt = "<!-- forge:orchestrator-start -->\nbody";
  assert.throws(
    () => applyOrchestratorBlock(corrupt, TEMPLATE),
    /unbalanced/i
  );
});

test("applyOrchestratorBlock: unbalanced markers throws (only end marker)", () => {
  const corrupt = "body\n<!-- forge:orchestrator-end -->\n";
  assert.throws(
    () => applyOrchestratorBlock(corrupt, TEMPLATE),
    /unbalanced/i
  );
});

test("applyOrchestratorBlock: preserves content before AND after the block on update", () => {
  const before = [
    "# project",
    "",
    "## Setup",
    "Some setup notes.",
    "",
    TEMPLATE,
    "",
    "## Conventions",
    "Use ts not js.",
    "",
  ].join("\n");

  const out = applyOrchestratorBlock(before, TEMPLATE_V2);
  assert.ok(out.includes("# project"));
  assert.ok(out.includes("## Setup"));
  assert.ok(out.includes("Some setup notes."));
  assert.ok(out.includes("## Conventions"));
  assert.ok(out.includes("Use ts not js."));
  assert.ok(out.includes("# forge orchestrator (v2)"));
});

// ----- planCommitMsgHook (#147 follow-up: ban-AI-attribution hook) -----

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-init-hook-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("planCommitMsgHook: returns not-a-git-repo when .git/hooks is missing", () => {
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "not-a-git-repo");
});

test("planCommitMsgHook: returns install when .git/hooks exists and no commit-msg present", () => {
  execSync("git init -q", { cwd: projectDir });
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.match(plan.target, /\.git\/hooks\/commit-msg$/);
    assert.match(plan.source, /commit-msg-no-ai-attribution$/);
  }
});

test("planCommitMsgHook: returns already-linked when a symlink already points at our source", () => {
  execSync("git init -q", { cwd: projectDir });
  // Replicate the install: symlink to the bundled source script.
  // Use the same resolution path the prod helper would.
  const prodPlan = planCommitMsgHook(projectDir);
  assert.equal(prodPlan.action, "install");
  if (prodPlan.action !== "install") throw new Error("setup failed");
  symlinkSync(prodPlan.source, prodPlan.target);

  const replan = planCommitMsgHook(projectDir);
  assert.equal(replan.action, "already-linked");
});

test("planCommitMsgHook: returns exists-other when a non-symlink hook is already in place", () => {
  execSync("git init -q", { cwd: projectDir });
  const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
  writeFileSync(hookPath, "#!/bin/sh\necho 'some other hook'\n");
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action === "exists-other") {
    assert.match(plan.details, /regular file/);
  }
});

test("planCommitMsgHook: returns exists-other when a symlink points somewhere else", () => {
  execSync("git init -q", { cwd: projectDir });
  // Make a decoy target inside the same tmpdir.
  const decoy = join(projectDir, "decoy-hook");
  writeFileSync(decoy, "#!/bin/sh\nexit 0\n");
  const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
  symlinkSync(decoy, hookPath);
  const plan = planCommitMsgHook(projectDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action === "exists-other") {
    assert.match(plan.details, /symlink/);
  }
});

// ----- planClaudeHooks / executeClaudeHooksPlan (#153) -----

test("planClaudeHooks: action=install when no .claude/settings.json exists", () => {
  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.match(plan.settingsPath, /\.claude\/settings\.json$/);
    assert.match(plan.source, /orchestrator-heartbeat$/);
    assert.match(plan.details, /create new/);
  }
});

test("executeClaudeHooksPlan: creates a fresh settings.json with all three event hooks", () => {
  const plan = planClaudeHooks(projectDir);
  const msg = executeClaudeHooksPlan(plan);
  assert.match(msg, /created/);
  const parsed = JSON.parse(readFileSync(join(projectDir, ".claude", "settings.json"), "utf8"));
  for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
    const entries = parsed.hooks[event];
    assert.ok(Array.isArray(entries), `${event} should be an array`);
    const found = entries.some((e: { hooks?: Array<{ command?: string }> }) =>
      Array.isArray(e.hooks) && e.hooks.some((h) => typeof h.command === "string" && h.command.includes("orchestrator-heartbeat"))
    );
    assert.ok(found, `${event} should contain our orchestrator-heartbeat command`);
  }
});

test("planClaudeHooks: action=already-current after a fresh install", () => {
  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  const replan = planClaudeHooks(projectDir);
  assert.equal(replan.action, "already-current");
});

test("executeClaudeHooksPlan: merges into existing settings.json, preserving unrelated keys", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const existing = {
    permissions: { allow: ["Read"] },
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/user/their-own-script.sh" }] },
      ],
    },
  };
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(existing, null, 2));

  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") assert.match(plan.details, /merge/);
  executeClaudeHooksPlan(plan);

  const merged = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"));
  // Unrelated keys preserved.
  assert.deepEqual(merged.permissions, { allow: ["Read"] });
  // User's own hook entry still there.
  const userEntry = merged.hooks.SessionStart.some((e: { hooks?: Array<{ command?: string }> }) =>
    e.hooks?.some((h) => h.command === "/user/their-own-script.sh"),
  );
  assert.ok(userEntry, "user's existing SessionStart hook should be preserved");
  // Our entry added.
  const ourEntry = merged.hooks.SessionStart.some((e: { hooks?: Array<{ command?: string }> }) =>
    e.hooks?.some((h) => typeof h.command === "string" && h.command.includes("orchestrator-heartbeat")),
  );
  assert.ok(ourEntry, "our SessionStart heartbeat hook should be added");
  // Stop + SessionEnd added too.
  assert.ok(merged.hooks.Stop?.length > 0);
  assert.ok(merged.hooks.SessionEnd?.length > 0);
});

test("executeClaudeHooksPlan: upgrades a stale forge heartbeat command in-place rather than appending a duplicate", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  // Simulate a stale prior install at a different path.
  const existing = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/old/path/scripts/claude-hooks/orchestrator-heartbeat start" }] },
      ],
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: "/old/path/scripts/claude-hooks/orchestrator-heartbeat tick" }] },
      ],
      SessionEnd: [
        { matcher: "", hooks: [{ type: "command", command: "/old/path/scripts/claude-hooks/orchestrator-heartbeat end" }] },
      ],
    },
  };
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(existing, null, 2));

  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  const merged = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"));

  // Each event still has exactly ONE entry (we upgraded, didn't duplicate).
  assert.equal(merged.hooks.SessionStart.length, 1);
  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.SessionEnd.length, 1);
  // And the command no longer points at /old/path.
  const startCmd = merged.hooks.SessionStart[0].hooks[0].command;
  assert.ok(!startCmd.startsWith("/old/path"), `expected upgrade away from /old/path, got: ${startCmd}`);
  assert.ok(startCmd.includes("orchestrator-heartbeat"));
  assert.ok(startCmd.endsWith(" start"));
});

test("planClaudeHooks: returns corrupt-json when settings.json is unparseable", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.json"), "{ not valid json");
  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "corrupt-json");
  // Execute should report SKIPPED without throwing.
  const msg = executeClaudeHooksPlan(plan);
  assert.match(msg, /SKIPPED/);
  // File untouched.
  assert.equal(readFileSync(join(settingsDir, "settings.json"), "utf8"), "{ not valid json");
});

test("executeClaudeHooksPlan: idempotent — running install twice doesn't accumulate entries", () => {
  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  const parsed = JSON.parse(readFileSync(join(projectDir, ".claude", "settings.json"), "utf8"));
  assert.equal(parsed.hooks.SessionStart.length, 1);
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.SessionEnd.length, 1);
});

// ----- planClaudeCommands / executeClaudeCommandsPlan (/orient + /handoff) -----

test("forgeSlashCommands: includes both /orient and /handoff templates", () => {
  const cmds = forgeSlashCommands();
  assert.ok(cmds.includes("orient.md"));
  assert.ok(cmds.includes("handoff.md"));
});

test("planClaudeCommands: action=install for a fresh project with no .claude/commands dir", () => {
  const plan = planClaudeCommands(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.equal(plan.entries.length, forgeSlashCommands().length);
    for (const e of plan.entries) {
      assert.equal(e.status, "install");
      assert.match(e.source, /scripts\/claude-commands\//);
      assert.match(e.target, /\.claude\/commands\//);
    }
  }
});

test("executeClaudeCommandsPlan: creates .claude/commands dir + symlinks each command", () => {
  const plan = planClaudeCommands(projectDir);
  const msg = executeClaudeCommandsPlan(plan);
  assert.match(msg, /installed/);
  const dir = join(projectDir, ".claude", "commands");
  for (const name of forgeSlashCommands()) {
    const target = join(dir, name);
    assert.ok(existsSync(target), `${name} should exist at ${target}`);
    assert.ok(lstatSync(target).isSymbolicLink(), `${name} should be a symlink, not a copy`);
  }
});

test("planClaudeCommands: action=already-current after a fresh install", () => {
  executeClaudeCommandsPlan(planClaudeCommands(projectDir));
  const replan = planClaudeCommands(projectDir);
  assert.equal(replan.action, "already-current");
});

test("planClaudeCommands: refuses to clobber a project-local override (regular file at the target path)", () => {
  const dir = join(projectDir, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  // User wrote their own /orient.md — must not be replaced.
  writeFileSync(join(dir, "orient.md"), "# my custom orient\n");
  const plan = planClaudeCommands(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    const orient = plan.entries.find((e) => e.name === "orient.md");
    assert.equal(orient?.status, "exists-other");
    assert.match(orient?.details ?? "", /regular file/);
  }
  // Execute leaves the custom file alone, installs the other commands.
  const msg = executeClaudeCommandsPlan(plan);
  assert.match(msg, /SKIPPED/);
  assert.equal(readFileSync(join(dir, "orient.md"), "utf8"), "# my custom orient\n");
});

test("planClaudeCommands: detects a stale-symlink (linked to old path) as exists-other so we don't clobber", () => {
  const dir = join(projectDir, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  // Decoy: point /orient.md at some unrelated file (simulates a prior tool that managed slash commands)
  const decoy = join(projectDir, "decoy.md");
  writeFileSync(decoy, "decoy content");
  symlinkSync(decoy, join(dir, "orient.md"));
  const plan = planClaudeCommands(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    const orient = plan.entries.find((e) => e.name === "orient.md");
    assert.equal(orient?.status, "exists-other");
    assert.match(orient?.details ?? "", /symlink/);
  }
});
