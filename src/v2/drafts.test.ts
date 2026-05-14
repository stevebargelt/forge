// Acceptance test: every drafted .yml.draft file in
// docs/prds/yaml-orchestrator-116/ parses + validates under the v2 schemas.
//
// This is the proof that the 7 translated workflows + 1 runtime fit the
// schema as written. If a draft fails here, either the schema needs to
// change or the draft does — both are real signals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { WorkflowSchema, RuntimeSchema } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAFTS_DIR = join(HERE, "..", "..", "docs", "prds", "yaml-orchestrator-116");

const WORKFLOWS = [
  "feature",
  "feature-ui-design-provided",
  "feature-ui-design-needed",
  "investigation",
  "codebase-assessment",
  "ui-design",
  "ui-design-revise",
];

for (const wf of WORKFLOWS) {
  test(`draft '${wf}.yml.draft' parses + validates`, () => {
    const path = join(DRAFTS_DIR, `${wf}.yml.draft`);
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw);
    const result = WorkflowSchema.safeParse(parsed);
    assert.ok(
      result.success,
      result.success
        ? ""
        : JSON.stringify(result.error.issues, null, 2)
    );
    assert.equal(result.data!.name, wf, "workflow name should match filename");
  });
}

test("draft 'runtime-claude-bedrock.yml.draft' parses + validates", () => {
  const path = join(DRAFTS_DIR, "runtime-claude-bedrock.yml.draft");
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const result = RuntimeSchema.safeParse(parsed);
  assert.ok(
    result.success,
    result.success
      ? ""
      : JSON.stringify(result.error.issues, null, 2)
  );
});
