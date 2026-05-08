import type { Command } from "commander";
import { newRunId, newTaskId, nowIso } from "../../util/ids.js";
import { ensureForgeDirs, runDir, sanitizeTitleForFilename } from "../../util/paths.js";
import { mkdirSync } from "node:fs";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import { loadWorkflow } from "../../spine/workflows.js";
import type { Run, Task, TaskPackage, WorkflowName } from "../../types/index.js";

const VALID: WorkflowName[] = [
  "feature-design-provided",
  "feature-design-needed",
  "investigation",
  "codebase-assessment",
  "ui-design",
  "design-revise",
];

export function registerNew(program: Command): void {
  program
    .command("new")
    .argument("<workflow>", `one of: ${VALID.join(", ")}`)
    .argument("<title>", "human-readable run title (used to derive the run id)")
    .option("--question <q>", "for investigation: the framing question")
    .option("--prd <path>", "path to a PRD/spec file")
    .option("--brief <text>", "for ui-design / design-revise: the design brief")
    .option("--design-dir <path>", "for ui-design / design-revise: directory for the .pen file + designs/ + code/. Defaults to ~/code/<sanitized-title>/.")
    .option("--project <path>", "project directory mounted at /project on agent containers. Defaults to cwd. Subsequent forge next calls reuse this without --project.")
    .option("--meta <json>", "extra run metadata as JSON")
    .description("Create a new workflow run")
    .action(async (workflow: string, title: string, options) => {
      if (!VALID.includes(workflow as WorkflowName)) {
        throw new Error(`Unknown workflow '${workflow}'. Valid: ${VALID.join(", ")}`);
      }
      ensureForgeDirs();
      const wf = await loadWorkflow(workflow as WorkflowName);
      const runId = newRunId(title);
      const metadata: Record<string, unknown> = options.meta ? JSON.parse(options.meta) : {};
      if (options.question) metadata.question = options.question;
      if (options.prd) metadata.prd = options.prd;
      if (options.brief) metadata.brief = options.brief;
      const designDir =
        (options as { designDir?: string }).designDir ?? deriveDefaultDesignDir(workflow as WorkflowName, title);
      if (designDir) metadata.designDir = designDir;

      const projectDir = (options as { project?: string }).project ?? process.cwd();

      const run: Run = {
        id: runId,
        workflow: wf.name,
        title,
        status: "active",
        createdAt: nowIso(),
        metadata,
        projectDir,
      };
      insertRun(run);
      mkdirSync(runDir(runId), { recursive: true });
      logEvent("run.created", { runId, payload: { workflow: wf.name, title } });

      // Seed first-phase tasks (one per agent).
      const firstPhase = wf.phases[0];
      if (!firstPhase) {
        throw new Error(`Workflow ${wf.name} has no phases.`);
      }
      const seedInputs: Record<string, unknown> = {};
      if (options.question) seedInputs.question = options.question;
      if (options.prd) seedInputs.prd = options.prd;
      if (options.brief) seedInputs.brief = options.brief;
      if (designDir) seedInputs.designDir = designDir;

      for (const agent of firstPhase.agents) {
        const taskId = newTaskId(firstPhase.name);
        const taskPackage: TaskPackage = {
          taskId,
          runId,
          phase: firstPhase.name,
          role: agent.role,
          inputs: seedInputs,
          composedSystemPrompt: "",
        };
        const task: Task = {
          id: taskId,
          runId,
          phase: firstPhase.name,
          agentRole: agent.role,
          agentAlias: agent.alias,
          agentModel: agent.model,
          status: "pending",
          taskPackage,
          createdAt: nowIso(),
        };
        insertTask(task);
        logEvent("task.created", { runId, taskId });
      }

      console.log(`Created run ${runId}`);
      console.log(`Workflow: ${wf.name}`);
      console.log(`Title:    ${title}`);
      console.log(`First phase: ${firstPhase.name} (${firstPhase.agents.length} task(s) seeded)`);
      console.log(`Project:  ${projectDir}`);
      if (designDir) console.log(`Design dir: ${designDir}`);
      console.log(`\nNext:\n  forge next ${runId}`);
    });
}

// Default design-dir convention: ~/code/<sanitized-title>/. Slug rule lives in
// util/paths.ts so `forge submit`'s artifact validator uses the same convention
// the run was created with.
function deriveDefaultDesignDir(workflow: WorkflowName, title: string): string | undefined {
  if (workflow !== "ui-design" && workflow !== "design-revise") return undefined;
  const home = process.env.HOME ?? "~";
  return `${home}/code/${sanitizeTitleForFilename(title)}`;
}
