// FG-670: this assertion is intentionally scoped to the forge repository.
// Generic Markdown-mode projects retain these directories as their backend.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const LEGACY_TICKET_DIRS = ["backlog/done", "backlog/stories", "backlog/epics", "backlog/ideas"];

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

test("FG-670: forge tracks no frozen Markdown tickets while retaining operational backlog files", () => {
  const root = repoRoot();
  const tracked = execFileSync("git", ["ls-files", "--", ...LEGACY_TICKET_DIRS], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path.endsWith(".md"));

  assert.deepEqual(tracked, [], "the deleted frozen ticket corpus must not return");
  for (const path of ["backlog/PLAN.md", "backlog/notes.md"]) {
    assert.ok(existsSync(join(root, path)), `${path} remains in the forge repository`);
  }
});
