import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Workflow, WorkflowName } from "../types/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(here, "..", "workflows");

const VALID_NAMES: WorkflowName[] = [
  "feature-design-provided",
  "feature-design-needed",
  "investigation",
  "codebase-assessment",
];

export async function loadWorkflow(name: WorkflowName): Promise<Workflow> {
  if (!VALID_NAMES.includes(name)) {
    throw new Error(`Unknown workflow: ${name}`);
  }
  const file = join(WORKFLOWS_DIR, `${name}.ts`);
  if (!existsSync(file)) {
    throw new Error(`Workflow definition not found: ${file}`);
  }
  const mod = (await import(pathToFileURL(file).href)) as { workflow?: Workflow };
  const wf = mod.workflow;
  if (!wf || wf.name !== name || !Array.isArray(wf.phases)) {
    throw new Error(`Invalid workflow export in ${file}`);
  }
  return wf;
}

export function findPhase(wf: Workflow, name: string) {
  return wf.phases.find((p) => p.name === name);
}

export function nextPhaseAfter(wf: Workflow, current: string) {
  const idx = wf.phases.findIndex((p) => p.name === current);
  if (idx < 0 || idx === wf.phases.length - 1) return undefined;
  return wf.phases[idx + 1];
}

export function firstPhase(wf: Workflow) {
  return wf.phases[0];
}
