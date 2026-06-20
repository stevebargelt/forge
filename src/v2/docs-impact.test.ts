import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDocsImpact, formatDocsImpactWarning, type TaskDocsSignals } from "./docs-impact.js";

const sig = (o: Partial<TaskDocsSignals>): TaskDocsSignals => ({
  filesModified: [],
  docsUpdated: false,
  deferred: false,
  ...o,
});

test("assessDocsImpact: empty run is not impacted", () => {
  const r = assessDocsImpact([]);
  assert.deepEqual(r, { impacted: false, resolved: false, surfaces: [] });
});

test("assessDocsImpact: operator-surface change with no docs work → impacted, unresolved", () => {
  const r = assessDocsImpact([sig({ filesModified: ["src/cli/commands/usage.ts"] })]);
  assert.equal(r.impacted, true);
  assert.equal(r.resolved, false);
  assert.deepEqual(r.surfaces, ["src/cli/"]);
});

test("assessDocsImpact: docs_updated on any task resolves the impact", () => {
  const r = assessDocsImpact([
    sig({ filesModified: ["seeds/workflows/feature.yml"] }),
    sig({ docsUpdated: true }), // the documenter ran
  ]);
  assert.equal(r.impacted, true);
  assert.equal(r.resolved, true);
});

test("assessDocsImpact: deferred-with-reason resolves the impact", () => {
  const r = assessDocsImpact([
    sig({ filesModified: ["src/notify/milestone.ts"] }),
    sig({ deferred: true }),
  ]);
  assert.equal(r.resolved, true);
});

test("assessDocsImpact: docs-only change is not an impact", () => {
  const r = assessDocsImpact([sig({ filesModified: ["docs/concepts.md", "learnings/decisions/x.md"] })]);
  assert.equal(r.impacted, false);
});

test("formatDocsImpactWarning: warns only on impacted+unresolved, names runId + surfaces", () => {
  const warn = formatDocsImpactWarning(
    { impacted: true, resolved: false, surfaces: ["src/cli/", "seeds/runtimes/"] },
    "run-abc",
  );
  assert.ok(warn);
  assert.match(warn!, /UNRESOLVED/);
  assert.match(warn!, /src\/cli\//);
  assert.match(warn!, /run-abc/);
  assert.match(warn!, /Advisory only/);
  // No warning when not impacted, or when resolved.
  assert.equal(formatDocsImpactWarning({ impacted: false, resolved: false, surfaces: [] }, "r"), null);
  assert.equal(formatDocsImpactWarning({ impacted: true, resolved: true, surfaces: ["src/cli/"] }, "r"), null);
});
