// FG-799 (AC3): the commit-msg hook is per-project TOGGLEABLE, proven by real
// `git commit` attempts through the INSTALLED hook path.
//
//   - suppress (default / absent config): Claude AND Codex/OpenAI/ChatGPT trailers,
//     boilerplate, and bare prose mentions are refused at write time; technical
//     identifiers still pass.
//   - allow: every one of those messages commits — the hook exits 0 before any check.
//
// Behavioral, not structural: a hook can be present and still never fire, so each
// assertion is on git's own accept/reject of a real commit.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { provisionWorkspaceCommitMsgHook } from "../util/commit-msg-hook.js";

const tmpDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A real repo with the no-AI-attribution hook installed through the provisioning
 *  path, and the given ai_attribution mode written to .forge/config.yml (or none). */
function makeRepo(mode?: "suppress" | "allow"): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg799-hook-"));
  tmpDirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg799\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  if (mode) {
    mkdirSync(join(dir, ".forge"), { recursive: true });
    writeFileSync(join(dir, ".forge", "config.yml"), `ai_attribution: ${mode}\n`);
  }
  provisionWorkspaceCommitMsgHook(dir);
  return dir;
}

/** Stage a file and attempt a real commit; report git's own accept/reject. */
function attempt(dir: string, file: string, message: string): { ok: boolean; stderr: string } {
  writeFileSync(join(dir, file), `touch ${file}\n`);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  const before = git(dir, "rev-parse", "HEAD").trim();
  const r = spawnSync("git", ["commit", "-m", message], { cwd: dir, encoding: "utf8" });
  const after = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "reset", "-q", "--hard", "HEAD");
  git(dir, "clean", "-qfd");
  return { ok: r.status === 0 && after !== before, stderr: r.stderr ?? "" };
}

const CLAUDE_TRAILER = "feat: widget\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n";
const CODEX_TRAILER = "feat: widget\n\nCo-Authored-By: Codex <noreply@openai.com>\n";
const BOILERPLATE = "feat: widget\n\n🤖 Generated with Codex\n";
const BARE_CODEX = "feat: widget\n\nThis was pair-written with Codex.\n";
const BARE_CHATGPT = "feat: widget\n\nDrafted with help from ChatGPT.\n";
const CLEAN =
  "feat: wire the release pin through CLAUDE.md and the .claude/ config dir\n\n" +
  "Reads claude-opus-5 and gpt-5.6-codex; honors CLAUDE_CODE_USE_BEDROCK, OPENAI_API_KEY, CODEX_HOME.\n" +
  "Run `claude` / `codex`, or forge codex, or --claude. Uses @openai/agents and codex-subscription.\n";

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test("FG-799 (AC3): suppress (default, no config) refuses Claude AND Codex/OpenAI/ChatGPT attribution", () => {
  const dir = makeRepo(); // no config → default suppress
  for (const [label, msg] of [
    ["claude trailer", CLAUDE_TRAILER],
    ["codex trailer", CODEX_TRAILER],
    ["boilerplate", BOILERPLATE],
    ["bare codex", BARE_CODEX],
    ["bare chatgpt", BARE_CHATGPT],
  ] as const) {
    const r = attempt(dir, `${label.replace(/\W+/g, "-")}.txt`, msg);
    assert.equal(r.ok, false, `${label} must be REFUSED under suppress`);
  }
});

test("FG-799 (AC3): explicit suppress is identical to the default", () => {
  const dir = makeRepo("suppress");
  assert.equal(attempt(dir, "a.txt", CODEX_TRAILER).ok, false, "codex trailer refused under explicit suppress");
});

test("FG-799 (AC3): technical identifiers still commit under suppress (no false positive)", () => {
  const dir = makeRepo("suppress");
  const r = attempt(dir, "clean.txt", CLEAN);
  assert.equal(r.ok, true, `the whitelisted-identifier control must COMMIT under suppress\n${r.stderr}`);
});

test("FG-799 (AC3): allow lets EVERY attribution variant commit", () => {
  const dir = makeRepo("allow");
  for (const [label, msg] of [
    ["claude trailer", CLAUDE_TRAILER],
    ["codex trailer", CODEX_TRAILER],
    ["boilerplate", BOILERPLATE],
    ["bare codex", BARE_CODEX],
  ] as const) {
    const r = attempt(dir, `${label.replace(/\W+/g, "-")}.txt`, msg);
    assert.equal(r.ok, true, `${label} must COMMIT under allow\n${r.stderr}`);
  }
});
