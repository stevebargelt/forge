// FG-422: install-seeds.sh must distribute the host/orchestrator workflow
// skills (seeds/skills/forge-*) to the user-global Claude skills dir
// (~/.claude/skills, overridable via CLAUDE_SKILLS_DEST / CLAUDE_CONFIG_DIR)
// so every project using forge picks them up — not just the forge repo.
//
// This shells out to the real script against temp HOME-equivalents so the
// idempotency contract (cp -n by default, FORCE=1 to overwrite) is verified
// end-to-end rather than re-implemented. Never touches the real ~/.claude or
// ~/.forge.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALL_SCRIPT = join(REPO_ROOT, "scripts", "install-seeds.sh");
const EXPECTED_SKILLS = ["forge-campaign", "forge-review-loop", "forge-backlog", "forge-research-synthesis"];

let root: string;
let forgeHome: string;
let skillsDest: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "install-seeds-skills-"));
  forgeHome = join(root, "forge-home");
  skillsDest = join(root, "claude-skills");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runInstall(extraEnv: Record<string, string> = {}): string {
  return execFileSync("bash", [INSTALL_SCRIPT], {
    env: { ...process.env, FORGE_HOME: forgeHome, CLAUDE_SKILLS_DEST: skillsDest, ...extraEnv },
    encoding: "utf8",
  });
}

test("install-seeds.sh: installs every seeds/skills/forge-* SKILL.md into CLAUDE_SKILLS_DEST", () => {
  const out = runInstall();
  assert.match(out, new RegExp(`Installing skills into ${skillsDest}/`));
  for (const skill of EXPECTED_SKILLS) {
    const p = join(skillsDest, skill, "SKILL.md");
    assert.ok(existsSync(p), `expected ${p} to exist`);
    assert.ok(readFileSync(p, "utf8").length > 0);
  }
});

test("install-seeds.sh: does not touch ~/.forge for skills (FORGE_HOME/skills is never created)", () => {
  runInstall();
  assert.ok(!existsSync(join(forgeHome, "skills")));
});

test("install-seeds.sh: default run does not clobber a locally-modified skill", () => {
  runInstall();
  const target = join(skillsDest, "forge-campaign", "SKILL.md");
  writeFileSync(target, "LOCALLY EDITED\n");
  runInstall(); // second run, default flags (cp -n)
  assert.equal(readFileSync(target, "utf8"), "LOCALLY EDITED\n");
});

test("install-seeds.sh: FORCE=1 overwrites a locally-modified skill", () => {
  runInstall();
  const target = join(skillsDest, "forge-campaign", "SKILL.md");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, "LOCALLY EDITED\n");
  runInstall({ FORCE: "1" });
  assert.equal(readFileSync(target, "utf8"), original);
});

test("install-seeds.sh: CLAUDE_SKILLS_DEST defaults to CLAUDE_CONFIG_DIR/skills when unset", () => {
  const configDir = join(root, "custom-claude-config");
  mkdirSync(configDir, { recursive: true });
  const out = execFileSync("bash", [INSTALL_SCRIPT], {
    env: { ...process.env, FORGE_HOME: forgeHome, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SKILLS_DEST: "" },
    encoding: "utf8",
  });
  assert.match(out, new RegExp(`Installing skills into ${configDir}/skills/`));
  for (const skill of EXPECTED_SKILLS) {
    assert.ok(existsSync(join(configDir, "skills", skill, "SKILL.md")));
  }
});

test("install-seeds.sh: does not install extra files beyond what ships in seeds/skills", () => {
  runInstall();
  const installed = readdirSync(skillsDest).sort();
  assert.deepEqual(installed, [...EXPECTED_SKILLS].sort());
});
