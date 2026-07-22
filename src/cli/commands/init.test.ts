import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyOrchestratorBlock,
  executeClaudeCommandsPlan,
  executeClaudeHooksPlan,
  executeGitignoreEntriesPlan,
  executeHookPlan,
  forgeSlashCommands,
  planClaudeCommands,
  planClaudeHooks,
  planCommitMsgHook,
  planGitignoreEntries,
  provisionSeedFile,
  scaffoldBacklogDirs,
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
  assert.equal(out.content, TEMPLATE + "\n");
  assert.equal(out.action, "appended");
});

test("applyOrchestratorBlock: appends with separator when CLAUDE.md has content", () => {
  const existing = "# my project\n\nSome notes.\n";
  const out = applyOrchestratorBlock(existing, TEMPLATE);
  assert.equal(out.action, "appended");
  assert.ok(out.content.startsWith("# my project"));
  assert.ok(out.content.includes("Some notes."));
  assert.ok(out.content.includes("<!-- forge:orchestrator-start -->"));
  assert.ok(out.content.includes("<!-- forge:orchestrator-end -->"));
});

test("applyOrchestratorBlock: replaces existing block in place", () => {
  const before = `# my project\n\nSome notes.\n\n${TEMPLATE}\n\n## After section\n\nMore content.\n`;
  const out = applyOrchestratorBlock(before, TEMPLATE_V2);
  assert.equal(out.action, "replaced");
  assert.ok(out.content.includes("# my project"));
  assert.ok(out.content.includes("Some notes."));
  assert.ok(out.content.includes("# forge orchestrator (v2)"));
  assert.ok(!out.content.includes("# forge orchestrator\n"));  // old block gone
  assert.ok(out.content.includes("## After section"));
  assert.ok(out.content.includes("More content."));
});

test("applyOrchestratorBlock: idempotent — replacing block with same content yields same text", () => {
  const once = applyOrchestratorBlock("# project\n\nbody.\n", TEMPLATE);
  const twice = applyOrchestratorBlock(once.content, TEMPLATE);
  assert.equal(once.content, twice.content);
  assert.equal(twice.action, "unchanged");
});

// #231: a lone START marker can't infer the block end → needs-markers (no throw).
test("applyOrchestratorBlock: lone start marker → needs-markers (no throw)", () => {
  const out = applyOrchestratorBlock("<!-- forge:orchestrator-start -->\nbody", TEMPLATE);
  assert.equal(out.action, "needs-markers");
  assert.equal(out.content, "<!-- forge:orchestrator-start -->\nbody", "content untouched");
  assert.match(out.message ?? "", /end marker/i);
});

// #231: a lone END marker WITH a heading to anchor the start → auto-repair.
test("applyOrchestratorBlock: lone end marker + heading → repaired in place", () => {
  const before = [
    "# my project",
    "",
    "# forge orchestrator",
    "You are the orchestrator.",
    "<!-- forge:orchestrator-end -->",
    "",
    "## Stack + project context",
    "- **Project**: Acme",
    "",
  ].join("\n");
  const out = applyOrchestratorBlock(before, TEMPLATE_WITH_STACK);
  assert.equal(out.action, "repaired");
  assert.ok(out.content.includes("<!-- forge:orchestrator-start -->"), "start marker inserted");
  assert.ok(out.content.includes("# forge orchestrator (v2)"), "block refreshed to template");
  assert.ok(!out.content.includes("You are the orchestrator."), "old body replaced");
  assert.ok(out.content.includes("# my project"), "head preserved");
  assert.ok(out.content.includes("- **Project**: Acme"), "project-specific tail preserved");
  assert.ok(!out.content.includes("<!-- placeholder -->"), "template placeholder not injected on repair");
});

// #231: a lone END marker with NO heading to anchor → needs-markers (can't guess).
test("applyOrchestratorBlock: lone end marker without heading → needs-markers", () => {
  const out = applyOrchestratorBlock("body\n<!-- forge:orchestrator-end -->\n", TEMPLATE);
  assert.equal(out.action, "needs-markers");
  assert.match(out.message ?? "", /start marker/i);
});

// #231: an unfenced legacy block (heading, no markers) → needs-markers, not a
// duplicate (the end boundary vs project tail is ambiguous).
test("applyOrchestratorBlock: unfenced heading, no markers → needs-markers (no duplicate)", () => {
  const before = "# my project\n\n# forge orchestrator\nold body\n\n## Stack\n- thing\n";
  const out = applyOrchestratorBlock(before, TEMPLATE);
  assert.equal(out.action, "needs-markers");
  assert.equal(out.content, before, "content untouched — no second block appended");
  assert.match(out.message ?? "", /unfenced/i);
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
  assert.ok(out.content.includes("# project"));
  assert.ok(out.content.includes("## Setup"));
  assert.ok(out.content.includes("Some setup notes."));
  assert.ok(out.content.includes("## Conventions"));
  assert.ok(out.content.includes("Use ts not js."));
  assert.ok(out.content.includes("# forge orchestrator (v2)"));
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
  assert.ok(out.content.includes("# forge orchestrator (v2)"), "orchestrator block should be updated");
  assert.ok(!out.content.includes("You are the orchestrator."), "old block body should be gone");
  assert.ok(out.content.includes("Acme — real project data"), "project-specific Stack content must survive");
  assert.ok(!out.content.includes("<!-- placeholder -->"), "template placeholder must NOT be injected");
});

test("applyOrchestratorBlock: first-time append includes post-marker Stack placeholder", () => {
  const existing = "# my project\n\nSome notes.\n";
  const out = applyOrchestratorBlock(existing, TEMPLATE_WITH_STACK);
  assert.equal(out.action, "appended");
  assert.ok(out.content.includes("## Stack + project context"), "Stack section should be seeded on first init");
  assert.ok(out.content.includes("<!-- placeholder -->"), "placeholder should appear on first init");
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

// ----- FG-582: installed hooks symlink THROUGH $FORGE_HOME/current so they
//       follow a promotion. All cases use a disposable FORGE_HOME + disposable
//       repo/install dirs and NEVER touch this repo's real .git/hooks. -----

let homeDir: string;

// A disposable git-hooks dir under projectDir; planCommitMsgHook only checks the
// dir exists, so a real `git init` is unnecessary for the pure-plan cases.
function makeHooksDir(): string {
  const hooksDir = join(projectDir, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  return hooksDir;
}

// Create a $FORGE_HOME/current pointer (current → releases/r-<id>) so the
// promoted arm is selected. Returns the arm-selected install target that git
// resolves at hook-exec time.
function makeCurrentPointer(release = "r-1"): string {
  const releaseDir = join(homeDir, "releases", release);
  const hookRel = join("scripts", "git-hooks", "commit-msg-no-ai-attribution");
  mkdirSync(join(releaseDir, "scripts", "git-hooks"), { recursive: true });
  // The promoted arm is chosen on RESOLVABILITY (FG-582 AC-3): the bundled hook
  // must resolve through current, so lay the release's SHIPPED hook layout down
  // (release.ts copies the whole tree — the hook lives at
  // scripts/git-hooks/commit-msg-no-ai-attribution, not a root-level commit-msg).
  writeFileSync(join(releaseDir, hookRel), "#!/bin/sh\n# release hook\n");
  symlinkSync(releaseDir, join(homeDir, "current"));
  return join(homeDir, "current", hookRel);
}

// The dev-checkout absolute source the pre-FG-582 code installed — obtained by
// asking for a plan with an EMPTY home (no current pointer → dev fallback arm)
// without exporting the module-private resolveHookSource().
function devCheckoutSource(): string {
  const empty = mkdtempSync(join(tmpdir(), "forge-empty-home-"));
  makeHooksDir();
  const plan = planCommitMsgHook(projectDir, empty);
  rmSync(empty, { recursive: true, force: true });
  assert.equal(plan.action, "install");
  if (plan.action !== "install") throw new Error("unreachable");
  return plan.source;
}

test("planCommitMsgHook FG-582: RED against absolute-dev-path target, GREEN on $FORGE_HOME/current arm", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  makeHooksDir();
  const devSource = devCheckoutSource();
  const currentArm = makeCurrentPointer();

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "install");
  if (plan.action !== "install") throw new Error("unreachable");
  // RED: the install target is NOT the old absolute dev-checkout path.
  assert.notEqual(plan.source, devSource);
  // GREEN: it symlinks through the bundled hook under $FORGE_HOME/current.
  assert.equal(plan.source, currentArm);
  assert.equal(plan.source, join(homeDir, "current", "scripts", "git-hooks", "commit-msg-no-ai-attribution"));
  rmSync(homeDir, { recursive: true, force: true });
});

test("planCommitMsgHook FG-582: dev-checkout fallback when no current pointer exists", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  makeHooksDir();

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "install");
  if (plan.action !== "install") throw new Error("unreachable");
  // No current pointer → point at the checkout (absolute path to the bundled
  // hook script), NOT through $FORGE_HOME/current.
  assert.notEqual(plan.source, join(homeDir, "current", "scripts", "git-hooks", "commit-msg-no-ai-attribution"));
  assert.ok(!plan.source.startsWith(join(homeDir, "current")));
  assert.match(plan.source, /commit-msg-no-ai-attribution$/);
  rmSync(homeDir, { recursive: true, force: true });
});

test("planCommitMsgHook FG-582: stale Forge-owned link (legacy absolute-dev-path) is re-pointed to current arm", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  const devSource = devCheckoutSource();
  const currentArm = makeCurrentPointer();
  // Simulate an already-onboarded repo: a link pinned at the dev-checkout path.
  symlinkSync(devSource, join(hooksDir, "commit-msg"));

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "install");
  if (plan.action !== "install") throw new Error("unreachable");
  assert.equal(plan.source, currentArm);
  rmSync(homeDir, { recursive: true, force: true });
});

test("planCommitMsgHook FG-582: already-correct current-arm link is a no-op", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  const currentArm = makeCurrentPointer();
  symlinkSync(currentArm, join(hooksDir, "commit-msg"));

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "already-linked");
  rmSync(homeDir, { recursive: true, force: true });
});

test("planCommitMsgHook FG-582: foreign regular-file hook is refused (never overwritten)", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  makeCurrentPointer();
  writeFileSync(join(hooksDir, "commit-msg"), "#!/bin/sh\necho someone-elses-hook\n");

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action !== "exists-other") throw new Error("unreachable");
  assert.match(plan.details, /regular file/);
  rmSync(homeDir, { recursive: true, force: true });
});

test("planCommitMsgHook FG-582: foreign symlink is refused (never overwritten)", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  makeCurrentPointer();
  const foreign = join(homeDir, "someone-elses-tool", "commit-msg");
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(foreign, "#!/bin/sh\n");
  symlinkSync(foreign, join(hooksDir, "commit-msg"));

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "exists-other");
  if (plan.action !== "exists-other") throw new Error("unreachable");
  assert.match(plan.details, /symlink →/);
  rmSync(homeDir, { recursive: true, force: true });
});

test("planCommitMsgHook FG-582: a bare release-dir containment is NOT ownership evidence", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  makeCurrentPointer();
  // A hand-placed link into the attacker-addressable releases/<id> namespace is
  // foreign — only the promoted arm ($FORGE_HOME/current) or the dev source
  // count as ownership evidence.
  const releaseHook = join(homeDir, "releases", "r-attacker", "commit-msg");
  mkdirSync(dirname(releaseHook), { recursive: true });
  writeFileSync(releaseHook, "#!/bin/sh\n");
  symlinkSync(releaseHook, join(hooksDir, "commit-msg"));

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "exists-other");
  rmSync(homeDir, { recursive: true, force: true });
});

test("executeHookPlan FG-582: re-pointing a stale Forge-owned link succeeds (unlinks first) and is then idempotent", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  const devSource = devCheckoutSource();
  const currentArm = makeCurrentPointer();
  const hookPath = join(hooksDir, "commit-msg");
  symlinkSync(devSource, hookPath);

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "install");
  executeHookPlan(plan);
  assert.ok(lstatSync(hookPath).isSymbolicLink());
  assert.equal(readlinkSync(hookPath), currentArm);

  // Second run over the now-correct link is a no-op.
  const plan2 = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan2.action, "already-linked");
  rmSync(homeDir, { recursive: true, force: true });
});

test("planCommitMsgHook FG-582 (AC-3): a DANGLING current pointer selects the dev-checkout fallback, NOT the promoted arm", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  makeHooksDir();
  // current → releases/r-gone, but that release dir does NOT exist → the
  // pointer dangles. Choosing the promoted arm here would install an
  // unresolvable $FORGE_HOME/current/commit-msg hook (the guard never runs).
  mkdirSync(join(homeDir, "releases"), { recursive: true });
  symlinkSync(join(homeDir, "releases", "r-gone"), join(homeDir, "current"));

  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "install");
  if (plan.action !== "install") throw new Error("unreachable");
  // Falls back to the dev checkout (absolute bundled-hook path), never through
  // $FORGE_HOME/current.
  assert.ok(!plan.source.startsWith(join(homeDir, "current")));
  assert.match(plan.source, /commit-msg-no-ai-attribution$/);
  rmSync(homeDir, { recursive: true, force: true });
});

test("executeHookPlan FG-582 (AC-5): a stale owned link swapped to a FOREIGN symlink between plan and execute is left untouched", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  const devSource = devCheckoutSource();
  makeCurrentPointer();
  const hookPath = join(hooksDir, "commit-msg");
  // Planner classifies a stale dev-checkout link as re-pointable (owned).
  symlinkSync(devSource, hookPath);
  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "install");

  // Concurrent swap AFTER planning: someone replaces it with a foreign hook.
  unlinkSync(hookPath);
  const foreign = join(homeDir, "someone-elses", "commit-msg");
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(foreign, "#!/bin/sh\n# not ours\n");
  symlinkSync(foreign, hookPath);

  const msg = executeHookPlan(plan);
  assert.match(msg, /changed since plan/);
  // The foreign hook must be exactly as we left it — never unlinked.
  assert.ok(lstatSync(hookPath).isSymbolicLink());
  assert.equal(readlinkSync(hookPath), foreign);
  rmSync(homeDir, { recursive: true, force: true });
});

test("executeHookPlan FG-582 (AC-5): a fresh-install target that gained a foreign hook between plan and execute is left untouched", () => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-home-"));
  const hooksDir = makeHooksDir();
  makeCurrentPointer();
  const hookPath = join(hooksDir, "commit-msg");
  // Nothing at the target when planned → a fresh install plan (expect: absent).
  const plan = planCommitMsgHook(projectDir, homeDir);
  assert.equal(plan.action, "install");

  // A foreign hook appears before execute runs.
  writeFileSync(hookPath, "#!/bin/sh\n# someone else got here first\n");

  const msg = executeHookPlan(plan);
  assert.match(msg, /changed since plan/);
  assert.ok(!lstatSync(hookPath).isSymbolicLink(), "foreign regular-file hook untouched");
  assert.match(readFileSync(hookPath, "utf8"), /got here first/);
  rmSync(homeDir, { recursive: true, force: true });
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

// ----- scaffoldBacklogDirs (FG-332: structured backlog layout) -----

test("scaffoldBacklogDirs: creates all subdirs and notes.md in a fresh dir", () => {
  const msg = scaffoldBacklogDirs(projectDir);
  assert.match(msg, /created/);
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    assert.ok(existsSync(join(projectDir, "backlog", sub)), `backlog/${sub} should exist`);
  }
  assert.ok(existsSync(join(projectDir, "backlog", "notes.md")));
});

test("scaffoldBacklogDirs: idempotent — re-run when everything already exists is a no-op", () => {
  scaffoldBacklogDirs(projectDir);
  writeFileSync(join(projectDir, "backlog", "notes.md"), "# my real notes\nkeep me\n");
  const msg = scaffoldBacklogDirs(projectDir);
  assert.match(msg, /no-op/);
  assert.equal(readFileSync(join(projectDir, "backlog", "notes.md"), "utf8"), "# my real notes\nkeep me\n", "notes.md must not be clobbered");
});

// ----- provisionSeedFile (model-policy + docs-surfaces) -----

test("provisionSeedFile: creates model-policy.yml when absent", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const result = provisionSeedFile(join(projectDir, ".forge"), "model-policy.yml", "model-policy.example.yml");
  assert.equal(result, "created");
  assert.ok(existsSync(join(projectDir, ".forge", "model-policy.yml")));
  const content = readFileSync(join(projectDir, ".forge", "model-policy.yml"), "utf8");
  assert.match(content, /model_profiles/);
});

test("provisionSeedFile: skips model-policy.yml when already present", () => {
  const forgeDir = join(projectDir, ".forge");
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(forgeDir, "model-policy.yml"), "# custom\n");
  const result = provisionSeedFile(forgeDir, "model-policy.yml", "model-policy.example.yml");
  assert.match(result, /already exists/);
  assert.equal(readFileSync(join(forgeDir, "model-policy.yml"), "utf8"), "# custom\n", "existing file must not be overwritten");
});

test("provisionSeedFile: creates docs-surfaces.yml when absent", () => {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  const result = provisionSeedFile(join(projectDir, ".forge"), "docs-surfaces.yml", "docs-surfaces.example.yml");
  assert.equal(result, "created");
  assert.ok(existsSync(join(projectDir, ".forge", "docs-surfaces.yml")));
  const content = readFileSync(join(projectDir, ".forge", "docs-surfaces.yml"), "utf8");
  assert.match(content, /surfaces/);
});

test("provisionSeedFile: skips docs-surfaces.yml when already present", () => {
  const forgeDir = join(projectDir, ".forge");
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(forgeDir, "docs-surfaces.yml"), "# my custom surfaces\n");
  const result = provisionSeedFile(forgeDir, "docs-surfaces.yml", "docs-surfaces.example.yml");
  assert.match(result, /already exists/);
  assert.equal(readFileSync(join(forgeDir, "docs-surfaces.yml"), "utf8"), "# my custom surfaces\n", "existing file must not be overwritten");
});

