import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adapterDecisions,
  adapterPathsAvoidDeprecatedCodexPrompts,
  adapterOutcomeLines,
  adapterReportLines,
  applyOrchestratorBlock,
  currentAdapterStamp,
  documentedAbsenceSurfaces,
  executeClaudeHooksPlan,
  executeGitignoreEntriesPlan,
  executedAdapterOverrides,
  executeHookPlan,
  executeOperatorAdapters,
  forgeAdapterPaths,
  forgeSlashCommands,
  operatorAdapterOverrides,
  planClaudeHooks,
  planCommitMsgHook,
  planGitignoreEntries,
  planOperatorAdapters,
  provisionDocsSurfaces,
  describeDocsSurfacesProvisionPlan,
  provisionSeedFile,
  scaffoldBacklogDirs,
  skippedClaudeCommands,
  skippedClaudeCommandOutcomes,
} from "./init.js";
import { isValidAdapterStamp, operatorSurface, parseAdapterMarker } from "../../v2/operator-workflows.js";
import { classifyDocsSurfaces, loadOperatorSurfaces } from "../../v2/contract.js";
import { currentAdapterStamp as driftAdapterStamp } from "../../v2/seed-drift.js";
import { CODEX_DEPRECATED_PROMPT_DIRS } from "../../v2/render-codex-skills.js";

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
    assert.equal(plan.missing.length, 4);
    assert.ok(plan.missing.includes(".claude/settings.local.json"));
    assert.ok(plan.missing.includes(".claude/commands/"));
    // FG-253: the Codex skill dirs, PER-DIRECTORY.
    assert.ok(plan.missing.includes(".agents/skills/forge-orient/"));
    assert.ok(plan.missing.includes(".agents/skills/forge-handoff/"));
  }
});

test("executeGitignoreEntriesPlan: creates .gitignore with the forge entries", () => {
  const msg = executeGitignoreEntriesPlan(planGitignoreEntries(projectDir));
  assert.match(msg, /added 4/);
  const content = readFileSync(join(projectDir, ".gitignore"), "utf8");
  assert.match(content, /\.claude\/settings\.local\.json/);
  assert.match(content, /\.claude\/commands\//);
  assert.match(content, /\.agents\/skills\/forge-orient\//);
  assert.match(content, /\.agents\/skills\/forge-handoff\//);
});

// FG-253: the parent `.agents/skills/` belongs to the operator and may hold
// skills forge knows nothing about. Ignoring it would silently un-commit
// somebody else's work, so the entries are per-directory and this asserts the
// broader forms are absent.
test("planGitignoreEntries: NEVER ignores the whole .agents/skills/ tree — only forge's own dirs", () => {
  const plan = planGitignoreEntries(projectDir);
  assert.equal(plan.action, "install");
  if (plan.action !== "install") return;
  for (const tooBroad of [".agents/", ".agents/skills/", ".agents/skills", ".agents"]) {
    assert.ok(!plan.missing.includes(tooBroad), `must not ignore ${tooBroad}`);
  }
  for (const e of plan.missing.filter((x) => x.startsWith(".agents/"))) {
    assert.match(e, /^\.agents\/skills\/forge-[a-z]+\/$/, `${e} must be a single forge-owned skill dir`);
  }
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
  writeFileSync(
    join(projectDir, ".gitignore"),
    "node_modules/\n.claude/settings.local.json\n.claude/commands/\n.agents/skills/forge-orient/\n.agents/skills/forge-handoff/\n",
  );
  const plan = planGitignoreEntries(projectDir);
  assert.equal(plan.action, "already-current");
});

test("planGitignoreEntries: action=install when ONE entry is missing", () => {
  writeFileSync(
    join(projectDir, ".gitignore"),
    "node_modules/\n.claude/settings.local.json\n.agents/skills/forge-orient/\n.agents/skills/forge-handoff/\n",
  );
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
  const orientSkillCount = (content.match(/\.agents\/skills\/forge-orient\//g) ?? []).length;
  assert.equal(settingsLocalCount, 1, "settings.local.json entry should appear exactly once");
  assert.equal(commandsCount, 1, ".claude/commands/ entry should appear exactly once");
  assert.equal(orientSkillCount, 1, "forge-orient skill dir entry should appear exactly once");
});

// ─────────────────────────────────────────────────────────────────────────────
// FG-253: project-scoped operator adapters — install, refresh, migrate, and
// (the half that matters) REFUSE.
//
// Every negative case below is the same threat stated four ways: forge writes
// generated files into a repository it does not own, so anything at a target
// path that is not provably forge's must survive the run byte-for-byte. The
// happy path is one test; the rest are the refusals.
// ─────────────────────────────────────────────────────────────────────────────

const STAMP_A = "test-stamp-aaa";
const STAMP_B = "test-stamp-bbb";

function adapterPath(projectDir: string, rel: string): string {
  return join(projectDir, ...rel.split("/"));
}

function claudeOrient(): string {
  const p = forgeAdapterPaths().find((x) => x.endsWith("/orient.md"));
  if (!p) throw new Error("no rendered Claude /orient target");
  return p;
}

function claudeHandoff(): string {
  const p = forgeAdapterPaths().find((x) => x.endsWith("/handoff.md"));
  if (!p) throw new Error("no rendered Claude /handoff target");
  return p;
}

function codexOrientSkill(): string {
  const p = forgeAdapterPaths().find((x) => x.includes("forge-orient"));
  if (!p) throw new Error("no rendered Codex forge-orient target");
  return p;
}

function decisionFor(plan: ReturnType<typeof planOperatorAdapters>, rel: string) {
  return adapterDecisions(plan).find((d) => d.relPath === rel);
}

test("FG-253 forgeAdapterPaths: exactly the four adapter targets — 2 Claude commands + 2 Codex skills", () => {
  const paths = forgeAdapterPaths();
  assert.equal(paths.length, 4, `expected 4 adapter targets, got ${paths.join(", ")}`);
  assert.deepEqual(
    paths.filter((p) => p.startsWith(".claude/commands/")).sort(),
    [".claude/commands/handoff.md", ".claude/commands/orient.md"],
  );
  assert.deepEqual(
    paths.filter((p) => p.startsWith(".agents/skills/")).sort(),
    [".agents/skills/forge-handoff/SKILL.md", ".agents/skills/forge-orient/SKILL.md"],
  );
});

test("FG-253: no rendered adapter path is under a deprecated Codex custom-prompt directory", () => {
  assert.ok(adapterPathsAvoidDeprecatedCodexPrompts(), `deprecated prompt dirs: ${CODEX_DEPRECATED_PROMPT_DIRS.join(", ")}`);
  for (const p of forgeAdapterPaths()) {
    assert.ok(!p.includes("prompts"), `${p} must not live in a prompts directory`);
  }
});

test("FG-253 currentAdapterStamp: is a stamp the marker renderer will actually accept", () => {
  assert.ok(isValidAdapterStamp(currentAdapterStamp()), `invalid stamp: ${currentAdapterStamp()}`);
});

// The installer writes the stamp; the drift detector judges it. Identity of the
// FUNCTION, not equality of today's two values: two resolvers that happen to agree
// under a release are exactly what shipped, and on a dev checkout they did not.
test("FG-253 currentAdapterStamp: the installer and the drift detector share ONE resolver", () => {
  assert.equal(currentAdapterStamp, driftAdapterStamp, "two resolvers are two answers");
  assert.equal(currentAdapterStamp(), driftAdapterStamp());
});

test("FG-253 planOperatorAdapters: a fresh project plans install for all four targets", () => {
  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(plan.action, "install");
  const decisions = adapterDecisions(plan);
  assert.equal(decisions.length, 4);
  for (const d of decisions) assert.equal(d.decision, "install", `${d.relPath} should be a fresh install`);
});

test("FG-253 executeOperatorAdapters: writes marked REGULAR FILES (not symlinks) at every target", () => {
  const plan = planOperatorAdapters(projectDir, STAMP_A);
  const run = executeOperatorAdapters(plan);
  assert.equal(run.outcomes.filter((o) => o.applied === "written").length, 4);
  for (const rel of forgeAdapterPaths()) {
    const target = adapterPath(projectDir, rel);
    assert.ok(existsSync(target), `${rel} should exist`);
    assert.ok(!lstatSync(target).isSymbolicLink(), `${rel} must be bytes, not a symlink`);
    assert.equal(parseAdapterMarker(readFileSync(target, "utf8")), STAMP_A, `${rel} must carry the marker + stamp`);
  }
});

test("FG-253: a second run over the same release is already-current and rewrites nothing", () => {
  executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_A));
  const before = forgeAdapterPaths().map((rel) => readFileSync(adapterPath(projectDir, rel), "utf8"));
  const replan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(replan.action, "already-current");
  for (const d of adapterDecisions(replan)) assert.equal(d.decision, "already-current");
  const run = executeOperatorAdapters(replan);
  assert.equal(run.outcomes.filter((o) => o.applied === "written").length, 0, "nothing may be rewritten");
  forgeAdapterPaths().forEach((rel, i) => {
    assert.equal(readFileSync(adapterPath(projectDir, rel), "utf8"), before[i], `${rel} must be byte-identical`);
  });
});

test("FG-253: a stamp bump refreshes forge-owned bytes in place", () => {
  executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_A));
  const plan = planOperatorAdapters(projectDir, STAMP_B);
  assert.equal(plan.action, "install");
  for (const d of adapterDecisions(plan)) assert.equal(d.decision, "refresh", `${d.relPath} should refresh`);
  executeOperatorAdapters(plan);
  for (const rel of forgeAdapterPaths()) {
    assert.equal(parseAdapterMarker(readFileSync(adapterPath(projectDir, rel), "utf8")), STAMP_B);
  }
});

// ----- REFUSALS: content forge does not own must survive byte-for-byte -------

test("FG-253 REFUSES: an UNMARKED .claude/commands/orient.md is a project override, left byte-identical", () => {
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  const mine = "# my own orient\n\nDo not touch this.\n";
  writeFileSync(target, mine);

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(decisionFor(plan, rel)?.decision, "override");
  assert.match(decisionFor(plan, rel)?.details ?? "", /no forge ownership marker/);

  const run = executeOperatorAdapters(plan);
  assert.equal(run.outcomes.find((o) => o.relPath === rel)?.applied, "left-alone");
  assert.equal(readFileSync(target, "utf8"), mine, "the operator's file must be byte-identical");
  // The other three still install — one override does not abort the set.
  assert.equal(run.outcomes.filter((o) => o.applied === "written").length, 3);
});

test("FG-253 REFUSES: an UNMARKED .agents/skills/forge-orient/SKILL.md is a project override, left byte-identical", () => {
  const rel = codexOrientSkill();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  const mine = "---\nname: forge-orient\n---\n\nmy own version\n";
  writeFileSync(target, mine);

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(decisionFor(plan, rel)?.decision, "override");
  executeOperatorAdapters(plan);
  assert.equal(readFileSync(target, "utf8"), mine);
});

test("FG-253 REFUSES: a foreign symlink at an adapter path is never written THROUGH", () => {
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  const victim = join(projectDir, "victim.md");
  const victimBytes = "someone else's file\n";
  writeFileSync(victim, victimBytes);
  symlinkSync(victim, target);

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(decisionFor(plan, rel)?.decision, "override");
  executeOperatorAdapters(plan);
  assert.ok(lstatSync(target).isSymbolicLink(), "the symlink itself must survive");
  assert.equal(readFileSync(victim, "utf8"), victimBytes, "writing through the link would have clobbered this");
});

test("FG-253 REFUSES: a symlinked adapter DIRECTORY that escapes the project is not a write target", () => {
  const outside = mkdtempSync(join(tmpdir(), "forge-outside-"));
  try {
    const commandsDir = join(projectDir, ".claude", "commands");
    mkdirSync(dirname(commandsDir), { recursive: true });
    symlinkSync(outside, commandsDir);

    const plan = planOperatorAdapters(projectDir, STAMP_A);
    for (const d of adapterDecisions(plan).filter((x) => x.relPath.startsWith(".claude/commands/"))) {
      assert.equal(d.decision, "override", `${d.relPath} must be refused, not written outside the project`);
      assert.match(d.details ?? "", /outside the project/);
    }
    executeOperatorAdapters(plan);
    assert.deepEqual(readdirSync(outside), [], "nothing may be written outside the project root");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("FG-253 REFUSES: a DANGLING symlinked adapter directory is reported, not mkdir'd into a crash", () => {
  // existsSync follows links, so a dangling `.claude/commands` reads as absent —
  // and mkdir over it throws EEXIST. `forge init` must classify it, not die.
  const commandsDir = join(projectDir, ".claude", "commands");
  mkdirSync(dirname(commandsDir), { recursive: true });
  symlinkSync(join(projectDir, "nowhere"), commandsDir);

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  for (const d of adapterDecisions(plan).filter((x) => x.relPath.startsWith(".claude/commands/"))) {
    assert.equal(d.decision, "override");
    assert.match(d.details ?? "", /dangling symlink/);
  }
  const run = executeOperatorAdapters(plan);
  assert.equal(run.outcomes.filter((o) => o.applied === "written").length, 2, "the Codex half still installs");
  assert.ok(lstatSync(commandsDir).isSymbolicLink(), "the dangling link must survive untouched");
  assert.ok(!existsSync(join(projectDir, "nowhere")), "forge must not materialize the link's target");
});

test("FG-253 REFUSES: a regular file where an adapter DIRECTORY belongs is an override", () => {
  const skillsDir = join(projectDir, ".agents", "skills");
  mkdirSync(dirname(skillsDir), { recursive: true });
  writeFileSync(skillsDir, "a file, not a directory\n");
  const plan = planOperatorAdapters(projectDir, STAMP_A);
  for (const d of adapterDecisions(plan).filter((x) => x.relPath.startsWith(".agents/skills/"))) {
    assert.equal(d.decision, "override");
    assert.match(d.details ?? "", /not a directory/);
  }
  executeOperatorAdapters(plan);
  assert.equal(readFileSync(skillsDir, "utf8"), "a file, not a directory\n");
});

test("FG-253 REFUSES: a directory sitting at an adapter file path is an override, not a target", () => {
  const rel = claudeOrient();
  mkdirSync(adapterPath(projectDir, rel), { recursive: true });
  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(decisionFor(plan, rel)?.decision, "override");
  assert.match(decisionFor(plan, rel)?.details ?? "", /directory/);
  executeOperatorAdapters(plan);
  assert.ok(lstatSync(adapterPath(projectDir, rel)).isDirectory(), "the directory must survive");
});

// ----- MIGRATION: forge's own prior artifact, recognized from the bytes -------

test("FG-253 MIGRATES: a legacy absolute forge symlink becomes marked bytes", () => {
  const rel = claudeHandoff();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync("/some/old/forge/scripts/claude-commands/handoff.md", target);

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(decisionFor(plan, rel)?.decision, "migrate");
  executeOperatorAdapters(plan);
  assert.ok(!lstatSync(target).isSymbolicLink(), "the legacy link must be replaced by bytes");
  assert.equal(parseAdapterMarker(readFileSync(target, "utf8")), STAMP_A);
});

test("FG-253: legacy recognition is by shape only — a symlink whose tail is not forge's stays foreign", () => {
  const rel = claudeHandoff();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  const decoy = join(projectDir, "elsewhere-claude-commands-handoff.md");
  writeFileSync(decoy, "not forge's\n");
  symlinkSync(decoy, target);
  assert.equal(decisionFor(planOperatorAdapters(projectDir, STAMP_A), rel)?.decision, "override");
});

// RF-3 / RF-4: a suffix match is not ownership. Forge's legacy artifact is a
// DANGLING absolute link into a `scripts/claude-commands/` that no longer exists in
// any forge tree; an operator's own link that merely ends the same way points at real
// bytes they maintain, and replacing its directory entry takes their link away.
test("FG-253 REFUSES: an operator's LIVE link whose tail matches forge's legacy path is theirs, not a migration", () => {
  const rel = claudeHandoff();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });

  // Their own tree, which happens to be laid out `…/scripts/claude-commands/<name>`.
  const theirTree = mkdtempSync(join(tmpdir(), "forge-not-forge-"));
  try {
    const theirs = join(theirTree, "scripts", "claude-commands", "handoff.md");
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(theirs, "# my handoff\n");
    symlinkSync(theirs, target);

    const plan = planOperatorAdapters(projectDir, STAMP_A);
    assert.equal(decisionFor(plan, rel)?.decision, "override", "a link that RESOLVES is somebody's live file");
    executeOperatorAdapters(plan);
    assert.ok(lstatSync(target).isSymbolicLink(), "the operator's link must survive");
    assert.equal(readlinkSync(target), theirs);
    assert.equal(readFileSync(theirs, "utf8"), "# my handoff\n");
  } finally {
    rmSync(theirTree, { recursive: true, force: true });
  }
});

test("FG-253 REFUSES: a RELATIVE link with forge's legacy tail was not written by forge", () => {
  const rel = claudeHandoff();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync("../../elsewhere/scripts/claude-commands/handoff.md", target);
  assert.equal(decisionFor(planOperatorAdapters(projectDir, STAMP_A), rel)?.decision, "override");
});

// ----- RF-2: the temp file the write goes through ---------------------------

test("FG-253 REFUSES: a symlink planted at the OLD predictable temp name redirects nothing", () => {
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  const victim = join(projectDir, "victim.md");
  const victimBytes = "someone else's file\n";
  writeFileSync(victim, victimBytes);

  // Exactly the name the pre-fix writer computed, which anyone who can read the
  // process table could compute too — and which it unlinked and then re-opened.
  const guessable = join(dirname(target), `.${"orient.md"}.forge-${process.pid}.tmp`);
  symlinkSync(victim, guessable);

  const run = executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_A));

  assert.equal(readFileSync(victim, "utf8"), victimBytes, "the rendered bytes were written through a planted link");
  assert.equal(parseAdapterMarker(readFileSync(target, "utf8")), STAMP_A, "the adapter itself must still install");
  assert.ok(run.outcomes.some((o) => o.relPath === rel && o.applied === "written"));
  // The planted link is the operator's problem, not forge's to delete.
  assert.ok(lstatSync(guessable).isSymbolicLink());
});

test("FG-253: the adapter write leaves no temp file behind", () => {
  executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_A));
  const strays = readdirSync(join(projectDir, ".claude", "commands")).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(strays, []);
});

// ----- RF-1: the run reports what it OBSERVED, including for already-current --

test("FG-253: `already current` is re-read before it is claimed — a file taken over after the plan is not reported unchanged", () => {
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_A));

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(decisionFor(plan, rel)?.decision, "already-current");

  // The operator takes the file over between the plan and the run.
  const mine = "# mine now\n";
  writeFileSync(target, mine);

  const run = executeOperatorAdapters(plan);
  const outcome = run.outcomes.find((o) => o.relPath === rel);
  assert.equal(outcome?.applied, "skipped-changed", "forge claimed a state it never re-read");
  assert.match(outcome?.details ?? "", /no forge ownership marker/);
  assert.equal(readFileSync(target, "utf8"), mine, "and their bytes are still theirs");

  const line = adapterOutcomeLines(plan, run.outcomes).find((l) => l.includes(rel));
  assert.ok(!/already current/.test(line ?? ""), `a taken-over file must not read as current: ${line}`);
});

test("FG-253: executedAdapterOverrides carries BOTH not-installed shapes; the plan's list carries only one", () => {
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  const overridden = adapterPath(projectDir, codexOrientSkill());
  mkdirSync(dirname(overridden), { recursive: true });
  writeFileSync(overridden, "operator owned\n");

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "# arrived late\n");
  const run = executeOperatorAdapters(plan);

  assert.deepEqual(operatorAdapterOverrides(plan).map((e) => e.relPath), [codexOrientSkill()]);
  assert.deepEqual(
    executedAdapterOverrides(run.outcomes).map((o) => o.relPath).sort(),
    [codexOrientSkill(), rel].sort(),
    "the file that became theirs after the plan is invisible in the plan-derived list",
  );
  assert.deepEqual(skippedClaudeCommandOutcomes(run.outcomes).map((o) => o.relPath), [rel]);
});

// ----- TOCTOU: the plan is not a licence to write later ----------------------

test("FG-253 REFUSES: a target replaced between plan and execute is skipped, not clobbered", () => {
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  const plan = planOperatorAdapters(projectDir, STAMP_A);
  assert.equal(decisionFor(plan, rel)?.decision, "install");

  // Someone drops their own file in after the plan was made.
  mkdirSync(dirname(target), { recursive: true });
  const theirs = "# arrived after the plan\n";
  writeFileSync(target, theirs);

  const run = executeOperatorAdapters(plan);
  const outcome = run.outcomes.find((o) => o.relPath === rel);
  assert.equal(outcome?.applied, "skipped-changed");
  assert.match(outcome?.details ?? "", /changed since the plan/);
  assert.equal(readFileSync(target, "utf8"), theirs, "the late arrival must be byte-identical");
});

test("FG-253 REFUSES: a forge-owned file edited between plan and execute is skipped", () => {
  executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_A));
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  const plan = planOperatorAdapters(projectDir, STAMP_B);
  assert.equal(decisionFor(plan, rel)?.decision, "refresh");

  const edited = "# hand-edited, marker removed\n";
  writeFileSync(target, edited);
  const run = executeOperatorAdapters(plan);
  assert.equal(run.outcomes.find((o) => o.relPath === rel)?.applied, "skipped-changed");
  assert.equal(readFileSync(target, "utf8"), edited);
});

// ----- PRESERVATION: files outside the write set ------------------------------

test("FG-253 PRESERVES: AGENTS.md, Codex config, and an operator's own skill are byte-identical across a run", () => {
  const protectedFiles: Record<string, string> = {
    "AGENTS.md": "# my agents doc\n\nforge must never write here.\n",
    ".codex/config.toml": "model = \"my-model\"\n",
    ".agents/skills/my-own-skill/SKILL.md": "---\nname: my-own-skill\n---\n\nmine.\n",
    ".agents/skills/README.md": "operator notes about this directory\n",
  };
  for (const [rel, bytes] of Object.entries(protectedFiles)) {
    const p = adapterPath(projectDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
  }

  executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_A));
  executeOperatorAdapters(planOperatorAdapters(projectDir, STAMP_B));

  for (const [rel, bytes] of Object.entries(protectedFiles)) {
    assert.equal(readFileSync(adapterPath(projectDir, rel), "utf8"), bytes, `${rel} must be untouched`);
  }
  // And the operator's skill directory still holds exactly what they put there.
  assert.deepEqual(readdirSync(join(projectDir, ".agents", "skills", "my-own-skill")), ["SKILL.md"]);
});

// ----- dry-run ⇔ real run -----------------------------------------------------

test("FG-253: the planned decisions are exactly the decisions the run then takes", () => {
  // A mixed project: one fresh target, one override, one legacy symlink.
  const orient = adapterPath(projectDir, claudeOrient());
  mkdirSync(dirname(orient), { recursive: true });
  writeFileSync(orient, "# mine\n");
  symlinkSync("/old/forge/scripts/claude-commands/handoff.md", adapterPath(projectDir, claudeHandoff()));

  const plan = planOperatorAdapters(projectDir, STAMP_A);
  const planned = adapterDecisions(plan);
  const run = executeOperatorAdapters(plan);

  assert.deepEqual(
    run.outcomes.map((o) => ({ relPath: o.relPath, decision: o.decision })),
    planned.map((p) => ({ relPath: p.relPath, decision: p.decision })),
    "the executed decision list must match the printed one, in order",
  );
  // Both reports name every target, and the real one reports OUTCOMES.
  const would = adapterReportLines(plan);
  const did = adapterOutcomeLines(plan, run.outcomes);
  assert.equal(would.length, did.length);
  for (const rel of forgeAdapterPaths()) {
    assert.ok(would.some((l) => l.includes(rel)), `dry-run must name ${rel}`);
    assert.ok(did.some((l) => l.includes(rel)), `the real run must name ${rel}`);
  }
});

test("FG-253: the real run's report states what HAPPENED — never 'installed' for a file it skipped", () => {
  const rel = claudeOrient();
  const target = adapterPath(projectDir, rel);
  const plan = planOperatorAdapters(projectDir, STAMP_A);
  // …the target is taken over between plan and execute.
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "# arrived late\n");

  const run = executeOperatorAdapters(plan);
  const line = adapterOutcomeLines(plan, run.outcomes).find((l) => l.includes(rel));
  assert.ok(line, `no report line for ${rel}`);
  assert.match(line, /SKIPPED/);
  assert.ok(!/installed/.test(line), `a skipped file must not be reported as installed: ${line}`);
  // The dry-run line, by contrast, predicted an install — that is the plan, and
  // the divergence is exactly what the outcome report exists to show.
  assert.match(adapterReportLines(plan).find((l) => l.includes(rel)) ?? "", /WOULD install/);
});

test("FG-253: the generic surface is reported as a documented absence and renders no files", () => {
  const generic = operatorSurface("generic");
  assert.equal(generic.renders.length, 0, "the generic surface must render nothing");
  assert.ok(documentedAbsenceSurfaces().some((s) => s.id === "generic"));
  const lines = adapterReportLines(planOperatorAdapters(projectDir, STAMP_A));
  const genericLine = lines.find((l) => l.includes("generic:"));
  assert.ok(genericLine, "init must say what a generic provider does");
  assert.match(genericLine, /no files/);
  assert.match(genericLine, /forge CLI is the interface/);
});

test("FG-253: a --no-install-hooks plan is skipped and writes nothing", () => {
  const run = executeOperatorAdapters({ action: "skipped" });
  assert.deepEqual(run.outcomes, []);
  assert.ok(!existsSync(join(projectDir, ".claude")));
  assert.ok(!existsSync(join(projectDir, ".agents")));
});

// ----- the pre-FG-253 upgrade entry points still work ------------------------

test("FG-253: forgeSlashCommands still names the Claude command files, derived from the renderer", () => {
  const cmds = forgeSlashCommands();
  assert.deepEqual([...cmds].sort(), ["handoff.md", "orient.md"]);
});

test("FG-253: skippedClaudeCommands reports Claude-surface overrides only (the upgrade --json field means slash commands)", () => {
  const claudeRel = claudeOrient();
  const codexRel = codexOrientSkill();
  for (const rel of [claudeRel, codexRel]) {
    const p = adapterPath(projectDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "operator owned\n");
  }
  const plan = planOperatorAdapters(projectDir, STAMP_A);
  const all = operatorAdapterOverrides(plan).map((e) => e.relPath).sort();
  assert.deepEqual(all, [codexRel, claudeRel].sort(), "both overrides are visible on the full list");
  assert.deepEqual(skippedClaudeCommands(plan).map((e) => e.relPath), [claudeRel]);
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

// ----- FG-546: provisionDocsSurfaces (classifier-driven create/migrate/preserve/repair) -----

const LEGACY_DOCS_SURFACES_YAML = [
  "# some old operator comment",
  "surfaces:",
  "  - name: readme",
  "    kind: user-facing",
  "    path: README.md",
  "  - name: api-reference",
  "    kind: public-api",
  "    path: docs/api.md",
  "",
].join("\n");

function docsSurfacesPath(dir: string): string {
  return join(dir, ".forge", "docs-surfaces.yml");
}

function writeDocsSurfaces(dir: string, content: string): string {
  const p = docsSurfacesPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

test("FG-546 provisionDocsSurfaces: missing → creates the corrected seed (production-valid, source:project)", () => {
  const outcome = provisionDocsSurfaces(projectDir);
  assert.equal(outcome.action, "created");
  const p = docsSurfacesPath(projectDir);
  assert.ok(existsSync(p), "docs-surfaces.yml should be created");
  // The written file resolves through the SAME production classifier as valid.
  assert.equal(classifyDocsSurfaces(projectDir).verdict, "valid-project");
  // And through the production loader with real path-prefix values (not defaults-fallback shape).
  const surfaces = loadOperatorSurfaces(projectDir);
  assert.ok(surfaces.length > 0 && surfaces.every((s) => typeof s === "string" && s.length > 0));
});

test("FG-546 provisionDocsSurfaces: known-legacy template → migrated to the corrected form", () => {
  writeDocsSurfaces(projectDir, LEGACY_DOCS_SURFACES_YAML);
  assert.equal(classifyDocsSurfaces(projectDir).verdict, "known-legacy-generated", "fixture must be the recognized legacy shape");

  const outcome = provisionDocsSurfaces(projectDir);
  assert.equal(outcome.action, "migrated");
  // After migration the file is production-valid and no longer the legacy object shape.
  const content = readFileSync(docsSurfacesPath(projectDir), "utf8");
  assert.ok(!content.includes("kind:"), "the meaningless legacy object entries must be gone");
  assert.equal(classifyDocsSurfaces(projectDir).verdict, "valid-project");
});

test("FG-546 provisionDocsSurfaces: idempotent — rerun on the corrected form is a preserve no-op", () => {
  provisionDocsSurfaces(projectDir); // create
  const bytes = readFileSync(docsSurfacesPath(projectDir), "utf8");
  const rerun = provisionDocsSurfaces(projectDir);
  assert.equal(rerun.action, "preserved");
  assert.equal(readFileSync(docsSurfacesPath(projectDir), "utf8"), bytes, "corrected form must be byte-identical after a no-op rerun");
});

test("FG-546 provisionDocsSurfaces: customized-VALID (Pixtron string-list) is preserved unchanged", () => {
  const custom = "surfaces:\n  - src/mine/\n  - config/mine.ts\n";
  writeDocsSurfaces(projectDir, custom);
  const outcome = provisionDocsSurfaces(projectDir);
  assert.equal(outcome.action, "preserved");
  assert.equal(readFileSync(docsSurfacesPath(projectDir), "utf8"), custom, "a valid operator file must never be rewritten");
});

test("FG-546 provisionDocsSurfaces: customized-INVALID is NEVER clobbered — repair outcome carries file + error detail", () => {
  // A single-entry object shape: structurally different from the frozen legacy
  // template ⇒ customized-invalid, never migrated.
  const custom = "surfaces:\n  - name: only-one\n    path: README.md\n";
  const p = writeDocsSurfaces(projectDir, custom);
  const outcome = provisionDocsSurfaces(projectDir);
  assert.equal(outcome.action, "requires-operator-repair");
  if (outcome.action !== "requires-operator-repair") throw new Error("unreachable");
  assert.equal(outcome.path, p);
  assert.ok(outcome.detail && outcome.detail.length > 0, "must carry a validation-error detail");
  assert.equal(readFileSync(p, "utf8"), custom, "a customized-invalid file must survive byte-for-byte");
});

test("FG-546 RF-1: a dangling docs-surfaces.yml symlink is NEVER followed — no write escapes .forge", () => {
  // Attacker-planted dangling symlink at .forge/docs-surfaces.yml pointing at a
  // sibling OUTSIDE .forge. The old copyFileSync followed it and created the
  // sibling with the bundled seed (write-outside-project). Provisioning must
  // classify it as requires-operator-repair and touch nothing.
  const escapeTarget = join(projectDir, "escape-target.yml");
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  symlinkSync(escapeTarget, docsSurfacesPath(projectDir));

  const outcome = provisionDocsSurfaces(projectDir);
  assert.equal(outcome.action, "requires-operator-repair");
  assert.ok(!existsSync(escapeTarget), "the seed must NOT have been written through the symlink");
  // The symlink entry itself is preserved, never overwritten.
  assert.ok(lstatSync(docsSurfacesPath(projectDir)).isSymbolicLink(), "the symlink must survive untouched");
});

test("FG-546 RF-1: provisioning a missing file lands the seed as a real regular file (atomic write leaves no temp)", () => {
  const outcome = provisionDocsSurfaces(projectDir);
  assert.equal(outcome.action, "created");
  const p = docsSurfacesPath(projectDir);
  assert.ok(lstatSync(p).isFile() && !lstatSync(p).isSymbolicLink(), "written target is a regular file");
  // The atomic temp file must not be left behind.
  const leftovers = readdirSync(join(projectDir, ".forge")).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, [], "no atomic temp file should remain");
});

test("FG-546 describeDocsSurfacesProvisionPlan: forecasts create / migrate / preserve / repair from the same classifier", () => {
  // missing
  assert.match(describeDocsSurfacesProvisionPlan(projectDir), /WOULD create/);
  // known-legacy
  writeDocsSurfaces(projectDir, LEGACY_DOCS_SURFACES_YAML);
  assert.match(describeDocsSurfacesProvisionPlan(projectDir), /WOULD migrate/i);
  // valid
  writeDocsSurfaces(projectDir, "surfaces:\n  - src/mine/\n");
  assert.match(describeDocsSurfacesProvisionPlan(projectDir), /preserve/i);
  // customized-invalid
  writeDocsSurfaces(projectDir, "surfaces:\n  - name: x\n    path: y\n");
  assert.match(describeDocsSurfacesProvisionPlan(projectDir), /repair/i);
});

