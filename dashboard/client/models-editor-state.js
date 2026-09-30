// FG-835 part 2b: Setup › Models — the model-policy editor's state, as pure functions (no
// DOM; fetch and timers injectable). Unit-tested in src/fg835-models-editor.test.ts, driven
// in a real page by browser-tests/fg835-models-editor.test.ts.
//
// The machine is FG-834's (raci-editor-state.js): editing → proposed (bound to the exact
// bytes the gate answered green for) → applied, any edit dropping the proposal. Only what
// differs lives here: the model-policy gate's findings and rows (MODEL_POLICY_GATE), the
// apply target (the host file, or one project's override), and quick edit.
//
// Quick edit never re-serialises the policy. It reads an outline of the draft (profiles,
// their map entries, the role overrides) with a small indentation scanner and rewrites ONE
// scalar or line in place, so comments, key order and keys this client does not know
// survive untouched — a quick edit is just an edit of the text, and the text stays the
// source of truth. A shape the scanner cannot place (a non-empty flow `agents: {…}`, a
// block-scalar model) is reported, not guessed at; the editor remains for it.

import { hashFor } from "./view-routing.js";
import { editDraft, replaceDraft, settleApply } from "./raci-editor-state.js";

export const MODELS_EDIT_MODE = "edit";
export const HOST_TARGET = "host";

export function modelsEditorMode(params) {
  return params && params.mode === MODELS_EDIT_MODE ? "edit" : "view";
}

/** The target the hash asks for: `project` only when a project is in scope; null = the
 *  default (the project's override when it has one, else the host file). */
export function requestedTarget(params, scope) {
  const target = params?.target;
  if (target === "project") return scope?.project ? "project" : null;
  return target === "host" ? "host" : null;
}

export function modelsEditorHash(scope, { edit = false, target = null } = {}) {
  const params = {};
  if (edit) params.mode = MODELS_EDIT_MODE;
  if (target) params.target = target;
  return hashFor({ view: "models", scope, params });
}

/** A role's Harness tab, at the scope its resolution rows were read at: the target
 *  project's checkout, or none for the host file — so the tab and the row cannot disagree. */
export function roleHarnessHash(role, target) {
  const project = target?.kind === "project" ? target.project : null;
  const scope = project ? { project: project.key, checkout: project.checkoutDir } : null;
  return hashFor({ view: "roles", id: role, tab: "harness", scope });
}

/** The GET for one listed backup's bytes (Restore…), for the target it was listed under. */
export function backupReadUrl(target, name) {
  const q = new URLSearchParams();
  if (target?.kind === "project" && target.project) {
    q.set("project", target.project.key);
    q.set("projectDir", target.project.checkoutDir);
  }
  q.set("backup", name);
  return `/api/model-policy?${q.toString()}`;
}

/** The GET the page reads for a target. */
export function modelPolicyReadUrl(target, scope) {
  if (target !== "project" || !scope?.project) return "/api/model-policy";
  const q = new URLSearchParams({ project: scope.project });
  if (scope.checkout) q.set("projectDir", scope.checkout);
  return `/api/model-policy?${q.toString()}`;
}

// ─── the YAML outline ────────────────────────────────────────────────────────

const KEY_RE = /^(\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:,[\]{}&*!|>%@`][^#]*?))\s*:(?=\s|$)(.*)$/;

function scan(text) {
  return String(text ?? "").split("\n").map((raw, i) => {
    const trimmed = raw.trim();
    const blank = trimmed === "" || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...";
    const indent = raw.length - raw.trimStart().length;
    const m = blank ? null : KEY_RE.exec(raw);
    if (!m) return { i, raw, blank, indent, key: null, restAt: -1 };
    const key = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3] !== undefined ? m[3].replace(/''/g, "'") : m[4].trim();
    return { i, raw, blank, indent, key, restAt: raw.length - m[5].length };
  });
}

/** The keyed lines directly under `parent` (null: the document root). */
function children(lines, parent) {
  const floor = parent ? parent.indent : -1;
  const out = [];
  let childIndent = null;
  for (let j = parent ? parent.i + 1 : 0; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.blank) continue;
    if (line.indent <= floor) break;
    childIndent ??= line.indent;
    if (line.indent < childIndent) break;
    if (line.indent === childIndent && line.key !== null) out.push(line);
  }
  return out;
}

const child = (lines, parent, key) => children(lines, parent).find((l) => l.key === key) ?? null;

/** A scalar value after a key's colon: its text and where it sits in the line. `kind` is
 *  `block` (nothing inline), `flow` (`{…}`/`[…]`) or `scalar`. */
function valueOf(line) {
  if (!line || line.restAt < 0) return { kind: "none", value: null };
  const rest = line.raw.slice(line.restAt);
  const lead = rest.length - rest.trimStart().length;
  const at = line.restAt + lead;
  const body = rest.trimStart();
  if (body === "" || body.startsWith("#")) return { kind: "block", value: null };
  if (body.startsWith("{") || body.startsWith("[")) return { kind: "flow", value: null, empty: /^(\{\s*\}|\[\s*\])\s*(#.*)?$/.test(body), start: at };
  if (body.startsWith("|") || body.startsWith(">")) return { kind: "blockScalar", value: null };
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(body);
  if (quoted) {
    const value = quoted[1] !== undefined ? JSON.parse(`"${quoted[1]}"`) : quoted[2].replace(/''/g, "'");
    return { kind: "scalar", value, start: at, end: at + quoted[0].length };
  }
  const plain = /^(.*?)(\s+#.*)?$/.exec(body)[1].trimEnd();
  return { kind: "scalar", value: plain, start: at, end: at + plain.length };
}

/** The `model:` value inside a one-line flow mapping (`review: { model: x, cost_tier: y }`). */
function flowModel(line) {
  const from = line.restAt;
  const re = /([{,]\s*)(?:model|"model"|'model')(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,}\s][^,}]*?)(\s*[,}])/g;
  re.lastIndex = from;
  const m = re.exec(line.raw);
  if (!m) return null;
  const start = m.index + m[1].length + (m[0].length - m[1].length - m[2].length - m[3].length - m[4].length) + m[2].length;
  const token = m[3];
  const value = token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1).replace(/''/g, "'") : token;
  return { value, start, end: start + token.length };
}

/** The policy's editable outline: profiles with their map entries, the default profile and
 *  the role overrides, each located on its line. `ok: false` names why quick edit cannot
 *  read the draft (the editor still can). */
export function policyOutline(text) {
  const lines = scan(text);
  const top = children(lines, null);
  const get = (key) => top.find((l) => l.key === key) ?? null;
  const schema = valueOf(get("schema_version"));
  const profilesLine = get("model_profiles");
  if (!profilesLine) return { ok: false, reason: "the draft has no model_profiles block", profiles: [], overrides: { editable: false, entries: [] } };
  if (valueOf(profilesLine).kind !== "block") return { ok: false, reason: "model_profiles is not a block mapping", profiles: [], overrides: { editable: false, entries: [] } };

  const profiles = children(lines, profilesLine).map((p) => {
    const scalar = (key) => {
      const v = valueOf(child(lines, p, key));
      return v.kind === "scalar" ? v.value : null;
    };
    const mapLine = child(lines, p, "map");
    const entries = mapLine
      ? children(lines, mapLine).map((e) => {
          const v = valueOf(e);
          let at = null;
          if (v.kind === "flow") {
            const m = flowModel(e);
            if (m) at = { index: e.i, start: m.start, end: m.end, value: m.value };
          } else if (v.kind === "block") {
            const modelLine = child(lines, e, "model");
            const mv = valueOf(modelLine);
            if (mv.kind === "scalar") at = { index: modelLine.i, start: mv.start, end: mv.end, value: mv.value };
          }
          return { alias: e.key, line: e.i + 1, model: at?.value ?? null, at };
        })
      : [];
    return { name: p.key, line: p.i + 1, provider: scalar("provider"), auth: scalar("auth"), runtime: scalar("runtime"), entries };
  });

  const defaultsLine = get("defaults");
  const defaultValue = defaultsLine ? valueOf(child(lines, defaultsLine, "profile")) : null;
  const defaultProfile = defaultValue?.kind === "scalar" ? defaultValue.value : null;

  const overridesLine = get("overrides");
  const agentsLine = overridesLine ? child(lines, overridesLine, "agents") : null;
  const overridesValue = valueOf(overridesLine);
  const agentsValue = valueOf(agentsLine);
  let style;
  if (!overridesLine) style = "absent";
  else if (overridesValue.kind === "flow") style = overridesValue.empty ? "overrides-empty" : "flow";
  else if (!agentsLine) style = "no-agents";
  else if (agentsValue.kind === "flow") style = agentsValue.empty ? "agents-empty" : "flow";
  else style = agentsValue.kind === "block" ? "block" : "flow";
  const entries = style === "block"
    ? children(lines, agentsLine).map((l) => {
        const v = valueOf(l);
        return { role: l.key, line: l.i + 1, profile: v.kind === "scalar" ? v.value : null, at: v.kind === "scalar" ? { index: l.i, start: v.start, end: v.end } : null };
      })
    : [];

  return {
    ok: true,
    reason: null,
    schemaVersion: schema.kind === "scalar" ? schema.value : null,
    profiles,
    defaultProfile,
    overrides: {
      style,
      editable: style !== "flow",
      reason: style === "flow" ? "overrides.agents is a flow mapping — edit it in the editor" : null,
      entries,
    },
  };
}

const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~|[-+]?[0-9][0-9_.:eE+-]*|\.inf|\.nan)$/i;

/** A value as YAML: plain when that is unambiguous, else a double-quoted (JSON) string. */
export function yamlScalar(value) {
  const v = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9._/@+-]*(?::[A-Za-z0-9._/@+-]+)*$/.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
}

function splice(text, index, start, end, replacement) {
  const lines = String(text).split("\n");
  lines[index] = lines[index].slice(0, start) + replacement + lines[index].slice(end);
  return lines.join("\n");
}

/** Quick edit: one profile map entry's model. Returns the new text, or null when the entry
 *  is not where the outline can rewrite it. */
export function setProfileModel(text, profile, alias, model) {
  const entry = policyOutline(text).profiles.find((p) => p.name === profile)?.entries.find((e) => e.alias === alias);
  if (!entry?.at || typeof model !== "string" || model.trim() === "") return null;
  if (entry.model === model) return text;
  return splice(text, entry.at.index, entry.at.start, entry.at.end, yamlScalar(model));
}

/** Quick edit: pin `role` to `profile`, or (profile null) drop its override. Returns the new
 *  text, or null when overrides.agents is a shape the outline does not rewrite. */
export function setRoleOverride(text, role, profile) {
  const outline = policyOutline(text);
  if (!outline.ok || !outline.overrides.editable) return null;
  const lines = String(text).split("\n");
  const scanned = scan(text);
  const existing = outline.overrides.entries.find((e) => e.role === role);
  if (existing) {
    if (profile === null) {
      const agents = scanned.find((l, i) => i < existing.line - 1 && l.key === "agents" && children(scanned, l).some((c) => c.i === existing.line - 1));
      lines.splice(existing.line - 1, 1);
      if (outline.overrides.entries.length === 1 && agents) {
        const at = agents.restAt;
        lines[agents.i] = `${lines[agents.i].slice(0, at)} {}${lines[agents.i].slice(at)}`;
      }
      return lines.join("\n");
    }
    if (!existing.at) return null;
    if (existing.profile === profile) return text;
    return splice(text, existing.at.index, existing.at.start, existing.at.end, yamlScalar(profile));
  }
  if (profile === null) return text;
  const entry = (indent) => `${" ".repeat(indent)}${yamlScalar(role)}: ${yamlScalar(profile)}`;
  const top = children(scanned, null);
  const overrides = top.find((l) => l.key === "overrides");
  const style = outline.overrides.style;
  if (style === "absent") {
    const body = lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    return [...body, "overrides:", "  agents:", entry(4), ""].join("\n");
  }
  if (style === "overrides-empty") {
    lines.splice(overrides.i, 1, `${lines[overrides.i].slice(0, overrides.restAt)}`, `${" ".repeat(overrides.indent + 2)}agents:`, entry(overrides.indent + 4));
    return lines.join("\n");
  }
  if (style === "no-agents") {
    const indent = children(scanned, overrides)[0]?.indent ?? overrides.indent + 2;
    lines.splice(overrides.i + 1, 0, `${" ".repeat(indent)}agents:`, entry(indent + 2));
    return lines.join("\n");
  }
  const agents = child(scanned, overrides, "agents");
  if (style === "agents-empty") {
    const raw = lines[agents.i];
    const comment = /\s#.*$/.exec(raw.slice(agents.restAt))?.[0] ?? "";
    lines.splice(agents.i, 1, `${raw.slice(0, agents.restAt)}${comment}`, entry(agents.indent + 2));
    return lines.join("\n");
  }
  const kids = children(scanned, agents);
  const last = kids[kids.length - 1];
  lines.splice(last.i + 1, 0, entry(last.indent));
  return lines.join("\n");
}

// ─── findings, placed on lines ───────────────────────────────────────────────

/** The 1-based line of the deepest key of `path` present in the text; null when not even
 *  the first is. `exact` returns null unless the whole path is found. */
export function lineOfPath(text, path, exact = false) {
  const lines = scan(text);
  let parent = null;
  let found = null;
  for (const key of path) {
    const next = child(lines, parent, key);
    if (!next) return exact ? null : found;
    found = next.i + 1;
    parent = next;
  }
  return found;
}

const LABEL_RE = /^model-policy \([^)]*\):\s*/;

/** Where a gate finding points in the draft. */
export function locatePolicyFinding(text, finding) {
  const message = String(finding?.message ?? "");
  const firstOf = (...paths) => {
    for (const p of paths) {
      const line = lineOfPath(text, p, true);
      if (line !== null) return line;
    }
    return null;
  };
  switch (finding?.code) {
    case "yaml_parse": {
      const m = /\bat line (\d+)/.exec(message);
      return m ? Number(m[1]) : null;
    }
    case "schema_version":
      return lineOfPath(text, ["schema_version"], true);
    case "grammar": {
      let m = /^profile '([^']+)'/.exec(message);
      if (m) return lineOfPath(text, ["model_profiles", m[1]], true);
      m = /^activity \(model_profiles\.([^.)]+)\.map\) '([^']+)'/.exec(message);
      if (m) return lineOfPath(text, ["model_profiles", m[1], "map", m[2]], true);
      m = /^activity \(defaults\.activity\) '([^']+)'/.exec(message);
      if (m) return lineOfPath(text, ["defaults", "activity", m[1]], true);
      m = /^role \(overrides\.agents\) '([^']+)'/.exec(message);
      return m ? lineOfPath(text, ["overrides", "agents", m[1]], true) : null;
    }
    case "runtime_missing": {
      const m = /^profile '([^']+)'/.exec(message);
      return m ? firstOf(["model_profiles", m[1], "runtime"], ["model_profiles", m[1], "auth"], ["model_profiles", m[1]]) : null;
    }
    case "auth_unbound":
    case "auth_unavailable": {
      const m = /^profile '([^']+)'/.exec(message);
      return m ? firstOf(["model_profiles", m[1], "auth"], ["model_profiles", m[1]]) : null;
    }
    case "default_undispatchable": {
      const m = /^role '([^']+)'/.exec(message);
      return m ? lineOfPath(text, ["overrides", "agents", m[1]], true) : null;
    }
    default:
      return null;
  }
}

/** The gate's findings from a propose answer, each on a line where one can be found. A
 *  schema failure is one finding per Zod issue, each placed by its dotted path. */
export function policyFindings(result, text) {
  const out = [];
  for (const f of result?.findings ?? []) {
    const message = String(f.message ?? "").replace(LABEL_RE, "");
    if (f.code === "schema_invalid") {
      const issues = message.split("\n").map((l) => /^\s+- (.+?): (.*)$/.exec(l)).filter(Boolean);
      if (issues.length > 0) {
        for (const [, path, why] of issues) {
          out.push({ code: f.code, message: `${path}: ${why}`, line: path === "<root>" ? null : lineOfPath(text, path.split(".")) });
        }
        continue;
      }
    }
    out.push({ code: f.code, message, line: locatePolicyFinding(text, f) });
  }
  return out;
}

/** The model-policy gate, for the shared machine's settleDryRun/settlePropose. */
export const MODEL_POLICY_GATE = Object.freeze({
  isVerdict: (result) => Boolean(result && Array.isArray(result.findings)),
  findings: (result, text) => policyFindings(result, text),
  green: (text, result) => ({ text, rows: result?.rows ?? null, findings: result?.findings ?? [] }),
});

// ─── the machine: what differs from FG-834 ───────────────────────────────────

/** Open the editor on a `GET /api/model-policy` read. `start` (a backup being restored)
 *  replaces the draft exactly as an edit would. A reload lands on the read's text again. */
export function openModelsEditor(read, start = null) {
  const text = read?.source?.text ?? "";
  const state = {
    mode: "editing",
    origin: "source",
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
  return start ? replaceDraft(state, start.text, start.origin) : state;
}

/** A quick edit is an edit: the new text goes through the same transition as typing. */
export function quickEdit(state, text) {
  return text === null ? state : editDraft(state, text);
}

export function proposeBody(target, text) {
  return target.kind === "project"
    ? { projectKey: target.project.key, projectDir: target.project.checkoutDir, candidate: text }
    : { target: HOST_TARGET, candidate: text };
}

export function applyBody(state, target) {
  return {
    ...proposeBody(target, state.proposal.text),
    proposedSha256: state.proposal.sha,
    confirmKey: state.confirmKey,
    rationale: state.rationale,
  };
}

/** The exact verb an apply shells, as the hint shows it. */
export function applyVerb(target) {
  const project = target.kind === "project" ? ` --project ${target.project.checkoutDir}` : "";
  return `forge model policy apply <candidate>${project} --confirm --by dashboard --source dashboard --rationale …`;
}

export function settleModelsApply(state, response) {
  const next = settleApply(state, response);
  return next.mode === "applied" ? { ...next, applied: modelsAppliedResult(response.body) } : next;
}

/** What the view shows once an apply lands: the exit status and what the CLI did. */
export function modelsAppliedResult(body) {
  const cli = body?.result ?? {};
  const audit = cli.audit ?? {};
  const lines = [
    cli.written === true ? `Applied model policy -> ${audit.target ?? cli.target?.path ?? "the target"}` : "Nothing written.",
    cli.backup ? `Previous file kept as ${cli.backup}` : cli.written === true ? "No previous file to back up." : null,
    `Resolution changes: ${diffSummary(audit.diff ?? [])}`,
    cli.written === true ? "Takes effect on the next dispatch." : null,
  ].filter(Boolean);
  return { exitCode: body?.exitCode ?? 0, verb: body?.verb ?? null, sha: body?.candidateSha256 ?? null, output: lines.join("\n") };
}

// ─── the tables ──────────────────────────────────────────────────────────────

const STATE_FIELDS = ["profile", "provider", "model", "auth", "runtime", "costTier", "outcome", "dispatchable", "error"];
const pick = (r) => Object.fromEntries(STATE_FIELDS.map((f) => [f, r?.[f] ?? null]));

export function isUndispatchable(s) {
  return Boolean(s) && (s.error != null || s.dispatchable === false || s.outcome === "activity_unmapped");
}

export function rowIsChange(row) {
  return (
    (row.changed?.length ?? 0) > 0 ||
    row.before?.outcome !== row.after?.outcome ||
    row.before?.dispatchable !== row.after?.dispatchable ||
    row.before?.error !== row.after?.error
  );
}

/** RESOLUTION (DRY-RUN): every role × activity. Before any green dry-run, the rows in force
 *  (the Harness rows); after one, the candidate's, tagged changed / undispatchable with
 *  what a changed model or profile was. */
export function resolutionRows(current, lastGreen) {
  if (!lastGreen?.rows) {
    return (current ?? []).map((r) => {
      const state = pick(r);
      const tags = isUndispatchable(state) ? ["undispatchable"] : [];
      return { key: `${r.role}\n${r.activity}`, role: r.role, activity: r.activity, isDefault: r.isDefault === true, state, tags, tag: tags[0] ?? null, was: null };
    });
  }
  return lastGreen.rows.map((r) => {
    const state = pick(r.after);
    const tags = [];
    if (rowIsChange(r)) tags.push("changed");
    if (isUndispatchable(state)) tags.push("undispatchable");
    const was = r.before?.model !== r.after?.model ? r.before?.model ?? null : r.before?.profile !== r.after?.profile ? r.before?.profile ?? null : null;
    return { key: `${r.role}\n${r.activity}`, role: r.role, activity: r.activity, isDefault: r.isDefault === true, state, tags, tag: tags[0] ?? null, was };
  });
}

function firstLine(s) {
  return String(s ?? "").split("\n")[0];
}

/** One side of a resolution, as the proposal's before → after cells read. */
export function sideText(s) {
  if (!s) return "—";
  if (s.error) return `error: ${firstLine(s.error)}`;
  const parts = [`${s.profile ?? "legacy"} → ${s.model ?? "—"}`, s.auth ?? "—", s.runtime ?? "—", `tier ${s.costTier ?? "—"}`];
  if (s.outcome === "activity_unmapped") parts.push("activity_unmapped");
  else if (s.dispatchable === false) parts.push("not dispatchable");
  return parts.join(" · ");
}

/** The PROPOSAL's before → after rows: only the role × activity rows that change. */
export function proposalDiffRows(result) {
  return (result?.rows ?? []).filter(rowIsChange).map((r) => ({
    key: `${r.role}\n${r.activity}`,
    label: `${r.role} · ${r.activity}`,
    before: sideText(r.before),
    after: sideText(r.after),
    becomesUndispatchable: r.becomesUndispatchable === true,
  }));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The PROPOSAL's summary line. */
export function proposalSummary(result) {
  const rows = result?.rows ?? [];
  const findings = result?.findings ?? [];
  const runtime = findings.filter((f) => f.code === "runtime_missing").length;
  const auth = findings.filter((f) => f.code === "auth_unavailable" || f.code === "auth_unbound").length;
  return {
    changed: rows.filter(rowIsChange).length,
    newlyUndispatchable: rows.filter((r) => r.becomesUndispatchable === true).length,
    preExisting: rows.filter((r) => isUndispatchable(r.after) && isUndispatchable(r.before)).length,
    runtimeText: runtime === 0 ? "runtime seeds: all present" : `runtime seeds: ${runtime} missing`,
    authText: auth === 0 ? "auth: every profile satisfiable on this host" : `auth: ${plural(auth, "profile")} unsatisfiable on this host`,
  };
}

/** An audit line's diff, in one phrase. */
export function diffSummary(diff) {
  const rows = diff ?? [];
  if (rows.length === 0) return "no resolution change";
  const names = rows.slice(0, 3).map((r) => `${r.role} · ${r.activity}`).join(", ") + (rows.length > 3 ? ", …" : "");
  const broken = rows.filter((r) => r.becomesUndispatchable).length;
  return `~${plural(rows.length, "resolution")} (${names})${broken ? ` · ${broken} undispatchable` : ""}`;
}

/** RECORDED: one row per audit line — when, who, change, rationale, candidate sha. */
export function policyAuditRows(entries) {
  return (entries ?? []).map((e) => ({
    timestamp: e.timestamp ?? null,
    who: e.source === "dashboard" ? "dashboard" : "cli",
    actor: e.actor ?? null,
    change: e.outcome === "failed" ? `failed — ${firstLine(e.error)}` : diffSummary(e.diff),
    rationale: e.rationale ?? null,
    sha: e.candidate_sha256 ?? null,
  }));
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** BACKUPS: newest first, as the server listed them. A backup larger than a candidate may
 *  be (`maxBytes`) cannot be proposed, so its Restore… is blocked with the reason. */
export function backupRows(entries, maxBytes) {
  return (entries ?? []).map((b) => {
    const over = Number.isFinite(maxBytes) && b.bytes > maxBytes;
    return {
      name: b.name,
      timestamp: b.timestamp,
      sha: b.sha256,
      size: formatBytes(b.bytes),
      blocked: over ? `${formatBytes(b.bytes)} is over the ${formatBytes(maxBytes)} a candidate may be — restore it from a terminal` : null,
    };
  });
}

// ─── quick-edit choices ──────────────────────────────────────────────────────

/** The models a picker offers: the current one, every model the draft's or the policy in
 *  force's profiles name, the seed runtimes' known models and every model already offered this
 *  session (`offered`), in one stable alphabetical order. The set only grows, so a choice never
 *  drops the model it replaced nor reorders the list under the select's own selected index. */
export function modelChoices(outline, current, knownModels, inForce, offered) {
  const ids = new Set([...(knownModels ?? []), ...(offered ?? [])]);
  for (const o of [outline, inForce]) for (const p of o?.profiles ?? []) for (const e of p.entries) if (e.model) ids.add(e.model);
  if (current) ids.add(current);
  return [...ids].sort();
}

/** The roles an override can be added for: every resolved role not already pinned. */
export function addableRoles(outline, rows) {
  const pinned = new Set((outline?.overrides?.entries ?? []).map((e) => e.role));
  return [...new Set((rows ?? []).map((r) => r.role))].filter((r) => !pinned.has(r)).sort();
}

/** The MODEL POLICY line's facts: schema_version, profile and role counts. */
export function policyFacts(read) {
  const outline = policyOutline(read?.source?.text ?? "");
  const roles = new Set((read?.resolution?.rows ?? []).map((r) => r.role));
  return { schemaVersion: outline.schemaVersion ?? null, profiles: outline.profiles.length, roles: roles.size };
}
