// FG-806: builder seeds may offer an install fallback only after they explain
// the task-package dependency-environment gate.  This guards the shipped seeds,
// rather than a rendered snapshot, so ordinary prose formatting can evolve.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUILDER_ROLES = [
  "engineer",
  "frontend-specialist",
  "backend-specialist",
  "agentic-platform-builder",
  "documentation-maintainer",
] as const;

const seedsDir = fileURLToPath(new URL("../../seeds/agents/", import.meta.url));

/** Deliberate install commands, whether they occur in prose or a fenced example. */
const INSTALL_COMMAND = /\b(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install)\b/gi;

test("fg806: shipped builder seeds gate dependency installation on the task package environment section", () => {
  for (const role of BUILDER_ROLES) {
    const seed = readFileSync(`${seedsDir}${role}/CLAUDE.md`, "utf8");
    const installCommands = [...seed.matchAll(INSTALL_COMMAND)];

    // A prohibition (for example the documentation maintainer's "never run npm
    // install") is not an install instruction. The builder roles that offer a
    // fallback must state both branches before showing an install command.
    const fallback = /Otherwise\s*\(\s*no\s+such\s+section\s*\)[\s\S]{0,600}?\binstall\s+first\b/i.exec(seed);
    if (fallback) {
      assert.match(
        seed,
        /If\s+the\s+task\s+package\s+has\s+a\s+`?##\s*Dependency environment`?\s+section[\s\S]{0,500}?read-only[\s\S]{0,300}?do\s+(?:\*\*)?not(?:\*\*)?\s+install/i,
        `${role} must describe the read-only, do-not-install branch`,
      );
      assert.ok(
        installCommands.some((command) => (command.index ?? -1) > (fallback.index ?? -1)),
        `${role} must put any install command after the no-section fallback`,
      );
    }

    // No seed may present an affirmative package-manager install without the
    // no-section fallback that scopes it. This stays insensitive to Markdown
    // fences, wrapping, and the exact lockfile-tool wording.
    for (const command of installCommands) {
      const lineStart = seed.lastIndexOf("\n", command.index) + 1;
      const commandLine = seed.slice(lineStart, seed.indexOf("\n", command.index));
      const isExplicitProhibition = /\b(?:never|do\s+not)\s+run\b/i.test(commandLine);
      if (!isExplicitProhibition) {
        assert.ok(
          fallback && (command.index ?? 0) > (fallback.index ?? Number.MAX_SAFE_INTEGER),
          `${role} contains an unconditional dependency install command: ${command[0]}`,
        );
      }
    }
  }
});
