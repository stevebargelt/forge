import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const FORGE_HOME = process.env.FORGE_HOME ?? join(homedir(), ".forge");
export const RUNS_DIR = join(FORGE_HOME, "runs");
export const AGENTS_DIR = join(FORGE_HOME, "agents");
export const CONSTRAINTS_DIR = join(FORGE_HOME, "constraints");
// FG-351: git worktrees live under WORKTREES_DIR/<runId>/<taskId>. Inside
// Docker Desktop's macOS file-sharing allowlist (under ~/.forge).
export const WORKTREES_DIR = join(FORGE_HOME, "worktrees");
// The installed host RACI source (authoring view). `forge raci validate` lints
// this by default.
export const RACI_PATH = join(FORGE_HOME, "forge-raci.md");
// Installed workflows; the derived routing policy. `forge route validate`
// resolves workflow symbols against WORKFLOWS_DIR and lints ROUTING_POLICY_PATH
// by default.
export const WORKFLOWS_DIR = join(FORGE_HOME, "workflows");
export const ROUTING_POLICY_PATH = join(FORGE_HOME, "routing-policy.yml");
// Append-only JSONL audit trail of orchestrator-mediated RACI changes (#279).
// One line per `forge raci apply --confirm`; host-global, outside any repo.
export const RACI_AUDIT_LOG_PATH = join(FORGE_HOME, "raci-audit.log");
// FORGE_DB_PATH overrides the default; pass `:memory:` in tests for an in-memory SQLite.
export const DB_PATH = process.env.FORGE_DB_PATH ?? join(FORGE_HOME, "forge.db");

export function ensureForgeDirs(): void {
  for (const dir of [FORGE_HOME, RUNS_DIR, AGENTS_DIR, CONSTRAINTS_DIR, WORKTREES_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function runDir(runId: string): string {
  return join(RUNS_DIR, runId);
}

export function taskDir(runId: string, taskId: string): string {
  return join(RUNS_DIR, runId, taskId);
}

// FG-351: path where a task's git worktree is checked out.
export function worktreeDir(runId: string, taskId: string): string {
  return join(WORKTREES_DIR, runId, taskId);
}

// Host path of the PROMPT.md a prompt-author task wrote. The agent writes to
// `/task/PROMPT.md` (in-container); that bind-mounts to taskDir() on the host.
// The dashboard renders the prompt body inline; validation works off the run's
// designDir, not the prompt path.
export function briefPromptHostPath(runId: string, briefTaskId: string): string {
  return join(taskDir(runId, briefTaskId), "PROMPT.md");
}

// Expand a leading `~` in a path to the user's home directory. Forge stores
// projectDir / designDir verbatim, but downstream consumers (docker -v, fs
// existsSync) don't do shell-style expansion. The dashboard's POST body
// likewise never goes through a shell. So we expand once at run creation —
// after that everything sees an absolute path. Returns absolute paths
// unchanged; returns relative paths unchanged (caller decides what to do).
export function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Sanitize a run title to a filename slug. Source of truth for the
// `<sanitized-title>.pen` convention used by ui-design / ui-design-revise / feature-ui-design-needed workflows.
// Both `forge new --design-dir` defaulting and design validation share this rule
// so the .pen file produced by Pencil and the .pen file expected by the validator
// are guaranteed to match.
export function sanitizeTitleForFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}
