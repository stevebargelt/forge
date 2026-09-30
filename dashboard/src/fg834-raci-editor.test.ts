// FG-834 part 2: the Edit RACI mode's state machine — view → editing → proposed → applied,
// any edit invalidating the proposal, the exact typed-key match, the debounced/aborting
// dry-run loop, and findings placed on lines of the draft. Pure: no DOM, fetch and timers
// injected. The browser suite (browser-tests/fg834-raci-editor.test.ts) drives it in a page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ATTRIBUTION_CLAIM_CAPTION,
  RACI_SECTIONS,
  applyBody,
  applyReadiness,
  auditRows,
  beginApply,
  beginDryRun,
  beginPropose,
  claimedAttribution,
  confirmKeyMatches,
  createDryRunner,
  diffLines,
  editDraft,
  effectiveRows,
  forceRuleCheck,
  gateFindings,
  isDirty,
  locateFinding,
  minutesLeft,
  openEditor,
  proposalExpired,
  proposalLive,
  proposeReadiness,
  raciEditorHash,
  raciEditorMode,
  replaceDraft,
  sectionLine,
  setConfirmKey,
  setRationale,
  settleApply,
  settleDryRun,
  settlePropose,
  visibleRows,
  type EditorState,
  type ProposeResponse,
} from "../client/raci-editor-state.js";
import { AttributionCell, AttributionClaimCaption } from "../client/governance.js";
import { ROUTES, parseHash } from "../client/view-routing.js";
import { statusToken } from "../client/status-tokens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = readFileSync(resolve(HERE, "..", "..", "seeds", "forge-raci.md"), "utf8");
const OVERRIDE = HOST.replace("responsible: red-backend", "responsible: backend-specialist");
const KEY = "repo-ba945c6725b6a153cffb";
const PROJECT = { key: KEY, checkoutDir: "/repos/atlas" };
const read = (own: string | null) => ({
  project: { key: KEY, label: "Atlas", checkoutDir: PROJECT.checkoutDir },
  source: { kind: own === null ? "host" : "project", path: "/x/forge-raci.md", text: own ?? HOST },
  host: { path: "/h/forge-raci.md", text: HOST },
});
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l === needle) + 1;
const green = (text: string, extra: Record<string, unknown> = {}): ProposeResponse => ({
  status: 200,
  body: {
    ok: true, candidateSha256: `sha-of-${text.length}`, proposalExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    verb: "forge raci propose <candidate> --project /repos/atlas --json",
    result: { ok: true, raciDiff: "- responsible: red-backend\n+ responsible: backend-specialist", routeChanges: { added: [], removed: [], modified: [{ route: "review_backend", fields: [] }] }, candidateRoutes: { review_backend: { path: "invoke", responsible: "backend-specialist" } }, validation: { raci: { ok: true, findings: [] }, route: { ok: true, findings: [] } }, ...extra },
  },
});
const refused = (findings: Array<Record<string, string>>): ProposeResponse => ({
  status: 409,
  body: { ok: false, refusal: "gate_failed", error: "the RACI gate refused the candidate", result: { ok: false, validation: { raci: { ok: false, findings }, route: { ok: false, findings: [] } } } },
});

/** Text a Preact vnode would put in the browser; keeps this renderer test DOM-free. */
function vnodeText(node: any): string {
  if (node === null || node === undefined || node === false) return "";
  if (Array.isArray(node)) return node.map(vnodeText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return vnodeText(node.props?.children);
}

function nodesWithTestId(node: any, testId: string): any[] {
  if (node === null || node === undefined || node === false) return [];
  if (Array.isArray(node)) return node.flatMap((child) => nodesWithTestId(child, testId));
  if (typeof node !== "object") return [];
  return [node, ...nodesWithTestId(node.props?.children, testId)].filter((child) => child?.props?.["data-testid"] === testId);
}

/** Dry-run a text green through the machine, as the view does. */
function dryRunGreen(state: EditorState, seq = state.dryRun.seq + 1): EditorState {
  return settleDryRun(beginDryRun(state, seq), seq, state.draft, green(state.draft));
}

test("the mode rides the hash (#routing?mode=edit) through the route table; anything else is view", () => {
  assert.deepEqual(ROUTES.routing?.params, ["mode"]);
  assert.deepEqual(ROUTES.routing?.paramValues?.mode, ["edit"]);
  const scope = { project: KEY, checkout: "/repos/atlas" };
  const hash = raciEditorHash(scope, true);
  assert.equal(hash, `#routing?project=${KEY}&checkout=%2Frepos%2Fatlas&mode=edit`);
  assert.equal(raciEditorMode(parseHash(hash).params), "edit");
  assert.equal(raciEditorHash(scope, false), `#routing?project=${KEY}&checkout=%2Frepos%2Fatlas`);
  const unknown = parseHash(`#routing?project=${KEY}&checkout=%2Frepos%2Fatlas&mode=delete`);
  assert.equal(raciEditorMode(unknown.params), "view");
  assert.equal(unknown.canonical, raciEditorHash(scope, false), "an unknown mode is dropped silently");
  assert.equal(raciEditorMode(null), "view");
});

test("opening the editor starts from the project's override, else the host default — and is not dirty", () => {
  const own = openEditor(read(OVERRIDE));
  assert.equal(own.mode, "editing");
  assert.equal(own.origin, "source");
  assert.equal(own.draft, OVERRIDE);
  assert.equal(isDirty(own), false);
  const fresh = openEditor(read(null));
  assert.equal(fresh.origin, "host");
  assert.equal(fresh.draft, HOST);
  const host = openEditor(read(OVERRIDE), "host");
  assert.equal(host.draft, HOST, "start from the host default instead");
});

test("editing → proposed → applied, and ANY edit after a propose invalidates the proposal", () => {
  let s = openEditor(read(OVERRIDE));
  s = editDraft(s, OVERRIDE.replace("followups: none", "followups: manual-qa"));
  assert.equal(isDirty(s), true);
  s = dryRunGreen(s);
  assert.equal(proposeReadiness(s).enabled, true);
  s = beginPropose(s);
  assert.equal(proposeReadiness(s).enabled, false, "no double propose");
  const text = s.draft;
  s = settlePropose(s, text, green(text));
  assert.equal(s.mode, "proposed");
  assert.equal(proposalLive(s), true);
  assert.equal(s.proposal?.text, text);
  assert.equal(s.proposal?.sha, `sha-of-${text.length}`, "bound to the sha the server hashed");

  s = setRationale(setConfirmKey(s, KEY), "Backend reviews go to the specialist first.");
  assert.equal(applyReadiness(s, KEY).enabled, true);

  const edited = editDraft(s, `${text}\n`);
  assert.equal(edited.mode, "editing");
  assert.equal(proposalLive(edited), false);
  assert.deepEqual(applyReadiness(edited, KEY), { enabled: false, reason: "propose this exact candidate first" });
  assert.ok(edited.proposal, "the superseded proposal stays on screen, marked");
  const undone = editDraft(edited, text);
  assert.equal(proposalLive(undone), false, "undoing back to the proposed bytes still needs a fresh propose");

  let applying = beginApply(s);
  assert.equal(applyReadiness(applying, KEY).enabled, false);
  const body = applyBody(s, PROJECT);
  assert.deepEqual(body, { projectKey: KEY, projectDir: "/repos/atlas", candidate: text, proposedSha256: s.proposal!.sha, confirmKey: KEY, rationale: "Backend reviews go to the specialist first." });
  applying = settleApply(applying, {
    status: 200,
    body: { ok: true, exitCode: 0, verb: "forge raci apply …", candidateSha256: "abc", project: { checkoutDir: "/repos/atlas" }, result: { written: true, effectiveForDispatch: true, audit: { current_raci: "/repos/atlas/.forge/forge-raci.md", routes_added: [], routes_removed: [], routes_modified: ["review_backend"] } } },
  });
  assert.equal(applying.mode, "applied");
  assert.equal(applying.applied?.exitCode, 0);
  assert.match(applying.applied!.output, /Applied RACI source -> \/repos\/atlas\/\.forge\/forge-raci\.md/);
  assert.match(applying.applied!.output, /~1 route \(review_backend\)/);
});

test("the typed key must match exactly — no trimming, no case folding; a blank rationale refuses", () => {
  assert.equal(confirmKeyMatches(KEY, KEY), true);
  for (const typed of ["repo-ba945c67", ` ${KEY}`, `${KEY} `, KEY.toUpperCase(), "", null]) assert.equal(confirmKeyMatches(typed, KEY), false, String(typed));
  assert.equal(confirmKeyMatches("", ""), false, "an empty key never matches");
  let s = openEditor(read(OVERRIDE));
  s = dryRunGreen(s);
  s = settlePropose(beginPropose(s), s.draft, green(s.draft));
  s = setRationale(setConfirmKey(s, "repo-ba945c67"), "why");
  assert.deepEqual(applyReadiness(s, KEY), { enabled: false, reason: "type the project key exactly" });
  s = setRationale(setConfirmKey(s, KEY), "   ");
  assert.deepEqual(applyReadiness(s, KEY), { enabled: false, reason: "a rationale is required" });
  s = setRationale(s, "why");
  assert.equal(applyReadiness(s, KEY).enabled, true);
  const later = Date.now() + 16 * 60_000;
  assert.equal(minutesLeft(s.proposal!.expiresAt, later), 0);
  const at = new Date(s.proposal!.expiresAt!).getTime();
  assert.equal(minutesLeft(s.proposal!.expiresAt, at - 15 * 60_000), 15);
  assert.equal(minutesLeft(s.proposal!.expiresAt, at - 15 * 60_000 + 1), 14, "rounded down: never more minutes than the server's window holds");
  assert.equal(proposalExpired(s.proposal!.expiresAt), false);
  assert.equal(proposalExpired(s.proposal!.expiresAt, later), true);
  assert.deepEqual(applyReadiness(s, KEY, later), { enabled: false, reason: "the proposal expired — propose again" });
});

test("a refused propose shows the reason and keeps Apply disabled; a spent proposal is dropped on apply refusal", () => {
  let s = dryRunGreen(openEditor(read(OVERRIDE)));
  s = settlePropose(beginPropose(s), s.draft, refused([{ code: "force_rule_weakened", route: "review_backend", message: 'host force rule "x" weakened' }]));
  assert.equal(s.mode, "editing");
  assert.equal(s.proposal, null);
  assert.match(s.proposeError!.message, /gate refused/);
  assert.equal(s.proposeError!.findings[0]!.line, lineOf(s.draft, "### route: review_backend") + 9, "placed on the block's force_rules line");
  assert.equal(applyReadiness(s, KEY).enabled, false);

  let p = dryRunGreen(openEditor(read(OVERRIDE)));
  p = setRationale(setConfirmKey(settlePropose(beginPropose(p), p.draft, green(p.draft)), KEY), "why");
  const spent = settleApply(beginApply(p), { status: 409, body: { ok: false, refusal: "candidate_not_proposed", error: "propose it first" } });
  assert.equal(spent.proposal, null);
  assert.equal(spent.applyError?.refusal, "candidate_not_proposed");
  const cli = settleApply(beginApply(p), { status: 409, body: { ok: false, refusal: "gate_failed", exitCode: 1, error: "the RACI gate refused" } });
  assert.equal(cli.mode, "proposed", "a CLI refusal is shown, never bypassed");
  assert.equal(cli.applyError?.exitCode, 1);
});

test("dry-run answers: stale ones never write; errors by line block Propose; green keeps the routes table", () => {
  let s = openEditor(read(OVERRIDE));
  const bad = OVERRIDE.replace("### route: review_backend\n", "### route: review_backend\nfollowups: red-backend\n");
  s = editDraft(s, bad);
  s = beginDryRun(s, 2);
  const stale = settleDryRun(s, 1, bad, green(bad));
  assert.equal(stale, s, "an older seq never writes");
  const other = settleDryRun(s, 2, OVERRIDE, green(OVERRIDE));
  assert.equal(other, s, "an answer for text no longer in the editor never writes");
  assert.deepEqual(proposeReadiness(s), { enabled: false, reason: "checking the candidate…" });

  s = settleDryRun(s, 2, bad, refused([{ code: "parse_error", message: 'route review_backend: unknown field "followups"' }]));
  assert.equal(s.dryRun.ok, false);
  assert.equal(s.dryRun.findings[0]!.line, lineOf(bad, "followups: red-backend"));
  assert.deepEqual(proposeReadiness(s), { enabled: false, reason: "fix the 1 validation error to propose" });
  assert.equal(s.lastGreen, null);

  s = editDraft(s, OVERRIDE);
  s = dryRunGreen(s, 3);
  assert.equal(s.dryRun.ok, true);
  assert.equal(s.lastGreen?.routes?.review_backend?.responsible, "backend-specialist");
  const broken = settleDryRun(beginDryRun(editDraft(s, bad), 4), 4, bad, refused([{ code: "parse_error", message: "x" }]));
  assert.equal(broken.lastGreen?.routes?.review_backend?.responsible, "backend-specialist", "routes from the last green dry-run");
  const busy = settleDryRun(beginDryRun(s, 5), 5, s.draft, { status: 503, body: { ok: false, error: "too many dashboard mutations in flight (4)" } });
  assert.match(busy.dryRun.error!, /too many/);
});

test("findings land on lines of the draft: field, header, duplicate key, and none for a whole-document error", () => {
  const header = lineOf(HOST, "### route: review_backend");
  assert.equal(locateFinding(HOST, { code: "agent_not_installed", route: "review_backend", message: 'responsible "red-backend" is not an installed agent' }), header + 3);
  assert.equal(locateFinding(HOST, { code: "informed_unknown", route: "review_backend", message: 'informed target "nope" is not in the controlled vocabulary' }), header + 8);
  assert.equal(locateFinding(HOST, { code: "parse_error", message: 'route review_backend: missing required field "command"' }), header);
  const dup = `${HOST}\n### route: review_backend\n`;
  assert.equal(locateFinding(dup, { code: "parse_error", message: "duplicate route key: review_backend" }), dup.split("\n").length - 1);
  assert.equal(locateFinding(HOST, { code: "compile_error", message: "policy schema: something" }), null);
  const found = gateFindings({ validation: { raci: { findings: [{ code: "compile_error", message: "boom" }] }, route: { findings: [{ code: "candidate_compile_error", message: "boom" }] } } }, HOST);
  assert.equal(found.length, 1, "the same compile error from both validators is shown once");
});

test("the section chips jump to the next line of their kind, wrapping", () => {
  assert.deepEqual(RACI_SECTIONS.map((s) => s.label), ["Roles", "Routes", "Force rules", "Followups", "Informed"]);
  assert.equal(sectionLine(HOST, "routes"), lineOf(HOST, "## Routes"));
  const firstResponsible = sectionLine(HOST, "roles")!;
  assert.match(HOST.split("\n")[firstResponsible - 1]!, /^responsible: /);
  const second = sectionLine(HOST, "roles", firstResponsible)!;
  assert.ok(second > firstResponsible);
  assert.equal(sectionLine(HOST, "roles", HOST.split("\n").length), firstResponsible, "wraps to the first");
  for (const id of ["force_rules", "followups", "informed"]) assert.ok(sectionLine(HOST, id), id);
  assert.equal(sectionLine("no routes here", "informed"), null);
});

test("the effective table tags the candidate against the routes in force", () => {
  const current = { a: { path: "invoke", responsible: "x" }, b: { path: "invoke", responsible: "y" }, gone: { path: "invoke", responsible: "z" } };
  const candidate = { a: { path: "invoke", responsible: "x" }, b: { path: "invoke", responsible: "w" }, fresh: { path: "in_session", responsible: "orchestrator" } };
  const rows = effectiveRows(current, candidate);
  assert.deepEqual(rows.map((r) => [r.key, r.tag, r.wasResponsible]), [["a", null, null], ["b", "changed", "y"], ["fresh", "added", null], ["gone", "removed", null]]);
  assert.deepEqual(effectiveRows(current, null).map((r) => r.tag), [null, null, null], "no green dry-run yet: the routes in force, untagged");
  const many = Array.from({ length: 12 }, (_, i) => ({ tag: i === 10 ? "changed" : null }));
  const { shown, hidden } = visibleRows(many);
  assert.equal(shown.length, 7);
  assert.equal(hidden, 5);
});

test("proposal and audit presentation: counts, force-rule check, diff lines, audit rows", () => {
  assert.deepEqual(forceRuleCheck({ validation: { route: { findings: [{ code: "force_rule_weakened", message: "m" }] } } }, {}), { ok: false, text: "force rules: 1 host rule weakened" });
  assert.equal(forceRuleCheck({ validation: { route: { findings: [] } } }, { a: { force_rules: ["r1", "r2"] }, b: { force_rules: ["r1"] } }).text, "force rules: 2 in the candidate · no host rule weakened");
  assert.deepEqual(diffLines("  ctx\n- old\n+ new\n  ⋮").map((l) => l.kind), ["ctx", "del", "add", "ctx"]);
  assert.deepEqual(auditRows([
    { timestamp: "2026-09-30T06:41:00Z", action: "apply", actor: "dashboard", source: "dashboard", routes_modified: ["review_backend"], routes_added: [], routes_removed: [], rationale: "why", candidate_sha256: "9f3c" },
    { timestamp: "2026-08-07T13:28:00Z", action: "apply", routes_modified: [], routes_added: [], routes_removed: [], candidate_sha256: "b71d" },
  ]), [
    { timestamp: "2026-09-30T06:41:00Z", attribution: "dashboard (claimed)", action: "apply", change: "~1 route (review_backend)", rationale: "why", sha: "9f3c" },
    { timestamp: "2026-08-07T13:28:00Z", attribution: null, action: "apply", change: "no route change", rationale: null, sha: "b71d" },
  ]);
  assert.equal(auditRows([{ routes_added: ["a", "b", "c", "d"] }])[0]!.change, "+4 routes (a, b, c, …)", "a long list is cut after three names");
});

test("FG-840 AC 4: Routing's rendered Recorded rows label every attribution as a claim", () => {
  assert.equal(claimedAttribution("dashboard", "dashboard"), "dashboard (claimed)");
  assert.equal(claimedAttribution("cli", undefined), "cli (claimed)");
  assert.equal(claimedAttribution("steve", "cli"), "steve (claimed) via cli (claimed)");

  const attributionCases = [
    [{ actor: "dashboard", source: "dashboard" }, "dashboard (claimed)"],
    [{ actor: "dashboard", source: "cli" }, "dashboard (claimed) via cli (claimed)"],
    [{ actor: "dashboard", source: "terminal-script" }, "dashboard (claimed) via terminal-script (claimed)"],
    [{ actor: "dashboard" }, "dashboard (claimed)"],
    [{ source: "dashboard" }, "dashboard (claimed)"],
  ] as const;
  for (const [entry, expected] of attributionCases) {
    const auditEntry = { timestamp: "2026-09-30T12:00:00Z", action: "apply", routes_added: [], routes_modified: [], routes_removed: [], ...entry };
    assert.equal(auditRows([auditEntry])[0]!.attribution, expected, JSON.stringify(entry));
  }

  assert.equal(ATTRIBUTION_CLAIM_CAPTION, "Attribution is recorded as the caller gave it; on this host anyone who can run forge can write these values. It is a claim, not a proof.");
  const captions = nodesWithTestId(AttributionClaimCaption(), "attribution-claim");
  assert.equal(captions.length, 1, "the Routing view's Recorded panel renders one attribution caption");
  assert.equal(vnodeText(captions[0]), ATTRIBUTION_CLAIM_CAPTION);
});

test("FG-840 AC 4a: recorded-audit attribution renders only what the line recorded — no actor or source is synthesized", () => {
  const cases = [
    [{ source: "terminal-script" }, "terminal-script (claimed)"],
    [{ source: "cli" }, "cli (claimed)"],
    [{ actor: "steve" }, "steve (claimed)"],
    [{ actor: "steve", source: "cli" }, "steve (claimed) via cli (claimed)"],
    [{ actor: "steve", source: "some-unknown-tool" }, "steve (claimed) via some-unknown-tool (claimed)"],
    [{}, "unattributed"],
  ] as const;
  for (const [entry, expected] of cases) {
    const row = auditRows([{ timestamp: "2026-09-30T12:00:00Z", action: "apply", ...entry }])[0]!;
    const cell = AttributionCell({ attribution: row.attribution });
    assert.equal(vnodeText(cell), expected, JSON.stringify(entry));
  }
  const blank = AttributionCell({ attribution: null }) as any;
  const faint = [blank.props.children].flat().find((c: any) => c?.props?.class === "faint");
  assert.ok(faint, "a line with neither actor nor source renders an explicit 'unattributed' in the faint token");
});

test("reset to host default is an edit of the draft, never a delete", () => {
  const s = replaceDraft(openEditor(read(OVERRIDE)), HOST, "host");
  assert.equal(s.draft, HOST);
  assert.equal(s.origin, "host");
  assert.equal(isDirty(s), true, "the host text is a candidate like any other");
  assert.equal(s.mode, "editing");
});

test("every editor state renders through the FG-824 token map", () => {
  for (const state of ["unedited", "edited", "checking", "dry_run_ok", "invalid", "unavailable", "proposed", "superseded", "gate_passed", "gate_failed", "expired", "applied", "apply_failed"]) {
    assert.equal(statusToken("raci", state).known, true, state);
  }
  assert.equal(statusToken("raci", "edited").label, "edited · not proposed");
});

test("the dry-run runner debounces, aborts the in-flight request on a newer edit, and only the newest answer lands", async () => {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const posts: Array<{ text: string; signal: AbortSignal; resolve: (r: ProposeResponse) => void }> = [];
  const settled: Array<[number, string]> = [];
  const started: number[] = [];
  const runner = createDryRunner({
    post: (text, signal) => new Promise((resolve) => posts.push({ text, signal, resolve })),
    onStart: (seq) => started.push(seq),
    onSettle: (seq, text) => settled.push([seq, text]),
    onFail: () => assert.fail("no failure expected"),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.cleared = true; },
  });
  runner.schedule("a");
  runner.schedule("ab");
  assert.equal(timers.length, 2);
  assert.equal(timers[0]!.cleared, true, "a newer edit restarts the debounce");
  assert.equal(timers[1]!.ms, 400);
  timers[1]!.fn();
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.text, "ab");
  runner.schedule("abc");
  assert.equal(posts[0]!.signal.aborted, true, "the in-flight dry-run is aborted by a newer edit at once");
  posts[0]!.resolve({ status: 200, body: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(settled, [], "the aborted answer never lands");
  timers[2]!.fn();
  posts[1]!.resolve({ status: 200, body: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(settled, [[started.at(-1)!, "abc"]]);
  void runner.now("now");
  assert.equal(posts[2]!.text, "now", "now() skips the debounce");
  runner.cancel();
  assert.equal(posts[2]!.signal.aborted, true);
});

test("the state-location docs count the per-project RACI override, its compiled policy and audit log as per-project state", () => {
  const doc = readFileSync(resolve(HERE, "..", "..", "docs", "how-to-use-forge-across-projects.md"), "utf8");
  assert.match(doc, /^\| `<project>\/\.forge\/forge-raci\.md`, `routing-policy\.yml`, `raci-audit\.log` \|/m);
  const summary = doc.split("\n").find((l) => l.startsWith("Per-project state is intentionally minimal"));
  assert.ok(summary, "the per-project state summary is present");
  assert.match(summary, /orchestrator block/);
  assert.match(summary, /workflow override/);
  assert.match(summary, /RACI override with its compiled policy and audit log/);
});
