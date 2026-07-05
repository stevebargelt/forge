import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveDefaultDesignDir,
  defaultPenFileName,
  assertNoControlPlaneMeta,
  workflowRequiresTicket,
  resolveTicketId,
} from "./new.js";
import { WorkflowSchema, type Workflow } from "../../v2/schema.js";
import { writeTicket, type StructuredTicket } from "../../backlog/structured.js";

// #67: design-touching workflows default --design-dir to <projectDir>/designs/
// (per-project shared corpus), replacing the prior ~/code/<sanitized-title>/
// per-run convention. Non-design workflows still get no default.

test("deriveDefaultDesignDir: returns <projectDir>/designs for ui-design workflow", () => {
  assert.equal(
    deriveDefaultDesignDir("ui-design", "/Users/x/code/forge"),
    "/Users/x/code/forge/designs",
  );
});

test("deriveDefaultDesignDir: returns <projectDir>/designs for ui-design-revise workflow", () => {
  assert.equal(
    deriveDefaultDesignDir("ui-design-revise", "/Users/x/code/dashboard"),
    "/Users/x/code/dashboard/designs",
  );
});

test("deriveDefaultDesignDir: returns <projectDir>/designs for feature-ui-design-needed workflow", () => {
  assert.equal(
    deriveDefaultDesignDir("feature-ui-design-needed", "/Users/x/code/myapp"),
    "/Users/x/code/myapp/designs",
  );
});

test("deriveDefaultDesignDir: returns undefined for non-design workflows", () => {
  assert.equal(deriveDefaultDesignDir("feature", "/Users/x/code/forge"), undefined);
  assert.equal(deriveDefaultDesignDir("investigation", "/Users/x/code/forge"), undefined);
  assert.equal(deriveDefaultDesignDir("audit", "/Users/x/code/forge"), undefined);
});

test("deriveDefaultDesignDir: invariant — the default ALWAYS lands inside projectDir (no per-run drift)", () => {
  // The whole point of #67: every design run for the same project shares one
  // corpus. Two invocations with different titles must produce the same dir.
  const a = deriveDefaultDesignDir("ui-design", "/Users/x/code/forge");
  const b = deriveDefaultDesignDir("ui-design", "/Users/x/code/forge");
  assert.equal(a, b);
  assert.match(a ?? "", /\/Users\/x\/code\/forge\/designs$/);
});

test("defaultPenFileName: uses basename of projectDir", () => {
  assert.equal(defaultPenFileName("/Users/x/code/forge"), "forge.pen");
  assert.equal(defaultPenFileName("/Users/x/code/my-dashboard"), "my-dashboard.pen");
  assert.equal(defaultPenFileName("/tmp/scratch"), "scratch.pen");
});

test("defaultPenFileName: handles trailing slash gracefully", () => {
  assert.equal(defaultPenFileName("/Users/x/code/forge/"), "forge.pen");
});

// AWN-7: --meta is workflow input, not a control-plane backdoor. modelProfile
// (and the other reserved keys) must only be settable through their flags, so a
// user can't pin a provider via `--meta '{"modelProfile":"x"}'`.
test("assertNoControlPlaneMeta: rejects modelProfile in --meta", () => {
  assert.throws(
    () => assertNoControlPlaneMeta({ modelProfile: "claude-bedrock" }),
    /reserved key 'modelProfile'/,
  );
});

test("assertNoControlPlaneMeta: rejects every reserved key", () => {
  for (const key of ["workspace", "designDir", "authProfile", "tags"]) {
    assert.throws(
      () => assertNoControlPlaneMeta({ [key]: "x" }),
      new RegExp(`reserved key '${key}'`),
      `expected ${key} to be rejected`,
    );
  }
});

test("assertNoControlPlaneMeta: allows ordinary workflow inputs", () => {
  assert.doesNotThrow(() => assertNoControlPlaneMeta({ brief: "ship it", priority: "high" }));
});

// FG-472: `forge new feature` (non-campaign) has no ticketId, so an
// authoritative shipping-reviewer pre-fails and blocks the run. Fail BEFORE
// creating the run instead.

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "forge-new-ticket-test-"));
}

function makeTicket(overrides: Partial<StructuredTicket> = {}): StructuredTicket {
  return {
    id: "FG-1",
    type: "story",
    status: "active",
    title: "Test ticket",
    body: "Some body content.",
    ...overrides,
  };
}

function workflowWith(reds: Array<{ agent: string; authority: "authoritative" | "specialist" }>): Workflow {
  return WorkflowSchema.parse({
    name: "feature",
    description: "test",
    steps: [
      { id: "build", agent: "engineer", gate: reds.length > 0 ? "verdict" : "auto", reds },
    ],
  });
}

const noShippingReviewer = workflowWith([{ agent: "red-wide", authority: "authoritative" }]);
const specialistShippingReviewer = workflowWith([{ agent: "shipping-reviewer", authority: "specialist" }]);
const authoritativeShippingReviewer = workflowWith([{ agent: "shipping-reviewer", authority: "authoritative" }]);

test("workflowRequiresTicket: false when no shipping-reviewer red at all", () => {
  assert.equal(workflowRequiresTicket(noShippingReviewer), false);
});

test("workflowRequiresTicket: false when shipping-reviewer is only specialist authority", () => {
  assert.equal(workflowRequiresTicket(specialistShippingReviewer), false);
});

test("workflowRequiresTicket: true when shipping-reviewer is authoritative", () => {
  assert.equal(workflowRequiresTicket(authoritativeShippingReviewer), true);
});

test("workflowRequiresTicket: true when the authoritative shipping-reviewer is on a later step", () => {
  const workflow = WorkflowSchema.parse({
    name: "feature",
    description: "test",
    steps: [
      { id: "plan", agent: "tech-lead", gate: "human" },
      {
        id: "build",
        agent: "engineer",
        gate: "verdict",
        depends_on: ["plan"],
        reds: [{ agent: "shipping-reviewer", authority: "authoritative" }],
      },
    ],
  });
  assert.equal(workflowRequiresTicket(workflow), true);
});

test("resolveTicketId: non-feature workflow without authoritative shipping-reviewer needs no ticket", () => {
  const projectDir = makeTmpDir();
  assert.equal(
    resolveTicketId({ workflow: noShippingReviewer, projectDir, ticketOption: undefined, metaTicketId: undefined }),
    undefined,
  );
});

test("resolveTicketId: missing --ticket for an authoritative-shipping-reviewer workflow fails before run creation", () => {
  const projectDir = makeTmpDir();
  assert.throws(
    () =>
      resolveTicketId({
        workflow: authoritativeShippingReviewer,
        projectDir,
        ticketOption: undefined,
        metaTicketId: undefined,
      }),
    /workflow 'feature' requires --ticket <id> because shipping-reviewer needs backlog acceptance criteria/,
  );
});

test("resolveTicketId: --ticket referencing a real backlog ticket resolves to that id", () => {
  const projectDir = makeTmpDir();
  writeTicket(projectDir, makeTicket({ id: "FG-123", title: "real feature" }));
  assert.equal(
    resolveTicketId({
      workflow: authoritativeShippingReviewer,
      projectDir,
      ticketOption: "FG-123",
      metaTicketId: undefined,
    }),
    "FG-123",
  );
});

test("resolveTicketId: --ticket referencing an unknown ticket fails before run creation", () => {
  const projectDir = makeTmpDir();
  assert.throws(
    () =>
      resolveTicketId({
        workflow: authoritativeShippingReviewer,
        projectDir,
        ticketOption: "FG-999",
        metaTicketId: undefined,
      }),
    /--ticket FG-999 not found in backlog/,
  );
});

test("resolveTicketId: --meta ticketId still works for back-compat", () => {
  const projectDir = makeTmpDir();
  writeTicket(projectDir, makeTicket({ id: "FG-123", title: "real feature" }));
  assert.equal(
    resolveTicketId({
      workflow: authoritativeShippingReviewer,
      projectDir,
      ticketOption: undefined,
      metaTicketId: "FG-123",
    }),
    "FG-123",
  );
});

test("resolveTicketId: --ticket and --meta ticketId disagreeing fails", () => {
  const projectDir = makeTmpDir();
  writeTicket(projectDir, makeTicket({ id: "FG-123", title: "real feature" }));
  writeTicket(projectDir, makeTicket({ id: "FG-456", title: "another feature" }));
  assert.throws(
    () =>
      resolveTicketId({
        workflow: authoritativeShippingReviewer,
        projectDir,
        ticketOption: "FG-123",
        metaTicketId: "FG-456",
      }),
    /--ticket FG-123 conflicts with --meta ticketId FG-456/,
  );
});

test("resolveTicketId: --ticket and --meta ticketId agreeing is fine", () => {
  const projectDir = makeTmpDir();
  writeTicket(projectDir, makeTicket({ id: "FG-123", title: "real feature" }));
  assert.equal(
    resolveTicketId({
      workflow: authoritativeShippingReviewer,
      projectDir,
      ticketOption: "FG-123",
      metaTicketId: "FG-123",
    }),
    "FG-123",
  );
});
