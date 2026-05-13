// Tests confirming the six new agent seeds (#96 foundation) exist in the
// repo's seeds/ directory with the expected file structure (CLAUDE.md +
// settings.json). These guard against accidental seed deletion or rename.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Walk up from src/workflows/ to repo root, then seeds/agents/.
const REPO_ROOT = join(here, "..", "..");
const SEEDS_DIR = join(REPO_ROOT, "seeds", "agents");

const SPECIALIST_SEEDS = [
  // Specialist reds — discipline-specific informational reviewers
  "red-frontend",
  "red-backend",
  "red-security",
  // Specialist implementers — discipline-specific implementer agents
  "frontend-implementer",
  "backend-implementer",
  "infosec-implementer",
];

for (const seed of SPECIALIST_SEEDS) {
  test(`specialist seed ${seed} has CLAUDE.md and settings.json`, () => {
    const dir = join(SEEDS_DIR, seed);
    assert.ok(existsSync(dir), `seed dir missing: ${dir}`);
    assert.ok(existsSync(join(dir, "CLAUDE.md")), `${seed}/CLAUDE.md missing`);
    assert.ok(existsSync(join(dir, "settings.json")), `${seed}/settings.json missing`);
  });
}

test("specialist red seeds declare read-only tools", () => {
  for (const role of ["red-frontend", "red-backend", "red-security"]) {
    const settings = JSON.parse(
      readFileSync(join(SEEDS_DIR, role, "settings.json"), "utf8")
    ) as { tools: string[] };
    assert.deepEqual(
      settings.tools,
      ["read"],
      `${role} should declare read-only tools (matches red-wide / red-narrow pattern)`
    );
  }
});

test("specialist implementer seeds declare full read/write tools", () => {
  for (const role of [
    "frontend-implementer",
    "backend-implementer",
    "infosec-implementer",
  ]) {
    const settings = JSON.parse(
      readFileSync(join(SEEDS_DIR, role, "settings.json"), "utf8")
    ) as { tools: string[] };
    assert.deepEqual(
      settings.tools.sort(),
      ["bash", "edit", "read", "write"],
      `${role} should declare full read/write/bash tools (matches implementer pattern)`
    );
  }
});

test("discipline red CLAUDE.md self-identifies + declares gating behavior (#113)", () => {
  for (const role of ["red-frontend", "red-backend", "red-security"]) {
    const text = readFileSync(join(SEEDS_DIR, role, "CLAUDE.md"), "utf8");
    assert.match(
      text,
      /discipline red/i,
      `${role} CLAUDE.md should self-identify as discipline red`
    );
    assert.match(
      text,
      /blocks the gate/i,
      `${role} CLAUDE.md should declare its fail blocks the gate (#113)`
    );
  }
});

test("specialist implementer CLAUDE.md declares discipline in output schema", () => {
  const expected: Record<string, string> = {
    "frontend-implementer": '"discipline": "frontend"',
    "backend-implementer": '"discipline": "backend"',
    "infosec-implementer": '"discipline": "infosec"',
  };
  for (const [role, marker] of Object.entries(expected)) {
    const text = readFileSync(join(SEEDS_DIR, role, "CLAUDE.md"), "utf8");
    assert.ok(
      text.includes(marker),
      `${role} should include ${marker} in output schema`
    );
  }
});
