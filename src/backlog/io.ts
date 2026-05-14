// forge backlog — file I/O.
//
// BACKLOG.md lives at the project root (the same place `forge init` writes
// CLAUDE.md). We don't put it in ~/.forge/ because backlogs are
// project-scoped and want to live in git alongside the code.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseBacklog } from "./parse.js";
import { serializeBacklog } from "./serialize.js";
import type { Backlog } from "./types.js";

export function backlogPath(projectDir: string): string {
  return join(projectDir, "BACKLOG.md");
}

export function readBacklog(projectDir: string): Backlog {
  const path = backlogPath(projectDir);
  if (!existsSync(path)) {
    throw new Error(`BACKLOG.md not found at ${path}. Run from your project root or pass --project.`);
  }
  const content = readFileSync(path, "utf8");
  return parseBacklog(content);
}

export function writeBacklog(projectDir: string, b: Backlog): void {
  const path = backlogPath(projectDir);
  writeFileSync(path, serializeBacklog(b));
}
