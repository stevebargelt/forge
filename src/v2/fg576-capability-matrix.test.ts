// FG-576 AC9 — the provider capability/parity matrix is COMPLETE and HONEST.
//
// The failure this file exists to prevent is silent omission: a capability that
// one adapter cannot supply quietly dropping out of the matrix, so the parity gap
// stops being visible to the operator. Every assertion below is therefore a
// structural one over the DATA — no row may be absent, no cell may be missing,
// and no cell that is anything other than fully supported may leave its gap
// unnamed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORCHESTRATOR_ADAPTERS,
  ORCHESTRATOR_ADAPTER_IDS,
  ORCHESTRATOR_CAPABILITIES,
  ORCHESTRATOR_CAPABILITY_IDS,
  adapterDescriptor,
  capabilityCell,
  capabilityRow,
  checkModelVocabulary,
  limitationsForAdapter,
  type OrchestratorAdapterId,
} from "./orchestrator-capabilities.js";

// ---- Completeness: nine capabilities, two adapters, no row silently absent ----

test("AC9: the matrix enumerates all nine capabilities exactly once, in declared order", () => {
  assert.equal(ORCHESTRATOR_CAPABILITY_IDS.length, 9);
  assert.deepEqual(
    ORCHESTRATOR_CAPABILITIES.map((r) => r.capability),
    [...ORCHESTRATOR_CAPABILITY_IDS],
  );
  assert.equal(new Set(ORCHESTRATOR_CAPABILITIES.map((r) => r.capability)).size, 9);
});

test("AC9: every capability has a cell for BOTH adapters — no cell is silently absent", () => {
  for (const id of ORCHESTRATOR_CAPABILITY_IDS) {
    const row = capabilityRow(id);
    assert.ok(row.title.trim().length > 0, `${id} has no operator-facing title`);
    for (const adapter of ORCHESTRATOR_ADAPTER_IDS) {
      const cell = row.adapters[adapter];
      assert.ok(cell, `${id} has no cell for adapter '${adapter}'`);
      assert.ok(
        cell.behavior.trim().length > 0,
        `${id}/${adapter} has an empty behavior — every cell must say what the adapter actually does`,
      );
    }
  }
});

test("AC9: every cell that is not fully supported NAMES its gap", () => {
  for (const row of ORCHESTRATOR_CAPABILITIES) {
    for (const adapter of ORCHESTRATOR_ADAPTER_IDS) {
      const cell = row.adapters[adapter];
      if (cell.support === "supported") {
        continue;
      }
      assert.ok(
        (cell.limitation ?? "").trim().length > 0,
        `${row.capability}/${adapter} is '${cell.support}' but names no limitation — ` +
          `an unsupported capability must be named, never silently omitted`,
      );
    }
  }
});

test("AC9: support values come from the closed vocabulary", () => {
  const allowed = new Set(["supported", "partial", "evidence-gated", "unsupported"]);
  for (const row of ORCHESTRATOR_CAPABILITIES) {
    for (const adapter of ORCHESTRATOR_ADAPTER_IDS) {
      assert.ok(allowed.has(row.adapters[adapter].support), `${row.capability}/${adapter}`);
    }
  }
});

// ---- The specific parity gaps this ticket must NOT paper over ----

test("AC12: Codex usage capture is unsupported and says no values are fabricated", () => {
  const codex = capabilityCell("usage-capture", "codex");
  assert.equal(codex.support, "unsupported");
  assert.match(codex.limitation ?? "", /fabricat/i);
  assert.equal(capabilityCell("usage-capture", "claude-code").support, "supported");
});

test("AC7: Codex heartbeat names the absent provider hook and refuses to call it healthy", () => {
  const codex = capabilityCell("heartbeat", "codex");
  assert.notEqual(codex.support, "supported");
  assert.match(codex.limitation ?? "", /no hook|never.*healthy/i);
  assert.match(codex.limitation ?? "", /unknown/i);
});

test("AC8: the Codex instruction source is EVIDENCE-GATED, not assumed from a constructed flag", () => {
  const codex = capabilityCell("instruction-source", "codex");
  assert.equal(codex.support, "evidence-gated");
  assert.match(codex.limitation ?? "", /not evidence/i);
  // Claude's carrier APPENDS; Codex's SUBSTITUTES. The matrix must not imply parity.
  assert.match(capabilityCell("instruction-source", "claude-code").behavior, /APPENDED/);
  assert.match(codex.behavior, /per launch/i);
});

test("remote control is evidence-gated for Claude and explicitly NOT claimed for Codex", () => {
  assert.equal(capabilityCell("remote-control", "claude-code").support, "evidence-gated");
  const codex = capabilityCell("remote-control", "codex");
  assert.equal(codex.support, "unsupported");
  assert.match(codex.limitation ?? "", /no independently supported evidence|claims NO Codex remote control/i);
});

test("skills/commands are named as a Codex gap, not synthesized", () => {
  const codex = capabilityCell("skills-commands", "codex");
  assert.equal(codex.support, "unsupported");
  assert.match(codex.limitation ?? "", /does not translate|not.*synthesiz/i);
});

// ---- limitationsForAdapter: what the launcher copies onto the receipt ----

test("limitationsForAdapter returns exactly the non-supported cells, in matrix order", () => {
  for (const adapter of ORCHESTRATOR_ADAPTER_IDS) {
    const expected = ORCHESTRATOR_CAPABILITIES.filter((r) => r.adapters[adapter].support !== "supported").map(
      (r) => r.capability,
    );
    const actual = limitationsForAdapter(adapter).map((l) => l.capability);
    assert.deepEqual(actual, expected, `adapter ${adapter}`);
    for (const l of limitationsForAdapter(adapter)) {
      assert.ok(l.note.trim().length > 0, `${adapter}/${l.capability} recorded an empty note`);
    }
  }
});

test("the Claude adapter carries fewer gaps than Codex — and Codex's are all named", () => {
  const claude = limitationsForAdapter("claude-code");
  const codex = limitationsForAdapter("codex");
  assert.ok(codex.length > claude.length);
  assert.ok(codex.some((l) => l.capability === "usage-capture"));
  assert.ok(codex.some((l) => l.capability === "heartbeat"));
  assert.ok(codex.some((l) => l.capability === "remote-control"));
});

// ---- Adapter identity ----

test("adapter descriptors bind one provider and one executable each", () => {
  assert.equal(adapterDescriptor("claude-code").provider, "anthropic");
  assert.equal(adapterDescriptor("claude-code").executable, "claude");
  assert.equal(adapterDescriptor("claude-code").sessionIdentity, "asserted");
  assert.equal(adapterDescriptor("codex").provider, "openai");
  assert.equal(adapterDescriptor("codex").executable, "codex");
  assert.equal(adapterDescriptor("codex").sessionIdentity, "correlated");
  // No two adapters share a provider — that is what makes "probe the selected
  // provider only" a decidable rule at the launch boundary.
  const providers = ORCHESTRATOR_ADAPTER_IDS.map((a) => ORCHESTRATOR_ADAPTERS[a].provider);
  assert.equal(new Set(providers).size, providers.length);
});

// ---- --model vocabulary (AC4 / AC14 guard) ----

const VOCAB: { adapter: OrchestratorAdapterId; model: string; ok: boolean; why: string }[] = [
  { adapter: "claude-code", model: "opus", ok: true, why: "AC14: `forge claude --model opus` predates this ticket" },
  { adapter: "claude-code", model: "sonnet", ok: true, why: "alias" },
  { adapter: "claude-code", model: "haiku", ok: true, why: "alias" },
  { adapter: "claude-code", model: "opusplan", ok: true, why: "alias" },
  { adapter: "claude-code", model: "sonnet[1m]", ok: true, why: "alias with a bracketed context suffix" },
  { adapter: "claude-code", model: "claude-sonnet-4-6", ok: true, why: "concrete anthropic id" },
  { adapter: "claude-code", model: "us.anthropic.claude-sonnet-4-6", ok: true, why: "concrete bedrock id" },
  { adapter: "claude-code", model: "gpt-5.6-terra", ok: false, why: "cross-provider model must not reach Claude" },
  { adapter: "claude-code", model: "--dangerously-skip-permissions", ok: false, why: "operand smuggling" },
  { adapter: "claude-code", model: "", ok: false, why: "empty" },
  { adapter: "claude-code", model: " opus", ok: false, why: "surrounding whitespace" },
  { adapter: "codex", model: "gpt-5.6-terra", ok: true, why: "concrete openai slug" },
  { adapter: "codex", model: "o3-mini", ok: true, why: "concrete openai slug" },
  { adapter: "codex", model: "codex-mini-latest", ok: true, why: "concrete openai slug" },
  { adapter: "codex", model: "opus", ok: false, why: "a Claude alias must not reach Codex" },
  { adapter: "codex", model: "claude-sonnet-4-6", ok: false, why: "cross-provider model must not reach Codex" },
  { adapter: "codex", model: "-c", ok: false, why: "operand smuggling" },
];

for (const row of VOCAB) {
  test(`--model vocabulary: ${row.adapter} ${row.ok ? "accepts" : "refuses"} '${row.model}' (${row.why})`, () => {
    const res = checkModelVocabulary(row.adapter, row.model);
    assert.equal(res.ok, row.ok, JSON.stringify(res));
    if (!res.ok) assert.ok(res.reason.trim().length > 0);
  });
}

test("a refused --model names the adapter and its accepted vocabulary", () => {
  const res = checkModelVocabulary("codex", "opus");
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.reason, /Codex CLI/);
  assert.match(res.reason, /gpt-/);
});
