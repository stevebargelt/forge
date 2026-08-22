// FG-349 [H]: ControlPlaneView presentation decisions, tested away from the DOM.
// Renders the component to text (invoking function components) and asserts the
// provenance vocabulary is visible: distinct status badges, the explicit
// "fully replaces host" callout, the invalid-override warning text, a
// seed/template row distinct from active config, capability support+limitation,
// a deferred prerequisite's reason — and that the view carries NO mutation
// affordance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { h } from "preact";
import { ControlPlaneView, STATUS_META, READINESS_META } from "../client/control-plane.js";

type Vnode = { type: unknown; props: Record<string, unknown> } | string | number | null | undefined | boolean | Vnode[];

function textOf(node: Vnode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  const { type, props } = node;
  if (typeof type === "function") return textOf((type as (p: unknown) => Vnode)(props));
  return textOf(props.children as Vnode);
}

function graph(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: { dir: "/proj", status: "active", native: {} },
    forgeHome: "/home/.forge",
    sections: {
      sources: {
        rows: [
          {
            key: "model-policy",
            label: "Model policy",
            truth: "EFFECTIVE",
            status: "overridden",
            sourcePaths: ["/proj/.forge/model-policy.yml"],
            effectivePath: "/proj/.forge/model-policy.yml",
            overrideSemantics: "full-replacement",
            overrideCallout: "project .forge/model-policy.yml active — fully replaces host ~/.forge/model-policy.yml",
            native: {},
          },
          {
            key: "docs-surfaces",
            label: "Docs surfaces",
            truth: "EFFECTIVE",
            status: "warning",
            sourcePaths: ["/proj/.forge/docs-surfaces.yml"],
            overrideSemantics: "full-replacement",
            warning: "project override present but invalid; effective source: built-in defaults",
            native: {},
          },
          {
            key: "seed-drift",
            label: "Seed drift (templates / install sources)",
            truth: "SOURCE",
            status: "template-only",
            sourcePaths: ["/home/.forge/seeds"],
            overrideSemantics: "none",
            detail: "seeds are install-source templates, never active config.",
            native: {},
          },
        ],
      },
      capabilities: {
        providers: [
          { provider: "anthropic", mode: "api", readiness: "available", provenance: "detected", detail: "ANTHROPIC_API_KEY set", observedBy: "host-observed", native: {} },
        ],
        capabilities: [
          { capability: "usage-capture", adapter: "codex", title: "Usage capture", support: "unsupported", provenance: "unavailable", limitation: "codex cannot report token usage without fabrication", observedBy: "inferred", native: {} },
        ],
        prerequisites: [
          { name: "Campaign Runner", readiness: "deferred", reason: "requires a container-runtime probe not performed on the read path", observedBy: "inferred", native: {} },
        ],
      },
    },
    ...over,
  };
}

test("every row status has a distinct a11y symbol (badge is not color-only)", () => {
  const statuses: (keyof typeof STATUS_META)[] = ["active", "absent", "overridden", "template-only", "derived", "stale", "missing", "warning"];
  for (const s of statuses) assert.ok(STATUS_META[s], `missing STATUS_META for ${s}`);
  const symbols = statuses.map((s) => STATUS_META[s].symbol);
  assert.equal(new Set(symbols).size, statuses.length, "each status must map to a distinct symbol");
  // a seed/template row is visibly distinct from active config
  assert.notEqual(STATUS_META["template-only"].symbol, STATUS_META["active"].symbol);
});

test("readiness badges are distinct too", () => {
  const syms = (["available", "unavailable", "deferred", "unknown"] as (keyof typeof READINESS_META)[]).map((r) => READINESS_META[r].symbol);
  assert.equal(new Set(syms).size, 4);
});

test("a project-override row renders the explicit 'fully replaces host' callout", () => {
  const text = textOf(h(ControlPlaneView as never, { data: graph() }) as unknown as Vnode);
  assert.match(text, /fully replaces host ~\/\.forge\/model-policy\.yml/);
});

test("an invalid-override row renders the contract warning, not a bare 'defaults active'", () => {
  const text = textOf(h(ControlPlaneView as never, { data: graph() }) as unknown as Vnode);
  assert.match(text, /project override present but invalid; effective source: built-in defaults/);
});

test("a capability row renders support AND limitation verbatim", () => {
  const text = textOf(h(ControlPlaneView as never, { data: graph() }) as unknown as Vnode);
  assert.match(text, /unsupported/);
  assert.match(text, /codex cannot report token usage without fabrication/);
});

test("a deferred prerequisite renders its reason", () => {
  const text = textOf(h(ControlPlaneView as never, { data: graph() }) as unknown as Vnode);
  assert.match(text, /Campaign Runner/);
  assert.match(text, /deferred/);
  assert.match(text, /requires a container-runtime probe/);
});

test("loading state when data is null", () => {
  const text = textOf(h(ControlPlaneView as never, { data: null }) as unknown as Vnode);
  assert.match(text, /loading control plane/);
});

test("the component carries NO mutation affordance (read-only)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "client", "control-plane.js"), "utf8");
  for (const forbidden of ["onClick", "onSubmit", "<button", "<form", "fetch(", "method:"]) {
    assert.equal(src.includes(forbidden), false, `control-plane.js must not contain ${forbidden}`);
  }
});
