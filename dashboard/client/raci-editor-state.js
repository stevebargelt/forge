// FG-834 part 2: the Edit RACI mode's state, as pure functions (no DOM, fetch and timers
// injectable) — unit-tested in src/fg834-raci-editor.test.ts, driven in a real page by
// browser-tests/fg834-raci-editor.test.ts.
//
// The machine: view → editing (dirty or not) → proposed (bound to the exact text the
// server answered green for) → applied → view. ANY edit returns to editing and drops the
// proposal: the server refuses an apply whose bytes were not proposed (by sha), and the
// client mirrors that rather than letting a stale Apply button look live.
//
// A dry-run is a real `POST /api/raci/propose` of the draft (debounced, the in-flight one
// aborted by a newer edit). Its findings carry a route and a message, never a line, so the
// line an error is shown on is located here from the draft text.

import { hashFor } from "./view-routing.js";

export const DRY_RUN_DEBOUNCE_MS = 400;
export const RACI_EDIT_MODE = "edit";

/** The section chips. Each jumps to the next line (after the caret, wrapping) of its kind
 *  in the real record-block grammar (`### route:` blocks of `field: value` lines). */
export const RACI_SECTIONS = Object.freeze([
  Object.freeze({ id: "roles", label: "Roles", pattern: /^responsible: / }),
  Object.freeze({ id: "routes", label: "Routes", pattern: /^(## Routes\b|### route: )/ }),
  Object.freeze({ id: "force_rules", label: "Force rules", pattern: /^force_rules: / }),
  Object.freeze({ id: "followups", label: "Followups", pattern: /^required_followups: / }),
  Object.freeze({ id: "informed", label: "Informed", pattern: /^informed: / }),
]);

export function raciEditorMode(params) {
  return params && params.mode === RACI_EDIT_MODE ? "edit" : "view";
}

export function raciEditorHash(scope, edit) {
  return hashFor({ view: "routing", scope, params: edit ? { mode: RACI_EDIT_MODE } : null });
}

/** The 1-based line of the next `sectionId` line after `afterLine`, wrapping; null if none. */
export function sectionLine(text, sectionId, afterLine = 0) {
  const section = RACI_SECTIONS.find((s) => s.id === sectionId);
  if (!section) return null;
  const lines = String(text ?? "").split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (section.pattern.test(line)) hits.push(i + 1);
  });
  if (hits.length === 0) return null;
  return hits.find((n) => n > afterLine) ?? hits[0];
}

/** The 1-based line a caret offset sits on. */
export function lineOfOffset(text, offset) {
  return String(text ?? "").slice(0, Math.max(0, offset)).split("\n").length;
}

/** The character offset where a 1-based line starts. */
export function offsetOfLine(text, line) {
  const lines = String(text ?? "").split("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i += 1) offset += lines[i].length + 1;
  return offset;
}

const FIELDS = ["classification_hints", "responsible", "accountable", "path", "command", "consulted", "required_followups", "informed", "force_rules"];
const CODE_FIELDS = { informed_unknown: "informed", force_rule_unknown: "force_rules", force_rule_weakened: "force_rules" };

function headerLines(lines, route) {
  const out = [];
  lines.forEach((line, i) => {
    const m = /^### route: (.+)$/.exec(line);
    if (m && m[1].trim() === route) out.push(i);
  });
  return out;
}

/** Where a gate finding points in the draft: its route block's field line when the finding
 *  names a field, else the block's header; a grammar error's route is read from its message.
 *  Null when the finding has no place (a whole-document compile error). */
export function locateFinding(text, finding) {
  const lines = String(text ?? "").split("\n");
  const message = String(finding?.message ?? "");
  const dup = /^duplicate route key: ([a-z0-9_-]+)/.exec(message);
  if (dup) {
    const headers = headerLines(lines, dup[1]);
    return headers.length > 1 ? headers[1] + 1 : headers.length ? headers[0] + 1 : null;
  }
  const malformed = /^malformed route key "(.*)"/.exec(message);
  if (malformed) {
    const i = lines.findIndex((l) => l === `### route: ${malformed[1]}`);
    return i === -1 ? null : i + 1;
  }
  const route = finding?.route ?? /^route ([a-z0-9_-]+):/.exec(message)?.[1] ?? null;
  if (!route) return null;
  const headers = headerLines(lines, route);
  if (headers.length === 0) return null;
  const start = headers[0];
  let end = start + 1;
  while (end < lines.length && !/^#{1,3} /.test(lines[end])) end += 1;
  const field = CODE_FIELDS[finding?.code] ?? /field "([a-z_]+)"/.exec(message)?.[1] ?? FIELDS.find((f) => new RegExp(`(^|[^a-z_])"?${f}"?([^a-z_]|$)`).test(message.replace(/^route [a-z0-9_-]+:/, "")));
  if (field) {
    for (let i = start + 1; i < end; i += 1) if (lines[i].startsWith(`${field}: `)) return i + 1;
  }
  return start + 1;
}

/** The gate's findings from a propose response (either validator), de-duplicated, each
 *  placed on a line of `text` where one can be found. */
export function gateFindings(result, text) {
  const validation = result?.validation ?? result?.proposal?.validation ?? {};
  const seen = new Set();
  const out = [];
  for (const part of [validation.raci, validation.route]) {
    for (const f of part?.findings ?? []) {
      if (seen.has(f.message)) continue;
      seen.add(f.message);
      out.push({ code: f.code, route: f.route ?? null, message: f.message, line: locateFinding(text, f) });
    }
  }
  return out;
}

// ─── the machine ─────────────────────────────────────────────────────────────

/** Open the editor on a `GET /api/raci` read. A reload lands here too: unsaved text is never
 *  kept anywhere, so the draft is the starting candidate again. */
export function openEditor(read, origin = "source") {
  const host = read?.host?.text ?? (read?.source?.kind === "host" ? read.source.text : null) ?? null;
  const own = read?.source?.kind === "project" ? read.source.text ?? null : null;
  const useHost = origin === "host" || own === null;
  const text = (useHost ? host : own) ?? "";
  return {
    mode: "editing",
    origin: useHost ? "host" : "source",
    baseText: text,
    draft: text,
    dryRun: { seq: 0, pending: false, text: null, ok: null, findings: [], error: null },
    lastGreen: null,
    proposal: null,
    proposing: false,
    proposeError: null,
    confirmKey: "",
    rationale: "",
    applying: false,
    applyError: null,
  };
}

export function isDirty(state) {
  return Boolean(state) && state.draft !== state.baseText;
}

/** Any edit: back to editing. The proposal stays on screen, superseded — `proposalLive`
 *  is false from here on, so Apply is disabled until this exact text is proposed again. */
export function editDraft(state, text) {
  if (text === state.draft) return state;
  return { ...state, mode: "editing", draft: text, proposeError: null, applyError: null };
}

/** Start again from another text (the host default): the same as an edit, never a delete. */
export function replaceDraft(state, text, origin) {
  return { ...editDraft(state, text), origin };
}

export function beginDryRun(state, seq) {
  return { ...state, dryRun: { ...state.dryRun, seq, pending: true, error: null } };
}

/** What the machine needs to know about one gate's answers: whether a result is a gate
 *  verdict, its findings placed on lines of the text, and what a green answer keeps. The
 *  model-policy editor (models-editor-state.js) passes its own. */
export const RACI_GATE = Object.freeze({
  isVerdict: (result) => Boolean(result && (result.validation || result.proposal)),
  findings: (result, text) => gateFindings(result, text),
  green: (text, result) => ({ text, routes: result?.candidateRoutes ?? null, routeChanges: result?.routeChanges ?? null }),
});

/** A dry-run answered. A superseded one (older seq) or one for text no longer in the
 *  editor never writes. */
export function settleDryRun(state, seq, text, response, gate = RACI_GATE) {
  if (seq !== state.dryRun.seq || text !== state.draft) return state;
  const body = response?.body ?? {};
  const result = body.result ?? null;
  if (response?.status === 200 && body.ok === true) {
    return {
      ...state,
      dryRun: { seq, pending: false, text, ok: true, findings: [], error: null },
      lastGreen: gate.green(text, result),
    };
  }
  if (gate.isVerdict(result)) {
    const findings = gate.findings(result, text);
    return {
      ...state,
      dryRun: { seq, pending: false, text, ok: false, findings: findings.length ? findings : [{ code: body.refusal ?? "gate_failed", route: null, message: body.error ?? "the gate refused the candidate", line: null }], error: null },
    };
  }
  return { ...state, dryRun: { ...state.dryRun, seq, pending: false, error: body.error ?? `dry-run unavailable — HTTP ${response?.status}` } };
}

export function failDryRun(state, seq, reason) {
  if (seq !== state.dryRun.seq) return state;
  return { ...state, dryRun: { ...state.dryRun, pending: false, error: reason } };
}

export function beginPropose(state) {
  return { ...state, proposing: true, proposeError: null };
}

/** The Propose button's answer. Green → proposed, bound to the text sent and the sha the
 *  server hashed; refused → the reason stays on screen and Apply stays disabled. */
export function settlePropose(state, text, response, gate = RACI_GATE) {
  const next = { ...state, proposing: false };
  if (text !== state.draft) return next;
  const body = response?.body ?? {};
  if (response?.status === 200 && body.ok === true) {
    return {
      ...next,
      mode: "proposed",
      dryRun: { seq: next.dryRun.seq, pending: false, text, ok: true, findings: [], error: null },
      lastGreen: gate.green(text, body.result ?? null),
      proposal: { text, sha: body.candidateSha256, expiresAt: body.proposalExpiresAt ?? null, verb: body.verb ?? null, result: body.result ?? null },
      proposeError: null,
      applyError: null,
    };
  }
  const result = body.result ?? null;
  const verdict = gate.isVerdict(result);
  const findings = verdict ? gate.findings(result, text) : [];
  return {
    ...next,
    mode: "editing",
    proposal: null,
    dryRun: verdict ? { seq: next.dryRun.seq, pending: false, text, ok: false, findings, error: null } : { ...next.dryRun, pending: false },
    proposeError: { message: body.error ?? `propose failed — HTTP ${response?.status}`, refusal: body.refusal ?? null, findings },
  };
}

export function failPropose(state, reason) {
  return { ...state, proposing: false, dryRun: { ...state.dryRun, pending: false }, proposeError: { message: reason, refusal: null, findings: [] } };
}

export function setConfirmKey(state, value) {
  return { ...state, confirmKey: value };
}

export function setRationale(state, value) {
  return { ...state, rationale: value };
}

/** Exact match: no trimming, no case folding — the key is typed, not recognised. */
export function confirmKeyMatches(typed, key) {
  return typeof typed === "string" && typeof key === "string" && key !== "" && typed === key;
}

/** Whole minutes left in the proposal window, rounded down (the server's clock set it). */
export function minutesLeft(expiresAt, now = Date.now()) {
  const at = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((at - now) / 60000));
}

export function proposalExpired(expiresAt, now = Date.now()) {
  const at = expiresAt ? new Date(expiresAt).getTime() : NaN;
  return Number.isFinite(at) && at <= now;
}

export function proposalLive(state) {
  return Boolean(state?.proposal) && state.mode === "proposed" && state.proposal.text === state.draft;
}

export function proposeReadiness(state) {
  if (state.proposing) return { enabled: false, reason: "proposing…" };
  if (state.draft.trim() === "") return { enabled: false, reason: "the candidate is empty" };
  if (state.dryRun.text === state.draft && state.dryRun.ok === false) {
    const n = state.dryRun.findings.length;
    return { enabled: false, reason: `fix the ${n} validation error${n === 1 ? "" : "s"} to propose` };
  }
  if (state.dryRun.pending || state.dryRun.text !== state.draft) return { enabled: false, reason: "checking the candidate…" };
  return { enabled: true, reason: "runs the full gate; nothing is written" };
}

/** `keyNoun` names what is typed: the project key here, "the target" for a model policy. */
export function applyReadiness(state, projectKey, now = Date.now(), keyNoun = "the project key") {
  if (!proposalLive(state)) return { enabled: false, reason: "propose this exact candidate first" };
  if (state.applying) return { enabled: false, reason: "applying…" };
  if (proposalExpired(state.proposal.expiresAt, now)) return { enabled: false, reason: "the proposal expired — propose again" };
  if (!confirmKeyMatches(state.confirmKey, projectKey)) return { enabled: false, reason: `type ${keyNoun} exactly` };
  if (state.rationale.trim() === "") return { enabled: false, reason: "a rationale is required" };
  return { enabled: true, reason: null };
}

/** The apply request body — the proposed bytes and the sha the server hashed for them. */
export function applyBody(state, project) {
  return {
    projectKey: project.key,
    projectDir: project.checkoutDir,
    candidate: state.proposal.text,
    proposedSha256: state.proposal.sha,
    confirmKey: state.confirmKey,
    rationale: state.rationale,
  };
}

export function beginApply(state) {
  return { ...state, applying: true, applyError: null };
}

/** Applied: the result for the view page. Refused: stay proposed with the reason (a spent
 *  or expired proposal comes back `candidate_not_proposed`, and Propose is the way on). */
export function settleApply(state, response) {
  const body = response?.body ?? {};
  if (response?.status === 200 && body.ok === true) {
    return { ...state, applying: false, mode: "applied", applied: appliedResult(body) };
  }
  const refusal = body.refusal ?? null;
  const spent = refusal === "candidate_not_proposed" || refusal === "candidate_changed";
  return {
    ...state,
    applying: false,
    mode: spent ? "editing" : state.mode,
    proposal: spent ? null : state.proposal,
    applyError: { message: body.error ?? `apply failed — HTTP ${response?.status}`, refusal, exitCode: body.exitCode ?? null },
  };
}

export function failApply(state, reason) {
  return { ...state, applying: false, applyError: { message: reason, refusal: null, exitCode: null } };
}

/** What the view page shows once an apply lands: the exit status and the CLI's output. */
export function appliedResult(body) {
  const cli = body.result ?? {};
  const audit = cli.audit ?? {};
  const lines = [
    cli.written === true ? `Applied RACI source -> ${audit.current_raci ?? "the project override"}` : "Nothing written.",
    `Route changes: ${routeChangeText(audit.routes_added, audit.routes_modified, audit.routes_removed)}`,
    cli.effectiveForDispatch ? `The routing change is now effective for dispatch in ${body.project?.checkoutDir ?? cli.project ?? "this checkout"}.` : null,
  ].filter(Boolean);
  return { exitCode: body.exitCode ?? 0, verb: body.verb ?? null, sha: body.candidateSha256 ?? null, output: lines.join("\n") };
}

// ─── the tables ──────────────────────────────────────────────────────────────

const EXECUTABLE = ["path", "responsible", "command", "consulted", "required_followups", "informed", "force_rules"];

function sameRoute(a, b) {
  return EXECUTABLE.every((f) => JSON.stringify(a?.[f] ?? null) === JSON.stringify(b?.[f] ?? null));
}

/** The dry-run table: the candidate's compiled routes tagged against the routes in force
 *  (added / changed / removed), in the candidate's order with removed routes last. */
export function effectiveRows(current, candidate) {
  const now = current ?? {};
  const next = candidate ?? now;
  const rows = Object.keys(next).map((key) => {
    const before = now[key];
    const route = next[key];
    const tag = candidate == null ? null : before === undefined ? "added" : sameRoute(before, route) ? null : "changed";
    return { key, route, tag, wasResponsible: tag === "changed" && before.responsible !== route.responsible ? before.responsible : null };
  });
  if (candidate != null) {
    for (const key of Object.keys(now)) if (!(key in next)) rows.push({ key, route: now[key], tag: "removed", wasResponsible: null });
  }
  return rows;
}

/** Collapse a long table: tagged rows always show, and the first `head` rows; the rest is
 *  counted. */
export function visibleRows(rows, head = 6) {
  const shown = rows.filter((row, i) => i < head || row.tag !== null);
  return { shown, hidden: rows.length - shown.length };
}

export function routeChangeCounts(changes) {
  return {
    added: changes?.added?.length ?? 0,
    changed: changes?.modified?.length ?? 0,
    removed: changes?.removed?.length ?? 0,
  };
}

/** The force-rule line of a proposal: weakened host rules by name, else the count kept. */
export function forceRuleCheck(result, routes) {
  const weakened = [...(result?.validation?.route?.findings ?? [])].filter((f) => f.code === "force_rule_weakened");
  if (weakened.length > 0) return { ok: false, text: `force rules: ${weakened.length} host rule${weakened.length === 1 ? "" : "s"} weakened` };
  const rules = new Set(Object.values(routes ?? {}).flatMap((r) => r.force_rules ?? []));
  return { ok: true, text: `force rules: ${rules.size} in the candidate · no host rule weakened` };
}

export function diffLines(raciDiff) {
  if (!raciDiff) return [];
  return String(raciDiff).split("\n").map((line) => ({
    text: line,
    kind: line.startsWith("+ ") ? "add" : line.startsWith("- ") ? "del" : "ctx",
  }));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const names = (routes) => (routes.length > 3 ? `${routes.slice(0, 3).join(", ")}, …` : routes.join(", "));

function routeChangeText(added = [], modified = [], removed = []) {
  const parts = [];
  if (added.length) parts.push(`+${plural(added.length, "route")} (${names(added)})`);
  if (modified.length) parts.push(`~${plural(modified.length, "route")} (${names(modified)})`);
  if (removed.length) parts.push(`−${plural(removed.length, "route")} (${names(removed)})`);
  return parts.length ? parts.join(" ") : "no route change";
}

// FG-840 AC 4: `--by`/`--source` are whatever the caller passed, and any local forge caller can
// pass them — the audit logs record attribution as a claim, labelled as one, never a proof.
export const ATTRIBUTION_CLAIM_CAPTION = "Attribution is recorded as the caller gave it; on this host anyone who can run forge can write these values. It is a claim, not a proof.";

/** Only what the audit line recorded, each value marked as a claim: an absent actor or source
 *  is never filled in, and a line with neither is `null` (rendered as "unattributed"). */
export function claimedAttribution(actor, source) {
  const claimed = (v) => `${v} (claimed)`;
  if (!actor) return source ? claimed(source) : null;
  return source && source !== actor ? `${claimed(actor)} via ${claimed(source)}` : claimed(actor);
}

/** RECORDED: one row per audit line — when, who, action, change, rationale, candidate sha. */
export function auditRows(entries) {
  return (entries ?? []).map((e) => ({
    timestamp: e.timestamp ?? null,
    attribution: claimedAttribution(e.actor, e.source),
    action: e.action ?? "—",
    change: routeChangeText(e.routes_added ?? [], e.routes_modified ?? [], e.routes_removed ?? []),
    rationale: e.rationale ?? null,
    sha: e.candidate_sha256 ?? null,
  }));
}

// ─── the dry-run loop ────────────────────────────────────────────────────────

/** Debounced dry-run proposes. `schedule(text)` aborts the in-flight request at once and
 *  runs after `delayMs` of quiet; `now(text)` runs immediately. Only the newest run's answer
 *  reaches `onSettle`/`onFail`. */
export function createDryRunner({ post, onStart, onSettle, onFail, delayMs = DRY_RUN_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let controller = null;
  let seq = 0;
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  const run = (text) => {
    stop();
    const mine = ++seq;
    const own = new AbortController();
    controller = own;
    onStart(mine, text);
    return post(text, own.signal).then(
      (response) => {
        if (mine !== seq) return;
        controller = null;
        onSettle(mine, text, response);
      },
      (e) => {
        if (mine !== seq || own.signal.aborted) return;
        controller = null;
        onFail(mine, text, e instanceof Error ? e.message : String(e));
      },
    );
  };
  return {
    schedule(text) {
      stop();
      seq += 1;
      timer = setTimer(() => {
        timer = null;
        run(text);
      }, delayMs);
    },
    now: run,
    cancel() {
      stop();
      seq += 1;
    },
  };
}
