import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const FORGE_HOME = process.env.FORGE_HOME ?? join(homedir(), ".forge");
export const RUNS_DIR = join(FORGE_HOME, "runs");
export const AGENTS_DIR = join(FORGE_HOME, "agents");
export const CONSTRAINTS_DIR = join(FORGE_HOME, "constraints");
// FORGE_DB_PATH overrides the default; pass `:memory:` in tests for an in-memory SQLite.
export const DB_PATH = process.env.FORGE_DB_PATH ?? join(FORGE_HOME, "forge.db");

export function ensureForgeDirs(): void {
  for (const dir of [FORGE_HOME, RUNS_DIR, AGENTS_DIR, CONSTRAINTS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function runDir(runId: string): string {
  return join(RUNS_DIR, runId);
}

export function taskDir(runId: string, taskId: string): string {
  return join(RUNS_DIR, runId, taskId);
}
