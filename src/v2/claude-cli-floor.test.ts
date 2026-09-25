// FG-804: the model → minimum Claude Code CLI table, and the Dockerfile pin that
// must satisfy it. The pin guard reads the Dockerfile's INSTRUCTIONS
// (comment-stripped, continuation-folded) so a comment mentioning the ARG cannot
// satisfy it while the real install line is bare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_CLI_FLOORS,
  compareVersions,
  parseClaudeCliVersion,
  requiredClaudeCliVersion,
} from "./claude-cli-floor.js";
import { computeBuildInputDigest } from "./build-input-digest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerDir = join(root, "docker");
const dockerfilePath = join(dockerDir, "agent-dev-worker.Dockerfile");

function instructions(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function pinnedClaudeVersion(body: string): string | undefined {
  return instructions(body)
    .map((l) => /^ARG\s+CLAUDE_CODE_VERSION=(\S+)$/i.exec(l)?.[1])
    .find((v) => v !== undefined);
}

test("FG-804 floor table: claude-opus-5-5 requires >= 2.1.280, across id spellings", () => {
  assert.equal(requiredClaudeCliVersion("claude-opus-5-5"), "2.1.280");
  assert.equal(requiredClaudeCliVersion("us.anthropic.claude-opus-5-5-v1:0"), "2.1.280");
  assert.equal(requiredClaudeCliVersion("claude-opus-5-5[1m]"), "2.1.280");
  assert.equal(requiredClaudeCliVersion("claude-opus-5-50"), undefined);
  assert.equal(requiredClaudeCliVersion("claude-sonnet-5"), undefined);
  assert.equal(requiredClaudeCliVersion("claude-opus-4-8"), undefined);
});

test("FG-804 parseClaudeCliVersion reads `claude --version` output; garbage → undefined", () => {
  assert.equal(parseClaudeCliVersion("2.1.281 (Claude Code)\n"), "2.1.281");
  assert.equal(parseClaudeCliVersion("command not found"), undefined);
});

test("FG-804 compareVersions is numeric, not lexical", () => {
  assert.ok(compareVersions("2.1.224", "2.1.280") < 0);
  assert.ok(compareVersions("2.1.281", "2.1.280") > 0);
  assert.ok(compareVersions("2.10.0", "2.9.9") > 0);
  assert.equal(compareVersions("2.1.280", "2.1.280"), 0);
});

test("FG-804 Dockerfile pin guard: every claude-code install references the CLAUDE_CODE_VERSION ARG", () => {
  const body = readFileSync(dockerfilePath, "utf8");
  const installs = instructions(body).filter((l) => /^RUN\b/i.test(l) && l.includes("@anthropic-ai/claude-code"));
  assert.ok(installs.length > 0, "the image must install Claude Code");
  for (const line of installs) {
    assert.match(line, /@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/, `unpinned claude install: ${line}`);
    assert.doesNotMatch(line, /@anthropic-ai\/claude-code(?!@)/, `bare claude install alongside the pin: ${line}`);
  }
  assert.ok(pinnedClaudeVersion(body), "ARG CLAUDE_CODE_VERSION=<version> must be declared");
});

test("FG-804 the pinned CLAUDE_CODE_VERSION satisfies every declared model floor", () => {
  const pinned = pinnedClaudeVersion(readFileSync(dockerfilePath, "utf8"))!;
  for (const f of CLAUDE_CLI_FLOORS) {
    assert.ok(compareVersions(pinned, f.minVersion) >= 0, `pin ${pinned} is below ${f.model}'s floor ${f.minVersion}`);
  }
});

test("FG-804 bumping CLAUDE_CODE_VERSION changes the build-input digest (image goes STALE)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-claude-pin-"));
  try {
    cpSync(dockerDir, tmp, { recursive: true });
    const before = computeBuildInputDigest(tmp);
    const file = join(tmp, "agent-dev-worker.Dockerfile");
    const body = readFileSync(file, "utf8");
    writeFileSync(file, body.replace(/^ARG CLAUDE_CODE_VERSION=\S+$/m, "ARG CLAUDE_CODE_VERSION=9.9.9"));
    assert.notEqual(readFileSync(file, "utf8"), body, "fixture must actually bump the ARG");
    assert.notEqual(computeBuildInputDigest(tmp), before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
