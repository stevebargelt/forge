// Single source of truth for the dashboard's new-run modal: which fields each
// workflow requires, what they look like in the form, and what to validate
// before shelling out to `forge new`. Per Steven's call (2026-05-08) this lives
// in dashboard/ rather than types/ — it's a UX schema, not a runtime contract;
// the CLI keeps its Commander flag declarations as the source of truth there.

import type { WorkflowName } from "../types/index.js";

export type FieldType = "text" | "textarea" | "path";

export type FieldSpec = {
  // Internal name. Maps 1:1 to the `forge new` flag (e.g. "brief" → --brief).
  name: string;
  // Human-readable label rendered above the input.
  label: string;
  type: FieldType;
  required: boolean;
  // One-line helper text rendered under the input.
  help?: string;
  // Pre-fill value (for designDir / project conveniences).
  defaultValue?: string;
  // Placeholder text (only used when defaultValue is absent).
  placeholder?: string;
};

export type WorkflowSpec = {
  name: WorkflowName;
  // Short description rendered when the workflow is selected.
  description: string;
  // Fields beyond the universal {title, project}. Order = render order.
  fields: FieldSpec[];
};

// Universal fields every workflow gets. Rendered first; not part of `fields`
// arrays so they don't have to be repeated 6×.
export const UNIVERSAL_FIELDS: FieldSpec[] = [
  {
    name: "title",
    label: "Title",
    type: "text",
    required: true,
    help: "Human-readable run title (used to derive the run id and the design slug).",
    placeholder: "e.g. forge stats widget",
  },
  {
    name: "project",
    label: "--project",
    type: "path",
    required: true,
    help: "Project directory mounted at /project on agent containers. Absolute path.",
    placeholder: "/Users/you/code/your-project",
  },
];

// Per-workflow extras. Required-ness here mirrors the CLI's expectations:
// - investigation needs --question
// - feature-ui-design-provided needs --prd
// - feature / feature-ui-design-needed / ui-design / ui-design-revise need --brief
// - feature-ui-design-needed / ui-design / ui-design-revise need --design-dir
// - codebase-assessment has no extras
export const WORKFLOW_SPECS: Record<WorkflowName, WorkflowSpec> = {
  feature: {
    name: "feature",
    description: "Build a feature with no UI/UX design step (CLI, API, library, internal refactor). Architect → plan → build → verify.",
    fields: [
      {
        name: "brief",
        label: "--brief",
        type: "textarea",
        required: true,
        help: "What you want built, in your own words. Architect produces systems-level concerns (risks, constraints, boundaries) — not implementation guidance.",
        placeholder: "Add a forge submit --dry-run flag that validates artifacts without transitioning the task…",
      },
    ],
  },
  "feature-ui-design-needed": {
    name: "feature-ui-design-needed",
    description: "Build a feature that needs UI design first. Composed: brief → ui-review → architect → plan → build → verify.",
    fields: [
      {
        name: "brief",
        label: "--brief",
        type: "textarea",
        required: true,
        help: "What the feature does AND how the UI should feel. The brief feeds both the design step and the architect step.",
        placeholder: "A run-detail panel showing per-task progress with red verdicts inline…",
      },
      {
        name: "designDir",
        label: "--design-dir",
        type: "path",
        required: true,
        help: "Where the .pen, designs/, and code/ artifacts live. Absolute path.",
        placeholder: "/Users/you/code/your-design-dir",
      },
    ],
  },
  "feature-ui-design-provided": {
    name: "feature-ui-design-provided",
    description: "Build a feature where the UI design already exists (a .pen, mocks, or PRD with design). Architect → plan → build → verify.",
    fields: [
      {
        name: "prd",
        label: "--prd",
        type: "path",
        required: true,
        help: "Absolute path to the PRD / design doc / spec file. Architect reads this as upstream context.",
        placeholder: "/Users/you/code/your-project/docs/feature-x.md",
      },
    ],
  },
  investigation: {
    name: "investigation",
    description: "Investigate a question or hypothesis; produces claims + experiments.",
    fields: [
      {
        name: "question",
        label: "--question",
        type: "textarea",
        required: true,
        help: "The framing question — single-sentence is fine, multi-paragraph also fine.",
        placeholder: "Why is the build slow on CI but not locally?",
      },
    ],
  },
  "codebase-assessment": {
    name: "codebase-assessment",
    description: "Multi-lens assessment of an existing codebase; framer scopes, lens agents fan out.",
    fields: [],
  },
  "ui-design": {
    name: "ui-design",
    description: "Design a UI from a brief. prompt-author writes PROMPT.md; you run it against Pencil; submit artifacts back.",
    fields: [
      {
        name: "brief",
        label: "--brief",
        type: "textarea",
        required: true,
        help: "What the UI should look like and feel like — be opinionated about style.",
        placeholder: "A small dashboard widget showing live forge stats; monospace, dense, terminal-adjacent.",
      },
      {
        name: "designDir",
        label: "--design-dir",
        type: "path",
        required: true,
        help: "Where the .pen, designs/, and code/ artifacts live. Absolute path. Default: ~/code/<title-slug>/.",
        placeholder: "/Users/you/code/your-design-dir",
      },
    ],
  },
  "ui-design-revise": {
    name: "ui-design-revise",
    description: "Revise a prior ui-design run. Same designDir; opens the existing .pen and applies changes.",
    fields: [
      {
        name: "brief",
        label: "--brief (revision)",
        type: "textarea",
        required: true,
        help: "What to change. Reference the existing screens; the prompt-author opens the prior .pen.",
        placeholder: "Tighten the awaiting-gate emphasis; add a third state: error/stale.",
      },
      {
        name: "designDir",
        label: "--design-dir",
        type: "path",
        required: true,
        help: "Existing design dir from the prior ui-design run. Absolute path.",
        placeholder: "/Users/you/code/your-design-dir",
      },
    ],
  },
};

// Workflow groups for the modal picker (Steven 2026-05-08 — phase grouping
// in the modal). Each group has a label + ordered workflow names. Render
// order within a group is intentional (most-common variant first).
export const WORKFLOW_GROUPS: { label: string; workflows: WorkflowName[] }[] = [
  {
    label: "Build features",
    workflows: ["feature", "feature-ui-design-needed", "feature-ui-design-provided"],
  },
  {
    label: "Design UI",
    workflows: ["ui-design", "ui-design-revise"],
  },
  {
    label: "Investigate or audit",
    workflows: ["investigation", "codebase-assessment"],
  },
];

// Flat order — derived from WORKFLOW_GROUPS so the two stay in sync.
export const WORKFLOW_ORDER: WorkflowName[] = WORKFLOW_GROUPS.flatMap((g) => g.workflows);

// ---------- validation ----------

export type ValidationError = {
  field: string;
  message: string;
};

// Loose-by-design: per Steven's call, the server enforces "looks absolute,
// not shell-injection-shaped" on paths and "non-empty" on required text;
// downstream `forge new` handles real existence checks.
export function validateNewRunBody(
  workflow: WorkflowName | string,
  body: Record<string, unknown>
): { ok: true; values: Record<string, string> } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  const spec = (WORKFLOW_SPECS as Record<string, WorkflowSpec | undefined>)[workflow];
  if (!spec) {
    return { ok: false, errors: [{ field: "workflow", message: `Unknown workflow '${workflow}'. Valid: ${WORKFLOW_ORDER.join(", ")}` }] };
  }

  const values: Record<string, string> = {};
  const allFields = [...UNIVERSAL_FIELDS, ...spec.fields];

  for (const f of allFields) {
    const raw = body[f.name];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (f.required && v.length === 0) {
      errors.push({ field: f.name, message: `${f.label} is required.` });
      continue;
    }
    if (v.length === 0) continue;
    if (f.type === "path") {
      if (!v.startsWith("/") && !v.startsWith("~")) {
        errors.push({ field: f.name, message: `${f.label} must be an absolute path.` });
        continue;
      }
      if (/[`$;|&<>\n]/.test(v)) {
        errors.push({ field: f.name, message: `${f.label} contains characters not allowed in paths.` });
        continue;
      }
    }
    values[f.name] = v;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, values };
}

// Translate a validated values map into argv for `forge new <workflow> <title> ...`.
// Universal fields title + project come first (title is positional after workflow);
// per-workflow flags follow. Returned argv is suitable for cpSpawn directly — no
// shell, no quoting concerns.
export function buildForgeNewArgv(workflow: WorkflowName, values: Record<string, string>): string[] {
  const argv: string[] = ["new", workflow, values.title ?? ""];
  if (values.project) argv.push("--project", values.project);
  if (values.brief) argv.push("--brief", values.brief);
  if (values.question) argv.push("--question", values.question);
  if (values.prd) argv.push("--prd", values.prd);
  if (values.designDir) argv.push("--design-dir", values.designDir);
  return argv;
}
