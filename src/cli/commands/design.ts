// `forge design` — launch an interactive Claude Code session with Pencil MCP
// for UI/UX design work. Seeded with a PROMPT.md produced by prompt-author.
//
// Runs on the host (not in a container) because Pencil is a host-side MCP.
// Tracks the session as a task in forge's DB so the dashboard shows it
// in-flight and usage gets captured on exit.

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve as pathResolve } from "node:path";
import { resolveProjectMeta } from "../../util/project-meta.js";
import { insertRun, updateRunStatus, getRun } from "../../store/runs.js";
import { insertTask, markTaskComplete } from "../../store/tasks.js";
import { extractUsageFromTranscript, insertUsageRows } from "../../store/model-calls.js";
import { newRunId, newTaskId, nowIso } from "../../util/ids.js";
import { findProjectRoot, findSessionTranscript } from "./claude.js";

export function registerDesign(program: Command): void {
  program
    .command("design")
    .description("Launch an interactive Claude Code + Pencil design session seeded with a PROMPT.md")
    .requiredOption("--prompt <path>", "Path to the PROMPT.md file")
    .option("--run <id>", "Attach to an existing forge run (creates a new run if absent)")
    .option("--project <dir>", "Project directory (default: cwd)")
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]", "passed through to `claude`")
    .action((args: string[], opts: { prompt: string; run?: string; project?: string }) => {
      const promptPath = pathResolve(opts.prompt);
      if (!existsSync(promptPath)) {
        console.error(`forge design: PROMPT.md not found at ${promptPath}`);
        process.exit(1);
      }

      const promptContent = readFileSync(promptPath, "utf8").trim();
      if (promptContent.length === 0) {
        console.error(`forge design: PROMPT.md is empty at ${promptPath}`);
        process.exit(1);
      }

      const cwd = opts.project ? pathResolve(opts.project) : process.cwd();
      const projectRoot = findProjectRoot(cwd) ?? cwd;
      const resolvedName = resolveProjectMeta(projectRoot)?.label ?? basename(projectRoot);

      // Resolve or create the run.
      let runId: string;
      let ownsRun = false;
      const startedAt = nowIso();

      if (opts.run) {
        const existing = getRun(opts.run);
        if (!existing) {
          console.error(`forge design: run ${opts.run} not found`);
          process.exit(1);
        }
        runId = opts.run;
      } else {
        runId = newRunId("design");
        ownsRun = true;
        try {
          insertRun({
            id: runId,
            workflow: "design",
            title: `${resolvedName} design`,
            status: "active",
            createdAt: startedAt,
            projectDir: projectRoot,
          });
        } catch (err) {
          console.error(`forge design: failed to create run — ${(err as Error).message}`);
          process.exit(1);
        }
      }

      const taskId = newTaskId("design");
      try {
        insertTask({
          id: taskId,
          runId,
          phase: "design",
          agentRole: "designer",
          status: "running",
          taskPackage: {
            taskId, runId, phase: "design", role: "designer",
            inputs: { projectDir: projectRoot, promptPath: promptPath },
            composedSystemPrompt: "",
          },
          createdAt: startedAt,
          startedAt,
        });
      } catch (err) {
        console.error(`forge design: failed to create task — ${(err as Error).message}`);
        process.exit(1);
      }

      console.log(`forge design: launching design session for '${resolvedName}'`);
      console.log(`  run:    ${runId}`);
      console.log(`  task:   ${taskId}`);
      console.log(`  prompt: ${promptPath}`);
      console.log("");

      const finalArgs: string[] = [
        "-n", `design: ${resolvedName}`,
        ...args,
        promptContent,
      ];

      const child = spawn("claude", finalArgs, {
        cwd: projectRoot,
        stdio: "inherit",
        env: process.env,
      });

      child.on("exit", (code, signal) => {
        captureDesignUsage(projectRoot, taskId, runId, ownsRun);
        if (signal) process.exit(128);
        process.exit(code ?? 0);
      });

      child.on("error", (err) => {
        console.error(`forge design: failed to spawn claude — ${err.message}`);
        console.error(`  Is the \`claude\` binary in your PATH?`);
        process.exit(1);
      });
    });
}

function captureDesignUsage(
  projectRoot: string,
  taskId: string,
  runId: string,
  ownsRun: boolean,
): void {
  try {
    const transcriptPath = findSessionTranscript(projectRoot);
    if (!transcriptPath) {
      markTaskComplete(taskId, { note: "session ended, no transcript found" });
      if (ownsRun) updateRunStatus(runId, "complete");
      return;
    }

    const rows = extractUsageFromTranscript(transcriptPath, { taskId, alias: "designer" });
    if (rows.length > 0) insertUsageRows(rows);

    markTaskComplete(taskId, { rowCount: rows.length });
    if (ownsRun) updateRunStatus(runId, "complete");
  } catch {
    try {
      markTaskComplete(taskId, { note: "session ended, usage capture failed" });
      if (ownsRun) updateRunStatus(runId, "complete");
    } catch { /* give up */ }
  }
}
