import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureForgeDirs } from "../../util/paths.js";
import { invoke } from "../../v2/invoke.js";
import { parseContractFile } from "../../v2/contract.js";

export function registerInvoke(program: Command): void {
  program
    .command("invoke")
    .argument("<agent-role>", "agent role (e.g. architecture-advisor, engineer, research-specialist, red-frontend)")
    .description("Dispatch a single agent against a freeform task; creates a one-task run visible in the dashboard")
    .option("--task <text>", "freeform task description")
    .option("--task-file <path>", "read task from a file instead of --task")
    .option("--project <dir>", "project directory mounted at /project (default: cwd)")
    .option("--design-dir <dir>", "optional design corpus, mounted RO at /design")
    .option("--model <alias>", "override model alias (spec-writer | fast-orchestrator | etc.)")
    .option("--runtime <name>", "override runtime YAML name (default: claude)")
    .option("--read-only", "mount /project read-only (default for adversarial / review work)")
    .option("--auth-profile <name>", "inject a captured auth profile (#176) so the agent tests the app authenticated; never sees the credential")
    .option("--contract <path>", "AWN-4: attach an explicit task contract (YAML/JSON) — objective, allowed_paths, validation, invariants")
    .option("--run <run-id>", "attach this invocation as a task in an existing run; otherwise a new one is created")
    .option("--run-title <text>", "title for the new run when --run is not provided")
    .option("--workspace <path>", "orchestrator's workspace dir (default: cwd). For per-workspace `forge status` filtering. Distinct from --project when an audit workspace targets external repos.")
    .option("--json", "emit the result.json verbatim to stdout instead of a human-readable summary")
    .action(async (agentRole: string, opts: {
      task?: string;
      taskFile?: string;
      project?: string;
      designDir?: string;
      model?: string;
      runtime?: string;
      readOnly?: boolean;
      authProfile?: string;
      contract?: string;
      run?: string;
      runTitle?: string;
      workspace?: string;
      json?: boolean;
    }) => {
      ensureForgeDirs();

      // Resolve the task text.
      const task = resolveTaskText(opts.task, opts.taskFile);
      if (!task) {
        throw new Error("provide --task <text> or --task-file <path>");
      }

      const projectDir = resolve(opts.project ?? process.cwd());
      if (!existsSync(projectDir)) {
        throw new Error(`project dir does not exist: ${projectDir}`);
      }
      const workspace = resolve(opts.workspace ?? process.cwd());
      // AWN-4: optional explicit task contract (YAML/JSON file).
      const contract = opts.contract ? parseContractFile(resolve(opts.contract)) : undefined;

      const result = await invoke({
        agentRole,
        task,
        projectDir,
        designDir: opts.designDir ? resolve(opts.designDir) : undefined,
        modelAlias: opts.model,
        runtimeName: opts.runtime,
        readOnlyProject: opts.readOnly,
        authProfile: opts.authProfile,
        ...(contract ? { contract } : {}),
        runId: opts.run,
        runTitle: opts.runTitle,
        workspace,
      });

      if (opts.json) {
        // Structured: orchestrator-friendly. Includes run/task IDs + the agent's result.
        console.log(JSON.stringify({
          runId: result.runId,
          taskId: result.taskId,
          status: result.status,
          result: result.result ?? null,
          error: result.error ?? null,
        }, null, 2));
        return;
      }

      // Human-readable summary.
      if (result.status === "failed") {
        console.error(`✗ ${agentRole} failed: ${result.error ?? "(no error)"}`);
        console.error(`  run:  ${result.runId}`);
        console.error(`  task: ${result.taskId}`);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ ${agentRole} complete`);
      console.log(`  run:  ${result.runId}`);
      console.log(`  task: ${result.taskId}`);
      console.log(``);
      console.log(`Read full result with:`);
      console.log(`  forge show ${result.taskId}`);
    });
}

function resolveTaskText(task: string | undefined, taskFile: string | undefined): string | undefined {
  if (task) return task;
  if (taskFile) {
    const path = resolve(taskFile);
    if (!existsSync(path)) throw new Error(`--task-file not found: ${path}`);
    return readFileSync(path, "utf8");
  }
  return undefined;
}
