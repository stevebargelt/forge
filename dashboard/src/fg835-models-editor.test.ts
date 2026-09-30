// FG-835 part 2b: the Models editor's state — quick edit as a one-line rewrite of the YAML
// that re-parses (through the loader the gate uses) to the intended policy with every other
// byte kept; findings placed by line from the gate's real message shapes; the shared FG-834
// machine driven through the model-policy gate adapter (invalidation, typed target, restore
// as a candidate); and the debounced, aborting dry-run. Pure: no DOM, fetch and timers
// injected. browser-tests/fg835-models-editor.test.ts drives it in a page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  MODEL_POLICY_GATE,
  addableRoles,
  applyBody,
  applyVerb,
  backupReadUrl,
  backupRows,
  diffSummary,
  lineOfPath,
  modelChoices,
  modelPolicyReadUrl,
  modelsEditorHash,
  modelsEditorMode,
  openModelsEditor,
  policyAuditRows,
  policyFacts,
  policyFindings,
  policyOutline,
  proposalDiffRows,
  proposalSummary,
  proposeBody,
  quickEdit,
  requestedTarget,
  resolutionRows,
  roleHarnessHash,
  setProfileModel,
  setRoleOverride,
  settleModelsApply,
  yamlScalar,
  type PolicyTargetView,
} from "../client/models-editor-state.js";
import {
  applyReadiness,
  beginDryRun,
  createDryRunner,
  isDirty,
  proposalLive,
  proposeReadiness,
  replaceDraft,
  setConfirmKey,
  setRationale,
  settleDryRun,
  settlePropose,
  type ProposeResponse,
} from "../client/raci-editor-state.js";
import { ROUTES, NAV_GROUPS, parseHash } from "../client/view-routing.js";
import { listHeader } from "../client/screen-header-render.js";
import { parseModelPolicyText } from "../../src/v2/loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = readFileSync(resolve(HERE, "..", "..", "seeds", "model-policy.example.yml"), "utf8");
const KEY = "repo-ba945c6725b6a153cffb";
const HOST: PolicyTargetView = { kind: "host", path: "/h/.forge/model-policy.yml", confirmKey: "host", project: null };
const PROJECT: PolicyTargetView = { kind: "project", path: "/repos/atlas/.forge/model-policy.yml", confirmKey: KEY, project: { key: KEY, label: "atlas", checkoutDir: "/repos/atlas" } };

const SMALL = [
  "schema_version: 2",
  "# operator note: keep this comment",
  "on_unavailable: fail",
  "x_operator_label: kept-by-quick-edit",
  "model_profiles:",
  "  default:",
  "    provider: anthropic",
  "    auth: subscription",
  "    x_profile_note: { keep: true }",
  "    map:",
  "      default: { model: claude-opus-5-5, cost_tier: premium }   # the workhorse",
  "      review:",
  "        model: claude-sonnet-5",
  "        cost_tier: standard",
  "  fast:",
  "    provider: anthropic",
  "    auth: subscription",
  "    map:",
  "      default: { model: claude-haiku-4-5-20251001, cost_tier: cheap }",
  "defaults:",
  "  profile: default",
  "  activity:",
  "    review: default",
  "overrides:",
  "  agents: {}",
  "",
].join("\n");

const policy = (text: string) => parseModelPolicyText(text, "candidate");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const changedLines = (a: string, b: string) => {
  const x = a.split("\n");
  const y = b.split("\n");
  return y.map((line, i) => (line === x[i] ? null : i + 1)).filter((n) => n !== null);
};

const read = (text: string, target: PolicyTargetView = HOST) => ({
  target,
  source: { kind: target.kind, path: target.path, text, error: null },
  resolution: { rows: [row("engineer", "build", "default", "claude-opus-5-5"), row("architecture-advisor", "plan", "default", "claude-opus-5-5")], policyError: null },
  audit: { path: "/h/.forge/model-policy-audit.log", entries: [], skippedLines: 0 },
  backups: { dir: "/h/.forge", entries: [] },
  knownModels: ["claude-fable-5-1", "claude-sonnet-5"],
});
function row(role: string, activity: string, profile: string, model: string, extra: Record<string, unknown> = {}) {
  return { role, activity, isDefault: true, profile, provider: "anthropic", model, auth: "subscription", runtime: "claude-oauth", costTier: "premium", outcome: "resolved", dispatchable: true, resolvedBy: "policy", error: null, ...extra };
}
const side = (profile: string, model: string, extra: Record<string, unknown> = {}) => ({ profile, provider: "anthropic", model, auth: "subscription", runtime: "claude-oauth", costTier: "premium", outcome: "resolved", dispatchable: true, error: null, ...extra });
const green = (text: string, rows: unknown[] = [], extra: Record<string, unknown> = {}): ProposeResponse => ({
  status: 200,
  body: { ok: true, candidateSha256: "4b1e".padEnd(64, "0"), proposalExpiresAt: "2026-09-30T08:00:00.000Z", verb: "forge model policy propose <candidate> --json", result: { ok: true, findings: [], rows, candidate: { sha256: "x" } }, ...extra },
});
const refused = (findings: Array<{ code: string; message: string }>, rows: unknown[] = []): ProposeResponse => ({
  status: 409,
  body: { ok: false, refusal: "gate_failed", error: "the model-policy gate refused the candidate", result: { ok: false, findings, rows } },
});

// ─── the route ───────────────────────────────────────────────────────────────

test("FG-835: #models is a Setup entry with hash-carried mode and target (FG-828 pattern); Config stays read-only", () => {
  assert.deepEqual(NAV_GROUPS.find((g) => g.id === "setup")!.items, ["roles", "routing", "models", "config", "projects"]);
  assert.deepEqual(ROUTES.models!.params, ["mode", "target"]);
  assert.equal(ROUTES.models!.scope, "optional");
  assert.ok(listHeader("models")?.verb === "forge model policy propose", "the info tip names the gate verb");
  const p = parseHash("#models?project=atlas&checkout=%2Frepos%2Fatlas&mode=edit&target=project");
  assert.deepEqual([p.view, p.params, p.canonical], ["models", { mode: "edit", target: "project" }, "#models?project=atlas&mode=edit&target=project"], "FG-843: #models keeps mode and target; the checkout rides only on Routing, Config and Notes");
  const bad = parseHash("#models?mode=write&target=elsewhere");
  assert.deepEqual([bad.canonical, bad.rewrite], ["#models", true], "unknown mode/target values are dropped");
  assert.equal(modelsEditorMode(p.params), "edit");
  assert.equal(modelsEditorMode({}), "view");
  assert.equal(requestedTarget({ target: "project" }, { project: "atlas" }), "project");
  assert.equal(requestedTarget({ target: "project" }, { project: null }), null, "no project in scope: no project target");
  assert.equal(requestedTarget({ target: "host" }, { project: "atlas" }), "host");
  assert.equal(requestedTarget({}, { project: "atlas" }), null);
  assert.equal(modelsEditorHash({ project: "atlas", checkout: "/repos/atlas" }, { edit: true, target: "host" }), "#models?project=atlas&mode=edit&target=host", "FG-843: the checkout does not ride on #models");
  assert.equal(modelsEditorHash(null, {}), "#models");
  assert.equal(modelPolicyReadUrl("host", { project: "atlas", checkout: "/r" }), "/api/model-policy");
  assert.equal(modelPolicyReadUrl("project", { project: "atlas", checkout: "/r" }), "/api/model-policy?project=atlas&projectDir=%2Fr");
});

// ─── quick edit → YAML ───────────────────────────────────────────────────────

test("FG-835 quick edit: the outline reads profiles, their map entries and overrides from the real seed example", () => {
  const o = policyOutline(EXAMPLE);
  assert.equal(o.ok, true);
  assert.equal(o.schemaVersion, "2");
  assert.deepEqual(o.profiles.map((p) => p.name), ["claude-subscription", "claude-bedrock", "claude-api", "codex-subscription", "pi-groq"]);
  const sub = o.profiles[0]!;
  assert.deepEqual([sub.provider, sub.auth, sub.runtime], ["anthropic", "subscription", null]);
  assert.deepEqual(sub.entries.map((e) => [e.alias, e.model]), [
    ["reasoning", "claude-opus-5"], ["review", "claude-opus-5-5"], ["fast", "claude-haiku-4-5"],
    ["default", "claude-sonnet-5"], ["spec-writer", "claude-opus-5"], ["fast-orchestrator", "claude-haiku-4-5"],
  ]);
  assert.equal(o.profiles[4]!.runtime, "pi-apikey");
  assert.equal(o.profiles[1]!.entries[2]!.model, "us.anthropic.claude-haiku-4-5-20251001-v1:0", "a model id with a colon is read whole");
  assert.equal(o.defaultProfile, "claude-subscription");
  assert.deepEqual([o.overrides.style, o.overrides.editable, o.overrides.entries], ["agents-empty", true, []]);
  assert.deepEqual(policyFacts(read(EXAMPLE)), { schemaVersion: "2", profiles: 5, roles: 2 });
});

test("FG-835 quick edit round-trip: a profile model change re-parses to the same policy with that one model changed; every other line (comments, unknown keys) is byte-identical", () => {
  for (const [text, profile, alias, model] of [
    [EXAMPLE, "claude-subscription", "review", "claude-fable-5-1"],
    [EXAMPLE, "claude-bedrock", "fast", "us.anthropic.claude-sonnet-5"],
    [SMALL, "default", "default", "claude-fable-5-1"],
    [SMALL, "default", "review", "claude-fable-5-1"],
    [SMALL, "fast", "default", "true"],
  ] as const) {
    const next = setProfileModel(text, profile, alias, model);
    assert.ok(next !== null, `${profile}.${alias} is rewritable`);
    const expected = clone(policy(text));
    expected.model_profiles[profile]!.map[alias]!.model = model;
    assert.deepEqual(policy(next), expected, `${profile}.${alias} → ${model} re-parses to the intended policy`);
    assert.equal(changedLines(text, next).length, 1, "exactly one line changes");
    assert.equal(next.split("\n").length, text.split("\n").length);
  }
  const small = setProfileModel(SMALL, "default", "default", "claude-fable-5-1")!;
  assert.match(small, /^ {6}default: \{ model: claude-fable-5-1, cost_tier: premium \} {3}# the workhorse$/m, "the inline comment survives");
  const raw = parseYaml(small) as Record<string, any>;
  assert.equal(raw.x_operator_label, "kept-by-quick-edit", "an unknown top-level key is preserved");
  assert.deepEqual(raw.model_profiles.default.x_profile_note, { keep: true }, "an unknown profile key is preserved");
  assert.match(small, /^# operator note: keep this comment$/m);
  assert.equal(setProfileModel(SMALL, "default", "default", "claude-opus-5-5"), SMALL, "the same model is no edit");
  assert.equal(setProfileModel(SMALL, "nope", "default", "x"), null, "an unknown profile is not guessed at");
  assert.equal(setProfileModel(SMALL, "fast", "default", "true")!.includes('model: "true"'), true, "a reserved word is quoted");
});

test("FG-835 quick edit composition: picker changes retain hand edits and compose without reserializing comments or unknown keys", () => {
  const handEdited = SMALL.replace("on_unavailable: fail", "on_unavailable: fallback\n# hand edit between picker changes");
  const first = setProfileModel(handEdited, "default", "default", "claude-fable-5-1")!;
  const second = setProfileModel(first, "fast", "default", "claude-sonnet-5")!;
  const expected = clone(policy(handEdited));
  expected.model_profiles.default!.map.default!.model = "claude-fable-5-1";
  expected.model_profiles.fast!.map.default!.model = "claude-sonnet-5";
  assert.deepEqual(policy(second), expected, "two picker edits compose on top of the exact hand-authored candidate");
  assert.match(second, /^# hand edit between picker changes$/m);
  assert.match(second, /^x_operator_label: kept-by-quick-edit$/m);
  assert.match(second, /^ {6}default: \{ model: claude-fable-5-1, cost_tier: premium \} {3}# the workhorse$/m);
  assert.deepEqual(changedLines(handEdited, second), [12, 20], "only the two selected model scalars move after the hand edit");
});

test("FG-835 quick edit round-trip: role overrides are added, changed and removed in place; each result is the intended policy", () => {
  const base = policy(SMALL);
  const add = setRoleOverride(SMALL, "architecture-advisor", "fast")!;
  assert.deepEqual(policy(add).overrides.agents, { "architecture-advisor": "fast" });
  assert.match(add, /^ {2}agents:\n {4}architecture-advisor: fast$/m, "`agents: {}` becomes a block");
  const two = setRoleOverride(add, "red-security", "default")!;
  assert.deepEqual(policy(two).overrides.agents, { "architecture-advisor": "fast", "red-security": "default" });
  const changed = setRoleOverride(two, "architecture-advisor", "default")!;
  assert.deepEqual(policy(changed).overrides.agents, { "architecture-advisor": "default", "red-security": "default" });
  assert.equal(changedLines(two, changed).length, 1);
  const one = setRoleOverride(changed, "architecture-advisor", null)!;
  assert.deepEqual(policy(one).overrides.agents, { "red-security": "default" });
  const none = setRoleOverride(one, "red-security", null)!;
  assert.deepEqual(policy(none).overrides.agents, {}, "removing the last override leaves `agents: {}`, never a null mapping");
  assert.match(none, /^ {2}agents: \{\}$/m);
  const expected = clone(base);
  assert.deepEqual(policy(none), expected, "add → change → remove returns to the same policy");

  const noOverrides = SMALL.replace("overrides:\n  agents: {}\n", "");
  const appended = setRoleOverride(noOverrides, "engineer", "fast")!;
  assert.deepEqual(policy(appended).overrides.agents, { engineer: "fast" }, "an absent overrides block is appended");
  const noAgents = SMALL.replace("  agents: {}\n", "").replace("overrides:\n", "overrides:\n  x_future: 1\n");
  const inserted = setRoleOverride(noAgents, "engineer", "fast")!;
  assert.deepEqual((parseYaml(inserted) as any).overrides, { agents: { engineer: "fast" }, x_future: 1 }, "an unknown overrides key is preserved");
  const emptyOverrides = SMALL.replace("overrides:\n  agents: {}", "overrides: {}");
  assert.deepEqual(policy(setRoleOverride(emptyOverrides, "engineer", "fast")!).overrides.agents, { engineer: "fast" });
  const flow = SMALL.replace("agents: {}", "agents: { engineer: fast }");
  assert.equal(policyOutline(flow).overrides.editable, false);
  assert.equal(setRoleOverride(flow, "red-security", "fast"), null, "a non-empty flow mapping is left to the editor");
  assert.equal(yamlScalar("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(yamlScalar("no"), '"no"');
  assert.equal(yamlScalar("a: b"), '"a: b"');
});

// ─── findings by line ────────────────────────────────────────────────────────

function loaderError(text: string): string {
  try {
    parseModelPolicyText(text, "/scratch/model-policy.yml");
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the loader to refuse");
}

test("FG-835 findings: each gate finding is placed on its line — YAML, schema (one per issue), runtime, auth, undispatchable, grammar", () => {
  const badTier = SMALL.replace("cost_tier: standard", "cost_tier: lavish");
  const tierLine = badTier.split("\n").findIndex((l) => l.includes("lavish")) + 1;
  const badRef = badTier.replace("  fast:\n    provider: anthropic\n    auth: subscription", "  fast:\n    provider: anthropic\n    auth: telepathy");
  const schema = policyFindings({ findings: [{ code: "schema_invalid", message: loaderError(badRef) }] }, badRef);
  assert.equal(schema.length, 2, "one finding per Zod issue");
  assert.deepEqual(schema.map((f) => f.line), [tierLine, badRef.split("\n").indexOf("    auth: telepathy") + 1]);
  assert.match(schema[0]!.message, /^model_profiles\.default\.map\.review\.cost_tier: /);
  assert.ok(!schema[0]!.message.includes("/scratch/"), "the scratch label is not shown");

  const broken = SMALL.replace("    provider: anthropic\n    auth: subscription\n    x_profile", "    provider: anthropic\n     auth: [subscription\n    x_profile");
  const yaml = policyFindings({ findings: [{ code: "yaml_parse", message: loaderError(broken) }] }, broken)[0]!;
  assert.equal(typeof yaml.line, "number");
  assert.match(yaml.message, /^YAML parse error/);

  const withRuntime = SMALL.replace("  fast:\n    provider: anthropic\n", "  fast:\n    provider: anthropic\n    runtime: claude-cod\n");
  const f = policyFindings({
    findings: [
      { code: "runtime_missing", message: "profile 'fast' needs runtime 'claude-cod', which the current seed generation (/g) does not carry: no runtime claude-cod (did you mean claude-code?)" },
      { code: "auth_unavailable", message: "profile 'default': anthropic/subscription is not satisfiable on this host — no oauth volume" },
      { code: "default_undispatchable", message: "role 'engineer' becomes undispatchable for its default activity 'build': activity_unmapped. Pass --allow-undispatchable to accept this." },
      { code: "grammar", message: "activity (model_profiles.default.map) 'review' must match ^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      { code: "no_generation", message: "no complete seed generation is published" },
    ],
  }, withRuntime);
  const at = (needle: string) => withRuntime.split("\n").indexOf(needle) + 1;
  assert.deepEqual(f.map((x) => x.line), [at("    runtime: claude-cod"), at("    auth: subscription"), null, at("      review:"), null]);
  assert.match(f[0]!.message, /did you mean claude-code\?/, "the gate's did-you-mean is shown as it came");
  const pinned = setRoleOverride(withRuntime, "engineer", "fast")!;
  assert.equal(policyFindings({ findings: [{ code: "default_undispatchable", message: "role 'engineer' becomes undispatchable" }] }, pinned)[0]!.line, pinned.split("\n").indexOf("    engineer: fast") + 1);
  assert.equal(lineOfPath(SMALL, ["model_profiles", "fast", "runtime"]), SMALL.split("\n").indexOf("  fast:") + 1, "the deepest key present");
  assert.equal(lineOfPath(SMALL, ["model_profiles", "fast", "runtime"], true), null);
});

// ─── the machine ─────────────────────────────────────────────────────────────

test("FG-835 machine: a quick edit is an edit — it invalidates a green proposal and Apply needs this exact text proposed again", () => {
  let s = openModelsEditor(read(SMALL));
  assert.deepEqual([s.mode, s.draft, isDirty(s)], ["editing", SMALL, false]);
  const edited = setProfileModel(SMALL, "default", "review", "claude-fable-5-1")!;
  s = quickEdit(s, edited);
  assert.equal(isDirty(s), true);
  s = beginDryRun(s, 1);
  const rows = [{ role: "architecture-advisor", activity: "plan", isDefault: true, before: side("default", "claude-opus-5-5"), after: side("default", "claude-fable-5-1"), changed: [{ field: "model", before: "claude-opus-5-5", after: "claude-fable-5-1" }], becomesUnmapped: false, becomesUndispatchable: false }];
  s = settleDryRun(s, 1, edited, green(edited, rows), MODEL_POLICY_GATE);
  assert.equal(s.dryRun.ok, true);
  assert.deepEqual(s.lastGreen?.rows, rows, "a green dry-run keeps the gate's rows");
  assert.equal(proposeReadiness(s).enabled, true);
  s = settlePropose({ ...s, proposing: true }, edited, green(edited, rows), MODEL_POLICY_GATE);
  assert.equal(s.mode, "proposed");
  assert.equal(proposalLive(s), true);
  s = setRationale(setConfirmKey(s, "host"), "deeper model for plans");
  assert.deepEqual(applyReadiness(s, "host", Date.parse("2026-09-30T07:50:00Z"), "the target"), { enabled: true, reason: null });

  const again = quickEdit(s, setRoleOverride(edited, "architecture-advisor", "fast"));
  assert.equal(proposalLive(again), false, "any edit supersedes the proposal");
  assert.equal(again.proposal !== null, true, "the superseded proposal stays on screen");
  assert.deepEqual(applyReadiness(again, "host", Date.parse("2026-09-30T07:50:00Z"), "the target"), { enabled: false, reason: "propose this exact candidate first" });
  assert.equal(quickEdit(s, null), s, "a quick edit the outline could not place changes nothing");
});

test("FG-835 machine: even an edit reverted byte-for-byte supersedes a green proposal", () => {
  const proposed = settlePropose({ ...openModelsEditor(read(SMALL)), proposing: true }, SMALL, green(SMALL), MODEL_POLICY_GATE);
  const changed = quickEdit(proposed, `${SMALL}# transient edit\n`);
  const reverted = quickEdit(changed, SMALL);
  assert.equal(reverted.draft, SMALL, "the candidate bytes are back to the green proposal");
  assert.equal(proposalLive(reverted), false, "the prior proposal is still invalid after any intervening edit");
  assert.deepEqual(applyReadiness(setRationale(setConfirmKey(reverted, "host"), "why"), "host", Date.parse("2026-09-30T07:50:00Z"), "the target"), { enabled: false, reason: "propose this exact candidate first" });
});

test("FG-835 machine: the typed target is matched exactly — host or the project key, never trimmed or case-folded", () => {
  const at = Date.parse("2026-09-30T07:50:00Z");
  let s = settlePropose({ ...openModelsEditor(read(SMALL)), proposing: true }, SMALL, green(SMALL), MODEL_POLICY_GATE);
  s = setRationale(s, "why");
  for (const typed of ["", "ho", "Host", "host ", " host"]) {
    assert.deepEqual(applyReadiness(setConfirmKey(s, typed), "host", at, "the target"), { enabled: false, reason: "type the target exactly" }, JSON.stringify(typed));
  }
  assert.equal(applyReadiness(setConfirmKey(s, "host"), "host", at, "the target").enabled, true);
  assert.equal(applyReadiness(setConfirmKey(s, "host"), KEY, at, "the target").enabled, false, "a project target takes its key, not host");
  assert.equal(applyReadiness(setConfirmKey(s, KEY), KEY, at, "the target").enabled, true);
  assert.deepEqual(applyReadiness(setRationale(setConfirmKey(s, "host"), "  "), "host", at, "the target"), { enabled: false, reason: "a rationale is required" });
  assert.deepEqual(applyReadiness(setConfirmKey(s, "host"), "host", Date.parse("2026-09-30T08:00:01Z"), "the target"), { enabled: false, reason: "the proposal expired — propose again" });
});

test("FG-835 machine: request bodies carry the target and the proposed bytes and sha — never --allow-undispatchable; the hint shows the exact verb", () => {
  const s = setRationale(setConfirmKey(settlePropose({ ...openModelsEditor(read(SMALL)), proposing: true }, SMALL, green(SMALL), MODEL_POLICY_GATE), "host"), "r");
  assert.deepEqual(proposeBody(HOST, SMALL), { target: "host", candidate: SMALL });
  assert.deepEqual(proposeBody(PROJECT, SMALL), { projectKey: KEY, projectDir: "/repos/atlas", candidate: SMALL });
  assert.deepEqual(applyBody(s, HOST), { target: "host", candidate: SMALL, proposedSha256: "4b1e".padEnd(64, "0"), confirmKey: "host", rationale: "r" });
  assert.deepEqual(Object.keys(applyBody(s, PROJECT)).sort(), ["candidate", "confirmKey", "projectDir", "projectKey", "proposedSha256", "rationale"]);
  assert.ok(!JSON.stringify(applyBody(s, PROJECT)).includes("allow"), "no field can carry --allow-undispatchable");
  assert.equal(applyVerb(HOST), "forge model policy apply <candidate> --confirm --by dashboard --source dashboard --rationale …");
  assert.equal(applyVerb(PROJECT), "forge model policy apply <candidate> --project /repos/atlas --confirm --by dashboard --source dashboard --rationale …");
});

test("FG-835 machine: an undispatchable candidate is refused as the CLI returns it, placed by line, and Propose stays disabled", () => {
  const text = setRoleOverride(SMALL, "engineer", "fast")!;
  let s = quickEdit(openModelsEditor(read(SMALL)), text);
  s = beginDryRun(s, 3);
  const message = "role 'engineer' becomes undispatchable for its default activity 'build': activity_unmapped. Pass --allow-undispatchable to accept this.";
  s = settleDryRun(s, 3, text, refused([{ code: "default_undispatchable", message }]), MODEL_POLICY_GATE);
  assert.equal(s.dryRun.ok, false);
  assert.deepEqual(s.dryRun.findings, [{ code: "default_undispatchable", message, line: text.split("\n").indexOf("    engineer: fast") + 1 }]);
  assert.deepEqual(proposeReadiness(s), { enabled: false, reason: "fix the 1 validation error to propose" });
  const proposed = settlePropose({ ...s, proposing: true }, text, refused([{ code: "default_undispatchable", message }]), MODEL_POLICY_GATE);
  assert.equal(proposed.mode, "editing");
  assert.equal(proposed.proposal, null);
  assert.equal(proposed.proposeError?.refusal, "gate_failed");
  assert.equal(settleDryRun(s, 2, text, green(text), MODEL_POLICY_GATE), s, "an older dry-run never overwrites a newer verdict");
});

test("FG-835 machine: apply lands with the CLI's own account; a spent proposal returns to editing", () => {
  const s = setRationale(setConfirmKey(settlePropose({ ...openModelsEditor(read(SMALL)), proposing: true }, SMALL, green(SMALL), MODEL_POLICY_GATE), "host"), "r");
  const ok = settleModelsApply(s, {
    status: 200,
    body: {
      ok: true, exitCode: 0, candidateSha256: "abc", verb: "forge model policy apply <candidate> --confirm --by dashboard --source dashboard --rationale <rationale> --json",
      result: { written: true, backup: "/h/.forge/model-policy.yml.bak-2026-09-30T07:41:02.000Z", audit: { target: "/h/.forge/model-policy.yml", diff: [{ role: "architecture-advisor", activity: "plan", becomesUndispatchable: false }] } },
    },
  });
  assert.equal(ok.mode, "applied");
  assert.equal(ok.applied?.output, [
    "Applied model policy -> /h/.forge/model-policy.yml",
    "Previous file kept as /h/.forge/model-policy.yml.bak-2026-09-30T07:41:02.000Z",
    "Resolution changes: ~1 resolution (architecture-advisor · plan)",
    "Takes effect on the next dispatch.",
  ].join("\n"));
  const spent = settleModelsApply(s, { status: 409, body: { ok: false, refusal: "candidate_not_proposed", error: "propose it first" } });
  assert.deepEqual([spent.mode, spent.proposal, spent.applyError?.refusal], ["editing", null, "candidate_not_proposed"]);
  const gate = settleModelsApply(s, { status: 409, body: { ok: false, refusal: "gate_failed", exitCode: 1, error: "the model-policy gate refused the candidate:\n[default_undispatchable] role 'engineer' …" } });
  assert.deepEqual([gate.mode, gate.applyError?.exitCode], ["proposed", 1], "a gate refusal stays on screen as the CLI said it");
});

test("FG-835 restore: a backup opens as the candidate — the same edit/propose loop, never a file copy", () => {
  const backup = SMALL.replace("claude-opus-5-5", "claude-sonnet-5");
  const rows = backupRows([{ name: "model-policy.yml.bak-2026-09-30T07:41:02.000Z", timestamp: "2026-09-30T07:41:02.000Z", sha256: "9d2f", bytes: 1234 }, { name: "big", timestamp: "t", sha256: "x", bytes: 900000 }], 65536);
  assert.deepEqual(rows.map((r) => [r.size, r.blocked]), [
    ["1.2 KB", null],
    ["878.9 KB", "878.9 KB is over the 64.0 KB a candidate may be — restore it from a terminal"],
  ], "an oversized backup's Restore… is blocked with the size and the limit, never a silent no-op");
  assert.equal(backupRows([{ name: "edge", timestamp: "t", sha256: "x", bytes: 65536 }], 65536)[0]!.blocked, null, "exactly the limit is restorable");
  assert.equal(backupReadUrl(HOST, "model-policy.yml.bak-2026-09-30T07:41:02.000Z"), "/api/model-policy?backup=model-policy.yml.bak-2026-09-30T07%3A41%3A02.000Z");
  assert.equal(
    backupReadUrl(PROJECT, "model-policy.yml.bak-x"),
    `/api/model-policy?project=${KEY}&projectDir=%2Frepos%2Fatlas&backup=model-policy.yml.bak-x`,
    "a backup's bytes are read one at a time, from the target it was listed under",
  );
  const opened = openModelsEditor(read(SMALL), { text: backup, origin: "backup:model-policy.yml.bak-2026-09-30T07:41:02.000Z" });
  assert.deepEqual([opened.draft, opened.baseText, opened.origin, isDirty(opened)], [backup, SMALL, "backup:model-policy.yml.bak-2026-09-30T07:41:02.000Z", true]);
  const proposed = settlePropose({ ...opened, proposing: true }, backup, green(backup), MODEL_POLICY_GATE);
  assert.equal(proposed.proposal?.text, backup, "the backup's bytes are what gets proposed and applied");
  const replaced = replaceDraft(proposed, SMALL, "backup:other");
  assert.equal(proposalLive(replaced), false, "restoring another backup supersedes the proposal");
});

test("FG-835 resolution: a role links to its Harness tab at the scope the row was resolved at — the project's checkout, or none for the host file", () => {
  assert.equal(roleHarnessHash("engineer", PROJECT), `#roles/engineer/harness?project=${KEY}&checkout=%2Frepos%2Fatlas`);
  assert.equal(roleHarnessHash("engineer", HOST), "#roles/engineer/harness", "host rows are unscoped, so the tab reads the host policy too");
  const opened = parseHash(roleHarnessHash("architecture-advisor", PROJECT));
  assert.deepEqual([opened.view, opened.id, opened.tab, opened.scope, opened.rewrite], ["roles", "architecture-advisor", "harness", { project: KEY, checkout: "/repos/atlas" }, false], "the scoped link is canonical, so the role page reads the same checkout");
  assert.deepEqual(parseHash(`#roles?project=${KEY}&checkout=%2Frepos%2Fatlas`).scope, { project: null, checkout: null }, "the Roles list still drops scope (FG-828)");
});

test("FG-835 debounce/abort: dry-runs post the draft to propose after quiet, abort the in-flight one, and only the newest settles", async () => {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const posts: Array<{ text: string; signal: AbortSignal; resolve: (r: ProposeResponse) => void }> = [];
  const settled: Array<[number, string]> = [];
  const runner = createDryRunner({
    post: (text, signal) => new Promise((done) => posts.push({ text, signal, resolve: done })),
    onStart: () => {},
    onSettle: (seq, text) => settled.push([seq, text]),
    onFail: () => assert.fail("no failure expected"),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.cleared = true; },
  });
  const a = setProfileModel(SMALL, "default", "default", "claude-fable-5-1")!;
  const b = setProfileModel(a, "fast", "default", "claude-sonnet-5")!;
  runner.schedule(a);
  timers[0]!.fn();
  assert.equal(posts.length, 1);
  runner.schedule(b);
  assert.equal(posts[0]!.signal.aborted, true, "a newer edit aborts the in-flight dry-run");
  timers[1]!.fn();
  posts[1]!.resolve(green(b));
  posts[0]!.resolve(green(a));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(settled.map(([, text]) => text), [b], "only the newest candidate's answer lands");
  runner.cancel();
});

// ─── the tables ──────────────────────────────────────────────────────────────

test("FG-835 tables: resolution rows tag changed/undispatchable with what was; the proposal's summary and before → after rows", () => {
  const current = read(SMALL).resolution.rows;
  assert.deepEqual(resolutionRows(current, null).map((r) => [r.role, r.state.model, r.tags]), [["engineer", "claude-opus-5-5", []], ["architecture-advisor", "claude-opus-5-5", []]]);
  const rows = [
    { role: "engineer", activity: "build", isDefault: true, before: side("default", "claude-opus-5-5"), after: side("default", "claude-opus-5-5"), changed: [], becomesUnmapped: false, becomesUndispatchable: false },
    { role: "architecture-advisor", activity: "plan", isDefault: true, before: side("default", "claude-opus-5-5", { costTier: "standard" }), after: side("spec-writer", "claude-fable-5-1"), changed: [{ field: "profile" }, { field: "model" }, { field: "costTier" }], becomesUnmapped: false, becomesUndispatchable: false },
    { role: "research-specialist", activity: "research", isDefault: true, before: side("groq-free", "llama", { error: "GROQ_API_KEY not set on this host" }), after: side("groq-free", "llama", { error: "GROQ_API_KEY not set on this host" }), changed: [], becomesUnmapped: false, becomesUndispatchable: false },
    { role: "test-engineer", activity: "verify", isDefault: true, before: side("default", "claude-opus-5-5"), after: side("fast", "claude-haiku", { outcome: "activity_unmapped" }), changed: [{ field: "profile" }], becomesUnmapped: true, becomesUndispatchable: true },
  ];
  const table = resolutionRows(current, { rows });
  assert.deepEqual(table.map((r) => [r.role, r.tags, r.was]), [
    ["engineer", [], null],
    ["architecture-advisor", ["changed"], "claude-opus-5-5"],
    ["research-specialist", ["undispatchable"], null],
    ["test-engineer", ["changed", "undispatchable"], "claude-opus-5-5"],
  ]);
  const result = { ok: true, findings: [], rows };
  assert.deepEqual(proposalSummary(result), { changed: 2, newlyUndispatchable: 1, preExisting: 1, runtimeText: "runtime seeds: all present", authText: "auth: every profile satisfiable on this host" });
  assert.deepEqual(proposalDiffRows(result).map((r) => [r.label, r.before, r.after]), [
    ["architecture-advisor · plan", "default → claude-opus-5-5 · subscription · claude-oauth · tier standard", "spec-writer → claude-fable-5-1 · subscription · claude-oauth · tier premium"],
    ["test-engineer · verify", "default → claude-opus-5-5 · subscription · claude-oauth · tier premium", "fast → claude-haiku · subscription · claude-oauth · tier premium · activity_unmapped"],
  ]);
  assert.equal(diffSummary([]), "no resolution change");
  assert.deepEqual(policyAuditRows([
    { timestamp: "2026-09-30T07:41:02.000Z", actor: "dashboard", source: "dashboard", rationale: "deeper plans", candidate_sha256: "4b1e", outcome: "applied", diff: [{ role: "architecture-advisor", activity: "plan" }] },
    { timestamp: "2026-09-12T18:03:11.000Z", actor: "steve", outcome: "failed", error: "EACCES\nstack", diff: [] },
  ]).map((r) => [r.attribution, r.actor, r.change]), [
    ["dashboard (claimed)", "dashboard", "~1 resolution (architecture-advisor · plan)"],
    ["steve (claimed)", "steve", "failed — EACCES"],
  ]);
});

test("FG-840 AC 4b: Models Recorded rows attribute only what the audit line recorded — an absent source is never filled in", () => {
  const attributionCases = [
    [{ actor: "steve" }, "steve (claimed)"],
    [{ actor: "dashboard", source: "dashboard" }, "dashboard (claimed)"],
    [{ actor: "steve", source: "cli" }, "steve (claimed) via cli (claimed)"],
    [{ actor: "steve", source: "terminal-script" }, "steve (claimed) via terminal-script (claimed)"],
    [{ source: "terminal-script" }, "terminal-script (claimed)"],
    [{}, null],
  ] as const;
  for (const [entry, expected] of attributionCases) {
    const row = policyAuditRows([{ timestamp: "2026-09-30T12:00:00Z", outcome: "applied", diff: [], ...entry }])[0]!;
    assert.equal(row.attribution, expected, JSON.stringify(entry));
    assert.equal(row.source, "source" in entry ? entry.source : null, "the row's source is the recorded one or none");
  }
});

test("FG-835 pickers: a change keeps the prior model offered and the order stable", () => {
  const inForce = policyOutline(SMALL);
  const prior = inForce.profiles.flatMap((p) => p.entries).find((e) => e.model === "claude-haiku-4-5-20251001")!;
  assert.ok(prior, "the fixture's policy in force names claude-haiku-4-5-20251001 once");
  const known = ["claude-fable-5-1", "claude-sonnet-5"];
  const offered = new Set<string>();
  const before = modelChoices(inForce, prior.model, known, inForce, offered);
  for (const m of before) offered.add(m);
  const draft = policyOutline(SMALL.replace("claude-haiku-4-5-20251001", "claude-sonnet-5"));
  assert.ok(!draft.profiles.some((p) => p.entries.some((e) => e.model === "claude-haiku-4-5-20251001")), "the change removed the prior model from the draft");
  const after = modelChoices(draft, "claude-sonnet-5", known, inForce, offered);
  assert.ok(after.includes("claude-haiku-4-5-20251001"), "the prior model stays offered");
  assert.deepEqual(after, before, "same options, same alphabetical order");
  assert.deepEqual(after, [...after].sort(), "alphabetical order");
  const onlySession = modelChoices(draft, "claude-sonnet-5", [], null, ["gpt-9"]);
  assert.ok(onlySession.includes("gpt-9"), "a model offered earlier this session is still offered after every source drops it");
});

test("FG-835 pickers: models offered are the current one, the draft's and the seed runtimes' in one stable order; roles to pin are those not pinned", () => {
  const o = policyOutline(setRoleOverride(SMALL, "engineer", "fast")!);
  const choices = ["claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5"];
  assert.deepEqual(modelChoices(o, "claude-sonnet-5", ["claude-fable-5-1", "claude-sonnet-5"]), choices);
  assert.deepEqual(modelChoices(o, "claude-fable-5-1", ["claude-fable-5-1", "claude-sonnet-5"]), choices, "choosing a model never reorders the list");
  assert.deepEqual(modelChoices(o, "gpt-9", []), ["claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5", "gpt-9"], "a current model no source names is still offered");
  assert.deepEqual(addableRoles(o, [{ role: "engineer" }, { role: "red-security" }, { role: "architecture-advisor" }, { role: "red-security" }]), ["architecture-advisor", "red-security"]);
});
