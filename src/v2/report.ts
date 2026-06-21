import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Run } from "../types/index.js";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { sanitizeTitleForFilename, taskDir } from "../util/paths.js";

export type SynthesisClaim = {
  id: string;
  claim: string;
  verdict: "supported" | "refuted" | "inconclusive";
  evidence: string;
  disagreements: string;
  confidence: "high" | "medium" | "low";
};

export type SynthesizeResult = {
  status: string;
  overall_summary?: string;
  claims: SynthesisClaim[];
};

const VERDICT_LABEL: Record<string, string> = {
  supported: "SUPPORTED",
  refuted: "REFUTED",
  inconclusive: "INCONCLUSIVE",
};

export function buildReportMarkdown(question: string, result: SynthesizeResult): string {
  const lines: string[] = [];

  lines.push(`# ${question}`, "");

  if (result.overall_summary) {
    lines.push(result.overall_summary, "");
  }

  if (result.claims.length > 0) {
    lines.push("---", "");
  }

  for (const claim of result.claims) {
    const verdictLabel = VERDICT_LABEL[claim.verdict] ?? claim.verdict.toUpperCase();
    const confidence = claim.confidence ?? "";

    lines.push(`## ${claim.claim}`, "");
    lines.push(`**Verdict:** ${verdictLabel}  |  **Confidence:** ${confidence}`, "");

    if (claim.evidence) {
      lines.push("### Evidence", "", claim.evidence, "");
    }

    if (claim.disagreements) {
      lines.push("### Disagreements", "", claim.disagreements, "");
    }
  }

  return lines.join("\n");
}

export function resolveReportPath(run: Run): string {
  const stored = run.metadata?.["reportOutputPath"];
  if (typeof stored === "string" && stored) return stored;

  if (!run.projectDir) {
    throw new Error(`forge report: run ${run.id} has no projectDir — cannot resolve a predictable report path. Re-run with --project <dir> or pass --out <path> to specify the output explicitly.`);
  }
  const slug = sanitizeTitleForFilename(run.title) + "-" + run.id.slice(-8);
  return join(run.projectDir, "research", slug + ".md");
}

function readResultJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function renderResearchReport(runId: string): { markdown: string; outputPath: string } {
  const run = getRun(runId);
  if (!run) throw new Error(`forge report: run not found: ${runId}`);

  const tasks = tasksForRun(runId);

  // Find the latest synthesize task at the top level (not a fanout child)
  const synthesizeTasks = tasks.filter((t) => t.phase === "synthesize" && !t.parentId);
  const synthesizeTask = synthesizeTasks[synthesizeTasks.length - 1];
  if (!synthesizeTask) {
    throw new Error(`forge report: no synthesize task found for run ${runId}`);
  }

  const synthesizeResultPath = join(taskDir(runId, synthesizeTask.id), "result.json");
  const synthesizeResult = readResultJson(synthesizeResultPath);
  if (!synthesizeResult) {
    throw new Error(`forge report: synthesize result not found at ${synthesizeResultPath}`);
  }

  const claims = Array.isArray(synthesizeResult["claims"])
    ? (synthesizeResult["claims"] as SynthesisClaim[])
    : [];
  const overall_summary =
    typeof synthesizeResult["overall_summary"] === "string"
      ? synthesizeResult["overall_summary"]
      : undefined;

  const result: SynthesizeResult = { status: "complete", overall_summary, claims };

  // Extract the research question from the frame task result, fall back to run title
  let question = run.title;
  const frameTasks = tasks.filter((t) => t.phase === "frame" && !t.parentId);
  const frameTask = frameTasks[frameTasks.length - 1];
  if (frameTask) {
    const frameResultPath = join(taskDir(runId, frameTask.id), "result.json");
    const frameResult = readResultJson(frameResultPath);
    if (typeof frameResult?.["question"] === "string" && frameResult["question"]) {
      question = frameResult["question"] as string;
    }
  }

  const markdown = buildReportMarkdown(question, result);
  const outputPath = resolveReportPath(run);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown, "utf8");

  return { markdown, outputPath };
}
