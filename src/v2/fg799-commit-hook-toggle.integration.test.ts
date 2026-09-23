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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { provisionWorkspaceCommitMsgHook } from "../util/commit-msg-hook.js";
import { readAiAttribution } from "./ai-attribution.js";

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "git-hooks");
const BUNDLED_HOOK = join(HOOKS_DIR, "commit-msg-no-ai-attribution");
const READER_MJS = join(HOOKS_DIR, "read-ai-attribution.mjs");

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

/** Like makeRepo, but writes VERBATIM YAML into .forge/config.yml — for exercising the
 *  exact key forms (nested, quoted, commented) the hook's grep must agree with. */
function makeRepoRawConfig(configYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg799-hook-"));
  tmpDirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg799\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), configYaml);
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

// ── RF-1/RF-3/RF-5/RF-6: the allow short-circuit is decided by the SAME parser the TS
// reader uses (via the standalone read-ai-attribution.mjs the hook shells out to), so
// the hook and the reader can no longer disagree on the edges a bash grep could not
// match: a root key with leading indentation is still top-level (RF-5, allow), a nested
// key is not the toggle (RF-1, suppress), and a mismatched-quote value fails closed
// (RF-6, suppress). Every row here drives a REAL commit through the installed hook and
// is mirrored against readAiAttribution in ai-attribution.test.ts's agreement table. ──
const TOGGLE_TABLE: ReadonlyArray<{ label: string; config: string; allows: boolean }> = [
  { label: "RF-3 bare allow", config: "ai_attribution: allow\n", allows: true },
  { label: "RF-3 double-quoted allow", config: 'ai_attribution: "allow"\n', allows: true },
  { label: "RF-3 single-quoted allow", config: "ai_attribution: 'allow'\n", allows: true },
  { label: "RF-3 commented allow", config: "ai_attribution: allow # approved\n", allows: true },
  { label: "RF-5 root key with leading indentation", config: "  ai_attribution: allow\n", allows: true },
  { label: "RF-1 nested (indented) key", config: "nested:\n  ai_attribution: allow\n", allows: false },
  { label: "RF-6 mismatched quotes", config: 'ai_attribution: "allow\'\n', allows: false },
  { label: "RF-3 allowed (not allow)", config: "ai_attribution: allowed\n", allows: false },
  { label: "RF-3 allow_x (not allow)", config: "ai_attribution: allow_x\n", allows: false },
  { label: "explicit suppress", config: "ai_attribution: suppress\n", allows: false },
];

test("FG-799 (RF-1/3/5/6): every ai_attribution form drives the hook the same way the TS reader resolves it", () => {
  for (const row of TOGGLE_TABLE) {
    const dir = makeRepoRawConfig(row.config);
    const r = attempt(dir, "toggle.txt", CODEX_TRAILER);
    assert.equal(
      r.ok,
      row.allows,
      `${row.label} — ${JSON.stringify(row.config)} must ${row.allows ? "COMMIT (allow)" : "be REFUSED (suppress)"}\n${r.stderr}`,
    );
  }
});

// ── The end-to-end parity pin: the standalone reader the hook shells out to resolves
// the SAME mode as readAiAttribution for every input, run as a real `node` spawn exactly
// as the hook invokes it (the unit tier pins the TS side over the same rows; a unit test
// may not spawn a subprocess, so the reader half lives here). ──
test("FG-799: the standalone reader and readAiAttribution agree on every input (RF-1/3/5/6)", () => {
  const table: ReadonlyArray<{ label: string; config?: string | "unreadable"; mode: "allow" | "suppress" }> = [
    { label: "absent config", config: undefined, mode: "suppress" },
    { label: "allow", config: "ai_attribution: allow\n", mode: "allow" },
    { label: "suppress", config: "ai_attribution: suppress\n", mode: "suppress" },
    { label: "quoted allow", config: 'ai_attribution: "allow"\n', mode: "allow" },
    { label: "single-quoted allow", config: "ai_attribution: 'allow'\n", mode: "allow" },
    { label: "allow with trailing comment", config: "ai_attribution: allow # ok\n", mode: "allow" },
    { label: "root key with leading indentation (RF-5)", config: "  ai_attribution: allow\n", mode: "allow" },
    { label: "nested key (RF-1)", config: "nested:\n  ai_attribution: allow\n", mode: "suppress" },
    { label: "mismatched quotes (RF-6)", config: 'ai_attribution: "allow\'\n', mode: "suppress" },
    { label: "unknown value", config: "ai_attribution: banana\n", mode: "suppress" },
    { label: "unreadable file", config: "unreadable", mode: "suppress" },
  ];
  for (const row of table) {
    const dir = mkdtempSync(join(tmpdir(), "forge-fg799-reader-"));
    tmpDirs.push(dir);
    if (row.config === "unreadable") {
      mkdirSync(join(dir, ".forge", "config.yml"), { recursive: true }); // a dir → readFileSync throws
    } else if (row.config !== undefined) {
      mkdirSync(join(dir, ".forge"), { recursive: true });
      writeFileSync(join(dir, ".forge", "config.yml"), row.config);
    }
    const viaReader = execFileSync(process.execPath, [READER_MJS, dir], { encoding: "utf8" }).trim();
    const viaTs = readAiAttribution(dir).mode;
    assert.equal(viaReader, row.mode, `reader mode for ${row.label}`);
    assert.equal(viaReader, viaTs, `reader and readAiAttribution DISAGREE on ${row.label}`);
  }
});

// ── Point 3: the reader is shipped ALONGSIDE the hook copy, so the toggle actually
// works in a provisioned workspace (no reachable node_modules there). ──
test("FG-799: provisioning installs the ai_attribution reader next to the hook copy", () => {
  const dir = makeRepo("allow");
  assert.ok(
    existsSync(join(dir, ".git", "hooks", "read-ai-attribution.mjs")),
    "the standalone reader must sit next to the copied commit-msg hook",
  );
});

// ── Point 4c: a reader that cannot be run must fail CLOSED and VISIBLY — enforce
// suppress and say why on stderr, never silently permit. ──
test("FG-799: a missing reader forces suppress and prints a notice (never silently permissive)", () => {
  const dir = makeRepoRawConfig("ai_attribution: allow\n"); // would ALLOW if the reader ran
  rmSync(join(dir, ".git", "hooks", "read-ai-attribution.mjs"), { force: true });
  const r = attempt(dir, "no-reader.txt", CODEX_TRAILER);
  assert.equal(r.ok, false, "with the reader gone the hook must fall back to suppress and REFUSE the trailer");
  assert.match(
    r.stderr,
    /reader missing|enforcing suppress/,
    `the suppress fallback must be VISIBLE on stderr, not silent\n${r.stderr}`,
  );
});

// ── RF-4: under suppress the bare-mention matcher covers the FULL provider set, including
// Gemini and Copilot, while keeping their technical-identifier exemptions. ──
test("FG-799 (RF-4): bare Gemini and Copilot mentions are refused under suppress", () => {
  const dir = makeRepo("suppress");
  assert.equal(attempt(dir, "gemini.txt", "feat: widget\n\nGemini wrote this.\n").ok, false, "bare Gemini refused");
  assert.equal(attempt(dir, "copilot.txt", "feat: widget\n\nCopilot suggested this.\n").ok, false, "bare Copilot refused");
});

test("FG-799 (RF-4): Gemini/Copilot technical identifiers still commit under suppress", () => {
  const dir = makeRepo("suppress");
  const msg = "chore: bump gemini-1.5-pro; set GEMINI_API_KEY and COPILOT_TOKEN\n";
  const r = attempt(dir, "ids.txt", msg);
  assert.equal(r.ok, true, `technical gemini/copilot identifiers must COMMIT under suppress\n${r.stderr}`);
});

// ── RF-4: the bare-mention provider set is DERIVED FROM the same list as the trailer set —
// a parity lock so a future provider addition cannot land in one matcher but not the other. ──
test("FG-799 (RF-4): hook bare-mention provider set matches the Co-Authored-By trailer set", () => {
  const hook = readFileSync(BUNDLED_HOOK, "utf8");
  const pull = (re: RegExp, what: string): string[] => {
    const group = hook.match(re)?.[1];
    assert.ok(group, `could not locate the ${what} provider alternation in the hook`);
    return group.split("|").sort();
  };
  const trailer = pull(/Co-Authored-By:.*?\(([a-z|]+)\)/, "Co-Authored-By trailer");
  const bare = pull(/\\b\(([a-z|]+)\)\\b/, "bare-mention");
  assert.deepEqual(bare, trailer, "the bare-mention matcher must cover exactly the trailer provider set");
  for (const provider of ["gemini", "copilot"]) {
    assert.ok(bare.includes(provider), `bare-mention set must include ${provider} (RF-4)`);
  }
});
