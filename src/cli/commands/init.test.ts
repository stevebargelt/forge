import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOrchestratorBlock,
  executeClaudeCommandsPlan,
  executeClaudeHooksPlan,
  executeGitignoreEntriesPlan,
  forgeSlashCommands,
  planClaudeCommands,
  planClaudeHooks,
  planCommitMsgHook,
  planGitignoreEntries,
} from "./init.js";

const TEMPLATE = `<!-- forge:orchestrator-start -->
# forge orchestrator
You are the orchestrator.
<!-- forge:orchestrator-end -->`;

const TEMPLATE_V2 = `<!-- forge:orchestrator-start -->
# forge orchestrator (v2)
Different body.
<!-- forge:orchestrator-end -->`;

const TEMPLATE_WITH_STACK = `<!-- forge:orchestrator-start -->
# forge orchestrator (v2)
Different body.
<!-- forge:orchestrator-end -->

## Stack + project context
- **Project**: <!-- placeholder -->
- **Stack**: <!-- placeholder -->`;

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

test("applyOrchestratorBlock: upgrade preserves project-specific Stack section after end marker", () => {
  const existing = [
    "# my project",
    "",
    "<!-- forge:orchestrator-start -->",
    "# forge orchestrator",
    "You are the orchestrator.",
    "<!-- forge:orchestrator-end -->",
    "",
    "## Stack + project context",
    "- **Project**: Acme — real project data",
    "- **Stack**: React + Node",
    "",
  ].join("\n");

  const out = applyOrchestratorBlock(existing, TEMPLATE_WITH_STACK);
  assert.ok(out.includes("# forge orchestrator (v2)"), "orchestrator block should be updated");
  assert.ok(!out.includes("You are the orchestrator."), "old block body should be gone");
  assert.ok(out.includes("Acme — real project data"), "project-specific Stack content must survive");
  assert.ok(!out.includes("<!-- placeholder -->"), "template placeholder must NOT be injected");
});

test("applyOrchestratorBlock: first-time append includes post-marker Stack placeholder", () => {
  const existing = "# my project\n\nSome notes.\n";
  const out = applyOrchestratorBlock(existing, TEMPLATE_WITH_STACK);
  assert.ok(out.includes("## Stack + project context"), "Stack section should be seeded on first init");
  assert.ok(out.includes("<!-- placeholder -->"), "placeholder should appear on first init");
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

// ----- planClaudeHooks / executeClaudeHooksPlan (#153, retargeted to
//       settings.local.json per the portability fix) -----

test("planClaudeHooks: action=install targeting settings.local.json when no .claude/settings.local.json exists", () => {
  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.match(plan.settingsPath, /\.claude\/settings\.local\.json$/);
    assert.match(plan.source, /orchestrator-heartbeat$/);
    assert.match(plan.details, /create new/);
    assert.equal(plan.legacyCleanup, false);
  }
});

test("executeClaudeHooksPlan: creates a fresh settings.local.json with all three event hooks", () => {
  const plan = planClaudeHooks(projectDir);
  const msg = executeClaudeHooksPlan(plan);
  assert.match(msg, /created/);
  const parsed = JSON.parse(readFileSync(join(projectDir, ".claude", "settings.local.json"), "utf8"));
  for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
    const entries = parsed.hooks[event];
    assert.ok(Array.isArray(entries), `${event} should be an array`);
    const found = entries.some((e: { hooks?: Array<{ command?: string }> }) =>
      Array.isArray(e.hooks) && e.hooks.some((h) => typeof h.command === "string" && h.command.includes("orchestrator-heartbeat"))
    );
    assert.ok(found, `${event} should contain our orchestrator-heartbeat command`);
  }
  // settings.json (project-shared) should NOT have been created.
  assert.ok(!existsSync(join(projectDir, ".claude", "settings.json")), "settings.json should not be created — that's the project-shared file");
});

test("planClaudeHooks: action=already-current after a fresh install", () => {
  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  const replan = planClaudeHooks(projectDir);
  assert.equal(replan.action, "already-current");
  if (replan.action === "already-current") assert.equal(replan.legacyCleanup, false);
});

test("executeClaudeHooksPlan: merges into existing settings.local.json, preserving unrelated keys", () => {
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
  writeFileSync(join(settingsDir, "settings.local.json"), JSON.stringify(existing, null, 2));

  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") assert.match(plan.details, /merge/);
  executeClaudeHooksPlan(plan);

  const merged = JSON.parse(readFileSync(join(settingsDir, "settings.local.json"), "utf8"));
  assert.deepEqual(merged.permissions, { allow: ["Read"] }, "unrelated keys preserved");
  const userEntry = merged.hooks.SessionStart.some((e: { hooks?: Array<{ command?: string }> }) =>
    e.hooks?.some((h) => h.command === "/user/their-own-script.sh"),
  );
  assert.ok(userEntry, "user's existing SessionStart hook should be preserved");
  const ourEntry = merged.hooks.SessionStart.some((e: { hooks?: Array<{ command?: string }> }) =>
    e.hooks?.some((h) => typeof h.command === "string" && h.command.includes("orchestrator-heartbeat")),
  );
  assert.ok(ourEntry, "our SessionStart heartbeat hook should be added");
  assert.ok(merged.hooks.Stop?.length > 0);
  assert.ok(merged.hooks.SessionEnd?.length > 0);
});

test("executeClaudeHooksPlan: upgrades a stale forge heartbeat command in-place rather than appending a duplicate", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  // Simulate a stale prior install at a different path, ALREADY in settings.local.json
  // (the new target). This is the "forge clone moved on this machine" upgrade path.
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
  writeFileSync(join(settingsDir, "settings.local.json"), JSON.stringify(existing, null, 2));

  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  const merged = JSON.parse(readFileSync(join(settingsDir, "settings.local.json"), "utf8"));

  assert.equal(merged.hooks.SessionStart.length, 1, "should upgrade in place, not duplicate");
  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.SessionEnd.length, 1);
  const startCmd = merged.hooks.SessionStart[0].hooks[0].command;
  assert.ok(!startCmd.startsWith("/old/path"), `expected upgrade away from /old/path, got: ${startCmd}`);
  assert.ok(startCmd.includes("orchestrator-heartbeat"));
  assert.ok(startCmd.endsWith(" start"));
});

test("planClaudeHooks: returns corrupt-json when settings.local.json is unparseable", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.local.json"), "{ not valid json");
  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "corrupt-json");
  const msg = executeClaudeHooksPlan(plan);
  assert.match(msg, /SKIPPED/);
  assert.equal(readFileSync(join(settingsDir, "settings.local.json"), "utf8"), "{ not valid json");
});

test("executeClaudeHooksPlan: idempotent — running install twice doesn't accumulate entries", () => {
  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  executeClaudeHooksPlan(planClaudeHooks(projectDir));
  const parsed = JSON.parse(readFileSync(join(projectDir, ".claude", "settings.local.json"), "utf8"));
  assert.equal(parsed.hooks.SessionStart.length, 1);
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.SessionEnd.length, 1);
});

// ----- Legacy migration: forge hooks in committed settings.json get
//       moved to per-developer settings.local.json -----

test("planClaudeHooks: detects forge hooks in legacy settings.json and flags legacyCleanup", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const legacy = {
    permissions: { allow: ["Read"] },  // user's project-shared config
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/old/forge/scripts/claude-hooks/orchestrator-heartbeat start" }] },
      ],
    },
  };
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(legacy, null, 2));
  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.equal(plan.legacyCleanup, true);
    assert.match(plan.details, /cleanup legacy|migrate legacy/);
  }
});

test("executeClaudeHooksPlan: migrates legacy settings.json hooks → settings.local.json, preserves other keys", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const legacy = {
    permissions: { allow: ["Read"] },
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/old/forge/scripts/claude-hooks/orchestrator-heartbeat start" }] },
        { matcher: "", hooks: [{ type: "command", command: "/user/their-own-hook.sh" }] },
      ],
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: "/old/forge/scripts/claude-hooks/orchestrator-heartbeat tick" }] },
      ],
    },
  };
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(legacy, null, 2));

  executeClaudeHooksPlan(planClaudeHooks(projectDir));

  // settings.local.json now has the forge hooks (with the CURRENT path).
  const local = JSON.parse(readFileSync(join(settingsDir, "settings.local.json"), "utf8"));
  assert.equal(local.hooks.SessionStart.length, 1);
  assert.match(local.hooks.SessionStart[0].hooks[0].command, /orchestrator-heartbeat start$/);
  assert.ok(!local.hooks.SessionStart[0].hooks[0].command.startsWith("/old/forge"));

  // settings.json has lost the forge hook entries but kept the user's hook + permissions.
  const shared = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"));
  assert.deepEqual(shared.permissions, { allow: ["Read"] }, "user's permissions preserved in settings.json");
  // Only the user's own SessionStart hook remains; forge hook gone.
  assert.equal(shared.hooks.SessionStart.length, 1);
  assert.equal(shared.hooks.SessionStart[0].hooks[0].command, "/user/their-own-hook.sh");
  // Stop event had only the forge hook → entire event key removed.
  assert.ok(shared.hooks.Stop === undefined, "empty Stop event should be removed from settings.json");
});

test("executeClaudeHooksPlan: deletes legacy settings.json entirely when nothing else remains in it", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  // Settings.json had ONLY forge hooks — no permissions, no user hooks.
  const legacy = {
    hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/old/forge/orchestrator-heartbeat start" }] }],
      Stop:         [{ matcher: "", hooks: [{ type: "command", command: "/old/forge/orchestrator-heartbeat tick" }] }],
      SessionEnd:   [{ matcher: "", hooks: [{ type: "command", command: "/old/forge/orchestrator-heartbeat end" }] }],
    },
  };
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(legacy, null, 2));

  executeClaudeHooksPlan(planClaudeHooks(projectDir));

  assert.ok(!existsSync(join(settingsDir, "settings.json")), "empty settings.json should be deleted, not left as {}");
  // settings.local.json still gets the migrated entries.
  assert.ok(existsSync(join(settingsDir, "settings.local.json")));
});

test("planClaudeHooks: legacy settings.json without forge hooks is ignored (no migration)", () => {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const userOnly = {
    permissions: { allow: ["Read", "Edit"] },
    hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/user/script.sh" }] }],
    },
  };
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(userOnly, null, 2));
  const plan = planClaudeHooks(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") assert.equal(plan.legacyCleanup, false, "user-only legacy file should not trigger cleanup");
  executeClaudeHooksPlan(plan);
  // settings.json untouched.
  const shared = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"));
  assert.deepEqual(shared, userOnly);
});

// ----- planGitignoreEntries / executeGitignoreEntriesPlan -----

test("planGitignoreEntries: action=install when no .gitignore exists", () => {
  const plan = planGitignoreEntries(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.equal(plan.missing.length, 2);
    assert.ok(plan.missing.includes(".claude/settings.local.json"));
    assert.ok(plan.missing.includes(".claude/commands/"));
  }
});

test("executeGitignoreEntriesPlan: creates .gitignore with the forge entries", () => {
  const msg = executeGitignoreEntriesPlan(planGitignoreEntries(projectDir));
  assert.match(msg, /added 2/);
  const content = readFileSync(join(projectDir, ".gitignore"), "utf8");
  assert.match(content, /\.claude\/settings\.local\.json/);
  assert.match(content, /\.claude\/commands\//);
});

test("executeGitignoreEntriesPlan: appends to existing .gitignore without disturbing other entries", () => {
  writeFileSync(join(projectDir, ".gitignore"), "node_modules/\ndist/\n");
  executeGitignoreEntriesPlan(planGitignoreEntries(projectDir));
  const content = readFileSync(join(projectDir, ".gitignore"), "utf8");
  // Original entries preserved.
  assert.match(content, /node_modules\//);
  assert.match(content, /dist\//);
  // New entries appended.
  assert.match(content, /\.claude\/settings\.local\.json/);
  assert.match(content, /\.claude\/commands\//);
});

test("planGitignoreEntries: action=already-current when entries are already present", () => {
  writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n.claude/settings.local.json\n.claude/commands/\n");
  const plan = planGitignoreEntries(projectDir);
  assert.equal(plan.action, "already-current");
});

test("planGitignoreEntries: action=install when ONE entry is missing", () => {
  writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n.claude/settings.local.json\n");
  const plan = planGitignoreEntries(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.equal(plan.missing.length, 1);
    assert.equal(plan.missing[0], ".claude/commands/");
  }
});

test("executeGitignoreEntriesPlan: idempotent — running twice doesn't duplicate entries", () => {
  executeGitignoreEntriesPlan(planGitignoreEntries(projectDir));
  executeGitignoreEntriesPlan(planGitignoreEntries(projectDir));
  const content = readFileSync(join(projectDir, ".gitignore"), "utf8");
  const settingsLocalCount = (content.match(/\.claude\/settings\.local\.json/g) ?? []).length;
  const commandsCount = (content.match(/\.claude\/commands\//g) ?? []).length;
  assert.equal(settingsLocalCount, 1, "settings.local.json entry should appear exactly once");
  assert.equal(commandsCount, 1, ".claude/commands/ entry should appear exactly once");
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

test("planClaudeCommands: detects a stale-symlink to an unrelated path as exists-other so we don't clobber", () => {
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

test("planClaudeCommands: detects a stale forge symlink (different forge path) and flags it for replacement", () => {
  const dir = join(projectDir, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  // Simulate an old forge install at a different path — broken symlink because
  // /old/forge doesn't exist on this machine.
  symlinkSync("/old/forge/scripts/claude-commands/orient.md", join(dir, "orient.md"));
  symlinkSync("/old/forge/scripts/claude-commands/handoff.md", join(dir, "handoff.md"));
  const plan = planClaudeCommands(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    const orient = plan.entries.find((e) => e.name === "orient.md");
    assert.equal(orient?.status, "install", "stale forge symlink should be flagged for upgrade-install, not skipped");
    assert.match(orient?.details ?? "", /replace stale/);
  }
});

test("executeClaudeCommandsPlan: replaces stale forge symlinks in place without EEXIST", () => {
  const dir = join(projectDir, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  symlinkSync("/old/forge/scripts/claude-commands/orient.md", join(dir, "orient.md"));
  symlinkSync("/old/forge/scripts/claude-commands/handoff.md", join(dir, "handoff.md"));
  const msg = executeClaudeCommandsPlan(planClaudeCommands(projectDir));
  // Should succeed (no thrown EEXIST) and report both installed.
  assert.match(msg, /installed/);
  // New symlinks now point at the live forge repo, not /old/forge.
  for (const name of ["orient.md", "handoff.md"]) {
    const target = join(dir, name);
    assert.ok(lstatSync(target).isSymbolicLink());
    const linkTarget = readlinkSync(target);
    assert.ok(!linkTarget.startsWith("/old/forge"), `${name} should no longer point at /old/forge; got ${linkTarget}`);
  }
});
