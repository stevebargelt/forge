// RUN-4: `forge bundle <run-id>` — assemble a SANITIZED debug archive of a run.
//
// Security posture: ALLOWLIST, never denylist. We copy only known-safe files
// from each task dir. A task dir may contain auth-state.json (a mode-0600 bearer
// token staged by auth-state.ts); copying by glob/denylist would risk leaking it
// and any future sensitive file. By only ever reading an explicit allowlist, a
// new sensitive file cannot leak by default.

import { mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Run, Task } from "../types/index.js";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { verdictsForTask } from "../store/verdicts.js";
import { usageForTask } from "../store/model-calls.js";
import { dispatchEvidenceForTask } from "../store/tickets.js";
import { taskDir } from "../util/paths.js";

// Files safe to copy verbatim from a task dir.
const SAFE_TASK_FILES = ["result.json", "manifest.json", "progress.jsonl"] as const;
// Logs — included but BOUNDED (they can be multi-MB stream-json).
const LOG_FILES = ["container.stdout.log", "container.stderr.log"] as const;
// Prompts/packages — task context, opt-in (they restate the brief, not secrets).
const PROMPT_FILES = ["CLAUDE.md", "package.md"] as const;
// Belt-and-suspenders denylist: file basenames / patterns that must NEVER appear
// in a bundle. The allowlist above already excludes everything not on it; this is
// a second, explicit guard checked after assembly (AWN-8) so a future allowlist
// slip can't leak a credential. Matched by exact basename or suffix.
export const NEVER_BUNDLE = ["auth-state.json", ".env", "storageState.json", "qa.json"] as const;

function isDenied(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  return NEVER_BUNDLE.some((d) => base === d || base.endsWith(d) || base.startsWith(".env"));
}

const LOG_CAP_BYTES = 256 * 1024;

export type BundleOptions = { includePrompts?: boolean };

export type BundleResult = {
  bundleDir: string;
  runId: string;
  taskCount: number;
  filesIncluded: string[]; // relative to bundleDir
  truncated: string[];     // files included as a bounded tail
  note: string;
};

function copyBounded(src: string, dest: string, capBytes: number): { copied: boolean; truncated: boolean } {
  let size: number;
  try { size = statSync(src).size; } catch { return { copied: false, truncated: false }; }
  if (size <= capBytes) {
    writeFileSync(dest, readFileSync(src));
    return { copied: true, truncated: false };
  }
  const buf = Buffer.alloc(capBytes);
  const fd = openSync(src, "r");
  try { readSync(fd, buf, 0, capBytes, size - capBytes); } finally { closeSync(fd); }
  writeFileSync(dest, `... (bundled tail — first ${size - capBytes} bytes omitted)\n` + buf.toString("utf8"));
  return { copied: true, truncated: true };
}

function copyVerbatim(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  writeFileSync(dest, readFileSync(src));
  return true;
}

// bundle.json embeds the task rows. The Task carries taskPackage, whose
// composedSystemPrompt (the full system prompt) and inputs (the brief / PRD /
// upstream data) are exactly the prompt/task context that --include-prompts gates
// for the prompt FILES. Strip them by default so the prompt-context opt-in is
// honored in the JSON too; keep task identity + result (the debug signal).
function sanitizeTask(t: Task, includePrompts: boolean) {
  if (includePrompts) return t;
  const { taskPackage, ...rest } = t;
  return {
    ...rest,
    taskPackage: { taskId: taskPackage.taskId, runId: taskPackage.runId, phase: taskPackage.phase, role: taskPackage.role },
  };
}

/** Assemble a sanitized bundle for a run under destRoot. Returns a manifest of
 *  what was included. Throws if the run does not exist. */
export function assembleBundle(runId: string, destRoot: string, opts: BundleOptions = {}): BundleResult {
  const run = getRun(runId);
  if (!run) throw new Error(`bundle: run not found: ${runId}`);

  const tasks = tasksForRun(runId);
  const bundleDir = join(destRoot, `${runId}-bundle`);
  mkdirSync(bundleDir, { recursive: true });

  const filesIncluded: string[] = [];
  const truncated: string[] = [];

  const tasksData: Array<{
    task: unknown;
    verdicts: unknown[];
    usage: unknown[];
    dispatchedTicket: unknown;
  }> = [];
  for (const t of tasks) {
    const srcDir = taskDir(t.runId, t.id);
    const outDir = join(bundleDir, "tasks", t.id);
    mkdirSync(outDir, { recursive: true });

    const names: string[] = [...SAFE_TASK_FILES];
    if (opts.includePrompts) names.push(...PROMPT_FILES);
    for (const name of names) {
      if (copyVerbatim(join(srcDir, name), join(outDir, name))) filesIncluded.push(`tasks/${t.id}/${name}`);
    }
    for (const name of LOG_FILES) {
      const r = copyBounded(join(srcDir, name), join(outDir, name), LOG_CAP_BYTES);
      if (r.copied) {
        filesIncluded.push(`tasks/${t.id}/${name}`);
        if (r.truncated) truncated.push(`tasks/${t.id}/${name}`);
      }
    }

    tasksData.push({
      task: sanitizeTask(t, !!opts.includePrompts),
      verdicts: verdictsForTask(t.id),
      usage: usageForTask(t.id),
      // FG-608: the ticket revision + body hash this task was CONSTRUCTED from.
      // Reproducibility evidence, not live authority — the live ticket may have
      // advanced since, and the two records deliberately never overwrite each
      // other. Null for a task with no ticket, or for a project that had not cut
      // over to the DB store when it was dispatched.
      dispatchedTicket: dispatchEvidenceForTask(t.id) ?? null,
    });
  }

  const note =
    "Sanitized bundle. Files copied by ALLOWLIST only — auth state / bearer tokens / " +
    "credentials are never included. Logs are bounded to the last 256KB. The manifest " +
    "(manifest.json) auth block is booleans-only by design.";

  const manifest = {
    runId,
    run,
    note,
    tasks: tasksData,
    events: eventsForRun(runId),
    filesIncluded,
    truncated,
  };
  writeFileSync(join(bundleDir, "bundle.json"), JSON.stringify(manifest, null, 2));

  // AWN-8 defense-in-depth: assert the allowlist never let a denied (credential)
  // file through. This should be impossible by construction; if it ever trips,
  // fail loudly rather than ship a bundle with secrets.
  const leaked = filesIncluded.filter(isDenied);
  if (leaked.length > 0) {
    throw new Error(`bundle: refusing to ship — denylisted files were included: ${leaked.join(", ")}`);
  }

  return { bundleDir, runId, taskCount: tasks.length, filesIncluded, truncated, note };
}
